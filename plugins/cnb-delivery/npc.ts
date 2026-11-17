// NPC 审查路线：把审查外包给 CNB 平台的 NPC（npc:go），hub 只负责召唤与认领结果。
// 好处：NPC 自带 CNB_TOKEN（限时/限地/限权）能直接读 diff、发评审，hub 不用搬代码进审查环境；
// 代价：审查结果异步回来（流水线要跑几分钟），状态机把它当「等一等」处理。
//
// 约定（与 delivery.ts 的标记协议咬合）：NPC 的提示词里要求它用
//   交付审查（head前10位）
// 开头发评审，approve 或 request_changes。状态机下一轮 ownReview 认到标记就继续走。
// CNB 的评审不绑 commit，这个标记就是防串版的唯一手段——提示词里必须写死。
import type { Cnb } from "./cnb.ts";
import type { Settings } from "./project.ts";

export type NpcRoute = {
  /** 项目 .cnb.yml 里 api_trigger_ 开头的流水线事件名（npc:go 那条） */
  event: string;
  /** NPC 角色名（.cnb/settings.yml npc.roles 里定义的），缺省用流水线自带提示词 */
  role?: string;
  /** 覆盖 npc:go 的模型（可选） */
  model?: string;
};

export const MARK_HINT = (head: string) =>
  `交付审查（${head.slice(0, 10)}）`;

/** CNB 构建状态的归一化：build/logs 列表和 build/status 都用它判进度 */
export function classifyBuild(status: string): "running" | "success" | "error" {
  const state = String(status ?? "").toLowerCase();
  if (["success", "passed", "ok"].includes(state)) return "success";
  if (["error", "failed", "cancel", "cancelled"].includes(state)) return "error";
  return "running";
}

export function npcReviewPrompt(number: number, head: string, settings: Settings): string {
  const repo = settings.repo;
  return [
    `请审查 ${repo} 的合并请求 #${number}（head 提交 ${head.slice(0, 10)}）。`,
    `先读 ${settings.review.points}（main 分支上的审查要点），再读这个 PR 的改动。`,
    "只报告会导致结果错误、数据损失、权限或发布事故的问题；同一类问题报成一条。",
    "不改代码、不推分支，只发评审。",
    `评审 body 必须以「${MARK_HINT(head)}」开头（原样复制，含全角括号），这是交付状态的认领标记。`,
    "没问题发 approve，有问题发 request_changes 并在评审里写清每条问题的位置、触发条件和后果。",
  ].join("\n");
}

/** 召唤 NPC 审查：触发项目里的 api_trigger 流水线。branch 必须传 PR 源分支——流水线 fetch 的是 branch，
 *  checkout 的是 sha；不带 branch 会拿 main 去找 PR head，报 reference is not a tree。 */
export async function startNpcReview(cnb: Cnb, route: NpcRoute, number: number, head: string, settings: Settings, branch?: string): Promise<{ sn: string }> {
  if (!/^api_trigger_/.test(route.event)) throw new Error(`NPC 触发事件必须以 api_trigger_ 开头：${route.event}`);
  const env: Record<string, string> = {
    DELIVERY_PR: String(number),
    DELIVERY_HEAD: head,
    DELIVERY_MARKER: MARK_HINT(head),
    DELIVERY_USER_PROMPT: npcReviewPrompt(number, head, settings),
    ...(route.model ? { DELIVERY_MODEL: route.model } : {}),
  };
  const started = await cnb.startBuild({
    event: route.event,
    branch,
    sha: head,
    env,
    // 按平台 NPC 语义执行：操作者展示为 NPC 身份，token 资源按 NPC 规则收窄；
    // 角色设定不在 API 传（StartBuildReq 无 role 字段），由 .cnb.yml 流水线 options.role/systemPrompt 承担
    npc: { name: "CodeBuddy" },
  });
  return { sn: String(started?.sn ?? "") };
}

/** 追一下召唤出去的审查构建：失败要让人知道（评审永远不会来了） */
export async function npcReviewHealth(cnb: Cnb, sn: string): Promise<"running" | "success" | "error"> {
  if (!sn) return "error";
  const status = await cnb.buildStatus(sn);
  return classifyBuild(String(status?.status ?? ""));
}
