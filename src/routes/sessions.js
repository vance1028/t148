'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const debtService = require('../services/debtService');
const riskService = require('../services/riskService');
const creditService = require('../services/creditService');

const router = express.Router();
router.use(authRequired);

/** GET /api/sessions —— 停车记录列表（lotId / plateNo / status 过滤）。 */
router.get('/', async (req, res, next) => {
  try {
    const { lotId, plateNo, status } = req.query;
    const filter = { plateNo, status };
    if (lotId !== undefined) filter.lotId = Number(lotId);
    return sendData(res, 200, await store.listSessions(filter));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSessionById(id);
    if (!s) return sendError(res, 404, '停车记录不存在');
    return sendData(res, 200, s);
  } catch (e) { return next(e); }
});

/** POST /api/sessions/enter —— 车辆入场，先做风控检查，通过再开记录。 */
router.post('/enter', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { lotId, plateNo, spaceId } = req.body || {};
    if (lotId === undefined || !plateNo) return sendError(res, 400, '停车场和车牌号不能为空');
    if (!(await store.getLotById(Number(lotId)))) return sendError(res, 400, '停车场不存在');

    const risk = await riskService.evaluateEntryRules(plateNo);
    if (!risk.allowEntry) {
      return sendError(res, 403, `入场被拦截：${risk.message || '风控规则不允许'}`);
    }
    if (risk.requirePaymentFirst) {
      const debt = await debtService.getVehicleDebtOverview(plateNo);
      return sendData(res, 402, {
        blocked: true,
        reason: risk.message,
        riskContext: risk.context,
        matchedRules: risk.matchedRules,
        requiredPayment: debt.summary,
      });
    }

    const enterTime = req.body.enterTime || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const s = await store.createSession({ lotId: Number(lotId), plateNo, spaceId: spaceId ?? null, enterTime });
    return sendData(res, 201, { ...s, riskCheck: risk });
  } catch (e) { return next(e); }
});

/** POST /api/sessions/:id/exit —— 车辆出场：结算 + 欠费挂账 + 信用分触发。 */
router.post('/:id/exit', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSessionById(id);
    if (!s) return sendError(res, 404, '停车记录不存在');
    if (s.status !== 'PARKED') return sendError(res, 409, '该记录已结束，不能重复出场');

    const exitTime = req.body.exitTime || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const feeCents = Number(req.body.feeCents ?? 0);
    const paid = req.body.paid === true || req.body.paid === 1;
    const paymentMethod = req.body.paymentMethod || 'NONE';
    const reason = req.body.reason || (paid ? '' : 'PAYMENT_FAILED');

    const updated = await store.updateSession(id, { exitTime, feeCents, status: 'FINISHED', paid });

    let debtRecord = null;
    let creditResult = null;
    let riskResult = null;

    if (feeCents > 0) {
      if (!paid) {
        debtRecord = await debtService.registerDebtOnExit({
          sessionId: id, lotId: s.lotId, plateNo: s.plateNo,
          feeCents, paid: false, reason,
        });
        creditResult = await creditService.applyEvent(s.plateNo, creditService.EVENT_TYPES.DEBT_CREATED, {
          amount: feeCents, refId: `debt-${debtRecord?.id || id}`,
          reason: `停车${feeCents}分未缴`,
        });
        try {
          riskResult = await riskService.refreshBlacklistFromDebts(s.plateNo, req.user?.id || null);
        } catch (riskErr) {
          console.error('[exit] refreshBlacklistFromDebts error:', riskErr);
        }
      } else {
        creditResult = await creditService.applyEvent(s.plateNo, creditService.EVENT_TYPES.TIMELY_PAYMENT, {
          amount: feeCents, refId: `session-${id}`,
          reason: `出场按时缴费${feeCents}分，方式${paymentMethod}`,
        });
      }
    }

    return sendData(res, 200, {
      session: updated,
      debt: debtRecord,
      creditChange: creditResult,
      blacklist: riskResult,
    });
  } catch (e) {
    console.error('[sessions exit] ERROR:', e);
    return next(e);
  }
});

/** POST /api/sessions/:id/settle —— 出场后补缴（把这次 session 对应欠费结清）。 */
router.post('/:id/settle', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSessionById(id);
    if (!s) return sendError(res, 404, '停车记录不存在');
    if (s.status !== 'FINISHED') return sendError(res, 409, '该记录尚未出场，不能结算');

    const { method, transactionId, note } = req.body || {};
    const debtStore = require('../data/debtStore');
    const debt = await debtStore.getDebtBySessionId(id);
    if (!debt) return sendError(res, 404, '该记录没有欠费');
    const remaining = debt.totalCents - debt.paidCents;
    if (remaining <= 0) return sendData(res, 200, { alreadyPaid: true, debt });

    const result = await debtService.processPayment({
      plateNo: s.plateNo, amountCents: remaining,
      method: method || 'WECHAT',
      transactionId: transactionId || '',
      operatorId: req.user?.id || null,
      note: note || `结算停车记录#${id}`,
      debtIds: [debt.id],
    });

    if (!result.success) return sendError(res, 400, result.message);

    if ((await debtStore.getDebtSummary(s.plateNo)).totalRemainingCents === 0) {
      await creditService.applyEvent(s.plateNo, creditService.EVENT_TYPES.ALL_DEBTS_CLEARED, {
        refId: `all-cleared-${s.plateNo}`,
      });
    } else {
      await creditService.applyEvent(s.plateNo, creditService.EVENT_TYPES.DEBT_PAID, {
        amount: remaining, refId: `pay-${result.payment?.id}`,
        reason: `补缴停车费${remaining}分`,
      });
    }
    await riskService.refreshBlacklistFromDebts(s.plateNo, req.user?.id || null);

    return sendData(res, 200, { settleResult: result });
  } catch (e) { return next(e); }
});

module.exports = router;
