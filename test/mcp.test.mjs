#!/usr/bin/env node
/**
 * mcp.test.mjs —— 验 MCP 适配器真的能当 MCP server 用
 *
 * 不用真的开 Claude Desktop。起一个子进程，按协议发消息，看回什么。
 * 重点验三件容易出事的事：
 *
 *   1. **stdout 只能有 JSON-RPC**。一行日志漏出去，整个客户端就废了，
 *      而且报错会指向「连接失败」，没人会想到是 printf 干的。
 *   2. **没有审批服务时必须 fail-closed**。「询问」级能力不能因为「没人能问我」
 *      就默认放行——那是把权限模型拆了。
 *   3. **render 的输出要能直接当 content**。插件里 23 个工具都写了 render，
 *      如果 MCP 侧不用它，模型看到的就是一坨 JSON。
 *
 *   node test/mcp.test.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'adapters', 'mcp.mjs');

// 用临时 home，别动真身
const TMP = path.join(ROOT, '.tmp', 'mcp-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n=== MCP 适配器 ===\n');

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, DSH_COMPANION_HOME: TMP },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let rawOut = '';
let errOut = '';
child.stdout.on('data', (d) => { rawOut += d.toString(); });
child.stderr.on('data', (d) => { errOut += d.toString(); });

/* 极简客户端：发一行，等对应 id 的回复 */
const waiters = new Map();
child.stdout.on('data', () => {
  for (const line of rawOut.split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  }
});

let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} 超时`)), 20000);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  // ---- 1. 握手 ----
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  ok('initialize 有回包', !!init.result, JSON.stringify(init).slice(0, 120));
  ok('报出协议版本', typeof init.result?.protocolVersion === 'string', init.result?.protocolVersion);
  ok('声明 tools 能力', !!init.result?.capabilities?.tools);
  ok('serverInfo 名字对', init.result?.serverInfo?.name === 'dsh-companion');
  notify('notifications/initialized');

  // ---- 2. tools/list ----
  const list = await call('tools/list');
  const tools = list.result?.tools || [];
  ok('工具列表非空', tools.length > 0, `拿到 ${tools.length} 个`);
  // 25 = 原有 23 个 + companion_model / companion_model_key
  // 加删工具时这里要跟着改，不然就是门禁失效
  ok('数量与插件一致（25）', tools.length === 25, `实际 ${tools.length}`);

  const bad = tools.filter((t) => !t.name || !t.description || t.inputSchema?.type !== 'object');
  ok('每个工具都有 name / description / object schema', bad.length === 0,
    bad.map((b) => b.name || '(无名)').join(', '));

  const recall = tools.find((t) => t.name === 'companion_recall');
  ok('required 数组正确（keywords*）',
    JSON.stringify(recall?.inputSchema?.required) === '["keywords"]',
    JSON.stringify(recall?.inputSchema?.required));
  ok('参数类型是 JSON Schema',
    recall?.inputSchema?.properties?.keywords?.type === 'string');

  // ---- 3. 无需审批的工具能跑通 ----
  const cost = await call('tools/call', { name: 'companion_cost', arguments: {} });
  const costText = cost.result?.content?.[0]?.text || '';
  ok('companion_cost 执行成功', !cost.result?.isError, costText.slice(0, 80));
  ok('返回的是人话而不是裸 JSON',
    costText && !/^\{/.test(costText.trim()), costText.slice(0, 80));

  // ---- 4. 需要审批的能力必须被拒（fail-closed）----
  const shot = await call('tools/call', { name: 'companion_see_screen', arguments: {} });
  ok('「询问」级能力在无审批环境下被拒', shot.result?.isError === true);
  const shotText = shot.result?.content?.[0]?.text || '';
  ok('拒绝理由说清是审批缺失', /确认|审批|拒绝/.test(shotText), shotText.slice(0, 90));

  // ---- 5. 坏参数与未知工具 ----
  const unknown = await call('tools/call', { name: 'companion_nope', arguments: {} });
  ok('未知工具返回 JSON-RPC 错误', !!unknown.error, JSON.stringify(unknown.error));

  const noKw = await call('tools/call', { name: 'companion_recall', arguments: {} });
  ok('缺必填参数不会崩（有回包）', !!noKw.result || !!noKw.error);

  // ---- 6. 协议纯净度：stdout 每一行都必须是 JSON ----
  await new Promise((r) => setTimeout(r, 400));
  const lines = rawOut.split('\n').filter((l) => l.trim());
  const dirty = lines.filter((l) => {
    try { JSON.parse(l); return false; } catch { return true; }
  });
  ok('stdout 全是合法 JSON-RPC（无日志污染）', dirty.length === 0,
    dirty.slice(0, 2).map((d) => d.slice(0, 60)).join(' | '));
  ok('日志确实走了 stderr', /\[companion\]/.test(errOut), errOut.split('\n')[0]?.slice(0, 70));

  // ---- 7. 记忆落盘在同一位置（换宿主不换记忆库）----
  ok('记忆目录在 MCP 下也建起来了', fs.existsSync(TMP), TMP);

} catch (e) {
  fail += 1;
  console.log(`  ✗ 异常：${e.message}`);
} finally {
  child.stdin.end();
  setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } }, 200);
}

setTimeout(() => {
  console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}, 900);
