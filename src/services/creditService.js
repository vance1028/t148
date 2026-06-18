'use strict';

const { getPool } = require('../db');
const creditStore = require('../data/creditStore');

const EVENT_TYPES = {
  DEBT_CREATED: 'DEBT_CREATED',
  DEBT_PAID: 'DEBT_PAID',
  ALL_DEBTS_CLEARED: 'ALL_DEBTS_CLEARED',
  TIMELY_PAYMENT: 'TIMELY_PAYMENT',
  BLACKLISTED: 'BLACKLISTED',
  REMOVED_FROM_BLACKLIST: 'REMOVED_FROM_BLACKLIST',
  BOOKING_NOSHOW: 'BOOKING_NOSHOW',
  MANUAL_ADJUST: 'MANUAL_ADJUST',
  LONG_TERM_GOOD: 'LONG_TERM_GOOD',
};

async function ensureDefaultCreditRules() {
  const existing = await creditStore.listCreditRules({ enabledOnly: false });
  if (existing.length) return;

  const defaults = [
    {
      code: 'CR_DEBT_NEW',
      name: '新增欠费扣分',
      eventType: EVENT_TYPES.DEBT_CREATED,
      delta: -10,
      description: '产生新欠费记录，信用分-10',
    },
    {
      code: 'CR_DEBT_PAID',
      name: '补缴欠费回分',
      eventType: EVENT_TYPES.DEBT_PAID,
      delta: 3,
      description: '完成一笔欠费补缴，信用分+3',
    },
    {
      code: 'CR_ALL_CLEARED',
      name: '全部结清奖励',
      eventType: EVENT_TYPES.ALL_DEBTS_CLEARED,
      delta: 5,
      description: '所有欠费全部结清，额外+5',
    },
    {
      code: 'CR_TIMELY_PAY',
      name: '按时缴费加分',
      eventType: EVENT_TYPES.TIMELY_PAYMENT,
      delta: 2,
      description: '出场时按时完成缴费，+2',
    },
    {
      code: 'CR_BLACKLIST',
      name: '被列黑重扣',
      eventType: EVENT_TYPES.BLACKLISTED,
      delta: -30,
      description: '被加入黑名单，-30',
    },
    {
      code: 'CR_UNBLACKLIST',
      name: '移出黑名单回分',
      eventType: EVENT_TYPES.REMOVED_FROM_BLACKLIST,
      delta: 15,
      description: '从黑名单中移出，+15',
    },
    {
      code: 'CR_NOSHOW',
      name: '预约爽约扣分',
      eventType: EVENT_TYPES.BOOKING_NOSHOW,
      delta: -5,
      description: '预约停车位但未使用，-5',
    },
    {
      code: 'CR_LONG_GOOD',
      name: '长期良好奖励',
      eventType: EVENT_TYPES.LONG_TERM_GOOD,
      delta: 10,
      description: '连续30天无欠费且按时缴费，+10',
    },
  ];

  for (const d of defaults) {
    await creditStore.createCreditRule(d);
  }
}

function _evalRuleCondition(rule, eventCtx) {
  if (!rule.condition) return true;
  const c = rule.condition;
  if (c.minAmount !== undefined && (eventCtx.amount || 0) < Number(c.minAmount)) return false;
  if (c.maxAmount !== undefined && (eventCtx.amount || 0) > Number(c.maxAmount)) return false;
  if (c.minDebtCount !== undefined && (eventCtx.debtCount || 0) < Number(c.minDebtCount)) return false;
  return true;
}

