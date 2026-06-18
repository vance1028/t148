-- 城市智慧停车运营管理平台 表结构（全程 utf8mb4，确保中文正常）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(64) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'VIEWER',
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parking_lots (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  district      VARCHAR(64) NOT NULL,
  address       VARCHAR(255) NOT NULL DEFAULT '',
  total_spaces  INT NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parking_spaces (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  lot_id      INT UNSIGNED NOT NULL,
  code        VARCHAR(32) NOT NULL,
  type        VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
  status      VARCHAR(16) NOT NULL DEFAULT 'FREE',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_lot_space (lot_id, code),
  CONSTRAINT fk_space_lot FOREIGN KEY (lot_id) REFERENCES parking_lots(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vehicles (
  id           INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plate_no     VARCHAR(16) NOT NULL UNIQUE,
  owner_name   VARCHAR(64) NOT NULL DEFAULT '',
  phone        VARCHAR(32) NOT NULL DEFAULT '',
  vehicle_type VARCHAR(16) NOT NULL DEFAULT 'SMALL',
  is_member    TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parking_sessions (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  lot_id      INT UNSIGNED NOT NULL,
  space_id    INT UNSIGNED NULL,
  plate_no    VARCHAR(16) NOT NULL,
  enter_time  DATETIME(3) NOT NULL,
  exit_time   DATETIME(3) NULL,
  fee_cents   INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'PARKED',
  paid        TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_session_lot FOREIGN KEY (lot_id) REFERENCES parking_lots(id) ON DELETE CASCADE,
  CONSTRAINT fk_session_space FOREIGN KEY (space_id) REFERENCES parking_spaces(id) ON DELETE SET NULL,
  INDEX idx_session_status (status),
  INDEX idx_session_plate (plate_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== 欠费模块 ====================

CREATE TABLE IF NOT EXISTS parking_debts (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  session_id    INT UNSIGNED NOT NULL UNIQUE,
  lot_id        INT UNSIGNED NOT NULL,
  plate_no      VARCHAR(16) NOT NULL,
  total_cents   INT NOT NULL,
  paid_cents    INT NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'UNPAID',
  reason        VARCHAR(64) NOT NULL DEFAULT 'PAYMENT_FAILED',
  note          VARCHAR(255) NOT NULL DEFAULT '',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_debt_session FOREIGN KEY (session_id) REFERENCES parking_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_debt_lot FOREIGN KEY (lot_id) REFERENCES parking_lots(id) ON DELETE CASCADE,
  INDEX idx_debt_plate (plate_no),
  INDEX idx_debt_status (status),
  INDEX idx_debt_lot (lot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS debt_payments (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plate_no      VARCHAR(16) NOT NULL,
  total_cents   INT NOT NULL,
  method        VARCHAR(32) NOT NULL DEFAULT 'WECHAT',
  transaction_id VARCHAR(128) NOT NULL DEFAULT '',
  operator_id   INT UNSIGNED NULL,
  note          VARCHAR(255) NOT NULL DEFAULT '',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_payment_plate (plate_no),
  INDEX idx_payment_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS debt_writeoffs (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  payment_id    INT UNSIGNED NOT NULL,
  debt_id       INT UNSIGNED NOT NULL,
  amount_cents  INT NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_wo_payment FOREIGN KEY (payment_id) REFERENCES debt_payments(id) ON DELETE CASCADE,
  CONSTRAINT fk_wo_debt FOREIGN KEY (debt_id) REFERENCES parking_debts(id) ON DELETE CASCADE,
  UNIQUE KEY uk_wo_debt_payment (debt_id, payment_id),
  INDEX idx_wo_payment (payment_id),
  INDEX idx_wo_debt (debt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== 风控模块 ====================

CREATE TABLE IF NOT EXISTS vehicle_blacklists (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plate_no      VARCHAR(16) NOT NULL UNIQUE,
  level         VARCHAR(16) NOT NULL DEFAULT 'WARN',
  reason        VARCHAR(255) NOT NULL DEFAULT '',
  total_owed_cents INT NOT NULL DEFAULT 0,
  unpaid_count  INT NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  action        VARCHAR(32) NOT NULL DEFAULT 'BLOCK_ENTRY',
  expires_at    DATETIME(3) NULL,
  operator_id   INT UNSIGNED NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_bl_status (status),
  INDEX idx_bl_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS risk_rules (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  type          VARCHAR(32) NOT NULL DEFAULT 'ENTRY_BLOCK',
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  priority      INT NOT NULL DEFAULT 0,
  condition_json JSON NOT NULL,
  action_json   JSON NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== 信用分模块 ====================

CREATE TABLE IF NOT EXISTS credit_scores (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plate_no      VARCHAR(16) NOT NULL UNIQUE,
  score         INT NOT NULL DEFAULT 100,
  level         VARCHAR(16) NOT NULL DEFAULT 'A',
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_cs_score (score),
  INDEX idx_cs_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_score_logs (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plate_no      VARCHAR(16) NOT NULL,
  rule_code     VARCHAR(32) NOT NULL DEFAULT '',
  rule_name     VARCHAR(128) NOT NULL DEFAULT '',
  delta         INT NOT NULL,
  before_score  INT NOT NULL,
  after_score   INT NOT NULL,
  reason        VARCHAR(255) NOT NULL DEFAULT '',
  ref_id        VARCHAR(64) NOT NULL DEFAULT '',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_csl_plate (plate_no),
  INDEX idx_csl_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_rules (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  event_type    VARCHAR(32) NOT NULL,
  delta         INT NOT NULL DEFAULT 0,
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  condition_json JSON NULL,
  description   VARCHAR(255) NOT NULL DEFAULT '',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== 系统配置 ====================

CREATE TABLE IF NOT EXISTS system_configs (
  config_key    VARCHAR(64) PRIMARY KEY,
  config_value  TEXT NOT NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
