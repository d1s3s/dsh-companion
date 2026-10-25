/**
 * cdp.js —— 极简 Chrome DevTools Protocol 客户端
 *
 * 为什么手写而不用 puppeteer/playwright：
 *   1. 装依赖要下 300MB 浏览器，而用户机器上 Edge 本来就在；
 *   2. 那两个库的默认行为是「自己开一个干净浏览器」，而陪伴助手需要的是
 *      「登着用户账号的那个浏览器」——这是 profile 问题，不是库问题；
 *   3. 只用得到四类命令：开页、读 DOM、发滚轮、打字。为了这四件事实在不值。
 *
 * Node 22 自带 WebSocket 和 fetch，所以整个文件零依赖。
 */

/** 连到一个已经开着调试端口的浏览器 */
export class CDP {
  constructor(wsUrl, { timeout = 15000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeout = timeout;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (e) {
        return reject(new Error(`WebSocket 建不起来：${e.message}`));
      }
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连 CDP 超时')), this.timeout);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败：${e.message || '握手被拒'}`));
      });
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('CDP 连接已断开'));
        this.pending.clear();
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
          else p.resolve(msg.result);
          return;
        }
        if (msg.method) {
          const hs = this.listeners.get(msg.method) || [];
          for (const h of hs) { try { h(msg.params, msg.sessionId); } catch { /* 别让监听器炸掉管道 */ } }
        }
      });
    });
  }

  send(method, params = {}, { timeout = this.timeout } = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
    return () => {
      const hs = this.listeners.get(method) || [];
      const i = hs.indexOf(handler);
      if (i >= 0) hs.splice(i, 1);
    };
  }

  close() {
    try { this.ws?.close(); } catch { /* 已经关了 */ }
    this.ws = null;
  }
}

/* ------------------------------------------------------------------ */
/* 浏览器级（/json 接口）                                                 */
/* ------------------------------------------------------------------ */

const base = (port) => `http://127.0.0.1:${port}`;

async function jget(url, timeout = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** 调试端口活着吗。活着就返回版本信息。 */
export async function probePort(port = 9222) {
  try {
    const v = await jget(`${base(port)}/json/version`, 2000);
    return { ok: true, ...v };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '端口没响应' : e.message };
  }
}

/** 所有可挂调试的页面（含 iframe 之外的顶层页） */
export async function listPages(port = 9222) {
  const list = await jget(`${base(port)}/json/list`, 3000);
  return (list || [])
    .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    .map((t) => ({ id: t.id, url: t.url, title: t.title, ws: t.webSocketDebuggerUrl }));
}

/** 开一个新标签。返回它的 ws 地址。 */
export async function newPage(port, url = 'about:blank') {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    // PUT 是较新版本的行为，旧版本用 GET；两个都试
    for (const method of ['PUT', 'GET']) {
      try {
        const r = await fetch(`${base(port)}/json/new?${encodeURIComponent(url)}`, { method, signal: ac.signal });
        if (r.ok) return await r.json();
      } catch { /* 试下一个 */ }
    }
    throw new Error('开新标签失败');
  } finally { clearTimeout(t); }
}

/** 关标签 */
export async function closePage(port, id) {
  try {
    const r = await fetch(`${base(port)}/json/close/${id}`);
    return r.ok;
  } catch { return false; }
}
