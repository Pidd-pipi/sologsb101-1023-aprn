/**
 * 炭焙间炉次排程状态管理（Zustand）· ovenStore.ts
 * 维护两座焙炉与炉次排程：按复焙日期 / 鲜叶重量 / 焙火时长自动重排，
 * 已开焙道次所在炉次冻结；提交时逐炉比对 revision（乐观锁），
 * 另一标签页已先保存时保留我方方案并列出冲突，绝不覆盖对方；
 * 排不下则整体回退（库中保持原排程），并把批次列为待处理。
 */
import { create } from 'zustand';
import type { Oven, OvenRun, OvenRunConflict, UnscheduledItem } from '../types/oven';
import {
  ID_PREFIX,
  OvenScheduleConflictError,
  commitOvenPlan,
  createId,
  listBatches,
  listOvenRuns,
  listOvens,
  listRoasts,
  nowIso,
} from '../utils/db';
import { computeOvenPlan, diffOvenPlans, planSignatureOf } from '../utils/ovenSchedule';

/** 重排结果：已写入 / 无需调整 / 冲突未写入 / 排不下已回退 / 失败 */
export type RescheduleResult = 'ok' | 'noop' | 'conflict' | 'unscheduled' | 'error';

interface OvenStoreState {
  ovens: Oven[];
  runs: OvenRun[];
  /** 本标签页读取排程时记录的各炉 revision 基准（冲突检测用） */
  baseRevisions: Record<string, number>;
  /** 与另一标签页的炉位冲突列表（仅在保存被拒时有值） */
  conflicts: OvenRunConflict[];
  /** 冲突时保留的我方方案（未写入，供「以最新数据重排」前对照） */
  pendingDraft: OvenRun[] | null;
  /** 上一次重排中排不下的道次（原排程已恢复，对应批次列为待处理） */
  unscheduled: UnscheduledItem[];
  loading: boolean;
  error: string;
  loadOvens: () => Promise<void>;
  /** 按当前库中数据重算两座炉排程并原子提交 */
  reschedule: () => Promise<RescheduleResult>;
  /** 放弃我方未保存方案，载入库中最新排程（不覆盖对方） */
  acceptLatest: () => Promise<void>;
}

/** 由焙炉列表生成 revision 基准表 */
function revisionsOf(ovens: Oven[]): Record<string, number> {
  return Object.fromEntries(ovens.map((oven) => [oven.id, oven.revision]));
}

/* 同标签页内串行化重排：并发触发时只排队一次，避免重复提交 */
let inflight = false;
let queued = false;

export const useOvenStore = create<OvenStoreState>((set, get) => ({
  ovens: [],
  runs: [],
  baseRevisions: {},
  conflicts: [],
  pendingDraft: null,
  unscheduled: [],
  loading: false,
  error: '',

  async loadOvens() {
    set({ loading: true, error: '' });
    try {
      const [ovens, runs] = await Promise.all([listOvens(), listOvenRuns()]);
      set({ ovens, runs, loading: false, baseRevisions: revisionsOf(ovens) });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '炉次排程读取失败' });
    }
  },

  async reschedule() {
    if (inflight) {
      queued = true;
      return 'noop';
    }
    inflight = true;
    try {
      // 尚未读过排程（基准为空）时先载入，以库中当前 revision 为基准
      if (Object.keys(get().baseRevisions).length === 0) await get().loadOvens();

      const [roasts, batches, ovens, existingRuns] = await Promise.all([
        listRoasts(),
        listBatches(),
        listOvens(),
        listOvenRuns(),
      ]);
      const plan = computeOvenPlan({ roasts, batches, ovens, existingRuns });

      // 排不下：不写入任何内容（库中保持原排程），把批次列为待处理
      if (plan.unscheduled.length > 0) {
        set({ ovens, runs: existingRuns, baseRevisions: revisionsOf(ovens), unscheduled: plan.unscheduled });
        return 'unscheduled';
      }

      // 方案与库中一致：跳过写入，避免无谓的 revision 递增误伤另一标签页
      if (planSignatureOf(existingRuns) === planSignatureOf([...plan.kept, ...plan.added])) {
        set({ ovens, runs: existingRuns, baseRevisions: revisionsOf(ovens), unscheduled: [], conflicts: [], pendingDraft: null });
        return 'noop';
      }

      const stamp = nowIso();
      const upsertRuns: OvenRun[] = [
        // 被修正过的冻结炉次（剔除失效道次后合计有变化）按原 id 写回
        ...plan.kept.filter((run) => {
          const original = existingRuns.find((item) => item.id === run.id);
          return !original || planSignatureOf([original]) !== planSignatureOf([run]);
        }),
        ...plan.added.map((draft) => ({ ...draft, id: createId(ID_PREFIX.ovenRun), createdAt: stamp, updatedAt: stamp })),
      ];

      try {
        const bumped = await commitOvenPlan({ baseRevisions: get().baseRevisions, removeRunIds: plan.removedRunIds, upsertRuns });
        const runs = await listOvenRuns();
        set({
          ovens: bumped,
          runs,
          baseRevisions: revisionsOf(bumped),
          unscheduled: [],
          conflicts: [],
          pendingDraft: null,
        });
        return 'ok';
      } catch (error) {
        if (!(error instanceof OvenScheduleConflictError)) throw error;
        // 冲突：另一标签页已先保存。保留我方方案供对照，列出逐炉位冲突，绝不覆盖对方
        const [currentOvens, currentRuns] = await Promise.all([listOvens(), listOvenRuns()]);
        const attempted = [...plan.kept, ...upsertRuns];
        set({
          ovens: currentOvens,
          runs: currentRuns,
          conflicts: diffOvenPlans(attempted, currentRuns),
          pendingDraft: attempted,
        });
        return 'conflict';
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '炉次排程保存失败' });
      return 'error';
    } finally {
      inflight = false;
      if (queued) {
        queued = false;
        void get().reschedule();
      }
    }
  },

  async acceptLatest() {
    await get().loadOvens();
    set({ conflicts: [], pendingDraft: null });
  },
}));

export default useOvenStore;
