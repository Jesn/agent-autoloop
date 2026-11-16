// CNB 交付事件源：项目里的中继流水线（见 relay.cnb.yml）在 PR 事件时把
// CNB 内置环境变量打包 POST 到 hub 的 webhook，这里验签后转成中台事件。
// 在 rules.json：
//   "sources": { "cnbd": { "name": "CNB交付", "adapter": "cnb-delivery" } },
// 并在 secrets.env 放 AGENT_AUTOLOOP_SECRET_CNBD=<与中继流水线一致的随机串>。
import { createHash, timingSafeEqual } from "node:crypto";

/** 字段截到限长且不劈开代理对（与 worker/contract.ts 的 fit 同一实现，内联保自包含） */
const fit = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

// 中继流水线打包的字段，全部来自 CNB 内置环境变量与 git 信息
type Relay = {
  event: string; // pull_request | pull_request.update | pull_request.merged | push | ...
  repo: string; // 组织/仓库，如 i.o/x
  number?: number; // PR 编号，push 事件没有
  title?: string;
  sha?: string; // head 或合并后的提交
  branch?: string; // 目标分支（push 事件为推送分支）
  url?: string; // 事件页地址（CNB_EVENT_URL）
  proposer?: string; // PR 发起人
  comment?: string; // @NPC/交付 的评论内容（comment 事件才有）
  commenter?: string; // 评论者账号（comment 事件才有）
  at?: string; // 中继时刻 ISO 时间，缺失则用 body 摘要做幂等
};

const clean = (value: string) => value.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100);

export default function cnbDelivery({ headers, body, secret }: Input) {
  const given = String(headers["x-cnb-token"] ?? "");
  const signed = secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!signed) throw new Error("signature");
  const relay = JSON.parse(body) as Relay;
  if (!relay.event || !relay.repo) throw new Error("event 和 repo 必填");
  // 只认白名单事件，防止中继流水线配置漂移后把任意事件灌进中台
  if (!/^(pull_request(\.update|\.merged|\.approved|\.changes_requested|\.comment)?|push)$/.test(relay.event)) {
    throw new Error(`不支持的事件：${relay.event}`);
  }
  const number = relay.number ? `#${relay.number}` : "";
  // 同一事件重放（中继重试）与兑底轮询补漏要幂等：用提交号做键（中继与轮询各自的时间戳不同，
  // 按 at 键会漏去重）。同一 head 重复上报只算一次；head 变了是新事件。
  const key = /^[a-f0-9]{7,40}$/.test(String(relay.sha))
    ? relay.sha!.slice(0, 10)
    : createHash("sha256").update(body).digest("hex").slice(0, 16);
  // 评论指令（/autoloop 开头）走独立 subject repo#N@cmd@…：不挂状态机事件的退避 run，
  // 指令即刻新起一轮；id 键用评论体哈希，同一条指令重放去重、不同指令各算各
  const isCommand = relay.event === "pull_request.comment" && /^\s*\/autoloop\s+/m.test(String(relay.comment ?? ""));
  const id = isCommand
    ? `${relay.repo}${number}@cmd@${createHash("sha256").update(String(relay.comment)).digest("hex").slice(0, 12)}`
    : `${relay.repo}${number}@${relay.event}@${key}`;
  return [
    {
      id,
      type: relay.event,
      subject: clean(isCommand ? `${relay.repo}${number}@cmd` : `${relay.repo}${number}`),
      summary: fit(String(relay.title ?? relay.comment ?? relay.sha ?? relay.event).slice(0, 200), 200),
      detail: fit([relay.comment, relay.commenter && `评论人：${relay.commenter}`, relay.proposer && `发起人：${relay.proposer}`, relay.sha && `提交：${relay.sha}`].filter(Boolean).join("\n"), 4000),
      link: encodeURI(String(relay.url ?? `https://cnb.cool/${relay.repo}`)).slice(0, 500),
    },
  ];
}
