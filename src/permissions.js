/**
 * permissions.js —— 权限闸门
 *
 * 一条信念：陪伴助手的能力边界必须由用户来划，而且要能随时收回。
 *
 * 核心区分（很多产品做错的地方）：
 *   snapshot —— 快照型：截一张图、开一次摄像头。用户看得见、结束即止。
 *   stream   —— 持续型：连拍、看视频、一直听。等同于监控。
 *   这两类绝不能合成一个开关。允许你截一张屏，不等于允许你一直看着。
 *
 * 每一个决定都落审计日志。用户有权问「你凭什么这么做」。
 * 失败即拒绝（fail closed）：拿不到明确同意，就当拒绝。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 权限级别，从紧到松 */
export const LEVELS = ['deny', 'ask', 'session', 'always'];

/** 能力清单。kind 决定配额策略，risk 决定默认值。 */
export const CAPABILITIES = {
  'screen.snapshot': {
    label: '截一张屏', kind: 'snapshot', risk: 1,
    note: '只在这次调用时抓一帧，结束即止。',
  },
  'window.title': {
    label: '看你在用什么', kind: 'snapshot', risk: 1,
    note: '只读窗口标题与进程名，不抓画面。几乎不花 token，但等于知道你在干什么——标题里可能有文件名、网页名、聊天对象。',
  },
  'video.watch': {
    label: '看一段视频', kind: 'snapshot', risk: 1,
    note: '读你指定的本地视频文件，抽几帧看。不碰屏幕、不录屏。',
  },
  'screen.stream': {
    label: '持续看屏幕', kind: 'stream', risk: 3,
    note: '连续抓帧（看视频、盯进度）。等同于监视你正在做什么，默认禁止。',
  },
  'camera.snapshot': {
    label: '开一次摄像头', kind: 'snapshot', risk: 2,
    note: '拍一张照片就关掉。',
  },
  'camera.stream': {
    label: '持续开摄像头', kind: 'stream', risk: 3,
    note: '摄像头保持开启。默认禁止。',
  },
  'microphone': {
    label: '听声音', kind: 'stream', risk: 3,
    note: '录一段音频。默认禁止。',
  },
  'clipboard.read': {
    label: '读剪贴板', kind: 'snapshot', risk: 2,
    note: '剪贴板里可能有密码和验证码。',
  },
  'files.read': {
    label: '读文件', kind: 'snapshot', risk: 1,
    note: '限定在记忆目录与工作区内。',
  },
  'files.write': {
    label: '写文件', kind: 'snapshot', risk: 2,
    note: '限定在记忆目录与工作区内，不许覆盖审计日志与权限配置。',
  },
  'shell': {
    label: '执行命令', kind: 'snapshot', risk: 3,
    note: '默认禁止。开了就等于把机器交出去。',
  },
  'network': {
    label: '联网', kind: 'snapshot', risk: 2,
    note: '出网会泄露上下文。',
  },

  'model.ask': {
    label: '问外部模型', kind: 'snapshot', risk: 2,
    note: '把内容发给 OpenAI / Claude / 千问 / DeepSeek 之一，会产生费用。和「联网」分开，因为这一项真的要花钱。',
  },
  'browse.read': {
    label: '自己开网页看', kind: 'snapshot', risk: 1,
    note: '用她自己的浏览器窗口打开 B 站/抖音等，读页面上的标题、评论。会开一个独立窗口，不碰你自己的浏览器。',
  },
  'browse.scroll': {
    label: '自己往下刷', kind: 'act', risk: 2,
    note: '在页面上滚动、切下一条视频。会改变页面状态，但不点任何按钮。',
  },
  'browse.auto': {
    label: '按时段自己刷', kind: 'stream', risk: 2,
    note: '在设定的时段和时长内，她自己去刷。等同于把「看什么」交给她几分钟。默认禁止。',
  },
  'browse.app': {
    label: '操作桌面 App', kind: 'act', risk: 2,
    note: '往抖音等客户端窗口发滚轮／按键。只发滚动，不点任何东西。',
  },
  'comment.draft': {
    label: '起草评论', kind: 'snapshot', risk: 0,
    note: '只生成文字，不打进任何框里。默认允许。',
  },
  'comment.post': {
    label: '把评论发出去', kind: 'act', risk: 3,
    note: '拿你的账号对外发言，发出去收不回。默认禁止，且必须你点头。',
  },
  'message.draft': {
    label: '起草消息', kind: 'snapshot', risk: 0,
    note: '只生成内容，不发送。默认允许。',
  },
  'message.send': {
    label: '发送消息', kind: 'act', risk: 3,
    note: '以你的名义对外说话，发出去收不回。每次都问。',
  },
};

