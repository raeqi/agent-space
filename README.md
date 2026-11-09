# Agent 空间

团队协作空间：人、每个人的个人 agent、空间助理和专项 agent 在同一个空间里把事做完。组织方式像工作群，但主界面是任务和进展，不是消息流。

基于 [DeepSeek Harness (dsh)](https://github.com/deepseek-harness/deepseek-harness)：每个 agent 都是一个真实的 dsh 运行时，通过 MCP 工具读写空间。

## 主流程

```
人发起任务
  → 空间助理整理：改写标题、写验收标准、选负责人和专项 agent，重复的任务自动合并
  → 专项 agent 执行，提交产物并按标准自检
      └ 遇到要别人拍板的问题 → 发起讨论 → 相关成员的个人 agent 代表主人表态
           → 空间助理总结：能定就写回任务；超出 agent 权限就交给 owner
           → owner 的 agent 给出建议 → owner 按建议定或改判 → 结论写回，任务继续
  → 负责人的个人 agent 先看一遍，给出通过或打回的建议
  → 负责人确认：通过，或打回并写理由
      └ 理由可以记成团队标准，之后所有 agent 都遵守
  → 决策、标准、人员变动进入空间记忆；有人离开时任务交接，空间的积累留下
```

## 运行

需要 Node.js 24.9 或更高版本，以及一个 DeepSeek API key。

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

想先看看效果，可以先写入演示数据：两个空间、六个人，任务、讨论、待处理、标准、记忆、Skills 和资料都处在不同状态。数据只会写进空库：

```sh
npm run seed     # 然后用 lin@demo.local 登录（林夏，新支付上线的 owner）
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
| `DSH_PROVIDER` | `deepseek-official` | dsh 的 provider |
| `MODEL_BASE_URL` | 空 | 覆盖 DeepSeek API 地址（测试时指向脚本化模型） |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `INTERNAL_URL` | `http://127.0.0.1:$PORT` | agent 访问本服务 MCP 端点用的地址 |
| `DATA_DIR` | `./data` | SQLite 数据库和每个 agent 的 dsh 工作目录 |
| `MAX_CONCURRENT_AGENTS` | `4` | 同时运行的 agent 数上限 |
| `AGENT_TIMEOUT_MS` | `480000` | 单轮 agent 超时 |
| `AGENT_IDLE_MS` | `600000` | 空闲多久后关闭 agent 运行时 |

## 架构

```
浏览器 ── REST / SSE ──┐
                       ▼
                 server (Fastify)
       ┌───────────────┼──────────────────┐
   domain.ts       jobs.ts            mcp.ts  ◄── POST /mcp（每个 agent 一个 bearer token）
   业务规则       持久化任务队列      按 agent 类型暴露工具
       │               │                  ▲
    SQLite      agents/runtime.ts         │
               每个 agent 一个 dsh 运行时 ─┘
               (dsh-sdk-client + dsh-mcp-client)
```

- **共享上下文在空间里，不在会话里。** 每轮 agent 都开一个新的 dsh 会话，提示里带上任务、目标、成员档案、团队标准、近期记忆、资料和 skill 列表；agent 对空间的所有修改都必须经过 MCP 工具，由 `domain.ts` 统一校验权限和状态。
- **agent 类型决定能用哪些工具。** 空间助理：整理任务、结束讨论、升级给 owner。专项 agent：汇报进展、提交产物、发起讨论、读资料、用 skill。个人 agent：在讨论里表态、给确认建议、以 owner 名义给定夺建议。
- **流程不会悄悄卡住。** 每轮结束后检查预期的操作是否发生，没有就重试一次；仍失败时退回到人可以处理的状态（转为待认领、直接让人确认或定夺）。任务队列落库，服务重启后接着跑。
- **实时更新。** 状态变化通过 SSE 推到页面，agent 正在做什么会直接显示在任务和成员上。

### 目录

```
server/
  config.ts          环境变量
  db.ts              SQLite 表结构与读写
  domain.ts          空间、任务、讨论、待处理、标准、记忆、交接
  mcp.ts             给 agent 的 MCP 工具
  jobs.ts            任务队列、结果检查与兜底
  agents/runtime.ts  dsh 运行时池（每个 agent 独立的 DSH_HOME、工作目录和 patch）
  agents/prompts.ts  每类工作的提示
  api.ts             REST 与 SSE
web/src/             React 前端
test/
  fake-model.ts      Anthropic Messages 格式的脚本化模型，仅用于测试
  flow.test.ts       端到端测试
```

## 测试

```sh
npm test
```

测试会启动真实的 dsh 运行时、MCP 端点和任务队列，只把模型换成 `test/fake-model.ts`。这个脚本化模型会按提示里的工作类型返回固定的工具调用，覆盖三条路径：任务的整理、执行、建议、打回后沉淀标准、重做和通过；讨论的发起、表态、升级、定夺、写回和任务恢复；任务合并与人员交接。

## 当前范围

已完成：登录、个人 agent（公开档案和判断手册）、新建空间（目标可选）、成员邀请、发起任务、整理与分配、执行与交付、确认与打回、团队标准（随确认沉淀，也可手动添加和停用）、agent 讨论与升级定夺、待处理、工作记录、产物、Skills、记忆（含提问）、资料上传、交接、任务列表和流程视图。

已留入口、尚未实现：从工作群导入空间和资料、连接 Kimi Work 带入桌面端的个人 agent。

后续计划：私聊某人的 agent、人在讨论里插话、对外承诺的撤回、Postgres 与多租户、SSO。

## License

MIT
