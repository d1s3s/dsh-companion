/**
 * capture.js —— 看世界
 *
 * 为什么走 ffmpeg 而不是 Electron API：
 * DSH Desktop 的 Electron 外壳把摄像头/麦克风权限硬拒绝了（issue #655，白名单只有
 * 剪贴板和通知），所以浏览器端 getUserMedia 走不通。宿主端调系统接口才是唯一可用的路。
 * ffmpeg 一个二进制覆盖三平台：Windows 走 gdigrab/dshow，mac 走 avfoundation，Linux 走 x11grab/v4l2。
 *
 * 三条硬规矩，写死在代码里而不是交给调用方：
 *   1. 持续采集必须有秒数上限，到点自己停 —— 不许出现「一直开着」的调用。
 *   2. 抓到的帧落在临时目录，默认用完即删，不留在记忆库里。
 *   3. 默认缩到 1280 宽。原图一帧就是一两千 token，看图不是看高清。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

/** 硬上限。调用方传更大的值会被压回这里，不接受协商。 */
export const LIMITS = {
  snapshotSeconds: 10,
  streamMaxSeconds: 300,
  streamMaxFrames: 60,
  maxWidth: 1280,
  videoMaxSeconds: 1800,  // 一次最多看半小时素材
  videoMaxFrames: 40,     // 再多就不是「看懂了」，是在烧钱
};

/**
 * 常见装法，按「最可能命中」排。都试不通就用 PATH 里的 ffmpeg。
 *
 * 注意 LOCALAPPDATA 不一定在：node 从 shell 继承环境，Git Bash / MSYS 下
 * 这个变量常常是 undefined，而 WinGet 恰恰只往那个目录里塞 Links。
 * 所以必须再用 homedir 拼一遍 —— 这里踩过：只信 LOCALAPPDATA 会「装了也找不到」。
 */
const CANDIDATES = [
  process.env.FFMPEG_PATH,
  'ffmpeg',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')
    : null,
  path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  process.env.ProgramData ? path.join(process.env.ProgramData, 'chocolatey', 'bin', 'ffmpeg.exe') : null,
  path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

let cached = null;
let probed = false;
let probing = null;

/** 没装 ffmpeg 时的统一说法。给「怎么修」，不给「出错了」。 */
export const NO_FFMPEG = '这台机器上没有可用的 ffmpeg，所以看屏幕、摄像头、看视频都用不了。'
  + '装一个就行：Windows 用 `winget install Gyan.FFmpeg`，macOS 用 `brew install ffmpeg`，'
  + 'Linux 用发行版的包管理器。装完不用重启，下次调用会自动认到；'
  + '装在奇怪位置的，把它的完整路径写进环境变量 FFMPEG_PATH。';

/**
 * 找 ffmpeg。不能靠「PATH 里有这个命令名」就断定可用——
 * 必须真的跑一次 -version，跑通了才算。否则等到截屏那一刻才发现找不到，
 * 用户看到的是「助手不会用摄像头」而不是「你没装 ffmpeg」。
 *
 * 全部失败时返回 null，**不返回 'ffmpeg' 兜底**。返回一个假名字的后果是：
 * 后面 spawn 报 ENOENT，看起来像代码坏了，而不是像少装了个软件。
 */
export async function findFfmpeg() {
  if (probed) return cached;
  if (probing) return probing;
  probing = (async () => {
    for (const c of CANDIDATES) {
      if (!c) continue;
      const isPath = c.includes('/') || c.includes('\\');
      if (isPath && !fs.existsSync(c)) continue;
      try {
        const r = spawnSync(c, ['-version'], { timeout: 6000, windowsHide: true, encoding: 'utf8' });
        if (r.status === 0 && /ffmpeg version/i.test((r.stdout || '') + (r.stderr || ''))) {
          return c;
        }
      } catch { /* 试下一个 */ }
    }
    return null;
  })();
  cached = await probing;
  probing = null;
  probed = true;
  return cached;
}

function run(args, { timeoutMs = 60_000 } = {}) {
  return new Promise(async (resolve) => {
    const bin = await findFfmpeg();
    if (!bin) return resolve({ code: -1, out: '', err: NO_FFMPEG, noFfmpeg: true });
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout?.on('data', (d) => { out += d.toString(); });
    p.stderr?.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: '', err: String(e), noFfmpeg: /ENOENT/.test(String(e)) });
    });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

export async function probe() {
  const bin = await findFfmpeg();
  if (!bin) return { ok: false, bin: null, version: '', raw: NO_FFMPEG, hint: NO_FFMPEG };
  const r = await run(['-version'], { timeoutMs: 8000 });
  const line = (r.out || r.err).split('\n')[0] || '';
  return { ok: r.code === 0 && /ffmpeg version/i.test(line), bin, version: line.trim(), raw: r.err.slice(0, 400) };
}

