'use strict';

// 测试连接 MySQL（默认 127.0.0.1:13366，由 docker compose 起的 db 服务）。
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp, ensureRuntimeInit } = require('../src/app');

const app = createApp();

test.before(async () => {
  await waitForDb();
  await ensureSchema();
  getPool();
});

test.beforeEach(async () => {
  await resetAll();
  await seed();
  await ensureRuntimeInit();
});

test.after(async () => {
  await close();
});

async function loginAs(username, password) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  assert.strictEqual(res.status, 200, `登录失败: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

test('健康检查无需鉴权', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});

test('登录：正确账号密码返回 token，中文姓名不乱码', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.token);
  assert.strictEqual(res.body.data.user.role, 'ADMIN');
  assert.strictEqual(res.body.data.user.name, '系统管理员');
});

test('登录：错误密码 401', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'bad' });
  assert.strictEqual(res.status, 401);
});

test('未带令牌访问受保护接口 401', async () => {
  const res = await request(app).get('/api/lots');
  assert.strictEqual(res.status, 401);
});

test('停车场列表读到种子数据，中文字段正确', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.length, 3);
  const names = res.body.data.map((l) => l.name);
  assert.ok(names.includes('市民中心地下停车场'), '中文停车场名应正确返回');
});

test('operator 新建停车场并能再查到（含中文与区域）', async () => {
  const token = await loginAs('operator', 'operator123');
  const create = await request(app).post('/api/lots').set('Authorization', `Bearer ${token}`)
    .send({ code: 'PL-XH-009', name: '西湖文化广场停车场', district: '西湖区', address: '环湖北路66号', totalSpaces: 10 });
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const id = create.body.data.id;
  const get = await request(app).get(`/api/lots/${id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.body.data.name, '西湖文化广场停车场');
  assert.strictEqual(get.body.data.district, '西湖区');
});

test('viewer 无权新建停车场（403）', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).post('/api/lots').set('Authorization', `Bearer ${token}`)
    .send({ code: 'PL-X-001', name: '测试', district: '某区' });
  assert.strictEqual(res.status, 403);
});

test('停车场编号重复 409', async () => {
  const token = await loginAs('admin', 'admin123');
  const res = await request(app).post('/api/lots').set('Authorization', `Bearer ${token}`)
    .send({ code: 'PL-CG-001', name: '重复', district: '某区' });
  assert.strictEqual(res.status, 409);
});

test('车位：列出某停车场车位、在其下新建车位', async () => {
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const list = await request(app).get(`/api/lots/${lot1.id}/spaces`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.data.length, 4);

  const create = await request(app).post(`/api/lots/${lot1.id}/spaces`).set('Authorization', `Bearer ${token}`)
    .send({ code: 'A-09', type: 'STANDARD' });
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  assert.strictEqual(create.body.data.lotId, lot1.id);
});

test('车辆：新建含中文车主并查询，中文不乱码', async () => {
  const token = await loginAs('operator', 'operator123');
  const create = await request(app).post('/api/vehicles').set('Authorization', `Bearer ${token}`)
    .send({ plateNo: '川A99999', ownerName: '陈大文', phone: '13900000000', vehicleType: 'SMALL' });
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  assert.strictEqual(create.body.data.ownerName, '陈大文');
});

test('停车记录：入场后再出场，状态流转与重复出场拦截', async () => {
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const enter = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: '川A12345', enterTime: '2026-06-16 10:00:00' });
  assert.strictEqual(enter.status, 201, JSON.stringify(enter.body));
  const sid = enter.body.data.id;

  const exit1 = await request(app).post(`/api/sessions/${sid}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-16 11:00:00', feeCents: 800 });
  assert.strictEqual(exit1.status, 200);
  assert.strictEqual(exit1.body.data.session.status, 'FINISHED');
  assert.strictEqual(exit1.body.data.session.feeCents, 800);

  const exit2 = await request(app).post(`/api/sessions/${sid}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-16 12:00:00' });
  assert.strictEqual(exit2.status, 409, '已结束的记录不能重复出场');
});

