# Agent 空间 · 让团队的 Agent 一起把事情做完

Agent 空间是个人桌面 agent 的团队形态。每个人身边已经有一个个人 agent：它观察工作，记住偏好和标准，能替主人先做一步。拾遗是这种个人 agent 的一种样子。这个产品要看的是下一步：这些已经了解主人的个人 agent 走进同一个空间，代表各自的主人，和空间助理、专项 agent 一起把事情做完；只有需要人拍板的时候，事情才来到人面前。

这个演示假定那段了解已经发生。页面里的公开档案和判断手册，写下的是桌面 agent 日积月累会学到的工作方式、标准和过往决定。学习过程本身不在这次演示里。

> 你把一件事交进空间，空间助理整理需求、安排执行；
> 遇到分歧，相关成员的个人 Agent 带着各自的标准参与讨论，需要拍板时再来找人；
> 结果留下，确认和打回的理由也能成为团队下一次做事的标准。

这是一个**面向组织提效的多人、多 Agent 协作应用**：

- 一个共享空间，放下团队的任务、资料、产物和决策；
- 每个人带着自己的个人 Agent，表达立场、预审结果、提供判断建议；
- 空间助理负责整理与协调，通用及专项 Agent 负责实际执行。

先读[产品初衷与方向](docs/product-intent.md)，了解我们看到的问题与未来判断；角色分工、产品形态和使用流程见 **[完整产品说明](docs/product-overview.md)**。

## 先跑起来

两条路，看你想体验到哪一步。

| | 不填 API key | 填写 API key |
|---|---|---|
| 你会看到 | **演示模式**。回复由脚本生成，协作流程是真的：整理、执行、讨论、预审、通过或打回、沉淀团队标准 | **真实模型**。agent 会按你填的服务阅读、调用工具、自己判断 |
| 怎么做 | 下面三条命令，不用准备 `.env` | 在项目根目录的 `.env` 填写 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_NAME`，然后同样启动 |

不填 key，直接跑：

```sh
npm install
npm run build
npm start
```

打开 http://localhost:8787 ，点「以林夏的身份看演示」，或用 `lin@demo.local` 登录、名字填林夏。空库会带上一份进行中的「新支付上线」。

要换成真实模型，把下面三项写进 `.env` 后重启。key 放在这个文件里，不要写进源码或提交到仓库。模型名以服务商控制台为准：

| 服务 | `MODEL_BASE_URL` | `MODEL_NAME` 示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-pro` |
| Kimi / Moonshot（国内） | `https://api.moonshot.cn/v1` | `kimi-k2` |
| Kimi / Moonshot（国际） | `https://api.moonshot.ai/v1` | `kimi-k2` |
| 通义千问 / DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.5-air` |

DeepSeek 用 `deepseek-v4-pro` 写长文档，短回复另填 `MODEL_LIGHT_NAME=deepseek-flash`（更快、更便宜）。`deepseek-chat` 是旧别名，请求会落到 flash。想在大约两分钟内走完真实模型的整条流程，再设 `LIGHT_MODE=1`：跳过个人 agent 预审，每个任务最多一次讨论，产物限在约两千字。一次真实执行里，长文档占了大部分时间和费用；执行 agent 现在直接提交产物，不再先写进本地文件再贴一遍。

`COOKIE_SECRET` 在演示模式可以不填，程序会在数据目录生成一把并记住。接上真实模型、给别人用时再改成你自己的随机字符串。

---

## 为什么做它

个人效率提升，不会自动变成组织效率提升。一个人做得更快，事情仍可能卡在信息不同步、等待回复、分歧和返工上。

我们希望 Agent 除了执行，也能承担成员之间的协调工作：让共同信息可读、让分歧有处理过程、让需要人判断的事带着背景和建议来到面前。人保留责任与关键判断，空间留下团队的工作积累。

## 它怎么工作

以「整理一版新支付上线说明」为例，当前流程是：

```text
你提出任务，也可以由明确的空间目标拆出任务
        │
