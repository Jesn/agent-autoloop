// M5 兜底轮询：中继流水线丢失（CNB 流水线抖动、hub 重启窗口、devtunnel 断线）时，按小时拉仓库动态补漏。
// 产出与 source.ts 同形的事件（相同 id 约定：仓库#编号@事件@提交前10位），交回 hub 的幂等管道，两条路不重复计数。
// 响应实测（2026-11）：GET /events/{repo}/-/{date}，date 为四位年北京时间小时（2026-11-16-17），
// 返回 NDJSON（一行一个对象），Gitea 风格动态（PushEvent/CreateEvent/PullRequestEvent…）。
// 认不出的条目跳过不猜——宁可漏一条等中继补上，不要错事件混进交付状态机。
import type { Cnb } from "./cnb.ts";

export type PollEvent = {
  id: string;
  type: string;
  repo: string;
  number?: number;
  title?: string;
  sha?: string;
  branch?: string;
  url?: string;
  at?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** 动态接口的 date 参数：四位年-月-日-小时，按北京时间取整点 */
export const hourOf = (date: Date) => {
  const beijing = new Date(date.getTime() + 8 * 3_600_000);
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}-${pad(beijing.getUTCHours())}`;
};

/** 一条动态 → 事件；认不出返回 null。id 与 source.ts 同键（提交前10位），两路天然去重。 */
export function normalize(item: any, repo: string, fallbackAt: string): PollEvent | null {
  if (!item || typeof item !== "object") return null;
  if (item.repo?.name && String(item.repo.name) !== repo) return null; // 只认本仓库
  const at = String(item.created_at ?? item.updated_at ?? fallbackAt);
  const payload = item.payload ?? {};
  const type = String(item.type ?? "");

  if (type === "PushEvent") {
    const branch = String(payload.ref ?? "").replace(/^refs\/heads\//, "");
    if (branch !== "main") return null; // 与中继一致只发主干推送，特性分支推送会污染发布核实
    const sha = String(payload.head ?? payload.commits?.filter((c: any) => c.distinct).at(-1)?.sha ?? "");
    if (!/^[a-f0-9]{7,40}$/.test(sha)) return null;
    return { id: `${repo}@push@${sha.slice(0, 10)}`, type: "push", repo, sha, branch, at };
  }

  const pull = payload.pull_request ?? payload.pull;
  if (type === "PullRequestEvent" && pull) {
    const number = Number(pull.number ?? payload.number ?? item.number);
    const action = String(payload.action ?? "").toLowerCase();
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const eventType =
      action === "closed" ? (pull.merged ? "pull_request.merged" : null)
      : action === "synchronized" ? "pull_request.update"
      : action === "opened" || action === "reopened" ? "pull_request"
      : null;
    if (!eventType) return null;
    const sha = String(pull.head?.sha ?? pull.head_sha ?? "");
    return {
      id: `${repo}#${number}@${eventType}@${sha.slice(0, 10)}`,
      type: eventType,
      repo,
      number,
      title: String(pull.title ?? ""),
      sha: /^[a-f0-9]{7,40}$/.test(sha) ? sha : undefined,
      url: pull.html_url ? String(pull.html_url) : `https://cnb.cool/${repo}/-/pulls/${number}`,
      at,
    };
  }
  return null; // CreateEvent/IssueCommentEvent 等与交付无关
}

/** 拉指定时刻所在小时（及上一小时，边界不漏）的动态，归一去重后返回 */
export async function pollOnce(cnb: Cnb, repo: string, since = new Date()): Promise<PollEvent[]> {
  const hours = [hourOf(since), hourOf(new Date(since.getTime() - 3_600_000))];
  const seen = new Set<string>();
  const events: PollEvent[] = [];
  for (const hour of hours) {
    let items: any[];
    try {
      items = await cnb.events(hour);
    } catch {
      continue; // 单小时失败不挡另一个小时
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const event = normalize(item, repo, `${hour}:00:00`);
      if (event && !seen.has(event.id)) {
        seen.add(event.id);
        events.push(event);
      }
    }
  }
  return events;
}
