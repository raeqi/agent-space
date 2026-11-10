# Agent 空间

团队协作空间：人、每个人的个人 agent、空间助理和专项 agent 在同一个空间里把事做完。面向组织提效，在共享上下文中协调信息、分歧与执行，推动工作持续完成。


## 产品文档

- [产品初衷、问题、未来判断与目标](docs/product-intent.md)

## 主流程

任务有三个来源：人发起；空间助理按目标拆解（设了目标的空间，第一批任务自动拆出，做完一批再拆下一批）；外部事件触发（`POST /api/hooks/spaces/:id/events`，带空间的 token，入口在「成员」页）。

```
任务进来（人发起 / 按目标拆解 / 事件触发）
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

## 当前范围

已完成：登录、个人 agent（公开档案和判断手册）、新建空间（目标可选）、成员邀请、发起任务、整理与分配、执行与交付、确认与打回、团队标准（随确认沉淀，也可手动添加和停用）、agent 讨论与升级定夺、待处理、工作记录、产物、Skills、记忆（含提问）、资料上传、交接、任务列表和流程视图。

已留入口、尚未实现：从工作群导入空间和资料、连接 Kimi Work 带入桌面端的个人 agent。

后续计划：私聊某人的 agent、人在讨论里插话、对外承诺的撤回、Postgres 与多租户、SSO。

## License

MIT
