/**
 * browser.js —— 让她真的能在网页上刷视频
 *
 * 关键取舍：**用她自己的 profile，不用用户的日常浏览器。**
 *
 * 看起来多此一举，其实是三条硬理由：
 *   1. 用户自己的 Edge 已经开着，加参数只能把 URL 转给现有进程，调试端口根本不开；
 *   2. 陪着他聊天的时候浏览器突然跳走、抢焦点、翻他的标签页，体验是灾难；
 *   3. 她有一个独立身份（独立 cookie），登的是「她的」B 站/抖音号，
 *      而不是拿用户的号到处点。出问题能整个删掉。
 *
 * 代价是第一次要在那个窗口里扫码登录一次。这一次登录换来后面几十年不用再登。
 *
 * 操作范围收得极窄：**只读、只滚、只发自己打的字。**
 * 不暴露「点任意 selector」这种能力——那样模型误判一次就可能点掉一个视频、
 * 关注一个人、删掉一条评论。每个动作都是语义化的，且发出去之前要回读校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { CDP, probePort, listPages, newPage, closePage } from './cdp.js';

/* ------------------------------------------------------------------ */
/* 站点表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 每个站点三件事：怎么进、怎么读、怎么往下走。
 *
 * 读的脚本一律「多选择器兜底 + 整体 try」——这些页面改版比翻书还快，
 * 单选择器必然某天全空。返回 null 比抛错好，模型看到「读不到」会去截图。
 */