/** 出厂默认。宁可多问一句，不要事后道歉。 */
/** 出厂设置。导出是为了让用户（和 doctor）能一眼看到「默认给到了什么程度」。 */
export const DEFAULT_LEVELS = {
  'screen.snapshot': 'ask',
  'window.title': 'session',
  'video.watch': 'ask',
  'screen.stream': 'deny',
  'camera.snapshot': 'ask',
  'camera.stream': 'deny',
  'microphone': 'deny',
  'browse.read': 'ask',
  'browse.scroll': 'ask',
  'browse.auto': 'deny',
  'browse.app': 'deny',
  'comment.draft': 'always',
  'comment.post': 'deny',
  'clipboard.read': 'ask',
  'files.read': 'session',
  'files.write': 'ask',
  'shell': 'deny',
  'network': 'ask',
  'model.ask': 'ask',
  'message.draft': 'always',
  'message.send': 'ask',
};

/** 每小时的硬配额。超了就停，不靠模型自觉。 */
const QUOTA = {
  'screen.snapshot': { perHour: 30, unit: '张' },
  'window.title': { perHour: 600, unit: '次' },
  'video.watch': { perHour: 12, unit: '段' },
  'screen.stream': { perHour: 3600, unit: '秒' },
  'camera.snapshot': { perHour: 12, unit: '张' },
  'camera.stream': { perHour: 300, unit: '秒' },
  'microphone': { perHour: 600, unit: '秒' },
  'browse.read': { perHour: 300, unit: '次' },
  'browse.scroll': { perHour: 600, unit: '次' },
  'browse.auto': { perHour: 120, unit: '分钟' },
  'browse.app': { perHour: 600, unit: '次' },
  'comment.post': { perHour: 6, unit: '条' },
  'message.send': { perHour: 10, unit: '条' },
  // 问外部模型是唯一「按次直接花钱」的能力，封顶要更紧：
  // 60 次/小时够用（判读、写草稿、筛资讯），循环调用在这里会被挡住。
  'model.ask': { perHour: 60, unit: '次' },
};

export class Permissions {
  constructor(opts = {}) {
    this.home = opts.home || path.join(process.env.DSH_COMPANION_HOME || '.dsh-companion');
    this.dir = path.join(this.home);
    this.file = path.join(this.dir, 'permissions.json');
    this.audit = path.join(this.dir, 'audit.jsonl');
    this.log = opts.log || (() => {});
    this.session = new Set();       // 本次会话内授予的（重启即失效）
    this.usage = new Map();         // 配额用量：cap → [{t, n}]
    this.data = this._load();
  }

