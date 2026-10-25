/**
 * smoke.mjs —— 不装 DSH 也能验的部分
 *
 * 用一个假 ctx 把插件跑起来，验证：注册得出工具、权限拦得住、采集真出图、
 * 记忆真读写、token 真记账。真机上要验的只剩「钩子名对不对」这一件。
 *
 * 跑法：node test/smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugin from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '..', '.tmp', 'smoke');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const memSrc = path.join(here, '..', '..', 'memory');
const memDst = path.join(tmp, 'memory');
if (fs.existsSync(memSrc)) fs.cpSync(memSrc, memDst, { recursive: true });

let approve = 'allowed-once';
const mkCtx = (withApproval = true) => {
  const tools = new Map();
  const hooks = [];
  const ctx = {
    logger: { info: (m) => console.log('  [log]', m), warn: (m) => console.log('  [warn]', m) },
    tools: { register: (spec) => tools.set(spec.name, spec) },
    on: (h, fn) => hooks.push([h, fn]),
  };
  if (withApproval) ctx.approval = { request: async () => approve };
  return { ctx, tools, hooks };
};

const { ctx, tools, hooks } = mkCtx();
console.log('=== 1. 加载 ===');
plugin.apply(ctx, { home: path.join(tmp, 'home'), memoryDir: memDst, profile: 'tender' });
console.log('  注册工具 %d 个', tools.size);
console.log('  挂上钩子 %d 个：%s', hooks.length, hooks.map((h) => h[0]).join(' '));

const run = async (name, args = {}, c = ctx) => {
  const t = tools.get(name);
  if (!t) return { ok: false, error: '工具不存在' };
  try { return await t.execute(args, c); } catch (e) { return { ok: false, error: '抛异常：' + e.message }; }
};

const p = (r) => String(r.note || r.done || r.error || r.reason || '')
  .split('\n').filter(Boolean).slice(0, 6).join('\n      ');

console.log('\n=== 2. 开场注入（带 token） ===');
console.log('     ', p(await run('companion_brief')));

console.log('\n=== 3. 权限清单（中文对齐） ===');
console.log('     ', p(await run('companion_permission', { action: 'list' })));

console.log('\n=== 4. 截屏：真抓 + 真算 token ===');
const shot = await run('companion_see_screen', { maxWidth: 960 });
console.log('     ', shot.ok ? `出图 ${shot.width}×${shot.height}，${Math.round(shot.image.length * 0.75 / 1024)}KB` : shot.error);
console.log('     ', p(shot));

console.log('\n=== 5. 连看：先授权再花 ===');
const up = await run('companion_permission', { action: 'set', capability: 'screen.stream', level: 'always' });
console.log('      授权 screen.stream →', up.ok ? up.note : up.error);
const watch = await run('companion_watch_screen', { seconds: 3, fps: 1, maxWidth: 800 });
console.log('     ', watch.ok ? `${watch.count} 帧（${watch.stoppedBy}）` : watch.error);
console.log('     ', p(watch));

console.log('\n=== 6. 超预算时应该拒绝并给出更省的方案 ===');
const big = await run('companion_watch_screen', { seconds: 120, fps: 2, maxWidth: 1280 });
console.log('     ', big.ok ? '放过了 ' + big.count + ' 帧（该拦没拦）' : big.error);
if (!big.ok && big.tryThis) console.log('      建议：', big.tryThis);

console.log('\n=== 7. 回忆（读 Python 写的记忆） ===');
console.log('     ', p(await run('companion_recall', { keywords: '记忆 权限', limit: 2 })));

console.log('\n=== 8. 写记忆 ===');
console.log('     ', p(await run('companion_remember', {
  title: '插件冒烟测试',
  facts: 'Node 插件能写进同一套 raw/索引。',
  belief: '原以为两边格式会打架；现知道按 raw 格式写就互通。',
  section: '测试',
})));

console.log('\n=== 9. 发消息（默认走剪贴板） ===');
console.log('     ', p(await run('companion_send_message', { text: '陪伴助手冒烟测试：中文是否正常？123' })));

console.log('\n=== 10. 权限拦截四条 ===');
approve = 'denied';
const d1 = await run('companion_see_screen', {});
console.log('      用户点拒绝 →', d1.ok ? '放过了（不对）' : (d1.error || d1.reason));

approve = 'allowed-once';
const { ctx: noAsk, tools: t2 } = mkCtx(false);
plugin.apply(noAsk, { home: path.join(tmp, 'home2'), memoryDir: memDst });
const d2 = await t2.get('companion_permission').execute(
  { action: 'set', capability: 'camera.stream', level: 'always' }, noAsk);
console.log('      没有审批服务时自己放权 →', d2.ok ? '成了（不对）' : d2.error);

const d3 = await run('companion_permission', { action: 'set', capability: 'message.send', level: 'deny' });
console.log('      自己收权 →', d3.ok ? d3.note : d3.error);

const d4 = await run('companion_permission', { action: 'set', capability: 'microphone', level: 'always' });
console.log('      放权高风险（用户同意）→', d4.ok ? d4.note : d4.error);

console.log('\n=== 11. token 账本 ===');
console.log((await run('companion_cost')).note.split('\n').map((l) => '     ' + l).join('\n'));

console.log('\n=== 12. 审计日志 ===');
const audit = path.join(tmp, 'home', 'audit.jsonl');
if (fs.existsSync(audit)) {
  const lines = fs.readFileSync(audit, 'utf8').trim().split('\n');
  console.log('      %d 条，最后四条：', lines.length);
  for (const l of lines.slice(-4)) {
    const r = JSON.parse(l);
    console.log(`        ${String(r.kind).padEnd(7)}${String(r.cap || '').padEnd(18)}${r.reason || ''}`);
  }
}

console.log('\n=== 13. 角色包（真读大肥鱼图集） ===');
const t0 = Date.now();
const { ctx: c2, tools: t3 } = mkCtx();
plugin.apply(c2, {
  home: path.join(tmp, 'home3'), memoryDir: memDst,
  characterPack: 'packs/bigfish-classic', characterSize: 170,
});
const ch = await t3.get('companion_character').execute({}, c2);
console.log('      载入耗时 %d ms', Date.now() - t0);
console.log('     ', p(ch));
const chBad = await (async () => {
  const { ctx: c3, tools: t4 } = mkCtx();
  plugin.apply(c3, { home: path.join(tmp, 'home4'), memoryDir: memDst, characterPack: 'packs/不存在' });
  return t4.get('companion_character').execute({}, c3);
})();
console.log('      坏路径不应崩 →', chBad.ok ? chBad.source : chBad.error);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n清理完成');
