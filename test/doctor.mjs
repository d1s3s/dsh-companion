#!/usr/bin/env node
/**
 * doctor.mjs —— 装完之后先跑这个
 *
 * 它不测「功能对不对」（那是 test/smoke.mjs 的事），只回答一个问题：
 * **这台机器上，她能不能干活？** 缺什么、缺了会影响哪几个工具、怎么补。
 *
 * 每一项单独判，一项挂了不影响后面的检查——因为最常见的现场是
 * 「装了插件、发了消息、没反应」，用户需要一次看到全部缺口，而不是修一个再发现一个。
 *
 *   node test/doctor.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findFfmpeg, probe, NO_FFMPEG, LIMITS } from '../src/capture.js';
import { findBrowser, profileDir } from '../src/browser.js';
import { CAPABILITIES, LEVELS, DEFAULT_LEVELS } from '../src/permissions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const rows = [];
function add(name, ok, detail, fix) {
  rows.push({ name, ok, detail: detail || '', fix: ok ? '' : (fix || '') });
}

/* ---------- 1. Node ---------- */
{
  const major = Number(process.versions.node.split('.')[0]);
  add('Node 版本', major >= 20, `v${process.versions.node}`,
    '需要 Node 20 以上。内置 WebSocket 和 fetch 是从 20 开始稳的，低版本浏览器驱动会挂。');
}

/* ---------- 2. ffmpeg ---------- */
{
  const bin = await findFfmpeg();
  if (bin) {
    const p = await probe();
    add('ffmpeg', p.ok, p.ok ? bin : `找到了但跑不起来：${bin}`,
      '文件在但执行失败，通常是权限或架构不对（比如 arm 机器装了 x64 版）。');
  } else {
    add('ffmpeg', false, '没找到', NO_FFMPEG);
  }
}

/* ---------- 3. 浏览器 ---------- */
{
  const bin = findBrowser();
  add('浏览器（Edge / Chrome）', !!bin, bin || '没找到',
    '装 Edge 或 Chrome 就行；装在别处的用 DSH_COMPANION_BROWSER 环境变量指过去。'
    + '缺这个只影响「她自己刷视频」，其他工具照常。');
}

/* ---------- 4. 窗口读取（Windows 靠 PowerShell） ---------- */
{
  if (process.platform !== 'win32') {
    add('读前台窗口', true, `${process.platform} 用原生方式，无需额外依赖`);
  } else {
    const cands = [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'powershell.exe',
    ];
    const hit = cands.find((c) => c.includes('\\') ? fs.existsSync(c) : true);
    add('读前台窗口（PowerShell）', !!hit, hit || '没找到 powershell.exe',
      'Windows 自带 PowerShell，找不到说明系统目录被裁剪过。缺这个只影响「知道你在刷什么」。');
  }
}

/* ---------- 5. 角色包 ---------- */
{
  const packsDir = path.join(ROOT, 'packs');
  if (!fs.existsSync(packsDir)) {
    add('角色包', true, '没带角色包，用内置手绘鲸鱼');
  } else {
    const packs = fs.readdirSync(packsDir).filter((d) => fs.existsSync(path.join(packsDir, d, 'pet.json')));
    const bad = [];
    for (const p of packs) {
      try { JSON.parse(fs.readFileSync(path.join(packsDir, p, 'pet.json'), 'utf8')); }
      catch (e) { bad.push(`${p}: ${e.message}`); }
    }
    add('角色包', packs.length > 0 && !bad.length,
      `${packs.length} 个（${packs.join(', ')}）${bad.length ? ' 损坏：' + bad.join('; ') : ''}`,
      'pet.json 读不了就是包被改坏了。删掉那个包会自动回落内置鲸鱼。');
  }
}

/* ---------- 6. 配置目录 ---------- */
{
  const home = path.join(os.homedir(), '.dsh-companion');
  let ok = true;
  let why = home;
  try {
    fs.mkdirSync(home, { recursive: true });
    const t = path.join(home, '.write-test');
    fs.writeFileSync(t, 'ok');
    fs.rmSync(t);
  } catch (e) { ok = false; why = `${home} 写不进去：${e.message}`; }
  add('配置目录可写', ok, why,
    '这里存权限、记忆、token 账本、浏览器 profile。写不进去等于她什么都记不住。'
    + '检查盘满没满、有没有被安全软件锁住。');
}

/* ---------- 7. 权限表 ---------- */
{
  const need = Object.keys(CAPABILITIES);
  const missing = need.filter((c) => !DEFAULT_LEVELS[c]);
  const badLevel = Object.entries(DEFAULT_LEVELS).filter(([, v]) => !LEVELS.includes(v));
  add('权限表自洽', !missing.length && !badLevel.length,
    `${need.length} 项能力${missing.length ? '，缺默认值：' + missing.join(',') : ''}${badLevel.length ? '，非法级别：' + badLevel.join(',') : ''}`,
    '这是插件内部 bug，不是你的配置问题。请提 issue 附上这一行输出。');
}

/* ---------- 8. 依赖 ---------- */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  add('外部依赖', deps.length === 0, deps.length ? deps.join(', ') : '零依赖（只用 Node 内置模块）',
    '插件设计成零依赖，出现依赖说明被改过，可能装不上。');
}

/* ---------- 输出 ---------- */
const W = (s) => [...s].reduce((n, ch) => n + (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - W(s)));

const nameW = Math.max(...rows.map((r) => W(r.name))) + 2;
console.log('\n  dsh-companion 环境自检\n');
for (const r of rows) {
  console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${pad(r.name, nameW)}${r.detail}`);
  if (r.fix) console.log(`    ${' '.repeat(nameW)}↳ ${r.fix.replace(/\n/g, '\n      ')}`);
}

const failed = rows.filter((r) => !r.ok);
console.log('');
if (!failed.length) {
  console.log(`  全通。上限参考：看视频 ${LIMITS.videoMaxFrames} 帧/次、`
    + `连看屏幕 ${LIMITS.streamMaxFrames} 帧/次。\n`);
} else {
  console.log(`  ${failed.length} 项缺。带 ↳ 的是补救办法；不影响核心记忆和聊天。\n`);
}

// 有硬缺（node / 配置目录）才算失败退出，其余是能力降级
const hard = rows.filter((r) => !r.ok && (r.name === 'Node 版本' || r.name === '配置目录可写' || r.name === '权限表自洽'));
process.exit(hard.length ? 1 : 0);
