/**
 * app-drive.js —— 在桌面 App 里刷（抖音客户端这类）
 *
 * 网页版能做全套（读 DOM、滚、评论），客户端什么都读不到：
 * 它是自绘窗口，没有 DOM、没有无障碍树、没有公开接口。
 * 所以这里只做一件最小的事：**往当前前台窗口发滚轮**。
 *
 * 为什么只发滚轮、不发点击：
 *   滚轮最坏的结果是「页面滚了一下」，可以撤销、也不改变任何数据；
 *   点击最坏的结果是点掉一条视频、关注一个人、发出一条评论。
 *   在什么都看不见（读不到控件内容）的前提下发点击，等于闭眼乱按。
 *   所以她的 App 操作到此为止——看得见的是网页那边，能评论的也是那边。
 *
 * 每滚一次都先确认前台真的是那个 App。用户切去看代码了，
 * 滚轮就该滚代码，而不是偷偷滚走他的编辑器。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const PS_SIG = [
  '$sig = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class WCMouse {',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $sig -ErrorAction Stop',
].join('\n');

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPs(script, timeout = 8000) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    let out = '';
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => fin({ ok: false, error: e.code || e.message }));
    child.on('close', (code) => fin({ ok: code === 0, code, out: out.trim() }));
    setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } fin({ ok: false, error: 'timeout' }); }, timeout);
  });
}

/** 只允许滚这些客户端的窗口 */
const APP_OK = /douyin|kuaishou|bilibili|抖音|快手|哔哩/i;

/**
 * 在指定 App 的前台窗口里滚。
 *
 * @param appRe 前台进程名/标题必须匹配这个正则，否则拒绝（防止滚错窗口）
 * @param dy    正数 = 往上（看前一条），负数 = 往下（看下一条）
 * @param times 滚几次
 */
export async function appScroll({ appRe = APP_OK, dy = -120, times = 1, foreground = null } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: `App 滚动目前只做了 Windows（当前 ${process.platform}）`, hint: 'macOS 上可以走 AppleScript 的 key code 125，还没实现' };
  }
  if (!foreground) return { ok: false, error: '没拿到前台窗口信息，拒绝盲滚' };

  const label = `${foreground.app || ''} ${foreground.title || ''}`;
  if (!appRe.test(label)) {
    return {
      ok: false, error: `前台不是视频 App（现在是 ${foreground.app || '未知'}：${(foreground.title || '').slice(0, 30)}）`,
      tryThis: '把抖音/快手客户端切到最前面，再让我滚。别人的窗口我不动。',
    };
  }

  const n = Math.min(Math.max(1, Number(times) || 1), 10);
  const delta = Math.min(Math.max(-1200, Math.round(Number(dy) || -120)), 1200);

  // 一条命令里循环，不反复起进程（每次 600ms 太浪费）
  const loop = Array.from({ length: n }, () => `[WCMouse]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero); Start-Sleep -Milliseconds 220`).join('\n');
  const script = `${PS_SIG}\n${loop}\n"OK"`;
  const r = await runPs(script);
  if (!r.ok || !r.out.includes('OK')) {
    return { ok: false, error: `发滚轮失败：${(r.out || r.error || '').slice(0, 200)}` };
  }
  return { ok: true, times: n, delta, app: foreground.app, title: foreground.title };
}

/** 这个平台上 App 操作可用吗 */
export function appDriveAvailable() {
  return process.platform === 'win32';
}
