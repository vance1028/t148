'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

/** GET /api/vehicles —— 车辆列表（keyword 过滤）。 */
router.get('/', async (req, res, next) => {
  try {
    const { keyword } = req.query;
    return sendData(res, 200, await store.listVehicles({ keyword }));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const v = await store.getVehicleById(id);
    if (!v) return sendError(res, 404, '车辆不存在');
    return sendData(res, 200, v);
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { plateNo } = req.body || {};
    if (!plateNo) return sendError(res, 400, '车牌号不能为空');
    if (await store.getVehicleByPlate(plateNo)) return sendError(res, 409, '车牌号已存在');
    return sendData(res, 201, await store.createVehicle(req.body));
  } catch (e) { return next(e); }
});

router.put('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getVehicleById(id))) return sendError(res, 404, '车辆不存在');
    return sendData(res, 200, await store.updateVehicle(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getVehicleById(id))) return sendError(res, 404, '车辆不存在');
    await store.deleteVehicle(id);
    return sendData(res, 200, { id });
  } catch (e) { return next(e); }
});

module.exports = router;
