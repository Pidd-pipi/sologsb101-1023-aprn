/**
 * 两座炉排程纯函数（utils/ovenSchedule.ts）
 * 输入焙火道次、茶青批次、焙炉与现有炉次，输出全量新排程；不碰数据库、不碰 React。
 * 规则：
 * - 已开焙（状态非「待焙」）道次所在炉次冻结，原样保留（仅剔除已删除道次并修正合计）；
 * - 其余「待焙且已填复焙日期」的道次按 复焙日期升序 → 鲜叶重量降序 → 时长降序 排队；
 * - 同炉同日可拼入未满炉次（合计 ≤ 容量），拼不下就在当日工时余额内另开下一炉次；
 * - 每炉每日工时上限 OVEN_DAILY_HOURS，两座炉都排不下则记为未排（由调用方整体回退）。
 */
import type { Batch } from '../types/batch';
import type { Roast } from '../types/roast';
import {
  OVEN_DAILY_HOURS,
  type Oven,
  type OvenRun,
  type OvenRunConflict,
  type OvenRunDraft,
  type UnscheduledItem,
} from '../types/oven';
import { roundTo } from './tea';

/** 排程计算结果：冻结保留 + 新增炉次 + 待删除旧炉次 + 排不下的道次 */
export interface OvenPlanResult {
  /** 冻结炉次（已开焙，原样保留；可能已剔除失效道次并修正合计） */
  kept: OvenRun[];
  /** 新排炉次（未持久化，写入前补 id 与时间戳） */
  added: OvenRunDraft[];
  /** 被替换 / 清空的旧炉次 id */
  removedRunIds: string[];
  /** 排不下的道次（非空时调用方应放弃整个方案，恢复原排程） */
  unscheduled: UnscheduledItem[];
}

/** 炉次成员合计鲜叶重量（kg） */
function sumKg(members: Roast[], batchMap: Map<string, Batch>): number {
  return roundTo(
    members.reduce((acc, roast) => acc + (batchMap.get(roast.batchId)?.freshLeafKg ?? 0), 0),
    1,
  );
}

/** 炉次时长 = 成员道次时长最大值 */
function maxHours(members: Roast[]): number {
  return members.reduce((acc, roast) => Math.max(acc, Number.isFinite(roast.hours) ? roast.hours : 0), 0);
}

/** 同炉同日的键 */
function dayKey(ovenId: string, date: string): string {
  return `${ovenId}|${date}`;
}

/**
 * 计算全量新排程。
 * 纯函数：相同输入必得相同输出，便于两个标签页各自重算后比对冲突。
 */
export function computeOvenPlan(params: {
  roasts: Roast[];
  batches: Batch[];
  ovens: Oven[];
  existingRuns: OvenRun[];
}): OvenPlanResult {
  const { roasts, batches, ovens, existingRuns } = params;
  const roastMap = new Map(roasts.map((roast) => [roast.id, roast]));
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));

  /* 1) 冻结炉次：含已开焙道次的炉次保持原样，仅剔除已删除道次并修正合计 */
  const kept: OvenRun[] = [];
  const removedRunIds: string[] = [];
  const frozenRoastIds = new Set<string>();
  const usedHours = new Map<string, number>();
  const runCount = new Map<string, number>();

  for (const run of existingRuns) {
    const members = run.roastIds
      .map((id) => roastMap.get(id))
      .filter((roast): roast is Roast => Boolean(roast));
    const frozen = members.some((roast) => roast.state !== '待焙');
    if (!frozen || members.length === 0) {
      // 未冻结炉次整体重排；成员已全部删除的空炉次一并清掉
      removedRunIds.push(run.id);
      continue;
    }
    kept.push({ ...run, roastIds: members.map((roast) => roast.id), totalKg: sumKg(members, batchMap), hours: maxHours(members) });
    members.forEach((roast) => frozenRoastIds.add(roast.id));
    const key = dayKey(run.ovenId, run.date);
    usedHours.set(key, (usedHours.get(key) ?? 0) + maxHours(members));
    runCount.set(key, Math.max(runCount.get(key) ?? 0, run.runNo));
  }

  /* 2) 候选道次：待焙 + 已填复焙日期 + 批次存在 + 未被冻结；按日期 → 重量 → 时长排序 */
  const candidates = roasts
    .filter(
      (roast) =>
        roast.state === '待焙' && roast.nextRoastDate && batchMap.has(roast.batchId) && !frozenRoastIds.has(roast.id),
    )
    .sort((a, b) => {
      const byDate = a.nextRoastDate.localeCompare(b.nextRoastDate);
      if (byDate !== 0) return byDate;
      const kgA = batchMap.get(a.batchId)?.freshLeafKg ?? 0;
      const kgB = batchMap.get(b.batchId)?.freshLeafKg ?? 0;
      if (kgA !== kgB) return kgB - kgA;
      return b.hours - a.hours;
    });

  /* 3) 逐道放置：先拼入同炉同日未满炉次，拼不下另开下一炉次；两炉当日排满则记未排 */
  const added: OvenRunDraft[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const openRun = new Map<string, OvenRunDraft>();
  const maxCapacity = ovens.reduce((acc, oven) => Math.max(acc, oven.capacityKg), 0);

  for (const roast of candidates) {
    const batch = batchMap.get(roast.batchId) as Batch;
    const kg = batch.freshLeafKg;
    const date = roast.nextRoastDate;
    // 可容炉位：当日已排工时少者优先，其次大容量优先，保证结果确定
    const eligible = ovens
      .filter((oven) => oven.capacityKg >= kg)
      .sort((a, b) => {
        const byHours = (usedHours.get(dayKey(a.id, date)) ?? 0) - (usedHours.get(dayKey(b.id, date)) ?? 0);
        if (byHours !== 0) return byHours;
        if (a.capacityKg !== b.capacityKg) return b.capacityKg - a.capacityKg;
        return a.id.localeCompare(b.id);
      });

    let placed = false;

    // 先尝试拼入同炉同日未满炉次（同炉重叠但总量不超容量即可同焙）
    for (const oven of eligible) {
      const key = dayKey(oven.id, date);
      const run = openRun.get(key);
      if (!run || roundTo(run.totalKg + kg, 1) > oven.capacityKg) continue;
      const dayHours = usedHours.get(key) ?? 0;
      const oldHours = run.hours;
      const mergedHours = Math.max(oldHours, roast.hours);
      if (dayHours - oldHours + mergedHours > OVEN_DAILY_HOURS) continue;
      run.roastIds.push(roast.id);
      run.totalKg = roundTo(run.totalKg + kg, 1);
      run.hours = mergedHours;
      usedHours.set(key, dayHours - oldHours + mergedHours);
      placed = true;
      break;
    }

    // 拼不下就排队到下一炉次（当日首个炉次允许超过每日工时上限，独占该炉）
    if (!placed) {
      for (const oven of eligible) {
        const key = dayKey(oven.id, date);
        const dayHours = usedHours.get(key) ?? 0;
        if (dayHours > 0 && dayHours + roast.hours > OVEN_DAILY_HOURS) continue;
        const run: OvenRunDraft = {
          ovenId: oven.id,
          runNo: (runCount.get(key) ?? 0) + 1,
          date,
          hours: roast.hours,
          totalKg: kg,
          roastIds: [roast.id],
        };
        added.push(run);
        openRun.set(key, run);
        runCount.set(key, run.runNo);
        usedHours.set(key, dayHours + roast.hours);
        placed = true;
        break;
      }
    }

    if (!placed) {
      unscheduled.push({
        roastId: roast.id,
        batchId: roast.batchId,
        date,
        kg,
        reason:
          kg > maxCapacity
            ? `鲜叶 ${kg} kg 超过最大炉容量 ${maxCapacity} kg`
            : `${date} 两座炉当日工时均已排满（每炉每日 ${OVEN_DAILY_HOURS} h）`,
      });
    }
  }

  return { kept, added, removedRunIds, unscheduled };
}

