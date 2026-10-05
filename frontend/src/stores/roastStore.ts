/**
 * 焙火状态管理（Zustand）· roastStore.ts
 * 维护焙火道次（多道次按序排列）、复焙提醒、足火判定（待焙→焙火中→已足火）与筛选条件。
 * 另负责炭焙间两座炉排程：重算装炉、排不下回滚并列待处理、多标签页保存冲突检测。
 * 所有道次写操作先读库内最新行再合并，避免覆盖另一窗口写入的炉位排程。
 */
import { create } from 'zustand';
import { nextRoastState, type Roast, type RoastDraft, type RoastReminder, type RoastState } from '../types/roast';
import type { Batch } from '../types/batch';
import type { Garden } from '../types/garden';
import {
  ID_PREFIX,
  createId,
  db,
  getRoast,
  listRoasts,
  listRoastsByBatch,
  nowIso,
  putRoast,
  putRoasts,
  removeRoast as removeRoastRow,
} from '../utils/db';
import {
  ScheduleConflictError,
  buildOvenSchedule,
  diffScheduleSnapshot,
  snapshotScheduleInputs,
  type OvenSchedulePlan,
  type SaveScheduleResult,
  type ScheduleConflict,
} from '../utils/ovenSchedule';
import { batchLabel, buildReminder, fireLevelOf, fireLoadOf } from '../utils/tea';
import { emptyFilterValue, matchKeyword, pickedIncludes, pickedSelect, type FilterValue } from '../components/common/FilterBar';
import { useBatchStore } from './batchStore';
import { useGardenStore } from './gardenStore';

/** 焙火页筛选条件默认值：关键字 + 批次 / 道次状态 / 炭种 / 山场四个下拉多选 */
export const DEFAULT_ROAST_FILTERS: FilterValue = emptyFilterValue(['batchIds', 'states', 'charcoals', 'gardenIds']);

/** 纯函数：按关键字、批次、道次状态、炭种、山场过滤焙火记录 */
export function filterRoasts(roasts: Roast[], batches: Batch[], gardens: Garden[], filters: FilterValue): Roast[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const gardenNameOf = (batch: Batch | undefined): string => {
    if (!batch) return '';
    return gardens.find((garden) => garden.id === batch.gardenId)?.name ?? '';
  };
  const charcoals = pickedSelect(filters, 'charcoals');
  const batchIds = pickedSelect(filters, 'batchIds');
  return roasts.filter((roast) => {
    const batch = batchMap.get(roast.batchId);
    if (!batch) return false;
    if (!matchKeyword(filters.keyword, gardenNameOf(batch), batch.pickedAt, roast.charcoal, `第 ${roast.passNo} 道`, roast.tempC)) {
      return false;
    }
    if (!pickedIncludes(filters, 'gardenIds', batch.gardenId)) return false;
    if (!pickedIncludes(filters, 'states', roast.state)) return false;
    if (batchIds.length > 0 && !batchIds.includes(roast.batchId)) return false;
    if (charcoals.length > 0 && !charcoals.includes(roast.charcoal)) return false;
    return true;
  });
}

interface RoastStoreState {
  roasts: Roast[];
  filters: FilterValue;
  loading: boolean;
  error: string;
  /** 冲突时保留的本方排程预览（未写入，不覆盖对方） */
  scheduleDraft: OvenSchedulePlan | null;
  /** 最近一次保存排程时检出的冲突明细 */
  scheduleConflicts: ScheduleConflict[];
  loadRoasts: () => Promise<void>;
  setFilters: (filters: FilterValue) => void;
  resetFilters: () => void;
  createRoast: (draft: RoastDraft) => Promise<Roast>;
  updateRoast: (roastId: string, draft: RoastDraft) => Promise<void>;
  deleteRoast: (roastId: string) => Promise<void>;
  /** 状态流转：待焙 → 焙火中 → 已足火；足火后自动把批次回写为「已焙火」 */
  advanceRoastState: (roastId: string) => Promise<RoastState | null>;
  /** 道次上移 / 下移（写回 passNo） */
  movePass: (roastId: string, direction: 'up' | 'down') => Promise<void>;
  /** 拖拽或批量重排后的道次顺序写回 */
  reorderPasses: (batchId: string, orderedIds: string[]) => Promise<void>;
  /**
   * 重算两座炉排程并保存：
   * - 排不下（单批超炉容量）→ 不写库恢复原排程，涉及批次列为待处理；
   * - 另一窗口已先保存 → 事务回滚不覆盖对方，保留本方预览并列冲突。
   */
  saveSchedule: () => Promise<SaveScheduleResult>;
  /** 冲突后「以最新数据重排」：刷新库内数据为基线后再保存一次 */
  rebaseAndSaveSchedule: () => Promise<SaveScheduleResult>;
  /** 放弃未保存的排程预览 */
  discardScheduleDraft: () => void;
}

