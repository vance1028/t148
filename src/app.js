'use strict';

const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const lotsRouter = require('./routes/lots');
const spacesRouter = require('./routes/spaces');
const vehiclesRouter = require('./routes/vehicles');
const sessionsRouter = require('./routes/sessions');
const { sendError } = require('./utils/http');

/** 创建 Express 应用。数据库连接与种子由调用方准备。 */
function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: '城市智慧停车运营管理平台', time: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/lots', lotsRouter);
  app.use('/api/spaces', spacesRouter);
  app.use('/api/vehicles', vehiclesRouter);
  app.use('/api/sessions', sessionsRouter);

  app.use((req, res) => sendError(res, 404, '接口不存在'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return sendError(res, 400, '请求体不是合法的 JSON');
    }
    if (err && err.statusCode) {
      return sendError(res, err.statusCode, err.message);
    }
    // eslint-disable-next-line no-console
    console.error(err);
    return sendError(res, 500, '服务器内部错误');
  });

  return app;
}

module.exports = { createApp };
