/**
 * models.js —— 接别人的脑子
 *
 * 这个文件只做一件事：把「你有一个问题」翻译成三家 API 各自的样子，再把回答翻译回一句话。
 * 零依赖，只用 fetch（Node 20+ 自带）。
 *
 * 为什么要这一层：
 *   陪伴助手有几件事必须自己会想，不能等宿主调它——
 *   刷完一堆视频要判断哪条值得留；评论草稿要说人话；看了一帧要知道「他在干嘛」。
 *   这些以前靠硬编码关键词，效果很差。接上模型才像回事。
 *
 * 三家的脾气不一样，记住这几条能省很多时间：
 *   · OpenAI / 千问（DashScope 兼容模式）：形状几乎一样，一个 style 覆盖两家。
 *   · Anthropic：结构不同（system 是顶层字段，不在 messages 里），
 *     而且 **必须** 带 anthropic-version 头，不带直接 400。
 *   · 千问的兼容模式在中国大陆直连很快；官方 OpenAI/Anthropic 端点可能需要代理，
 *     所以 base 可以覆盖（见 PROVIDERS.*.baseEnv）。
 *
 * 密钥只从环境变量或 ~/.dsh-companion/keys.json 读，**绝不写进代码、绝不进日志**。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 三家（外加一家顺手的）                                                 */
/* ------------------------------------------------------------------ */

/**
 * price 是「元 / 百万 token」的量级参考，只要够算账就行，不需要精确。
 * 各家都会调价，所以这里只用来给用户一个体感，不做财务结算。
 */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    baseEnv: 'OPENAI_BASE_URL',
    keyEnv: ['OPENAI_API_KEY'],
    style: 'openai',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    defaultModel: 'gpt-4o-mini',
    price: { in: 1.0, out: 4.0 },
  },
  anthropic: {
    label: 'Claude',
    base: 'https://api.anthropic.com/v1',
    baseEnv: 'ANTHROPIC_BASE_URL',
    keyEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    style: 'anthropic',
    models: ['claude-3-5-haiku-latest', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-latest'],
    defaultModel: 'claude-3-5-haiku-latest',
    price: { in: 1.0, out: 5.0 },
  },
  qwen: {
    label: '千问（DashScope）',
    // 兼容模式，和 OpenAI 同一套形状，省一个解析分支
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseEnv: 'DASHSCOPE_BASE_URL',
    keyEnv: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'ALIYUN_API_KEY'],
    style: 'openai',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen3-max'],
    defaultModel: 'qwen-plus',
    price: { in: 0.8, out: 2.0 },
  },
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    baseEnv: 'DEEPSEEK_BASE_URL',
    keyEnv: ['DEEPSEEK_API_KEY'],
    style: 'openai',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    price: { in: 2.0, out: 8.0 },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/* ------------------------------------------------------------------ */
/* 密钥                                                                */
/* ------------------------------------------------------------------ */

const keysFile = (home) => path.join(home || path.join(os.homedir(), '.dsh-companion'), 'keys.json');

function readKeys(home) {
  try {
    const f = keysFile(home);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch { return {}; }
}

/**
 * 找 key。优先环境变量（临时、不进磁盘），其次 keys.json（长期、用户自己的）。
 *
 * 返回值**不要**打到日志里。需要显示时用 mask()。
 */
export function apiKey(provider, home) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  for (const e of p.keyEnv) {
    const v = process.env[e];
    if (v && String(v).trim()) return String(v).trim();
  }
  const saved = readKeys(home);
  const v = saved[provider] || saved.provider === provider && saved.key;
  return v && String(v).trim() ? String(v).trim() : null;
}

/** 只显示头尾，够确认「配的是哪个号」就够 */
export function mask(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 12) return '****';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** 存 key 到 keys.json。权限收到 600——这是本机唯一的明文密钥，别让它被别人读到。 */
export function saveKey(provider, key, home) {
  if (!PROVIDERS[provider]) throw new Error(`不认识的 provider：${provider}`);
  const f = keysFile(home);
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true });
  const all = readKeys(home);
  all[provider] = String(key || '').trim();
  fs.writeFileSync(f, JSON.stringify(all, null, 1));
  try { fs.chmodSync(f, 0o600); } catch { /* Windows 上不一定生效，尽力而为 */ }
  return f;
}

/** 每个 provider 配了没。给 doctor 和 companion_ask 用 */
export function ready(home) {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    model: PROVIDERS[id].defaultModel,
    hasKey: !!apiKey(id, home),
    keyFrom: (() => {
      for (const e of PROVIDERS[id].keyEnv) if (process.env[e]) return `环境变量 ${e}`;
      return readKeys(home)[id] ? 'keys.json' : '';
    })(),
    base: process.env[PROVIDERS[id].baseEnv] || PROVIDERS[id].base,
  }));
}

/* ------------------------------------------------------------------ */
/* 调用                                                                */
/* ------------------------------------------------------------------ */

function baseOf(provider) {
  const p = PROVIDERS[provider];
  const b = process.env[p.baseEnv] || p.base;
  return b.replace(/\/+$/, '');
}

/**
 * 估 token。中文按 1 字 1.5 token，英文按 4 字符 1 token，混排按长度加权。
 * 不追求精确——真正的用量在返回的 usage 里（三家都会给），估算是给「花之前先报价」用的。
 */
