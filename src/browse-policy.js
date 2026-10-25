/**
 * browse-policy.js —— 什么时候能刷、能刷多久、能说几句
 *
 * 这个文件是「她自己刷视频」这件事的刹车和日历。
 * 没有它，一个会自己刷抖音的助手等于一个没人看管的短视频黑洞。
 *
 * 四道闸，任何一道不合就停：
 *   1. 总开关       enabled
 *   2. 时段         windows（支持跨午夜，如 "22:00-01:30"）
 *   3. 单次时长     perSessionMinutes
 *   4. 每日总量      perDayMinutes + 两次之间 minGapMinutes
 *
 * 评论是另一套闸，独立开关、独立配额、独立内容黑名单。
 * 「能刷」不等于「能说话」——刷是消费内容，评论是对外发言，两者风险差一个量级。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_POLICY = {
  enabled: false,                        // 出厂关着。要不要让她自己刷，用户说了算
  sites: ['bilibili', 'douyin'],         // 允许哪些站
  windows: ['12:30-13:30', '21:30-23:30'],
  perSessionMinutes: 15,
  perDayMinutes: 45,
  minGapMinutes: 90,
  comment: {
    enabled: false,                      // 评论默认关
    maxPerDay: 3,
    maxPerSession: 1,
    requireApproval: true,               // 发出去之前必须用户点头
    maxChars: 40,
    avoid: ['政治', '医疗', '灾难事故', '身材评价', '收入', '宗教'],
  },
};

const DAY = 24 * 60;

/** "22:00-01:30" → {start: 1320, end: 90, cross: true} */
export function parseWindow(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})\s*[-–—~]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h1, m1, h2, m2] = m;
  const start = (+h1) * 60 + (+m1);
  const end = (+h2) * 60 + (+m2);
  if (start > DAY - 1 || end > DAY - 1) return null;
  return { start, end, cross: end <= start, raw: s };
}

const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 现在落在哪个允许时段里。跨午夜时段在 00:30 也算命中。 */
export function activeWindow(policy, now = new Date()) {
  const cur = minutesOf(now);
  for (const raw of policy.windows || []) {
    const w = parseWindow(raw);
    if (!w) continue;
    if (w.cross) {
      if (cur >= w.start || cur < w.end) return { ...w, remainMinutes: w.end - (cur >= w.start ? cur - DAY : cur) };
    } else if (cur >= w.start && cur < w.end) {
      return { ...w, remainMinutes: w.end - cur };
    }
  }
  return null;
}

export class BrowsePolicy {
  constructor(opts = {}) {
    this.home = opts.home || path.join(os.homedir(), '.dsh-companion');
    this.file = path.join(this.home, 'browse.json');
    this.stateFile = path.join(this.home, 'browse-state.json');
    fs.mkdirSync(this.home, { recursive: true });
    this.policy = { ...DEFAULT_POLICY, ...(opts.policy || {}) };
    if (opts.policy && opts.policy.comment) {
      this.policy.comment = { ...DEFAULT_POLICY.comment, ...opts.policy.comment };
    }
    this.state = this._load();
    this.session = null;  // {site, startedAt, minutes, pageId}
  }