  /** 配置所在目录永远不许被工具写——否则 agent 能给自己提权 */
  isProtected(p) {
    const a = path.resolve(p);
    return a === path.resolve(this.file) || a === path.resolve(this.audit)
      || a.startsWith(path.resolve(this.dir) + path.sep);
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const merged = { ...DEFAULT_LEVELS };
      for (const [k, v] of Object.entries(raw.levels || {})) {
        if (CAPABILITIES[k] && LEVELS.includes(v)) merged[k] = v;
      }
      return { levels: merged, targets: raw.targets || {} };
    } catch {
      return { levels: { ...DEFAULT_LEVELS }, targets: {} };
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 上忽略 */ }
    fs.renameSync(tmp, this.file);
  }

  level(cap) {
    if (!CAPABILITIES[cap]) return 'deny';   // 未知能力一律拒绝
    return this.data.levels[cap] || 'deny';
  }

  setLevel(cap, level) {
    if (!CAPABILITIES[cap]) throw new Error('未知能力：' + cap);
    if (!LEVELS.includes(level)) throw new Error('未知级别：' + level);
    this.data.levels[cap] = level;
    this.save();
    this.record('config', { cap, level });
    return this.level(cap);
  }

  record(kind, extra = {}) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.audit, JSON.stringify({
        at: new Date().toISOString(), kind, ...extra,
      }) + '\n');
    } catch { /* 审计失败不阻断主流程，但要记 */ this.log('[warn] 审计写入失败'); }
  }

  /**
   * 判一次调用。
   * @returns {{decision:'allow'|'deny'|'ask', reason:string}}
   */
  decide(cap, { cost = 1 } = {}) {
    const meta = CAPABILITIES[cap];
    if (!meta) return { decision: 'deny', reason: '未知能力一律拒绝：' + cap };
    const lv = this.level(cap);
    if (lv === 'deny') return { decision: 'deny', reason: '用户设为禁止：' + meta.label };
    const q = this._quotaLeft(cap, cost);
    if (q.left < cost) {
      return { decision: 'deny', reason: `配额用完（${cap} 每小时上限 ${q.perHour}${q.unit}）` };
    }
    if (lv === 'always') return { decision: 'allow', reason: '用户已永久允许' };
    if (lv === 'session' && this.session.has(cap)) return { decision: 'allow', reason: '本会话已允许' };
    return { decision: 'ask', reason: '需要你确认：' + CAPABILITIES[cap].label };
  }

  consume(cap, cost = 1) {
    const arr = this.usage.get(cap) || [];
    const now = Date.now();
    const fresh = arr.filter((x) => now - x.t < 3600_000);
    fresh.push({ t: now, n: cost });
    this.usage.set(cap, fresh);
  }

  _quotaLeft(cap, cost) {
    const spec = QUOTA[cap];
    if (!spec) return { left: Infinity, perHour: Infinity, unit: '' };
    const now = Date.now();
    const used = (this.usage.get(cap) || [])
      .filter((x) => now - x.t < 3600_000)
      .reduce((a, x) => a + x.n, 0);
    return { left: spec.perHour - used, perHour: spec.perHour, unit: spec.unit };
  }

  grantSession(cap) {
    if (CAPABILITIES[cap]) this.session.add(cap);
  }

  /** 给 /perm 命令用的人类可读表 */
  describe() {
    const rows = [];
    for (const [cap, meta] of Object.entries(CAPABILITIES)) {
      const lv = this.level(cap);
      const q = this._quotaLeft(cap, 0);
      const used = Number.isFinite(q.perHour) ? `${q.perHour - q.left}/${q.perHour}${q.unit}` : '—';
      rows.push({ cap, label: meta.label, level: lv, kind: meta.kind, quota: used, note: meta.note });
    }
    return rows;
  }
}

/**
 * 包一层：把权限判定塞进工具执行前面。
 * 拿不到审批服务，就当拒绝（fail closed）——绝不当成同意。
 */
export function guarded(pm, cap, fn, opts = {}) {
  return async (input, ctx) => {
    const cost = typeof opts.cost === 'function' ? opts.cost(input) : (opts.cost || 1);
    const d = pm.decide(cap, { cost });

    if (d.decision === 'deny') {
      pm.record('deny', { cap, input: brief(input), reason: d.reason });
      return { ok: false, denied: true, reason: d.reason, error: d.reason,
        hint: `用户可调整「${cap}」这一项权限` };
    }

    if (d.decision === 'ask') {
      const asker = ctx?.approval?.request;
      if (typeof asker !== 'function') {
        pm.record('deny', { cap, input: brief(input), reason: '没有审批服务（fail closed）' });
        return { ok: false, denied: true, error: '需要你确认，但当前环境无法弹审批，已按拒绝处理',
          reason: '需要你确认，但当前环境无法弹审批，已按拒绝处理' };
      }
      let verdict;
      try {
        verdict = await ctx.approval.request({
          title: '陪伴助手请求权限',
          capability: cap,
          label: CAPABILITIES[cap].label,
          detail: CAPABILITIES[cap].note,
          input: brief(input),
        });
      } catch (e) {
        pm.record('deny', { cap, reason: '审批异常：' + e.message });
        return { ok: false, denied: true, error: '审批失败，已按拒绝处理', reason: '审批失败，已按拒绝处理' };
      }
      // DSH 只认 allowed-once：批准一次就只放这一次，不顺手提权
      if (verdict !== 'allowed-once' && verdict?.kind !== 'allowed-once' && verdict !== true) {
        pm.record('deny', { cap, input: brief(input), reason: '用户未批准' });
        return { ok: false, denied: true, error: '你拒绝了这次操作', reason: '你拒绝了这次操作' };
      }
    }

    pm.consume(cap, cost);
    pm.record('allow', { cap, input: brief(input) });
    return fn(input, ctx);
  };
}

function brief(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch { return '(无法序列化)'; }
}
