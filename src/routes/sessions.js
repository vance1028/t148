'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

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

/** POST /api/sessions/enter —— 车辆入场，开一条停车记录。 */
router.post('/enter', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { lotId, plateNo, spaceId } = req.body || {};
    if (lotId === undefined || !plateNo) return sendError(res, 400, '停车场和车牌号不能为空');
    if (!(await store.getLotById(Number(lotId)))) return sendError(res, 400, '停车场不存在');
    const enterTime = req.body.enterTime || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const s = await store.createSession({ lotId: Number(lotId), plateNo, spaceId: spaceId ?? null, enterTime });
    return sendData(res, 201, s);
  } catch (e) { return next(e); }
});

/** POST /api/sessions/:id/exit —— 车辆出场，登记出场时间与（基础）费用。 */
router.post('/:id/exit', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSessionById(id);
    if (!s) return sendError(res, 404, '停车记录不存在');
    if (s.status !== 'PARKED') return sendError(res, 409, '该记录已结束，不能重复出场');
    const exitTime = req.body.exitTime || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const feeCents = req.body.feeCents ?? 0;
    const updated = await store.updateSession(id, { exitTime, feeCents, status: 'FINISHED' });
    return sendData(res, 200, updated);
  } catch (e) { return next(e); }
});

module.exports = router;