  _load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s.date !== dateKey(new Date())) {
        // 跨天：清当天额度，但保留「上次刷完是什么时候」用来算间隔
        return { date: dateKey(new Date()), minutes: 0, comments: 0, sessions: 0, lastEndAt: s.lastEndAt || 0 };
      }
      return s;
    } catch {
      return { date: dateKey(new Date()), minutes: 0, comments: 0, sessions: 0, lastEndAt: 0 };
    }
  }

  _save() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); } catch { /* 存储失败不该阻断 */ }
  }

  savePolicy() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.policy, null, 2)); return true; } catch { return false; }
  }

  /* ---------- 能不能开始 ---------- */

  /**
   * 能不能现在开始刷。
   * 这个函数要说出「为什么不行」，而不是只给 false —— 用户问「她怎么不刷了」
   * 的时候，得有一句人话能回答。
   */
  canStart(now = new Date()) {
    const p = this.policy;
    if (!p.enabled) return { ok: false, code: 'off', reason: '自己刷视频的总开关是关的' };
    if (this.session) return { ok: false, code: 'busy', reason: `已经在刷了（${this.session.site}，第 ${Math.round((Date.now() - this.session.startedAt) / 60000)} 分钟）` };

    const w = activeWindow(p, now);
    if (!w) {
      const next = this.nextWindow(now);
      return {
        ok: false, code: 'out-of-window',
        reason: `不在允许时段（现在 ${hhmm(minutesOf(now))}，允许 ${(p.windows || []).join('、') || '无'}）`,
        nextAt: next,
      };
    }

    const left = p.perDayMinutes - this.state.minutes;
    if (left <= 0) {
      return { ok: false, code: 'day-quota', reason: `今天 ${p.perDayMinutes} 分钟已经用完了（${this.state.minutes} 分钟）` };
    }

    const sinceEnd = this.state.lastEndAt ? (Date.now() - this.state.lastEndAt) / 60000 : Infinity;
    if (sinceEnd < p.minGapMinutes) {
      return {
        ok: false, code: 'gap',
        reason: `距上次结束才 ${Math.round(sinceEnd)} 分钟，要隔 ${p.minGapMinutes} 分钟`,
        nextAt: new Date(this.state.lastEndAt + p.minGapMinutes * 60000).toISOString(),
      };
    }

    const minutes = Math.max(1, Math.min(p.perSessionMinutes, left, w.remainMinutes));
    return {
      ok: true, minutes,
      until: new Date(Date.now() + minutes * 60000).toISOString(),
      windowLeft: w.remainMinutes,
      dayLeft: left,
      reason: `可以刷 ${minutes} 分钟（本时段还剩 ${w.remainMinutes} 分钟，今天还剩 ${left} 分钟）`,
    };
  }

  nextWindow(now = new Date()) {
    const cur = minutesOf(now);
    let best = Infinity;
    for (const raw of this.policy.windows || []) {
      const w = parseWindow(raw);
      if (!w) continue;
      let delta = w.start - cur;
      if (delta <= 0) delta += DAY;
      if (delta < best) best = delta;
    }
    if (best === Infinity) return null;
    return new Date(now.getTime() + best * 60000).toISOString();
  }

  /* ---------- 开始 / 结束 ---------- */

  start(site, { pageId } = {}) {
    const c = this.canStart();
    if (!c.ok) return c;
    this.session = { site, startedAt: Date.now(), pageId, minutes: c.minutes };
    this.state.sessions += 1;
    this._save();
    return { ok: true, minutes: c.minutes, until: c.until };
  }

  /** 结束。返回这次实际刷了多久（按分钟向上取整，宁多算不少算）。 */
  stop() {
    if (!this.session) return { ok: true, minutes: 0, note: '没在刷' };
    const ms = Date.now() - this.session.startedAt;
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    this.state.minutes += minutes;
    this.state.lastEndAt = Date.now();
    const site = this.session.site;
    this.session = null;
    this._save();
    return { ok: true, minutes, site, dayUsed: this.state.minutes, dayLimit: this.policy.perDayMinutes };
  }

  /** 到点自己停。工具调用间隙调用它，不需要额外定时器。 */
  expired(now = Date.now()) {
    if (!this.session) return null;
    const limitMs = this.session.minutes * 60000;
    if (now - this.session.startedAt >= limitMs) {
      return { expired: true, ...this.stop() };
    }
    return { expired: false, leftMs: limitMs - (now - this.session.startedAt) };
  }

  sessionLeftMinutes() {
    if (!this.session) return 0;
    return Math.max(0, this.session.minutes - (Date.now() - this.session.startedAt) / 60000);
  }

  /* ---------- 评论 ---------- */

  canComment(now = new Date()) {
    const c = this.policy.comment || {};
    if (!c.enabled) return { ok: false, code: 'off', reason: '评论功能是关的' };
    if (this.state.comments >= (c.maxPerDay || 0)) {
      return { ok: false, code: 'day-quota', reason: `今天已经评论 ${this.state.comments} 条，上限 ${c.maxPerDay}` };
    }
    const inSession = this.session ? this.state.commentsThisSession || 0 : 0;
    if (this.session && inSession >= (c.maxPerSession || 0)) {
      return { ok: false, code: 'session-quota', reason: `这一次已经说过 ${inSession} 句了，上限 ${c.maxPerSession}` };
    }
    return { ok: true, usedToday: this.state.comments, leftToday: (c.maxPerDay || 0) - this.state.comments };
  }

  /**
   * 内容检查。不是审查，是「别替用户得罪人」。
   * 命中黑名单或超长一律拒绝，理由给出来，让模型自己改写。
   */
  checkCommentText(text) {
    const c = this.policy.comment || {};
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: '空的' };
    if (t.length > (c.maxChars || 40)) {
      return { ok: false, reason: `${t.length} 字，超过上限 ${c.maxChars} 字。短一点更像真人` };
    }
    const hit = (c.avoid || []).find((k) => t.includes(k));
    if (hit) return { ok: false, reason: `碰到不评论的话题「${hit}」`, tryThis: '换个角度夸内容本身，别碰这类话题' };
    // 硬广与引流也挡一下：评论区发链接是封号级操作
    if (/https?:\/\/|www\.|加我|私信我|微信|vx|qq群/i.test(t)) {
      return { ok: false, reason: '看起来像引流/广告，评论区发这个是封号级操作' };
    }
    return { ok: true };
  }

  recordComment() {
    this.state.comments += 1;
    this.state.commentsThisSession = (this.state.commentsThisSession || 0) + 1;
    this._save();
    return this.state.comments;
  }

  /* ---------- 给人和模型看的概要 ---------- */

  describe(now = new Date()) {
    const p = this.policy;
    const w = activeWindow(p, now);
    const c = p.comment || {};
    const lines = [
      `总开关：${p.enabled ? '开' : '关'}`,
      `允许站点：${(p.sites || []).join('、') || '无'}`,
      `允许时段：${(p.windows || []).map((x) => ` ${x} `).join('').trim() || '无'}${w ? `（此刻在时段内，剩 ${w.remainMinutes} 分钟）` : ''}`,
      `单次上限：${p.perSessionMinutes} 分钟｜每天上限：${p.perDayMinutes} 分钟（今天已用 ${this.state.minutes} 分钟）`,
      `两次之间至少隔：${p.minGapMinutes} 分钟`,
      `评论：${c.enabled ? '开' : '关'}${c.enabled ? `（每天 ${c.maxPerDay} 条、每次 ${c.maxPerSession} 条、${c.requireApproval ? '发前必须你点头' : '可直接发'}、${c.maxChars} 字以内）` : ''}`,
      this.session ? `正在刷：${this.session.site}，还剩 ${Math.round(this.sessionLeftMinutes())} 分钟` : '此刻没在刷',
    ];
    return lines.join('\n');
  }
}
