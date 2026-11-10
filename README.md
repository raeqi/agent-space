# Agent 空间

**面向组织提效的多人、多 Agent 协作空间。**

人与各自的个人 Agent 在共享上下文中参与工作，由空间 Agent 协调推进，结合通用及专业 Agent 的执行能力，完成从需求提出、信息同步、分歧处理到结果交付的全过程。

让团队在成员不必始终在线、反复解释背景和人工协调的情况下，持续把事情做成。

## 产品文档

- **[完整产品说明](docs/product-overview.md)**：产品初衷、问题判断、目标、角色分工、共享上下文、核心流程和衡量指标。
- [产品初衷与方向](docs/product-intent.md)：问题、未来判断与产品目标。

产品文档描述目标形态；当前已实现的能力见下方「当前范围」。

## 为什么做这个产品

个人效率的提升，不会自动变成组织效率的提升。执行变快以后，信息差、等待回复、分歧和反复返工，仍然可能阻塞整个团队。

Agent 空间希望让 Agent 承担更多协作事务：维护共同上下文、同步相关变化、协调分工与分歧，并在需要时把问题和依据交给相应的人。人保留责任、授权和关键判断，工作经验则留在空间里，持续影响后续协作。

## 如何协作

| 角色 | 职责 |
|---|---|
| 人 | 提出需求、补充信息、确认结果、作出关键判断 |
| 个人 Agent | 带入主人的标准与立场，参与讨论、预审交付、提供建议 |
| 空间 Agent | 整理和合并任务、协调分工、组织讨论、维护共同上下文 |
| 通用及专业 Agent | 实际执行工作、报告进展、提交结果 |

空间可以服务于有明确目标的项目，也可以长期承载团队的日常协作。目标可选，任务也可以由人随时提出。

```text
提出需求或明确目标
        ↓
空间助理整理需求、补全验收标准、协调分工
        ↓
执行 Agent 开展工作 ← 讨论形成结论后继续推进
        ↓                       ↑
提交结果                 遇到分歧，相关个人 Agent 参与
        ↓                       ↓
核验结果或交给负责人确认     超出权限时交给 owner
        ↓
反馈、决策与标准沉淀到空间
```

## 当前范围

已支持：个人 Agent 的公开档案和判断手册、目标可选的空间、成员邀请、任务整理与分配、执行与交付、确认与打回、讨论与升级定夺、团队标准、空间记忆、资料、Skills、交接和实时进展。

仍在探索：主动信息同步、求助路由、跨空间协调，以及个人 Agent 对主人的持续理解。更多目标能力见[完整产品说明](docs/product-overview.md)。

<details>
<summary>展开当前能力与后续计划</summary>

已完成：登录、个人 agent（公开档案和判断手册）、新建空间（目标可选）、成员邀请、发起任务、整理与分配、执行与交付、确认与打回、团队标准（随确认沉淀，也可手动添加和停用）、agent 讨论与升级定夺、待处理、工作记录、产物、Skills、记忆（含提问）、资料上传、交接、任务列表和流程视图。

已留入口、尚未实现：从工作群导入空间和资料、连接 Kimi Work 带入桌面端的个人 agent。

后续计划：私聊某人的 agent、人在讨论里插话、对外承诺的撤回、Postgres 与多租户、SSO。


</details>

## 本地运行与开发

<details>
<summary>展开安装、演示数据、配置与验证说明</summary>

## 运行

需要 Node.js 24.9 或更高版本。每位部署者必须配置自己的模型 API key，项目不附带个人密钥。

```sh
cp .env.example .env    # 填入 DEEPSEEK_API_KEY 和 COOKIE_SECRET
npm install
npm run build
npm start               # http://localhost:8787
```

用 Docker：

```sh
DEEPSEEK_API_KEY=sk-... COOKIE_SECRET=$(openssl rand -hex 32) docker compose up -d
```

想先看看效果，可以先写入演示数据：四个空间、六个人，任务、讨论、待处理、标准、记忆、Skills 和资料都处在不同状态。数据只会写进空库：

```sh
DATA_DIR=./data-demo npm run seed
DATA_DIR=./data-demo npm start
# 用 lin@demo.local 登录
```

开发时，`npm run dev` 启动后端（文件变动自动重启），`npm run dev:web` 启动带热更新的前端（http://localhost:5173，`/api` 代理到 8787）。

登录只需要邮箱和名字，第一次登录时自动创建账号和个人 agent。设置 `ACCESS_CODE` 后，登录时还要输入访问码。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | 必填 |
| `COOKIE_SECRET` | 开发用默认值 | 生产环境必须修改 |
| `ACCESS_CODE` | 空 | 登录访问码 |
| `DSH_MODEL` | `deepseek-flash` | 所有 agent 用的模型 |
| `DSH_PROVIDER` | `deepseek-official` | 模型服务路由 |
| `MODEL_BASE_URL` | 空 | 覆盖 DeepSeek API 地址（测试时指向脚本化模型） |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `INTERNAL_URL` | `http://127.0.0.1:$PORT` | agent 访问本服务 MCP 端点用的地址 |
| `DATA_DIR` | `./data` | 数据库和运行目录 |
| `MAX_CONCURRENT_AGENTS` | `4` | 同时运行的 agent 数上限 |
| `AGENT_TIMEOUT_MS` | `480000` | 单轮 agent 超时 |
| `AGENT_IDLE_MS` | `600000` | 空闲多久后关闭 agent 运行时 |

## 开发与验证

前端位于 `web/src/`，服务端位于 `server/`。共享状态持久化到数据库，页面通过实时事件更新。

```sh
npm run typecheck
npm test
```

测试使用脚本化模型，不使用个人 API key。


</details>

## License

MIT
