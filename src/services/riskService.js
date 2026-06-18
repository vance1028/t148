'use strict';

const riskStore = require('../data/riskStore');
const debtStore = require('../data/debtStore');
const creditStore = require('../data/creditStore');
const debtService = require('./debtService');

const ENTRY_ACTION = {
  ALLOW: 'ALLOW',
  WARN: 'WARN',
  REQUIRE_PAYMENT: 'REQUIRE_PAYMENT',
  DISABLE_SENSELESS: 'DISABLE_SENSELESS',
  BLOCK_ENTRY: 'BLOCK_ENTRY',
};

const ACTION_PRIORITY = {
  ALLOW: 0,
  WARN: 1,
  DISABLE_SENSELESS: 2,
  REQUIRE_PAYMENT: 3,
  BLOCK_ENTRY: 4,
};

async function ensureDefaultRiskRules() {
  const existing = await riskStore.listRiskRules({ enabledOnly: false });
  if (existing.length) return;

  const defaults = [
    {
      code: 'BLACKLIST_BLOCK',
      name: '黑名单直接拦截',
      type: 'ENTRY_BLOCK',
      enabled: true,
      priority: 100,
      condition: { type: 'IN_BLACKLIST', level: ['DANGER', 'SEVERE'] },
      action: { type: 'BLOCK_ENTRY', message: '车辆在黑名单中，禁止入场' },
    },
    {
      code: 'BLACKLIST_REQUIRE_PAY',
      name: '黑名单限制补缴',
      type: 'ENTRY_BLOCK',
      enabled: true,
      priority: 80,
      condition: { type: 'IN_BLACKLIST', level: ['WARN'] },
      action: { type: 'REQUIRE_PAYMENT', message: '车辆在限制名单中，请先补缴' },
    },
    {
      code: 'CREDIT_LOW',
      name: '信用分过低限制',
      type: 'ENTRY_BLOCK',
      enabled: true,
      priority: 60,
      condition: { type: 'CREDIT_LEVEL', levels: ['D', 'E'] },
      action: { type: 'DISABLE_SENSELESS', message: '信用分较低，已禁用无感支付' },
    },
    {
      code: 'DEBT_WARN',
      name: '欠费预警',
      type: 'ENTRY_BLOCK',
      enabled: true,
      priority: 10,
      condition: { type: 'AND', conditions: [
        { type: 'DEBT_AMOUNT', operator: 'GT', value: 0 },
        { type: 'NOT_IN_BLACKLIST' },
      ] },
      action: { type: 'WARN', message: '有欠费记录，请及时补缴' },
    },
  ];

  for (const d of defaults) {
    await riskStore.createRiskRule(d);
  }
}

function _evalCondition(cond, ctx) {
  if (!cond || !cond.type) return true;

  switch (cond.type) {
    case 'IN_BLACKLIST': {
      if (!ctx.blacklist) return false;
      if (!cond.level || !cond.level.length) return true;
      return cond.level.includes(ctx.blacklist.level);
    }
    case 'NOT_IN_BLACKLIST': {
      return !ctx.blacklist;
    }
    case 'DEBT_AMOUNT': {
      const v = Number(ctx.debtSummary?.totalRemainingCents || 0);
      return _cmp(v, cond.operator, Number(cond.value));
    }
    case 'DEBT_COUNT': {
      const v = Number(ctx.debtSummary?.unpaidCount || 0);
      return _cmp(v, cond.operator, Number(cond.value));
    }
    case 'CREDIT_LEVEL': {
      if (!ctx.creditScore) return false;
      return (cond.levels || []).includes(ctx.creditScore.level);
    }
    case 'CREDIT_SCORE': {
      const v = Number(ctx.creditScore?.score ?? 100);
      return _cmp(v, cond.operator, Number(cond.value));
    }
    case 'AND': {
      return (cond.conditions || []).every((c) => _evalCondition(c, ctx));
    }
    case 'OR': {
      return (cond.conditions || []).some((c) => _evalCondition(c, ctx));
    }
    default:
      return true;
  }
}

function _cmp(a, op, b) {
  switch (op) {
    case 'GT': return a > b;
    case 'GTE': return a >= b;
    case 'LT': return a < b;
    case 'LTE': return a <= b;
    case 'EQ': return a === b;
    case 'NEQ': return a !== b;
    default: return false;
  }
}

async function buildRiskContext(plateNo) {
  const [debtSummary, blacklist, creditScore] = await Promise.all([
    debtStore.getDebtSummary(plateNo),
    riskStore.getBlacklistByPlate(plateNo),
    creditStore.getCreditScore(plateNo),
  ]);
  return { plateNo, debtSummary, blacklist, creditScore };
}

