'use strict';

const express = require('express');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const riskStore = require('../data/riskStore');
const riskService = require('../services/riskService');

const router = express.Router();
router.use(authRequired);

/* ----------------------------- 入场风控检查 ----------------------------- */

/** GET /api/risk/check-entry?plateNo=xxx —— 车辆入场风控检查 */
router.get('/check-entry', async (req, res, next) => {
  try {
    const { plateNo } = req.query;
    if (!plateNo) return sendError(res, 400, '车牌号必填');
    return sendData(res, 200, await riskService.evaluateEntryRules(plateNo));
  } catch (e) { return next(e); }
});

/* ----------------------------- 黑名单 ----------------------------- */

router.get('/blacklist', async (req, res, next) => {
  try {
    const { level, status } = req.query;
    return sendData(res, 200, await riskStore.listBlacklists({ level, status }));
  } catch (e) { return next(e); }
});

router.get('/blacklist/plate/:plateNo', async (req, res, next) => {
  try {
    const bl = await riskStore.getBlacklistByPlate(req.params.plateNo);
    return sendData(res, 200, bl || { inBlacklist: false });
  } catch (e) { return next(e); }
});

/** POST /api/risk/blacklist —— 手动加入黑名单 */
router.post('/blacklist', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { plateNo, level, reason, action, expiresAt } = req.body || {};
    if (!plateNo) return sendError(res, 400, '车牌号必填');
    const bl = await riskService.manualAddBlacklist({
      plateNo,
      level: level || 'WARN',
      reason: reason || '',
      action: action || 'BLOCK_ENTRY',
      expiresAt: expiresAt || null,
      operatorId: req.user?.id || null,
    });
    return sendData(res, 201, bl);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return sendError(res, 409, '该车辆已在黑名单中');
    return next(e);
  }
});

/** DELETE /api/risk/blacklist/plate/:plateNo —— 手动移出黑名单 */
router.delete('/blacklist/plate/:plateNo', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const ok = await riskService.manualRemoveBlacklist(req.params.plateNo, req.user?.id || null);
    return sendData(res, 200, { removed: ok });
  } catch (e) { return next(e); }
});

router.get('/blacklist/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const bl = await riskStore.getBlacklistById(id);
    if (!bl) return sendError(res, 404, '黑名单记录不存在');
    return sendData(res, 200, bl);
  } catch (e) { return next(e); }
});

router.put('/blacklist/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { level, reason, status, action, expiresAt } = req.body || {};
    return sendData(res, 200, await riskStore.updateBlacklist(id, {
      level, reason, status, action, expiresAt,
    }));
  } catch (e) { return next(e); }
});

/** POST /api/risk/refresh/:plateNo —— 根据欠费情况自动刷新黑名单状态 */
router.post('/refresh/:plateNo', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const bl = await riskService.refreshBlacklistFromDebts(req.params.plateNo, req.user?.id || null);
    return sendData(res, 200, { updated: true, blacklist: bl });
  } catch (e) { return next(e); }
});

/* ----------------------------- 风控规则 ----------------------------- */

router.get('/rules', async (req, res, next) => {
  try {
    const { type, all } = req.query;
    return sendData(res, 200, await riskStore.listRiskRules({ type, enabledOnly: all !== '1' }));
  } catch (e) { return next(e); }
});

router.post('/rules', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { code, name, type, enabled, priority, condition, action } = req.body || {};
    if (!code || !name) return sendError(res, 400, '规则编码和名称必填');
    try {
      const rule = await riskStore.createRiskRule({
        code, name, type: type || 'ENTRY_BLOCK',
        enabled: enabled !== false,
        priority: Number(priority) || 0,
        condition, action,
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
    const r = await riskStore.getRiskRuleById(id);
    if (!r) return sendError(res, 404, '风控规则不存在');
    return sendData(res, 200, r);
  } catch (e) { return next(e); }
});

router.put('/rules/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { code, name, type, enabled, priority, condition, action } = req.body || {};
    return sendData(res, 200, await riskStore.updateRiskRule(id, {
      code, name, type, enabled, priority: priority === undefined ? undefined : Number(priority),
      condition, action,
    }));
  } catch (e) { return next(e); }
});

router.delete('/rules/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const ok = await riskStore.deleteRiskRule(id);
    if (!ok) return sendError(res, 404, '风控规则不存在');
    return sendData(res, 200, { deleted: true });
  } catch (e) { return next(e); }
});

module.exports = router;
