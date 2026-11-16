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

- **M1**（本目录已有）：事件链路——source.ts 验收中继回调、cnb.ts API 客户端、relay 样例
- **M2**：审查回写——review.ts 把审查结论转 reviews（含行级评论），免审判定
- **M3**：合并与发布核实——state.ts 轮询 build/status + 健康接口 + commit-annotations 存发布版本
- **M4**：NPC 路线——npc.ts 用 `POST /build/start`（`api_trigger_` + `npc:go`）召唤平台内审查，
  对比自研审查的成本/质量后二选一
- **M5**：仓库动态轮询兜底（poll.ts），防中继丢失

## 已知约束（来自 CNB 文档与 OpenAPI 实测）

- PR 打标签**不触发**流水线事件（事件只有 pull_request/update/approved/
  changes_requested/comment/mergeable/merged）→ 触达手段：`pull_request.update`
  全量上报 hub 过滤，或 PR 评论 `@NPC`（`pull_request.comment@npc` 原生触发）
- 评论数超过 100 条后 @NPC 不再触发 → 长期活跃 PR 走中继路线
- `forbid_approve_pull_created_by_own_npc`：NPC 工作模式自建的 PR 不能自审自批
- 合并接口无 sha CAS：hub 侧合并前回读 `blocked_on`/`mergeable_state`，合并后回读 `is_merged`
- `commit-statuses` 只有 GET：审查状态全部走 reviews 语义
