'use strict';

const express = require('express');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const creditStore = require('../data/creditStore');
const creditService = require('../services/creditService');

const router = express.Router();
router.use(authRequired);

/* ----------------------------- 信用分查询 ----------------------------- */

router.get('/profile/:plateNo', async (req, res, next) => {
  try {
    return sendData(res, 200, await creditService.getCreditProfile(req.params.plateNo));
  } catch (e) { return next(e); }
});

router.get('/scores', async (req, res, next) => {
  try {
    const { minScore, maxScore, level } = req.query;
    const filter = {};
    if (minScore !== undefined) filter.minScore = Number(minScore);
    if (maxScore !== undefined) filter.maxScore = Number(maxScore);
    if (level) filter.level = level;
    return sendData(res, 200, await creditStore.listCreditScores(filter));
  } catch (e) { return next(e); }
});

router.get('/scores/:plateNo', async (req, res, next) => {
  try {
    const s = await creditStore.getCreditScore(req.params.plateNo);
    if (!s) return sendData(res, 200, { plateNo: req.params.plateNo, score: 100, level: 'A', initialized: false });
    return sendData(res, 200, { ...s, initialized: true });
  } catch (e) { return next(e); }
});

/** POST /api/credit/adjust —— 手动调整信用分 */
router.post('/adjust', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { plateNo, delta, reason } = req.body || {};
    if (!plateNo || delta === undefined) return sendError(res, 400, '车牌号和调整分值必填');
    const d = Number(delta);
    if (!Number.isInteger(d)) return sendError(res, 400, '分值必须为整数');
    const result = await creditService.manualAdjust(plateNo, d, reason || '', req.user?.id || null);
    return sendData(res, 200, result);
  } catch (e) { return next(e); }
});

/* ----------------------------- 信用分流水 ----------------------------- */

router.get('/logs', async (req, res, next) => {
  try {
    const { plateNo, ruleCode, limit } = req.query;
    return sendData(res, 200, await creditStore.listCreditLogs({
      plateNo, ruleCode, limit: limit ? Number(limit) : 100,
    }));
  } catch (e) { return next(e); }
});

router.get('/logs/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const log = await creditStore.getCreditLogById(id);
    if (!log) return sendError(res, 404, '信用分流水不存在');
    return sendData(res, 200, log);
  } catch (e) { return next(e); }
});

/* ----------------------------- 信用分规则 ----------------------------- */

router.get('/rules', async (req, res, next) => {
  try {
    const { eventType, all } = req.query;
    return sendData(res, 200, await creditStore.listCreditRules({
      eventType, enabledOnly: all !== '1',
    }));
  } catch (e) { return next(e); }
});

router.post('/rules', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { code, name, eventType, delta, enabled, condition, description } = req.body || {};
    if (!code || !name || !eventType) return sendError(res, 400, '编码、名称和事件类型必填');
    try {
      const rule = await creditStore.createCreditRule({
        code, name, eventType,
        delta: Number(delta) || 0,
        enabled: enabled !== false,
        condition,
        description: description || '',
      });
      return sendData(res, 201, rule);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return sendError(res, 409, '规则编码已存在');
      throw e;
    }
  } catch (e) { return next(e); }
});

router.get('/rules/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const r = await creditStore.getCreditRuleById(id);
    if (!r) return sendError(res, 404, '信用分规则不存在');
    return sendData(res, 200, r);
  } catch (e) { return next(e); }
});

router.put('/rules/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { code, name, eventType, delta, enabled, condition, description } = req.body || {};
    return sendData(res, 200, await creditStore.updateCreditRule(id, {
      code, name, eventType,
      delta: delta === undefined ? undefined : Number(delta),
      enabled, condition, description,
    }));
  } catch (e) { return next(e); }
});

router.delete('/rules/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const ok = await creditStore.deleteCreditRule(id);
    if (!ok) return sendError(res, 404, '信用分规则不存在');
    return sendData(res, 200, { deleted: true });
  } catch (e) { return next(e); }
});

/** POST /api/credit/trigger —— 手动触发某个信用事件（用于测试/补偿） */
router.post('/trigger', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { plateNo, eventType, amount, debtCount, reason, refId } = req.body || {};
    if (!plateNo || !eventType) return sendError(res, 400, '车牌号和事件类型必填');
    const result = await creditService.applyEvent(plateNo, eventType, {
      amount: Number(amount) || 0,
      debtCount: Number(debtCount) || 0,
      reason: reason || '',
      refId: refId || '',
      operatorId: req.user?.id || null,
    });
    return sendData(res, 200, result);
  } catch (e) { return next(e); }
});

module.exports = router;
