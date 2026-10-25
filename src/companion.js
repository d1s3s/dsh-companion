/**
 * companion.js —— 核心：与宿主无关的那部分
 *
 * 这里**不知道**自己跑在 DSH、MCP 还是别的什么上面。它只认一个五方法的 host：
 *
 *   host.register(spec)   注册一个工具
 *   host.emit(ev, data)   往界面推事件（没有界面就丢掉）
 *   host.log(msg)         普通日志
 *   host.warn(msg)        警告
 *   host.on(name, fn)     挂钩子（宿主不支持就返回 false）
 *
 * 为什么要在意这件事：陪伴这件事的价值不在「哪个 Agent 能调截屏」，
 * 而在记住你、知道分寸、说人话。换模型、换客户端都不该让这些重来一遍。
 * 所以核心必须能搬走——搬走时只需要写一个新的 host 适配器。
 *
 * 这个文件只做编排：把「权限闸门 → 采集/记忆/消息 → 记账 → 说成人话」串起来。
 * 每一笔 token 都实测并记账——看图比聊天贵得多，用户有权在花出去之前知道价格。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Permissions, guarded, CAPABILITIES } from './permissions.js';
import { Memory } from './memory.js';
import { MentionGate, sessionSection, PROFILES } from './persona.js';
import { grabScreen, watchScreen, grabCamera, listCameras, probe, cleanup, LIMITS, videoFrames, NO_FFMPEG } from './capture.js';
import { draft, send, CHANNELS } from './messaging.js';
import { Ledger, imageTokens, textTokens } from './cost.js';
import { viewing } from './window.js';
import { SITES, SITE_IDS, siteOf, ensureBrowser, attach, readPage, goto, wheel, evaluate, searchSite } from './browser.js';
import { BrowsePolicy, activeWindow, parseWindow } from './browse-policy.js';
import { postComment, readComments, SUPPORTED_COMMENT_SITES } from './comment.js';
import { appScroll, appDriveAvailable } from './app-drive.js';
import {
  PROVIDERS, PROVIDER_IDS, ask as askModel, ready as modelsReady,
  saveKey, apiKey, mask, pick as pickProvider, roughTokens,
} from './models.js';

/** 插件根目录。角色包路径默认相对它，所以换安装位置不用改配置。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');



/** 宿主要能注册工具才能干活。DSH 侧靠 inject 声明，其它宿主由 host 自己保证 */


/** 状态名给工具输出用，跟客户端 client.cjs 的 STATES 保持一致 */
const STATES_HINT = {
  idle: '空闲', greet: '打招呼', think: '思考', type: '写作', tool: '动手',
  wait: '等你确认', done: '完成', error: '出错', sleep: '睡着', happy: '开心',
};

const text = (t) => [{ type: 'text', text: String(t) }];

