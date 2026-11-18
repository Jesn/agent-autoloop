# cnb-delivery — CNB 平台的自动交付插件

把 CNB 仓库的 PR 交付流程交给 agent-autoloop 中台驱动：**打开感知 → 审查（免审/代理审查/作者声明免审）→ 合并门禁 → 发布核实 → shipped 标注**，外加一套 PR 评论指令通道（retry / skip-review / rollback / build / status）。

插件自包含（不引上级目录），两处部署：
- hub 容器：`/data/plugins/cnb-delivery/`（source.ts 提供事件源适配）
- worker 宿主：`~/.agent-autoloop/plugins/cnb-delivery/`（run.ts 是中台派活的入口命令）

## 架构

```
CNB 流水线(.cnb.yml 中继)──webhook──▶ hub(/v1/in/cnbd)──rules──▶ worker──▶ run.ts
     ▲                                    │ facts/events                       │
     │                                    ▼                                    ▼
     └── poll.ts 兜底轮询(NDJSON)    状态机每轮重读 CNB 实况 ◀────────────  CNB API
                                                                          (cnb.ts)
```

- **无自有状态**：每轮 deliverOnce 都从 CNB 回读 PR 实况再行动；head 漂移、标签被撤、已被别人合并都安全。
- **门禁分工**：检查流水线在平台跑，状态机等它终态；合并用 Owner 身份 `force` 过自批禁令，风险由 gate 的 blocked_on/冲突检查先行把关。

## 文件

| 文件 | 作用 |
|---|---|
| `run.ts` | 中台派活入口：解析 context 事件 → push 走 `shipSha` 发布核实 / PR 走 `deliverOnce` 状态机 / `#N@cmd` subject 走 `commandReceipt` 指令 |
| `source.ts` | hub 事件源：中继 body → 总线事件；`/autoloop` 评论归到独立 subject（`repo#N@cmd@哈希`），不挂状态机的退避 run，同评论重放幂等去重 |
| `delivery.ts` | 状态机与指令处理器：`deliverOnce`（标签协议→审查→门禁→合并→发布）、`shipSha`（构建核实+shipped 标注）、`commandReceipt` |
| `review.ts` | 审查判定与结论提交（结论用 comment 事件，见下方实测差异） |
| `npc.ts` | 平台 NPC 审查路线（CNB_NPC_EVENT 派单、构建分类） |
| `poll.ts` | 兜底轮询：CNB 事件 NDJSON（北京时区小时目录），中继丢事件时补漏 |
| `project.ts` | 仓库 `ops/delivery.json` 的设置读取与校验 |
| `relay.cnb.yml` | 用户仓库 `.cnb.yml` 的中继片段模板（PR/update/comment/push 四段） |

## PR 评论指令（/autoloop）

在 PR 里评论（CNB 评论触发流水线 → 中继 → hub）：

| 指令 | 权限 | 行为 |
|---|---|---|
| `/autoloop retry` | 任何人 | 新起一轮状态机（指令走独立 subject，不被退避 run 压住） |
| `/autoloop skip-review <理由>` | PR 作者或 admin_merge | 写入绑定提交号的免审声明评论 → 状态机识别 exempt 免审；推新提交后声明自动作废 |
| `/autoloop rollback <sha>` | admin_merge（未配置时退到 PR 作者） | 直接触发回滚流水线：startBuild 内联 YAML 在 main 头 revert 目标提交并推送，push 链路自动接力出新 shipped 标注；目标提交打 `rollback-triggered` 标注 + PR 评论回执带构建号 |
| `/autoloop build <需求>` | admin_merge（同 rollback 名单） | 需求→出货全自动：派工作模式 CodeBuddy 从零实现（建分支/写码/自主开 PR），NPC 作者的 PR 自动补交付标后进入审查-合并-发布链路；实现见 `startNpcDev` + `api_trigger_deliver_build` 流水线段 |
| `/autoloop status` | 任何人 | 只读盘点交付进度并回评论：PR 状态/阶段（已发布/已合并/审查结论/修复中）/审查构建/修复轮数/台账与回滚记录；不碰状态机、不触发构建，merged/closed 也能查。已知局限：squash 合并的 shipped 标注在合并提交上（不在 PR head），已合并的 PR 盘点会提示去 main 提交看标注 |
| `/autoloop cross-review` | 任何人 | 手动追加一轮交叉复核：按首轮结论自动选模式（approve→找岔挑漏 challenge，打回→逐条核实 findings verify）；结论与本轮对照，一致自动定夺，分歧标 `cross-review-split` 转人工仲裁 |

执行结果都回复到 PR 评论里留痕。同一指令重放被幂等挡（防刷，带不同尾注如 `status 2` 可重新触发）。

### 交叉复核（玩法 B 前置：第二只眼）

