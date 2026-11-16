# cnb-delivery —— CNB（cnb.cool）版交付插件

对标 `plugins/delivery/`（GitHub 版）：一个 PR 从打上 `deliver` 标签到线上生效的
全程自动化——审查、检查、合并、发布、健康核实。

## 与 GitHub 版的核心差异

GitHub 版是「外部状态机」：多方并发写 GitHub，只能靠轮询 + CAS + 回读防竞态
（delivery.ts 一半代码在干这个）。CNB 把门禁内建进了分支保护，架构反转：

| 环节 | GitHub 版（delivery.ts） | CNB 版（本插件） |
|---|---|---|
| 审查记录 | commit status（`review` context） | `POST /pulls/{n}/reviews`（approve / request_changes + 行级评论） |
| 合并门禁 | 靠 status context + 手写安全序列 | 分支保护 `required_approved_review_count` / `required_status_checks`，平台强制 |
| 合并时序 | 外部 CAS + 回读 + auto-merge 管理 | PR 流水线末尾 `git:auto-merge` 内置步骤，平台保证时序 |
| CI 判定 | Actions runs/jofs API | `GET /build/status/{sn}` + `/build/logs` |
| 事件进入中台 | GitHub webhook → hub | 项目 `.cnb.yml` 中继流水线（PR 事件 → curl hub）+ 仓库动态 API 按小时轮询兜底 |
| 审查执行 | hub 自带 Codex/命令 | 二选一：hub 自己的 agent，或 CNB NPC（`POST /build/start` + `api_trigger_*` + `npc:go`） |

CNB 上没有、也不需要的东西：commit status 写接口（reviews 更对路）、
合并 sha CAS（合并时机由平台流水线决定，无外部竞态）、出站 webhook（中继代替）。

## 事件流

```
PR 打 deliver 标签 / 评论 @交付
  → 项目 .cnb.yml 中继流水线（pull_request* 事件）curl hub /webhook/cnbd
  → plugins/cnb-delivery/source.ts 验签转事件 → hub 规则派活
  → hub agent（或 NPC）审查：
      有问题 → POST review: request_changes + 行级评论（分支保护自动挡合并）+ 飞书卡片
      通过   → POST review: approve
  → PR 检查流水线通过 + 评审数达标
  → git:auto-merge 自动合并
  → push main 触发部署流水线
  → hub 轮询 build/status + 健康接口核实线上版本 → 飞书汇报
  → 兜底：GET /events/{repo}/-/{小时} 轮询补漏（中继丢失时）
```

## 接入配置

**中台侧** rules.json：

```json
"sources": { "cnbd": { "name": "CNB交付", "adapter": "cnb-delivery" } }
```

**secrets.env**：`AGENT_AUTOLOOP_SECRET_CNBD=<随机串>`（中继流水线用同一串放 env）。

**CNB 项目侧** `.cnb.yml`：见 `relay.cnb.yml` 样例（pull_request* 事件中继 +
合并后部署流水线），分支保护配置 required_status_checks + 评审数，
流水线末尾挂 `git:auto-merge`。

**项目 ops/delivery.json**（结构对齐 GitHub 版，见 project.ts）：
仓库、检查流水线名、审查策略（免审模式/审查员）、健康检查、内部文档路径模式。

## 里程碑

- **M1 ✅** 事件链路——source.ts 验收中继回调、cnb.ts API 客户端、relay 样例（`ee9bf5d`）
- **M2 ✅** 审查回写——review.ts 把审查结论转 reviews（含行级评论），免审判定（`5d2896c`）
- **M3 ✅** 状态机 delivery.ts——回读驱动、门禁判定、squash 合并、发布核实与标注（`48865a4`）
- **M4 ✅** NPC 路线——npc.ts 用 `api_trigger_` + `npc:go` 召唤平台审查，head 去重防重复派出，标记认领（`1946781`）
- **M5 ✅** 兜底轮询——poll.ts 按小时拉仓库动态，归一成 relay 同形事件交回幂等管道（动态接口响应无 schema，鸭子类型保守归一，待真实 token 校准）