export function buildCompanion(host, config = {}) {
  const home = config.home || process.env.DSH_COMPANION_HOME
    || path.join(os.homedir(), '.dsh-companion');
  const memoryDir = config.memoryDir || path.join(home, 'memory');
  const profileKey = PROFILES[config.profile] ? config.profile : 'tender';

  const pm = new Permissions({ home, log: (m) => host.log(m) });
  const mem = new Memory(memoryDir);
  const gate = new MentionGate(path.join(home, 'mention.json'));
  const ledger = new Ledger(home);
  const PRICE = Number(config.pricePerMTokens ?? 2);   // 元 / 百万 token
  const PER_BOWL = Number(config.tokensPerBowl ?? 1000); // 一碗白饭换多少 token

  /* ---------------------------------------------------------------- 浏览器 */
  /**
   * 「她自己刷」这件事的状态机：
   *   她的浏览器（独立 profile） → 一个页面连接 → 一个会话（有时长上限）
   *
   * 连接是懒建的：没人让她刷的时候不起浏览器、不占内存。
   */
  const browse = new BrowsePolicy({ home, policy: config.browse });
  const PORT = Number(config.browserPort ?? 9222);
  let bs = null;   // 当前页面连接 { cdp, page, site }

  const browser = {
    /** 开浏览器 + 连页面。第二次调用几乎 0 成本（端口活着就直接连）。 */
    async ready() {
      const r = await ensureBrowser({ home, port: PORT, profile: config.browserProfile });
      if (!r.ok) return r;
      if (bs && bs.cdp && bs.cdp.ws && bs.cdp.ws.readyState === 1) return { ok: true, ...r, reused: true };
      const a = await attach(PORT);
      if (!a.ok) return a;
      bs = { cdp: a.cdp, page: a.page, site: siteOf(a.page.url) };
      return { ok: true, ...r, page: a.page };
    },
    cdp() { return bs && bs.cdp && bs.cdp.ws && bs.cdp.ws.readyState === 1 ? bs.cdp : null; },
    site() { return bs?.site || null; },
    setSite(s) { if (bs) bs.site = s; },
    detach() { try { bs?.cdp?.close(); } catch { /* 已断 */ } bs = null; },
  };

  /** 每次工具调用开头都检查「这次会话是不是到点了」。不需要额外的定时器。 */
  const checkExpiry = () => {
    const e = browse.expired();
    if (e && e.expired) {
      const note = `自己刷的时间到了（${e.minutes} 分钟），已停。今天累计 ${e.dayUsed}/${e.dayLimit} 分钟。`;
      host.log(`[companion] ${note}`);
      return note;
    }
    return null;
  };

  const siteName = (id) => (id && SITES[id] ? SITES[id].name : id || '未知站点');

  /** 把一次页面读取说成人话。模型看这个就够回答「她在看什么」了。 */
  const describePage = (p) => {
    const bits = [];
    if (p.site) bits.push(`在 ${p.siteName || siteName(p.site)}`);
    if (p.title) bits.push(`标题：${p.title}`);
    if (p.author) bits.push(`作者：${p.author}`);
    if (p.video) {
      const t = Math.round(p.video.t || 0);
      const d = Number.isFinite(p.video.d) ? Math.round(p.video.d) : null;
      bits.push(`进度：${t}${d ? '/' + d : ''} 秒${p.video.paused ? '（暂停中）' : '（在播）'}`);
    }
    if (p.items?.length) bits.push(`列表里还有：${p.items.slice(0, 6).join('｜')}`);
    if (p.comments?.length) bits.push(`热评：${p.comments.slice(0, 3).join('｜')}`);
    return bits.join('\n');
  };

  /**
   * 加载角色包。浏览器端读不到本地文件，所以这里把图读成 data URI 推过去。
   *
   * 两种包都认：
   *   · dsh-pet v1（pet.json + animations.json）—— 社区通用格式，大肥鱼就是这种。
   *     图集有几 MB，base64 之后更胖，但只在开场推一次；图集在构建时就降过采样，
   *     444px → 222px，实际显示 170px 够用，体积掉到 1/4。
   *   · pack.json（art.base + art.states）—— 简单包，一个状态一张图。
   * 都没配就返回 null，客户端自动回落到内置那只鲸鱼。
   */
  /**
   * 上次切换过的形象。
   *
   * 为什么单独存一个文件而不是改用户配置：配置文件是用户的，插件不该悄悄改它。
   * character.json 是插件的运行时状态，删掉就等于回到配置里的默认值。
   */
  const savedPack = () => {
    try {
      const f = path.join(home, 'character.json');
      if (!fs.existsSync(f)) return null;
      return JSON.parse(fs.readFileSync(f, 'utf8')).pack || null;
    } catch { return null; }
  };
  const rememberPack = (pack) => {
    try {
      fs.mkdirSync(home, { recursive: true });
      if (pack) fs.writeFileSync(path.join(home, 'character.json'), JSON.stringify({ pack, at: Date.now() }, null, 1));
      else fs.rmSync(path.join(home, 'character.json'), { force: true });
    } catch { /* 存不下就算了，本次会话仍然生效 */ }
  };

  const loadCharacter = (override) => {
    // 配置里可以写绝对路径，也可以写相对插件目录的路径（默认就是 packs/bigfish-classic）。
    // override 是运行时切换用的——「换成成年版」不该需要改配置再重启。
    // 优先级：本次指定 > 上次切换记下的 > 配置文件。
    const raw = override || savedPack() || config.characterPack;
    if (!raw) return null;

    // 配色皮肤不走文件，直接交给客户端的 whaleSVG 换色
    const tk = themeKey(raw);
    if (tk) {
      if (!SVG_THEMES[tk]) {
        host.warn(`[companion] 不认识的配色「${tk}」，用默认的`);
        return { mode: 'svg', theme: 'default', name: SVG_THEMES.default.label };
      }
      return { mode: 'svg', theme: tk, name: SVG_THEMES[tk].label };
    }

    const dir = path.isAbsolute(raw) ? raw : path.resolve(PLUGIN_ROOT, raw);
    try {
      const toURI = (file) => {
        if (!file || !fs.existsSync(file)) return null;
        const ext = path.extname(file).slice(1).toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'webp' ? 'image/webp' : `image/${ext}`;
        return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      };

      // ---- dsh-pet v1
      const petFile = path.join(dir, 'pet.json');
      if (fs.existsSync(petFile)) {
        const pet = JSON.parse(fs.readFileSync(petFile, 'utf8'));
        const animFile = path.join(dir, pet.animations || 'animations.json');
        const animations = fs.existsSync(animFile)
          ? JSON.parse(fs.readFileSync(animFile, 'utf8'))
          : [];
        const assets = {};
        let bytes = 0;
        for (const [k, v] of Object.entries(pet.assets || {})) {
          const f = path.join(dir, v.path);
          const uri = toURI(f);
          if (!uri) continue;
          bytes += fs.statSync(f).size;
          assets[k] = { src: uri, width: v.width, height: v.height };
        }
        if (!Object.keys(assets).length || !animations.length) {
          host.warn(`[companion] 角色包不完整（${dir}）：没有素材或没有动作`);
          return null;
        }
        // 台词：有就用上游的，没有就静默
        let dialogue = null;
        const dlgFile = path.join(dir, pet.dialogue || 'dialogue.json');
        if (fs.existsSync(dlgFile)) {
          try { dialogue = JSON.parse(fs.readFileSync(dlgFile, 'utf8')); } catch { /* 烂了不用 */ }
        }
        const art = {
          mode: 'atlas',
          name: pet.name || '',
          pet: {
            canvas: pet.canvas,
            assets,
            animations,
            fallbacks: pet.fallbacks || {},
            dialogue,
          },
        };
        host.log(
          `[companion] 角色包 ${pet.name || dir}：${animations.length} 个动作 · `
          + `${Object.keys(assets).length} 张图集 · ${(bytes / 1048576).toFixed(1)} MB`,
        );
        return art;
      }

      // ---- 简单包
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
      const art0 = manifest.art || {};
      const states = {};
      for (const [k, v] of Object.entries(art0.states || {})) {
        const u = toURI(path.join(dir, 'art', v));
        if (u) states[k] = u;
      }
      const base = toURI(path.join(dir, 'art', art0.base));
      if (!base) return null;
      host.log(`[companion] 角色包 ${manifest.name || dir}：${Object.keys(states).length} 个状态图`);
      return { mode: 'image', base, states, name: manifest.name || '' };
    } catch (e) {
      host.warn(`[companion] 角色包读不了（${dir}）：${e.message}`);
      return null;
    }
  };

  /**
   * 内置鲸鱼的配色皮肤。
   *
   * 为什么是「配色」不是「官方形象」：OpenAI / Anthropic / 阿里都是有法务的商业主体，
   * 复制它们的官方形象是商标问题，和用社区角色不是一回事。
   * 这里借的是气质——青绿偏工程、陶土偏人文、星紫偏科技——不复制任何 logo。
   *
   * 真要用官方素材：放进 ~/.dsh-companion/packs/，那里优先级更高，会盖掉这些。
   */
  const SVG_THEMES = {
    default: { label: '深海蓝（内置鲸鱼）', hint: '蓝发鲸鱼，最朴素那只' },
    gpt: { label: '青绿', hint: '像 OpenAI 的配色，冷静偏工程' },
    claude: { label: '陶土橙', hint: '像 Claude 的配色，暖偏人文' },
    qwen: { label: '星紫', hint: '像通义千问的配色，偏科技' },
  };
  const themeKey = (raw) => (raw && String(raw).startsWith('theme-') ? String(raw).slice(6) : null);

  /**
   * 有哪些形象可用。
   *
   * 两个地方都看：插件自带的 packs/，和用户自己放在 home 下的 packs/。
   * 后者优先——用户放的包不该被插件升级覆盖，也不该和自带的混在一起分不清。
   */
  const listPacks = () => {
    const dirs = [
      path.join(home, 'packs'),
      path.join(PLUGIN_ROOT, 'packs'),
    ];
    const seen = new Set();
    const out = [];

    // 现在用的是哪个：切换记录 > 配置。配色皮肤和角色包是互斥的两种。
    const effective = savedPack() || config.characterPack || '';
    const currentTheme = themeKey(effective) || (effective ? null : 'default');
    const currentDir = currentTheme ? null : (() => {
      const raw = effective;
      if (!raw) return null;
      return path.isAbsolute(raw) ? raw : path.resolve(PLUGIN_ROOT, raw);
    })();

    // 配色皮肤排前面：零体积、随插件走、换一下就见效
    for (const [id, meta] of Object.entries(SVG_THEMES)) {
      out.push({
        dir: `theme-${id}`,
        name: `theme-${id}`,
        label: meta.label,
        kind: 'theme',
        actions: 10,
        mb: 0,
        hint: meta.hint,
        current: currentTheme === id,
        writable: false,
      });
    }

    for (const base of dirs) {
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        if (seen.has(dir)) continue;
        let st;
        try { st = fs.statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;

        const petFile = path.join(dir, 'pet.json');
        const simpleFile = path.join(dir, 'pack.json');
        if (!fs.existsSync(petFile) && !fs.existsSync(simpleFile)) continue;

        let label = name;
        let actions = 0;
        let sizeKb = 0;
        try {
          if (fs.existsSync(petFile)) {
            const pet = JSON.parse(fs.readFileSync(petFile, 'utf8'));
            label = pet.name || name;
            const af = path.join(dir, pet.animations || 'animations.json');
            if (fs.existsSync(af)) {
              const a = JSON.parse(fs.readFileSync(af, 'utf8'));
              actions = Array.isArray(a) ? a.length : 0;
            }
          }
          const walk = (d) => {
            for (const f of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, f.name);
              if (f.isDirectory()) walk(p);
              else sizeKb += fs.statSync(p).size / 1024;
            }
          };
          walk(dir);
        } catch { /* 包坏了也列出来，让人能看见并删掉 */ }

        seen.add(dir);
        out.push({
          dir,
          name,
          label,
          kind: fs.existsSync(petFile) ? 'dsh-pet' : 'simple',
          actions,
          mb: Number((sizeKb / 1024).toFixed(1)),
          current: currentDir === dir,
          writable: base === path.join(home, 'packs'),
        });
      }
    }
    return out;
  };

  let character = loadCharacter();

  const emitCharacter = () => {
    if (!character) return;
    try {
      host.emit('session/event', {
        kind: 'character',
        art: character,
        size: Number(config.characterSize) || 170,
      });
    } catch { /* 没 UI 算了 */ }
  };

  /** 把用量推给客户端形象——数字要长在头上，不能只躺在日志里 */
  const emitUsage = () => {
    try {
      host.emit('session/event', {
        kind: 'usage',
        tokens: ledger.day.tokens,
        sessionTokens: ledger.session.tokens,
        cost: (ledger.day.tokens / 1e6) * PRICE,
        bowls: Math.floor(ledger.day.tokens / PER_BOWL),
      });
    } catch { /* 没有 UI 半边就算了，不影响功能 */ }
  };

  const reg = (spec) => {
    try {
      host.register(spec);
    } catch (e) {
      host.warn(`[companion] 工具 ${spec.name} 注册失败：${e.message}`);
    }
  };

  /** 统一收尾：算钱、记账、把数字塞进 note */
  const bill = (kind, units, note) => {
    const total = units.reduce((a, u) => a + u, 0);
    const st = ledger.add(kind, total, {});
    emitUsage();
    const money = `¥${((ledger.day.tokens / 1e6) * PRICE).toFixed(4)}`;
    const bowls = Math.floor(ledger.day.tokens / PER_BOWL);
    return { cost: st, money, bowls, note: `${note}\n（${st.line}｜今日 ${money}｜🍚 ${bowls} 碗）` };
  };

  // ---------------------------------------------------------------- 看

  reg({
    name: 'companion_see_screen',
    description: '截一张当前屏幕（快照，结束即止）。用于帮用户看界面、读报错、认图片里是什么。会报告 token 消耗。',
    parameters: {
      region: { type: 'string', required: false, description: '可选，裁剪区域 "x,y,宽,高"，只给关心的那块能省 token 也更不侵入' },
      maxWidth: { type: 'number', required: false, description: '可选，默认 1280。降到 800 能省约六成 token' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'screen.snapshot', async (args) => {
      const r = await grabScreen({ region: parseRegion(args.region), maxWidth: args.maxWidth });
      if (!r.ok) {
        // 缺 ffmpeg 是环境问题，不是「出错了」。说清怎么装，别让人以为是插件坏了。
        if (r.noFfmpeg || !r.bin) return { ok: false, error: NO_FFMPEG, hint: NO_FFMPEG };
        return { ok: false, error: `${r.error}（ffmpeg: ${r.bin}）`, detail: r.detail };
      }

      const buf = fs.readFileSync(r.file);
      const it = imageTokens(buf);
      const gate = ledger.check(it.tokens);
      if (!gate.ok) {
        cleanup([r.file]);
        return { ok: false, error: gate.reason, hint: '让用户同意后再来，或者用 region 只截一小块' };
      }
      const b64 = buf.toString('base64');
      cleanup([r.file]);
      const b = bill('看屏幕', [it.tokens],
        `截了一张 ${it.w}×${it.h} 的屏幕。看完说结论，别逐像素描述。`);
      return { ok: true, image: b64, mime: 'image/jpeg', width: it.w, height: it.h, ...b };
    }),
  });

  reg({
    name: 'companion_watch_screen',
    description: `连续看一段屏幕（看视频、盯进度、观察变化）。上限 ${LIMITS.streamMaxSeconds} 秒，到点自己停。会先报预算再花。`,
    parameters: {
      seconds: { type: 'number', required: true, description: `看多久，上限 ${LIMITS.streamMaxSeconds} 秒` },
      fps: { type: 'number', required: false, description: '每秒抓几帧，上限 2。默认 1' },
      region: { type: 'string', required: false, description: '可选，只盯某块区域 "x,y,宽,高"' },
      maxWidth: { type: 'number', required: false, description: '默认 1280；长视频建议降到 800' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'screen.stream', async (args) => {
      const r = await watchScreen({
        seconds: args.seconds, fps: args.fps,
        region: parseRegion(args.region), maxWidth: args.maxWidth,
      });
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail };

      // 先算总价再决定要不要交出去——帧已经抓了不要紧，让模型看才是花钱的地方
      const items = r.files.map((f) => ({ f, it: imageTokens(fs.readFileSync(f)) }));
      const total = items.reduce((a, x) => a + x.it.tokens, 0);
      const gate = ledger.check(total);
      if (!gate.ok) {
        const perFrame = items[0]?.it.tokens || 1200;
        cleanup(r.files);
        return {
          ok: false, error: gate.reason,
          tryThis: `${r.count} 帧 × ${perFrame} token。降到「${Math.max(3, Math.floor(r.seconds / 3))} 秒 1 帧」或 maxWidth=800 只需约 ${Math.round(total / 3)} token`,
          hint: '跟用户说一声要花多少，再决定要不要看',
        };
      }

      const frames = items.map((x) => ({ mime: 'image/jpeg', data: fs.readFileSync(x.f).toString('base64') }));
      cleanup(r.files);
      const b = bill('看屏幕(连续)', items.map((x) => x.it.tokens),
        `看了 ${r.seconds} 秒，${r.count} 帧（${r.stoppedBy}），每帧 ${items[0]?.it.w}×${items[0]?.it.h}。按时间顺序看，只说变化和值得注意的东西。`);
      return { ok: true, count: r.count, seconds: r.seconds, stoppedBy: r.stoppedBy, frames, ...b };
    }, { cost: (a) => Math.min(Math.max(1, Number(a.seconds) || 10), LIMITS.streamMaxSeconds) }),
  });

  reg({
    name: 'companion_watch_video',
    description: '看一段本地视频文件（按秒抽帧，不是看屏幕）。适合刷视频、看录屏、看下载好的片子。会先报预算再花。',
    parameters: {
      path: { type: 'string', required: true, description: '视频文件绝对路径（mp4/mkv/flv/webm/mov 等）' },
      start: { type: 'number', required: false, description: '从第几秒开始看，默认 0。长视频别从头看' },
      seconds: { type: 'number', required: false, description: '看多长，默认 min(总时长, 120)，上限 1800' },
      everySec: { type: 'number', required: false, description: '每几秒抽一帧，默认 2（即 0.5 帧/秒）。想看得细就给 1' },
      frames: { type: 'number', required: false, description: '最多抽几帧，上限 40。比 everySec 优先' },
      maxWidth: { type: 'number', required: false, description: '默认 1280；长视频建议 800' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'video.watch', async (args) => {
      const file = path.resolve(String(args.path || ''));
      if (!fs.existsSync(file)) return { ok: false, error: `找不到这个文件：${file}` };

      const r = await videoFrames({
        file,
        start: args.start,
        seconds: args.seconds,
        fps: args.everySec ? 1 / Math.max(0.5, Number(args.everySec)) : undefined,
        frames: args.frames,
        maxWidth: args.maxWidth,
      });
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail, info: r.info };

      const items = r.files.map((f) => ({ f, it: imageTokens(fs.readFileSync(f)) }));
      const total = items.reduce((a, x) => a + x.it.tokens, 0);
      const gate = ledger.check(total);
      if (!gate.ok) {
        const perFrame = items[0]?.it.tokens || 1200;
        cleanup(r.files);
        return {
          ok: false,
          error: gate.reason,
          tryThis: `${r.count} 帧 × ${perFrame} token。改成每 ${Math.max(2, Math.round(r.seconds / 8))} 秒 1 帧、或 maxWidth=800，约 ${Math.round(total / 4)} token`,
          hint: '先跟用户说一声要花多少，再决定看不看',
        };
      }

      const frames = items.map((x) => ({ mime: 'image/jpeg', data: fs.readFileSync(x.f).toString('base64') }));
      cleanup(r.files);
      const dur = r.info?.durationSec ? `总长 ${r.info.durationSec} 秒，` : '';
      const b = bill('看视频', items.map((x) => x.it.tokens),
        `看了《${path.basename(file)}》${dur}从第 ${r.start} 秒起 ${r.seconds} 秒，抽了 ${r.count} 帧（${r.stoppedBy}）。`
        + '按时间顺序看，只说剧情推进、画面变化和值得注意的细节。');
      return { ok: true, file, count: r.count, start: r.start, seconds: r.seconds, info: r.info, frames, ...b };
    }, { cost: () => 1 }),   // 配额按「段」算，不按秒——12 段/小时，不是 12 秒
  });

  // ------------------------------------------------------------ 自己在网页上刷

  reg({
    name: 'companion_now_viewing',
    description: '不用截图就知道用户此刻在看什么：前台窗口、在哪个平台（B站/抖音/快手/小红书/YouTube）、看的是哪条。约 0 token，比截屏便宜三个数量级。',
    parameters: {
      limit: { type: 'number', required: false, description: '最多列几个内容平台窗口，默认 5' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'window.title', async (args) => {
      const limit = Math.min(Math.max(1, Number(args.limit) || 5), 12);
      const { media, fg, top } = await viewing();
      const lines = [];

      if (fg) {
        lines.push(`前台：${fg.app}${fg.platformName ? `（${fg.platformName}${fg.client ? '客户端' : '网页'}）` : ''}｜${fg.title}`);
      } else {
        lines.push('前台窗口读不到（非 Windows、或拿不到窗口句柄）。下面按「像不像正在看的东西」排序。');
      }

      const m = media.slice(0, limit);
      if (m.length) {
        lines.push('', '内容平台窗口：');
        for (const w of m) {
          lines.push(`  · [${w.platformName}${w.client ? '·客户端' : '·网页'}] ${w.title}${w.foreground ? '  ⟵ 正在看' : ''}`);
        }
      } else {
        lines.push('', '没开 B 站/抖音/快手/小红书/YouTube 的窗口。');
      }

      // 下一步怎么走，按成本从低到高给选项
      const hint = top
        ? `想知道这条具体在讲什么，两种走法：\n  · 截一帧看画面（companion_see_screen，maxWidth=960 约 460 token）\n  · 让她自己开浏览器读标题/评论（companion_open_site，读文字约几十 token）`
        : '';

      const b = bill('看你在用什么', [textTokens(lines.join('\n'))],
        lines.join('\n') + (hint ? `\n\n${hint}` : ''));
      return {
        ok: true,
        foreground: fg ? { app: fg.app, title: fg.title, platform: fg.platform, client: fg.client } : null,
        viewing: m.map((w) => ({ platform: w.platform, platformName: w.platformName, title: w.title, client: w.client, foreground: w.foreground })),
        ...b,
      };
    }),
  });

  reg({
    name: 'companion_open_site',
    description: '用她自己的浏览器窗口打开一个视频平台，读回当前看到什么（标题/作者/进度/列表/热评）。读的是文字不是截图，很省 token。第二次调用会复用已开的窗口。',
    parameters: {
      site: { type: 'string', required: false, description: `平台：${SITE_IDS.join(' / ')}。不给就用当前页` },
      url: { type: 'string', required: false, description: '直接开指定链接（必须属于该平台域名）' },
      fresh: { type: 'boolean', required: false, description: 'true = 重新打开该平台的推荐流首页，默认 false' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'browse.read', async (args) => {
      const expired = checkExpiry();
      const want = args.site ? String(args.site).toLowerCase() : null;
      if (want && !SITES[want]) {
        return { ok: false, error: `不认识的平台「${want}」`, tryThis: `可选：${SITE_IDS.join(' / ')}` };
      }

      const r = await browser.ready();
      if (!r.ok) return { ok: false, error: r.error, hint: r.hint };

      const cdp = browser.cdp();
      if (!cdp) return { ok: false, error: '浏览器连接断了，再试一次' };

      let page;
      const curUrl = bs?.page?.url || '';
      const curSite = siteOf(curUrl);
      const needNav = args.fresh || args.url || (want && want !== curSite);

      if (args.url) {
        // 只许在允许的域名里跳，防止被诱导开到钓鱼页
        const allow = Object.values(SITES).flatMap((s) => s.allow);
        let host = '';
        try { host = new URL(args.url).hostname; } catch { return { ok: false, error: 'URL 不合法' }; }
        if (!allow.some((re) => re.test(host))) {
          return { ok: false, error: `这个域名不在允许列表里（${host}）`, tryThis: `只允许：${SITE_IDS.join('、')}` };
        }
        page = await goto(cdp, args.url);
      } else if (needNav && SITES[want || 'bilibili']) {
        const s = SITES[want || 'bilibili'];
        page = await goto(cdp, s.stream || s.home);
      } else {
        page = await readPage(cdp);
      }

      browser.setSite(page.site || want || curSite);
      const body = describePage(page) || '（页面上没读到内容，可能是还没加载完或需要登录）';
      const extra = r.started ? '\n（刚启动了浏览器窗口。第一次用要在这个窗口里扫码登录一次，之后就不用再登了）' : '';
      const b = bill('开网页看', [textTokens(body + extra)], body + extra + (expired ? `\n\n⚠ ${expired}` : ''));
      return { ok: true, site: page.site, url: page.url, items: page.items, comments: page.comments, video: page.video, ...b };
    }),
  });

  reg({
    name: 'companion_browse_next',
    description: '在她开着的页面上往下刷：滚动、加载更多、切下一条视频。刷完读回新的状态。不点任何按钮。',
    parameters: {
      count: { type: 'number', required: false, description: '刷几次，默认 1，上限 8' },
      dir: { type: 'string', required: false, description: 'up 或 down，默认 down' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'browse.scroll', async (args) => {
      const expired = checkExpiry();
      if (expired) return { ok: false, error: expired, hint: '要接着刷得等下一个时段，或者调 companion_browse_settings 改配额' };

      const cdp = browser.cdp();
      if (!cdp) return { ok: false, error: '还没有开着的页面，先 companion_open_site' };
      const site = browser.site();
      if (site && browse.policy.sites && !browse.policy.sites.includes(site)) {
        return { ok: false, error: `策略里没允许刷 ${siteName(site)}`, tryThis: `当前允许：${(browse.policy.sites || []).join('、')}` };
      }

      const times = Math.min(Math.max(1, Number(args.count) || 1), 8);
      const dy = String(args.dir).toLowerCase() === 'up' ? -800 : 800;
      const page = await wheel(cdp, { dy, times });

      const body = describePage(page) || '（滚了但没读到新内容）';
      const left = browse.session ? `还剩 ${Math.round(browse.sessionLeftMinutes())} 分钟` : '';
      const b = bill('往下刷', [textTokens(body)], body + (left ? `\n（${left}）` : ''));
      return { ok: true, site: page.site, scrolled: times, items: page.items, comments: page.comments, video: page.video, ...b };
    }, { cost: (a) => Math.min(Math.max(1, Number(a.count) || 1), 8) }),
  });

  reg({
    name: 'companion_collect',
    description: '按主题去某个平台搜一批视频，拿回标题/作者/播放量/链接。用来「帮我看看最近 XX 有什么值得看的」「盯着这个领域的新东西」。只读不点，很省 token。',
    parameters: {
      query: { type: 'string', required: true, description: '搜什么，比如「vibecoding」「Malaysia 电商」' },
      site: { type: 'string', required: false, description: `在哪搜：${SITE_IDS.join(' / ')}，默认 bilibili` },
      sort: { type: 'string', required: false, description: 'new 按最新（默认，适合追资讯）/ hot 按播放（适合找经典）' },
      limit: { type: 'number', required: false, description: '最多拿几条，默认 10，上限 20' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'browse.read', async (args) => {
      const expired = checkExpiry();
      const query = String(args.query || '').trim();
      if (!query) return { ok: false, error: '要给个搜索词' };
      const site = String(args.site || 'bilibili').toLowerCase();
      if (!SITES[site]) return { ok: false, error: `不认识的平台「${site}」`, tryThis: `可选：${SITE_IDS.join(' / ')}` };
      const limit = Math.min(Math.max(1, Number(args.limit) || 10), 20);

      const r = await browser.ready();
      if (!r.ok) return { ok: false, error: r.error, hint: r.hint };
      const cdp = browser.cdp();
      if (!cdp) return { ok: false, error: '浏览器连接断了' };

      const res = await searchSite(cdp, site, query, { sort: String(args.sort || 'new') });
      if (!res.ok) return res;
      browser.setSite(site);

      const items = (res.entries || []).slice(0, limit);
      const lines = [`在 ${siteName(site)} 搜「${query}」，拿到 ${items.length} 条：`];
      items.forEach((x, i) => {
        const meta = [x.author && `UP主 ${x.author}`, x.views && `${Math.round(x.views / 1000) / 10}万播放`, x.duration, x.tag].filter(Boolean).join('｜');
        lines.push(`${i + 1}. ${x.title}${meta ? `\n   ${meta}` : ''}${x.href ? `\n   ${x.href}` : ''}`);
      });
      if (!items.length) lines.push('（一条都没读到。可能没登录、或页面还没加载完，重试一次通常就好了）');
      lines.push('', '看完挑几条值得的，可以用 companion_keep_video 记下来——这样下次聊天能主动提起。');

      const body = lines.join('\n');
      const b = bill('按主题收集', [textTokens(body)], body + (expired ? `\n\n⚠ ${expired}` : ''));
      return { ok: true, site, query, items, ...b };
    }, { cost: () => 1 }),
  });

  reg({
    name: 'companion_keep_video',
    description: '把一条视频记进长期记忆（标题/作者/链接/为什么值得看）。记下来之后，聊天时她就能主动提起「你之前想看的那个」。',
    parameters: {
      title: { type: 'string', required: true, description: '视频标题' },
      url: { type: 'string', required: false, description: '链接' },
      author: { type: 'string', required: false, description: 'UP主/作者' },
      why: { type: 'string', required: false, description: '为什么值得看，一句话。这句是以后回想时的钩子' },
      topic: { type: 'string', required: false, description: '归到哪个主题，方便以后按主题找' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: async (args) => {
      const title = String(args.title || '').trim();
      if (!title) return { ok: false, error: '至少要给标题' };
      const facts = [];
      if (args.author) facts.push(`作者：${args.author}`);
      if (args.why) facts.push(`值得看：${args.why}`);
      if (args.url) facts.push(`链接：${args.url}`);
      if (args.topic) facts.push(`主题：${args.topic}`);

      try {
        const r = mem.append({
          title: `刷到：${title.slice(0, 40)}`,
          facts,
          section: args.topic ? `视频收藏·${args.topic}` : '视频收藏',
          index: `刷到《${title.slice(0, 22)}》${args.why ? `，${String(args.why).slice(0, 12)}` : ''}`,
        });
        const body = `记下了（${r.id}）：${title}${args.why ? `\n为什么值得看：${args.why}` : ''}${args.url ? `\n${args.url}` : ''}`;
        const b = bill('收藏视频', [textTokens(body)], body + `\n\n以后聊到这个话题，她会主动提一句。`);
        return { ok: true, id: r.id, ...b };
      } catch (e) {
        return { ok: false, error: `写记忆失败：${e.message}` };
      }
    },
  });

  reg({
    name: 'companion_browse_auto',
    description: '按设定好的时段和时长，让她自己刷一段。action=start 开始（受时段/单次时长/每天总量/间隔四道闸约束）、stop 结束、status 看她现在能不能刷。',
    parameters: {
      action: { type: 'string', required: true, description: 'start / stop / status' },
      site: { type: 'string', required: false, description: `刷哪个，默认用策略里的第一个（${SITE_IDS.join('/')}）` },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'browse.auto', async (args) => {
      const action = String(args.action || 'status').toLowerCase();

      if (action === 'status') {
        const c = browse.canStart();
        const body = browse.describe();
        const b = bill('刷视频状态', [textTokens(body)], body
          + (c.ok ? `\n\n现在可以刷：${c.reason}` : `\n\n现在不能刷：${c.reason}${c.nextAt ? `\n下次可刷：${new Date(c.nextAt).toLocaleString('zh-CN')}` : ''}`));
        return { ok: true, canStart: c.ok, ...b };
      }

      if (action === 'stop') {
        const s = browse.stop();
        const body = `停了。这次 ${s.minutes} 分钟，今天累计 ${s.dayUsed}/${s.dayLimit} 分钟。`;
        const b = bill('停止刷视频', [textTokens(body)], body);
        return { ok: true, ...b };
      }

      if (action !== 'start') return { ok: false, error: `不认识的 action「${action}」，只支持 start / stop / status` };

      const site = String(args.site || (browse.policy.sites || [])[0] || 'bilibili').toLowerCase();
      if (!SITES[site]) return { ok: false, error: `不认识的平台「${site}」` };
      if (browse.policy.sites && !browse.policy.sites.includes(site)) {
        return { ok: false, error: `策略里没允许刷 ${siteName(site)}`, tryThis: `允许的是：${(browse.policy.sites || []).join('、')}` };
      }

      const c = browse.canStart();
      if (!c.ok) {
        return {
          ok: false, error: c.reason,
          nextAt: c.nextAt || null,
          tryThis: '要改时段或时长，用 companion_browse_settings',
        };
      }

      const r = await browser.ready();
      if (!r.ok) return { ok: false, error: r.error, hint: r.hint };
      const cdp = browser.cdp();
      const page = await goto(cdp, SITES[site].stream || SITES[site].home);
      browser.setSite(site);
      const started = browse.start(site, { pageId: r.page?.id });
      if (!started.ok) return { ok: false, error: started.reason };

      const body = `开始刷 ${siteName(site)}，${c.minutes} 分钟后自己停。\n${describePage(page)}`;
      const b = bill('自己刷视频', [textTokens(body)], body + `\n\n（本时段还剩 ${c.windowLeft} 分钟，今天还剩 ${c.dayLeft} 分钟）`);
      return { ok: true, site, minutes: c.minutes, until: c.until, ...b };
    }, { cost: (a) => (String(a.action).toLowerCase() === 'start' ? Math.min(browse.policy.perSessionMinutes || 15, 120) : 1) }),
  });

  reg({
    name: 'companion_comment',
    description: '在她正看的这条内容下评论。默认 dryRun：把字打进输入框并逐字核对，停在这一步等你点头；确认后才真发。会在发送前校验按钮上写的是「发送/发布」。',
    parameters: {
      text: { type: 'string', required: true, description: '评论内容。会被长度上限和话题黑名单挡' },
      dryRun: { type: 'boolean', required: false, description: '默认 true，只准备不发送。设 false 才真发出去' },
      site: { type: 'string', required: false, description: `默认用当前页所在平台（支持：${SUPPORTED_COMMENT_SITES.join('/')}）` },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: async (args) => {
      const site = String(args.site || browser.site() || '').toLowerCase();
      if (!SUPPORTED_COMMENT_SITES.includes(site)) {
        return { ok: false, error: `这个平台还没做评论适配（${site || '未知'}）`, tryThis: `目前只支持：${SUPPORTED_COMMENT_SITES.join('、')}` };
      }

      // 1) 内容检查（不需要权限，纯本地判断）
      const v = browse.checkCommentText(args.text);
      if (!v.ok) return { ok: false, error: v.reason, tryThis: v.tryThis, yourText: args.text };

      const dryRun = args.dryRun !== false;
      if (dryRun) {
        // 只起草：连浏览器都不用开，0 风险
        const chk = browse.canComment();
        const body = `草稿：「${args.text}」（${String(args.text).length} 字）`;
        const b = bill('起草评论', [textTokens(body)], body
          + (chk.ok ? `\n\n今天还剩 ${chk.leftToday} 条。要真发就把 dryRun 设成 false——发之前我会把字打进输入框核对一遍，再把「准备点哪个按钮」报给你。`
            : `\n\n⚠ 现在不能发：${chk.reason}`));
        return { ok: true, drafted: true, text: args.text, dryRun: true, canPost: chk.ok, ...b };
      }

      // 2) 真发：走权限闸门 + 配额
      const quota = browse.canComment();
      if (!quota.ok) return { ok: false, error: quota.reason, tryThis: '要发得先 companion_browse_settings 打开评论或放宽配额' };

      const gateRes = await guarded(pm, 'comment.post', async () => ({ ok: true }))({}, ctx);
      if (gateRes && gateRes.ok === false) return { ok: false, error: gateRes.error, reason: gateRes.reason };

      const cdp = browser.cdp();
      if (!cdp) return { ok: false, error: '还没有开着的页面，先 companion_open_site 打开那个视频' };

      const r = await postComment(cdp, args.text, {
        site, dryRun: false,
        readComments: () => readComments(cdp, site),
      });

      if (r.ok) {
        const n = browse.recordComment();
        const body = `已发出：「${args.text}」（今天第 ${n} 条）`;
        const b = bill('发评论', [textTokens(body)], body);
        return { ok: true, sent: r.sent, inputCleared: r.inputCleared, appeared: r.appearedInComments, ...b };
      }

      const detail = [
        r.error,
        r.expected ? `要发的：${r.expected}` : '',
        r.actual ? `框里的：${r.actual}` : '',
        r.button ? `按钮：「${r.button.text}」` : '',
        r.tryThis || '',
      ].filter(Boolean).join('\n');
      return { ok: false, step: r.step, error: detail, dryHint: '没发出去，也没留在输入框里造成误发' };
    },
  });

  reg({
    name: 'companion_app_scroll',
    description: '在抖音/快手客户端里往下刷（只发滚轮，绝不点击）。客户端读不到内容，所以只滚不读；想让她看懂内容得用网页版。滚之前会确认前台真的是那个 App。',
    parameters: {
      times: { type: 'number', required: false, description: '滚几次，默认 1，上限 10' },
      dir: { type: 'string', required: false, description: 'next 往下一条（默认）/ prev 往上一条' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'browse.app', async (args) => {
      const dir = String(args.dir || 'next').toLowerCase();
      const dy = dir === 'prev' ? 120 : -120;
      const times = Math.min(Math.max(1, Number(args.times) || 1), 10);

      // 先看前台是什么，不是视频 App 就拒绝 —— 绝不盲滚
      const { fg } = await viewing();
      if (!fg) {
        return { ok: false, error: '拿不到前台窗口（非 Windows 或权限不足）', tryThis: '把抖音客户端切到最前面再试' };
      }

      const r = await appScroll({ dy, times, foreground: fg });
      if (!r.ok) return { ok: false, error: r.error, tryThis: r.tryThis };

      const body = `在 ${r.app} 里滚了 ${times} 次（${dir === 'prev' ? '往上' : '往下'}）。这一侧我看不到画面，内容是你在看。`
        + '\n想让我真的看懂这条在讲什么，用网页版：companion_open_site → 或者截图 companion_see_screen。';
      const b = bill('App 里刷', [textTokens(body)], body);
      return { ok: true, app: r.app, times, dir, ...b };
    }, { cost: (a) => Math.min(Math.max(1, Number(a.times) || 1), 10) }),
  });

  reg({
    name: 'companion_browse_settings',
    description: '改「她自己刷」的设置：什么时候能刷、每次刷多久、每天多久、允许刷哪些站、评论开不开和每天几条。改完立刻生效。',
    parameters: {
      enabled: { type: 'boolean', required: false, description: '自己刷视频的总开关' },
      sites: { type: 'string', required: false, description: `允许的平台，逗号分隔，如 "bilibili,douyin"` },
      windows: { type: 'string', required: false, description: `允许时段，逗号分隔，如 "12:30-13:30,21:30-23:30"。跨午夜用 "22:00-01:30"` },
      perSessionMinutes: { type: 'number', required: false, description: '单次最长几分钟' },
      perDayMinutes: { type: 'number', required: false, description: '每天总共几分钟' },
      minGapMinutes: { type: 'number', required: false, description: '两次之间至少隔几分钟' },
      commentEnabled: { type: 'boolean', required: false, description: '评论总开关（单独一项）' },
      commentPerDay: { type: 'number', required: false, description: '每天最多几条评论' },
      commentPerSession: { type: 'number', required: false, description: '每次最多几条评论' },
      commentRequireApproval: { type: 'boolean', required: false, description: '发送前是否必须你点头，默认 true' },
      commentMaxChars: { type: 'number', required: false, description: '评论字数上限' },
      commentAvoid: { type: 'string', required: false, description: '不评论的话题，逗号分隔' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: async (args) => {
      const p = browse.policy;
      const changed = [];
      const num = (k, min, max) => {
        const v = Number(args[k]);
        if (!Number.isFinite(v)) return;
        p[k] = Math.min(Math.max(min, Math.round(v)), max);
        changed.push(`${k}=${p[k]}`);
      };

      if (typeof args.enabled === 'boolean') { p.enabled = args.enabled; changed.push(`总开关=${p.enabled ? '开' : '关'}`); }
      if (args.sites) {
        const list = String(args.sites).split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const bad = list.filter((s) => !SITES[s]);
        if (bad.length) return { ok: false, error: `不认识的平台：${bad.join('、')}`, tryThis: `可选：${SITE_IDS.join('、')}` };
        p.sites = list;
        changed.push(`允许站点=${list.join('、') || '无'}`);
      }
      if (args.windows !== undefined) {
        const raw = String(args.windows).split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
        // 校验格式，写错时段等于让她永远不刷
        const bad = raw.filter((s) => !parseWindow(s));
        if (bad.length) return { ok: false, error: `时段格式不对：${bad.join('、')}`, tryThis: '要写成 "12:30-13:30"，跨午夜写 "22:00-01:30"' };
        p.windows = raw;
        changed.push(`允许时段=${raw.join('、') || '无'}`);
      }
      if (args.perSessionMinutes !== undefined) num('perSessionMinutes', 1, 180);
      if (args.perDayMinutes !== undefined) num('perDayMinutes', 1, 600);
      if (args.minGapMinutes !== undefined) num('minGapMinutes', 0, 1440);

      const c = p.comment = p.comment || {};
      if (typeof args.commentEnabled === 'boolean') { c.enabled = args.commentEnabled; changed.push(`评论=${c.enabled ? '开' : '关'}`); }
      if (args.commentPerDay !== undefined) { c.maxPerDay = Math.min(Math.max(0, Math.round(Number(args.commentPerDay))), 50); changed.push(`每天评论=${c.maxPerDay}`); }
      if (args.commentPerSession !== undefined) { c.maxPerSession = Math.min(Math.max(0, Math.round(Number(args.commentPerSession))), 20); changed.push(`每次评论=${c.maxPerSession}`); }
      if (typeof args.commentRequireApproval === 'boolean') { c.requireApproval = args.commentRequireApproval; changed.push(`发前确认=${c.requireApproval ? '要' : '不要'}`); }
      if (args.commentMaxChars !== undefined) { c.maxChars = Math.min(Math.max(5, Math.round(Number(args.commentMaxChars))), 200); changed.push(`字数上限=${c.maxChars}`); }
      if (args.commentAvoid !== undefined) {
        c.avoid = String(args.commentAvoid).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        changed.push(`不碰话题=${c.avoid.join('、') || '无'}`);
      }

      if (!changed.length) {
        const body = browse.describe();
        const b = bill('看刷视频设置', [textTokens(body)], body);
        return { ok: true, changed: [], ...b };
      }

      browse.savePolicy();
      const body = `改好了（${changed.join('，')}）：\n${browse.describe()}`;
      const b = bill('改刷视频设置', [textTokens(body)], body);
      return { ok: true, changed, ...b };
    },
  });

  reg({
    name: 'companion_see_camera',
    description: '开一次摄像头拍一张照片（拍完就关）。会报告 token 消耗。',
    parameters: { device: { type: 'string', required: false, description: '设备名，先用 companion_list_cameras 查' } },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'camera.snapshot', async (args) => {
      const r = await grabCamera({ device: args.device });
      if (!r.ok) return { ok: false, error: r.error, detail: r.detail, hint: r.hint };
      const buf = fs.readFileSync(r.file);
      const it = imageTokens(buf);
      const b64 = buf.toString('base64');
      cleanup([r.file]);
      const b = bill('开摄像头', [it.tokens], `拍到一张 ${it.w}×${it.h}。看完就关，别说「我正在看着你」这种话。`);
      return { ok: true, image: b64, mime: 'image/jpeg', width: it.w, height: it.h, ...b };
    }),
  });

  reg({
    name: 'companion_list_cameras',
    description: '列出可用摄像头。只枚举设备，不拍照，不花 token。',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || '') },
    execute: async () => {
      const r = await listCameras();
      const p = await probe();
      const t = textTokens(r.cameras.join('、'));
      ledger.add('枚举设备', t);
      return {
        ok: true, cameras: r.cameras, ffmpeg: p.ok ? '正常' : '不可用',
        note: r.cameras.length
          ? `可用摄像头：${r.cameras.join('、')}（约 ${t} token）`
          : '没找到摄像头（Windows 上还要在隐私设置里允许桌面应用访问摄像头）',
      };
    },
  });

  // ---------------------------------------------------------------- 记

  reg({
    name: 'companion_remember',
    description: '把这次聊出的结论落进记忆库。原文只追加、永不改写。落盘本身几乎不花 token。',
    parameters: {
      title: { type: 'string', required: true, description: '一句话标题' },
      facts: { type: 'string', required: false, description: '事实，多条用换行分隔' },
      quote: { type: 'string', required: false, description: '用户原话（最容易被摘要吃掉的东西）' },
      veto: { type: 'string', required: false, description: '当时否决了什么、为什么' },
      belief: { type: 'string', required: false, description: '认知修订，格式「原以为 X，现知道 Y」' },
      section: { type: 'string', required: false, description: '归类主题' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error) },
    execute: guarded(pm, 'files.write', async (args) => {
      const split = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const r = mem.append({
        title: args.title,
        facts: split(args.facts), quotes: split(args.quote),
        vetoes: split(args.veto), beliefs: split(args.belief),
        section: args.section || '待归类',
      });
      const t = textTokens(JSON.stringify(args));
      ledger.add('写记忆', t);
      return { ok: true, id: r.id, file: r.file, note: `已记下 ${r.id}：${args.title}（约 ${t} token）` };
    }),
  });

  reg({
    name: 'companion_recall',
    description: '按关键词回忆。返回命中的原始条目，不是摘要。会报告 token 消耗。',
    parameters: {
      keywords: { type: 'string', required: true, description: '关键词，空格分隔' },
      limit: { type: 'number', required: false },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || '') },
    execute: guarded(pm, 'files.read', async (args) => {
      const kws = String(args.keywords || '').split(/\s+/).filter(Boolean);
      const hits = mem.search(kws, { limit: args.limit || 3 });
      const body = hits.length
        ? hits.map((h) => `${h.id} · ${h.title}\n  ${h.body.slice(0, 3).join('\n  ')}`).join('\n')
        : '记忆里没有对得上这件事的。别硬编。';
      const b = bill('回忆', [textTokens(body)], body);
      return { ok: true, hits, ...b };
    }),
  });

  reg({
    name: 'companion_valuable',
    description: '取最值钱的两类记忆：被否决的判断、认知修订。给建议和换模型交接时用。',
    parameters: { kind: { type: 'string', required: false, description: 'veto 或 belief，默认 veto' } },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || '') },
    execute: guarded(pm, 'files.read', async (args) => {
      const kind = args.kind === 'belief' ? '认知' : '否决';
      const rows = mem.valuable(kind, { limit: 3 });
      const body = rows.length ? rows.map((r) => `${r.id} · ${r.text}`).join('\n') : `记忆里还没有${kind}记录。`;
      const b = bill('取关键记忆', [textTokens(body)], body);
      return { ok: true, rows, ...b };
    }),
  });

  // ---------------------------------------------------------------- 说

  reg({
    name: 'companion_draft_message',
    description: '起草一条消息给用户看，不发送。任何时候都安全，不花额外 token。',
    parameters: {
      to: { type: 'string', required: false },
      text: { type: 'string', required: true },
      subject: { type: 'string', required: false },
      channel: { type: 'string', required: false, description: CHANNELS.join(' / ') },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.preview || v.error) },
    execute: guarded(pm, 'message.draft', async (args) => {
      const d = draft(args);
      ledger.add('起草消息', textTokens(d.text), {});
      return d;
    }),
  });

  reg({
    name: 'companion_send_message',
    description: '真正把消息发出去。会先请用户确认。默认走剪贴板或本机客户端，不直接外发。',
    parameters: {
      to: { type: 'string', required: false },
      text: { type: 'string', required: true },
      subject: { type: 'string', required: false },
      channel: { type: 'string', required: false, description: 'clipboard（默认）/ urlscheme / webhook' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.done || v.error || '') },
    execute: guarded(pm, 'message.send', async (args) => {
      const r = await send({ ...args, webhook: config.webhook || process.env.DSH_COMPANION_WEBHOOK });
      ledger.add('发消息', textTokens(args.text), { channel: r.channel });
      return r;
    }),
  });

  // ---------------------------------------------------------------- 账

  reg({
    name: 'companion_character',
    description: '看当前形象、列出所有可用形象（action=list）、或者换一个（action=use，立刻生效不用重启）。',
    parameters: {
      action: { type: 'string', required: false, description: 'show（默认）/ list / use' },
      pack: { type: 'string', required: false, description: 'action=use 时给包名（如 bigfish-adult）或包目录的绝对路径' },
      reset: { type: 'boolean', required: false, description: 'action=use 时置 true 表示回到配置里的默认形象' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note) },
    execute: async (args = {}) => {
      const action = String(args.action || 'show').toLowerCase();

      /* ---- 列出 ---- */
      if (action === 'list') {
        const packs = listPacks();
        if (!packs.length) {
          return {
            ok: true, packs: [],
            note: '没有可用的角色包。把 dsh-pet 包放进 ' + path.join(home, 'packs') + ' 或插件的 packs/ 即可。\n'
              + '现在用内置鲸鱼（手写 SVG，随插件分发，不涉及第三方美术）。',
          };
        }
        const w = (s) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
        const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
        const rows = packs.map((p) => `  ${pad(p.label, 22)}${pad(p.name, 20)}`
          + `${pad(p.kind === 'theme' ? '10 个状态' : `${p.actions} 个动作`, 11)}`
          + `${pad(p.kind === 'theme' ? '—' : `${p.mb} MB`, 8)}`
          + `${p.writable ? '你自己的' : '自带'}${p.current ? '  ← 当前' : ''}`);
        return {
          ok: true, packs,
          note: `可用形象 ${packs.length} 个：\n${rows.join('\n')}\n\n`
            + '换一个：companion_character action=use pack=<包名>\n'
            + `放自己的包：放进 ${path.join(home, 'packs')}，下次 list 就能看到。`,
        };
      }

      /* ---- 换 ---- */
      if (action === 'use') {
        if (args.reset) {
          rememberPack(null);
          character = loadCharacter(null);
          emitCharacter();
          return {
            ok: true, reset: true,
            note: character
              ? `已回到默认形象「${character.name || '未命名'}」。`
              : '已回到内置鲸鱼（配置里没指定角色包）。',
          };
        }

        const want = String(args.pack || '').trim();
        if (!want) return { ok: false, error: '要给 pack：包名或包目录的绝对路径' };

        // 先按包名找，找不到再当路径试
        const packs = listPacks();
        const byName = packs.find((p) => p.name === want || p.label === want || p.dir === want);
        let target = byName ? byName.dir : null;
        if (!target) {
          const abs = path.isAbsolute(want) ? want : path.resolve(PLUGIN_ROOT, want);
          if (fs.existsSync(abs)) target = abs;
        }
        if (!target) {
          return {
            ok: false,
            error: `没有这个形象「${want}」`,
            hint: `可用的：${packs.map((p) => p.name).join(' / ') || '（一个都没有）'}`,
          };
        }

        const next = loadCharacter(target);
        if (!next) {
          return { ok: false, error: `这个包加载不了：${target}`, hint: 'pet.json / pack.json 或素材文件可能损坏' };
        }
        character = next;
        // 配色皮肤存 'theme-xxx'，加载时能被 themeKey 认出来；角色包存绝对路径
        rememberPack(target);
        emitCharacter();
        const what = next.mode === 'atlas'
          ? `${next.name || path.basename(target)}（${(next.pet.animations || []).length} 个动作）`
          : next.mode === 'svg'
            ? `${next.name || '配色皮肤'}（内置鲸鱼换色，10 个状态）`
            : `${next.name || path.basename(target)}（${Object.keys(next.states || {}).length} 个状态图）`;
        return {
          ok: true, name: next.name || '', mode: next.mode, dir: target,
          note: `已换成「${what}」，立刻生效，下次启动也还是这个。\n回到默认：action=use reset=true`,
        };
      }

      /* ---- 看 ---- */
      if (!character) {
        return {
          ok: true,
          source: '内置鲸鱼（SVG）',
          states: Object.keys(STATES_HINT),
          note: '当前用内置鲸鱼（手写 SVG，随插件分发，不涉及第三方美术）。\n'
            + '看看有什么可选：action=list；换一个：action=use pack=<包名>。',
        };
      }
      if (character.mode === 'svg') {
        const meta = SVG_THEMES[character.theme] || SVG_THEMES.default;
        return {
          ok: true,
          source: '内置鲸鱼（配色皮肤）',
          name: meta.label,
          theme: character.theme,
          states: Object.keys(STATES_HINT),
          note: `形象：内置鲸鱼 · ${meta.label}\n`
            + `${meta.hint}\n`
            + `10 个状态（${Object.keys(STATES_HINT).join(' / ')}），零体积，随插件走。\n`
            + `想换：action=list 看全部可选；action=use pack=theme-gpt`,
        };
      }
      if (character.mode === 'atlas') {
        const anims = character.pet.animations || [];
        const byTag = {};
        for (const a of anims) {
          for (const t of a.tags || []) (byTag[t] = byTag[t] || []).push(a.label || a.id);
        }
        const tagLine = Object.entries(byTag)
          .map(([t, ls]) => `  ${t}：${ls.length} 段`).join('\n');
        return {
          ok: true,
          source: 'dsh-pet 角色包',
          name: character.name || '',
          actions: anims.length,
          atlas: Object.keys(character.pet.assets).length,
          canvas: character.pet.canvas,
          states: Object.keys(STATES_HINT),
          note: `形象：${character.name || '未命名'}（dsh-pet v1）\n`
            + `${anims.length} 个动作 · ${Object.keys(character.pet.assets).length} 张图集 · `
            + `画布 ${character.pet.canvas.width}×${character.pet.canvas.height}\n`
            + `标签分布：\n${tagLine}`,
        };
      }
      return {
        ok: true,
        source: '简单图包',
        name: character.name || '',
        states: Object.keys(character.states || {}),
        note: `形象来自简单图包「${character.name || '未命名'}」，${Object.keys(character.states || {}).length} 个状态图：`
          + `${Object.keys(character.states || {}).join(' / ')}`,
      };
    },
  });

  /* ---------------------------------------------------------------- 外部模型 */

  /**
   * 有的事必须自己会想。
   *
   * 之前「判断他在干什么」是靠关键词表，「写评论草稿」是拼模板——效果一眼假。
   * 接上模型之后这两件事才像回事。代价是要花钱，所以：
   *   · 单独一项权限（model.ask），跟「联网」分开——这一项真的会产生账单
   *   · 每小时封顶 60 次，循环调用在这里被挡住
   *   · 用多少 token 由上游回报，据实记账，不用估算糊弄
   */
  reg({
    name: 'companion_model',
    description: '用外部模型想一件事（OpenAI / Claude / 千问 / DeepSeek 任选）。'
      + 'action=status 看哪些配好了（不花钱）；action=ask 真问（会产生费用，按上游回报的实际用量记账）。',
    parameters: {
      action: { type: 'string', required: false, description: 'ask（默认）/ status' },
      input: { type: 'string', required: false, description: '要问的话。action=ask 时必填' },
      provider: { type: 'string', required: false, description: `openai / anthropic / qwen / deepseek，不填自动挑一个配好的` },
      model: { type: 'string', required: false, description: '不填用该家默认（如 gpt-4o-mini / claude-3-5-haiku-latest / qwen-plus）' },
      system: { type: 'string', required: false, description: '系统提示：定语气、定角色、定输出格式' },
      maxTokens: { type: 'number', required: false, description: '默认 1024。只是判读/写一句话的话 200 就够' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'model.ask', async (args = {}) => {
      const action = String(args.action || 'ask').toLowerCase();

      /* 看配置 —— 不花钱，但仍在同一项权限下，因为它能暴露你配了哪些账号 */
      if (action === 'status') {
        const rows = modelsReady(home);
        const w = (s) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
        const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
        const lines = rows.map((r) => `  ${r.hasKey ? '✓' : '·'} ${pad(r.label, 18)}${pad(r.model, 26)}`
          + `${r.hasKey ? pad(mask(apiKey(r.id, home)), 14) + r.keyFrom : '没配密钥'}`);
        const any = rows.some((r) => r.hasKey);
        return {
          ok: true, providers: rows,
          note: `外部模型：\n${lines.join('\n')}\n\n`
            + (any
              ? `不指定 provider 时会用「${PROVIDERS[pickProvider(home, config.modelProvider)].label}」`
                + `（顺序：千问 → DeepSeek → OpenAI → Claude，先挑配好的）。`
              : '一个都没配。配一个就能用了：\n'
                + '  companion_model_key provider=qwen key=sk-xxxx\n'
                + '  或者设环境变量 DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY'),
        };
      }

      /* 真问 */
      const text = String(args.input || '').trim();
      if (!text) return { ok: false, error: '要给 input：想让它想什么' };

      const provider = args.provider || pickProvider(home, config.modelProvider);
      if (!provider) {
        return {
          ok: false,
          error: '一个模型都没配',
          hint: 'companion_model_key provider=qwen key=<你的key>，或设 DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY',
        };
      }

      const budget = Math.min(Math.max(64, Number(args.maxTokens) || 1024), 8192);
      const r = await askModel({
        provider,
        model: args.model,
        system: args.system,
        input: text,
        home,
        maxTokens: budget,
      });

      if (!r.ok) {
        return { ok: false, error: r.error, hint: r.hint, provider, detail: r.detail };
      }

      // 据实记账：token 数用上游回报的，不用估算
      const total = r.usage?.total || roughTokens(text) + roughTokens(r.text);
      const res = bill('model', [total],
        `${PROVIDERS[provider].label}（${r.model}）答：\n${r.text}`);
      return {
        ok: true,
        text: r.text,
        provider,
        model: r.model,
        ms: r.ms,
        usage: r.usage,
        note: `${res.note}`,
      };
    }, { cost: 1 }),
  });

  /**
   * 配密钥。
   *
   * 单独一个工具、单独一项权限：这个动作改的是本机的凭据文件，性质是「写文件」，
   * 不是「问模型」。混在一起会导致「想看一眼配置就得先有花钱的权限」。
   */
  reg({
    name: 'companion_model_key',
    description: '配 / 清外部模型的密钥。存到 ~/.dsh-companion/keys.json（权限 600），不写进代码、不进日志、不回显全文。',
    parameters: {
      provider: { type: 'string', required: true, description: 'openai / anthropic / qwen / deepseek' },
      key: { type: 'string', required: false, description: '密钥。action=set 时必填' },
      action: { type: 'string', required: false, description: 'set（默认）/ clear / check' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error || '') },
    execute: guarded(pm, 'files.write', async (args = {}) => {
      const provider = String(args.provider || '').trim();
      const action = String(args.action || 'set').toLowerCase();
      if (!PROVIDERS[provider]) {
        return { ok: false, error: `不认识的 provider「${provider}」`, hint: `可用的：${PROVIDER_IDS.join(' / ')}` };
      }
      const label = PROVIDERS[provider].label;

      if (action === 'check') {
        const k = apiKey(provider, home);
        return {
          ok: true, hasKey: !!k,
          note: k ? `${label} 已配：${mask(k)}（来源：见 companion_model action=status）`
            : `${label} 没配。companion_model_key provider=${provider} key=<你的key>`,
        };
      }

      if (action === 'clear') {
        saveKey(provider, '', home);
        return { ok: true, cleared: true, note: `已清掉 ${label} 的密钥。` };
      }

      const key = String(args.key || '').trim();
      if (!key) return { ok: false, error: '要给 key' };
      // 明显的粘贴错误先挡住，别等 401 才发现多了个换行
      if (!/^[\x21-\x7e]{12,}$/.test(key)) {
        return { ok: false, error: '这个 key 看起来不对（有空格/换行/非 ASCII 字符），检查一下再给' };
      }
      const f = saveKey(provider, key, home);
      host.log(`[companion] 已保存 ${label} 的密钥（${mask(key)}）`);
      return {
        ok: true, provider, masked: mask(key), file: f,
        note: `${label} 的密钥已存到 ${f}（只有你自己能读）。\n`
          + `用一次试试：companion_model input="用一句话说你现在能做什么" provider=${provider}`,
      };
    }, { cost: 1 }),
  });

  reg({
    name: 'companion_cost',
    description: '查看 token 消耗：本次会话、今日累计、按类型明细。',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note) },
    execute: async () => ({ ok: true, session: ledger.session, day: ledger.day, note: ledger.summary() }),
  });

  // ---------------------------------------------------------------- 权限

  reg({
    name: 'companion_permission',
    description: '查看或调整权限。注意：只能自己收权，放权要用户当场点确认。',
    parameters: {
      action: { type: 'string', required: true, description: 'list / set' },
      capability: { type: 'string', required: false },
      level: { type: 'string', required: false, description: 'deny / ask / session / always' },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note || v.error) },
    execute: async (args, c) => {
      if (args.action === 'list' || !args.capability) {
        const rows = pm.describe();
        return {
          ok: true, rows,
          note: rows.map((r) => `${padW(r.level, 9)}${padW(r.label, 13)}${padW(r.cap, 19)}${r.quota !== '—' ? r.quota : ''}`.trimEnd()).join('\n'),
        };
      }
      if (args.action !== 'set') return { ok: false, error: '只支持 list / set' };
      if (!CAPABILITIES[args.capability]) return { ok: false, error: '没有这个能力：' + args.capability };

      const before = pm.level(args.capability);
      const after = args.level;
      const rank = { deny: 0, ask: 1, session: 2, always: 3 };

      // 关键规矩：收紧可以自己做，放宽必须用户点确认。
      // 否则一条提示词注入就能让助手给自己开摄像头。
      if ((rank[after] ?? 9) > (rank[before] ?? 0)) {
        const ask = c?.approval?.request;
        if (typeof ask !== 'function') {
          return { ok: false, error: '放宽权限需要用户确认，当前环境无法弹审批，已拒绝' };
        }
        const meta = CAPABILITIES[args.capability];
        const v = await ask({
          title: meta.risk >= 3 ? '⚠️ 陪伴助手请求放宽高风险权限' : '陪伴助手请求放宽权限',
          detail: `${meta.label}：${before} → ${after}`
            + (meta.risk >= 3 ? `\n风险提示：${meta.note}` : ''),
          input: { capability: args.capability, from: before, to: after },
        });
        if (v !== 'allowed-once' && v?.kind !== 'allowed-once' && v !== true) {
          return { ok: false, error: '用户没有同意放宽' };
        }
      }
      const now = pm.setLevel(args.capability, after);
      return { ok: true, note: `${CAPABILITIES[args.capability].label}：${before} → ${now}（已记录审计）` };
    },
  });

  reg({
    name: 'companion_brief',
    description: '取本次会话该注入的记忆与人格提示。会话没自动注入时用它兜底。会报告注入的 token 数。',
    parameters: {},
    output: { schema: { type: 'object' }, render: (_a, v) => text(v.note) },
    execute: async () => {
      const s = sessionSection({ memory: mem, profile: profileKey, gate });
      const st = ledger.add('开场注入', s.tokens, {});
      return { ok: true, text: s.text, tokens: s.tokens, note: `${s.text}\n\n（开场注入 ${st.line}）` };
    },
  });

  // ---------------------------------------------------------------- 钩子

  // 会话开始注入人格与记忆。不同 DSH 版本的钩子名可能不同，
  // 所以每个都试一遍、失败就静默降级到 companion_brief。
  for (const hook of ['agent/session-start', 'agent/pre-step', 'session/start']) {
    try {
      host.on(hook, async (...a) => {
        const s = sessionSection({ memory: mem, profile: profileKey, gate });
        ledger.add('开场注入', s.tokens, { hook });
        const emit = a.find((x) => typeof x?.inject === 'function');
        if (emit) await emit.inject(s.text);
        return { inject: s.text, tokens: s.tokens };
      });
    } catch { /* 这个版本没这个钩子 */ }
  }

  emitUsage();
  emitCharacter();
  host.log(
    `[companion] 已加载｜人格 ${PROFILES[profileKey].name}｜记忆 ${memoryDir}`
    + `｜权限 ${pm.file}｜今日已用 ${ledger.day.tokens} token`
    + `（¥${((ledger.day.tokens / 1e6) * PRICE).toFixed(4)} / 🍚 ${Math.floor(ledger.day.tokens / PER_BOWL)} 碗）`,
  );

  /**
   * 把内部句柄交出去。原来的 apply 什么都不返回，对 DSH 没问题；
   * 但 MCP 适配器和测试都需要能摸到账本、记忆、权限——不然只能靠猜。
   */
  return { pm, mem, gate, ledger, browse, browser, character, host, home, memoryDir };
}

/** 按显示宽度补空格：汉字占两格，padEnd 按字符数算会错位 */
function padW(s, w) {
  const t = String(s || '');
  let d = 0;
  for (const ch of t) d += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return t + ' '.repeat(Math.max(0, w - d));
}

function parseRegion(s) {
  if (!s) return null;
  const n = String(s).split(',').map((x) => parseInt(x, 10));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}
