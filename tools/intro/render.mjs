/**
 * render.mjs —— 把 tools/intro/index.html 逐帧渲染成 PNG 序列
 *
 * 为什么这么做（而不是 ffmpeg 滤镜画文字）：
 *   介绍片要的是排版、圆角、阴影、渐变——这些在 HTML/CSS 里是一行，
 *   在 ffmpeg drawtext 里是一堆坐标。所以画面用网页做，只借浏览器当渲染器。
 *
 * 为什么不用 puppeteer：只用得到三个 CDP 命令，Node 22 自带 WebSocket，
 *   为这点事发装个 300MB 的依赖不值。和 src/cdp.js 是同一个理由。
 *
 *   node tools/intro/render.mjs            # 全片
 *   node tools/intro/render.mjs 0 3 15     # 只渲染第 0/3/15 秒附近（抽检）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'frames');
const FPS = 30;
const W = 1280;
const H = 720;
const PORT = 9333;

// ---------------------------------------------------------------- 找浏览器
function findBrowser() {
  const cands = [
    process.env.DSH_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function waitDevtools(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await jsonGet(`http://127.0.0.1:${port}/json/version`);
      if (v.webSocketDebuggerUrl) return v;
    } catch { /* 还没起来 */ }
    await sleep(180);
  }
  throw new Error('浏览器没起来（devtools 端口无响应）');
}

// ---------------------------------------------------------------- 极简 CDP
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); res(this); });
      ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP 连接失败')); });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? j(new Error(`${m.error.message}`)) : r(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} 超时`)); }
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------- 主流程
const browser = findBrowser();
if (!browser) {
  console.error('找不到 Edge / Chrome。设 DSH_BROWSER=<exe 路径> 再跑。');
  process.exit(1);
}

const pageUrl = 'file:///' + path.join(HERE, 'index.html').replace(/\\/g, '/');
const profile = path.join(os.tmpdir(), 'dsh-intro-profile');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log(`浏览器  ${browser}`);
console.log(`页面    ${pageUrl}`);

const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: 'ignore' });

let cdp;
try {
  await waitDevtools(PORT);

  // 不靠启动参数带 URL——实测会被「同步确认」之类的页面抢走，
  // 且干净 profile 首启时目标页面会晚到。改成自己开一个 target 最稳。
  let target = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
    if (r.ok) target = await r.json();
  } catch { /* 老版本只支持 GET，下面兜底 */ }
  if (!target) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(pageUrl)}`);
    if (r.ok) target = await r.json();
  }
  if (!target) {
    for (let i = 0; i < 40; i++) {
      const list = await jsonGet(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (target) break;
      await sleep(150);
    }
  }
  if (!target) throw new Error('没找到页面 target');

  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: pageUrl });

  // 等页面脚本就绪
  for (let i = 0; i < 60; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'window.__ready === true' });
    if (r.result?.value === true) break;
    await sleep(120);
  }

  const total = await cdp.send('Runtime.evaluate', { expression: 'window.TOTAL' });
  const TOTAL = total.result.value;
  const args = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));

  let frames;
  if (args.length) {
    frames = args.map((s) => Math.round(s * FPS));
    console.log(`抽检模式：${args.join(' / ')} 秒 → ${frames.length} 帧`);
  } else {
    frames = Array.from({ length: Math.round(TOTAL * FPS) }, (_, i) => i);
    console.log(`全片 ${TOTAL}s × ${FPS}fps = ${frames.length} 帧`);
  }

  const t0 = Date.now();
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const t = f / FPS;
    await cdp.send('Runtime.evaluate', {
      expression: `window.setFrame(${t}); 'ok'`,
      returnByValue: true,
    });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    const name = `f${String(f).padStart(5, '0')}.png`;
    fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
    if ((k + 1) % 30 === 0 || k === frames.length - 1) {
      const el = (Date.now() - t0) / 1000;
      const per = el / (k + 1);
      process.stdout.write(`\r  ${k + 1}/${frames.length} 帧  ${per.toFixed(3)}s/帧  剩余 ${Math.round(per * (frames.length - k - 1))}s   `);
    }
  }
  console.log(`\n完成，共 ${frames.length} 帧 → ${OUT}`);
} finally {
  if (cdp) cdp.close();
  child.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}
