'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

/** GET /api/spaces —— 车位列表（lotId / status / type 过滤）。 */
router.get('/', async (req, res, next) => {
  try {
    const { lotId, status, type } = req.query;
    const filter = { status, type };
    if (lotId !== undefined) filter.lotId = Number(lotId);
    return sendData(res, 200, await store.listSpaces(filter));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const space = await store.getSpaceById(id);
    if (!space) return sendError(res, 404, '车位不存在');
    return sendData(res, 200, space);
  } catch (e) { return next(e); }
});

router.put('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getSpaceById(id))) return sendError(res, 404, '车位不存在');
    return sendData(res, 200, await store.updateSpace(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getSpaceById(id))) return sendError(res, 404, '车位不存在');
    await store.deleteSpace(id);
    return sendData(res, 200, { id });
  } catch (e) { return next(e); }
});

module.exports = router;