export function roughTokens(text) {
  const s = String(text || '');
  let han = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) han += 1;
  const other = s.length - han;
  return Math.ceil(han * 1.5 + other / 4);
}

/**
 * 问一句。
 *
 * @param {object} opts
 * @param {string} opts.provider  openai / anthropic / qwen / deepseek
 * @param {string} [opts.model]   不填用该家默认
 * @param {string} [opts.system]  系统提示（Anthropic 下走顶层字段）
 * @param {string|Array} opts.input  一句话，或 [{role, content}]
 * @param {string} [opts.home]    用来找 keys.json
 * @param {number} [opts.maxTokens=1024]
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<{ok:boolean, text?:string, usage?:object, model?:string, ms?:number, error?:string, hint?:string}>}
 */
export async function ask(opts) {
  const {
    provider, model, system, input,
    home, maxTokens = 1024, temperature = 0.7, timeoutMs = 60_000,
  } = opts || {};

  const p = PROVIDERS[provider];
  if (!p) {
    return {
      ok: false,
      error: `不认识的 provider「${provider}」`,
      hint: `可用的：${PROVIDER_IDS.join(' / ')}`,
    };
  }

  const key = apiKey(provider, home);
  if (!key) {
    return {
      ok: false,
      error: `${p.label} 没配密钥`,
      hint: `设环境变量 ${p.keyEnv[0]}，或者：companion_ask action=keys provider=${provider} key=<你的key>`,
    };
  }

  // 统一成 messages 数组
  const msgs = Array.isArray(input)
    ? input.map((m) => ({ role: m.role || 'user', content: String(m.content ?? '') }))
    : [{ role: 'user', content: String(input ?? '') }];
  if (!msgs.length || !msgs[msgs.length - 1].content) {
    return { ok: false, error: '没有内容可问' };
  }

  const useModel = model || p.defaultModel;
  const base = baseOf(provider);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let url, headers, body;
  if (p.style === 'anthropic') {
    url = `${base}/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': key,
      // 少了这个头 Anthropic 直接 400，报错还不说为什么
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: useModel,
      max_tokens: maxTokens,
      temperature,
      messages: msgs,
    };
    if (system) body.system = String(system);
  } else {
    url = `${base}/chat/completions`;
    headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    };
    const full = system ? [{ role: 'system', content: String(system) }, ...msgs] : msgs;
    body = {
      model: useModel,
      messages: full,
      max_tokens: maxTokens,
      temperature,
    };
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? `${p.label} 超时（${Math.round(timeoutMs / 1000)} 秒）` : `连不上 ${p.label}：${e.message}`,
      hint: provider === 'openai' || provider === 'anthropic'
        ? '这两家的官方端点在部分地区需要代理。可以把 base 指到你的代理：设环境变量 '
          + `${p.baseEnv}=https://你的代理/v1`
        : '检查网络和 base 地址',
      ms: Date.now() - t0,
    };
  }
  clearTimeout(timer);

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    // 把上游的原话带回去。401/429 是最常见的两个，看一眼就知道该怎么办。
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw);
      detail = j?.error?.message || j?.message || detail;
    } catch { /* 不是 JSON 就用原文 */ }
    const hint = res.status === 401 ? '密钥不对或已失效'
      : res.status === 403 ? '密钥没有这个模型的权限，或者所在地区被限制'
        : res.status === 429 ? '限流或额度用完了，等一会儿或换模型'
          : res.status === 404 ? `模型名「${useModel}」在该账号下不可用`
            : '';
    return {
      ok: false,
      error: `${p.label} 返回 ${res.status}：${detail}`,
      hint,
      status: res.status,
      ms: Date.now() - t0,
    };
  }

  let j;
  try { j = JSON.parse(raw); } catch {
    return { ok: false, error: `${p.label} 返回的不是 JSON`, detail: raw.slice(0, 200) };
  }

  // 两家取文本的位置不一样
  const text = p.style === 'anthropic'
    ? (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    : (j.choices?.[0]?.message?.content ?? '');

  if (!text) {
    return {
      ok: false,
      error: `${p.label} 没给内容`,
      detail: JSON.stringify(j).slice(0, 300),
      hint: j?.choices?.[0]?.finish_reason === 'content_filter' ? '被内容策略拦了' : '',
    };
  }

  // usage 字段名两家也不同
  const usage = p.style === 'anthropic'
    ? { in: j.usage?.input_tokens, out: j.usage?.output_tokens }
    : { in: j.usage?.prompt_tokens, out: j.usage?.completion_tokens };
  const total = (usage.in || 0) + (usage.out || 0);
  const price = (usage.in || 0) / 1e6 * p.price.in + (usage.out || 0) / 1e6 * p.price.out;

  return {
    ok: true,
    text: String(text).trim(),
    provider,
    model: j.model || useModel,
    usage: { ...usage, total },
    money: Number(price.toFixed(6)),
    ms: Date.now() - t0,
  };
}

/**
 * 挑一个能用的 provider。用户没指定时用它：
 * 优先按 config 里写的，其次按 千问 → deepseek → openai → anthropic 的顺序试。
 *
 * 为什么千问排前面：国内直连，不用代理，最不容易让人一上手就卡在网络上。
 */
export function pick(home, prefer) {
  if (prefer && PROVIDERS[prefer] && apiKey(prefer, home)) return prefer;
  for (const id of ['qwen', 'deepseek', 'openai', 'anthropic']) {
    if (apiKey(id, home)) return id;
  }
  return null;
}
