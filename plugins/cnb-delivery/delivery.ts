// CNB 版交付状态机：一次 deliverOnce 把一个 PR 推到它能到的最远状态，下一轮从中断处继续。
// 每一步都从 CNB 回读当下状态再行动（不落自有状态），head 漂移、标签被撤、已被别人合并都安全。
// 与 GitHub 版 delivery.ts 的分工差异：检查与合并门禁由分支保护在平台上强制（blocked_on 不会骗人），
// 这里只剩：标签协议 → 审查（review.ts）→ 门禁判定 → 合并 → 发布核实（build/logs + health）→ 发布标注。
import type { Cnb, Pull } from "./cnb.ts";
import { liveRelease, type Settings } from "./project.ts";
import { reviewInput, scopeFromFiles, submitVerdict, type Finding, type Reviewed } from "./review.ts";
import { startNpcReview, startNpcFix, fixEventOf, classifyBuild, type NpcRoute } from "./npc.ts";

export type { NpcRoute };

/** 需要人处理才能继续的失败：撤交付标记、退回作者（区别于「等一等就好」的静默等待） */
export class Refusal extends Error {}

export type Receipt = { text: string; exit: 0 | 1 | 2 };

export type DeliveryOptions = {
  /** 审查执行者：拿到审查输入（补丁 + 要点提示词），交回 findings。hub 派自己的 agent 实现 */
  review?: (input: { diff: string; prompt: string }) => Promise<Finding[]>;
  /** NPC 路线：没有自带执行者时，召唤平台 NPC 审查（异步，下一轮认领结果） */
  npc?: NpcRoute;
  /** 免审声明：项目设置了 review.agents 时，由受信账号声明这个 PR 是哪个代理写的 */
  declaredAgent?: string | null;
  /** 退回等事件的飞书通知（可选） */
  notify?: (text: string) => void;
};

/** 评审 body 开头的标记：CNB 的评审不绑定 commit，靠它认出哪个 head 已经有结论 */
const MARK = (head: string) => `交付审查（${head.slice(0, 10)}）`;

async function ownReview(cnb: Cnb, number: number, head: string) {
  const reviews = await cnb.reviews(number);
  const mine = reviews.filter((review: any) => typeof review.body === "string" && review.body.startsWith(MARK(head)));
  return mine.at(-1) as { state: string; body?: string } | undefined;
}

async function verdict(cnb: Cnb, config: Settings, pr: Pull, options: DeliveryOptions): Promise<Reviewed> {
  const number = Number(pr.number);
  const files = await cnb.files(number);
  const scope = scopeFromFiles(files, config);
  if (!scope.needsReview) return { docsOnly: true };
  const skip = await findSkipReview(cnb, config, number, pr.head.sha, String(pr.author?.username ?? ""));
  if (skip) return { exempt: skip };
  const prior = await ownReview(cnb, number, pr.head.sha);
  if (prior)
    return prior.state === "approved"
      ? []
      : { blockedByReview: String(prior.body ?? "") };
  if (!options.review) throw new Refusal("没有可用的审查执行者");
  const points = await cnb.file("main", config.review.points);
  const input = reviewInput(files, points, pr.body || undefined);
  return await options.review(input);
}

// 作者显式免审声明（/autoloop skip-review 指令写入，绑定提交号）：推新提交后声明自动作废
const SKIP_MARK = (head: string) => `交付免审（${head.slice(0, 10)}）：`;
async function findSkipReview(cnb: Cnb, config: Settings, number: number, head: string, author = ""): Promise<string | null> {
  const comments = await cnb.comments(number);
  const mark = SKIP_MARK(head);
  const hit = comments.filter((comment) => typeof comment.body === "string" && comment.body.startsWith(mark)).at(-1);
  if (!hit) return null;
  const by = /声明人：(.+)/.exec(hit.body)?.[1]?.trim();
  if (!by || (by !== author && !config.admin_merge.includes(by))) return null;
  return by;
}