/** 平台相关输入参数 */
function screenInput(region) {
  const p = process.platform;
  if (p === 'win32') return ['-f', 'gdigrab', '-i', 'desktop'];
  if (p === 'darwin') return ['-f', 'avfoundation', '-capture_cursor', '0', '-i', '1:none'];
  return ['-f', 'x11grab', '-i', (process.env.DISPLAY || ':0.0')];
}

function cameraInput(device) {
  const p = process.platform;
  if (p === 'win32') return ['-f', 'dshow', '-i', `video=${device || 'default'}`];
  if (p === 'darwin') return ['-f', 'avfoundation', '-i', `${device || '0'}:none`];
  return ['-f', 'v4l2', '-i', device || '/dev/video0'];
}

/** 统一裁剪 + 缩放。按平台分三套参数太脆，抓全屏再裁最稳。 */
function vf(region, maxWidth = LIMITS.maxWidth) {
  const chain = [];
  if (region && region.w && region.h) {
    const x = Math.max(0, region.x | 0), y = Math.max(0, region.y | 0);
    chain.push(`crop=${region.w | 0}:${region.h | 0}:${x}:${y}`);
  }
  chain.push(`scale='min(${maxWidth},iw)':-2`);
  return chain.join(',');
}

function tmpdir(tag) {
  const d = path.join(os.tmpdir(), 'dsh-companion', `${tag}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 截一张屏。返回文件路径 + 尺寸。 */
export async function grabScreen({ region, maxWidth } = {}) {
  const dir = tmpdir('screen');
  const out = path.join(dir, 'shot.jpg');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...screenInput(region),
    '-frames:v', '1',
    '-vf', vf(region, maxWidth),
    '-q:v', '3',
    out,
  ];
  const r = await run(args, { timeoutMs: LIMITS.snapshotSeconds * 1000 });
  if (!fs.existsSync(out)) {
    const bin = await findFfmpeg();
    if (!bin) return { ok: false, error: NO_FFMPEG, noFfmpeg: true, detail: NO_FFMPEG };
    return { ok: false, error: '截屏失败', detail: (r.err || r.out || '').slice(-400), bin };
  }
  return { ok: true, file: out, bytes: fs.statSync(out).size, hint: '把 file 交给能看图的模型读取' };
}

/** 开一次摄像头。device 是 dshow 设备名，win 上可用 listCameras() 查。 */
export async function grabCamera({ device, maxWidth } = {}) {
  const dir = tmpdir('camera');
  const out = path.join(dir, 'shot.jpg');
  const args = [
    // 摄像头比截屏容易失败得多（设备被占用、驱动没起、隐私设置拦了），
    // 所以这里放开 loglevel 到 warning —— 报错不带原因等于没报错
    '-hide_banner', '-loglevel', 'warning', '-y',
    ...cameraInput(device),
    '-frames:v', '1',
    '-vf', vf(null, maxWidth),
    '-q:v', '3',
    out,
  ];
  const r = await run(args, { timeoutMs: 15_000 });
  if (!fs.existsSync(out)) {
    const bin = await findFfmpeg();
    if (!bin) return { ok: false, error: NO_FFMPEG, noFfmpeg: true };
    return {
      ok: false,
      error: '摄像头打不开',
      detail: (r.err || r.out || '').slice(-400),
      hint: '先调 listCameras 看设备名；Windows 上需要系统隐私设置里允许桌面应用使用摄像头',
    };
  }
  return { ok: true, file: out, bytes: fs.statSync(out).size };
}

/** 枚举摄像头。Windows 上 ffmpeg 把设备列表打到 stderr，得从那儿抠。 */
export async function listCameras() {
  const p = process.platform;
  let args;
  if (p === 'win32') args = ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
  else if (p === 'darwin') args = ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  else args = ['-hide_banner', '-f', 'v4l2', '-list_devices', 'true', '-i', '/dev/null'];

  const r = await run(args, { timeoutMs: 15_000 });
  if (r.noFfmpeg) return { ok: false, error: NO_FFMPEG, noFfmpeg: true, cameras: [] };
  const text = r.err + r.out;
  const names = [];
  for (const line of text.split('\n')) {
    const m = line.match(/"([^"]+)"/g);
    if (m && /(video|Video|摄像头|Camera)/i.test(line)) {
      for (const s of m) names.push(s.replace(/"/g, ''));
    }
  }
  return { ok: true, cameras: [...new Set(names)], raw: names.length ? undefined : text.slice(-300) };
}

/**
 * 看一段屏幕。这是"刷视频"的底层能力。
 * seconds 和 frames 都会被压到上限内；到点或到帧数就停，不会无限跑。
 */
export async function watchScreen({ seconds = 10, fps = 1, frames, region, maxWidth } = {}) {
  const secs = Math.min(Math.max(1, Number(seconds) || 10), LIMITS.streamMaxSeconds);
  const cap = Math.min(Math.max(1, Number(frames) || Math.ceil(secs * Math.min(fps || 1, 2))),
    LIMITS.streamMaxFrames);
  const dir = tmpdir('watch');
  const pattern = path.join(dir, 'f%03d.jpg');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...screenInput(region),
    '-t', String(secs),
    '-vf', `fps=${Math.min(Math.max(0.2, fps || 1), 2)},${vf(region, maxWidth)}`,
    '-frames:v', String(cap),
    '-q:v', '4',
    pattern,
  ];
  const r = await run(args, { timeoutMs: (secs + 15) * 1000 });

  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f))
    : [];
  if (!files.length) {
    if (r.noFfmpeg) return { ok: false, error: NO_FFMPEG, noFfmpeg: true };
    return { ok: false, error: '没抓到帧', detail: (r.err || r.out || '').slice(-400) };
  }
  return {
    ok: true,
    files,
    count: files.length,
    seconds: secs,
    stoppedBy: files.length >= cap ? 'fps×上限' : '时间到',
    hint: '按时间顺序看这几帧，别逐帧描述，只说变化和值得注意的东西',
  };
}

/** 视频基本信息。from 是「想从哪儿开始看」用的，所以时长和编码都得先知道。 */
export async function videoInfo(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' };
  const r = await run(['-hide_banner', '-i', file], { timeoutMs: 20_000 });
  const t = r.err + r.out;
  const d = t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = t.match(/Video:\s*([^,\n]+)/);
  const sz = t.match(/,\s*(\d{2,5})x(\d{2,5})/);
  return {
    ok: true,
    file,
    bytes: fs.statSync(file).size,
    durationSec: d ? Math.round(+d[1] * 3600 + +d[2] * 60 + +d[3]) : null,
    codec: v ? v[1].trim() : null,
    width: sz ? +sz[1] : null,
    height: sz ? +sz[2] : null,
  };
}

/**
 * 看一段本地视频：抽帧，不是解码全部。
 * 「真看懂视频」的关键是抽帧策略——六路互补（字幕/弹幕/热评/画面…）那种是另一回事，
 * 这里只做最基础也最通用的一路：按秒均匀取样，让模型自己说发生了什么。
 * start 支持从中间某处开始，长视频不用从头看。
 */
export async function videoFrames({ file, start = 0, seconds, fps = 0.5, frames, maxWidth } = {}) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在：' + (file || '（没给路径）') };
  const info = await videoInfo(file);
  const total = info.durationSec || null;
  const from = Math.max(0, Number(start) || 0);
  const secs = Math.min(
    Math.max(1, Number(seconds) || Math.min(total ? total - from : 60, 120)),
    LIMITS.videoMaxSeconds,
  );
  const rate = Math.min(Math.max(0.05, Number(fps) || 0.5), 2);
  const cap = Math.min(Math.max(1, Number(frames) || Math.ceil(secs * rate)), LIMITS.videoMaxFrames);

  const dir = tmpdir('video');
  const pattern = path.join(dir, 'f%03d.jpg');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(from),          // 放在 -i 前面：快速定位，不用从头解
    '-t', String(secs),
    '-i', file,
    '-vf', `fps=${rate},${vf(null, maxWidth)}`,
    '-frames:v', String(cap),
    '-q:v', '4',
    pattern,
  ];
  const r = await run(args, { timeoutMs: Math.min(300_000, (secs / 4 + 40) * 1000) });
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f))
    : [];
  if (!files.length) {
    if (r.noFfmpeg) return { ok: false, error: NO_FFMPEG, noFfmpeg: true, info };
    return { ok: false, error: '抽帧失败', detail: (r.err || r.out || '').slice(-400), info };
  }
  return {
    ok: true,
    files,
    count: files.length,
    start: from,
    seconds: secs,
    fps: rate,
    info,
    stoppedBy: files.length >= cap ? '帧数上限' : '时间到',
    hint: '按时间顺序看，别逐帧描述；只说剧情推进、画面变化和值得注意的细节',
  };
}

/** 用完就删。抓到的画面不属于记忆，留在盘上是风险。 */
export function cleanup(files) {
  const dirs = new Set();
  for (const f of [].concat(files || [])) dirs.add(path.dirname(f));
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
