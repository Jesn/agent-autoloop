// 一轮交付：`node run.ts <repo>`，事件从 AGENT_AUTOLOOP_CONTEXT 读（hub 派活时注入），回执打到 stdout。
// 项目设置从 CNB 仓库 main 的 ops/delivery.json 经 API 读取，本机不需要仓库检出。
// 审查执行者按优先级：CNB_NPC_EVENT（平台 NPC 路线）> review.command（项目自定命令）> 拒绝。
// 环境变量：CNB_TOKEN（api.cnb.cool 的访问令牌，必填）；CNB_NPC_EVENT / CNB_NPC_ROLE（NPC 路线，可选）。
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cnb } from "./cnb.ts";
import { deliverOnce, type DeliveryOptions } from "./delivery.ts";
import { settings, type Settings } from "./project.ts";
import { parseReview, reviewInput, type Finding } from "./review.ts";

export function subjectNumber(context: any, repo: string): number {
  const subject = String(context?.subject ?? "");
  const prefix = `${repo}#`;
  if (!subject.startsWith(prefix)) throw new Error(`事件主题 ${subject} 不是 ${repo} 的合并请求`);
  const number = Number(subject.slice(prefix.length).split(/[^0-9]/)[0]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`事件主题 ${subject} 里没有合并请求编号`);
  return number;
}

// 与 GitHub 版同约定：提示词从 stdin 进，{input} 替换成补丁文件，stdout 交 findings JSON。
const REVIEW_MINUTES = 30;

async function reviewByCommand(command: string[], input: { diff: string; prompt: string }): Promise<Finding[]> {
  const snapshot = mkdtempSync(join(tmpdir(), "cnbd-review-"));
  const changes = join(snapshot, "changes.txt");
  writeFileSync(changes, input.diff);
  const child = execFile(command[0], command.slice(1).map((arg) => arg.replaceAll("{input}", changes)), {
    timeout: REVIEW_MINUTES * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  child.stdin!.end(input.prompt);
  const stdout = await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout!.on("data", (chunk) => (out += chunk));
    child.stderr!.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0 ? resolve(out) : reject(new Error(signal && child.killed ? `审查超过 ${REVIEW_MINUTES} 分钟没有完成` : `审查没有完成：${err.slice(-1000)}`)),
    );
  });
  return parseReview(stdout);
}

export async function run(repo: string, argv = process.argv): Promise<{ text: string; exit: number }> {
  const token = process.env.CNB_TOKEN;
  if (!token) throw new Error("环境里没有 CNB_TOKEN，无法访问 api.cnb.cool");
  const number = subjectNumber(JSON.parse(process.env.AGENT_AUTOLOOP_CONTEXT ?? "{}"), repo);
  const cnb = new Cnb(token, repo);
  const config: Settings = settings(JSON.parse(await cnb.file("main", "ops/delivery.json")));
  const options: DeliveryOptions = {};
  if (process.env.CNB_NPC_EVENT) {
    options.npc = { event: process.env.CNB_NPC_EVENT, ...(process.env.CNB_NPC_ROLE ? { role: process.env.CNB_NPC_ROLE } : {}) };
  } else if (config.review.command) {
    options.review = (input) => reviewByCommand(config.review.command!, input);
  }
  const receipt = await deliverOnce(cnb, config, number, options);
  return { text: receipt.text, exit: receipt.exit === 1 ? 1 : 0 };
}

if (import.meta.main) {
  const repo = process.argv[2];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("用法：node run.ts <owner/name>");
  run(repo, process.argv)
    .then(({ text, exit }) => {
      console.log(text);
      process.exitCode = exit;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
