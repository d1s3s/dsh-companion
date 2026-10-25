/**
 * memory.js —— 记忆
 *
 * 这里有个刻意的决定：**不调用 Python 脚本，直接读同一批 Markdown 文件。**
 *
 * 为什么值得这样重复一遍解析逻辑：
 * 记忆库的价值全在「它能被任何东西读懂」。Python 脚本写的 raw，Node 插件直接用正则
 * 就能解析——这证明那个 50 年设计没有骗人。哪天 Python 没了、脚本烂了，插件照样能读。
 * 反过来，如果插件必须调 mem.py 才能工作，那记忆就被绑在一个 Python 环境上了。
 *
 * 格式必须和 log.py / index.py 保持一致，否则两边会互相踩。
 */

import fs from 'node:fs';
import path from 'node:path';

const ENTRY = /^###\s+D(\d+)\s*·\s*(\d{1,2}:\d{2})\s*·\s*(.+)$/;
const ANCHOR = /^-\s*(.+?)\s*→\s*D(\d+)\s*·\s*(\d{2}-\d{2})\s*$/;
const FIELD = /^-\s*(事实|结论|原话|否决|认知|待办|备注)[：:]\s*(.+)$/;

export class Memory {
  constructor(dir) {
    this.dir = dir;
    this.rawDir = path.join(dir, 'raw');
    this.indexDir = path.join(dir, 'index');
    this.indexFile = path.join(dir, 'index.md');
    this.counterFile = path.join(dir, 'counter.json');
  }

  exists() {
    return fs.existsSync(this.rawDir);
  }

  /** 所有原文条目，按编号升序 */
  entries() {
    if (!this.exists()) return [];
    const out = [];
    for (const f of fs.readdirSync(this.rawDir).filter((x) => x.endsWith('.md')).sort()) {
      const day = f.replace(/\.md$/, '');
      const lines = fs.readFileSync(path.join(this.rawDir, f), 'utf8').split('\n');
      let cur = null;
      for (const line of lines) {
        const m = line.match(ENTRY);
        if (m) {
          cur = { id: 'D' + m[1], num: +m[1], time: m[2], title: m[3].trim(), day, body: [], fields: {} };
          out.push(cur);
          continue;
        }
        if (!cur) continue;
        cur.body.push(line);
        const fm = line.match(FIELD);
        if (fm) {
          const k = fm[1];
          (cur.fields[k] ||= []).push(fm[2].trim());
        }
      }
    }
    return out.sort((a, b) => a.num - b.num);
  }

  /** 常驻：只到「那阵子聊过什么」。近 3 天逐日，更早压成一行——不随天数增长。 */
  resident({ days = 3, perDay = 6 } = {}) {
    const es = this.entries();
    if (!es.length) return { text: '（还没有记忆。像刚认识。）', days: 0, entries: 0 };

    const byDay = new Map();
    for (const e of es) {
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day).push(e);
    }
    const allDays = [...byDay.keys()].sort().reverse();
    const recent = allDays.slice(0, days);
    const older = allDays.slice(days);

