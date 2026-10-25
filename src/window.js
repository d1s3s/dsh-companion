/**
 * window.js —— 你现在在刷什么
 *
 * 这是整个插件里最便宜的一个能力，也是最容易被忽略的一个。
 *
 * 想陪你刷 B 站、刷抖音，第一反应都是「截屏给我看」。但那是错的：
 *   一张 1920×1080 的图 = 2765 token，一秒一张，刷十分钟 = 166 万 token。
 * 而你真正需要知道的头一件事，只是「她在看什么」——这件事**窗口标题里就有**，
 * 成本 0 token，不用抓一个像素。
 *
 * 所以分三层，从便宜到贵，按需往上走：
 *   1. 窗口标题（这里）        —— 你在哪个平台、看的是哪条  ≈ 0 token
 *   2. 截一帧 screen.snapshot  —— 这一帧长什么样           ≈ 300~2800 token
 *   3. 连着看 screen.stream    —— 这条视频在讲什么          ≈ 帧数 × 单帧
 *
 * 隐私上这仍然是敏感能力：标题能暴露「离职申请 - Word」「某某医院预约」。
 * 所以它单独占一项权限，不藏在截屏底下。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 视频 / 内容平台识别表。先认进程，再认标题关键词。 */
const PLATFORMS = [
  // 客户端：进程名就能定性
  { id: 'douyin', name: '抖音', proc: ['douyin', 'douyinlive', '抖音'] },
  { id: 'bilibili', name: '哔哩哔哩', proc: ['bilibili', '哔哩哔哩'] },
  { id: 'kuaishou', name: '快手', proc: ['kuaishou', '快手'] },
  { id: 'xiaohongshu', name: '小红书', proc: ['xiaohongshu', '小红书'] },
  { id: 'weibo', name: '微博', proc: ['weibo', '微博'] },

  // 网页：只能看标题
  { id: 'bilibili', name: '哔哩哔哩', title: ['哔哩哔哩', 'bilibili', 'b站'] },
  { id: 'douyin', name: '抖音', title: ['抖音', 'douyin'] },
  { id: 'tiktok', name: 'TikTok', title: ['tiktok'] },
  { id: 'kuaishou', name: '快手', title: ['快手', 'kuaishou'] },
  { id: 'xiaohongshu', name: '小红书', title: ['小红书', 'xiaohongshu'] },
  { id: 'youtube', name: 'YouTube', title: ['youtube', '油管'] },
  { id: 'weibo', name: '微博', title: ['微博', 'weibo'] },
  { id: 'zhihu', name: '知乎', title: ['知乎', 'zhihu'] },
  { id: 'douban', name: '豆瓣', title: ['豆瓣', 'douban'] },
];

/** 浏览器进程。标题里有平台关键词的，基本就是浏览器在看。 */
const BROWSERS = ['msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi', 'safari', 'arc', '360se', '360chrome', 'qqbrowser', 'sogouexplorer', 'liebao'];

/**
 * 标题噪音表。Windows 的窗口列表里，绝大多数「标题」是框架内部窗口名，
 * 对判断你在干什么毫无意义，而且很占字数 —— 一条条滤掉。
 */
const NOISE = [
  /^N\/A$/i, /^暂缺$/, /^OleMainThreadWndName$/, /^\.NET-BroadcastEventWindow/i,
  /^Title$/, /^Program Manager$/i, /^Default IME$/i, /^MSCTFIME UI$/i,
  /^GDI\+ Window$/i, /^lse__host__hide$/i, /^Windows Push Notifications/i,
  /^DWM Notification Window$/i, /^Task Host Window$/i, /^BroadcastListenerWindow$/i,
  /^CrossDeviceResumeWindow$/i, /^NvSvc$/i, /^UxdService$/i, /^FNForMonitorMic$/i,
  /^Fn_Hotkey_CapsLKNumLK$/i, /^[0-9A-F]{8,}$/i, /^\{[0-9A-F-]{20,}\}$/i,
  /^[a-z0-9]+(_[a-z0-9]+){2,}$/i,          // clouddrive_desktop_widget 这种内部名
];

