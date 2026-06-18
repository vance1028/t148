'use strict';

const express = require('express');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const debtStore = require('../data/debtStore');
const debtService = require('../services/debtService');

const router = express.Router();
router.use(authRequired);

/* ----------------------------- 欠费查询 ----------------------------- */

router.get('/', async (req, res, next) => {
  try {
    const { plateNo, lotId, status, minRemaining } = req.query;
    const filter = { plateNo, status };
    if (lotId !== undefined) filter.lotId = Number(lotId);
    if (minRemaining !== undefined) filter.minRemaining = Number(minRemaining);
    return sendData(res, 200, await debtStore.listDebts(filter));
  } catch (e) { return next(e); }
});

router.get('/summary/:plateNo', async (req, res, next) => {
  try {
    const { plateNo } = req.params;
    return sendData(res, 200, await debtService.getVehicleDebtOverview(plateNo));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const d = await debtStore.getDebtById(id);
    if (!d) return sendError(res, 404, '欠费记录不存在');
    return sendData(res, 200, d);
  } catch (e) { return next(e); }
});

/* ----------------------------- 补缴 ----------------------------- */

/** POST /api/debts/pay —— 按金额补缴，自动按核销规则分配到各欠费 */
router.post('/pay', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { plateNo, amountCents, method, transactionId, note, debtIds } = req.body || {};
    if (!plateNo || !amountCents) return sendError(res, 400, '车牌号和缴费金额必填');
    const result = await debtService.processPayment({
      plateNo,
      amountCents: Number(amountCents),
      method: method || 'WECHAT',
      transactionId: transactionId || '',
      operatorId: req.user?.id || null,
      note: note || '',
      debtIds: debtIds || null,
    });
    if (!result.success) return sendError(res, 400, result.message);
    return sendData(res, 200, result);
  } catch (e) {
    if (e.statusCode) return sendError(res, e.statusCode, e.message);
    return next(e);
  }
});

/** POST /api/debts/pay-all —— 一次性缴清所有欠费 */
router.post('/pay-all', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { plateNo, method, transactionId, note } = req.body || {};
    if (!plateNo) return sendError(res, 400, '车牌号必填');
    const result = await debtService.payAllDebts({
      plateNo,
      method: method || 'WECHAT',
      transactionId: transactionId || '',
      operatorId: req.user?.id || null,
      note: note || '',
    });
    if (!result.success) return sendError(res, 400, result.message);
    return sendData(res, 200, result);
  } catch (e) {
    if (e.statusCode) return sendError(res, e.statusCode, e.message);
    return next(e);
  }
});

/* ----------------------------- 缴费记录查询 ----------------------------- */

router.get('/payments/list', async (req, res, next) => {
  try {
    const { plateNo } = req.query;
    return sendData(res, 200, await debtStore.listPayments({ plateNo }));
  } catch (e) { return next(e); }
});

router.get('/payments/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const p = await debtStore.getPaymentWithWriteoffs(id);
    if (!p) return sendError(res, 404, '缴费记录不存在');
    return sendData(res, 200, p);
  } catch (e) { return next(e); }
});

/* ----------------------------- 核销配置 ----------------------------- */

router.get('/config/writeoff', requireRole('ADMIN'), async (req, res, next) => {
  try {
    return sendData(res, 200, await debtService.getWriteoffConfig());
  } catch (e) { return next(e); }
});

router.put('/config/writeoff', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { writeOffOrder, minWriteOffAmount } = req.body || {};
    const current = await debtService.getWriteoffConfig();
    const updated = {};
    if (writeOffOrder) updated.writeOffOrder = writeOffOrder;
    if (minWriteOffAmount !== undefined) updated.minWriteOffAmount = Number(minWriteOffAmount);
    const merged = { ...current, ...updated };
    await debtStore.setConfig('debt.writeoff', merged);
    return sendData(res, 200, merged);
  } catch (e) { return next(e); }
});

router.get('/config/risk', requireRole('ADMIN'), async (req, res, next) => {
  try {
    return sendData(res, 200, await debtService.getRiskConfig());
  } catch (e) { return next(e); }
});

router.put('/config/risk', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const current = await debtService.getRiskConfig();
    const keys = ['blockEntryThresholdCents', 'warnThresholdCents', 'blockUnpaidCount', 'warnUnpaidCount'];
    const updated = { ...current };
    for (const k of keys) {
      if (req.body?.[k] !== undefined) updated[k] = Number(req.body[k]);
    }
    await debtStore.setConfig('debt.risk', updated);
    return sendData(res, 200, updated);
  } catch (e) { return next(e); }
});

/* ----------------------------- 对账 ----------------------------- */

router.get('/verify/:plateNo', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    return sendData(res, 200, await debtService.verifyWriteoffConsistency(req.params.plateNo));
  } catch (e) { return next(e); }
});

module.exports = router;