    const lines = [];
    for (const d of recent) {
      const items = byDay.get(d);
      const first = items[items.length - 1].title;   // 当天最后一条＝最像「在忙什么」
      lines.push(`${d}  ${cut(first, 14)}${items.length > 1 ? `（等 ${items.length} 件）` : ''}`);
    }
    if (older.length) {
      const n = older.reduce((a, d) => a + byDay.get(d).length, 0);
      lines.push(`更早还有 ${older.length} 天、${n} 件，记不清细节了。`);
    }
    // 已淡的总量：提醒它「有东西在，但不主动提」
    return { text: lines.join('\n'), days: allDays.length, entries: es.length, recent };
  }

  /** 检索：先索引后原文，只取命中那几条 */
  search(kws, { limit = 3 } = {}) {
    const list = [].concat(kws || []).filter(Boolean);
    if (!list.length) return [];
    const scored = [];
    for (const e of this.entries()) {
      const blob = e.title + '\n' + e.body.join('\n');
      let hit = 0;
      for (const k of list) {
        const n = blob.split(k).length - 1;
        if (n) hit += n;
      }
      if (hit) scored.push({ e, hit, weight: hit + (e.fields['认知'] ? 0.5 : 0) + (e.fields['否决'] ? 0.8 : 0) });
    }
    scored.sort((a, b) => b.weight - a.weight || b.e.num - a.e.num);
    return scored.slice(0, limit).map(({ e, hit }) => ({
      id: e.id, day: e.day, title: e.title, hit,
      body: e.body.filter((l) => FIELD.test(l)).map((l) => l.trim()),
    }));
  }

  /** 最值钱的两类：否决和认知修订。换模型、给提醒都靠它们。 */
  valuable(kind, { limit = 3 } = {}) {
    const out = [];
    for (const e of this.entries().reverse()) {
      const v = e.fields[kind];
      if (v && v.length) out.push({ id: e.id, title: e.title, text: v[0] });
      if (out.length >= limit) break;
    }
    return out;
  }

  nextNum() {
    try {
      const c = JSON.parse(fs.readFileSync(this.counterFile, 'utf8'));
      if (Number.isInteger(c.next_id)) return c.next_id;
    } catch { /* 落到下面自愈 */ }
    const es = this.entries();
    return es.length ? es[es.length - 1].num + 1 : 1;
  }

  /**
   * 落一条。原文只追加，索引另写——和 log.py 同规则。
   * 顺序不能反：先写原文，再写索引。反过来一旦中途失败，索引就指向空处。
   */
  append({ title, facts = [], quotes = [], vetoes = [], beliefs = [], todos = [], section = '待归类', index }) {
    if (!title) throw new Error('必须给标题');
    const num = this.nextNum();
    const day = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 5);

    fs.mkdirSync(this.rawDir, { recursive: true });
    const rawFile = path.join(this.rawDir, day + '.md');
    const head = fs.existsSync(rawFile) ? '' : `# ${day}\n\n`;
    const block = [
      `${head}### D${num} · ${time} · ${title}`,
      ...facts.map((x) => `- 事实：${x}`),
      ...quotes.map((x) => `- 原话：${x}`),
      ...vetoes.map((x) => `- 否决：${x}`),
      ...beliefs.map((x) => `- 认知：${x}`),
      ...todos.map((x) => `- 待办：${x}`),
      '',
    ].join('\n');
    fs.appendFileSync(rawFile, block, 'utf8');

    this._index(num, day, index || cut(title, 24), section);
    fs.writeFileSync(this.counterFile, JSON.stringify({ next_id: num + 1 }), 'utf8');
    return { id: 'D' + num, day, file: rawFile };
  }

  _index(num, day, sentence, section) {
    const year = day.slice(0, 4);
    fs.mkdirSync(this.indexDir, { recursive: true });
    const yf = path.join(this.indexDir, year + '.md');
    let lines = fs.existsSync(yf)
      ? fs.readFileSync(yf, 'utf8').split('\n')
      : [`# ${year} 年`, '', '> 只回答「在哪」，不回答「是什么」。', ''];
    const head = '## ' + section;
    const row = `- ${sentence} → D${num} · ${day.slice(5)}`;

    let start = lines.findIndex((l) => l.trim() === head);
    if (start < 0) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push('', head, '', row);
    } else {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) { end = i; break; }
      }
      let last = start;
      for (let i = start + 1; i < end; i++) if (lines[i].trim()) last = i;
      lines.splice(last + 1, 0, row);
    }
    fs.writeFileSync(yf, lines.join('\n') + '\n', 'utf8');

    // 目录（L0）：只写「哪一年、多少件、几个主题」
    const years = fs.readdirSync(this.indexDir).filter((f) => /^\d{4}\.md$/.test(f)).sort().reverse();
    const rows = years.map((f) => {
      const t = fs.readFileSync(path.join(this.indexDir, f), 'utf8');
      const n = (t.match(/→\s*D\d+/g) || []).length;
      const tops = [...t.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]).slice(0, 4).join(' / ');
      return `- ${f.slice(0, 4)} · ${n} 件 · ${tops}`;
    });
    fs.writeFileSync(this.indexFile, [
      '# 记忆目录', '',
      '> 按年分层。详情在 `index/<年>.md`，原文在 `raw/<年-月-日>.md`。',
      '> 本文件可整份重建，丢了不心疼。', '',
      '最近', ...rows, '',
    ].join('\n'), 'utf8');
  }
}

function cut(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
