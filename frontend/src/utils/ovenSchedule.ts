/**
 * 炭焙间两座炉排程（utils/ovenSchedule.ts）
 * 纯函数模块，不碰数据库、不碰 React：
 * - buildOvenSchedule：按「复焙日期 → 鲜叶重量 → 焙火时长」把待焙道次装进炉一 / 炉二的炉次；
 *   同一炉次内多道并行（鲜叶总重不超炉容量），同炉各炉次时间串行不重叠，
 *   装不下就排队到下一炉；已开焙（焙火中 / 已足火）道次保持原排程不动。
 * - snapshotScheduleInputs / diffScheduleSnapshot：排程输入快照与差异对比，
 *   用于两个标签页同时改同一炉时的保存冲突检测（后保存方列冲突、不覆盖对方）。
 * - groupPersistedSlots：把已写库的炉位三元组（ovenId / slotDate / slotSeq）分组回显成炉次。
 */
import {
  OVEN_ROOM,
  OVEN_TURNAROUND_MIN,
  OVEN_WORKDAY_START_HOUR,
  type OvenId,
  type Roast,
} from '../types/roast';
import type { Batch } from '../types/batch';
import { roundTo, todayIso } from './tea';

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

/** 单条道次的炉位分配结果（写回 roasts 表的三元组） */
export interface SlotAssignment {
  ovenId: OvenId | '';
  slotDate: string;
  slotSeq: number;
}

/** 炉次成员 */
export interface OvenSlotMember {
  roastId: string;
  batchId: string;
  passNo: number;
  hours: number;
  weightKg: number;
  /** 已开焙（焙火中）占位成员：保持原排程，不参与重排 */
  locked: boolean;
}

/** 炉次：一座炉的一段连续焙火，成员并行同焙，炉次时长取成员最长时长 */
export interface OvenSlot {
  ovenId: OvenId;
  slotDate: string;
  slotSeq: number;
  startMs: number;
  endMs: number;
  totalKg: number;
  capacityKg: number;
  maxHours: number;
  locked: boolean;
  members: OvenSlotMember[];
}

/** 排不下的道次（触发整体回滚 + 批次列待处理） */
export interface UnschedulableItem {
  roastId: string;
  batchId: string;
  passNo: number;
  weightKg: number;
  reason: string;
}

/** 排程结果 */
export interface OvenSchedulePlan {
  ok: boolean;
  slots: OvenSlot[];
  /** roastId → 炉位三元组（待焙道次为新排结果，已开焙道次为原值） */
  assignments: Record<string, SlotAssignment>;
  unschedulable: UnschedulableItem[];
}

/** 排程保存结果 */
export type SaveScheduleResult =
  | { ok: true; slotCount: number }
  | { ok: false; reason: 'conflict'; conflicts: ScheduleConflict[] }
  | { ok: false; reason: 'unschedulable'; items: UnschedulableItem[] };

/** 排程冲突明细（另一窗口已改动同一批排程输入） */
export interface ScheduleConflict {
  kind: 'roast' | 'batch';
  id: string;
  label: string;
  changes: string[];
}

/** 排程保存冲突：携带冲突明细抛出，事务回滚不覆盖对方 */
export class ScheduleConflictError extends Error {
  conflicts: ScheduleConflict[];

  constructor(conflicts: ScheduleConflict[]) {
    super('排程保存冲突：另一窗口已修改焙火数据');
    this.name = 'ScheduleConflictError';
    this.conflicts = conflicts;
  }
}

/** 某天的开炉时刻（本地时区）：dateIso 当天 OVEN_WORKDAY_START_HOUR 点 */
function dayStartMs(dateIso: string): number {
  const base = new Date(`${dateIso}T00:00:00`).getTime();
  const safe = Number.isNaN(base) ? Date.now() : base;
  return safe + OVEN_WORKDAY_START_HOUR * HOUR_MS;
}

