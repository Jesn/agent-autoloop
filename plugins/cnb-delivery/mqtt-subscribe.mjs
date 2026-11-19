// MQTT 订阅桥：EMQX Cloud（nas-mqtt）→ 本地 hub
// 订阅 autoloop/cnb/#，把消息原样转投 hub 的 CNB 事件入口（与 .cnb.yml 中继同一形状、同一幂等管道）。
// 设计要点：
//   - clean:false + QoS1：hub 宕机期间消息在 broker 侧排队，恢复后补送（devtunnel 丢事件的老坑不存在）
//   - 断线自动重连（mqtt.js 内建）；连接状态变化打日志
//   - 配置从同目录 mqtt-env.json 读（不入库），密钥不进代码
// 用法：node mqtt-subscribe.mjs [配置文件路径，默认同目录 mqtt-env.json]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.argv[2] ?? join(here, "mqtt-env.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const client = mqtt.connect(cfg.url, {
  clientId: cfg.clientId ?? "autoloop-bridge",
  clean: false, // 持久会话：掉线期间 broker 保留订阅并排队 QoS1 消息
  reconnectPeriod: 5_000,
  connectTimeout: 15_000,
  username: cfg.username,
  password: cfg.password,
});

client.on("connect", () => {
  log(`已连接 ${cfg.url}（会话${cfg.clientId ?? "autoloop-bridge"}）`);
  client.subscribe(cfg.topic ?? "autoloop/cnb/#", { qos: 1 }, (err) => {
    if (err) log("订阅失败：", err.message);
    else log("已订阅", cfg.topic ?? "autoloop/cnb/#");
  });
});
client.on("reconnect", () => log("重连中…"));
client.on("close", () => log("连接断开"));
client.on("error", (err) => log("连接错误：", err.message));

client.on("message", async (topic, payload) => {
  const text = payload.toString("utf8");
  try {
    JSON.parse(text); // 只收 JSON（坏消息丢弃并打日志，防止垃圾进中台）
  } catch {
    log(`[${topic}] 非 JSON 消息，丢弃（${text.slice(0, 60)}）`);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${cfg.hubUrl}/v1/in/cnbd`, {
        method: "POST",
        headers: { "x-cnb-token": cfg.token, "content-type": "application/json" },
        body: text,
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
      log(`[${topic}] 已投递 hub（${body.slice(0, 120)}）`);
      return;
    } catch (error) {
      log(`[${topic}] 投递失败（第 ${attempt} 次）：`, error instanceof Error ? error.message : error);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
  log(`[${topic}] 3 次投递均失败，放弃本轮（状态机有心跳/轮询兜底）`);
});