/** 合并门禁：分支保护在平台上挡着的（waiting_review/status_check）交回去等，冲突退回作者 */
async function gate(cnb: Cnb, config: Settings, pr: Pull): Promise<Receipt> {
  const number = Number(pr.number);
  if (pr.blocked_on === "code_conflict" || pr.mergeable_state === "conflict")
    throw new Refusal("与 main 有冲突：CNB 没有代为更新分支的接口，请作者自己解决后重新交付");
  if (pr.is_wip) return { text: `#${number} 还是 WIP，等作者转正`, exit: 2 };
  // blocked_on="unblocked" 表示无阻塞，真正的阻塞值见 cnb.ts Pull 类型注释
  if (pr.blocked_on && pr.blocked_on !== "unblocked") {
    const admin = config.admin_merge.includes(String(pr.author?.username ?? ""));
    if (!admin) return { text: `#${number} 平台门禁未过（${pr.blocked_on}），等着`, exit: 2 };
  }
  // 插件令牌挂在仓库 Owner 名下 = Owner 的 NPC，普通合并被自批禁令挡（2003024）；
  // force 仅 Owner 可用，门禁仍由上面的 blocked_on/mergeable 检查先行把关。
  // 实测 squash 合并 commit_title 必填（缺了报 400），按平台默认格式补「{title} (#N)」；
  // 另实测：检查流水线还在跑时 merge 也会报同一个 2003024（CNB 内部先补审）——
  // 文案有误导，当门禁等待处理，下一轮重试自然过
  let merged: boolean;
  try {
    merged = await cnb.merge(number, "squash", `${pr.title} (#${number})`, true);
  } catch (error) {
    if (String(error).includes("2003024"))
      return { text: `#${number} 门禁还没放行（检查流水线可能没跑完），下一轮再看`, exit: 2 };
    throw error;
  }
  if (!merged) return { text: `#${number} 合并没生效（门禁或并发），下一轮再看`, exit: 2 };
  await cnb.removeLabel(number, "deliver");
  await cnb.removeLabel(number, "deliver-review");
  return { text: `#${number} 已合并（squash），等部署流水线跑完`, exit: 0 };
}

/** 发布核实：按合并提交 sha 查部署构建，构建成功再核线上版本，对上才标发布 */
/** 发布核实：按合并提交 sha 查部署构建，构建成功再核线上版本，对上才标发布。
 * PR 合并后走 ship()，push 中继事件没有 PR 编号时走 shipSha() 直接按提交核。 */
async function ship(cnb: Cnb, config: Settings, pr: Pull, options: DeliveryOptions): Promise<Receipt> {
  return shipSha(cnb, config, pr.head.sha, options, Number(pr.number));
}

/** NPC 参与台账：交付链里有工作模式 NPC push 时，把参与情况并进 shipped 标注。台账是锦上添花：
 *  端点不可用或没参与都不影响发布。匹配两次：先按交付 sha（fast-forward/直推），
 *  再按它的 parent（squash 合并后交付 sha 是新建的合并提交，NPC push 的 sha 落在 parent 上）。 */