/** 时间戳 → 本地 YYYY-MM-DD */
export function localDateOf(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 时间戳 → 本地 HH:mm（预览展示用） */
export function localClockOf(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 炉容量查询（未知炉位返回 0） */
export function ovenCapacityOf(ovenId: OvenId | ''): number {
  return OVEN_ROOM.find((oven) => oven.id === ovenId)?.capacityKg ?? 0;
}

/* ------------------------------ 排程算法 ------------------------------ */

/** 排程中的可变炉次（rebuildTimeline 反复重排开始时刻） */
interface MutableSlot {
  ovenId: OvenId;
  locked: boolean;
  /** 成员复焙日期约束的最大值：炉次不得早于该时刻开焙 */
  earliestMs: number;
  members: OvenSlotMember[];
  startMs: number;
}

function slotHours(slot: MutableSlot): number {
  return slot.members.reduce((acc, member) => Math.max(acc, member.hours), 0);
}

function slotKg(slot: MutableSlot): number {
  return slot.members.reduce((acc, member) => acc + member.weightKg, 0);
}

/** 炉次结束后的下一可排时刻（含清炉间隔） */
function slotTailMs(slot: MutableSlot): number {
  return slot.startMs + slotHours(slot) * HOUR_MS + OVEN_TURNAROUND_MIN * MINUTE_MS;
}

/**
 * 重排一座炉的时间轴：炉次按最早可排时刻升序串行放置，互不重叠；
 * 往炉次里加道次导致时长变长时，后续炉次随此处级联顺延（即「后续炉次重算」）。
 */
function rebuildTimeline(slots: MutableSlot[], fromMs: number): void {
  const ordered = slots.sort((a, b) => a.earliestMs - b.earliestMs);
  let cursor = fromMs;
  ordered.forEach((slot) => {
    slot.startMs = Math.max(cursor, slot.earliestMs);
    cursor = slotTailMs(slot);
  });
}

/**
 * 两座炉排程主函数：
 * 1. 焙火中且已排炉的道次 → 固定炉次占位（保持原三元组，不接纳新成员）；
 * 2. 待焙道次按「复焙日期（逾期按今天）→ 重量降 → 时长降 → 道次」排序后依次装炉：
 *    先试装已有开口炉次（同炉次总重不超容量、开炉不早于该道次复焙日），
 *    装不下则在能最早开炉的炉位排队开新炉次；
 * 3. 单批鲜叶超过全部炉容量 → 记入 unschedulable（调用方整体回滚并列为待处理）。
 */
export function buildOvenSchedule(roasts: Roast[], batches: Batch[], today = todayIso()): OvenSchedulePlan {
  const weightOf = new Map(batches.map((batch) => [batch.id, batch.freshLeafKg]));
  const maxCapacity = Math.max(...OVEN_ROOM.map((oven) => oven.capacityKg));
  const fromMs = dayStartMs(today);
  const timelines = new Map<OvenId, MutableSlot[]>(OVEN_ROOM.map((oven) => [oven.id, []]));

  // 1) 已开焙（焙火中）且已排炉的道次：固定炉次占位，保持原排程
  const lockedGroups = new Map<string, Roast[]>();
  roasts
    .filter((roast) => roast.state === '焙火中' && roast.ovenId && roast.slotDate && roast.slotSeq > 0)
    .forEach((roast) => {
      const key = `${roast.ovenId}|${roast.slotDate}|${roast.slotSeq}`;
      lockedGroups.set(key, [...(lockedGroups.get(key) ?? []), roast]);
    });
  lockedGroups.forEach((group) => {
    const first = group[0];
    const slots = timelines.get(first.ovenId as OvenId);
    if (!slots) return;
    slots.push({
      ovenId: first.ovenId as OvenId,
      locked: true,
      earliestMs: dayStartMs(first.slotDate),
      members: group.map((roast) => ({
        roastId: roast.id,
        batchId: roast.batchId,
        passNo: roast.passNo,
        hours: roast.hours,
        weightKg: weightOf.get(roast.batchId) ?? 0,
        locked: true,
      })),
      startMs: 0,
    });
  });
  timelines.forEach((slots) => rebuildTimeline(slots, fromMs));

  // 2) 待焙道次依次装炉
  const pending = roasts
    .filter((roast) => roast.state === '待焙')
    .map((roast) => ({
      roast,
      dateKey: roast.nextRoastDate && roast.nextRoastDate >= today ? roast.nextRoastDate : today,
      weightKg: weightOf.get(roast.batchId) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.dateKey.localeCompare(b.dateKey) ||
        b.weightKg - a.weightKg ||
        b.roast.hours - a.roast.hours ||
        a.roast.passNo - b.roast.passNo ||
        a.roast.id.localeCompare(b.roast.id),
    );

  const unschedulable: UnschedulableItem[] = [];

  pending.forEach(({ roast, dateKey, weightKg }) => {
    const earliestMs = dayStartMs(dateKey);
    if (weightKg > maxCapacity) {
      unschedulable.push({
        roastId: roast.id,
        batchId: roast.batchId,
        passNo: roast.passNo,
        weightKg,
        reason: `鲜叶 ${weightKg} kg 超过最大炉容量 ${maxCapacity} kg`,
      });
      return;
    }

    // 2a) 试装已有开口炉次：总重不超容量、开炉时刻不早于该道次复焙日
    let target: MutableSlot | null = null;
    timelines.forEach((slots) => {
      slots.forEach((slot) => {
        if (slot.locked) return;
        if (slotKg(slot) + weightKg > ovenCapacityOf(slot.ovenId)) return;
        if (slot.startMs < earliestMs) return;
        if (!target || slot.startMs < target.startMs) target = slot;
      });
    });
    if (target) {
      const chosen = target as MutableSlot;
      chosen.members.push({
        roastId: roast.id,
        batchId: roast.batchId,
        passNo: roast.passNo,
        hours: roast.hours,
        weightKg,
        locked: false,
      });
      rebuildTimeline(timelines.get(chosen.ovenId) ?? [], fromMs);
      return;
    }

    // 2b) 装不下：排队到下一炉 —— 在能最早开炉的炉位开新炉次
    let bestOven: OvenId | null = null;
    let bestStart = Number.POSITIVE_INFINITY;
    OVEN_ROOM.forEach((oven) => {
      if (weightKg > oven.capacityKg) return;
      const slots = timelines.get(oven.id) ?? [];
      const tail = slots.length > 0 ? slotTailMs(slots[slots.length - 1]) : fromMs;
      const candidate = Math.max(tail, earliestMs);
      if (candidate < bestStart) {
        bestStart = candidate;
        bestOven = oven.id;
      }
    });
    if (!bestOven) {
      unschedulable.push({
        roastId: roast.id,
        batchId: roast.batchId,
        passNo: roast.passNo,
        weightKg,
        reason: `鲜叶 ${weightKg} kg 超过全部炉容量`,
      });
      return;
    }
    const slots = timelines.get(bestOven) as MutableSlot[];
    slots.push({
      ovenId: bestOven,
      locked: false,
      earliestMs,
      members: [
        {
          roastId: roast.id,
          batchId: roast.batchId,
          passNo: roast.passNo,
          hours: roast.hours,
          weightKg,
          locked: false,
        },
      ],
      startMs: 0,
    });
    rebuildTimeline(slots, fromMs);
  });

  // 3) 编号输出：每座炉按开炉时刻排序，按日期编「当日第几炉」
  const slots: OvenSlot[] = [];
  const assignments: Record<string, SlotAssignment> = {};
  OVEN_ROOM.forEach((oven) => {
    const list = [...(timelines.get(oven.id) ?? [])].sort((a, b) => a.startMs - b.startMs);
    const seqByDate = new Map<string, number>();
    list.forEach((slot) => {
      const slotDate = localDateOf(slot.startMs);
      const slotSeq = (seqByDate.get(slotDate) ?? 0) + 1;
      seqByDate.set(slotDate, slotSeq);
      const maxHours = slotHours(slot);
      slots.push({
        ovenId: oven.id,
        slotDate,
        slotSeq,
        startMs: slot.startMs,
        endMs: slot.startMs + maxHours * HOUR_MS,
        totalKg: roundTo(slotKg(slot), 1),
        capacityKg: oven.capacityKg,
        maxHours,
        locked: slot.locked,
        members: slot.members,
      });
      slot.members.forEach((member) => {
        if (!member.locked) {
          assignments[member.roastId] = { ovenId: oven.id, slotDate, slotSeq };
        }
      });
    });
  });
  // 已开焙 / 已足火道次：保持原三元组，不参与重排
  roasts.forEach((roast) => {
    if (roast.state !== '待焙' && !assignments[roast.id]) {
      assignments[roast.id] = { ovenId: roast.ovenId, slotDate: roast.slotDate, slotSeq: roast.slotSeq };
    }
  });
  slots.sort((a, b) => a.ovenId.localeCompare(b.ovenId) || a.startMs - b.startMs);
  return { ok: unschedulable.length === 0, slots, assignments, unschedulable };
}

/* ---------------------------- 已保存排程回显 ---------------------------- */

/** 从 roasts 表当前行提取炉位三元组（与重算结果对比即「是否需要重排」） */
export function persistedAssignments(roasts: Roast[]): Record<string, SlotAssignment> {
  const map: Record<string, SlotAssignment> = {};
  roasts.forEach((roast) => {
    map[roast.id] = { ovenId: roast.ovenId, slotDate: roast.slotDate, slotSeq: roast.slotSeq };
  });
  return map;
}

/** 两份炉位分配是否完全一致 */
export function sameAssignments(a: Record<string, SlotAssignment>, b: Record<string, SlotAssignment>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (!x || !y) return false;
    if (x.ovenId !== y.ovenId || x.slotDate !== y.slotDate || x.slotSeq !== y.slotSeq) return false;
  }
  return true;
}

/** 已保存排程的炉次分组（排程面板泳道回显） */
export interface PersistedSlotGroup {
  ovenId: OvenId;
  slotDate: string;
  slotSeq: number;
  capacityKg: number;
  totalKg: number;
  maxHours: number;
  /** 同炉次鲜叶总重超过炉容量（撞炉信号，提示重排） */
  overloaded: boolean;
  roasts: Roast[];
}

/** 把已写库的炉位三元组分组为炉次（按炉位 → 日期 → 第几炉排序） */
export function groupPersistedSlots(roasts: Roast[], batches: Batch[]): PersistedSlotGroup[] {
  const weightOf = new Map(batches.map((batch) => [batch.id, batch.freshLeafKg]));
  const groups = new Map<string, Roast[]>();
  roasts.forEach((roast) => {
    if (!roast.ovenId || !roast.slotDate || roast.slotSeq <= 0) return;
    const key = `${roast.ovenId}|${roast.slotDate}|${roast.slotSeq}`;
    groups.set(key, [...(groups.get(key) ?? []), roast]);
  });
  return [...groups.values()]
    .map((list) => {
      const first = list[0];
      const ovenId = first.ovenId as OvenId;
      const capacityKg = ovenCapacityOf(ovenId);
      const totalKg = roundTo(list.reduce((acc, roast) => acc + (weightOf.get(roast.batchId) ?? 0), 0), 1);
      return {
        ovenId,
        slotDate: first.slotDate,
        slotSeq: first.slotSeq,
        capacityKg,
        totalKg,
        maxHours: list.reduce((acc, roast) => Math.max(acc, roast.hours), 0),
        overloaded: capacityKg > 0 && totalKg > capacityKg,
        roasts: [...list].sort((a, b) => a.passNo - b.passNo),
      };
    })
    .sort((a, b) => a.slotDate.localeCompare(b.slotDate) || a.slotSeq - b.slotSeq);
}

/* --------------------------- 输入快照与冲突对比 --------------------------- */

/** 参与排程的道次字段（任一变化都会改变排程结果） */
interface RoastScheduleFields {
  batchId: string;
  passNo: number;
  tempC: number;
  hours: number;
  charcoal: string;
  nextRoastDate: string;
  state: string;
  ovenId: string;
  slotDate: string;
  slotSeq: number;
}

/** 参与排程的批次字段 */
interface BatchScheduleFields {
  freshLeafKg: number;
  state: string;
}

/** 排程输入快照：保存排程那一刻的输入基线，用于并发冲突检测 */
export interface ScheduleSnapshot {
  roasts: Record<string, RoastScheduleFields>;
  batches: Record<string, BatchScheduleFields>;
}

/** 给当前排程输入拍快照 */
export function snapshotScheduleInputs(roasts: Roast[], batches: Batch[]): ScheduleSnapshot {
  const roastMap: Record<string, RoastScheduleFields> = {};
  roasts.forEach((roast) => {
    roastMap[roast.id] = {
      batchId: roast.batchId,
      passNo: roast.passNo,
      tempC: roast.tempC,
      hours: roast.hours,
      charcoal: roast.charcoal,
      nextRoastDate: roast.nextRoastDate,
      state: roast.state,
      ovenId: roast.ovenId,
      slotDate: roast.slotDate,
      slotSeq: roast.slotSeq,
    };
  });
  const batchMap: Record<string, BatchScheduleFields> = {};
  batches.forEach((batch) => {
    batchMap[batch.id] = { freshLeafKg: batch.freshLeafKg, state: batch.state };
  });
  return { roasts: roastMap, batches: batchMap };
}

/** 道次字段中文名与取值格式化（冲突明细文案） */
const ROAST_FIELD_LABEL: Array<{ key: keyof Omit<RoastScheduleFields, 'batchId'>; label: string; format: (value: unknown) => string }> = [
  { key: 'passNo', label: '道次', format: (v) => `第 ${String(v)} 道` },
  { key: 'tempC', label: '温度', format: (v) => `${String(v)} ℃` },
  { key: 'hours', label: '时长', format: (v) => `${String(v)} h` },
  { key: 'charcoal', label: '炭种', format: (v) => String(v) },
  { key: 'nextRoastDate', label: '复焙日期', format: (v) => (v ? String(v) : '未排') },
  { key: 'state', label: '状态', format: (v) => String(v) },
  { key: 'ovenId', label: '炉位', format: (v) => (v ? String(v) : '未排炉') },
  { key: 'slotDate', label: '炉次日期', format: (v) => (v ? String(v) : '未排炉') },
  { key: 'slotSeq', label: '炉次序', format: (v) => (Number(v) > 0 ? `第 ${String(v)} 炉` : '未排炉') },
];

/**
 * 对比基线快照与库内最新数据，逐条列出冲突明细。
 * 返回空数组表示无冲突，可以安全写入；非空则调用方应回滚事务、保留本方输入。
 */
export function diffScheduleSnapshot(
  base: ScheduleSnapshot,
  roasts: Roast[],
  batches: Batch[],
  labelOfBatch: (batchId: string) => string,
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const roastMap = new Map(roasts.map((roast) => [roast.id, roast]));

  Object.entries(base.roasts).forEach(([id, before]) => {
    const after = roastMap.get(id);
    const label = `${labelOfBatch(before.batchId)} · 第 ${before.passNo} 道`;
    if (!after) {
      conflicts.push({ kind: 'roast', id, label, changes: ['该道次已被删除'] });
      return;
    }
    const changes = ROAST_FIELD_LABEL.filter(({ key }) => before[key] !== after[key]).map(
      ({ key, label: fieldLabel, format }) => `${fieldLabel} ${format(before[key])} → ${format(after[key])}`,
    );
    if (changes.length > 0) conflicts.push({ kind: 'roast', id, label, changes });
  });
  roasts.forEach((roast) => {
    if (!base.roasts[roast.id]) {
      conflicts.push({
        kind: 'roast',
        id: roast.id,
        label: `${labelOfBatch(roast.batchId)} · 第 ${roast.passNo} 道`,
        changes: ['另一窗口新增的道次'],
      });
    }
  });

  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  Object.entries(base.batches).forEach(([id, before]) => {
    const after = batchMap.get(id);
    const label = labelOfBatch(id);
    if (!after) {
      conflicts.push({ kind: 'batch', id, label, changes: ['该批次已被删除'] });
      return;
    }
    const changes: string[] = [];
    if (before.freshLeafKg !== after.freshLeafKg) {
      changes.push(`鲜叶重量 ${before.freshLeafKg} kg → ${after.freshLeafKg} kg`);
    }
    if (before.state !== after.state) {
      changes.push(`工序状态 ${before.state} → ${after.state}`);
    }
    if (changes.length > 0) conflicts.push({ kind: 'batch', id, label, changes });
  });
  batches.forEach((batch) => {
    if (!base.batches[batch.id]) {
      conflicts.push({ kind: 'batch', id: batch.id, label: labelOfBatch(batch.id), changes: ['另一窗口新增的批次'] });
    }
  });
  return conflicts;
}