配置 `review.crossReview`（`off` 默认 / `on-reject` 打回才复核 / `always` 每轮都复核），PR 打 `cross-review` 标签单点强制。首轮结论回来后自动派第二只眼（`api_trigger_deliver_cross` 流水线段，与审查/修复同族）：打回后 verify 模式逐条核实 findings 是否成立，approve 后 challenge 模式专门挑漏。两轮一致自动定夺（CR+CR 照旧进修复，approve+approve 照旧合并）；分歧不猜谁对，标 `cross-review-split` 转人工仲裁（评论里带双方意见折叠原文）。

**实测（PR #14，timeout=-9 全自动链路）**：首轮审查 CR「交付审查」→ 自动派交叉复核 verify → 复核确认「成立。核实依据：…timeout = 3 改为 timeout = -9」（CR）→ 两轮一致 → NPC 修复第 1 轮把 timeout 修回 3 → 新 head 重审 approve → squash 合并 → push 中继发布成功 → `shipped` 台账标注落 main。人工干预只有 4 条 `/autoloop retry` 推进评论。

同版本修复防重：修复轮数按**当前 head** 计数（同 head 最多 fixRounds 次，跨 PR 不互相挤占；全局计数会因历史 PR 用光名额）。

### 网络鲁棒性

CNB API 调用（`api()`）内置传输层重试（fetch failed/超时自动重试 2 次，指数退避）；业务错误（4xx/5xx）照旧抛给门禁/退避逻辑处理。宿主机到 api.cnb.cool 的连接偶发重置时，单次失败不再导致整轮 run 失败。

## 仓库接线（ops/delivery.json）

```json
{
  "repo": "owner/name",
  "internal": ["docs/**", "ops/**"],          // 命中即免审
  "admin_merge": [],                          // 回滚/管理操作名单；空则退到 PR 作者
  "check": {}, "ship": { "pipeline": "push" },
  "review": { "points": "ops/review.md", "trusted": ["..."], "agents": {} }
}
```

`.cnb.yml` 合入 relay.cnb.yml 四段（pull_request / pull_request.update / pull_request.comment / push）；webhook 密钥走 hub 容器的 `AGENT_AUTOLOOP_SECRET_CNBD`，中继地址 `POST <hub>/v1/in/cnbd`。

## 实测差异（rich/test/autoloop_cnb 试点，代码已按此校准）

- **CNB API 一律要 `Accept: application/vnd.cnb.api+json`**，否则 406（GET 也一样；cnb.ts 已内置）。
- **没有 PR 编号环境变量**：`CNB_PULL_INDEX` 不存在；编号取 `${CNB_EVENT_URL##*/}`。`CNB_COMMIT` 在 PR 管道里就是源分支头 sha。
- **build/logs 的 sha 过滤参数不生效**且返回的 `sha` 是 12 位短前缀 → 拉回 20 条由调用方前缀匹配；事件 API 是 NDJSON、路径 `/events/{repo}/-/{yyyy-MM-dd-H}`（北京时间小时）。
- **插件令牌（挂在仓库 Owner 名下）是 Owner 的 NPC**，两处被自批禁令挡（2003024，文案都写成 approve）：
  - `PUT /pulls/{n}/merge`：`force: true`（Owner 可用）可过；
  - **PR 评审 approve**：`force` 也绕不过（历次 run 失败的真正根因）→ 通过/免审结论改用 **comment** 提交，marker 机制不变；request_changes 不受限。
- **squash 合并 `commit_title` 必填**（缺了报 400），按平台默认格式补 `「{title} (#N)」`。
- **检查流水线未跑完时 merge 也报 2003024** → gate 转 waiting，下一轮重试自然过。
- **`blocked_on: "unblocked"` = 无阻塞**；真正的阻塞值是 status_check / waiting_review / code_conflict 等，判断时必须显式排除。
- **PR 对话评论**在 `/pulls/{n}/comments`（`author.username`，CNB 风格），不是 issues 端点。
- **投递语义**：事件 sent 给 worker 后 worker 被杀 → 该事件永久不补投；可靠做法是 cancel 卡住的 run（owner 密钥在 hub config.json，`POST /v1/runs/<id>/cancel`）后重发新事件。
- **diff 列表字段是 `filename`** 不是 Gitea 的 `path`：cnb.files() 已做归一，否则列表恒空、一切 PR 误判 docsOnly 免审（试点曾因此漏审代码 PR）。
- **NPC 审查（CodeBuddy）实测要点**（PR #10 全链路验证）：
  - 事件段要挂在 **`$:` 通配 key** 下——startBuild 的 branch 传 PR 源分支（流水线 fetch branch 才能 checkout PR head），分支 key 只匹配同名分支，挂 main: 下会报 CONFIG_EVENT_EMPTY；
  - 派单必须带 `branch` + `sha`（不带 branch 会拿 main 找 PR head → `reference is not a tree`）；
  - **平台系统 NPC 的 approve 不受自批禁令**（插件 token 才是 Owner NPC）→ 状态机认领 marker 后正常放行；
  - marker 防串版生效：PR head 一变旧 marker 作废、自动重派；
  - npc:go 的 `userPrompt` 必填（缺了构建直接失败），用 env `DELIVERY_USER_PROMPT` 注入。
