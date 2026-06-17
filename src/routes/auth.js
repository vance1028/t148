'use strict';

const express = require('express');
const { login, authRequired } = require('../auth');
const { sendData, sendError } = require('../utils/http');

const router = express.Router();

/** POST /api/auth/login —— 登录，返回 JWT 与用户信息。 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return sendError(res, 400, '用户名和密码不能为空');
    const result = await login(String(username), String(password));
    if (!result) return sendError(res, 401, '用户名或密码错误');
    return sendData(res, 200, result);
  } catch (e) { return next(e); }
});

/** GET /api/auth/me —— 当前登录用户。 */
router.get('/me', authRequired, (req, res) => sendData(res, 200, req.user));

module.exports = router;
