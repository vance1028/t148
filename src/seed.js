'use strict';

const store = require('./data/store');

/**
 * 写入初始种子数据：管理员/收费员/观察员各一个账号，
 * 外加若干停车场、车位、车辆与停车记录，方便本地起步与「功能迭代」类任务直接有数据可用。
 * 幂等：若库中已存在用户则跳过。
 */
async function seed() {
  if ((await store.countUsers()) > 0) return { skipped: true };

  await store.createUser({ username: 'admin', password: 'admin123', name: '系统管理员', role: 'ADMIN' });
  await store.createUser({ username: 'operator', password: 'operator123', name: '张收费', role: 'OPERATOR' });
  await store.createUser({ username: 'viewer', password: 'viewer123', name: '李值班', role: 'VIEWER' });

  const lot1 = await store.createLot({
    code: 'PL-CG-001', name: '市民中心地下停车场', district: '城关区',
    address: '人民中路1号地下', totalSpaces: 6, status: 'OPEN',
  });
  const lot2 = await store.createLot({
    code: 'PL-JN-002', name: '滨江路立体停车楼', district: '江南区',
    address: '滨江路88号', totalSpaces: 4, status: 'OPEN',
  });
  await store.createLot({
    code: 'PL-GX-003', name: '高新万达路侧停车段', district: '高新区',
    address: '科技大道沿线', totalSpaces: 3, status: 'CLOSED',
  });

  const spaces = [
    { lotId: lot1.id, code: 'A-01', type: 'STANDARD', status: 'OCCUPIED' },
    { lotId: lot1.id, code: 'A-02', type: 'STANDARD', status: 'FREE' },
    { lotId: lot1.id, code: 'A-03', type: 'CHARGING', status: 'FREE' },
    { lotId: lot1.id, code: 'A-04', type: 'DISABLED', status: 'FREE' },
    { lotId: lot2.id, code: 'B-01', type: 'STANDARD', status: 'OCCUPIED' },
    { lotId: lot2.id, code: 'B-02', type: 'OVERSIZE', status: 'FREE' },
  ];
  const spaceRecs = [];
  for (const s of spaces) spaceRecs.push(await store.createSpace(s));

  await store.createVehicle({ plateNo: '川A12345', ownerName: '王明', phone: '13800000001', vehicleType: 'SMALL', isMember: true });
  await store.createVehicle({ plateNo: '川AD6789', ownerName: '赵丽', phone: '13800000002', vehicleType: 'SMALL', isMember: false });
  await store.createVehicle({ plateNo: '川B88888', ownerName: '物流公司', phone: '13800000003', vehicleType: 'LARGE', isMember: true });

  await store.createSession({
    lotId: lot1.id, spaceId: spaceRecs[0].id, plateNo: '川A12345',
    enterTime: '2026-06-16 08:30:00', status: 'PARKED',
  });
  const finished = await store.createSession({
    lotId: lot2.id, spaceId: spaceRecs[4].id, plateNo: '川AD6789',
    enterTime: '2026-06-16 07:00:00', status: 'PARKED',
  });
  await store.updateSession(finished.id, { exitTime: '2026-06-16 09:15:00', feeCents: 1500, status: 'FINISHED', paid: true });

  return { skipped: false, users: 3, lots: 3, spaces: spaceRecs.length, vehicles: 3, sessions: 2 };
}

if (require.main === module) {
  const { getPool, ensureSchema, waitForDb, close } = require('./db');
  (async () => {
    await waitForDb();
    await ensureSchema();
    getPool();
    const result = await seed();
    // eslint-disable-next-line no-console
    console.log('种子数据写入结果:', JSON.stringify(result));
    await close();
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed };
