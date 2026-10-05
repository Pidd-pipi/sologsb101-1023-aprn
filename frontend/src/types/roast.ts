/**
 * 焙火（Roast）：多道次焙火曲线与复焙安排
 * 状态流转：待焙 → 焙火中 → 已足火。
 */

/** 炭种枚举 */
export const CHARCOAL_OPTIONS = ['荔枝炭', '龙眼炭', '机制炭'] as const;
export type Charcoal = (typeof CHARCOAL_OPTIONS)[number];

/** 焙火状态枚举（数组顺序即流转顺序） */
export const ROAST_STATES = ['待焙', '焙火中', '已足火'] as const;
export type RoastState = (typeof ROAST_STATES)[number];

/** 参数合法区间 */
export const ROAST_LIMITS = {
  tempC: { min: 40, max: 160 },
  hours: { min: 0.5, max: 48 },
} as const;

/* --------------------------- 炭焙间炉位 --------------------------- */

/** 炭焙间炉位枚举（两座炉） */
export const OVEN_OPTIONS = ['炉一', '炉二'] as const;
export type OvenId = (typeof OVEN_OPTIONS)[number];

/** 炉位定义：单炉次可容纳的鲜叶总重上限（kg） */
export interface OvenDef {
  id: OvenId;
  /** 炉容量：同一炉次内各道次鲜叶重量合计的上限 */
  capacityKg: number;
}

/** 炭焙间两座炉：炉一大容量、炉二小容量 */
export const OVEN_ROOM: OvenDef[] = [
  { id: '炉一', capacityKg: 60 },
  { id: '炉二', capacityKg: 45 },
];

/** 每日开炉时刻（小时）：复焙日期当天从该时刻起可排炉 */
export const OVEN_WORKDAY_START_HOUR = 8;

/** 相邻两炉之间的清炉间隔（分钟） */
export const OVEN_TURNAROUND_MIN = 60;

/** 焙火道次实体（持久化到 IndexedDB 的 roasts 表） */
export interface Roast {
  id: string;
  /** 所属批次 id（batchId 外键） */
  batchId: string;
  /** 道次，从 1 开始；按序排列 */
  passNo: number;
  /** 焙火温度 ℃ */
  tempC: number;
  /** 时长（小时） */
  hours: number;
  /** 炭种：荔枝炭 / 龙眼炭 / 机制炭 */
  charcoal: Charcoal;
  /** 复焙日期 YYYY-MM-DD，空串表示不复焙 */
  nextRoastDate: string;
  /** 焙火状态 */
  state: RoastState;
  /** 炉位（炉一 / 炉二）；空串表示未排炉 */
  ovenId: OvenId | '';
  /** 炉次日期 YYYY-MM-DD；空串表示未排炉 */
  slotDate: string;
  /** 当日第几炉（1 起）；0 表示未排炉 */
  slotSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑焙火道次表单草稿 */
export interface RoastDraft {
  batchId: string;
  tempC: number;
  hours: number;
  charcoal: Charcoal;
  nextRoastDate: string;
  state: RoastState;
}

/** 复焙提醒：到期或临期的道次 */
export interface RoastReminder {
  roastId: string;
  batchId: string;
  passNo: number;
  nextRoastDate: string;
  /** 距今天数，负数表示已过期 */
  daysLeft: number;
  level: 'overdue' | 'today' | 'soon' | 'planned';
}

/** 火功档位：轻火 / 中火 / 足火（由累计温度时长换算） */
export type FireLevel = '轻火' | '中火' | '足火';

/** 下一道工序状态；已足火返回 null */
export function nextRoastState(state: RoastState): RoastState | null {
  const index = ROAST_STATES.indexOf(state);
  if (index < 0 || index >= ROAST_STATES.length - 1) return null;
  return ROAST_STATES[index + 1];
}