export const SITES = {
  bilibili: {
    name: '哔哩哔哩',
    home: 'https://www.bilibili.com',
    // 能"往下刷"的入口：热门列表，滚到底会加载更多
    stream: 'https://www.bilibili.com/v/popular/all',
    search: (q, sort) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}&order=${sort === 'hot' ? 'click' : 'pubdate'}`,
    searchRead: `(() => {
      const num = (s) => { const m = String(s||'').replace(/\\s+/g,''); const g = m.match(/([\\d.]+)(万|亿)?/); if (!g) return null; let v = parseFloat(g[1]); if (g[2]==='万') v*=1e4; if (g[2]==='亿') v*=1e8; return Math.round(v); };
      const cards = [...document.querySelectorAll('.bili-video-card, .video-list .bili-video-card, .col_3 .bili-video-card')];
      return cards.slice(0, 24).map((c) => {
        const a = c.querySelector('a[href*="/video/"]');
        const t = c.querySelector('.bili-video-card__info--tit');
        const au = c.querySelector('.bili-video-card__info--author');
        const st = c.querySelector('.bili-video-card__stats--item, .bili-video-card__stats');
        const dur = c.querySelector('.bili-video-card__stats__duration');
        return {
          title: (t && (t.getAttribute('title') || t.innerText) || '').trim(),
          author: (au && au.innerText || '').replace(/^\\s*UP主[:：]?\\s*/,'').trim(),
          meta: (st && st.innerText || '').replace(/\\s+/g,' ').trim(),
          views: num(st && st.innerText),
          duration: (dur && dur.innerText || '').trim(),
          href: a ? new URL(a.getAttribute('href'), location.origin).href : null,
        };
      }).filter((x) => x.title && x.href);
    })()`,
    // 热门/推荐列表页是另一套 DOM（.video-card / .video-name），和搜索页不通用。
    // 实测：搜索页用 .bili-video-card 能读到 24 条，热门页同一个选择器读到 0 条。
    listRead: `(() => {
      const num = (s) => { const m = String(s||'').replace(/\\s+/g,''); const g = m.match(/([\\d.]+)(万|亿)?/); if (!g) return null; let v = parseFloat(g[1]); if (g[2]==='万') v*=1e4; if (g[2]==='亿') v*=1e8; return Math.round(v); };
      const cards = [...document.querySelectorAll('.video-card')];
      return cards.slice(0, 24).map((c) => {
        const a = c.querySelector('a[href*="/video/"]');
        const t = c.querySelector('.video-name');
        const au = c.querySelector('.up-name__text, .up-name');
        const pl = c.querySelector('.play-text');
        const lk = c.querySelector('.like-text');
        const tag = c.querySelector('.rcmd-tag, .strong-tag');
        return {
          title: (t && t.innerText || '').replace(/\\s+/g,' ').trim(),
          author: (au && au.innerText || '').trim(),
          views: num(pl && pl.innerText),
          likes: (lk && lk.innerText || '').trim(),
          tag: (tag && tag.innerText || '').trim(),
          meta: [pl && pl.innerText, lk && lk.innerText].filter(Boolean).join(' · '),
          href: a ? new URL(a.getAttribute('href'), location.origin).href : null,
        };
      }).filter((x) => x.title && x.href);
    })()`,
    match: /(^|\.)bilibili\.com$/i,
    allow: [/bilibili\.com$/i],
    kind: 'list',
    read: `(() => {
      const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); const t = e && (e.innerText || e.textContent); if (t && t.trim()) return t.trim(); } return null; };
      const many = (sels, n) => { for (const s of sels) { const a = [...document.querySelectorAll(s)]; if (a.length) return a.slice(0, n).map(e => (e.innerText||e.textContent||'').trim()).filter(Boolean); } return []; };
      return {
        title: pick(['h1.video-title', 'h1[title]', '.video-title']) || document.title,
        author: pick(['.up-name', '.up-info--name', '.up-detail-name a', 'a.up-name']),
        desc: pick(['.desc-info-text', '.basic-desc-info', '#v_desc']),
        items: many(['.video-card__info .title', '.bili-video-card__info--tit', '.rank-item .title', '.video-page-card-small .title'], 12),
        stats: pick(['.view.item', '.video-data']),
        isVideo: /\\/video\\/BV/i.test(location.href),
        url: location.href,
      };
    })()`,
  },

  douyin: {
    name: '抖音',
    home: 'https://www.douyin.com',
    stream: 'https://www.douyin.com/?recommend=1',
    search: (q) => `https://www.douyin.com/search/${encodeURIComponent(q)}`,
    searchRead: `(() => {
      const items = [...document.querySelectorAll('[data-e2e="scroll-list"] li, [data-e2e="search-result-item"]')];
      return items.slice(0, 20).map((c) => {
        const a = c.querySelector('a[href*="/video/"]');
        const t = c.querySelector('[data-e2e="video-desc"], .video-desc, p');
        return {
          title: (t && t.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 80),
          author: (c.querySelector('[data-e2e="video-author-name"], .author-name') || {}).innerText || '',
          meta: '', views: null, duration: '',
          href: a ? new URL(a.getAttribute('href'), location.origin).href : null,
        };
      }).filter((x) => x.title && x.href);
    })()`,
    match: /(^|\.)douyin\.com$/i,
    allow: [/douyin\.com$/i],
    kind: 'feed',   // 竖向滚动，一条一条换
    read: `(() => {
      const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); const t = e && (e.innerText || e.textContent); if (t && t.trim()) return t.trim(); } return null; };
      const many = (sels, n) => { for (const s of sels) { const a = [...document.querySelectorAll(s)]; if (a.length) return a.slice(0, n).map(e => (e.innerText||e.textContent||'').trim()).filter(Boolean); } return []; };
      return {
        title: pick(['[data-e2e="video-desc"]', '[data-e2e="feed-video-desc"]']) || document.title,
        author: pick(['[data-e2e="video-author-name"]', '[data-e2e="feed-author-name"]', '.author-name']),
        desc: pick(['[data-e2e="video-desc"]']),
        items: many(['[data-e2e="feed-item-desc"]', '[data-e2e="video-desc"]'], 6),
        comments: many(['[data-e2e="comment-item"] [data-e2e="comment-content"]', '.comment-item .content'], 8),
        isVideo: !!document.querySelector('[data-e2e="video-desc"], video'),
        url: location.href,
      };
    })()`,
  },

  xiaohongshu: {
    name: '小红书',
    home: 'https://www.xiaohongshu.com',
    stream: 'https://www.xiaohongshu.com/explore',
    search: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`,
    searchRead: `(() => {
      const items = [...document.querySelectorAll('section.note-item, .note-item')];
      return items.slice(0, 24).map((c) => {
        const a = c.querySelector('a[href*="/explore/"], a[href*="/search_result/"]');
        const t = c.querySelector('.title, .footer .title, span');
        const au = c.querySelector('.author .name, .name');
        const like = c.querySelector('.like-wrapper .count, .count');
        return {
          title: (t && t.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 80),
          author: (au && au.innerText || '').trim(),
          meta: (like && like.innerText || '').trim(),
          views: null, duration: '',
          href: a ? new URL(a.getAttribute('href'), location.origin).href : null,
        };
      }).filter((x) => x.title && x.href);
    })()`,
    match: /(^|\.)xiaohongshu\.com$/i,
    allow: [/xiaohongshu\.com$/i],
    kind: 'grid',
    read: `(() => {
      const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); const t = e && (e.innerText || e.textContent); if (t && t.trim()) return t.trim(); } return null; };
      const many = (sels, n) => { for (const s of sels) { const a = [...document.querySelectorAll(s)]; if (a.length) return a.slice(0, n).map(e => (e.innerText||e.textContent||'').trim()).filter(Boolean); } return []; };
      return {
        title: pick(['#detail-title', '.note-content .title', '.title']) || document.title,
        author: pick(['.author-wrapper .name', '.username']),
        desc: pick(['#detail-desc', '.note-content .desc', '.desc']),
        items: many(['.note-item .title', 'section.note-item .footer .title'], 12),
        isVideo: /\\/(explore|discovery\\/item)\\//.test(location.href),
        url: location.href,
      };
    })()`,
  },

  kuaishou: {
    name: '快手',
    home: 'https://www.kuaishou.com',
    stream: 'https://www.kuaishou.com/brilliant',
    match: /(^|\.)kuaishou\.com$/i,
    allow: [/kuaishou\.com$/i],
    kind: 'grid',
    read: `(() => {
      const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); const t = e && (e.innerText || e.textContent); if (t && t.trim()) return t.trim(); } return null; };
      return {
        title: pick(['.video-info-title', '.work-description']) || document.title,
        author: pick(['.video-info-user-name', '.profile-user-name']),
        desc: pick(['.work-description']),
        items: [],
        isVideo: /\\/short-video\\//.test(location.href),
        url: location.href,
      };
    })()`,
  },
};

export const SITE_IDS = Object.keys(SITES);

export function siteOf(url) {
  try {
    const h = new URL(url).hostname;
    for (const [id, s] of Object.entries(SITES)) if (s.match.test(h)) return id;
  } catch { /* 非法 URL */ }
  return null;
}

/* ------------------------------------------------------------------ */
/* 启动 / 连接                                                           */
/* ------------------------------------------------------------------ */

/** 找浏览器可执行文件。导出给 doctor 用——「能自己刷」这件事全靠它。 */
export function findBrowser() {
  return edgePath();
}

function edgePath() {
  const cands = [
    process.env.DSH_COMPANION_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 下一个 */ }
  }
  return null;
}

/** 她的浏览器 profile。删掉这个目录 = 她忘掉所有登录态。 */
export function profileDir(home) {
  return path.resolve(path.join(home || path.join(os.homedir(), '.dsh-companion'), 'browser'));
}

/**
 * 确保调试端口上有浏览器。
 * 已经开着就直接连（第二次调用几乎 0 成本），没开才起。
 */
export async function ensureBrowser({ home, port = 9222, profile, headless = false, url } = {}) {
  const alive = await probePort(port);
  if (alive.ok) return { ok: true, port, started: false, browser: alive.Browser };

  // 必须是绝对路径。Edge 对相对的 --user-data-dir 解析得很随意，
  // 表现是进程起来了、目录却是空的、调试端口也不开——排查起来极费时间。
  const dir = path.resolve(profile || profileDir(home));
  fs.mkdirSync(dir, { recursive: true });

  const bin = edgePath();
  if (!bin) {
    return { ok: false, error: '没找到 Edge 或 Chrome', hint: '用 DSH_COMPANION_BROWSER 环境变量指定浏览器路径' };
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',        // 关掉后台常驻，省内存
    '--disable-features=Translate,OptimizationHints',
    // 保持窗口正常大小，不然截图和滚动坐标都会歪
    '--window-size=1280,860',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu', '--no-sandbox');

  // 浏览器自己的输出写文件，不用管道。
  // 管道会让 node 的事件循环一直被这个 handle 挂着 —— 表现为「脚本跑完了但不退出」，
  // 而且 detached 以外的写法都躲不开。写文件既不留 handle，又留下了排查用的日志。
  const logFile = path.join(dir, '..', 'browser.log');
  let logFd = null;
  try { logFd = fs.openSync(logFile, 'a'); } catch { logFd = null; }

  const child = spawn(bin, [...args, url || 'about:blank'], {
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    windowsHide: false,   // 故意不隐藏：用户得看见她在做什么
  });
  child.unref();
  if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* 子进程已持有副本 */ } }

  // 等端口起来。Edge 冷启动要 1.5~4 秒（实测 1.2 秒就通）。
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await probePort(port);
    if (p.ok) return { ok: true, port, started: true, browser: p.Browser, profile: dir, pid: child.pid, log: logFile };
    // 浏览器已经放弃（例如 profile 被占用）就别等到 15 秒
    if (child.exitCode !== null && child.exitCode !== 0) break;
  }
  let tail = '';
  try {
    const s = fs.readFileSync(logFile, 'utf8');
    tail = s.split(/\r?\n/).filter((l) => l.trim() && !/DevTools listening/.test(l)).slice(-2).join(' | ');
  } catch { /* 没有日志 */ }
  return {
    ok: false,
    error: `浏览器起来了但调试端口 ${port} 没响应`,
    hint: tail ? `浏览器报：${tail.slice(0, 300)}` : `检查 ${dir} 是否被另一个实例占用；或手动跑一次 ${path.basename(bin)} ${args[0]}`,
    profile: dir, log: logFile,
  };
}

/** 连到某个页面。不指定就用最后一个非空白页。 */
export async function attach(port, { targetId, wantUrl } = {}) {
  const pages = await listPages(port);
  if (!pages.length) {
    const np = await newPage(port, 'about:blank');
    if (!np?.webSocketDebuggerUrl) return { ok: false, error: '没有可用的页面' };
    const cdp = await new CDP(np.webSocketDebuggerUrl).connect();
    return { ok: true, cdp, page: { id: np.id, url: 'about:blank' } };
  }
  let page = targetId ? pages.find((p) => p.id === targetId) : null;
  if (!page && wantUrl) page = pages.find((p) => wantUrl.test(p.url));
  if (!page) {
    // 优先内容页（不是 about:blank / 新标签页）
    page = pages.filter((p) => !/^(about:|chrome|edge|devtools:)/i.test(p.url)).pop() || pages[pages.length - 1];
  }
  const cdp = await new CDP(page.ws).connect();
  return { ok: true, cdp, page, pages };
}

/* ------------------------------------------------------------------ */
/* 页面动作                                                              */
/* ------------------------------------------------------------------ */

/** 读当前页。返回结构化信息，全部字段都可能为 null。 */
export async function readPage(cdp, { site } = {}) {
  const info = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      url: location.href,
      title: document.title,
      ready: document.readyState,
      hasVideo: !!document.querySelector('video'),
      videoTime: (() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, d: v.duration, paused: v.paused } : null; })(),
    }))()`,
    returnByValue: true,
  });
  const base = info?.result?.value || {};
  const id = site || siteOf(base.url);
  let detail = {};
  if (id && SITES[id]) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: SITES[id].read, returnByValue: true, awaitPromise: false,
      });
      detail = r?.result?.value || {};
    } catch { detail = {}; }
  }
  const pick = (a, b) => (a && String(a).trim()) || (b && String(b).trim()) || null;
  return {
    site: id,
    siteName: id ? SITES[id].name : null,
    url: base.url || detail.url || null,
    title: pick(detail.title, base.title),
    author: detail.author || null,
    desc: detail.desc || null,
    items: Array.isArray(detail.items) ? detail.items.slice(0, 12) : [],
    comments: Array.isArray(detail.comments) ? detail.comments.slice(0, 8) : [],
    stats: detail.stats || null,
    isVideo: !!detail.isVideo || !!base.hasVideo,
    video: base.videoTime || null,
  };
}