空间助理：整理标题和说明、补验收标准、选负责人和执行 Agent
        │  与已有事项重复时合并
执行 Agent：读资料、使用工具、完成工作
        │
        ├─ 需要取舍 → 发起讨论 → 相关个人 Agent 陈述立场
        │                         → 空间助理汇总，超出权限交给任务负责人定夺
        │                         → 负责人的 Agent 给建议，本人定夺；立场不同的成员会看到
        │                         → 结论可以撤销，原结论留在记录里，不再当作当前结论
        │                         → 结论写回，继续执行
        │
提交产物与自检 → 负责人的个人 Agent 预审 → 本人通过或打回
        │                                      │
        │                               按反馈修改后重新交付
        │
结果、决策和经确认的团队标准留在空间里
```

- **空间不必只有一个项目**：可以承载有明确目标的项目，也可以长期服务于一个团队；目标可选，人随时可以提出新任务。
- **责任与执行分开**：任务有负责的人，也有实际执行的 Agent。个人 Agent 不需要具备所有专业能力。
- **共享事实，保留个人边界**：空间保存公共资料、结果和标准；个人 Agent 的公开档案用于协作，判断手册用于为主人提供建议。
- **交付可以打回**：反馈会带回执行过程；有普遍价值的理由可以由人保存为团队标准，后续 Agent 据此工作。
- **分歧有出口**：讨论结论写回任务。需要人取舍时，交给任务负责人定夺，立场不同的成员也会看到。结论可以撤销，原话留在记录里，避免只留下讨论记录。
- **简单执行不必重复审批**：有限次数的定时任务，在执行记录数量符合预期且交付自检全部通过时自动完成；记录异常或检查失败则保留人工确认。这仍不等同于独立验证执行效果。
- **人走，空间的积累留下**：支持责任交接，共享资料、决策和团队标准继续留存。

## 现在可以看到什么

| 页面 | 可以做什么 |
|---|---|
| 待处理 | 查看跨空间需要本人确认或定夺的事项，以及个人 Agent 的建议 |
| 空间概览 | 查看正在推进的事、待协调的讨论、成员与 Agent 活动 |
| 任务 | 查看负责人、执行进展、交付产物和处理过程 |
| 讨论 | 查看各方立场、总结、定夺与写回结果 |
| 资产 | 管理产物、资料、Skills、团队标准和空间记忆 |
| 我的 Agent | 配置公开档案和个人判断手册 |

## 当前边界

这是一个可运行的产品原型，完整产品说明包含尚未实现的目标能力。

- 个人 agent 能代表主人，是因为它在进空间之前已经了解这个人。演示用公开档案和判断手册写下这些理解，代替桌面 agent 本来会学到的记忆；学习过程不在这次演示里。
- 主动信息同步、求助路由、跨空间协调仍待完善。
- 目前任务执行和交付流程最完整，任务之外的持续协作还需要补齐。
- 从既有协作工具导入成员和资料、接入桌面端个人 Agent 尚未实现。
- Agent 自检和个人 Agent 预审仍是模型判断，不能视为结果正确的保证。

## 模型与 API key 配置

不填 key 就会进入上面的演示模式。下面只在你要接真实模型时需要。

当前版本由部署者在服务端配置模型密钥，页面尚不支持每位用户分别填写自己的 key。运行这个实例产生的模型调用费用，由服务端配置的密钥所属账户承担。

密钥放在项目根目录的 `.env`，不绑定某一家服务商。对方只要提供 OpenAI 兼容的 Chat Completions 接口，就填写 key、base URL 和模型名。`.env` 已被 Git 忽略。真实 key 只留在这一个文件里，不要写进源码、截图、共享文档或提交到仓库。

1. 将 `.env.example` 复制为 `.env`。
2. 在 `MODEL_API_KEY=` 后面填入你自己申请的 API key。
3. 填写 `MODEL_BASE_URL` 和 `MODEL_NAME`。base URL 停在版本前缀，一般以 `/v1` 结尾。常见组合见上面的表。
4. 给别人用时设置 `COOKIE_SECRET`，然后重启。换 key 或换模型后也要重启。

只填了 key、却没填地址或模型名时，启动会指出缺哪一项。`DEMO_MODE=1` 可以在已经填了 key 时仍强制走演示模式。

自定义 base URL 会按 OpenAI 兼容接口连接，一般只填上面三个变量。`MODEL_PROVIDER` 可以不写；只有在使用 harness 自带的供应商目录、并且不填 `MODEL_BASE_URL` 时才需要它，例如 `openai`、`moonshotai`、`anthropic`。

### 从旧变量迁移

只配置了 `DEEPSEEK_API_KEY` 的旧 `.env` 可以继续用，服务仍走 DeepSeek 官方接口，模型默认 `deepseek-flash`。这时 `MODEL_BASE_URL` 的含义和以前一样：它覆盖 DeepSeek 的 Anthropic Messages 地址（测试里的脚本化模型也走这条路径）。

建议改成 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_NAME` 后重启。一旦设置了 `MODEL_API_KEY` 或 `MODEL_NAME`，同一个 `MODEL_BASE_URL` 就按 OpenAI Chat Completions 调用；DeepSeek 请用 `https://api.deepseek.com` 和 `deepseek-v4-pro`（`deepseek-flash` 更快、更便宜）。`DSH_MODEL` 在 `MODEL_NAME` 未设置时仍作为模型名。`DSH_PROVIDER` 只在没有这些新变量时生效。启动时如果仍在读旧变量，会打一行提示。

