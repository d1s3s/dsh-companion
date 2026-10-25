/**
 * policy.test.mjs —— 时段与配额的验收
 *
 * 这些逻辑的错法都很安静：时段算错 = 她永远不刷或者一直刷；
 * 额度算错 = 一天刷掉三小时。所以每一条都单独验。
 *
 *   node test/policy.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { BrowsePolicy, parseWindow, activeWindow, DEFAULT_POLICY } from '../src/browse-policy.js';

const tmp = path.resolve('./.tmp/policytest');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const at = (h, m = 0) => new Date(2026, 9, 25, h, m, 0);

console.log('\n=== 1. 时段解析 ===');
t('普通时段', () => {
  const w = parseWindow('12:30-13:30');
  assert.equal(w.start, 750);
  assert.equal(w.end, 810);
  assert.equal(w.cross, false);
});
t('跨午夜时段', () => {
  const w = parseWindow('22:00-01:30');
  assert.equal(w.start, 1320);
  assert.equal(w.end, 90);
  assert.equal(w.cross, true, '结束时间早于开始 = 跨午夜');
});
t('全角破折号也算', () => {
  assert.ok(parseWindow('09:00–10:00'));
});
t('非法格式返回 null', () => {
  assert.equal(parseWindow('12:30'), null);
  assert.equal(parseWindow('25:00-26:00'), null);
  assert.equal(parseWindow(''), null);
  assert.equal(parseWindow('abc'), null);
});

console.log('\n=== 2. 当前在不在时段内 ===');
const p = { ...DEFAULT_POLICY, windows: ['12:30-13:30', '22:00-01:30'] };
t('12:45 命中午间时段', () => {
  const w = activeWindow(p, at(12, 45));
  assert.ok(w);
  assert.equal(w.remainMinutes, 45);
});
t('12:00 不在时段', () => assert.equal(activeWindow(p, at(12, 0)), null));
t('23:00 命中跨午夜时段，剩 150 分钟', () => {
  const w = activeWindow(p, at(23, 0));
  assert.ok(w);
  assert.equal(w.remainMinutes, 150, '22:00 到 01:30 是 210 分钟，23:00 进去还剩 150');
});
t('00:30 仍然命中跨午夜时段，剩 60 分钟', () => {
  const w = activeWindow(p, at(0, 30));
  assert.ok(w);
  assert.equal(w.remainMinutes, 60);
});
t('02:00 已经出来了', () => assert.equal(activeWindow(p, at(2, 0)), null));

console.log('\n=== 3. 四道闸 ===');
t('总开关关着 → off', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, enabled: false } });
  const c = b.canStart(at(12, 45));
  assert.equal(c.ok, false);
  assert.equal(c.code, 'off');
});
t('不在时段 → out-of-window，并给出下次可刷时间', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, enabled: true, windows: ['12:30-13:30'] } });
  const c = b.canStart(at(15, 0));
  assert.equal(c.code, 'out-of-window');
  assert.ok(c.nextAt, '要给 nextAt，用户才知道几点能刷');
  assert.ok(new Date(c.nextAt).getHours() === 12, '下次应该是明天 12:30');
});
t('正常时段内可以刷，时长取三者最小', () => {
  const b = new BrowsePolicy({
    home: tmp,
    policy: { ...DEFAULT_POLICY, enabled: true, windows: ['12:00-14:00'], perSessionMinutes: 15, perDayMinutes: 45 },
  });
  const c = b.canStart(at(13, 0));
  assert.equal(c.ok, true);
  assert.equal(c.minutes, 15, '单次上限 15 分钟');
});
t('时段只剩 5 分钟 → 只能刷 5 分钟', () => {
  const b = new BrowsePolicy({
    home: tmp,
    policy: { ...DEFAULT_POLICY, enabled: true, windows: ['12:00-13:05'], perSessionMinutes: 15 },
  });
  const c = b.canStart(at(13, 0));
  assert.equal(c.minutes, 5, '不能被时段截断成负的，也不能超时段');
});

console.log('\n=== 4. 记账与额度 ===');
// start()/stop() 用真实时钟（这是对的：真实使用时不该能「假装现在是 13 点」），
// 所以这两条测试的窗口要能覆盖此刻。
const ALWAYS = ['00:00-23:59'];

t('刷完记账，日额度下降', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, enabled: true, windows: ALWAYS, perSessionMinutes: 15, perDayMinutes: 45, minGapMinutes: 90 } });
  const st = b.start('bilibili');
  assert.equal(st.ok, true, `start 失败：${st.reason || st.code}`);
  // 假装刷了 8 分钟
  b.session.startedAt = Date.now() - 8 * 60000;
  const s = b.stop();
  assert.equal(s.minutes, 8);
  assert.equal(b.state.minutes, 8);

  const c = b.canStart(at(13, 0));
  assert.equal(c.code, 'gap', '刚刷完要隔 90 分钟');
  assert.ok(c.reason.includes('90'));
});
t('日额度用完 → day-quota', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, enabled: true, windows: ALWAYS, perDayMinutes: 20, minGapMinutes: 0 } });
  b.state.minutes = 20;
  const c = b.canStart(at(13, 0));
  assert.equal(c.code, 'day-quota');
});
t('到点自动停', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, enabled: true, windows: ALWAYS, perSessionMinutes: 5, minGapMinutes: 0 } });
  const st = b.start('douyin');
  assert.equal(st.ok, true, `start 失败：${st.reason || st.code}`);
  b.session.startedAt = Date.now() - 6 * 60000;
  const e = b.expired();
  assert.ok(e && e.expired, '超时应该自己停');
  assert.equal(b.session, null);
});

console.log('\n=== 5. 评论：独立开关与内容检查 ===');
t('评论默认关', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY } });
  assert.equal(b.canComment().code, 'off');
});
t('超长被挡', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, comment: { ...DEFAULT_POLICY.comment, enabled: true, maxChars: 20 } } });
  const r = b.checkCommentText('这条评论写了特别特别多的字已经超过二十个字的上限了');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('20'));
});
t('话题黑名单生效', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, comment: { ...DEFAULT_POLICY.comment, enabled: true } } });
  assert.equal(b.checkCommentText('这个政治话题我不聊').ok, false);
});
t('引流/广告被挡', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, comment: { ...DEFAULT_POLICY.comment, enabled: true } } });
  assert.equal(b.checkCommentText('加我微信领资料').ok, false);
  assert.equal(b.checkCommentText('看 https://x.com').ok, false);
});
t('正常夸奖能过', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, comment: { ...DEFAULT_POLICY.comment, enabled: true } } });
  const r = b.checkCommentText('这个剪辑节奏太好了，学到不少');
  assert.equal(r.ok, true);
});
t('每日评论额度递减', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, comment: { ...DEFAULT_POLICY.comment, enabled: true, maxPerDay: 2 } } });
  assert.equal(b.canComment().ok, true);
  b.recordComment();
  b.recordComment();
  assert.equal(b.canComment().code, 'day-quota');
});

console.log('\n=== 6. 人话描述 ===');
t('describe 能说清现在能不能刷', () => {
  const b = new BrowsePolicy({ home: tmp, policy: { ...DEFAULT_POLICY, enabled: true, windows: ['12:00-14:00'] } });
  const s = b.describe(at(13, 0));
  assert.ok(s.includes('总开关：开'));
  assert.ok(/此刻在时段内|这一刻/.test(s) || s.includes('剩'), '应提到当前在时段内');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