/** 浏览器标题尾巴：`XXX - 哔哩哔哩 和另外 33 个页面 - 用户配置 1 - Microsoft Edge` */
const TAIL = [
  /\s+和另外\s*\d+\s*个页面/, /\s+and\s+\d+\s+more\s+pages/i,
  /\s*[-–—]\s*(Microsoft\s*)?Edge\s*$/i, /\s*[-–—]\s*Google Chrome\s*$/i,
  /\s*[-–—]\s*Mozilla Firefox\s*$/i, /\s*[-–—]\s*(个人|用户配置\s*\d+|Profile\s*\d+)\s*$/i,
  /\s*[-–—]\s*Microsoft\u200b?\s*Edge\s*$/i,
];

const isNoise = (t) => !t || t.trim().length < 2 || NOISE.some((re) => re.test(t.trim()));

/** 把浏览器标题扒成「内容名」。`【MV】xxx - 哔哩哔哩 - Microsoft Edge` → `【MV】xxx` */
export function cleanTitle(raw) {
  let t = String(raw || '').trim();
  for (const re of TAIL) t = t.replace(re, '');
  t = t.replace(/\s*[-–—]\s*(Microsoft Edge|Google Chrome|Mozilla Firefox|Edge)\s*$/i, '');
  // 去掉平台名本身和「在 YouTube 观看」这种尾巴
  t = t.replace(/\s*[-–—]\s*(哔哩哔哩|bilibili|抖音|快手|小红书|微博|知乎|豆瓣)\s*$/i, '');
  t = t.replace(/^\(\d+\)\s*/, '');           // 未读计数
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

/** 判平台。进程优先（更准），标题兜底（网页端）。 */
export function classify(app, title) {
  const a = String(app || '').toLowerCase().replace(/\.exe$/, '');
  const t = String(title || '').toLowerCase();

  // 1) 进程名直接命中 —— 抖音客户端这种标题只有「抖音」两个字，全靠进程认
  for (const p of PLATFORMS) {
    if (p.proc && p.proc.some((n) => a === n || a.includes(n))) {
      return { platform: p.id, name: p.name, client: true };
    }
  }
  // 2) 标题命中
  for (const p of PLATFORMS) {
    if (p.title && p.title.some((k) => t.includes(k))) {
      const browser = BROWSERS.some((b) => a.includes(b));
      return { platform: p.id, name: p.name, client: !browser, browser };
    }
  }
  return { platform: null, name: null, browser: BROWSERS.some((b) => a.includes(b)) };
}

/* ------------------------------------------------------------------ */
/* 取窗口列表：三平台                                                        */
/* ------------------------------------------------------------------ */

function run(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, timeout });
    } catch (e) {
      return resolve({ ok: false, error: e.message, out: '' });
    }
    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', () => {});
    child.on('error', (e) => finish({ ok: false, error: e.code || e.message, out }));
    child.on('close', (code) => finish({ ok: code === 0, code, out }));
    // spawn 的 timeout 在部分平台不生效，自己兜一层
    setTimeout(() => { try { child.kill(); } catch { /* 已结束 */ } finish({ ok: false, error: 'timeout', out }); }, timeout + 500);
  });
}

/** 绝对路径找 powershell。node 的 PATH 里通常没有 System32（和剪贴板踩过同一个坑）。 */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 取窗口列表（Windows）。
 *
 * 走 -EncodedCommand 而不是 -File：.ps1 会被 ExecutionPolicy 拦（默认 Restricted，
 * 报「在此系统上禁止运行脚本」），而 -Command / -EncodedCommand 不受那条限制。
 * 也不用 -Command 拼引号 —— 脚本里既有 @" 字面量又有嵌套引号，base64 最省事。
 *
 * 前台窗口靠 30 行 P/Invoke 换。Get-Process 的 MainWindowTitle 只能告诉你
 * 「这个程序有窗口」，不能告诉你「你正在看哪个」；而刷 B 站时 Edge 可能开着
 * 30 个标签、抖音客户端也挂着，不知道哪个在前台就只能猜。
 */