export async function goto(cdp, url) {
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Page.navigate', { url });
  // 等 load。给 12 秒，抖音这种首屏很重。
  await new Promise((resolve) => {
    let done = false;
    const off = cdp.on('Page.loadEventFired', () => { done = true; off(); resolve(); });
    setTimeout(() => { if (!done) { try { off(); } catch { /* 已解绑 */ } resolve(); } }, 12000);
  });
  await new Promise((r) => setTimeout(r, 900));  // 让首屏 JS 把内容渲出来
  return readPage(cdp);
}

/**
 * 滚一下。用真滚轮事件，不用 window.scrollBy：
 * 抖音/小红书这类是虚拟列表 + 拦截 scroll 的，改 scrollTop 会被忽略或无效果。
 */
export async function wheel(cdp, { dy = 800, dx = 0, x = 640, y = 430, times = 1, gapMs = 260 } = {}) {
  await cdp.send('Page.bringToFront').catch(() => {});
  for (let i = 0; i < times; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy,
      pointerType: 'mouse', modifiers: 0,
    });
    if (i < times - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  await new Promise((r) => setTimeout(r, 500));
  return readPage(cdp);
}

/** 在当前页里执行只读 JS。**只读**：拒绝任何赋值/DOM 改写的语句。 */
export async function evaluate(cdp, expr) {
  const banned = /(document\s*\.\s*(cookie|write)|\.innerHTML\s*=|\.outerHTML\s*=|\.value\s*=|localStorage\s*\.\s*set|sessionStorage\s*\.\s*set|\.submit\s*\(|\.click\s*\(|fetch\s*\(|XMLHttpRequest|indexedDB)/i;
  if (banned.test(expr || '')) {
    return { ok: false, error: '这个表达式会改页面或发请求，只读沙箱拒绝执行' };
  }
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) {
    return { ok: false, error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return { ok: true, value: r?.result?.value };
}

/** 关掉她自己开的标签。不碰用户自己开的页。 */
export async function closeOwn(port, pageId) {
  return closePage(port, pageId);
}

/* ------------------------------------------------------------------ */
/* 定向搜索：帮用户收集某一类视频                                          */
/* ------------------------------------------------------------------ */

/**
 * 读列表页/搜索页，返回结构化条目。
 *
 * 分 kind 是因为同一站点的「搜索页」和「热门页」DOM 完全是两套。
 * 拿错脚本不报错、只是安静地返回 0 条——所以这里先按 kind 精确选，
 * 选不到才退到另一个，并把「用哪个脚本读的」记下来，方便排查。
 */
export async function readList(cdp, site, { kind = 'auto' } = {}) {
  const s = SITES[site];
  if (!s) return { ok: false, entries: [], error: `不认识的平台「${site}」` };

  let expr = null;
  let used = null;
  if (kind === 'search') { expr = s.searchRead || s.listRead; used = s.searchRead ? 'searchRead' : 'listRead'; }
  else if (kind === 'list') { expr = s.listRead || s.searchRead; used = s.listRead ? 'listRead' : 'searchRead'; }
  else { expr = s.listRead || s.searchRead; used = s.listRead ? 'listRead' : 'searchRead'; }

  if (!expr) return { ok: true, entries: [], note: `${s.name} 的列表解析还没适配` };

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const raw = r?.result?.value;
  if (!Array.isArray(raw)) {
    return { ok: true, entries: [], used, note: '列表没读到（可能还没加载完、需要登录、或页面改版了）' };
  }

  // 去重：搜索结果常出现同一视频的多张卡片
  const seen = new Set();
  const entries = [];
  for (const x of raw) {
    const k = (x.href || x.title || '').replace(/[?#].*$/, '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    entries.push(x);
  }
  return { ok: true, entries, used, site, siteName: s.name };
}

/**
 * 在某个站上搜一个主题，读回结果列表。
 *
 * 这是「帮我收集资讯」的入口 —— 和「随便刷刷」不一样，它是有目的的：
 * 给一个话题，拿回来带标题、作者、播放量、链接的一串条目，
 * 模型再据此筛出值得看的几条，落进记忆。
 */
export async function searchSite(cdp, site, query, { sort = 'new', scrollTimes = 1 } = {}) {
  const s = SITES[site];
  if (!s) return { ok: false, error: `不认识的平台「${site}」` };
  if (!s.search) return { ok: false, error: `${s.name} 的搜索还没适配` };

  await goto(cdp, s.search(query, sort));
  // 搜索结果大多是懒加载的，滚一两次把首屏填满
  for (let i = 0; i < Math.min(Math.max(0, scrollTimes), 4); i++) {
    await wheel(cdp, { dy: 1200, times: 1 });
  }
  await new Promise((r) => setTimeout(r, 700));

  const res = await readList(cdp, site, { kind: 'search' });
  return { ...res, query };
}

