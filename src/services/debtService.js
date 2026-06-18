'use strict';

const { getPool } = require('../db');
const debtStore = require('../data/debtStore');
const creditService = require('./creditService');

const WRITE_OFF_ORDER = {
  FIFO: 'FIFO',
  LARGEST_FIRST: 'LARGEST_FIRST',
  SMALLEST_FIRST: 'SMALLEST_FIRST',
};

const DEFAULT_CONFIG = {
  writeOffOrder: WRITE_OFF_ORDER.FIFO,
  minWriteOffAmount: 0,
};

async function ensureDefaultConfigs() {
  const existing = await debtStore.getConfig('debt.writeoff');
  if (!existing) {
    await debtStore.setConfig('debt.writeoff', DEFAULT_CONFIG);
  }
  const existing2 = await debtStore.getConfig('debt.risk');
  if (!existing2) {
    await debtStore.setConfig('debt.risk', {
      blockEntryThresholdCents: 5000,
      warnThresholdCents: 2000,
      blockUnpaidCount: 3,
      warnUnpaidCount: 2,
    });
  }
}

async function getWriteoffConfig() {
  await ensureDefaultConfigs();
  const cfg = await debtStore.getConfig('debt.writeoff', DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...cfg };
}

async function getRiskConfig() {
  await ensureDefaultConfigs();
  return await debtStore.getConfig('debt.risk', {});
}

/* ----------------------------- 出场欠费挂账 ----------------------------- */

async function registerDebtOnExit({ sessionId, lotId, plateNo, feeCents, paid = false, reason = 'PAYMENT_FAILED', note = '' }) {
  if (paid || feeCents <= 0) return null;
  const debt = await debtStore.createDebt({
    sessionId, lotId, plateNo, totalCents: feeCents, reason, note,
  });
  return debt;
}

/* ----------------------------- 补缴核销核心 ----------------------------- */

function orderDebtsForWriteoff(debts, order) {
  const copy = [...debts];
  switch (order) {
    case WRITE_OFF_ORDER.LARGEST_FIRST:
      copy.sort((a, b) => (b.totalCents - b.paidCents) - (a.totalCents - a.paidCents));
      break;
    case WRITE_OFF_ORDER.SMALLEST_FIRST:
      copy.sort((a, b) => (a.totalCents - a.paidCents) - (b.totalCents - b.paidCents));
      break;
    case WRITE_OFF_ORDER.FIFO:
    default:
      copy.sort((a, b) => a.id - b.id);
      break;
  }
  return copy;
}

