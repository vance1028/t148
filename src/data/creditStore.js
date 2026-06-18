'use strict';

const { getPool } = require('../db');

/* ----------------------------- 映射 ----------------------------- */

function mapCreditScore(r) {
  if (!r) return null;
  return {
    id: r.id, plateNo: r.plate_no, score: r.score, level: r.level,
    updatedAt: r.updated_at,
  };
}
function mapCreditLog(r) {
  if (!r) return null;
  return {
    id: r.id, plateNo: r.plate_no, ruleCode: r.rule_code, ruleName: r.rule_name,
    delta: r.delta, beforeScore: r.before_score, afterScore: r.after_score,
    reason: r.reason, refId: r.ref_id, createdAt: r.created_at,
  };
}
function mapCreditRule(r) {
  if (!r) return null;
  let condition = r.condition_json;
  if (condition && typeof condition === 'string') { try { condition = JSON.parse(condition); } catch (_) {} }
  return {
    id: r.id, code: r.code, name: r.name, eventType: r.event_type,
    delta: r.delta, enabled: !!r.enabled, condition,
    description: r.description, createdAt: r.created_at,
  };
}

/* ----------------------------- 信用分快照 credit_scores ----------------------------- */

function scoreToLevel(score) {
  if (score >= 120) return 'S';
  if (score >= 100) return 'A';
  if (score >= 80) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

async function getOrCreateCreditScore(plateNo, conn = null) {
  const pool = conn || getPool();
  const [rows] = await pool.query('SELECT * FROM credit_scores WHERE plate_no = ? FOR UPDATE', [plateNo]);
  if (rows.length) return mapCreditScore(rows[0]);
  const [r] = await pool.query(
    `INSERT INTO credit_scores (plate_no, score, level) VALUES (?, 100, 'A')`,
    [plateNo],
  );
  const [newRows] = await pool.query('SELECT * FROM credit_scores WHERE id = ?', [r.insertId]);
  return mapCreditScore(newRows[0]);
}

async function getCreditScore(plateNo) {
  const [rows] = await getPool().query('SELECT * FROM credit_scores WHERE plate_no = ?', [plateNo]);
  return mapCreditScore(rows[0]);
}

async function listCreditScores({ minScore, maxScore, level } = {}) {
  const where = []; const params = [];
  if (minScore !== undefined) { where.push('score >= ?'); params.push(minScore); }
  if (maxScore !== undefined) { where.push('score <= ?'); params.push(maxScore); }
  if (level) { where.push('level = ?'); params.push(level); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM credit_scores ${clause} ORDER BY score DESC`,
    params,
  );
  return rows.map(mapCreditScore);
}

async function updateCreditScoreDirect(plateNo, score, conn = null) {
  const pool = conn || getPool();
  const clamped = Math.max(0, Math.min(200, score));
  const level = scoreToLevel(clamped);
  await pool.query(
    `UPDATE credit_scores SET score = ?, level = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE plate_no = ?`,
    [clamped, level, plateNo],
  );
  return getCreditScore(plateNo);
}

/* ----------------------------- 信用分流水 credit_score_logs ----------------------------- */

async function createCreditLog({ plateNo, ruleCode = '', ruleName = '', delta, beforeScore, afterScore, reason = '', refId = '' }, conn = null) {
  const pool = conn || getPool();
  const [r] = await pool.query(
    `INSERT INTO credit_score_logs
     (plate_no, rule_code, rule_name, delta, before_score, after_score, reason, ref_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [plateNo, ruleCode, ruleName, delta, beforeScore, afterScore, reason, refId],
  );
  return getCreditLogById(r.insertId, conn);
}

async function getCreditLogById(id, conn = null) {
  const pool = conn || getPool();
  const [rows] = await pool.query('SELECT * FROM credit_score_logs WHERE id = ?', [id]);
  return mapCreditLog(rows[0]);
}

async function listCreditLogs({ plateNo, ruleCode, limit = 100 } = {}) {
  const where = []; const params = [];
  if (plateNo) { where.push('plate_no = ?'); params.push(plateNo); }
  if (ruleCode) { where.push('rule_code = ?'); params.push(ruleCode); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM credit_score_logs ${clause} ORDER BY id DESC LIMIT ?`,
    [...params, Number(limit)],
  );
  return rows.map(mapCreditLog);
}

/* ----------------------------- 信用分规则 credit_rules ----------------------------- */

async function createCreditRule(d) {
  const condition = d.condition
    ? (typeof d.condition === 'string' ? d.condition : JSON.stringify(d.condition))
    : null;
  const [r] = await getPool().query(
    `INSERT INTO credit_rules (code, name, event_type, delta, enabled, condition_json, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      d.code, d.name, d.eventType, d.delta || 0,
      d.enabled === false ? 0 : 1, condition, d.description || '',
    ],
  );
  return getCreditRuleById(r.insertId);
}

async function getCreditRuleById(id) {
  const [rows] = await getPool().query('SELECT * FROM credit_rules WHERE id = ?', [id]);
  return mapCreditRule(rows[0]);
}

async function getCreditRuleByCode(code) {
  const [rows] = await getPool().query('SELECT * FROM credit_rules WHERE code = ?', [code]);
  return mapCreditRule(rows[0]);
}

async function listCreditRules({ eventType, enabledOnly = true } = {}) {
  const where = []; const params = [];
  if (eventType) { where.push('event_type = ?'); params.push(eventType); }
  if (enabledOnly) where.push('enabled = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await getPool().query(
    `SELECT * FROM credit_rules ${clause} ORDER BY id ASC`,
    params,
  );
  return rows.map(mapCreditRule);
}

async function updateCreditRule(id, d) {
  const sets = []; const params = [];
  const simpleMap = { code: 'code', name: 'name', eventType: 'event_type', delta: 'delta', description: 'description' };
  for (const [k, col] of Object.entries(simpleMap)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (d.enabled !== undefined) { sets.push('enabled = ?'); params.push(d.enabled ? 1 : 0); }
  if (d.condition !== undefined) {
    sets.push('condition_json = ?');
    params.push(d.condition ? (typeof d.condition === 'string' ? d.condition : JSON.stringify(d.condition)) : null);
  }
  if (sets.length) {
    params.push(id);
    await getPool().query(`UPDATE credit_rules SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getCreditRuleById(id);
}

async function deleteCreditRule(id) {
  const [r] = await getPool().query('DELETE FROM credit_rules WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

module.exports = {
  scoreToLevel,
  mapCreditScore, mapCreditLog, mapCreditRule,
  getOrCreateCreditScore, getCreditScore, listCreditScores, updateCreditScoreDirect,
  createCreditLog, getCreditLogById, listCreditLogs,
  createCreditRule, getCreditRuleById, getCreditRuleByCode, listCreditRules,
  updateCreditRule, deleteCreditRule,
};
