// 一轮交付：`node run.ts <repo>`，事件从 AGENT_AUTOLOOP_CONTEXT 读（hub 派活时注入），回执打到 stdout。
// 项目设置从 CNB 仓库 main 的 ops/delivery.json 经 API 读取，本机不需要仓库检出。
// 审查执行者按优先级：CNB_NPC_EVENT（平台 NPC 路线）> review.command（项目自定命令）> 拒绝。
// 环境变量：CNB_TOKEN（api.cnb.cool 的访问令牌，必填）；CNB_NPC_EVENT / CNB_NPC_ROLE（NPC 路线，可选）。
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cnb } from "./cnb.ts";
import { commandReceipt, deliverOnce, parseCommand, shipSha, type DeliveryOptions } from "./delivery.ts";
import { settings, type Settings } from "./project.ts";
import { parseReview, reviewInput, type Finding } from "./review.ts";

// 与上游 delivery/input.ts 同一约定：context.events 的 subject 必须都指向同一事项；
// push 事件的 subject 就是仓库名（无编号），走发布核实。
export function subjectNumber<E extends { subject: string }>(repo: string, context: { events: E[] }): number {
  const subjects = [...new Set(context.events.map((event) => event.subject))];
  const suffix = subjects[0]?.slice(repo.length + 1);
  if (subjects.length !== 1 || !subjects[0].startsWith(`${repo}#`) || !/^[1-9]\d*$/.test(suffix)) {
    throw new Error("事件没有指向规则指定仓库的同一个事项");
  }
  const number = Number(suffix);
  if (!Number.isSafeInteger(number)) throw new Error("事项编号不正确");
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
  return runWith(new Cnb(token, repo), repo);
}

export async function runWith(cnb: Cnb, repo: string): Promise<{ text: string; exit: number }> {
  const contextPath = process.env.AGENT_AUTOLOOP_CONTEXT;
  if (!contextPath) throw new Error("没有 AGENT_AUTOLOOP_CONTEXT，只能由中台派活时运行");
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const config: Settings = settings(JSON.parse(await cnb.file("main", "ops/delivery.json")));
  const options: DeliveryOptions = {};
  if (process.env.CNB_NPC_EVENT) {
    options.npc = { event: process.env.CNB_NPC_EVENT, ...(process.env.CNB_NPC_ROLE ? { role: process.env.CNB_NPC_ROLE } : {}) };
  } else if (config.review.command) {
    options.review = (input) => reviewByCommand(config.review.command!, input);
  }
  // 评论指令：subject 形如 repo#N@cmd@…（独立于状态机事件，不挂退避 run）；
  // 中继把指令正文放 detail，指令人放 summary/detail（评论人：xxx）
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cmdNumber = (subject: string) => Number(new RegExp(`^${esc}#(\\d+)@cmd@`).exec(subject)?.[1] ?? 0);
  const cmdEvent = (context.events ?? []).find((event: any) => {
    const text = `${event.summary ?? ""}\n${event.detail ?? ""}`;
    return cmdNumber(String(event.subject ?? "")) > 0 && parseCommand(text) !== null;
  });
  if (cmdEvent) {
    const text = `${cmdEvent.summary ?? ""}\n${cmdEvent.detail ?? ""}`;
    const parsed = parseCommand(text)!;
    const by = /评论人：(.+)/.exec(text)?.[1]?.trim() ?? /发起人：(.+)/.exec(text)?.[1]?.trim() ?? "";
    const receipt = await commandReceipt(cnb, config, cmdNumber(String(cmdEvent.subject)), { ...parsed, by }, String((await cnb.pull(cmdNumber(String(cmdEvent.subject)))).head?.sha ?? ""), options);
    return { text: receipt.text, exit: receipt.exit === 1 ? 1 : 0 };
  }
  // push 事件：subject 就是仓库，从事件的 sha/summary/detail 里提出提交号进发布核实；其余按 PR 编号走状态机
  const subjects = [...new Set((context.events ?? []).map((event: any) => String(event.subject ?? "")))];
  if (subjects.length === 1 && subjects[0] === repo) {
    const sha = String(
      context.events.find((event: any) => /^[a-f0-9]{7,40}$/.test(String(event.sha ?? "")))?.sha
        ?? context.events.find((event: any) => /^[a-f0-9]{7,40}$/.test(String(event.summary ?? "")))?.summary
        ?? context.events.map((event: any) => /提交：([a-f0-9]{7,40})/.exec(String(event.detail ?? ""))?.[1]).find(Boolean)
        ?? "",
    );
    if (!/^[a-f0-9]{7,40}$/.test(sha)) throw new Error("push 事件里没有可用的提交号");
    return await shipSha(cnb, config, sha, options);
  }
  const receipt = await deliverOnce(cnb, config, subjectNumber(repo, context), options);
  return { text: receipt.text, exit: receipt.exit === 1 ? 1 : 0 };
}

if (import.meta.main) {
  const repo = process.argv[2];
  if (!repo || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw new Error("用法：node run.ts <owner/name 或 org/group/name>");
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