async function processPayment({ plateNo, amountCents, method = 'WECHAT', transactionId = '', operatorId = null, note = '', debtIds = null }) {
  if (!amountCents || amountCents <= 0) {
    const err = new Error('缴费金额必须大于 0');
    err.statusCode = 400;
    throw err;
  }

  const config = await getWriteoffConfig();
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const unpaidDebts = await _lockAndFetchUnpaidDebts(conn, plateNo, debtIds);
    if (!unpaidDebts.length) {
      await conn.rollback();
      return { success: false, message: '没有可核销的欠费', payment: null, writeoffs: [] };
    }

    const totalRemaining = unpaidDebts.reduce((s, d) => s + (d.total_cents - d.paid_cents), 0);
    if (amountCents > totalRemaining) {
      await conn.rollback();
      const err = new Error(`缴费金额(${amountCents})超过待缴总额(${totalRemaining})`);
      err.statusCode = 400;
      throw err;
    }

    const payment = await debtStore.createPayment(
      { plateNo, totalCents: amountCents, method, transactionId, operatorId, note },
      conn,
    );

    const orderedDebts = orderDebtsForWriteoff(
      unpaidDebts.map(debtStore.mapDebt),
      config.writeOffOrder,
    );

    let remainingPayment = amountCents;
    const writeoffs = [];

    for (const debt of orderedDebts) {
      if (remainingPayment <= 0) break;
      const stillOwed = debt.totalCents - debt.paidCents;
      if (stillOwed <= 0) continue;

      const toApply = Math.min(stillOwed, remainingPayment);

      const [upd] = await conn.query(
        `UPDATE parking_debts
         SET paid_cents = paid_cents + ?,
             status = CASE
               WHEN paid_cents + ? >= total_cents THEN 'PAID'
               ELSE 'PARTIAL'
             END,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND (total_cents - paid_cents) >= ?`,
        [toApply, toApply, debt.id, toApply],
      );
      if (upd.affectedRows !== 1) {
        await conn.rollback();
        const err = new Error(`欠费 ${debt.id} 核销冲突，请重试`);
        err.statusCode = 409;
        throw err;
      }

      await debtStore.createWriteoff(
        { paymentId: payment.id, debtId: debt.id, amountCents: toApply },
        conn,
      );

      remainingPayment -= toApply;
      writeoffs.push({ debtId: debt.id, amountCents: toApply, sessionId: debt.sessionId });
    }

    if (remainingPayment > 0) {
      await conn.rollback();
      const err = new Error('核销后仍有余款，操作已回滚');
      err.statusCode = 400;
      throw err;
    }

    await conn.commit();

    const writeoffAmount = writeoffs.reduce((s, w) => s + w.amountCents, 0);
    await creditService.applyEvent(plateNo, creditService.EVENT_TYPES.DEBT_PAID, {
      amount: writeoffAmount, refId: `pay-${payment.id}`,
      reason: `补缴欠费${writeoffAmount}分`,
    });
    const afterSummary = await debtStore.getDebtSummary(plateNo);
    if (afterSummary.totalRemainingCents === 0 && writeoffs.length > 0) {
      await creditService.applyEvent(plateNo, creditService.EVENT_TYPES.ALL_DEBTS_CLEARED, {
        refId: `all-cleared-${plateNo}`,
      });
    }

    const finalPayment = await debtStore.getPaymentWithWriteoffs(payment.id);
    return { success: true, message: '补缴成功', payment: finalPayment, writeoffs };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function _lockAndFetchUnpaidDebts(conn, plateNo, debtIds = null) {
  if (debtIds && debtIds.length) {
    const placeholders = debtIds.map(() => '?').join(',');
    const [rows] = await conn.query(
      `SELECT * FROM parking_debts
       WHERE plate_no = ? AND id IN (${placeholders}) AND (total_cents - paid_cents) > 0
       ORDER BY id ASC FOR UPDATE`,
      [plateNo, ...debtIds],
    );
    return rows;
  }
  const [rows] = await conn.query(
    `SELECT * FROM parking_debts
     WHERE plate_no = ? AND (total_cents - paid_cents) > 0
     ORDER BY id ASC FOR UPDATE`,
    [plateNo],
  );
  return rows;
}

async function payAllDebts({ plateNo, method = 'WECHAT', transactionId = '', operatorId = null, note = '' }) {
  const summary = await debtStore.getDebtSummary(plateNo);
  if (summary.totalRemainingCents <= 0) {
    return { success: false, message: '没有待缴欠费' };
  }
  return processPayment({
    plateNo, amountCents: summary.totalRemainingCents,
    method, transactionId, operatorId, note,
  });
}

/* ----------------------------- 查询辅助 ----------------------------- */

async function getVehicleDebtOverview(plateNo) {
  const summary = await debtStore.getDebtSummary(plateNo);
  const debts = await debtStore.listDebts({ plateNo, minRemaining: 1 });
  const payments = await debtStore.listPayments({ plateNo });
  return { summary, debts, recentPayments: payments.slice(0, 20) };
}

async function verifyWriteoffConsistency(plateNo) {
  const conn = await getPool().getConnection();
  try {
    const [debtRows] = await conn.query(
      `SELECT id, total_cents, paid_cents FROM parking_debts WHERE plate_no = ?`,
      [plateNo],
    );
    const [woRows] = await conn.query(
      `SELECT w.debt_id, SUM(w.amount_cents) AS wo_sum
       FROM debt_writeoffs w
       JOIN debt_payments p ON w.payment_id = p.id
       WHERE p.plate_no = ?
       GROUP BY w.debt_id`,
      [plateNo],
    );
    const woMap = new Map(woRows.map((r) => [r.debt_id, Number(r.wo_sum)]));

    const issues = [];
    for (const d of debtRows) {
      const woSum = woMap.get(d.id) || 0;
      if (woSum !== Number(d.paid_cents)) {
        issues.push({
          debtId: d.id,
          recordedPaid: d.paid_cents,
          actualWriteoffSum: woSum,
          diff: d.paid_cents - woSum,
        });
      }
      if (d.paid_cents > d.total_cents) {
        issues.push({ debtId: d.id, overpaid: d.paid_cents - d.total_cents });
      }
    }
    return { consistent: issues.length === 0, issues, totalDebts: debtRows.length };
  } finally {
    conn.release();
  }
}

module.exports = {
  WRITE_OFF_ORDER,
  ensureDefaultConfigs,
  getWriteoffConfig,
  getRiskConfig,
  registerDebtOnExit,
  processPayment,
  payAllDebts,
  getVehicleDebtOverview,
  verifyWriteoffConsistency,
};
