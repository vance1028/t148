'use strict';

// 测试连接 MySQL（默认 127.0.0.1:13366，由 docker compose 起的 db 服务）。
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

const app = createApp();

test.before(async () => {
  await waitForDb();
  await ensureSchema();
  getPool();
});

test.beforeEach(async () => {
  await resetAll();
  await seed();
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
  assert.strictEqual(exit1.body.data.status, 'FINISHED');
  assert.strictEqual(exit1.body.data.feeCents, 800);

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
