/**
 * 炭焙间两座炉排程面板（components/roasting/OvenBoard.tsx）· 被焙火页 /roasting 消费
 * - 按「复焙日期 → 鲜叶重量 → 焙火时长」把待焙道次装进炉一 / 炉二的炉次：
 *   同炉次鲜叶总重不超炉容量，装不下排队到下一炉；已开焙道次保持原排程
 * - 焙火时长 / 鲜叶重量 / 复焙日期变化后提示重算，一键重排并保存
 * - 两个标签页同时改同一炉：后保存的一方保留排程预览并列出冲突，不覆盖对方
 * - 排不下的批次自动列为待处理，原排程保持不变
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Modal, Row, Space, Tag, Typography } from 'antd';
import { FireOutlined, GoldOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import GradeTag from '../common/GradeTag';
import StatBadge from '../common/StatBadge';
import { useBatchStore } from '../../stores/batchStore';
import { useGardenStore } from '../../stores/gardenStore';
import { useRoastStore } from '../../stores/roastStore';
import { OVEN_ROOM } from '../../types/roast';
import {
  buildOvenSchedule,
  groupPersistedSlots,
  localClockOf,
  persistedAssignments,
  sameAssignments,
  type SaveScheduleResult,
} from '../../utils/ovenSchedule';
import { batchLabel, todayIso } from '../../utils/tea';

export default function OvenBoard() {
  const { message, modal } = App.useApp();

  const roasts = useRoastStore((state) => state.roasts);
  const scheduleDraft = useRoastStore((state) => state.scheduleDraft);
  const scheduleConflicts = useRoastStore((state) => state.scheduleConflicts);
  const saveSchedule = useRoastStore((state) => state.saveSchedule);
  const rebaseAndSaveSchedule = useRoastStore((state) => state.rebaseAndSaveSchedule);
  const discardScheduleDraft = useRoastStore((state) => state.discardScheduleDraft);

  const batches = useBatchStore((state) => state.batches);
  const gardens = useGardenStore((state) => state.gardens);

  const [saving, setSaving] = useState(false);
  const [conflictDismissed, setConflictDismissed] = useState(false);

  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const labelOfBatch = (batchId: string): string => {
    const batch = batchMap.get(batchId);
    return batch ? batchLabel(batch, gardenMap.get(batch.gardenId)?.name) : '未知批次';
  };

  /** 现算预览：与已保存炉位不一致即「参数已变、炉位未重算」 */
  const preview = useMemo(() => buildOvenSchedule(roasts, batches), [roasts, batches]);
  const dirty = useMemo(
    () => !sameAssignments(persistedAssignments(roasts), preview.assignments),
    [preview.assignments, roasts],
  );
  const slots = useMemo(() => groupPersistedSlots(roasts, batches), [batches, roasts]);
  const unscheduled = useMemo(
    () => roasts.filter((roast) => roast.state === '待焙' && (!roast.ovenId || !roast.slotDate || roast.slotSeq <= 0)),
    [roasts],
  );
  const pendingBatches = useMemo(() => batches.filter((batch) => batch.roastPending), [batches]);
  const scheduledCount = roasts.filter((roast) => roast.state === '待焙').length - unscheduled.length;

  // 新一批冲突到达时重新展开冲突弹窗
  useEffect(() => {
    if (scheduleConflicts.length > 0) setConflictDismissed(false);
  }, [scheduleConflicts]);

  const notifyResult = (result: SaveScheduleResult): void => {
    if (result.ok) {
      message.success(`炉次已重排保存：两座炉共 ${result.slotCount} 个炉次`);
      return;
    }
    if (result.reason === 'unschedulable') {
      modal.warning({
        title: '有批次排不下，已恢复原排程',
        content: (
          <div>
            <p style={{ marginBottom: 8 }}>以下道次无法装入任何一座炉，本次重排未写入，相关批次已列为待处理：</p>
            <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
              {result.items.map((item) => (
                <li key={item.roastId}>
                  {labelOfBatch(item.batchId)} · 第 {item.passNo} 道：{item.reason}
                </li>
              ))}
            </ul>
          </div>
        ),
      });
    }
    // reason === 'conflict'：由下方受控 Modal 列出冲突明细
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      notifyResult(await saveSchedule());
    } finally {
      setSaving(false);
    }
  };

  const handleRebase = async (): Promise<void> => {
    setSaving(true);
    try {
      notifyResult(await rebaseAndSaveSchedule());
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      className="panel-card"
      title={
        <Space size={8}>
          <GoldOutlined />
          <span>炭焙间炉次排程</span>
          <Tag color="blue">两座炉</Tag>
        </Space>
      }
      extra={
        <Button
          type="primary"
          size="small"
          icon={<ReloadOutlined />}
          loading={saving}
          onClick={() => void handleSave()}
        >
          重排炉次
        </Button>
      }
      style={{ marginBottom: 14 }}
    >
      <div className="stat-row" style={{ marginBottom: 12 }}>
        <StatBadge label="已排炉次" value={slots.length} suffix="炉" tone="primary" hint="两座炉已保存的炉次合计" />
        <StatBadge
          label="今日炉次"
          value={slots.filter((slot) => slot.slotDate === todayIso()).length}
          suffix="炉"
          tone="info"
        />
        <StatBadge
          label="待焙已排 / 未排"
          value={`${scheduledCount} / ${unscheduled.length}`}
          suffix="道"
          tone={unscheduled.length > 0 ? 'warning' : 'success'}
        />
        <StatBadge
          label="排程待处理"
          value={pendingBatches.length}
          suffix="批"
          tone={pendingBatches.length > 0 ? 'danger' : 'default'}
          hint="排不下时已恢复原排程，批次列为待处理"
        />
      </div>

      {pendingBatches.length > 0 ? (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 12 }}
          message={`${pendingBatches.length} 个批次排程待处理（原排程未改动）`}
          description={
            <Space wrap size={8}>
              {pendingBatches.map((batch) => (
                <Tag key={batch.id} color="red">
                  {labelOfBatch(batch.id)} · {batch.freshLeafKg} kg
                </Tag>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                鲜叶重量超过炉容量，请分批或调整批次鲜叶重量后重排。
              </Typography.Text>
            </Space>
          }
        />
      ) : null}

      {dirty && !scheduleDraft ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="焙火时长、鲜叶重量或复焙日期已变化，炉位与后续炉次尚未重算"
          description="点击「重排炉次」按最新参数重新装炉；已开焙（焙火中 / 已足火）道次保持原排程。"
          action={
            <Button size="small" type="primary" loading={saving} onClick={() => void handleSave()}>
              立即重排
            </Button>
          }
        />
      ) : null}

      {scheduleDraft ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="有未保存的排程预览（未写入，不会覆盖另一窗口的保存）"
          description={
            <div>
              {OVEN_ROOM.map((oven) => {
                const list = scheduleDraft.slots.filter((slot) => slot.ovenId === oven.id && !slot.locked);
                return (
                  <div key={oven.id} style={{ fontSize: 12 }}>
                    <strong>{oven.id}</strong>：
                    {list.length === 0
                      ? '无新炉次'
                      : list
                          .map(
                            (slot) =>
                              `${slot.slotDate} 第${slot.slotSeq}炉 ${localClockOf(slot.startMs)} 开 · ${slot.totalKg}/${slot.capacityKg}kg`,
                          )
                          .join('；')}
                  </div>
                );
              })}
              <Space size={8} style={{ marginTop: 8 }}>
                <Button size="small" type="primary" loading={saving} onClick={() => void handleRebase()}>
                  以最新数据重排并保存
                </Button>
                <Button size="small" onClick={discardScheduleDraft}>
                  放弃预览
                </Button>
              </Space>
            </div>
          }
        />
      ) : null}

      <Row gutter={[12, 12]}>
        {OVEN_ROOM.map((oven) => {
          const ovenSlots = slots.filter((slot) => slot.ovenId === oven.id);
          return (
            <Col key={oven.id} xs={24} md={12}>
              <div className="oven-lane">
                <Space size={8} style={{ marginBottom: 8 }} wrap>
                  <FireOutlined style={{ color: '#c9602c' }} />
                  <strong>{oven.id}</strong>
                  <Tag>{oven.capacityKg} kg / 炉</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ovenSlots.length > 0 ? `${ovenSlots.length} 个炉次` : '暂无炉次'}
                  </Typography.Text>
                </Space>
                {ovenSlots.map((slot) => (
                  <div
                    key={`${slot.slotDate}-${slot.slotSeq}`}
                    className={`oven-slot ${slot.overloaded ? 'is-overloaded' : ''}`}
                  >
                    <Space size={8} wrap>
                      <span className="mono">{slot.slotDate}</span>
                      <strong>第 {slot.slotSeq} 炉</strong>
                      <Tag color={slot.overloaded ? 'red' : 'blue'}>
                        {slot.totalKg} / {slot.capacityKg} kg
                      </Tag>
                      <span style={{ fontSize: 12 }}>最长 {slot.maxHours} h</span>
                      {slot.overloaded ? <Tag color="red">超容量，待重排</Tag> : null}
                    </Space>
                    {slot.roasts.map((roast) => (
                      <div key={roast.id} className="oven-slot-member">
                        <span>{labelOfBatch(roast.batchId)}</span>
                        <span>
                          第 {roast.passNo} 道 · {roast.hours} h
                        </span>
                        <span>{batchMap.get(roast.batchId)?.freshLeafKg ?? 0} kg</span>
                        <GradeTag kind="roastState" value={roast.state} />
                      </div>
                    ))}
                  </div>
                ))}
                {ovenSlots.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    尚无已排炉次，点击「重排炉次」自动装炉。
                  </Typography.Text>
                ) : null}
              </div>
            </Col>
          );
        })}
      </Row>

      {unscheduled.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            未排炉的待焙道次：
          </Typography.Text>
          <Space wrap size={8} style={{ marginTop: 6 }}>
            {unscheduled.map((roast) => (
              <Tag key={roast.id} color="gold">
                {labelOfBatch(roast.batchId)} · 第 {roast.passNo} 道
              </Tag>
            ))}
          </Space>
        </div>
      ) : null}

      <Modal
        open={scheduleConflicts.length > 0 && !conflictDismissed}
        title="排程保存冲突"
        okText="以最新数据重排"
        cancelText="保留预览，稍后处理"
        okButtonProps={{ loading: saving }}
        onOk={() => void handleRebase()}
        onCancel={() => setConflictDismissed(true)}
      >
        <Typography.Paragraph style={{ fontSize: 13 }}>
          另一窗口已保存了新的焙火数据。你的排程未写入、不会覆盖对方；冲突明细如下，可「以最新数据重排」后再保存。
        </Typography.Paragraph>
        <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
          {scheduleConflicts.map((conflict) => (
            <li key={`${conflict.kind}-${conflict.id}`} style={{ marginBottom: 6 }}>
              <strong>{conflict.label}</strong>
              <ul style={{ paddingLeft: 16 }}>
                {conflict.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Modal>
    </Card>
  );
}