test('删除停车场需要 admin，operator 被拒 403', async () => {
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const res = await request(app).delete(`/api/lots/${lots[0].id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 403);
});

test('不存在的接口 404', async () => {
  const res = await request(app).get('/api/not-exist');
  assert.strictEqual(res.status, 404);
});

/* ==================== 欠费追缴核心链路 ==================== */

test('出场未缴费自动挂欠费 + 信用分扣分', async () => {
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');

  const enter = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: '川B-欠费车', enterTime: '2026-06-16 10:00:00' });
  assert.strictEqual(enter.status, 201);
  const sid = enter.body.data.id;

  const exit = await request(app).post(`/api/sessions/${sid}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-16 11:00:00', feeCents: 1500, paid: false, reason: 'PAYMENT_FAILED' });
  assert.strictEqual(exit.status, 200);
  assert.ok(exit.body.data.debt, '应自动挂欠费');
  assert.strictEqual(exit.body.data.debt.totalCents, 1500);
  assert.strictEqual(exit.body.data.debt.status, 'UNPAID');

  assert.ok(exit.body.data.creditChange, '应有信用分变更');
  assert.strictEqual(exit.body.data.creditChange.applied, true);
  assert.strictEqual(exit.body.data.creditChange.totalDelta, -10, '新增欠费扣10分');

  const summary = await request(app).get(`/api/debts/summary/川B-欠费车`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(summary.status, 200);
  assert.strictEqual(summary.body.data.summary.unpaidCount, 1);
  assert.strictEqual(summary.body.data.summary.totalRemainingCents, 1500);
});

test('出场按时缴费不挂欠费 + 信用分加分', async () => {
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');

  const enter = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: '川B-好车主', enterTime: '2026-06-16 09:00:00' });
  const sid = enter.body.data.id;

  const exit = await request(app).post(`/api/sessions/${sid}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-16 10:00:00', feeCents: 800, paid: true, paymentMethod: 'ALIPAY' });
  assert.strictEqual(exit.status, 200);
  assert.strictEqual(exit.body.data.debt, null, '按时缴费不挂欠费');
  assert.strictEqual(exit.body.data.creditChange.totalDelta, 2, '按时缴费+2分');
});

test('分笔补缴 + 核销精确对得上（FIFO）', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const token = await loginAs('operator', 'operator123');
  await request(app).put('/api/debts/config/risk').set('Authorization', `Bearer ${adminToken}`)
    .send({ warnThresholdCents: 99999, warnUnpaidCount: 99, blockEntryThresholdCents: 99999, blockUnpaidCount: 99 });

  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-分笔缴';

  const debts = [];
  const amounts = [1000, 2000, 3000];
  for (let i = 0; i < 3; i++) {
    const e = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
      .send({ lotId: lot1.id, plateNo: plate, enterTime: `2026-06-1${i} 10:00:00` });
    assert.strictEqual(e.status, 201, `enter#${i} 应创建: ${JSON.stringify(e.body)}`);
    const x = await request(app).post(`/api/sessions/${e.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
      .send({ exitTime: `2026-06-1${i} 11:00:00`, feeCents: amounts[i], paid: false });
    assert.strictEqual(x.status, 200, `exit#${i} 应成功: ${JSON.stringify(x.body)}`);
    debts.push(x.body.data.debt);
  }
  assert.strictEqual(debts.length, 3);
  assert.ok(debts.every((d) => d && d.id), '每笔欠费应有 id');

  const summary1 = (await request(app).get(`/api/debts/summary/${plate}`).set('Authorization', `Bearer ${token}`)).body.data.summary;
  assert.strictEqual(summary1.totalRemainingCents, 6000);

  const pay1 = await request(app).post('/api/debts/pay').set('Authorization', `Bearer ${token}`)
    .send({ plateNo: plate, amountCents: 1500, method: 'WECHAT' });
  assert.strictEqual(pay1.status, 200, JSON.stringify(pay1.body));
  assert.strictEqual(pay1.body.data.writeoffs.length, 2, 'FIFO 应先核销第1笔1000，再核销第2笔部分500');
  assert.strictEqual(pay1.body.data.writeoffs[0].debtId, debts[0].id, '先欠先缴第1笔');
  assert.strictEqual(pay1.body.data.writeoffs[0].amountCents, 1000);
  assert.strictEqual(pay1.body.data.writeoffs[1].debtId, debts[1].id);
  assert.strictEqual(pay1.body.data.writeoffs[1].amountCents, 500);

  const summary2 = (await request(app).get(`/api/debts/summary/${plate}`).set('Authorization', `Bearer ${token}`)).body.data.summary;
  assert.strictEqual(summary2.totalRemainingCents, 4500, `实际:${summary2.totalRemainingCents}`);

  const verify = await request(app).get(`/api/debts/verify/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(verify.body.data.consistent, true, '对账应一致');
});

test('一次性缴清所有欠费 + 信用分 + 黑名单解除', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const token = await loginAs('operator', 'operator123');
  await request(app).put('/api/debts/config/risk').set('Authorization', `Bearer ${adminToken}`)
    .send({ warnThresholdCents: 99999, warnUnpaidCount: 99, blockEntryThresholdCents: 99999, blockUnpaidCount: 99 });

  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-一次清';
  const N = 5;

  for (let i = 0; i < N; i++) {
    const e = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
      .send({ lotId: lot1.id, plateNo: plate, enterTime: `2026-06-1${i} 10:00:00` });
    assert.strictEqual(e.status, 201, `enter#${i}`);
    const x = await request(app).post(`/api/sessions/${e.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
      .send({ exitTime: `2026-06-1${i} 11:00:00`, feeCents: 2000, paid: false });
    assert.strictEqual(x.status, 200, `exit#${i}:${JSON.stringify(x.body)}`);
  }

  await request(app).post(`/api/risk/refresh/${plate}`).set('Authorization', `Bearer ${token}`);

  const beforeBL = await request(app).get(`/api/risk/blacklist/plate/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.ok(beforeBL.body.data, '黑名单检查返回');

  const payAll = await request(app).post('/api/debts/pay-all').set('Authorization', `Bearer ${token}`)
    .send({ plateNo: plate, method: 'CASH' });
  assert.strictEqual(payAll.status, 200, JSON.stringify(payAll.body));
  assert.strictEqual(payAll.body.data.success, true);
  assert.strictEqual(payAll.body.data.payment.totalCents, 10000, `总待缴应 10000: ${JSON.stringify(payAll.body)}`);

  const summary = (await request(app).get(`/api/debts/summary/${plate}`).set('Authorization', `Bearer ${token}`)).body.data.summary;
  assert.strictEqual(summary.totalRemainingCents, 0);
  assert.strictEqual(summary.unpaidCount, 0);

  const credit = await request(app).get(`/api/credit/profile/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.ok(credit.body.data.recentLogs.length >= 2, '应有信用分流水');

  const verify = await request(app).get(`/api/debts/verify/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(verify.body.data.consistent, true);
});

test('缴费金额不能超过欠费总额（防超额核销）', async () => {
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-防超额';

  const e = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: plate, enterTime: '2026-06-16 10:00:00' });
  await request(app).post(`/api/sessions/${e.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-16 11:00:00', feeCents: 1200, paid: false });

  const pay = await request(app).post('/api/debts/pay').set('Authorization', `Bearer ${token}`)
    .send({ plateNo: plate, amountCents: 5000 });
  assert.strictEqual(pay.status, 400, '超额缴费应被拒');
});

/* ==================== 风控 + 入场拦截 ==================== */

test('欠费累计触发黑名单，再入场被拦截', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const token = await loginAs('operator', 'operator123');
  await request(app).put('/api/debts/config/risk').set('Authorization', `Bearer ${adminToken}`)
    .send({ warnThresholdCents: 99999, warnUnpaidCount: 99, blockEntryThresholdCents: 10000, blockUnpaidCount: 5 });

  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-黑名单';

  for (let i = 0; i < 4; i++) {
    const e = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
      .send({ lotId: lot1.id, plateNo: plate, enterTime: `2026-06-0${i + 1} 10:00:00` });
    assert.strictEqual(e.status, 201, `enter#${i}:${JSON.stringify(e.body)}`);
    const x = await request(app).post(`/api/sessions/${e.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
      .send({ exitTime: `2026-06-0${i + 1} 11:00:00`, feeCents: 3000, paid: false });
    assert.strictEqual(x.status, 200, `exit#${i}:${JSON.stringify(x.body)}`);
  }

  const bl = await request(app).get(`/api/risk/blacklist/plate/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.ok(bl.body.data && bl.body.data.id, `应自动加入黑名单, got:${JSON.stringify(bl.body)}`);

  const check = await request(app).get(`/api/risk/check-entry?plateNo=${encodeURIComponent(plate)}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(check.status, 200);
  assert.strictEqual(check.body.data.allowEntry, false, `拦截规则应禁止入场: ${JSON.stringify(check.body.data)}`);
  assert.ok(check.body.data.matchedRules.length >= 1, '至少命中1条规则');

  const reEnter = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: plate, enterTime: '2026-06-17 10:00:00' });
  assert.ok(reEnter.status === 403 || reEnter.status === 402, `带黑名单入场应被拒(${reEnter.status}):${JSON.stringify(reEnter.body)}`);
});

test('缴清后黑名单自动解除，可再次入场', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const token = await loginAs('operator', 'operator123');
  await request(app).put('/api/debts/config/risk').set('Authorization', `Bearer ${adminToken}`)
    .send({ warnThresholdCents: 99999, warnUnpaidCount: 99, blockEntryThresholdCents: 7000, blockUnpaidCount: 3 });

  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-解除黑';

  for (let i = 0; i < 3; i++) {
    const e = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
      .send({ lotId: lot1.id, plateNo: plate, enterTime: `2026-06-0${i + 1} 10:00:00` });
    assert.strictEqual(e.status, 201, `解除黑测试 enter#${i}:${JSON.stringify(e.body)}`);
    const x = await request(app).post(`/api/sessions/${e.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
      .send({ exitTime: `2026-06-0${i + 1} 11:00:00`, feeCents: 2500, paid: false });
    assert.strictEqual(x.status, 200, `解除黑测试 exit#${i}:${JSON.stringify(x.body)}`);
  }

  const bl1 = await request(app).get(`/api/risk/blacklist/plate/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.ok(bl1.body.data.id, '有欠费应在黑名单');

  await request(app).post('/api/debts/pay-all').set('Authorization', `Bearer ${token}`).send({ plateNo: plate });
  await request(app).post(`/api/risk/refresh/${plate}`).set('Authorization', `Bearer ${token}`);

  const bl2 = await request(app).get(`/api/risk/blacklist/plate/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(bl2.body.data.inBlacklist, false, '缴清后应不在黑名单');

  const reEnter = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: plate, enterTime: '2026-06-17 10:00:00' });
  assert.strictEqual(reEnter.status, 201, '解除后应能入场');
});

test('风控规则 CRUD + 启用/禁用', async () => {
  const token = await loginAs('admin', 'admin123');

  const create = await request(app).post('/api/risk/rules').set('Authorization', `Bearer ${token}`)
    .send({
      code: 'TEST_RULE_1', name: '测试规则', type: 'ENTRY_BLOCK', priority: 50,
      condition: { type: 'DEBT_COUNT', operator: 'GTE', value: 10 },
      action: { type: 'BLOCK_ENTRY', message: '测试拦截' },
    });
  assert.strictEqual(create.status, 201);
  const ruleId = create.body.data.id;

  const list = await request(app).get('/api/risk/rules?all=1').set('Authorization', `Bearer ${token}`);
  assert.ok(list.body.data.some((r) => r.code === 'TEST_RULE_1'));

  const upd = await request(app).put(`/api/risk/rules/${ruleId}`).set('Authorization', `Bearer ${token}`)
    .send({ enabled: false });
  assert.strictEqual(upd.body.data.enabled, false);

  const del = await request(app).delete(`/api/risk/rules/${ruleId}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(del.status, 200);
});

/* ==================== 信用分 ==================== */

test('信用分规则触发完整链路 + 流水可解释', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const token = await loginAs('operator', 'operator123');
  await request(app).put('/api/debts/config/risk').set('Authorization', `Bearer ${adminToken}`)
    .send({ warnThresholdCents: 99999, warnUnpaidCount: 99, blockEntryThresholdCents: 99999, blockUnpaidCount: 99 });

  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-信用测试';

  const profile0 = (await request(app).get(`/api/credit/profile/${plate}`).set('Authorization', `Bearer ${token}`)).body.data;
  assert.strictEqual(profile0.score, 100, '默认100分');
  assert.strictEqual(profile0.level, 'A');

  const e1 = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: plate, enterTime: '2026-06-15 09:00:00' });
  assert.strictEqual(e1.status, 201);
  const x1 = await request(app).post(`/api/sessions/${e1.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-15 10:00:00', feeCents: 2000, paid: false });
  assert.strictEqual(x1.status, 200);
  assert.strictEqual(x1.body.data.creditChange.afterScore, 90);

  const e2 = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
    .send({ lotId: lot1.id, plateNo: plate, enterTime: '2026-06-16 09:00:00' });
  assert.strictEqual(e2.status, 201);
  const x2 = await request(app).post(`/api/sessions/${e2.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
    .send({ exitTime: '2026-06-16 10:00:00', feeCents: 2000, paid: false });
  assert.strictEqual(x2.status, 200);
  assert.strictEqual(x2.body.data.creditChange.afterScore, 80, '2次欠费应80分');

  const profile1 = (await request(app).get(`/api/credit/profile/${plate}`).set('Authorization', `Bearer ${token}`)).body.data;
  assert.strictEqual(profile1.level, 'B', '80分对应B级');
  assert.ok(profile1.recentLogs.length >= 2, '流水可追溯');
  for (const log of profile1.recentLogs) {
    assert.ok(log.ruleCode, '每条流水有规则编码');
    assert.ok(log.reason, '每条流水有解释');
    assert.strictEqual(log.beforeScore + log.delta, log.afterScore, '分差对得上');
  }

  const payRes = await request(app).post('/api/debts/pay-all').set('Authorization', `Bearer ${token}`).send({ plateNo: plate });
  assert.strictEqual(payRes.status, 200, `pay-all:${JSON.stringify(payRes.body)}`);
  await request(app).post(`/api/risk/refresh/${plate}`).set('Authorization', `Bearer ${token}`);

  const profile2 = (await request(app).get(`/api/credit/profile/${plate}`).set('Authorization', `Bearer ${token}`)).body.data;
  assert.ok(profile2.score > 80, `缴清后分数应回升: 当前${profile2.score}, 之前80`);
});

test('手动调整信用分 + 规则 CRUD', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const plate = '川B-手动调';

  const adj = await request(app).post('/api/credit/adjust').set('Authorization', `Bearer ${adminToken}`)
    .send({ plateNo: plate, delta: -50, reason: '管理员测试调分' });
  assert.strictEqual(adj.status, 200);
  assert.strictEqual(adj.body.data.afterScore, 50);

  const profile = (await request(app).get(`/api/credit/profile/${plate}`).set('Authorization', `Bearer ${adminToken}`)).body.data;
  assert.strictEqual(profile.level, 'D');
  assert.ok(profile.recommendedActions.some((a) => a.type === 'DISABLE_SENSELESS'), 'D级应禁用无感');

  const createRule = await request(app).post('/api/credit/rules').set('Authorization', `Bearer ${adminToken}`)
    .send({
      code: 'CR_TEST_1', name: '测试规则', eventType: 'MANUAL_ADJUST', delta: 99,
      description: '测试用',
    });
  assert.strictEqual(createRule.status, 201);

  const listRules = await request(app).get('/api/credit/rules?all=1').set('Authorization', `Bearer ${adminToken}`);
  assert.ok(listRules.body.data.some((r) => r.code === 'CR_TEST_1'));

  const trigger = await request(app).post('/api/credit/trigger').set('Authorization', `Bearer ${adminToken}`)
    .send({ plateNo: plate, eventType: 'LONG_TERM_GOOD', reason: '手动触发长期良好事件' });
  assert.strictEqual(trigger.status, 200);
  assert.strictEqual(trigger.body.data.applied, true);
});

test('核销顺序配置生效（改LARGEST_FIRST验证）', async () => {
  const adminToken = await loginAs('admin', 'admin123');
  const token = await loginAs('operator', 'operator123');
  const lots = (await request(app).get('/api/lots').set('Authorization', `Bearer ${token}`)).body.data;
  const lot1 = lots.find((l) => l.code === 'PL-CG-001');
  const plate = '川B-大额先';

  await request(app).put('/api/debts/config/risk').set('Authorization', `Bearer ${adminToken}`)
    .send({ warnThresholdCents: 99999, warnUnpaidCount: 99, blockEntryThresholdCents: 99999, blockUnpaidCount: 99 });

  const debts = [];
  const amounts = [500, 5000, 1200];
  for (let i = 0; i < 3; i++) {
    const e = await request(app).post('/api/sessions/enter').set('Authorization', `Bearer ${token}`)
      .send({ lotId: lot1.id, plateNo: plate, enterTime: `2026-06-1${i} 10:00:00` });
    assert.strictEqual(e.status, 201, `enter[${i}] 失败: ${JSON.stringify(e.body)}`);
    const x = await request(app).post(`/api/sessions/${e.body.data.id}/exit`).set('Authorization', `Bearer ${token}`)
      .send({ exitTime: `2026-06-1${i} 11:00:00`, feeCents: amounts[i], paid: false });
    assert.strictEqual(x.status, 200, `exit[${i}] 失败: ${JSON.stringify(x.body)}`);
    debts.push({ id: x.body.data.debt.id, amount: amounts[i] });
  }

  await request(app).put('/api/debts/config/writeoff').set('Authorization', `Bearer ${adminToken}`)
    .send({ writeOffOrder: 'LARGEST_FIRST' });

  const pay = await request(app).post('/api/debts/pay').set('Authorization', `Bearer ${token}`)
    .send({ plateNo: plate, amountCents: 3000 });
  assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));

  const largestDebt = debts.reduce((a, b) => (a.amount > b.amount ? a : b));
  assert.strictEqual(pay.body.data.writeoffs[0].debtId, largestDebt.id, 'LARGEST_FIRST 应先核销最大的5000');
  assert.strictEqual(pay.body.data.writeoffs[0].amountCents, 3000);

  const verify = await request(app).get(`/api/debts/verify/${plate}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(verify.body.data.consistent, true);

  await request(app).put('/api/debts/config/writeoff').set('Authorization', `Bearer ${adminToken}`)
    .send({ writeOffOrder: 'FIFO' });
});