## 接线（已在本机 hub+worker 验证，2026-11）

实际部署好的形态（hub = Docker 容器 agent-autoloop，`AGENT_AUTOLOOP_HOME=/data`；worker = 宿主机 darren-pc）：

1. **插件就位（两处都要）**：hub 拷进卷内 `/data/plugins/cnb-delivery/`，worker 拷进
   `~/.agent-autoloop/plugins/cnb-delivery/`（HOME/plugins 优先于 app 自带，这是官方插件挂载点；插件自包含，不引上级目录）。
2. **rules.json（hub 的 /data/rules.json）三处**：
   - `"sources": { "cnbd": { "name": "CNB交付", "adapter": "cnb-delivery" } }`；
   - `"agents": { "cnbd": { "name": "CNB 交付", "worker": "darren-pc", "use": "command",
     "command": ["node", "C:/Users/darren/.agent-autoloop/plugins/cnb-delivery/run.ts", "rich/test/autoloop_cnb"], "timeout": 35 } }`；
   - `"rules"` 加 `{ "name": "CNB 交付", "when": { "source": "cnbd", "types": ["pull_request", "pull_request.*", "push"] },
     "to": "cnbd", "cwd": "C:/Users/darren", "parallel": 2 }`——**cwd 必填**（少了它 reloadRules 报「规则缺少 cwd」整份规则不生效）。
3. **webhook 密钥**：hub 容器由 compose 的 `env_file: .env` 注入，项目根 `.env` 写
   `AGENT_AUTOLOOP_SECRET_CNBD=<随机串>` 后 `docker compose up -d` 重建。取值用
   `docker exec agent-autoloop printenv AGENT_AUTOLOOP_SECRET_CNBD`（容器内值是唯一权威）。
4. **中继回传地址**：`POST http://<hub>:3350/v1/in/cnbd`，header `x-cnb-token` 同上。
   验证：无/错 token → 401「验签没过」；对 token → 200，同 body 重放 `duplicate:true`（幂等）。
5. **worker 侧 API 令牌**：worker 会把自身环境透传给 run.ts，所以 `CNB_TOKEN` 放 Windows 用户环境变量
   （`setx CNB_TOKEN <PAT>`）后重启计划任务 agent-autoloop。
6. **审查执行者二选一**（run.ts 按优先级自动选）：环境 `CNB_NPC_EVENT`（+可选 `CNB_NPC_ROLE`）走平台 NPC；
   否则项目 ops/delivery.json 的 `review.command`；都没有则拒单退标签。push 事件（subject 无编号）自动走发布核实。
7. **兜底轮询（可选，未接）**：`node run.ts` 之外另有 `pollOnce(cnb, repo)` 库函数，等真实 PAT 校准响应形状后再挂 cron。
8. **试点仓库**：`rich/test/autoloop_cnb` main 放 `ops/delivery.json`（shape 见 project.ts），
   `.cnb.yml` 加 relay 流水线（模板 relay.cnb.yml，token 用第 3 步的值），分支保护
   required_status_checks=check、评审数 ≥1。

已实测打通：POST /v1/in/cnbd → 事件入总线 → 规则路由 → worker 起进程 run.ts → context.json 正常解析 →
卡在预期位置（缺 CNB_TOKEN）。待 token 到位后填第 5/8 步。

## 已知约束（来自 CNB 文档与 OpenAPI 实测）

- PR 打标签**不触发**流水线事件（事件只有 pull_request/update/approved/
  changes_requested/comment/mergeable/merged）→ 触达手段：`pull_request.update`
  全量上报 hub 过滤，或 PR 评论 `@NPC`（`pull_request.comment@npc` 原生触发）
- 评论数超过 100 条后 @NPC 不再触发 → 长期活跃 PR 走中继路线
- `forbid_approve_pull_created_by_own_npc`：NPC 工作模式自建的 PR 不能自审自批
- 合并接口无 sha CAS：hub 侧合并前回读 `blocked_on`/`mergeable_state`，合并后回读 `is_merged`
- `commit-statuses` 只有 GET：审查状态全部走 reviews 语义
