// CNB 项目的交付设置（ops/delivery.json），形状对齐 plugins/delivery/project.ts 的 GitHub 版，
// 差异只在 CNB 没有的概念：check/ship 是 .cnb.yml 里的流水线事件名而非 workflow 文件，
// review 没有 commit status 可写（去掉 status 字段）。
// 本目录完全自包含：只依赖本插件内的文件和 Node 内置，可整体拷进 HOME/plugins 运行。
import { execFileSync } from "node:child_process";

export type Settings = {
  repo: string;
  /** 免审免发布的内部路径（glob），与 GitHub 版同一套规则 */
  internal: string[];
  /** 允许跳过未完成审查直接合并的管理员账号（CNB 用户名） */
  admin_merge: string[];
  /** .cnb.yml 里 PR 检查流水线的事件名（分支保护里配的 required_status_checks 对应它） */
  check: { pipeline: string };
  /** 部署流水线事件名：合并后 hub 靠 build/status + health 核实 */
  ship: { pipeline: string };
  review: {
    points: string;
    xhigh: string[];
    command?: string[];
    agents: Record<string, Reviewer | null>;
    trusted: string[];
  };
  health?: { url: string; require: Record<string, unknown>; field: string; pattern: string };
};

/** 内置审查换成一条命令（提示词从 stdin 进，{input} 换成补丁文件，stdout 交 findings JSON），
 * 或给某个开发 Agent 指定模型与深度。与 GitHub 版同形。 */
export type Reviewer = { model?: string; effort?: string; command?: string[] };
export type Live = { sha: string; release: string };

/** 不是可执行位也不是软链的普通文件模式；只有这类改动可以免审免发布 */
export const PLAIN_FILE_MODES = ["000000", "100644"];
const REPO = /^[\w.-]+\/[\w.-]+$/;
const isWords = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((word) => typeof word === "string" && word.length > 0);
const isPaths = (value: unknown) =>
  isWords(value) && value.every((path) => !path.startsWith("/") && !path.split("/").includes(".."));

function isReviewer(value: any) {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const { model, effort, command, ...unknown } = value;
  if (Object.keys(unknown).length) return false;
  if (command !== undefined) return model === undefined && effort === undefined && isWords(command) && command.length > 0;
  const named = model === undefined || (typeof model === "string" && /^[A-Za-z0-9][\w.-]*$/.test(model));
  return named && (effort === undefined || (typeof effort === "string" && /^[a-z]+$/.test(effort)));
}

/** Settings 可能写命名分组（(?P<sha>…)），JavaScript 只认 (?<sha>…） */
const jsPattern = (pattern: string) => pattern.replace("(?P<sha>", "(?<sha>");

export function settings(value: any, testLocalHealth = false): Settings {
  const bad = () => {
    throw new Error("ops/delivery.json 的设置不正确");
  };
  if (!value || !REPO.test(value.repo ?? "") || !isPaths(value.internal)) bad();
  if (Object.keys(value).some((key) => !["repo", "internal", "admin_merge", "check", "ship", "review", "health"].includes(key))) bad();
  const { review, health } = value;
  if (!review || !isPaths([review.points]) || (review.xhigh !== undefined && !isPaths(review.xhigh))) bad();
  if (review.command !== undefined && (!isWords(review.command) || !review.command.length)) bad();
  const { agents = {}, trusted = [] } = review;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) bad();
  if (!Object.entries(agents).every(([name, reviewer]) => /^[a-z][a-z0-9-]{0,31}$/.test(name) && isReviewer(reviewer))) bad();
  if (!Array.isArray(trusted) || !trusted.every((name) => typeof name === "string" && /^[\w.-]+$/.test(name))) bad();
  for (const pipeline of [value.check?.pipeline, value.ship?.pipeline]) {
    if (pipeline !== undefined && (typeof pipeline !== "string" || !/^[a-zA-Z][\w-]*$/.test(pipeline))) bad();
  }
  if (health) {
    const url = new URL(health.url);
    const secure = url.protocol === "https:" || (testLocalHealth && url.protocol === "http:" && url.hostname === "127.0.0.1");
    if (!secure || url.username || url.password) bad();
    if (typeof health.field !== "string" || typeof health.pattern !== "string" || !/\(\?(?:P)?<sha>/.test(health.pattern)) bad();
    new RegExp(jsPattern(health.pattern));
    if (health.require !== undefined && (!health.require || typeof health.require !== "object" || Array.isArray(health.require))) bad();
  }
  return {
    ...value,
    admin_merge: value.admin_merge ?? [],
    check: { pipeline: "check", ...value.check },
    ship: { pipeline: "ship", ...value.ship },
    review: { xhigh: [], ...review, agents, trusted },
    ...(health && { health: { require: {}, ...health } }),
  };
}

function globToRegExp(pattern: string) {
  const parts = pattern.split(/(\*\*\/|\*)/).map((part) => {
    if (part === "**/") return "(?:.*/)?";
    if (part === "*") return "[^/]*";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("")}$`);
}

export const matches = (name: string, patterns: string[]) =>
  patterns.some((pattern) => globToRegExp(pattern).test(name));

/** 项目健康接口：返回体里按 require 核对业务字段，按 pattern 提取线上版本里的提交号 */
export async function liveRelease(config: Settings, request: typeof fetch = fetch): Promise<Live | null> {
  if (!config.health) return null;
  const { url, require, field, pattern } = config.health;
  try {
    const response = await request(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || Object.entries(require).some(([key, value]) => body[key] !== value)) return null;
    if (typeof body[field] !== "string") return null;
    const release = body[field];
    const sha = new RegExp(`^(?:${jsPattern(pattern)})$`).exec(release)?.groups?.sha;
    return sha && /^[a-f0-9]{7,40}$/.test(sha) ? { sha, release } : null;
  } catch {
    return null;
  }
}

/** 读仓库文件用（worker 本地没有 CNB 仓库检出，设置从 main 经 API 读） */
export function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
