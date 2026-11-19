#!/usr/bin/env node
// 零依赖 MQTT 3.1.1 单发客户端：CNB 流水线中继专用（runner 只需有 node，无需 npm install）
// 用法：node mqtt-relay.mjs <host> <port> <user> <pass> <topic> <payload>
//   连接 → 发布(QoS1 等 PUBACK) → 断开，全程 <2s；失败非零退出（流水线可见）
import { connect as tlsConnect } from "node:tls";

const [host, port, user, pass, topic, payload] = process.argv.slice(2);
if (!host || !port || !user || !pass || !topic || !payload) {
  console.error("用法：node mqtt-relay.mjs <host> <port> <user> <pass> <topic> <payload>");
  process.exit(2);
}
const enc = (s) => Buffer.from(String(s), "utf8");

// UTF8 长度前缀字符串（MQTT 3.1.1 标准 2 字节大端长度）
const str = (s) => {
  const b = enc(s);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

// CONNECT：clean session + 用户名 + 密码，keepalive 60s
const flags = Buffer.from([0xc2]); // username|password|cleanSession
const connect = Buffer.concat([
  Buffer.from([0x00, 0x04]), Buffer.from("MQTT"), Buffer.from([0x04]), flags, Buffer.from([0x00, 60]),
  str(host), str(user), str(pass), // clientId 用 host 占位（唯一性不敏感，一次性连接）
]);
const pkt = (type, body) => {
  const len = [];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; len.push(d); } while (n > 0);
  return Buffer.concat([Buffer.from([type, ...len]), body]);
};

const socket = tlsConnect({ host, port: Number(port), servername: host }, () => {
  socket.write(pkt(0x10, connect));
});
let pid = 0;
const fail = (msg) => { console.error(`mqtt-pub 失败：${msg}`); socket.destroy(); process.exit(1); };
const timer = setTimeout(() => fail("超时（15s）"), 15_000);

socket.on("data", (buf) => {
  const type = buf[0] >> 4;
  if (type === 2) { // CONNACK
    if (buf[3] !== 0) fail(`CONNACK 拒绝码 ${buf[3]}（认证失败/不可用）`);
    pid = 1;
    const body = Buffer.concat([str(topic), Buffer.from([0x00, 0x01]), enc(payload)]);
    socket.write(pkt(0x32, body)); // PUBLISH QoS1
  } else if (type === 4) { // PUBACK
    console.log("mqtt-pub：已发布并收到 PUBACK");
    clearTimeout(timer);
    socket.end(Buffer.from([0xe0, 0x00])); // DISCONNECT
    setTimeout(() => process.exit(0), 150);
  }
});
socket.on("error", (e) => fail(e.message));
socket.on("close", () => { if (!socket.writableEnded) fail("连接被关闭"); });
