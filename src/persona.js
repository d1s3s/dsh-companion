/**
 * persona.js —— 人格
 *
 * 一条原则：**脚本决定「该不该说、说得有多确定」，模型决定「具体怎么说」。**
 * 把这两件事混在一起会同时坏掉两边——脚本写死的句子说三遍就穿帮，
 * 模型自由发挥又会编造。所以这里只输出状态和边界，不出台词。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 四种初始人格。同一份记忆、不同加权＝不同的人。 */
export const PROFILES = {
  tender: { name: '温柔', desc: '记性黏，记得你的情绪和原话，爱主动关心', halfLife: 60, warm: 0.50, maxMention: 2 },
  sharp: { name: '毒舌', desc: '记仇记得久，专挑你说过的大话，但绝不编造', halfLife: 120, warm: 0.52, maxMention: 1 },
  pro: { name: '专业', desc: '只记结论、事实与否决理由，少寒暄', halfLife: 21, warm: 0.60, maxMention: 1 },
  casual: { name: '随性', desc: '忘得快，只聊眼前，不翻旧账', halfLife: 4, warm: 0.68, maxMention: 1 },
};

/**
 * 主动提旧事的配额。防油腻靠这个，不靠模型自觉。
 * 一天最多一次，同一条七天内不重复。
 */
export class MentionGate {
  constructor(file) {
    this.file = file;
    this.data = { day: '', count: 0, seen: {} };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* 首次 */ }
    const today = new Date().toISOString().slice(0, 10);
    if (this.data.day !== today) { this.data.day = today; this.data.count = 0; }
  }

  may(id) {
    if (this.data.count >= 1) return { ok: false, reason: '今天已经主动提过一次了，别再提' };
    const last = this.data.seen[id];
    if (last) {
      const days = (Date.now() - new Date(last).getTime()) / 86400_000;
      if (days < 7) return { ok: false, reason: `这条 ${Math.floor(days)} 天前刚提过，别重复` };
    }
    return { ok: true };
  }

  record(id) {
    this.data.count += 1;
    if (id) this.data.seen[id] = new Date().toISOString().slice(0, 10);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* 配额写不进去不影响主流程，但下次会重复提，可接受 */ }
  }
}

/**
 * 会话开场注入的那一段。目标 ≤300 token：
 * 说清「怎么说话」「记得什么」「能不能主动提」三件事，别塞细节。
 */
export function sessionSection({ memory, profile = 'tender', gate, budgetTokens = 300 }) {
  const p = PROFILES[profile] || PROFILES.tender;
  const out = [];

  out.push(`【陪伴人格 · ${p.name}】${p.desc}`);
  out.push('语气：先接住情绪，再说事；不客套、不总结、不列 1234。一次最多提一件旧事，没接就放下。');
  out.push('底线：不确定就说记不准，绝不编造。软的可模糊（月份、先后），硬的不许错（金额、路径、承诺、被否决过的事）。');

  if (memory?.exists?.()) {
    const r = memory.resident({ days: 3 });
    out.push('【记得的事】' + r.text.replace(/\n/g, ' / '));
  } else {
    out.push('【记得的事】（还没有记忆。像刚认识，别装熟。）');
  }

  // 主动提一句的资格：靠配额判，不靠感觉
  if (gate) {
    const v = memory?.valuable?.('否决', { limit: 1 }) || [];
    if (v.length) {
      const g = gate.may(v[0].id);
      out.push(g.ok
        ? `【可以提一句】${v[0].title}（今天还没提过；一句就够，提完回当下）`
        : `【今天别提旧事】${g.reason}`);
    }
  }

  let text = out.join('\n');
  // 粗估：中文 1 字 ≈ 1.5 token，超了就砍最后一段
  const est = (s) => Math.ceil(s.length * 1.5);
  while (est(text) > budgetTokens && out.length > 3) {
    out.pop();
    text = out.join('\n');
  }
  return { text, tokens: est(text) };
}
