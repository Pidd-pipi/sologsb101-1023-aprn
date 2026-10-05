/**
 * 焙炉与炉次（Oven / OvenRun）：炭焙间两座炉的排程
 * - 两座炉容量固定；炉次按复焙日期、鲜叶重量与焙火时长自动排定
 * - 同炉同日可拼炉（合计 ≤ 容量），拼不下就排队到下一炉次
 * - 已开焙（焙火中 / 已足火）道次所在炉次冻结，重排时保持原样
 */

/** 每炉每日最大焙火工时（小时）：当日排满后只能另开炉次，仍排不下则整批回退 */
export const OVEN_DAILY_HOURS = 24;

/** 焙炉实体（持久化到 ovens 表；revision 用于多标签页乐观锁） */
export interface Oven {
  id: string;
  /** 炉名，例如「一号炉」 */
  name: string;
  /** 单炉次容量（鲜叶 kg） */
  capacityKg: number;
  /** 排程版本号：每次成功写入排程 +1，用于跨标签页冲突检测 */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 炉次实体（持久化到 ovenRuns 表）：一炉一次同焙的若干道次 */
export interface OvenRun {
  id: string;
  /** 所属焙炉 id（ovenId 外键） */
  ovenId: string;
  /** 炉次序号：同炉同日内从 1 开始 */
  runNo: number;
  /** 开焙日期 YYYY-MM-DD（取成员道次的复焙日期） */
  date: string;
  /** 本炉次时长（小时）= 成员道次时长最大值 */
  hours: number;
  /** 本炉次鲜叶总重（kg）= 成员批次鲜叶重量合计 */
  totalKg: number;
  /** 成员焙火道次 id 列表（roastId 外键） */
  roastIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** 排程计算产物：尚未持久化的炉次（id / 时间戳在写入前补齐） */
export type OvenRunDraft = Pick<OvenRun, 'ovenId' | 'runNo' | 'date' | 'hours' | 'totalKg' | 'roastIds'>;

/** 排不下的道次（整批回退后列为待处理） */
export interface UnscheduledItem {
  roastId: string;
  batchId: string;
  /** 复焙日期 YYYY-MM-DD */
  date: string;
  /** 批次鲜叶重量（kg） */
  kg: number;
  /** 排不下的原因说明 */
  reason: string;
}

/** 多标签页排程冲突条目：同一炉位我方方案与库中当前方案不一致 */
export interface OvenRunConflict {
  ovenId: string;
  date: string;
  runNo: number;
  /** 我方方案的成员道次 id（空数组表示我方未排此炉位） */
  mine: string[];
  /** 对方（库中当前）方案的成员道次 id（空数组表示对方无此炉位） */
  theirs: string[];
  /** 双方炉次时长 h（无此炉位时为 null），便于展示成员一致但参数不同的冲突 */
  mineHours: number | null;
  theirsHours: number | null;
  /** 双方炉次总重 kg（无此炉位时为 null） */
  mineKg: number | null;
  theirsKg: number | null;
}

/** 默认两座炉（首屏播种与 v3 迁移共用；固定 id 保证幂等） */
export const DEFAULT_OVEN_SEEDS = [
  { id: 'oven-yi', name: '一号炉', capacityKg: 60 },
  { id: 'oven-er', name: '二号炉', capacityKg: 45 },
] as const;