async function npcLedger(cnb: Cnb, sha: string): Promise<Record<string, string>> {
  try {
    const rows = await cnb.npcCommits(20);
    const match = (target: string) =>
      rows.find((row) => typeof row.sha === "string" && target.startsWith(row.sha.slice(0, 10)));
    // squash 合并后 NPC push 的 sha 是 PR head、不在 main 历史里——从交付提交标题的 (#N) 反查 PR 拿 head 再匹配
    const number = Number(
      (await cnb.commit(sha).catch(() => null))?.message?.match(/\(#(\d+)\)\s*$/)?.[1] ?? 0,
    );
    const head = number ? await cnb.pull(number).then((p) => String(p.head?.sha ?? "")).catch(() => "") : "";
    const hit = match(sha) ?? (head ? match(head) : undefined);
    if (!hit) return {};
    const who = hit.npc_name ?? "npc";
    const fix = typeof hit.commits_count === "number" ? ` commits:${hit.commits_count}` : "";
    return { "npc-commit": `${who}@${String(hit.sha).slice(0, 10)} build:${hit.sn}${fix}` };
  } catch {
    return {};
  }
}

export async function shipSha(cnb: Cnb, config: Settings, sha: string, options: DeliveryOptions, number = 0): Promise<Receipt> {
  const where = number ? `#${number} ` : `${sha.slice(0, 10)} `;
  const builds = await cnb.builds(config.ship.pipeline, sha);
  const latest = builds.find((b) => b.sha === sha) ?? builds.find((b) => b.sha && (sha.startsWith(b.sha.slice(0, 10)) || b.sha.startsWith(sha.slice(0, 10))));
  if (!latest) return { text: `${where}还没有部署构建，等着`, exit: 2 };
  if (["pending", "running", ""].includes(latest.status)) return { text: `${where}部署构建进行中（${latest.sn}）`, exit: 2 };
  if (latest.status !== "success") {
    const text = `${where}部署构建失败（${latest.sn} 状态 ${latest.status}），发布未生效`;
    options.notify?.(text);
    return { text, exit: 1 };
  }
  if (!config.health) {
    await cnb.annotate(sha, { shipped: sha.slice(0, 10), ...(await npcLedger(cnb, sha)) });
    return { text: `${where}已发布（构建 ${latest.sn} 成功，项目没配健康核实）`, exit: 0 };
  }
  const live = await liveRelease(config);
  if (!live || (live.sha !== sha && !sha.startsWith(live.sha) && !live.sha.startsWith(sha.slice(0, 10))))
    return { text: `${where}线上版本还没到 ${sha.slice(0, 10)}，等发布生效`, exit: 2 };
  await cnb.annotate(sha, { shipped: live.release.slice(0, 200), ...(await npcLedger(cnb, sha)) });
  return { text: `${where}已发布并核实（${live.release}）`, exit: 0 };
}

export async function deliverOnce(cnb: Cnb, config: Settings, number: number, options: DeliveryOptions = {}): Promise<Receipt> {
  let pr: Pull;
  try {
    pr = await cnb.pull(number);
  } catch (error) {
    if (String(error).includes("404")) return { text: `#${number} 不存在或没权限`, exit: 1 };
    throw error;
  }
  if (pr.state === "merged") return ship(cnb, config, pr, options);
  if (pr.state === "closed") return { text: `#${number} 已关闭，没事可做`, exit: 2 };
  if (!pr.labels.some((label) => label.name === "deliver")) return { text: `#${number} 没有交付标记，没事可做`, exit: 2 };
  const head = pr.head.sha;
  try {
    // NPC 路线：没有自带审查执行者时，把审查外包给平台 NPC（异步）。免审的 PR 不惊动它。
    if (!options.review && options.npc) {
      const files = await cnb.files(number);
      if (scopeFromFiles(files, config).needsReview && !(await ownReview(cnb, number, head))) {
        // 去重：同一 head 已召唤过就不再派（api_trigger 构建按 sha 可查），防每轮重复派出
        const dispatched = await cnb.builds(options.npc.event, head);
        if (dispatched.length) {
          const health = classifyBuild(dispatched[0].status);
          if (health === "error") throw new Refusal(`NPC 审查构建失败（${dispatched[0].sn}），请检查 api_trigger 流水线`);
          return { text: `#${number} NPC 审查进行中（${dispatched[0].sn}），结果回来后继续`, exit: 2 };
        }
        const { sn } = await startNpcReview(cnb, options.npc, number, head, config, String(pr.head?.ref ?? ""));
        return { text: `#${number} 已派出 NPC 审查（${sn || "构建已受理"}）`, exit: 2 };
      }
    }
    const reviewed = await verdict(cnb, config, pr, options);
    if ("waiting" in reviewed) return { text: `#${number} ${reviewed.waiting}`, exit: 2 };
    if ("blockedByReview" in reviewed) {
      // 上一轮评审已打回这版提交：没配 NPC 修复就等作者推新提交；配了就把评审意见派给工作模式的
      // CodeBuddy 修——修完 push 新 head，marker 变更自动重开审查，直到 approve 或轮数用尽。
      const fixEvent = options.npc ? fixEventOf(options.npc) : null;
      const rounds = config.review.fixRounds ?? 0;
      if (fixEvent && rounds > 0) {
        const done = (await cnb.builds(fixEvent, "")).length; // 按事件计数修复轮数（含其它 PR，粗粒度但足够防死循环）
        if (done < rounds) {
          const findings = [{ title: `上轮审查意见（PR #${number}）`, text: reviewed.blockedByReview }];
          const { sn } = await startNpcFix(cnb, fixEvent, number, head, String(pr.head?.ref ?? ""), findings);
          await cnb.annotate(head, { "npc-fix-dispatched": `build:${sn} round:${done + 1}` });
          options.notify?.(`#${number} 审查已打回，已派 NPC 修复（第 ${done + 1} 轮，${sn}）`);
          return { text: `#${number} 审查已打回，已派 NPC 修复（第 ${done + 1} 轮，${sn || "构建已受理"}）`, exit: 2 };
        }
        await cnb.annotate(head, { "npc-fix-exhausted": `rounds:${done}` }).catch(() => {});
      }
      return { text: `#${number} 审查已挡下这版提交，等作者修复后重新交付`, exit: 2 };
    }
    const outcome = await submitVerdict(cnb, number, head, reviewed, MARK(head));
    if ("changed" in outcome) return { text: `#${number} 审查期间提交变了，下一轮重开`, exit: 2 };
    if (Array.isArray(reviewed) && reviewed.length) {
      // 有问题：request_changes 已提交（分支保护会挡住合并）。NPC 路线开着且项目配了修复轮数时，
      // 顺手把发现派给工作模式的 CodeBuddy：修完 push 新 head 自动重开审查；超轮数上限才退回人工。
      const fixEvent = options.npc ? fixEventOf(options.npc) : null;
      const rounds = config.review.fixRounds ?? 0;
      if (fixEvent && rounds > 0) {
        const done = (await cnb.builds(fixEvent, "")).length; // 按事件计数修复轮数（含其它 PR，粗粒度但足够防死循环）
        if (done < rounds) {
          const { sn } = await startNpcFix(cnb, fixEvent, number, head, String(pr.head?.ref ?? ""), reviewed);
          await cnb.annotate(head, { "npc-fix-dispatched": `build:${sn} round:${done + 1}` });
          options.notify?.(`#${number} 审查发现 ${reviewed.length} 个问题，已派 NPC 修复（第 ${done + 1} 轮，${sn}）`);
          return { text: `#${number} 审查发现 ${reviewed.length} 个问题，已派 NPC 修复（${sn || "构建已受理"}）`, exit: 2 };
        }
        await cnb.annotate(head, { "npc-fix-exhausted": `rounds:${done}` }).catch(() => {});
      }
      options.notify?.(`#${number} 审查发现 ${reviewed.length} 个问题，已挡下`);
      return { text: `#${number} 审查发现 ${reviewed.length} 个问题，挡下等修复`, exit: 0 };
    }
    if (Array.isArray(reviewed) && options.declaredAgent) await cnb.annotate(head, { "delivery-agent": options.declaredAgent });
    // 到这里只有两种：通过（[]）和免审（docsOnly/exempt），都直接进门禁
    const fresh = await cnb.pull(number);
    if (fresh.state !== "open" || fresh.head.sha !== head) return { text: `#${number} 审查后提交变了，下一轮重开`, exit: 2 };
    return await gate(cnb, config, fresh);
  } catch (error) {
    if (error instanceof Refusal) {
      await cnb.removeLabel(number, "deliver").catch(() => {});
      await cnb.removeLabel(number, "deliver-review").catch(() => {});
      options.notify?.(`#${number} 交付退回：${error.message}`);
      return { text: `#${number} 交付退回：${error.message}`, exit: 1 };
    }
    throw error;
  }
}

// ---------- 评论指令通道 ----------
// PR 里评论 /autoloop <cmd>，经中继进 hub 后路由到独立 subject（repo#N@cmd@…）——
// 不挂到状态机的退避 run 上，指令即刻新起一轮。

export type Command = { cmd: "retry" | "skip-review" | "rollback"; arg: string; by: string };

/** 从中继事件的 detail/summary 里解出指令；不是指令返回 null */
export function parseCommand(text: string): { cmd: Command["cmd"]; arg: string } | null {
  const hit = /^\s*\/autoloop\s+(\S+)(?:\s+([\s\S]+))?$/m.exec(text);
  if (!hit) return null;
  const cmd = hit[1].toLowerCase();
  if (cmd !== "retry" && cmd !== "skip-review" && cmd !== "rollback") return null;
  return { cmd, arg: (hit[2] ?? "").trim() };
}

/** 执行一条评论指令。commenter 是发评论的账号；by 回执正文在 reply 里同步到 PR */
export async function commandReceipt(
  cnb: Cnb,
  config: Settings,
  number: number,
  command: Command,
  head: string,
  options: DeliveryOptions = {},
): Promise<Receipt> {
  const { cmd, arg, by } = command;
  // admin_merge 未配置时退到 PR 作者可发起（配置名单后仅限名单）
  const pr = await cnb.pull(number);
  const admins = config.admin_merge.length ? config.admin_merge : [String(pr.author?.username ?? "")];
  const admin = admins.includes(by);
  if (cmd === "rollback" && !admin)
    return await refuse(cnb, number, `回滚只有管理员（${admins.join(", ")}）能发起，${by || "未知账号"} 不在名单里`);
  if (cmd === "rollback") {
    // 事件 detail 是多行的（后面跟评论人等元信息），提交号取首词
    const sha = arg.split(/\s+/)[0] ?? "";
    if (!/^[a-f0-9]{7,40}$/.test(sha))
      return await refuse(cnb, number, "回滚指令要带提交号：/autoloop rollback <sha>");
    // 直接下发回滚流水线（startBuild 的 config 可内联 YAML，仓库不用预配 api_trigger 段）：
    // 在 main 头上 revert 目标提交并推送，push 管道/中继自然接力出新 shipped 标注
    const config = [
      "main:",
      "  api_trigger:",
      "    - stages:",
      `        - name: rollback-${sha.slice(0, 8)}`, 
      "          script: |",
      '            git config user.email "autoloop@cnb" && git config user.name "autoloop-rollback"',
      '            git revert --no-edit "$ROLLBACK_SHA" && git push origin HEAD:main',
      '            echo "回滚提交已推送"',
    ].join("\n");
    const build = await cnb.startBuild({
      event: "api_trigger",
      branch: "main",
      title: `回滚 ${sha.slice(0, 10)}（${by} 指令，#${number}）`,
      env: { ROLLBACK_SHA: sha },
      config,
    });
    const sn = String(build?.sn ?? "");
    await cnb.annotate(sha, { "rollback-triggered": `build:${sn} by ${by}` });
    await cnb.createComment(number, `回滚流水线已触发：revert ${sha.slice(0, 10)} → main，构建 ${sn}。流水线完成后 push 链路会自动打出新 shipped 标注。`);
    return { text: `#${number} 回滚已触发（revert ${sha.slice(0, 10)}，构建 ${sn}）`, exit: 0 };
  }
  if (cmd === "skip-review") {
    if (!admin && pr.author?.username !== by)
      return await refuse(cnb, number, `免审声明只有 PR 作者或管理员能发，${by || "未知账号"} 不行`);
    await cnb.createComment(number, `${SKIP_MARK(head)}${arg || "作者显式免审"}\n声明人：${by}`);
    // 声明落库后直接跑一轮状态机：verdict 会认到声明走 exempt
  }
  // retry：什么都不用做，重新走状态机就是重试；skip-review 已写声明，同样接着走
  const receipt = await deliverOnce(cnb, config, number, options);
  return receipt;
}

async function refuse(cnb: Cnb, number: number, why: string): Promise<Receipt> {
  await cnb.createComment(number, `指令被拒：${why}`).catch(() => {});
  return { text: why, exit: 1 };
}