async function applyEvent(plateNo, eventType, { amount = 0, debtCount = 0, reason = '', refId = '', operatorId = null, forceDelta = null, forceReason = '' } = {}) {
  await ensureDefaultCreditRules();
  const allRules = await creditStore.listCreditRules({ eventType });
  const applicableRules = allRules.filter((r) => _evalRuleCondition(r, { amount, debtCount }));

  if (!applicableRules.length && forceDelta === null) {
    return { applied: false, plateNo, reason: '无匹配规则' };
  }

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const current = await creditStore.getOrCreateCreditScore(plateNo, conn);
    let beforeScore = current.score;
    let runningScore = beforeScore;
    const appliedLogs = [];

    for (const rule of applicableRules) {
      const delta = rule.delta;
      if (delta === 0) continue;
      const afterScore = Math.max(0, Math.min(200, runningScore + delta));
      const d = afterScore - runningScore;

      const log = await creditStore.createCreditLog(
        {
          plateNo, ruleCode: rule.code, ruleName: rule.name,
          delta: d, beforeScore: runningScore, afterScore,
          reason: rule.description + (reason ? `（${reason}）` : ''),
          refId: String(refId || rule.code),
        },
        conn,
      );
      runningScore = afterScore;
      appliedLogs.push({
        ruleCode: rule.code, ruleName: rule.name, delta: d, logId: log.id,
      });
    }

    if (forceDelta !== null) {
      const afterScore = Math.max(0, Math.min(200, runningScore + forceDelta));
      const d = afterScore - runningScore;
      if (d !== 0) {
        const log = await creditStore.createCreditLog(
          {
            plateNo, ruleCode: 'MANUAL', ruleName: '手动调整',
            delta: d, beforeScore: runningScore, afterScore,
            reason: forceReason || reason || '管理员手动调整',
            refId: String(refId || 'manual'),
          },
          conn,
        );
        runningScore = afterScore;
        appliedLogs.push({
          ruleCode: 'MANUAL', ruleName: '手动调整', delta: d, logId: log.id,
        });
      }
    }

    if (runningScore !== beforeScore) {
      await creditStore.updateCreditScoreDirect(plateNo, runningScore, conn);
    }

    await conn.commit();

    const newScore = await creditStore.getCreditScore(plateNo);
    return {
      applied: true,
      plateNo,
      beforeScore,
      afterScore: runningScore,
      totalDelta: runningScore - beforeScore,
      newLevel: newScore?.level,
      appliedLogs,
    };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

function _getActionsByLevel(level) {
  const actions = [];
  switch (level) {
    case 'S':
      actions.push({ type: 'PRIORITY_SERVICE', desc: '优享服务' });
      actions.push({ type: 'REDUCE_DEPOSIT', desc: '押金减免50%' });
      break;
    case 'A':
      actions.push({ type: 'SENSELESS_PAY_ALLOW', desc: '无感支付正常' });
      break;
    case 'B':
      actions.push({ type: 'SENSELESS_PAY_ALLOW', desc: '无感支付正常' });
      break;
    case 'C':
      actions.push({ type: 'INCREASE_DEPOSIT', desc: '押金提高50%' });
      actions.push({ type: 'WARN', desc: '信用分偏低' });
      break;
    case 'D':
      actions.push({ type: 'DISABLE_SENSELESS', desc: '禁用无感支付' });
      actions.push({ type: 'RESTRICT_BOOKING', desc: '限制预约' });
      actions.push({ type: 'INCREASE_DEPOSIT', desc: '押金翻倍' });
      break;
    case 'E':
      actions.push({ type: 'BLOCK_ENTRY', desc: '拒绝入场' });
      actions.push({ type: 'DISABLE_SENSELESS', desc: '禁用无感支付' });
      actions.push({ type: 'RESTRICT_BOOKING', desc: '禁止预约' });
      break;
    default:
      break;
  }
  return actions;
}

async function getCreditProfile(plateNo) {
  await ensureDefaultCreditRules();
  const score = await creditStore.getCreditScore(plateNo)
    || { plateNo, score: 100, level: 'A', updatedAt: null };
  const logs = await creditStore.listCreditLogs({ plateNo, limit: 50 });
  const actions = _getActionsByLevel(score.level);
  return {
    plateNo,
    score: score.score,
    level: score.level,
    updatedAt: score.updatedAt,
    recommendedActions: actions,
    recentLogs: logs,
  };
}

async function manualAdjust(plateNo, delta, reason, operatorId = null) {
  return applyEvent(plateNo, EVENT_TYPES.MANUAL_ADJUST, {
    forceDelta: delta, forceReason: reason, operatorId, refId: `adj-${Date.now()}`,
  });
}

module.exports = {
  EVENT_TYPES,
  ensureDefaultCreditRules,
  applyEvent,
  getCreditProfile,
  manualAdjust,
};