/** 排程签名：炉位 + 时长 + 总重 + 成员集合，用于判断新旧方案是否一致（一致则跳过写入） */
export function planSignatureOf(
  runs: Array<Pick<OvenRun, 'ovenId' | 'date' | 'runNo' | 'hours' | 'totalKg' | 'roastIds'>>,
): string {
  return runs
    .map(
      (run) =>
        `${run.ovenId}|${run.date}|${run.runNo}|${run.hours}|${run.totalKg}|${[...run.roastIds].sort().join('+')}`,
    )
    .sort()
    .join('¶');
}

/** 炉位键：炉 + 日期 + 炉次序号 */
function slotKeyOf(run: Pick<OvenRun, 'ovenId' | 'date' | 'runNo'>): string {
  return `${run.ovenId}|${run.date}|${run.runNo}`;
}

/**
 * 逐炉位比对我方方案与库中当前方案，列出内容不一致的炉位冲突
 * （成员、时长或总重任一不同即算冲突）。
 * 用于多标签页：后保存的一方不覆盖对方，只列出冲突。
 */
export function diffOvenPlans(mine: OvenRun[], theirs: OvenRun[]): OvenRunConflict[] {
  const mineMap = new Map(mine.map((run) => [slotKeyOf(run), run]));
  const theirsMap = new Map(theirs.map((run) => [slotKeyOf(run), run]));
  const keys = [...new Set([...mineMap.keys(), ...theirsMap.keys()])].sort();
  const conflicts: OvenRunConflict[] = [];
  for (const key of keys) {
    const mineRun = mineMap.get(key);
    const theirsRun = theirsMap.get(key);
    const sameMembers = (a?: OvenRun, b?: OvenRun): boolean =>
      [...(a?.roastIds ?? [])].sort().join('+') === [...(b?.roastIds ?? [])].sort().join('+');
    if (
      mineRun &&
      theirsRun &&
      sameMembers(mineRun, theirsRun) &&
      mineRun.hours === theirsRun.hours &&
      mineRun.totalKg === theirsRun.totalKg
    ) {
      continue;
    }
    if (!mineRun && !theirsRun) continue;
    const [ovenId, date, runNo] = key.split('|');
    conflicts.push({
      ovenId,
      date,
      runNo: Number(runNo),
      mine: mineRun?.roastIds ?? [],
      theirs: theirsRun?.roastIds ?? [],
      mineHours: mineRun?.hours ?? null,
      theirsHours: theirsRun?.hours ?? null,
      mineKg: mineRun?.totalKg ?? null,
      theirsKg: theirsRun?.totalKg ?? null,
    });
  }
  return conflicts;
}
