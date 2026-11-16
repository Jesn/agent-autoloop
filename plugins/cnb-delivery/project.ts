// CNB 项目的交付设置（ops/delivery.json），形状对齐 plugins/delivery/project.ts 的 GitHub 版，
// 差异只在 CNB 没有的概念：check/ship 是 .cnb.yml 里的流水线事件名而非 workflow 文件，
// review 没有 commit status 可写（去掉 status 字段）。健康核实完全同构，直接复用上游实现。
import { liveRelease, type Live, type Reviewer } from "../delivery/project.ts";

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

export type { Live, Reviewer };
export { liveRelease };

export { matches, PLAIN_FILE_MODES } from "../delivery/project.ts";

const SETTINGS_KEYS = ["repo", "internal", "admin_merge", "check", "ship", "review", "health"];
const REPO = /^[\w.-]+\/[\w.-]+$/;
const isWords = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((word) => typeof word === "string" && word.length > 0);
const isPaths = (value: unknown) =>
  isWords(value) && value.every((path) => !path.startsWith("/") && !path.split("/").includes(".."));

export function settings(value: any, testLocalHealth = false): Settings {
  const bad = () => {
    throw new Error("ops/delivery.json 的设置不正确");
  };
  if (!value || !REPO.test(value.repo ?? "") || !isPaths(value.internal)) bad();
  if (Object.keys(value).some((key) => !SETTINGS_KEYS.includes(key))) bad();
  const { review, health } = value;
  if (!review || !isPaths([review.points]) || (review.xhigh !== undefined && !isPaths(review.xhigh))) bad();
  if (review.command !== undefined && (!isWords(review.command) || !review.command.length)) bad();
  const { agents = {}, trusted = [] } = review;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) bad();
  if (!Object.entries(agents).every(([name, reviewer]) => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return false;
    if (reviewer === null) return true;
    if (typeof reviewer !== "object" || Array.isArray(reviewer)) return false;
    const { model, effort, command, ...unknown } = reviewer as any;
    if (Object.keys(unknown).length) return false;
    if (command !== undefined) return model === undefined && effort === undefined && isWords(command) && command.length > 0;
    const named = model === undefined || (typeof model === "string" && /^[A-Za-z0-9][\w.-]*$/.test(model));
    return named && (effort === undefined || (typeof effort === "string" && /^[a-z]+$/.test(effort)));
  })) bad();
  if (!Array.isArray(trusted) || !trusted.every((name) => typeof name === "string" && /^[\w.-]+$/.test(name))) bad();
  for (const pipeline of [value.check?.pipeline, value.ship?.pipeline]) {
    if (pipeline !== undefined && (typeof pipeline !== "string" || !/^[a-zA-Z][\w-]*$/.test(pipeline))) bad();
  }
  if (health) {
    const url = new URL(health.url);
    const secure = url.protocol === "https:" || (testLocalHealth && url.protocol === "http:" && url.hostname === "127.0.0.1");
    if (!secure || url.username || url.password) bad();
    if (typeof health.field !== "string" || typeof health.pattern !== "string" || !/\(\?(?:P)?<sha>/.test(health.pattern)) bad();
  }
  return {
    ...value,
    admin_merge: value.admin_merge ?? [],
    check: { pipeline: "check", ...value.check },
    ship: { pipeline: "ship", ...value.ship },
    review: { xhigh: [], ...review, agents, trusted },
  };
}
