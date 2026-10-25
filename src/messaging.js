/**
 * messaging.js —— 发消息
 *
 * 刻意的设计：**默认不直接发**。
 *
 * 直接替你发出去的消息收不回来，而「以你的名义说话」是最容易出事的一类动作。
 * 所以这里排了三级通道，默认走最保守的那一级：
 *
 *   clipboard  复制到剪贴板，你自己粘            ← 默认
 *   urlscheme  打开你的邮件/短信客户端，你自己按发送   ← 保留人在环里
 *   webhook    直接 POST 出去                    ← 必须显式配置才启用
 *
 * 这不是保守，是因为前两级让「最后一下」由人按下。真出问题时，
 * 差别是你「看了一眼觉得不对」还是「发现时已经发出去了」。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CHANNELS = ['clipboard', 'urlscheme', 'webhook'];

/** 纯起草，不产生任何外部动作，所以不需要权限 */
export function draft({ to, text, channel = 'clipboard', subject }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('消息内容是空的');
  const ch = CHANNELS.includes(channel) ? channel : 'clipboard';

  const url = ch === 'urlscheme' ? buildUrl({ to, subject, text: body }) : null;
  return {
    ok: true,
    channel: ch,
    to: to || null,
    text: body,
    url,
    preview: [
      to ? `收件人：${to}` : null,
      subject ? `标题：${subject}` : null,
      `内容：${body.length > 200 ? body.slice(0, 200) + '…' : body}`,
      `通道：${label(ch)}`,
    ].filter(Boolean).join('\n'),
    hint: ch === 'clipboard' ? '交给 send 才会真正落到剪贴板/客户端'
      : ch === 'urlscheme' ? '交给 send 会打开你本机的客户端，最后一步由你按'
        : '交给 send 会直接 POST 到配置的 webhook',
  };
}

function label(ch) {
  return { clipboard: '复制到剪贴板', urlscheme: '打开本机客户端', webhook: '直接发送' }[ch] || ch;
}

function buildUrl({ to, subject, text }) {
  const t = String(to || '');
  if (/^\+?\d[\d\s-]{5,}$/.test(t) || /^sms:/i.test(t)) {
    const num = t.replace(/^sms:/i, '').replace(/[\s-]/g, '');
    return `sms:${num}${process.platform === 'win32' ? '?body=' : '&body='}${encodeURIComponent(text)}`;
  }
  const q = new URLSearchParams();
  if (subject) q.set('subject', subject);
  q.set('body', text);
  return `mailto:${encodeURIComponent(t)}?${q.toString()}`;
}

/** 真正发出去。调用方必须先过 message.send 权限。 */
export async function send({ channel = 'clipboard', to, text, subject, webhook }) {
  const d = draft({ to, text, channel, subject });

  if (d.channel === 'clipboard') {
    const ok = await toClipboard(d.text);
    return { ok, channel: 'clipboard', done: ok ? '已复制，去粘贴吧' : '复制失败',
      detail: ok ? undefined : '没找到可用的剪贴板命令' };
  }

  if (d.channel === 'urlscheme') {
    const ok = await openUrl(d.url);
    return { ok, channel: 'urlscheme', url: d.url,
      done: ok ? '已打开你的客户端，确认后自己按发送' : '打不开客户端',
      detail: ok ? undefined : d.url };
  }

  // webhook：没有配置就不许发，绝不猜一个地址
  const endpoint = webhook || process.env.DSH_COMPANION_WEBHOOK;
  if (!endpoint) {
    return { ok: false, channel: 'webhook', error: '没有配置 webhook 地址',
      hint: '在插件配置里填 webhook，或用 DSH_COMPANION_WEBHOOK 环境变量' };
  }
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: to || null, subject: subject || null, text: d.text, from: 'dsh-companion' }),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, channel: 'webhook', status: r.status,
      done: r.ok ? '已发送' : '对方拒收，检查 webhook 配置' };
  } catch (e) {
    return { ok: false, channel: 'webhook', error: e.message };
  }
}

/** 剪贴板：走临时文件 + Set-Clipboard，避开命令行编码坑 */
async function toClipboard(text) {
  const tmp = path.join(os.tmpdir(), `dsh-clip-${Date.now()}.txt`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (process.platform === 'win32') {
      // 两处坑：
      // 1) 直接管道给 clip.exe 会被控制台代码页搅乱中文 —— 走 PowerShell 显式 UTF8；
      // 2) node 的 spawn 上下文里 PATH 可能不含 System32，靠命令名找不到 powershell.exe，
      //    必须按绝对路径试。
      const root = process.env.SystemRoot || process.env.windir || 'C:\\WINDOWS';
      const cands = [
        path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'powershell.exe',
      ];
      const ps = `Get-Content -Raw -Encoding UTF8 -LiteralPath '${tmp.replace(/'/g, "''")}' | Set-Clipboard`;
      for (const bin of cands) {
        if (bin.includes('\\') && !fs.existsSync(bin)) continue;
        if (await exec(bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])) {
          return true;
        }
      }
      return false;
    }
    if (process.platform === 'darwin') return await exec('pbcopy', [], text);
    return await exec('xclip', ['-selection', 'clipboard'], text);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

async function openUrl(url) {
  if (process.platform === 'win32') return exec('cmd.exe', ['/c', 'start', '', url]);
  if (process.platform === 'darwin') return exec('open', [url]);
  return exec('xdg-open', [url]);
}

function exec(bin, args, stdin) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(bin, args, { windowsHide: true }); } catch { return resolve(false); }
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
    if (stdin) { p.stdin.write(stdin); p.stdin.end(); }
  });
}