const PS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$sig = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class WCWin {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '}',
  '"@',
  '[uint32]$fg = 0',
  'try {',
  '  Add-Type -TypeDefinition $sig -ErrorAction Stop',
  '  $h = [WCWin]::GetForegroundWindow()',
  '  [void][WCWin]::GetWindowThreadProcessId($h, [ref]$fg)',
  '} catch { $fg = 0 }',
  'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {',
  '  $(if ($_.Id -eq $fg) { "1" } else { "0" }) + [char]1 + $_.ProcessName + [char]1 + $_.MainWindowTitle',
  '}',
].join('\n');

/** 1.5 秒内的重复调用不重开进程。刷视频时模型常常连问两次。 */
const CACHE_MS = 1500;
let cache = { at: 0, rows: null };

async function windowsWindows() {
  if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const ps = powershellPath();
  const b64 = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64]);
  if (!r.out.trim()) return [];

  const rows = [];
  for (const line of r.out.split(/\r?\n/)) {
    const p = line.split('\u0001');
    if (p.length < 3) continue;
    rows.push({ fg: p[0].trim() === '1', app: p[1].trim(), title: p.slice(2).join('\u0001').trim() });
  }
  cache = { at: Date.now(), rows };
  return rows;
}

async function windowsMac() {
  // 一次拿全部可见进程名 + 窗口标题，比逐个 osascript 快得多
  const r = await run('osascript', ['-e', `
    set out to ""
    tell application "System Events"
      repeat with p in (every application process whose visible is true)
        set nm to name of p
        try
          if (count of windows of p) > 0 then
            set out to out & nm & "\\u0001" & (name of window 1 of p) & "\\n"
          end if
        end try
      end repeat
    end tell
    return out`]);
  if (!r.ok) return [];
  const rows = [];
  for (const line of r.out.split(/\r?\n/)) {
    const i = line.indexOf('\u0001');
    if (i <= 0) continue;
    rows.push({ app: line.slice(0, i).trim(), title: line.slice(i + 1).trim() });
  }
  return rows;
}

async function windowsLinux() {
  const r = await run('wmctrl', ['-lp']);
  if (!r.ok) return [];
  const rows = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (m) rows.push({ app: m[3], title: m[5].trim() });
  }
  return rows;
}

/**
 * 列出「有内容」的窗口，按「多可能正在看」排序。
 *
 * 排在前面的：视频平台 > 浏览器 > 其他；同档里标题更长的优先
 * （「抖音」两个字 vs「某条视频 - 哔哩哔哩」，后者信息量大得多）。
 */
export async function listWindows() {
  const plat = process.platform;
  let rows = [];
  try {
    if (plat === 'win32') rows = await windowsWindows();
    else if (plat === 'darwin') rows = await windowsMac();
    else rows = await windowsLinux();
  } catch { rows = []; }

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const raw = String(r.title || '').trim();
    if (isNoise(raw)) continue;
    const title = cleanTitle(raw);
    if (isNoise(title)) continue;
    const c = classify(r.app, raw);
    const key = r.app.toLowerCase() + '|' + title;
    if (seen.has(key)) continue;   // 同一 app 多个窗口同名，只留一条
    seen.add(key);
    out.push({
      app: r.app,
      raw,
      title,
      platform: c.platform,
      platformName: c.name,
      client: !!c.client,
      browser: !!c.browser,
      foreground: !!r.fg,
      // 前台压倒一切。拿不到前台标记时（mac / linux / 退化模式）就按「像不像
      // 你正在看的东西」排：平台 > 浏览器 > 标题信息量大
      score: (r.fg ? 1000 : 0) + (c.platform ? 100 : 0) + (c.browser ? 40 : 0) + Math.min(30, title.length),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 只看视频/内容平台那几条。刷 B 站这件事，答案就在这里面。 */
export async function viewing() {
  const all = await listWindows();
  const media = all.filter((w) => w.platform);
  const fg = all.find((w) => w.foreground) || null;
  // top 的优先级：前台就是视频平台 > 任意视频平台 > 前台 > 第一个
  const top = (fg && fg.platform ? fg : null) || media[0] || fg || all[0] || null;
  return { all, media, fg, top };
}
