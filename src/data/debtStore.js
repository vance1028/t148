'use strict';

const { getPool } = require('../db');

/* ----------------------------- 映射 ----------------------------- */

function mapDebt(r) {
  if (!r) return null;
  return {
    id: r.id, sessionId: r.session_id, lotId: r.lot_id, plateNo: r.plate_no,
    totalCents: r.total_cents, paidCents: r.paid_cents,
    remainingCents: r.total_cents - r.paid_cents,
    status: r.status, reason: r.reason, note: r.note,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapPayment(r) {
  if (!r) return null;
  return {
    id: r.id, plateNo: r.plate_no, totalCents: r.total_cents,
    method: r.method, transactionId: r.transaction_id,
    operatorId: r.operator_id, note: r.note,
    createdAt: r.created_at,
  };
}
function mapWriteoff(r) {
  if (!r) return null;
  return {
    id: r.id, paymentId: r.payment_id, debtId: r.debt_id,
    amountCents: r.amount_cents, createdAt: r.created_at,
  };
}

/* ----------------------------- 欠费 parking_debts ----------------------------- */

async function createDebt({ sessionId, lotId, plateNo, totalCents, reason = 'PAYMENT_FAILED', note = '' }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query(
      'SELECT id FROM parking_debts WHERE session_id = ? FOR UPDATE',
      [sessionId],
    );
    if (existing.length) {
      await conn.rollback();
      const [rows] = await conn.query('SELECT * FROM parking_debts WHERE id = ?', [existing[0].id]);
      return mapDebt(rows[0]);
    }
    const [r] = await conn.query(
      `INSERT INTO parking_debts (session_id, lot_id, plate_no, total_cents, paid_cents, status, reason, note)
       VALUES (?, ?, ?, ?, 0, 'UNPAID', ?, ?)`,
      [sessionId, lotId, plateNo, totalCents, reason, note],
    );
    await conn.commit();
    return getDebtById(r.insertId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function getDebtById(id) {
  const [rows] = await getPool().query('SELECT * FROM parking_debts WHERE id = ?', [id]);
  return mapDebt(rows[0]);
}

async function getDebtBySessionId(sessionId) {
  const [rows] = await getPool().query('SELECT * FROM parking_debts WHERE session_id = ?', [sessionId]);
  return mapDebt(rows[0]);
}

async function listDebts({ plateNo, lotId, status, minRemaining = 0 } = {}) {
  const where = []; const params = [];
  if (plateNo) { where.push('plate_no = ?'); params.push(plateNo); }
  if (lotId !== undefined) { where.push('lot_id = ?'); params.push(lotId); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (minRemaining > 0) { where.push('(total_cents - paid_cents) >= ?'); params.push(minRemaining); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM parking_debts ${clause} ORDER BY id ASC`,
    params,
  );
  return rows.map(mapDebt);
}

async function getDebtSummary(plateNo) {
  const [rows] = await getPool().query(
    `SELECT
       COUNT(*) AS debt_count,
       SUM(CASE WHEN status = 'UNPAID' OR (total_cents - paid_cents) > 0 THEN 1 ELSE 0 END) AS unpaid_count,
       COALESCE(SUM(total_cents - paid_cents), 0) AS total_remaining_cents,
       COALESCE(SUM(total_cents), 0) AS total_original_cents,
       COALESCE(SUM(paid_cents), 0) AS total_paid_cents
     FROM parking_debts WHERE plate_no = ?`,
    [plateNo],
  );
  const r = rows[0];
  return {
    plateNo,
    debtCount: Number(r.debt_count || 0),
    unpaidCount: Number(r.unpaid_count || 0),
    totalRemainingCents: Number(r.total_remaining_cents || 0),
    totalOriginalCents: Number(r.total_original_cents || 0),
    totalPaidCents: Number(r.total_paid_cents || 0),
  };
}

/* ----------------------------- 缴费 debt_payments ----------------------------- */

async function createPayment({ plateNo, totalCents, method = 'WECHAT', transactionId = '', operatorId = null, note = '' }, conn = null) {
  const pool = conn || getPool();
  const [r] = await pool.query(
    `INSERT INTO debt_payments (plate_no, total_cents, method, transaction_id, operator_id, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [plateNo, totalCents, method, transactionId, operatorId, note],
  );
  return getPaymentById(r.insertId, conn);
}

async function getPaymentById(id, conn = null) {
  const pool = conn || getPool();
  const [rows] = await pool.query('SELECT * FROM debt_payments WHERE id = ?', [id]);
  return mapPayment(rows[0]);
}

async function listPayments({ plateNo } = {}) {
  const where = []; const params = [];
  if (plateNo) { where.push('plate_no = ?'); params.push(plateNo); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM debt_payments ${clause} ORDER BY id DESC`,
    params,
  );
  return rows.map(mapPayment);
}

/* ----------------------------- 核销 debt_writeoffs ----------------------------- */

async function createWriteoff({ paymentId, debtId, amountCents }, conn) {
  await conn.query(
    'INSERT INTO debt_writeoffs (payment_id, debt_id, amount_cents) VALUES (?, ?, ?)',
    [paymentId, debtId, amountCents],
  );
}

async function listWriteoffs({ paymentId, debtId } = {}) {
  const where = []; const params = [];
  if (paymentId !== undefined) { where.push('payment_id = ?'); params.push(paymentId); }
  if (debtId !== undefined) { where.push('debt_id = ?'); params.push(debtId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM debt_writeoffs ${clause} ORDER BY id ASC`,
    params,
  );
  return rows.map(mapWriteoff);
}

async function getPaymentWithWriteoffs(paymentId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) return null;
  const writeoffs = await listWriteoffs({ paymentId });
  return { ...payment, writeoffs };
}

/* ----------------------------- 系统配置 system_configs ----------------------------- */

async function getConfig(key, defaultValue = null) {
  const [rows] = await getPool().query('SELECT config_value FROM system_configs WHERE config_key = ?', [key]);
  if (!rows.length) return defaultValue;
  try { return JSON.parse(rows[0].config_value); } catch (_) { return rows[0].config_value; }
}

async function setConfig(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  await getPool().query(
    `INSERT INTO system_configs (config_key, config_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP(3)`,
    [key, v],
  );
  return getConfig(key);
}

module.exports = {
  mapDebt, mapPayment, mapWriteoff,
  createDebt, getDebtById, getDebtBySessionId, listDebts, getDebtSummary,
  createPayment, getPaymentById, listPayments, getPaymentWithWriteoffs,
  createWriteoff, listWriteoffs,
  getConfig, setConfig,
};
