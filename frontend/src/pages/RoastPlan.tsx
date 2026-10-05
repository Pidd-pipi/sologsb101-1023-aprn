/**
 * /roasting 焙火曲线与复焙安排
 * - 多道次按序排列（上移 / 下移写回 passNo）、温度时长与炭种登记
 * - 足火判定（轻火 / 中火 / 足火）与状态流转：待焙 → 焙火中 → 已足火（足火后回写批次为已焙火）
 * - 复焙提醒面板：逾期 / 今日 / 7 日内 / 已排期
 * - 炭焙间两座炉排程：按复焙日期 / 鲜叶重量 / 焙火时长自动排炉，同炉超容量排队到下一炉次，
 *   已开焙道次所在炉次保持原样；排不下则恢复原排程并列出待处理批次；
 *   多标签页同时排同一炉时，后保存的一方保留方案并列出冲突，不覆盖对方
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  FireOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import FilterBar, { type FilterSelectConfig } from '../components/common/FilterBar';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useGardenStore } from '../stores/gardenStore';
import { useBatchStore } from '../stores/batchStore';
import {
  buildReminders,
  filterRoasts,
  fireLevelOfBatch,
  fireLoadOfBatch,
  roastsOfBatch,
  useRoastStore,
} from '../stores/roastStore';
import { useOvenStore, type RescheduleResult } from '../stores/ovenStore';
import { CHARCOAL_OPTIONS, ROAST_LIMITS, ROAST_STATES, type Roast, type RoastDraft } from '../types/roast';
import { OVEN_DAILY_HOURS } from '../types/oven';
import type { Batch } from '../types/batch';
import {
  CHARCOAL_COLOR,
  FIRE_LEVEL_ADVICE,
  FIRE_THRESHOLDS,
  REMINDER_COLOR,
  REMINDER_LABEL,
  batchLabel,
  isFullFire,
  roundTo,
} from '../utils/tea';

export default function RoastPlan() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<RoastDraft>();

  const batches = useBatchStore((state) => state.batches);
  const gardens = useGardenStore((state) => state.gardens);

  const roasts = useRoastStore((state) => state.roasts);
  const roastFilters = useRoastStore((state) => state.filters);
  const setFilters = useRoastStore((state) => state.setFilters);
  const resetFilters = useRoastStore((state) => state.resetFilters);
  const loadRoasts = useRoastStore((state) => state.loadRoasts);
  const createRoast = useRoastStore((state) => state.createRoast);
  const updateRoast = useRoastStore((state) => state.updateRoast);
  const deleteRoast = useRoastStore((state) => state.deleteRoast);
  const advanceRoastState = useRoastStore((state) => state.advanceRoastState);
  const movePass = useRoastStore((state) => state.movePass);

  const ovens = useOvenStore((state) => state.ovens);
  const ovenRuns = useOvenStore((state) => state.runs);
  const ovenConflicts = useOvenStore((state) => state.conflicts);
  const unscheduled = useOvenStore((state) => state.unscheduled);
  const loadOvens = useOvenStore((state) => state.loadOvens);
  const reschedule = useOvenStore((state) => state.reschedule);
  const acceptLatest = useOvenStore((state) => state.acceptLatest);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRoast, setEditingRoast] = useState<Roast | null>(null);
  const [scheduling, setScheduling] = useState(false);

  useEffect(() => {
    void loadRoasts();
    void loadOvens();
  }, [loadRoasts, loadOvens]);

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const labelOfBatch = (batchId: string): string => {
    const batch = batchMap.get(batchId);
    if (!batch) return '未知批次';
    return batchLabel(batch, gardenMap.get(batch.gardenId)?.name);
  };

  const rows = useMemo(() => filterRoasts(roasts, batches, gardens, roastFilters), [batches, gardens, roastFilters, roasts]);
  const reminders = useMemo(() => buildReminders(roasts), [roasts]);

  /* --------------------------- 两座炉排程派生数据 --------------------------- */

  const roastMap = useMemo(() => new Map(roasts.map((roast) => [roast.id, roast])), [roasts]);
  const ovenMap = useMemo(() => new Map(ovens.map((oven) => [oven.id, oven])), [ovens]);

  /** 炉次按炉分组，组内按日期 + 炉次序号排列 */
  const runsByOven = useMemo(
    () =>
      ovens.map((oven) => ({
        oven,
        list: ovenRuns
          .filter((run) => run.ovenId === oven.id)
          .sort((a, b) => a.date.localeCompare(b.date) || a.runNo - b.runNo),
      })),
    [ovens, ovenRuns],
  );

  /** 含已开焙道次的炉次（冻结，重排时保持原样） */
  const frozenRunIds = useMemo(
    () =>
      new Set(
        ovenRuns
          .filter((run) => run.roastIds.some((id) => (roastMap.get(id)?.state ?? '待焙') !== '待焙'))
          .map((run) => run.id),
      ),
    [ovenRuns, roastMap],
  );

  /** 待处理：待焙且已填复焙日期、但未排进任何炉次的道次 */
  const pendingRoasts = useMemo(() => {
    const scheduledIds = new Set(ovenRuns.flatMap((run) => run.roastIds));
    return roasts.filter((roast) => roast.state === '待焙' && roast.nextRoastDate && !scheduledIds.has(roast.id));
  }, [roasts, ovenRuns]);

  /** 道次展示名：批次标签 + 第 N 道 */
  const labelOfRoast = (roastId: string): string => {
    const roast = roastMap.get(roastId);
    if (!roast) return '已删除道次';
    return `${labelOfBatch(roast.batchId)} · 第 ${roast.passNo} 道`;
  };

  /** 冲突条目一侧的文案：成员道次 + 时长 / 总重 */
  const conflictSide = (roastIds: string[], hours: number | null, kg: number | null): string => {
    if (roastIds.length === 0) return '空炉位';
    return `${roastIds.map(labelOfRoast).join('、')}（${hours ?? '-'} h · ${kg ?? '-'} kg）`;
  };

  /** 重排结果提示文案 */
  const notifyReschedule = (result: RescheduleResult): void => {
    if (result === 'ok') message.success('两座炉排程已重算并保存');
    else if (result === 'noop') message.info('排程已是最新，无需调整');
    else if (result === 'unscheduled') message.warning('有批次排不下，已恢复原排程并列为待处理');
    else if (result === 'conflict') message.warning('另一标签页已更新炉次排程，本次未覆盖对方，请查看冲突列表');
    else message.error('炉次排程保存失败，请重试');
  };

  const handleReschedule = async (): Promise<void> => {
    setScheduling(true);
    try {
      notifyReschedule(await reschedule());
    } finally {
      setScheduling(false);
    }
  };

  /** 冲突后：放弃我方未保存方案，载入库中最新排程 */
  const handleAcceptLatest = async (): Promise<void> => {
    await acceptLatest();
    message.info('已放弃未保存的方案，载入最新排程');
  };

  /** 冲突后：以库中最新数据为基准重新排程（双方的道次改动都会纳入） */
  const handleReapply = async (): Promise<void> => {
    setScheduling(true);
    try {
      await acceptLatest();
      notifyReschedule(await reschedule());
    } finally {
      setScheduling(false);
    }
  };

  /** 过滤结果按批次分组 */
  const grouped = useMemo(() => {
    const map = new Map<string, Roast[]>();
    rows.forEach((roast) => {
      map.set(roast.batchId, [...(map.get(roast.batchId) ?? []), roast]);
    });
    return [...map.entries()].map(([batchId, list]) => ({
      batchId,
      list: [...list].sort((a, b) => a.passNo - b.passNo),
    }));
  }, [rows]);

  const stats = useMemo(() => {
    const totalLoad = roundTo(
      rows.reduce((acc, roast) => acc + roast.tempC * roast.hours, 0),
      1,
    );
    const batchCount = new Set(rows.map((roast) => roast.batchId)).size;
    const fullFireCount = rows.filter((roast) => roast.state === '已足火').length;
    const soonCount = reminders.filter((item) => item.level === 'overdue' || item.level === 'today' || item.level === 'soon').length;
    const averageTemp = rows.length > 0 ? roundTo(rows.reduce((acc, roast) => acc + roast.tempC, 0) / rows.length, 1) : 0;
    return { totalLoad, batchCount, fullFireCount, soonCount, averageTemp };
  }, [reminders, rows]);

  const selectConfigs: FilterSelectConfig[] = [
    {
      key: 'batchIds',
      label: '按批次筛选',
      options: batches.map((batch) => ({ value: batch.id, label: labelOfBatch(batch.id) })),
      width: 240,
    },
    {
      key: 'states',
      label: '按道次状态筛选',
      options: ROAST_STATES.map((value) => ({ value, label: value })),
      width: 176,
    },
    {
      key: 'charcoals',
      label: '按炭种筛选',
      options: CHARCOAL_OPTIONS.map((value) => ({ value, label: value })),
      width: 168,
    },
    {
      key: 'gardenIds',
      label: '按山场筛选',
      options: gardens.map((garden) => ({ value: garden.id, label: garden.name })),
    },
  ];

  const openModal = (batchId?: string, roast?: Roast): void => {
    setEditingRoast(roast ?? null);
    setModalOpen(true);
    if (roast) {
      form.setFieldsValue({
        batchId: roast.batchId,
        tempC: roast.tempC,
        hours: roast.hours,
        charcoal: roast.charcoal,
        nextRoastDate: roast.nextRoastDate,
        state: roast.state,
      });
    } else {
      const branch = batchId ? roastsOfBatch(roasts, batchId) : [];
      const last = branch[branch.length - 1];
      form.setFieldsValue({
        batchId: batchId ?? batches[0]?.id,
        tempC: last ? Math.min(ROAST_LIMITS.tempC.max, last.tempC + 5) : 95,
        hours: last ? last.hours : 5,
        charcoal: last ? last.charcoal : '荔枝炭',
        nextRoastDate: '',
        state: '待焙',
      });
    }
  };

  const submit = async (values: RoastDraft): Promise<void> => {
    try {
      if (editingRoast) {
        await updateRoast(editingRoast.id, values);
        message.success(`第 ${editingRoast.passNo} 道焙火已更新`);
      } else {
        const created = await createRoast(values);
        message.success(`已新增第 ${created.passNo} 道焙火`);
      }
      setModalOpen(false);
      setEditingRoast(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '焙火记录保存失败');
    }
  };

  const confirmDelete = (roast: Roast): void => {
    modal.confirm({
      title: `删除第 ${roast.passNo} 道焙火？`,
      content: `批次：${labelOfBatch(roast.batchId)}。删除后同批次其余道次会重排 passNo。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteRoast(roast.id);
          message.success('焙火道次已删除并重排');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const handleAdvance = async (roast: Roast): Promise<void> => {
    const next = await advanceRoastState(roast.id);
    if (next) {
      message.success(`第 ${roast.passNo} 道状态已推进到「${next}」${next === '已足火' ? '，批次已回写为「已焙火」' : ''}`);
    } else {
      message.info('该道次已是「已足火」');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            焙火曲线与复焙安排
          </Typography.Title>
          <div className="page-hint">
            多道次按序排列，逐道推进「待焙 → 焙火中 → 已足火」；累计热负荷达到 {FIRE_THRESHOLDS.full} ℃·h 且不
            少于两道次即判定足火。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void loadRoasts()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()} disabled={batches.length === 0}>
            新建焙火道次
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="焙火道次" value={rows.length} suffix={`/ ${roasts.length}`} tone="primary" />
        <StatBadge label="涉及批次" value={stats.batchCount} suffix="个" />
        <StatBadge label="累计热负荷" value={stats.totalLoad} suffix="℃·h" tone="warning" hint="温度 × 时长求和" />
        <StatBadge label="平均温度" value={stats.averageTemp} suffix="℃" tone="info" />
        <StatBadge label="已足火道次" value={stats.fullFireCount} suffix="道" tone="success" />
        <StatBadge
          label="待复焙（含逾期）"
          value={stats.soonCount}
          suffix="条"
          tone={stats.soonCount > 0 ? 'danger' : 'default'}
          hint="7 日内到期或已逾期的复焙提醒"
        />
        <StatBadge label="已排炉次" value={ovenRuns.length} suffix="炉" tone="primary" hint="两座炉已排定的炉次总数" />
        <StatBadge
          label="待处理批次"
          value={new Set(pendingRoasts.map((roast) => roast.batchId)).size}
          suffix="个"
          tone={pendingRoasts.length > 0 ? 'danger' : 'default'}
          hint="已填复焙日期但未排进炉次的待焙道次"
        />
      </div>

      <Card
        className="panel-card"
        title={
          <Space size={8}>
            <ScheduleOutlined />
            <span>炭焙间炉次排程</span>
            {ovens.map((oven) => (
              <Tag key={oven.id} color="geekblue">
                {oven.name} · {oven.capacityKg} kg
              </Tag>
            ))}
            {pendingRoasts.length > 0 ? <Tag color="red">待处理 {pendingRoasts.length} 道</Tag> : null}
          </Space>
        }
        extra={
          <Tooltip title="按复焙日期、鲜叶重量与焙火时长重算两座炉；已开焙道次所在炉次保持原样">
            <Button size="small" type="primary" ghost icon={<ReloadOutlined />} loading={scheduling} onClick={() => void handleReschedule()}>
              重新排程
            </Button>
          </Tooltip>
        }
        style={{ marginBottom: 14 }}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 10 }}>
          待焙且已填复焙日期的道次按「复焙日期 → 鲜叶重量 → 时长」排入两座炉；同炉同日合计不超容量可同焙，
          超容量即排队到下一炉次；每炉每日工时 ≤ {OVEN_DAILY_HOURS} h。焙火时长或鲜叶重量变动会自动重算，
          已开焙道次所在炉次保持原样。
        </Typography.Paragraph>

        {ovenConflicts.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="另一标签页已更新炉次排程：你的方案未保存（未覆盖对方），冲突炉位如下"
            description={
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {ovenConflicts.map((conflict) => (
                  <li key={`${conflict.ovenId}|${conflict.date}|${conflict.runNo}`}>
                    {ovenMap.get(conflict.ovenId)?.name ?? conflict.ovenId} · {conflict.date} · 第 {conflict.runNo} 炉：
                    对方 [{conflictSide(conflict.theirs, conflict.theirsHours, conflict.theirsKg)}]
                    ／ 我方 [{conflictSide(conflict.mine, conflict.mineHours, conflict.mineKg)}]
                  </li>
                ))}
              </ul>
            }
            action={
              <Space direction="vertical" size={4}>
                <Button size="small" onClick={() => void handleAcceptLatest()}>
                  放弃我的方案
                </Button>
                <Button size="small" type="primary" loading={scheduling} onClick={() => void handleReapply()}>
                  以最新数据重排
                </Button>
              </Space>
            }
          />
        ) : null}

        {unscheduled.length > 0 ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 10 }}
            message="有批次排不下，已恢复原排程"
            description={
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {unscheduled.map((item) => (
                  <li key={item.roastId}>
                    {labelOfRoast(item.roastId)}（{item.date} · {item.kg} kg）：{item.reason}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}

        <Row gutter={[14, 14]}>
          {runsByOven.map(({ oven, list }) => (
            <Col key={oven.id} xs={24} lg={12}>
              <div className="oven-col">
                <Space size={8} wrap>
                  <strong>{oven.name}</strong>
                  <Tag>容量 {oven.capacityKg} kg</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {list.length} 个炉次
                  </Typography.Text>
                </Space>
                {list.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无炉次：给待焙道次填复焙日期后重新排程"
                    style={{ margin: '12px 0' }}
                  />
                ) : (
                  list.map((run) => {
                    const frozen = frozenRunIds.has(run.id);
                    const overCapacity = run.totalKg > oven.capacityKg;
                    return (
                      <div key={run.id} className={`oven-run ${frozen ? 'is-locked' : ''}`}>
                        <Space size={8} wrap>
                          <strong className="mono">
                            {run.date} · 第 {run.runNo} 炉
                          </strong>
                          {frozen ? (
                            <Tag icon={<LockOutlined />} color="processing">
                              已开焙
                            </Tag>
                          ) : null}
                          <Tag color={overCapacity ? 'red' : 'default'} className={overCapacity ? 'oven-run-over' : ''}>
                            {run.totalKg} / {oven.capacityKg} kg
                          </Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {run.hours} h
                          </Typography.Text>
                        </Space>
                        <div className="oven-run-members">
                          {run.roastIds.map((roastId) => (
                            <Tag key={roastId}>{labelOfRoast(roastId)}</Tag>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Col>
          ))}
        </Row>

        {pendingRoasts.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <Typography.Text strong type="danger">
              待处理批次：
            </Typography.Text>
            <Space wrap size={6} style={{ marginLeft: 6 }}>
              {pendingRoasts.map((roast) => (
                <Tag key={roast.id} color="red">
                  {labelOfRoast(roast.id)} · {roast.nextRoastDate}
                </Tag>
              ))}
            </Space>
          </div>
        ) : null}
      </Card>

      <Card
        className="panel-card"
        title={
          <Space size={8}>
            <FireOutlined />
            <span>复焙提醒</span>
            <Tag color={reminders.length > 0 ? 'volcano' : 'default'}>{reminders.length} 条</Tag>
          </Space>
        }
        style={{ marginBottom: 14 }}
      >
        {reminders.length === 0 ? (
          <Typography.Text type="secondary">暂无复焙安排：在道次表单里填写「复焙日期」即可生成提醒。</Typography.Text>
        ) : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {reminders.map((reminder) => (
              <Space key={reminder.roastId} size={10} wrap>
                <Tag color={REMINDER_COLOR[reminder.level]}>{REMINDER_LABEL[reminder.level]}</Tag>
                <span>{labelOfBatch(reminder.batchId)}</span>
                <span>第 {reminder.passNo} 道</span>
                <span className="mono">{reminder.nextRoastDate}</span>
                <Typography.Text type={reminder.daysLeft < 0 ? 'danger' : 'secondary'}>
                  {reminder.daysLeft < 0
                    ? `已逾期 ${Math.abs(reminder.daysLeft)} 天`
                    : reminder.daysLeft === 0
                      ? '今天应复焙'
                      : `还有 ${reminder.daysLeft} 天`}
                </Typography.Text>
              </Space>
            ))}
          </Space>
        )}
      </Card>

      <FilterBar
        value={roastFilters}
        onChange={setFilters}
        selects={selectConfigs}
        onReset={resetFilters}
        placeholder="搜索山场 / 批次 / 炭种 / 道次"
      />

      {roasts.length === 0 ? (
        <EmptyPanel
          title="还没有焙火记录"
          description="毛茶拣剔后即可排第 1 道焙火：填温度、时长与炭种，并约定复焙日期。"
          actionText="新建焙火道次"
          onAction={() => openModal()}
        />
      ) : grouped.length === 0 ? (
        <EmptyPanel
          size="small"
          title="没有命中筛选条件的焙火道次"
          description="试试调整批次、道次状态、炭种或山场。"
          secondaryText="重置筛选"
          onSecondary={resetFilters}
        />
      ) : (
        <Row gutter={[14, 14]}>
          {grouped.map((group) => {
            const branch = roastsOfBatch(roasts, group.batchId);
            const fireLevel = fireLevelOfBatch(roasts, group.batchId);
            const load = fireLoadOfBatch(roasts, group.batchId);
            const fullFire = isFullFire(branch);
            return (
              <Col key={group.batchId} xs={24} xl={12}>
                <Card
                  className="panel-card"
                  title={
                    <Space size={8} wrap>
                      <span>{labelOfBatch(group.batchId)}</span>
                      <GradeTag kind="fire" value={fireLevel} />
                      {fullFire ? <Tag color="volcano">足火判定通过</Tag> : null}
                    </Space>
                  }
                  extra={
                    <Tooltip title="按上一道参数 +5 ℃ 追加下一道">
                      <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openModal(group.batchId)}>
                        追加道次
                      </Button>
                    </Tooltip>
                  }
                >
                  <Space size={16} wrap style={{ marginBottom: 10 }}>
                    <StatBadge size="small" label="道次" value={branch.length} suffix="道" />
                    <StatBadge size="small" label="累计热负荷" value={load} suffix="℃·h" tone="warning" />
                    <StatBadge size="small" label="足火阈值" value={FIRE_THRESHOLDS.full} suffix="℃·h" />
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {FIRE_LEVEL_ADVICE[fireLevel]}
                  </Typography.Text>

                  <div style={{ marginTop: 10 }}>
                    {group.list.map((roast, index) => (
                      <div key={roast.id} className={`roast-pass ${roast.state === '已足火' ? 'is-fullfire' : ''}`}>
                        <strong style={{ width: 58 }}>第 {roast.passNo} 道</strong>
                        <span style={{ width: 92 }}>
                          {roast.tempC} ℃ / {roast.hours} h
                        </span>
                        <Tag color={CHARCOAL_COLOR[roast.charcoal]}>{roast.charcoal}</Tag>
                        <GradeTag kind="roastState" value={roast.state} />
                        <span className="mono" style={{ fontSize: 12, color: 'rgba(43,42,38,0.6)' }}>
                          {roast.nextRoastDate ? `复焙 ${roast.nextRoastDate}` : '未排复焙'}
                        </span>
                        <Space size={2} style={{ marginLeft: 'auto' }}>
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowUpOutlined />}
                            disabled={index === 0}
                            onClick={() => void movePass(roast.id, 'up')}
                          />
                          <Button
                            size="small"
                            type="text"
                            icon={<ArrowDownOutlined />}
                            disabled={index === group.list.length - 1}
                            onClick={() => void movePass(roast.id, 'down')}
                          />
                          <Button size="small" type="link" onClick={() => void handleAdvance(roast)}>
                            推进状态
                          </Button>
                          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openModal(undefined, roast)} />
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(roast)} />
                        </Space>
                      </div>
                    ))}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {groupsWithoutRoast(batches, roasts).length > 0 ? (
        <Card className="panel-card" style={{ marginTop: 14 }} title="尚未排焙火的批次">
          <Space wrap size={8}>
            {groupsWithoutRoast(batches, roasts).map((batch) => (
              <Tag key={batch.id} color="gold" style={{ padding: '4px 8px' }}>
                {batchLabel(batch, gardenMap.get(batch.gardenId)?.name)}
                <Button size="small" type="link" onClick={() => openModal(batch.id)}>
                  排第 1 道
                </Button>
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}

      {batches.length === 0 ? (
        <Empty
          style={{ marginTop: 16 }}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有茶青批次，先到山场台账登记批次"
        />
      ) : null}

      <Modal
        open={modalOpen}
        title={editingRoast ? `编辑第 ${editingRoast.passNo} 道焙火` : '新建焙火道次'}
        okText={editingRoast ? '保存' : '新增道次'}
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          setEditingRoast(null);
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(values: RoastDraft) => void submit(values)}>
          <Row gutter={12}>
            <Col span={24}>
              <Form.Item label="茶青批次" name="batchId" rules={[{ required: true, message: '请选择茶青批次' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  disabled={editingRoast !== null}
                  options={batches.map((batch) => ({
                    value: batch.id,
                    label: `${batchLabel(batch, gardenMap.get(batch.gardenId)?.name)} · ${batch.state}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="焙火温度（℃）"
                name="tempC"
                rules={[
                  { required: true, message: '请填写温度' },
                  {
                    type: 'number',
                    min: ROAST_LIMITS.tempC.min,
                    max: ROAST_LIMITS.tempC.max,
                    message: `温度需在 ${ROAST_LIMITS.tempC.min}-${ROAST_LIMITS.tempC.max} ℃`,
                  },
                ]}
              >
                <InputNumber min={ROAST_LIMITS.tempC.min} max={ROAST_LIMITS.tempC.max} step={5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="时长（小时）"
                name="hours"
                rules={[
                  { required: true, message: '请填写时长' },
                  {
                    type: 'number',
                    min: ROAST_LIMITS.hours.min,
                    max: ROAST_LIMITS.hours.max,
                    message: `时长需在 ${ROAST_LIMITS.hours.min}-${ROAST_LIMITS.hours.max} 小时`,
                  },
                ]}
              >
                <InputNumber min={ROAST_LIMITS.hours.min} max={ROAST_LIMITS.hours.max} step={0.5} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="炭种" name="charcoal" rules={[{ required: true, message: '请选择炭种' }]}>
                <Select options={CHARCOAL_OPTIONS.map((value) => ({ value, label: value }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="道次状态" name="state" rules={[{ required: true, message: '请选择道次状态' }]}>
                <Select options={ROAST_STATES.map((value) => ({ value, label: value }))} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                label="复焙日期"
                name="nextRoastDate"
                rules={[{ pattern: /^$|^\d{4}-\d{2}-\d{2}$/, message: '日期格式需为 YYYY-MM-DD，或不填' }]}
                extra="留空表示暂不复焙；填写后会在复焙提醒面板按到期紧急度排序"
              >
                <Input placeholder="2025-09-30" allowClear />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}

/** 还没有任何焙火道次的批次 */
function groupsWithoutRoast(batches: Batch[], roasts: Roast[]): Batch[] {
  const touched = new Set(roasts.map((roast) => roast.batchId));
  return batches.filter((batch) => !touched.has(batch.id));
}
