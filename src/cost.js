/**
 * cost.js —— token 账本
 *
 * 为什么要把这件事做成一层，而不是在每个工具里打印一句话：
 * 陪伴助手最贵的不是文字，是**看图**。一张 1280×720 的截图约 1200+ token，
 * 连看 60 帧就是 7 万——比一整天聊天还贵。用户有权在花出去之前知道价格。
 *
 * 所以这里做三件事：
 *   1. 算准：图片按真实像素算（读 JPEG/PNG 头拿宽高），不靠固定估值。
 *   2. 记账：每次调用落一行 usage.jsonl，可查今日/本次/按类型。
 *   3. 预警：单次超阈值就提醒，超硬顶直接拒。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 中文 1 字 ≈ 1.5 token；英文约 1 词 ≈ 1.3。取保守值，宁可高估。 */
export function textTokens(s) {
  const t = String(s || '');
  if (!t) return 0;
  let cjk = 0;
  for (const ch of t) if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
  const other = t.length - cjk;
  return Math.ceil(cjk * 1.5 + other / 3.6);
}

/** 从图片字节里读真实宽高。不装库，认 JPEG 和 PNG 两种。 */
export function imageSize(buf) {
  try {
    // PNG: 8 字节签名 + IHDR，宽高在 16..24 大端
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
    }
    // JPEG: 扫 marker 找 SOF
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const m = buf[i + 1];
        // SOF0/1/2/3, 5/6/7, 9/10/11, 13/14/15
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7)
          || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpeg' };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch { /* 落到底下给个默认 */ }
  return { w: 0, h: 0, type: 'unknown' };
}

/**
 * 图片 token。业界常用近似：tokens ≈ (w × h) / 750，并有最低固定开销。
 * 这里按比例算而不是按「一张图固定多少」——因为裁一小块和抓全屏差一个数量级。
 */
export function imageTokens(buf) {
  const { w, h, type } = imageSize(buf);
  if (!w || !h) return { tokens: 1100, w: 0, h: 0, type, exact: false };
  return { tokens: Math.ceil((w * h) / 750), w, h, type, exact: true };
}

/** 单次调用的软阈值与硬顶。硬顶踩到就拒，不商量。 */
export const GUARD = {
  warnPerCall: 4000,
  maxPerCall: 60_000,
  maxPerDay: 2_000_000,
};

export class Ledger {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'usage.jsonl');
    this.session = { calls: 0, tokens: 0, byKind: {} };
    this.day = { date: '', tokens: 0 };
    this._loadToday();
  }

  _loadToday() {
    const today = new Date().toISOString().slice(0, 10);
    this.day = { date: today, tokens: 0 };
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (String(r.at).slice(0, 10) === today) this.day.tokens += r.tokens || 0;
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 首次没有账本 */ }
  }

  /** 记一笔。返回这笔的汇总，方便直接塞进工具结果。 */
  add(kind, tokens, meta = {}) {
    const n = Math.max(0, Math.round(tokens || 0));
    this.session.calls += 1;
    this.session.tokens += n;
    this.session.byKind[kind] = (this.session.byKind[kind] || 0) + n;
    this.day.tokens += n;
    try {
      fs.mkdirSync(this.home, { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({
        at: new Date().toISOString(), kind, tokens: n, ...meta,
      }) + '\n');
    } catch { /* 记账失败不阻断功能 */ }
    return this.stamp(kind, n);
  }

  /** 一次调用里可能同时有文字和图片，合起来报 */
  stamp(kind, tokens, extra = {}) {
    const warn = tokens >= GUARD.warnPerCall;
    return {
      kind, tokens,
      session: this.session.tokens,
      today: this.day.tokens,
      warn,
      line: `${fmt(tokens)} token${warn ? ' ⚠️ 这一笔偏贵' : ''}｜本次 ${fmt(this.session.tokens)}｜今日 ${fmt(this.day.tokens)}`,
      ...extra,
    };
  }

  /** 超硬顶就拒——在花钱之前拦，不是在花完之后道歉 */
  check(tokens) {
    if (tokens > GUARD.maxPerCall) {
      return { ok: false, reason: `这一笔约 ${fmt(tokens)} token，超过单次硬顶 ${fmt(GUARD.maxPerCall)}，已拒绝` };
    }
    if (this.day.tokens + tokens > GUARD.maxPerDay) {
      return { ok: false, reason: `今日已用 ${fmt(this.day.tokens)}，再加会超过日上限 ${fmt(GUARD.maxPerDay)}` };
    }
    return { ok: true };
  }

  summary() {
    const kinds = Object.entries(this.session.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k.padEnd(16)} ${fmt(v)}`)
      .join('\n');
    return [
      `本次会话：${this.session.calls} 次调用 / ${fmt(this.session.tokens)} token`,
      `今日累计：${fmt(this.day.tokens)} token（上限 ${fmt(GUARD.maxPerDay)}，占 ${(this.day.tokens / GUARD.maxPerDay * 100).toFixed(2)}%）`,
      kinds ? '按类型：\n' + kinds : '按类型：（还没有消耗）',
      `单次软阈值 ${fmt(GUARD.warnPerCall)} / 硬顶 ${fmt(GUARD.maxPerCall)}`,
    ].join('\n');
  }
}

function fmt(n) {
  const v = Math.round(n || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}
