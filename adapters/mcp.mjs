#!/usr/bin/env node
/**
 * adapters/mcp.mjs —— 把同一个陪伴核心接到任何 MCP 客户端上
 *
 * 为什么要这一层：MCP 是现在 Agent 世界的通用插座。Claude Desktop、Cursor、
 * Cline、Continue、Zed、DSH……都认它。写一个 MCP server，等于让「记忆 + 权限 +
 * 看屏幕 + 刷视频」这些能力一次性对所有客户端可用——换模型、换客户端，
 * 记忆库不用重来一遍。这是「适配其它 Agent」最省力也最正经的做法。
 *
 * 用：
 *   node adapters/mcp.mjs                    # stdio，给客户端去连
 *   node adapters/mcp.mjs --list             # 看有哪些工具（人用）
 *   node adapters/mcp.mjs --config a.json    # 指定配置
 *
 * 客户端配置示例（Claude Desktop 的 claude_desktop_config.json）：
 *   {
 *     "mcpServers": {
 *       "companion": {
 *         "command": "node",
 *         "args": ["C:/path/to/dsh-companion/adapters/mcp.mjs"]
 *       }
 *     }
 *   }
 *
 * ⚠ 两条硬约束：
 *   1. stdio 传输下 **stdout 只放 JSON-RPC**。任何调试输出都会把协议弄坏，
 *      所以这里日志一律走 stderr（host.log 已经这么做了）。
 *   2. MCP 没有审批弹窗。所以「询问」级别的能力在这里**一律拒绝**（fail closed）——
 *      这是故意的：宁可少做一件事，也不要在没人点头的情况下开摄像头。
 *      想让某个能力在 MCP 下可用，就用配置文件把它改成 session 或 always。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { buildCompanion } from '../src/companion.js';
import { mcpHost } from '../src/host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const has = (n) => argv.includes(n);

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function loadConfig() {
  const file = flag('--config')
    || process.env.DSH_COMPANION_CONFIG
    || path.join(os.homedir(), '.dsh-companion', 'config.json');

  let base = {};
  if (fs.existsSync(file)) {
    try {
      base = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // 配置坏了不能静默——但这行只能进 stderr
      process.stderr.write(`[companion] 配置文件读不了（${file}）：${e.message}\n`);
    }
  }

  return {
    ...base,
    // 环境变量优先级最高，方便一次会话临时覆盖
    home: process.env.DSH_COMPANION_HOME || base.home || path.join(os.homedir(), '.dsh-companion'),
    profile: process.env.DSH_COMPANION_PROFILE || base.profile || 'tender',
    characterPack: process.env.DSH_COMPANION_CHARACTER
      || base.characterPack
      || path.join(ROOT, 'packs', 'bigfish-classic'),
  };
}

/* ------------------------------------------------------------------ */
/* spec → MCP                                                          */
/* ------------------------------------------------------------------ */

/**
 * 插件自己的参数格式是扁平对象 { 名: {type, required, description} }，
 * MCP 要标准 JSON Schema。这里只做形状转换，不加解释。
 */
function toInputSchema(params = {}) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params || {})) {
    const t = v?.type || 'string';
    properties[k] = { type: t, description: v?.description || '' };
    if (t === 'number') properties[k].type = 'number';
    if (t === 'boolean') properties[k].type = 'boolean';
    if (t === 'array') properties[k].type = 'array';
    if (v?.required) required.push(k);
  }
  const s = { type: 'object', properties };
  if (required.length) s.required = required;
  return s;
}

/** 插件工具的 render 返回的就是 MCP 的 content 格式，直接复用 */
function toContent(spec, args, out) {
  if (out && typeof spec.output?.render === 'function') {
    try {
      const c = spec.output.render(args, out);
      if (Array.isArray(c) && c.length) return c;
    } catch { /* 落到 JSON */ }
  }
  return [{ type: 'text', text: JSON.stringify(out ?? null, null, 1) }];
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const tools = new Map();
const config = loadConfig();
const host = mcpHost({ register: (spec) => tools.set(spec.name, spec) });
const core = buildCompanion(host, config);

/** 工具都在了才能回 tools/list，否则客户端会看到一个空列表 */
const READY = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-companion', version: '0.3.0' } };

if (has('--list')) {
  process.stdout.write(`\n  ${tools.size} 个工具（${config.profile} 人格，形象 ${path.basename(config.characterPack || '-')}）\n\n`);
  for (const [n, s] of tools) {
    const cols = Object.keys(s.parameters || {}).map((k) => (s.parameters[k].required ? `${k}*` : k));
    process.stdout.write(`  ${n.padEnd(28)}${JSON.stringify(cols)}\n    ${s.description.slice(0, 76)}\n`);
  }
  process.stdout.write('\n');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio                                                 */
/* ------------------------------------------------------------------ */

function send(msg) {
  // stdout 是协议通道，一行一条
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      // 客户端可能请求较新的协议版本，回我们实现的这个即可
      return reply(id, READY);

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知不需要回

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: [...tools.values()].map((s) => ({
          name: s.name,
          description: s.description,
          inputSchema: toInputSchema(s.parameters),
        })),
      });

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      const spec = tools.get(name);
      if (!spec) return fail(id, -32602, `没有这个工具：${name}`);
      try {
        // 注意这里**不传 ctx**：MCP 没有审批服务，guarded 会按 fail-closed 处理
        // 「询问」级别的能力。想放开就把那项权限改成 session/always。
        const out = await spec.execute(args || {});
        const isError = out && (out.ok === false || out.denied === true);
        return reply(id, { content: toContent(spec, args || {}, out), isError: !!isError });
      } catch (e) {
        return reply(id, {
          content: [{ type: 'text', text: `工具执行出错：${e.message}` }],
          isError: true,
        });
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] });

    case 'prompts/list':
      return reply(id, { prompts: [] });

    default:
      // 未知方法：有 id 才回错误，通知类直接丢
      if (id !== undefined) return fail(id, -32601, `不支持的方法：${method}`);
      return;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    // 解析不了就没有 id，只能报 parse error
    return fail(null, -32700, 'JSON 解析失败');
  }
  Promise.resolve(handle(msg)).catch((e) => {
    process.stderr.write(`[companion] 处理 ${msg?.method} 出错：${e.message}\n`);
    if (msg?.id !== undefined) fail(msg.id, -32603, e.message);
  });
});

rl.on('close', () => {
  // 客户端关了管道就该退，别留在后台
  process.exit(0);
});

process.stderr.write(
  `[companion] MCP server 就绪｜${tools.size} 个工具｜人格 ${config.profile}`
  + `｜记忆 ${path.join(config.home, 'memory')}\n`,
);