async function evaluateEntryRules(plateNo) {
  await ensureDefaultRiskRules();
  const ctx = await buildRiskContext(plateNo);
  const rules = await riskStore.listRiskRules({ type: 'ENTRY_BLOCK' });

  let finalAction = ENTRY_ACTION.ALLOW;
  let finalMessage = '';
  const matched = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    try {
      const cond = rule.condition && typeof rule.condition === 'string'
        ? JSON.parse(rule.condition)
        : rule.condition;
      if (_evalCondition(cond || {}, ctx)) {
        const act = rule.action && typeof rule.action === 'string'
          ? JSON.parse(rule.action)
          : rule.action;
        const actionType = act?.type || ENTRY_ACTION.ALLOW;
        matched.push({
          ruleCode: rule.code, ruleName: rule.name,
          action: actionType, message: act?.message || '',
        });
        if ((ACTION_PRIORITY[actionType] || 0) > (ACTION_PRIORITY[finalAction] || 0)) {
          finalAction = actionType;
          finalMessage = act?.message || '';
        }
      }
    } catch (_) {}
  }

  if (ctx.blacklist && ctx.blacklist.action) {
    const blAction = ctx.blacklist.action;
    if ((ACTION_PRIORITY[blAction] || 0) > (ACTION_PRIORITY[finalAction] || 0)) {
      finalAction = blAction;
      finalMessage = ctx.blacklist.reason || `黑名单(${ctx.blacklist.level})：${finalMessage}`;
      matched.unshift({
        ruleCode: 'BLACKLIST_DIRECT', ruleName: '黑名单直接处置',
        action: blAction, message: ctx.blacklist.reason || '',
      });
    }
  }

  return {
    plateNo,
    action: finalAction,
    message: finalMessage,
    matchedRules: matched,
    context: {
      totalOwed: Number(ctx.debtSummary?.totalRemainingCents || 0),
      unpaidCount: Number(ctx.debtSummary?.unpaidCount || 0),
      creditLevel: ctx.creditScore?.level || 'A',
      creditScore: Number(ctx.creditScore?.score ?? 100),
      inBlacklist: !!ctx.blacklist,
      blacklistLevel: ctx.blacklist?.level || null,
    },
    allowEntry: finalAction !== ENTRY_ACTION.BLOCK_ENTRY,
    requirePaymentFirst: finalAction === ENTRY_ACTION.REQUIRE_PAYMENT || finalAction === ENTRY_ACTION.BLOCK_ENTRY,
    disableSenseless: finalAction === ENTRY_ACTION.DISABLE_SENSELESS || finalAction === ENTRY_ACTION.REQUIRE_PAYMENT || finalAction === ENTRY_ACTION.BLOCK_ENTRY,
  };
}

async function refreshBlacklistFromDebts(plateNo, operatorId = null) {
  const summary = await debtStore.getDebtSummary(plateNo);
  const riskCfg = await debtService.getRiskConfig();

  let level = null;
  let action = 'ALLOW';
  let reason = '';

  if (summary.totalRemainingCents >= Number(riskCfg.blockEntryThresholdCents || 5000)
      || summary.unpaidCount >= Number(riskCfg.blockUnpaidCount || 3)) {
    level = 'DANGER';
    action = 'BLOCK_ENTRY';
    reason = `欠费总额 ${summary.totalRemainingCents} 分或 ${summary.unpaidCount} 次，触发拦截`;
  } else if (summary.totalRemainingCents >= Number(riskCfg.warnThresholdCents || 2000)
             || summary.unpaidCount >= Number(riskCfg.warnUnpaidCount || 2)) {
    level = 'WARN';
    action = 'REQUIRE_PAYMENT';
    reason = `欠费总额 ${summary.totalRemainingCents} 分或 ${summary.unpaidCount} 次，触发警告`;
  }

  if (level) {
    return await riskStore.upsertBlacklist({
      plateNo, level, reason, action,
      totalOwedCents: summary.totalRemainingCents,
      unpaidCount: summary.unpaidCount,
      operatorId,
    });
  }

  await riskStore.removeBlacklistByPlate(plateNo);
  return null;
}

async function manualAddBlacklist({ plateNo, level = 'WARN', reason = '', action = 'BLOCK_ENTRY', expiresAt = null, operatorId = null }) {
  const summary = await debtStore.getDebtSummary(plateNo);
  return await riskStore.upsertBlacklist({
    plateNo, level, reason, action, expiresAt, operatorId,
    totalOwedCents: summary.totalRemainingCents,
    unpaidCount: summary.unpaidCount,
  });
}

async function manualRemoveBlacklist(plateNo, operatorId = null) {
  return await riskStore.removeBlacklistByPlate(plateNo);
}

module.exports = {
  ENTRY_ACTION,
  ensureDefaultRiskRules,
  buildRiskContext,
  evaluateEntryRules,
  refreshBlacklistFromDebts,
  manualAddBlacklist,
  manualRemoveBlacklist,
};