export const useRoastStore = create<RoastStoreState>((set, get) => ({
  roasts: [],
  filters: DEFAULT_ROAST_FILTERS,
  loading: false,
  error: '',
  scheduleDraft: null,
  scheduleConflicts: [],

  async loadRoasts() {
    set({ loading: true, error: '' });
    try {
      const roasts = await listRoasts();
      set({ roasts, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '焙火数据读取失败' });
    }
  },

  setFilters(filters) {
    set({ filters });
  },

  resetFilters() {
    set({ filters: DEFAULT_ROAST_FILTERS });
  },

  async createRoast(draft) {
    const branch = get().roasts.filter((roast) => roast.batchId === draft.batchId);
    const stamp = nowIso();
    const row: Roast = {
      id: createId(ID_PREFIX.roast),
      batchId: draft.batchId,
      passNo: branch.length + 1,
      tempC: draft.tempC,
      hours: draft.hours,
      charcoal: draft.charcoal,
      nextRoastDate: draft.nextRoastDate,
      state: draft.state,
      ovenId: '',
      slotDate: '',
      slotSeq: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await putRoast(row);
    await get().loadRoasts();
    return row;
  },

  async updateRoast(roastId, draft) {
    // 读库内最新行再合并：只覆盖表单字段，保留另一窗口写入的炉位排程
    const current = await getRoast(roastId);
    if (!current) return;
    const next: Roast = {
      ...current,
      tempC: draft.tempC,
      hours: draft.hours,
      charcoal: draft.charcoal,
      nextRoastDate: draft.nextRoastDate,
      state: draft.state,
      updatedAt: nowIso(),
    };
    await putRoast(next);
    await get().loadRoasts();
  },

  async deleteRoast(roastId) {
    const existing = get().roasts.find((roast) => roast.id === roastId);
    if (!existing) return;
    await removeRoastRow(roastId);
    const rest = await listRoastsByBatch(existing.batchId);
    if (rest.length > 0) {
      await putRoasts(rest.map((roast, index) => ({ ...roast, passNo: index + 1, updatedAt: nowIso() })));
    }
    await get().loadRoasts();
  },

  async advanceRoastState(roastId) {
    const current = await getRoast(roastId);
    if (!current) return null;
    const next = nextRoastState(current.state);
    if (!next) return null;
    await putRoast({ ...current, state: next, updatedAt: nowIso() });
    if (next === '已足火') {
      // 足火判定通过：批次工序推进到「已焙火」
      await useBatchStore.getState().markBatchState(current.batchId, '已焙火');
    }
    await get().loadRoasts();
    return next;
  },

  async movePass(roastId, direction) {
    const current = await getRoast(roastId);
    if (!current) return;
    const branch = await listRoastsByBatch(current.batchId);
    const index = branch.findIndex((roast) => roast.id === roastId);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= branch.length) return;
    const swapped = [...branch];
    const currentRow = swapped[index];
    swapped[index] = swapped[swapIndex];
    swapped[swapIndex] = currentRow;
    await putRoasts(swapped.map((roast, order) => ({ ...roast, passNo: order + 1, updatedAt: nowIso() })));
    await get().loadRoasts();
  },

  async reorderPasses(batchId, orderedIds) {
    if (orderedIds.length === 0) return;
    const branch = await listRoastsByBatch(batchId);
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const reordered = [...branch]
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((roast, index) => ({ ...roast, passNo: index + 1, updatedAt: nowIso() }));
    await putRoasts(reordered);
    await get().loadRoasts();
  },

  async saveSchedule() {
    const { roasts } = get();
    const batches = useBatchStore.getState().batches;
    const plan = buildOvenSchedule(roasts, batches);

    // 排不下：不写 roasts（恢复原排程），把涉及批次列为待处理
    if (!plan.ok) {
      const pendingIds = [...new Set(plan.unschedulable.map((item) => item.batchId))];
      const stamp = nowIso();
      await db.transaction('rw', db.batches, async () => {
        const rows = await db.batches.toArray();
        await db.batches.bulkPut(
          rows.map((batch) =>
            pendingIds.includes(batch.id) && !batch.roastPending
              ? { ...batch, roastPending: true, updatedAt: stamp }
              : batch,
          ),
        );
      });
      await useBatchStore.getState().loadBatches();
      return { ok: false, reason: 'unschedulable', items: plan.unschedulable };
    }

    // 基线 = 本次排程的输入快照；事务内重读库内数据对比，检出另一窗口的并发写入
    const base = snapshotScheduleInputs(roasts, batches);
    const gardens = useGardenStore.getState().gardens;
    const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));

    try {
      await db.transaction('rw', db.roasts, db.batches, async () => {
        const [currentRoasts, currentBatches] = await Promise.all([db.roasts.toArray(), db.batches.toArray()]);
        // 合并基线与库内最新批次，保证对方新增 / 删除的批次也能显示名字
        const mergedBatchMap = new Map(batches.map((batch) => [batch.id, batch]));
        currentBatches.forEach((batch) => mergedBatchMap.set(batch.id, batch));
        const labelOfBatch = (batchId: string): string => {
          const batch = mergedBatchMap.get(batchId);
          return batch ? batchLabel(batch, gardenMap.get(batch.gardenId)?.name) : '未知批次';
        };
        const conflicts = diffScheduleSnapshot(base, currentRoasts, currentBatches, labelOfBatch);
        if (conflicts.length > 0) {
          throw new ScheduleConflictError(conflicts);
        }
        const stamp = nowIso();
        const updates = currentRoasts.map((roast) => {
          const assignment = plan.assignments[roast.id];
          if (!assignment) return roast;
          if (
            roast.ovenId === assignment.ovenId &&
            roast.slotDate === assignment.slotDate &&
            roast.slotSeq === assignment.slotSeq
          ) {
            return roast;
          }
          return { ...roast, ...assignment, updatedAt: stamp };
        });
        await db.roasts.bulkPut(updates);
        // 本次全部排下：清除各批次的排程待处理标记
        const cleared = currentBatches
          .filter((batch) => batch.roastPending)
          .map((batch) => ({ ...batch, roastPending: false, updatedAt: stamp }));
        if (cleared.length > 0) await db.batches.bulkPut(cleared);
      });
    } catch (error) {
      if (error instanceof ScheduleConflictError) {
        // 后保存的一方：保留本方排程预览、列出冲突，不覆盖对方
        set({ scheduleConflicts: error.conflicts, scheduleDraft: plan });
        return { ok: false, reason: 'conflict', conflicts: error.conflicts };
      }
      throw error;
    }

    await get().loadRoasts();
    await useBatchStore.getState().loadBatches();
    set({ scheduleConflicts: [], scheduleDraft: null });
    return { ok: true, slotCount: plan.slots.length };
  },

  async rebaseAndSaveSchedule() {
    await Promise.all([get().loadRoasts(), useBatchStore.getState().loadBatches()]);
    set({ scheduleConflicts: [], scheduleDraft: null });
    return get().saveSchedule();
  },

  discardScheduleDraft() {
    set({ scheduleDraft: null, scheduleConflicts: [] });
  },
}));

/** 某批次的道次（按 passNo 升序） */
export function roastsOfBatch(roasts: Roast[], batchId: string): Roast[] {
  return roasts.filter((roast) => roast.batchId === batchId).sort((a, b) => a.passNo - b.passNo);
}

/** 某批次的火功档位 */
export function fireLevelOfBatch(roasts: Roast[], batchId: string): ReturnType<typeof fireLevelOf> {
  return fireLevelOf(roastsOfBatch(roasts, batchId));
}

/** 某批次累计热负荷（℃·h） */
export function fireLoadOfBatch(roasts: Roast[], batchId: string): number {
  return fireLoadOf(roastsOfBatch(roasts, batchId));
}

/** 全部复焙提醒（按到期紧急度排序） */
export function buildReminders(roasts: Roast[]): RoastReminder[] {
  return roasts
    .map((roast) => buildReminder(roast))
    .filter((item): item is RoastReminder => item !== null)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export default useRoastStore;
