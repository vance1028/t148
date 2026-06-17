'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/**
 * MySQL 连接管理（mysql2/promise 连接池）。
 * 全程 utf8mb4，确保中文不乱码。
 */

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 13366,
  user: process.env.DB_USER || 'park',
  password: process.env.DB_PASSWORD || 'parkpass',
  database: process.env.DB_NAME || 'parking',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
};

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

/**
 * 确保表结构存在（读取 db/schema.sql 执行）。
 * 用一个开启 multipleStatements 的临时连接执行，执行完关闭。
 */
async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({ ...DB_CONFIG, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

/** 清空所有业务数据（测试用）。 */
async function resetAll() {
  const conn = await getPool().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['parking_sessions', 'parking_spaces', 'vehicles', 'parking_lots', 'users']) {
      await conn.query(`TRUNCATE TABLE ${t}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

/** 等待数据库可连接（最多重试若干次），用于启动时等容器就绪。 */
async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const conn = await mysql.createConnection({ ...DB_CONFIG, database: undefined });
      await conn.end();
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('数据库连接超时');
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, ensureSchema, resetAll, waitForDb, close, DB_CONFIG };
