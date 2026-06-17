# 城市智慧停车运营管理平台 - 后端 API

纯后端 REST API 服务，用于管理城市停车场、车位、车辆与停车记录，含登录鉴权与基于角色的权限控制。
作为「功能迭代」类评测题目的基础工程：Node + Express + MySQL，docker compose 一键编排，结构清晰、留有充分扩展点（分时计费、月卡、车位预约、潮汐共享、违停记账、营收对账等都可在此基础上长出来）。

## 技术栈

- Node.js (≥ 18) + Express 4
- 数据库：MySQL 8（`mysql2/promise` 连接池，全程 utf8mb4）
- 认证：JWT（`jsonwebtoken`）+ scrypt 密码哈希（Node 内置 crypto）
- 编排：Docker Compose
- 测试：Node 内置 `node:test` + `supertest`

## 快速开始

### docker compose（推荐）

```bash
docker compose up --build
```

- API 暴露在 `http://localhost:5080`
- MySQL 暴露在宿主机 `13366` 端口
- 首次启动 `db/schema.sql` 建表，应用检测到空库自动写入种子数据

### 本地运行

```bash
docker compose up -d db          # 仅起数据库
npm install
npm run seed                     # 可选：预先灌种子
npm start
```

### 测试

```bash
docker compose up -d db          # 测试需要 MySQL（默认 127.0.0.1:13366）
npm test
```

测试每个用例前重置并重新播种，互不影响。

## 种子账号

| 用户名 | 密码 | 角色 | 说明 |
| --- | --- | --- | --- |
| admin | admin123 | ADMIN | 管理员，全部权限（含删除、管用户） |
| operator | operator123 | OPERATOR | 收费员，可建/改停车场车位车辆、登记出入场 |
| viewer | viewer123 | VIEWER | 观察员，只读查询 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5080` | API 监听端口 |
| `DB_HOST` | `127.0.0.1` | MySQL 主机 |
| `DB_PORT` | `13366` | MySQL 端口 |
| `DB_USER` | `park` | MySQL 用户 |
| `DB_PASSWORD` | `parkpass` | MySQL 密码 |
| `DB_NAME` | `parking` | 数据库名 |
| `JWT_SECRET` | `smart-parking-dev-secret` | JWT 签名密钥 |
| `SEED_ON_START` | - | 设为 `false` 禁用空库自动播种 |

## 数据模型

- **users 用户**：`id, username(唯一), password_hash, name, role(ADMIN/OPERATOR/VIEWER), status`
- **parking_lots 停车场**：`id, code(唯一), name, district, address, total_spaces, status(OPEN/CLOSED)`
- **parking_spaces 车位**：`id, lot_id(FK), code, type(STANDARD/CHARGING/DISABLED/OVERSIZE), status(FREE/OCCUPIED/RESERVED/DISABLED)`，`(lot_id, code)` 唯一
- **vehicles 车辆**：`id, plate_no(唯一), owner_name, phone, vehicle_type(SMALL/LARGE), is_member`
- **parking_sessions 停车记录**：`id, lot_id(FK), space_id(FK), plate_no, enter_time, exit_time, fee_cents, status(PARKED/FINISHED), paid`

## API 一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 健康检查 |
| POST | `/api/auth/login` | 公开 | 登录，返回 JWT |
| GET | `/api/auth/me` | 登录 | 当前用户 |
| GET/POST/PUT/DELETE | `/api/users[...]` | ADMIN | 用户管理 |
| GET | `/api/lots` | 登录 | 停车场列表（`district`/`status`/`keyword`） |
| GET | `/api/lots/:id` | 登录 | 停车场详情 |
| POST/PUT | `/api/lots[...]` | ADMIN/OPERATOR | 建/改停车场 |
| DELETE | `/api/lots/:id` | ADMIN | 删除停车场 |
| GET | `/api/lots/:id/spaces` | 登录 | 某场车位列表 |
| POST | `/api/lots/:id/spaces` | ADMIN/OPERATOR | 新建车位 |
| GET/PUT/DELETE | `/api/spaces[...]` | 登录/操作 | 车位详情与维护 |
| GET/POST/PUT/DELETE | `/api/vehicles[...]` | 登录/操作 | 车辆管理 |
| GET | `/api/sessions` | 登录 | 停车记录（`lotId`/`plateNo`/`status`） |
| POST | `/api/sessions/enter` | ADMIN/OPERATOR | 车辆入场 |
| POST | `/api/sessions/:id/exit` | ADMIN/OPERATOR | 车辆出场 |

## 响应约定

- 成功：`{ "data": ... }`
- 失败：`{ "error": { "message": "..." } }`，配合 HTTP 状态码（400/401/403/404/409/500）
