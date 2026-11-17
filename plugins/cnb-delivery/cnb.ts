// api.cnb.cool 的零依赖客户端，只覆盖交付链路用到的接口。
// 错误分类对齐 GitHub 版的习惯：可重试的（网络、5xx、限流）抛 CnbHiccup，
// 终态拒绝的（冲突、检查失败）由状态机转成 refusal，不在这里重试。
const HICCUP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class CnbHiccup extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type PullRef = { ref: string; sha: string };
export type Pull = {
  number: string;
  state: "open" | "closed" | "merged";
  title: string;
  body: string;
  labels: { name: string }[];
  head: PullRef;
  base: PullRef;
  is_merged: boolean;
  is_wip: boolean;
  mergeable_state: "checking" | "mergeable" | "merging" | "merged" | "conflict" | "no-merge-base";
  // 阻塞原因：no_merge_base | internal_error | code_conflict | status_check | waiting_review
  blocked_on: string | null;
  author: { id?: number; username?: string };
};
export type ReviewComment = { path: string; body: string; start_line?: number; end_line?: number; subject_type?: "line" | "file" };
// 分支改动文件的清单项，只列用到的字段；mode 取值同 git raw（100644 普通文件、100755 可执行、120000 软链、000000 删除）
export type DiffFile = {
  path: string;
  previous_filename?: string;
  mode?: string;
  previous_mode?: string;
  status?: string;
  patch?: string;
};
export type BuildStatus = { status: string; pipelinesStatus: Record<string, unknown>; npc?: unknown };

export class Cnb {
  readonly token: string;
  readonly repo: string;
  readonly apiBase: string;

  constructor(token: string, repo: string, apiBase = "https://api.cnb.cool") {
    this.token = token;
    this.repo = repo;
    this.apiBase = apiBase;
  }

  async api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
    const url = `${this.apiBase}/${this.repo}/-${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.cnb.api+json",
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = typeof data?.message === "string" ? data.message : text.slice(0, 200);
      if (HICCUP_STATUS.has(response.status)) throw new CnbHiccup(response.status, `${response.status} ${message}`);
      throw new Error(`${response.status} ${message}`);
    }
    return data;
  }

  // ---- 合并请求 ----

  pull(number: number): Promise<Pull> {
    return this.api(`/pulls/${number}`);
  }

  labels(number: number): Promise<string[]> {
    return this.api(`/pulls/${number}/labels`).then((items: any) => items.map((item: any) => item.name));
  }

  async addLabels(number: number, names: string[]): Promise<void> {
    await this.api(`/pulls/${number}/labels`, { labels: names });
  }

  async removeLabel(number: number, name: string): Promise<void> {
    // 删除丢失的响应要回读确认，不能当成已删（对齐 GitHub 版 clearLabels 的教训）
    try {
      await this.api(`/pulls/${number}/labels/${encodeURIComponent(name)}`, undefined, "DELETE");
    } catch (error) {
      const left = await this.labels(number);
      if (left.includes(name)) throw error;
    }
  }

  // ---- 评审（审查结论的门禁载体）----

  review(number: number, event: "approve" | "request_changes" | "comment", body: string, comments: ReviewComment[] = []) {
    return this.api(`/pulls/${number}/reviews`, { event, body, comments });
  }

  reviews(number: number): Promise<any[]> {
    return this.api(`/pulls/${number}/reviews`);
  }

  // PR 评论（对话评论，非行内评审）：指令通道的读写都走这里。author 是 CNB 风格 {username,…}
  comments(number: number): Promise<Array<{ id: string; body: string; author?: { username?: string }; created_at?: string }>> {
    return this.api(`/pulls/${number}/comments`);
  }

  async createComment(number: number, body: string): Promise<{ id: number }> {
    const made = await this.api(`/pulls/${number}/comments`, { body });
    return { id: Number(made?.id ?? 0) };
  }

  // 分支自己改动的文件清单（带 path/mode/status/patch），免审判定和审查输入都从这里来
  files(number: number): Promise<DiffFile[]> {
    return this.api(`/pulls/${number}/files`);
  }

  // 读 main 上的审查要点等仓库内文件；响应里的 content 是 base64（GitHub 风格），
  // 某些版本可能直接给明文，两种都兼容
  async file(ref: string, path: string): Promise<string> {
    const content = await this.api(`/git/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    const text = String(content?.content ?? "");
    return content?.encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
  }

  // 按事件名和提交查构建历史：发布核实靠它找到合并提交的部署构建，不依赖中继回传 sn
  async builds(event: string, sha: string): Promise<Array<{ sn: string; status: string; sha?: string }>> {
    // 实测 sha 过滤参数不生效，拉回后由调用方按 b.sha 自行匹配
    const page = await this.api(`/build/logs?event=${encodeURIComponent(event)}&page_size=20`);
    const items = Array.isArray(page) ? page : page?.data ?? page?.items ?? []; // 实测包装是 { total, totalCapped, data }
    return items.map((item: any) => ({
      sn: String(item.sn ?? item.serial_number ?? ""),
      status: String(item.status ?? ""),
      sha: item.sha ? String(item.sha) : undefined,
    }));
  }

  // ---- 合并与分支 ----

  async merge(number: number, style: "merge" | "squash" | "rebase" | "fast_forward" = "squash", title?: string, force = false): Promise<boolean> {
    await this.api(`/pulls/${number}/merge`, { merge_style: style, commit_title: title, force }, "PUT");
    // 合并请求可能被分支保护拒了但响应丢失：回读确认，没合上就让调用方重试
    const after = await this.pull(number);
    return Boolean(after.is_merged);
  }

  head(branch = "main"): Promise<string> {
    return this.api(`/git/branches/${encodeURIComponent(branch)}`).then((b: any) => b.commit?.id ?? b.commit?.sha);
  }

  // head 是否已在 base 里：共同祖先就是 head 自己（CompareResponse.merge_base_commit）
  async contains(base: string, head: string): Promise<boolean> {
    const comparison = await this.api(`/git/compare/${base}...${head}`);
    return comparison?.merge_base_commit?.sha === head;
  }

  // 发布元数据：比如 shipped=发布的版本号，waitLive 核实线上时回读
  annotate(sha: string, entries: Record<string, string>): Promise<void> {
    const annotations = Object.entries(entries).map(([key, value]) => ({ key, value }));
    return this.api(`/git/commit-annotations/${sha}`, { annotations }, "PUT").then(() => undefined);
  }

  // ---- 构建（检查与部署流水线）----

  startBuild(form: { event: string; branch?: string; sha?: string; env?: Record<string, string>; title?: string; config?: string; npc?: { name: "CodeBuddy"; workMode?: boolean } }): Promise<{ sn: string }> {
    return this.api("/build/start", form);
  }

  buildStatus(sn: string): Promise<BuildStatus> {
    return this.api(`/build/status/${encodeURIComponent(sn)}`);
  }

  // ---- 仓库动态（轮询兜底）----

  // 动态接口在 api 根下而非仓库作用域；date 格式 yy-mm-dd-h 或 yy-mm-dd（两位年！）
  async events(date: string): Promise<any[]> {
    const response = await fetch(`${this.apiBase}/events/${this.repo}/-/${date}`, {
      headers: { accept: "application/vnd.cnb.api+json", authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
    // 实测响应是 NDJSON：一行一个事件对象（Gitea 风格：PushEvent/CreateEvent/…）
    return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
}


