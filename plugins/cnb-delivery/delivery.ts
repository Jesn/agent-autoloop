// CNB 版交付状态机：一次 deliverOnce 把一个 PR 推到它能到的最远状态，下一轮从中断处继续。
// 每一步都从 CNB 回读当下状态再行动（不落自有状态），head 漂移、标签被撤、已被别人合并都安全。
// 与 GitHub 版 delivery.ts 的分工差异：检查与合并门禁由分支保护在平台上强制（blocked_on 不会骗人），
// 这里只剩：标签协议 → 审查（review.ts）→ 门禁判定 → 合并 → 发布核实（build/logs + health）→ 发布标注。
import type { Cnb, Pull } from "./cnb.ts";
import { liveRelease, type Settings } from "./project.ts";
import { reviewInput, scopeFromFiles, submitVerdict, type Finding, type Reviewed } from "./review.ts";

/** 需要人处理才能继续的失败：撤交付标记、退回作者（区别于「等一等就好」的静默等待） */
export class Refusal extends Error {}

export type Receipt = { text: string; exit: 0 | 1 | 2 };

export type DeliveryOptions = {
  /** 审查执行者：拿到审查输入（补丁 + 要点提示词），交回 findings。hub 派自己的 agent 实现 */
  review?: (input: { diff: string; prompt: string }) => Promise<Finding[]>;
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
  return mine.at(-1) as { state: string } | undefined;
}

async function verdict(cnb: Cnb, config: Settings, pr: Pull, options: DeliveryOptions): Promise<Reviewed> {
  const number = Number(pr.number);
  const files = await cnb.files(number);
  const scope = scopeFromFiles(files, config);
  if (!scope.needsReview) return { docsOnly: true };
  const prior = await ownReview(cnb, number, pr.head.sha);
  if (prior)
    return prior.state === "APPROVED"
      ? []
      : { waiting: "审查已挡下这版提交，等作者修复后重新交付" };
  if (!options.review) throw new Refusal("没有可用的审查执行者");
  const points = await cnb.file("main", config.review.points);
  const input = reviewInput(files, points, pr.body || undefined);
  return await options.review(input);
}

/** 合并门禁：分支保护在平台上挡着的（waiting_review/status_check）交回去等，冲突退回作者 */
async function gate(cnb: Cnb, config: Settings, pr: Pull): Promise<Receipt> {
  const number = Number(pr.number);
  if (pr.blocked_on === "code_conflict" || pr.mergeable_state === "conflict")
    throw new Refusal("与 main 有冲突：CNB 没有代为更新分支的接口，请作者自己解决后重新交付");
  if (pr.is_wip) return { text: `#${number} 还是 WIP，等作者转正`, exit: 2 };
  if (pr.blocked_on) {
    const admin = config.admin_merge.includes(String(pr.author?.username ?? ""));
    if (!admin) return { text: `#${number} 平台门禁未过（${pr.blocked_on}），等着`, exit: 2 };
  }
  const merged = await cnb.merge(number, "squash");
  if (!merged) return { text: `#${number} 合并没生效（门禁或并发），下一轮再看`, exit: 2 };
  await cnb.removeLabel(number, "deliver");
  await cnb.removeLabel(number, "deliver-review");
  return { text: `#${number} 已合并（squash），等部署流水线跑完`, exit: 0 };
}

/** 发布核实：按合并提交 sha 查部署构建，构建成功再核线上版本，对上才标发布 */
async function ship(cnb: Cnb, config: Settings, pr: Pull, options: DeliveryOptions): Promise<Receipt> {
  const number = Number(pr.number);
  const sha = pr.head.sha; // 合并后 head 即合并提交
  const builds = await cnb.builds(config.ship.pipeline, sha);
  const latest = builds[0];
  if (!latest) return { text: `#${number} 合并提交 ${sha.slice(0, 10)} 还没有部署构建，等着`, exit: 2 };
  if (["pending", "running", ""].includes(latest.status)) return { text: `#${number} 部署构建进行中（${latest.sn}）`, exit: 2 };
  if (latest.status !== "success") {
    const text = `#${number} 部署构建失败（${latest.sn} 状态 ${latest.status}），发布未生效`;
    options.notify?.(text);
    return { text, exit: 1 };
  }
  if (!config.health) {
    await cnb.annotate(sha, { shipped: sha.slice(0, 10) });
    return { text: `#${number} 已发布（构建 ${latest.sn} 成功，项目没配健康核实）`, exit: 0 };
  }
  const live = await liveRelease(config);
  if (live.sha !== sha && !sha.startsWith(live.sha) && !live.sha.startsWith(sha.slice(0, 10)))
    return { text: `#${number} 线上版本还没到 ${sha.slice(0, 10)}，等发布生效`, exit: 2 };
  await cnb.annotate(sha, { shipped: live.release.slice(0, 200) });
  return { text: `#${number} 已发布并核实（${live.release}）`, exit: 0 };
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
    const reviewed = await verdict(cnb, config, pr, options);
    if ("waiting" in reviewed) return { text: `#${number} ${reviewed.waiting}`, exit: 2 };
    const outcome = await submitVerdict(cnb, number, head, reviewed, MARK(head));
    if ("changed" in outcome) return { text: `#${number} 审查期间提交变了，下一轮重开`, exit: 2 };
    if (Array.isArray(reviewed) && reviewed.length) {
      // 有问题：request_changes 已提交（分支保护会挡住合并），保留标签等作者推新提交
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