- **NPC 自动修复（workMode）实测要点**（PR #11 全链路验证）：
  - 修复事件 = 审查事件尾部 `review`→`fix`（`api_trigger_deliver_fix`）；不配这段则 request_changes 照旧退回人工；
  - `pr.head.ref` 可能带 `refs/heads/` 前缀（各端点口径不一），startBuild 会自己再加一层——必须先规范化（plainBranch），否则 fetch `refs/heads/refs/heads/x` not found；
  - workMode 的语义：NPC token 默认只读，开启后可写码/推分支/按评审意见修改（PR #11 中 CodeBuddy 自主改 app.txt、push 源分支、评论修复说明，全部自动）；
  - 打回后的重开链路：verdict 把压头的 request_changes 返回为 `blockedByReview`（携评审 body 当问题清单）→ fixRounds 未超就派修 → NPC push 新 head → marker 变更自动重派审查 → approve → 认领合并；
  - 轮数上限 `review.fixRounds` 按修复事件全量计数（粗粒度防死循环），超限打 `npc-fix-exhausted` 标注退回人工；
  - 审查标准要写进 `ops/review.md` 才可靠——第一轮 retry_limit=-1 被放行（NPC 按「结果错误」标准判不了配置风险），写明负数为阻塞后立刻 request_changes。
- **NPC 台账（npc-observability）实测要点**（第 3 步）：
  - `actions` 端点对 API 派单不记录（total=0）；`commits` 才有货——工作模式 NPC 的 push 记录（行里带构建 sn、sha 就是推上的新 head）；
  - squash 合并后交付 sha 是新建的合并提交，NPC push 的 sha 是 PR head、**不在 main 历史里**，parent 上也没有——从交付提交标题的 `(#N)` 反查 PR 拿 head 再匹配（merge 固定 `{title} (#N)` 正好可用）；
  - shipSha 发布成功时查台账，命中则把 `npc-commit=<npc>@<sha> build:<sn> commits:<n>` 并进 shipped 标注；端点不可用或没参与都不影响发布。
- **需求→出货全自动（/autoloop build）实测要点**（PR #13 全链路验证）：
  - PR 里评论 `/autoloop build <需求>`（管理员权限，与 rollback 同名单）→ 派 `api_trigger_deliver_build` 流水线（工作模式 CodeBuddy）；
  - 开发人设与修复人设分开写：开发段「从 main 新建分支、实现、自己开 PR、不合并」；
  - CodeBuddy 确实能自主开 PR（标题+完整描述含方案依据/放弃方案），且**永远不要让它合并**——合并留给状态机门禁；
  - NPC 开的 PR 自动补交付标（作者认出是 CodeBuddy 就 addLabels + 回读验证），opened 中继接管后审查-合并-发布链路无人接管自然走完；
  - 实测全程：指令 → 开发构建 → 自主开 PR → 自动补标 → 自动审查 approve → 认领合并 → shipped+台账，人工只发两条评论指令。

## CNB API 端点备忘

```
PR      POST /{repo}/-/pulls                GET /{repo}/-/pulls/{n}
标签    GET/POST/DELETE /{repo}/-/pulls/{n}/labels
评审    GET/POST /{repo}/-/pulls/{n}/reviews        （approve 会被 NPC 自批禁令挡）
评论    GET/POST /{repo}/-/pulls/{n}/comments       （对话评论；不受禁令限制）
合并    PUT /{repo}/-/pulls/{n}/merge               （merge_style/commit_title/force）
构建    GET /{repo}/-/build/logs?page_size=20       （sha 过滤不生效，返回 12 位短 sha）
标注    GET/PUT /{repo}/-/git/commit-annotations/{full-sha}
状态    GET /{repo}/-/git/commit-statuses/{commitish}
事件    GET /events/{repo}/-/{yyyy-MM-dd-H}         （NDJSON，北京时间）
设置    GET/PUT /{repo}/-/settings/pull-request     分支保护 /{repo}/-/settings/branch-protections
```

## 已验证的状态机路径（试点仓库全链路跑通）

开 PR 无标签 → 静默等待 ✓ ・ docs-only 免审 → 合并 → shipped 标注 ✓ ・
检查构建进行中 → waiting 等待 ✓ ・ 构建完成 → 发布核实 ✓ ・
skip-review 声明 → 免审合并 → shipped ✓ ・ rollback 指令 → 权限校验 → 标注登记（含拒绝路径）✓ ・
重复事件/已合并 PR → 幂等「没事可做」✓ ・ 中继重放 → duplicate ✓ ・ 指令重放 → 防刷 ✓
