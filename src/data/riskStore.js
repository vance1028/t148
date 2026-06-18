'use strict';

const { getPool } = require('../db');

/* ----------------------------- 映射 ----------------------------- */

function mapBlacklist(r) {
  if (!r) return null;
  return {
    id: r.id, plateNo: r.plate_no, level: r.level, reason: r.reason,
    totalOwedCents: r.total_owed_cents, unpaidCount: r.unpaid_count,
    status: r.status, action: r.action, expiresAt: r.expires_at,
    operatorId: r.operator_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapRiskRule(r) {
  if (!r) return null;
  let condition = r.condition_json;
  let action = r.action_json;
  if (typeof condition === 'string') { try { condition = JSON.parse(condition); } catch (_) {} }
  if (typeof action === 'string') { try { action = JSON.parse(action); } catch (_) {} }
  return {
    id: r.id, code: r.code, name: r.name, type: r.type,
    enabled: !!r.enabled, priority: r.priority,
    condition, action,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ----------------------------- 黑名单 vehicle_blacklists ----------------------------- */

async function upsertBlacklist({ plateNo, level = 'WARN', reason = '', totalOwedCents = 0, unpaidCount = 0, action = 'BLOCK_ENTRY', expiresAt = null, operatorId = null }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query(
      'SELECT id FROM vehicle_blacklists WHERE plate_no = ? FOR UPDATE',
      [plateNo],
    );
    if (existing.length) {
      await conn.query(
        `UPDATE vehicle_blacklists
         SET level = ?, reason = ?, total_owed_cents = ?, unpaid_count = ?,
             action = ?, expires_at = ?, operator_id = ?, status = 'ACTIVE',
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [level, reason, totalOwedCents, unpaidCount, action, expiresAt, operatorId, existing[0].id],
      );
      await conn.commit();
      return getBlacklistByPlate(plateNo);
    }
    const [r] = await conn.query(
      `INSERT INTO vehicle_blacklists
       (plate_no, level, reason, total_owed_cents, unpaid_count, status, action, expires_at, operator_id)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [plateNo, level, reason, totalOwedCents, unpaidCount, action, expiresAt, operatorId],
    );
    await conn.commit();
    return getBlacklistById(r.insertId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function getBlacklistById(id) {
  const [rows] = await getPool().query('SELECT * FROM vehicle_blacklists WHERE id = ?', [id]);
  return mapBlacklist(rows[0]);
}

async function getBlacklistByPlate(plateNo) {
  const [rows] = await getPool().query(
    `SELECT * FROM vehicle_blacklists WHERE plate_no = ?
     AND (status = 'ACTIVE') AND (expires_at IS NULL OR expires_at > NOW(3))`,
    [plateNo],
  );
  return mapBlacklist(rows[0]);
}

async function listBlacklists({ level, status } = {}) {
  const where = [`status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW(3))`]; const params = [];
  if (level) { where.unshift('level = ?'); params.push(level); }
  if (status) { where.unshift('status = ?'); params.pop(); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM vehicle_blacklists ${clause} ORDER BY id DESC`,
    params,
  );
  return rows.map(mapBlacklist);
}

async function updateBlacklist(id, d) {
  const map = {
    level: 'level', reason: 'reason', totalOwedCents: 'total_owed_cents',
    unpaidCount: 'unpaid_count', status: 'status', action: 'action',
    expiresAt: 'expires_at',
  };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (sets.length) {
    sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    params.push(id);
    await getPool().query(`UPDATE vehicle_blacklists SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getBlacklistById(id);
}

async function removeBlacklistByPlate(plateNo) {
  const [r] = await getPool().query(
    `UPDATE vehicle_blacklists SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP(3)
     WHERE plate_no = ? AND status = 'ACTIVE'`,
    [plateNo],
  );
  return r.affectedRows > 0;
}

async function deleteBlacklist(id) {
  const [r] = await getPool().query('DELETE FROM vehicle_blacklists WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

/* ----------------------------- 风控规则 risk_rules ----------------------------- */

async function createRiskRule(d) {
  const condition = typeof d.condition === 'string' ? d.condition : JSON.stringify(d.condition || {});
  const action = typeof d.action === 'string' ? d.action : JSON.stringify(d.action || {});
  const [r] = await getPool().query(
    `INSERT INTO risk_rules (code, name, type, enabled, priority, condition_json, action_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [d.code, d.name, d.type || 'ENTRY_BLOCK', d.enabled ? 1 : 0, d.priority || 0, condition, action],
  );
  return getRiskRuleById(r.insertId);
}

async function getRiskRuleById(id) {
  const [rows] = await getPool().query('SELECT * FROM risk_rules WHERE id = ?', [id]);
  return mapRiskRule(rows[0]);
}

async function getRiskRuleByCode(code) {
  const [rows] = await getPool().query('SELECT * FROM risk_rules WHERE code = ?', [code]);
  return mapRiskRule(rows[0]);
}

async function listRiskRules({ type, enabledOnly = true } = {}) {
  const where = []; const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (enabledOnly) where.push('enabled = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM risk_rules ${clause} ORDER BY priority DESC, id ASC`,
    params,
  );
  return rows.map(mapRiskRule);
}

async function updateRiskRule(id, d) {
  const sets = []; const params = [];
  const simpleMap = { code: 'code', name: 'name', type: 'type', priority: 'priority' };
  for (const [k, col] of Object.entries(simpleMap)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (d.enabled !== undefined) { sets.push('enabled = ?'); params.push(d.enabled ? 1 : 0); }
  if (d.condition !== undefined) {
    sets.push('condition_json = ?');
    params.push(typeof d.condition === 'string' ? d.condition : JSON.stringify(d.condition));
  }
  if (d.action !== undefined) {
    sets.push('action_json = ?');
    params.push(typeof d.action === 'string' ? d.action : JSON.stringify(d.action));
  }
  if (sets.length) {
    sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    params.push(id);
    await getPool().query(`UPDATE risk_rules SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getRiskRuleById(id);
}

async function deleteRiskRule(id) {
  const [r] = await getPool().query('DELETE FROM risk_rules WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

module.exports = {
  mapBlacklist, mapRiskRule,
  upsertBlacklist, getBlacklistById, getBlacklistByPlate, listBlacklists,
  updateBlacklist, removeBlacklistByPlate, deleteBlacklist,
  createRiskRule, getRiskRuleById, getRiskRuleByCode, listRiskRules,
  updateRiskRule, deleteRiskRule,
};