## 本地运行与开发

<details>
<summary>展开安装、演示数据、配置与验证说明</summary>

## 运行

需要 Node.js 24.9 或更高版本。不填模型 API key 就是演示模式；要接真实模型时，每位部署者使用自己的 key，项目不附带个人密钥。

```sh
npm install
npm run build
npm start               # http://localhost:8787 ，不填 key 就是演示模式
```

用 Docker：

```sh
MODEL_API_KEY=sk-... MODEL_BASE_URL=https://api.openai.com/v1 MODEL_NAME=gpt-4.1 COOKIE_SECRET=$(openssl rand -hex 32) docker compose up -d
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
| `MODEL_API_KEY` | 空 | 留空进入演示模式。要真实模型时，和下面两项一起填 |
| `MODEL_BASE_URL` | 空 | OpenAI 兼容接口地址 |
| `MODEL_NAME` | 空 | 长文档用的模型名。DeepSeek 用 `deepseek-v4-pro` |
| `MODEL_LIGHT_NAME` | 与 `MODEL_NAME` 相同 | 整理、讨论、预审等短回复。DeepSeek 用 `deepseek-flash` |
| `LIGHT_MODE` | 关 | 设为 `1` 时跳过预审、每个任务最多一次讨论、产物更短 |
| `MODEL_PROVIDER` | 空 | 一般留空。不填 base URL 时，用来选择 harness 内置供应商 |
| `DEMO_MODE` | 空 | 设为 `1` 时，即使填了 key 也用脚本回复 |
| `COOKIE_SECRET` | 演示模式自动生成 | 生产环境必须修改 |
| `ACCESS_CODE` | 空 | 登录访问码 |
| `DEEPSEEK_API_KEY` | — | 旧变量。只设置它时仍走 DeepSeek 官方接口 |
| `DSH_MODEL` | 旧部署为 `deepseek-flash` | 旧变量。`MODEL_NAME` 未设置时作为模型名 |
| `DSH_PROVIDER` | 旧部署为 `deepseek-official` | 旧变量。没有新的 `MODEL_API_KEY` / `MODEL_NAME` / `MODEL_PROVIDER` 时才生效 |
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
