// M5 兜底轮询：中继流水线丢失（CNB 流水线抖动、hub 重启窗口）时，按小时拉仓库动态补漏。
// 产出与 source.ts 同形的事件（相同 id 约定），交回 hub 的幂等管道，两条路不重复计数。
// 注意：动态接口的响应没有 schema 文档（swagger 无 $ref），这里按保守的鸭子类型归一，
// 认不出的条目跳过不猜——宁可漏一条等中继补上，不要错事件混进交付状态机。
import { createHash } from "node:crypto";
import type { Cnb } from "./cnb.ts";

export type PollEvent = {
  id: string;
  type: string;
  repo: string;
  number?: number;
  title?: string;
  sha?: string;
  url?: string;
  at?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** 动态接口的 date 参数：两位年 yy-mm-dd-h（UTC） */
export const hourOf = (date: Date) =>
  `${pad(date.getUTCFullYear()).slice(-2)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}`;

const stamp = (item: any) => String(item?.updated_at ?? item?.created_at ?? item?.time ?? "");

/** 一条动态 → 事件；认不出返回 null */
export function normalize(item: any, repo: string, fallbackAt: string): PollEvent | null {
  if (!item || typeof item !== "object") return null;
  const pull = item.pull ?? item.pull_request ?? item.pr;
  const at = stamp(item) || fallbackAt;
  if (pull && (pull.number ?? item.number)) {
    const number = Number(pull.number ?? item.number);
    const action = String(pull.action ?? item.action ?? "update").toLowerCase().replace(/[^a-z]/g, "");
    return {
      id: `${repo}#${number}@pull_request@${at}`,
      type: "pull_request",
      repo,
      number,
      title: String(pull.title ?? item.title ?? ""),
      sha: String(pull.head_sha ?? pull.sha ?? item.sha ?? ""),
      url: pull.url ? String(pull.url) : `https://cnb.cool/${repo}/-/pulls/${number}`,
      at,
    };
  }
  const push = item.commits?.length || item.ref || item.after;
  if (push) {
    const sha = String(item.after ?? item.sha ?? item.commits?.at(-1)?.sha ?? "");
    return {
      id: `${repo}@push@${at}@${sha.slice(0, 10) || createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 10)}`,
      type: "push",
      repo,
      sha,
      url: item.url ? String(item.url) : `https://cnb.cool/${repo}`,
      at,
    };
  }
  return null;
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
