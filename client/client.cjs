/**
 * client.cjs —— DSH 客户端半边（浏览器端桌宠）
 *
 * 为什么是 .cjs：DSH 的 client 半边按 CJS 模块表加载，而 package.json 是 ESM。
 * 用 .cjs 后缀两边都不打架。
 *
 * 三个刻意的决定：
 *   1. **自带原创形象，不打包别人的美术。** 社区那些桌宠的代码是 MIT，但角色美术
 *      是单独授权的。所以这里画一只自己的鲸鱼（纯 SVG，无外部图片），
 *      想要现成形象的人通过角色包导入——个人使用合法，分发插件时不含侵权素材。
 *   2. **动画用 CSS 不用图片帧。** 一张 SVG + 十来个 keyframes，
 *      体积从几 MB 降到几 KB，而且跟主题走（深色/浅色不用做两套）。
 *   3. **不动就淡出。** 陪伴助手最容易变成屏幕上的噪音，所以闲置久了会主动安静。
 */

'use strict';

// ------------------------------------------------------------------ 原创形象

/** 一只蓝色小鲸鱼。全部手写路径，没抄任何现有角色。 */
let UID = 0;

/**
 * 配色皮肤。
 *
 * 为什么不直接放三家的官方形象：那是商标，不是美术素材。
 * 大肥鱼那种社区角色可以个人使用，但冒充 OpenAI / Anthropic / 阿里的官方形象
 * 是另一回事——对方是有法务的商业主体。
 *
 * 所以这里的做法是：把「气质」借过来（配色、点缀），但不复制任何官方 logo。
 * 你自己有素材就放进 ~/.dsh-companion/packs/，那些包优先级更高，会盖掉这些。
 */
const PALETTES = {
  default: {
    label: '深海蓝',
    body0: '#5C9BFF', body1: '#2A5CD6', belly0: '#DCEBFF', belly1: '#A8C8F5',
    fin: '#4A8AF0', glow: '#7FB2FF', spout: '#9FC7FF',
    line: '#1B3B6F', zzz: '#8FB4E8', accent: '#2A5CD6',
  },
  // OpenAI 那种青绿，冷静、偏工程
  gpt: {
    label: '青绿',
    body0: '#4ED6B4', body1: '#0E8F72', belly0: '#D8FFF4', belly1: '#9BE8D6',
    fin: '#2FBFA0', glow: '#5FE3C4', spout: '#A8F0DD',
    line: '#0B4A3C', zzz: '#8FE5CE', accent: '#0E8F72',
  },
  // Anthropic 那种陶土橙，暖、偏人文
  claude: {
    label: '陶土橙',
    body0: '#E8A184', body1: '#C25E3A', belly0: '#FFEDE4', belly1: '#F3C6B2',
    fin: '#D98162', glow: '#F0A98C', spout: '#FFD2BE',
    line: '#6B2F1B', zzz: '#F0B99F', accent: '#C25E3A',
  },
  // 通义那种紫蓝，偏科技感
  qwen: {
    label: '星紫',
    body0: '#9B94FF', body1: '#5B4BD6', belly0: '#EEEBFF', belly1: '#C4BCFA',
    fin: '#7A6EEF', glow: '#A99CFF', spout: '#D2C9FF',
    line: '#2E2360', zzz: '#C3BAF5', accent: '#5B4BD6',
  },
};

const THEME_IDS = Object.keys(PALETTES);

function whaleSVG(id = 'wc', theme = 'default') {
  const p = PALETTES[theme] || PALETTES.default;
  return `
<svg viewBox="0 0 132 128" xmlns="http://www.w3.org/2000/svg" class="wc-svg">
  <defs>
    <linearGradient id="${id}-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.body0}"/>
      <stop offset="100%" stop-color="${p.body1}"/>
    </linearGradient>
    <linearGradient id="${id}-belly" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.belly0}"/>
      <stop offset="100%" stop-color="${p.belly1}"/>
    </linearGradient>
    <radialGradient id="${id}-glow" cx="50%" cy="60%" r="55%">
      <stop offset="0%" stop-color="${p.glow}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <ellipse class="wc-shadow" cx="62" cy="112" rx="30" ry="6" fill="#000" opacity="0.14"/>
  <circle cx="62" cy="70" r="46" fill="url(#${id}-glow)" class="wc-glow"/>

  <g class="wc-root">
    <!-- 尾巴：绕根部摆动 -->
    <g class="wc-tail">
      <path d="M92 66 C104 55 114 48 120 44 C115 56 115 64 120 74 C110 71 100 72 92 74 Z"
            fill="url(#${id}-body)"/>
    </g>

    <!-- 身体 -->
    <ellipse class="wc-body" cx="62" cy="70" rx="38" ry="28" fill="url(#${id}-body)"/>
    <ellipse class="wc-belly" cx="60" cy="80" rx="27" ry="15" fill="url(#${id}-belly)"/>

    <!-- 侧鳍 -->
    <path class="wc-fin" d="M56 84 C50 94 44 99 38 100 C44 92 46 86 47 80 Z"
          fill="${p.fin}" opacity="0.95"/>

    <!-- 头顶喷水：思考时才冒 -->
    <g class="wc-spout">
      <circle cx="60" cy="34" r="3.4" fill="${p.spout}" opacity="0.9"/>
      <circle cx="52" cy="28" r="2.4" fill="${p.spout}" opacity="0.75"/>
      <circle cx="68" cy="26" r="2" fill="${p.spout}" opacity="0.6"/>
    </g>

    <!-- 眼睛 -->
    <g class="wc-eye">
      <ellipse class="wc-eye-white" cx="46" cy="62" rx="8.5" ry="9.5" fill="#fff"/>
      <circle class="wc-pupil" cx="47" cy="63" r="4.6" fill="#10203A"/>
      <circle class="wc-glint" cx="48.8" cy="60.8" r="1.7" fill="#fff"/>
      <path class="wc-lid" d="M37 62 Q46 56 55 62 L55 52 L37 52 Z" fill="${p.fin}" opacity="0"/>
    </g>

    <!-- 嘴：说话时张合 -->
    <path class="wc-mouth" d="M34 74 Q40 79 46 74" fill="none"
          stroke="${p.line}" stroke-width="2.4" stroke-linecap="round" opacity="0.75"/>

    <!-- 腮红 -->
    <ellipse class="wc-blush" cx="34" cy="72" rx="6" ry="3.4" fill="#FF9BB6" opacity="0"/>
  </g>

  <g class="wc-zzz" opacity="0">
    <text x="92" y="40" font-size="15" fill="${p.zzz}" font-family="system-ui">z</text>
    <text x="102" y="28" font-size="19" fill="${p.zzz}" font-family="system-ui">z</text>
  </g>
  <g class="wc-mark" opacity="0">
    <circle cx="100" cy="30" r="8" fill="${p.body1}"/>
    <text x="96.5" y="34.5" font-size="11" fill="#fff" font-family="system-ui">!</text>
  </g>
</svg>`;
}

/**
 * 形象渲染。三种模式：
 *   svg   —— 内置那只鲸鱼，兜底用，一定在。
 *   image —— 简单角色包。art.base 一张底图，art.states 可以给某些状态换图。
 *   atlas —— dsh-pet v1 角色包（社区通用格式，大肥鱼就是这个）。
 *            一张图集里切格子，按 frames[].durationMs 逐帧播。
 *
 * 为什么直接吃 dsh-pet 而不是自造格式：社区的 .dshpet 已经把「素材 + 帧序 +
 * 每帧时长 + 台词」定义清楚了，跟它对齐就等于免费继承所有人做好的角色。
 */

/** 图集模式的外壳。真正的帧由 paintFrame() 一格一格换。 */
function atlasMarkup(art) {
  const cv = (art.pet && art.pet.canvas) || { width: 222, height: 222 };
  return '<div class="wc-stage" style="width:' + cv.width + 'px;height:' + cv.height + 'px">'
    + '<div class="wc-frame"></div></div>';
}

function artMarkup(art, id) {
  if (art && art.mode === 'atlas' && art.pet) return atlasMarkup(art);
  if (art && art.mode === 'image' && art.base) {
    return '<img class="wc-img" alt="" draggable="false" src="' + String(art.base) + '">';
  }
  return whaleSVG(id, (art && art.theme) || 'default');
}

/**
 * 状态 → 角色包里的动作标签。
 * 标签是 dsh-pet 的通用词汇，不是我们自己编的，所以别人的包也能对上。
 */
const STATE_TAGS = {
  idle: ['idle'],
  greet: ['greeting'],
  think: ['thinking'],
  type: ['writing', 'working'],
  tool: ['tool', 'working'],
  wait: ['wait', 'attention'],
  done: ['success'],
  error: ['error'],
  sleep: ['idle'],
  happy: ['success', 'greeting'],
};

// ------------------------------------------------------------------ 状态

/**
 * 状态 → CSS 类。名字对齐 Agent 的真实生命周期，
 * 不是「随便晃两下」，而是让用户一眼知道助手在干什么。
 */
const STATES = {
  idle: { label: '在呢', anim: 'wc-idle' },
  greet: { label: '打个招呼', anim: 'wc-idle' },
  think: { label: '想着呢', anim: 'wc-think' },
  type: { label: '在写', anim: 'wc-type' },
  tool: { label: '在动手', anim: 'wc-tool' },
  wait: { label: '等你确认', anim: 'wc-wait' },
  done: { label: '好了', anim: 'wc-done' },
  error: { label: '出了点问题', anim: 'wc-error' },
  sleep: { label: '睡一会儿', anim: 'wc-sleep' },
  happy: { label: '开心', anim: 'wc-happy' },
};

const CSS = `
.wc-svg{width:100%;height:100%;overflow:visible;display:block}
.wc-root{transform-origin:62px 100px}
.wc-tail{transform-origin:92px 70px;animation:wc-wag 2.6s ease-in-out infinite}
.wc-body{transform-origin:62px 98px;animation:wc-breathe 3.4s ease-in-out infinite}
.wc-fin{transform-origin:52px 82px;animation:wc-fin 3.4s ease-in-out infinite}
.wc-eye{transform-origin:46px 62px}
.wc-pupil{transition:transform .18s ease}
.wc-spout{opacity:0;transition:opacity .25s ease}
.wc-blush{transition:opacity .3s ease}

@keyframes wc-wag{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(7deg)}}
@keyframes wc-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.03,0.97)}}
@keyframes wc-fin{0%,100%{transform:rotate(0)}50%{transform:rotate(-9deg)}}
@keyframes wc-blink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(0.08)}}
.wc-eye{animation:wc-blink 5.2s infinite}

/* 思考：喷水 + 尾巴慢下来 + 眼睛往上看 */
.wc-think .wc-spout{opacity:1;animation:wc-rise 1.4s ease-out infinite}
.wc-think .wc-tail{animation-duration:4.2s}
.wc-think .wc-pupil{transform:translate(0,-2.2px)}
@keyframes wc-rise{0%{transform:translateY(6px);opacity:0}35%{opacity:1}100%{transform:translateY(-8px);opacity:0}}

/* 写：嘴快速开合 */
.wc-type .wc-mouth{animation:wc-talk .32s steps(2,end) infinite}
.wc-type .wc-spout{opacity:.5}
@keyframes wc-talk{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.45)}}
.wc-mouth{transform-origin:40px 74px}

/* 动手：整体轻震，像在搬东西 */
.wc-tool .wc-root{animation:wc-bump .5s ease-in-out infinite}
.wc-tool .wc-fin{animation-duration:.7s}
@keyframes wc-bump{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-2.5px) rotate(-2deg)}}

/* 等确认：歪头 + 身子不动，像在看着你 */
.wc-wait .wc-root{transform:rotate(-5deg);transition:transform .3s}
.wc-wait .wc-body,.wc-wait .wc-tail,.wc-wait .wc-fin{animation-play-state:paused}
.wc-wait .wc-lid{opacity:.0}

/* 好了：蹦一下 + 腮红 */
.wc-done .wc-root{animation:wc-jump .62s cubic-bezier(.3,-0.2,.4,1.4) 2}
.wc-done .wc-blush{opacity:.75}
@keyframes wc-jump{0%,100%{transform:translateY(0)}45%{transform:translateY(-11px)}}

/* 出错：左右摇头 + 感叹号 */
.wc-error .wc-root{animation:wc-shake .42s ease-in-out 3}
.wc-error .wc-mark{opacity:1}
@keyframes wc-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}

/* 睡：闭眼 + zzz */
.wc-sleep .wc-eye{animation:none}
.wc-sleep .wc-lid{opacity:1}
.wc-sleep .wc-tail{animation-duration:6.5s}
.wc-sleep .wc-body{animation-duration:5s}
.wc-sleep .wc-zzz{opacity:.9;animation:wc-zzz 2.6s ease-in-out infinite}
@keyframes wc-zzz{0%,100%{transform:translateY(0);opacity:.35}50%{transform:translateY(-6px);opacity:.9}}

/* 开心：快速摆动 + 腮红 */
.wc-happy .wc-tail{animation-duration:.9s}
.wc-happy .wc-blush{opacity:.85}

/* 系统级「减少动态」：全部停掉，只留静态 */
@media (prefers-reduced-motion: reduce){
  .wc-tail,.wc-body,.wc-fin,.wc-eye,.wc-root,.wc-zzz,.wc-spout,.wc-mouth{animation:none !important}
}
`;

// ------------------------------------------------------------------ 角色包

/**
 * 角色包格式（自定，不抄别人）：
 *   pack.json { name, author, license, art: { base: 'base.png', states: { think: 'think.png' } } }
 * 支持 image 模式：给每状态一张图；缺的自动回退到 base。
 * 纯本地读取，不上传。
 */
const PACK_SCHEMA = {
  name: 'string',
  author: 'string',
  license: 'string',
  art: 'object',
};

function validatePack(p) {
  if (!p || typeof p !== 'object') return { ok: false, error: '不是合法 JSON' };
  // dsh-pet v1：社区通用格式（大肥鱼就是这个），字段多，只校验骨架
  if (p.format === 'dsh-pet') {
    if (!p.canvas || !p.assets) return { ok: false, error: 'dsh-pet 包缺少 canvas / assets' };
    return { ok: true, warning: p.license ? null : '这个包没写 license，分发前请确认授权' };
  }
  for (const [k, t] of Object.entries(PACK_SCHEMA)) {
    if (p[k] !== undefined && typeof p[k] !== t) {
      return { ok: false, error: `字段 ${k} 应该是 ${t}` };
    }
  }
  if (!p.art || typeof p.art !== 'object') return { ok: false, error: '缺少 art' };
  return { ok: true, warning: p.license ? null : '这个包没写 license，分发前请确认授权' };
}

// ------------------------------------------------------------------ 挂载

/**
 * @param {HTMLElement} host 挂载点
 * @param {{onEvent?:Function, position?:string, size?:number}} opts
 */
function mount(host, opts) {
  const o = opts || {};
  const doc = host.ownerDocument || document;
  const root = doc.createElement('div');
  root.className = 'wc-pet wc-idle';

  const style = doc.createElement('style');
  style.textContent = CSS + `
.wc-pet{${o.inline
    ? 'position:relative;inset:auto;'
    : `position:fixed;${o.position === 'left' ? 'left:24px;right:auto;' : 'right:24px;left:auto;'}bottom:24px;top:auto;`}
  width:${o.size || 132}px;height:${o.size || 132}px;z-index:2147483000;
  cursor:grab;user-select:none;touch-action:none;
  filter:drop-shadow(0 8px 18px rgba(30,60,120,.18));
  transition:opacity .5s ease,transform .2s ease}
.wc-pet.wc-dim{opacity:.42}
.wc-pet:active{cursor:grabbing}
.wc-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
  margin-bottom:6px;padding:5px 9px;border-radius:10px;font:12px/1.4 system-ui;
  background:rgba(28,38,58,.92);color:#EAF2FF;white-space:nowrap;pointer-events:none;
  opacity:0;transition:opacity .2s ease;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.wc-pet:hover .wc-bubble,.wc-pet.wc-say .wc-bubble{opacity:1}
.wc-img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;
  user-select:none;-webkit-user-drag:none;animation:wc-bob 3.2s ease-in-out infinite;
  transform-origin:50% 92%}
/* 图集模式：外层按画布像素尺寸摆，再整体缩到控件大小。缩的是容器，不是每帧，省得每帧都算。 */
.wc-stage{position:absolute;left:0;bottom:0;transform-origin:0 100%;
  image-rendering:auto;pointer-events:none}
.wc-frame{position:absolute;background-repeat:no-repeat;will-change:background-position}
.wc-pet.wc-idle .wc-stage{animation:wc-bob 3.6s ease-in-out infinite}
.wc-pet.wc-think .wc-stage{animation:wc-bob 5s ease-in-out infinite}
.wc-pet.wc-tool .wc-stage{animation:wc-bump .5s ease-in-out infinite}
.wc-pet.wc-done .wc-stage{animation:wc-jump .62s cubic-bezier(.3,-0.2,.4,1.4) 2}
.wc-pet.wc-error .wc-stage{animation:wc-shake .42s ease-in-out 3}
.wc-pet.wc-wait .wc-stage{animation:none;filter:brightness(1.04)}
.wc-pet.wc-sleep .wc-stage{animation:wc-bob 6s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.wc-stage{animation:none !important}}
@keyframes wc-bob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.015,0.985)}}
.wc-think .wc-img{animation:wc-bob 4.6s ease-in-out infinite}
.wc-type .wc-img{animation:wc-bob .9s ease-in-out infinite}
.wc-tool .wc-img{animation:wc-bump .5s ease-in-out infinite}
.wc-wait .wc-img{animation:none;transform:rotate(-4deg)}
.wc-done .wc-img{animation:wc-jump .62s cubic-bezier(.3,-0.2,.4,1.4) 2}
.wc-error .wc-img{animation:wc-shake .42s ease-in-out 3}
.wc-sleep .wc-img{animation:wc-bob 6s ease-in-out infinite;opacity:.82}
.wc-happy .wc-img{animation:wc-bob .8s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.wc-img{animation:none !important}}
.wc-hud{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:26px;
  padding:4px 10px;border-radius:999px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,system-ui;
  background:rgba(22,32,50,.86);color:#DCE9FF;white-space:nowrap;pointer-events:none;
  opacity:0;transition:opacity .25s ease;letter-spacing:.2px;
  box-shadow:0 2px 10px rgba(20,40,80,.18);backdrop-filter:blur(6px)}
.wc-hud .wc-unit{opacity:.6;margin-left:2px}
.wc-hud .wc-sep{opacity:.35;margin:0 5px}
.wc-hud .wc-cost{color:#8FE3B0}
.wc-hud .wc-rice{color:#FFD98A}
.wc-pet:hover .wc-hud{opacity:1}
.wc-pet.wc-hud-on .wc-hud{opacity:1}
.wc-pet.wc-dim .wc-hud{opacity:0 !important}
@media (prefers-color-scheme: light){
  .wc-hud{background:rgba(255,255,255,.94);color:#22344F;border:1px solid rgba(180,200,230,.7)}
  .wc-hud .wc-cost{color:#178A4E}.wc-hud .wc-rice{color:#B8791B}
}
`;

  var uid = 'wc' + (++UID);
  let art = o.art || null;

  root.innerHTML = artMarkup(art, uid)
    + '<div class="wc-hud">'
    + '  <span class="wc-tok">0</span><span class="wc-unit">token</span>'
    + '  <span class="wc-sep">·</span><span class="wc-cost">¥0.000</span>'
    + '  <span class="wc-sep">·</span><span class="wc-rice">🍚 0 碗</span>'
    + '</div>'
    + '<div class="wc-bubble"></div>';
  host.appendChild(style);
  host.appendChild(root);

  const bubble = root.querySelector('.wc-bubble');
  const hudEl = {
    tok: root.querySelector('.wc-tok'),
    cost: root.querySelector('.wc-cost'),
    rice: root.querySelector('.wc-rice'),
  };

  // 价格按「元 / 百万 token」算。默认 2 元，够用；真实价目自己去配置里填。
  const PRICE = Number(o.pricePerMTokens ?? 2);
  // 一碗白饭 = 多少 token。纯玩梗，但把抽象数字变成看得懂的量。
  const PER_BOWL = Number(o.tokensPerBowl ?? 1000);

  let usage = { tokens: Number(o.tokens || 0) };
  let pinned = o.hud === 'always';

  function fmtTok(n) {
    const v = Math.round(n || 0);
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e4) return Math.round(v / 1e3) + 'k';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  function fmtMoney(tokens) {
    const c = (tokens / 1e6) * PRICE;
    if (c === 0) return '¥0';
    if (c < 0.01) return '¥' + c.toFixed(4);
    if (c < 1) return '¥' + c.toFixed(3);
    return '¥' + c.toFixed(2);
  }

  /** 白饭话术：吃得越多说得越欠。只是让人愿意看一眼数字。 */
  function riceLine() {
    const bowls = Math.floor((usage.tokens || 0) / PER_BOWL);
    const money = fmtMoney(usage.tokens || 0);
    if (!bowls) return `今天还没吃上饭（${fmtTok(usage.tokens)} token）`;
    if (bowls < 5) return `今天吃了 ${bowls} 碗白饭，很克制｜${money}`;
    if (bowls < 20) return `今天吃了 ${bowls} 碗白饭，有点撑｜${money}`;
    if (bowls < 60) return `今天吃了 ${bowls} 碗白饭，盆都见底了｜${money}`;
    return `今天吃了 ${bowls} 碗白饭…我是鲸鱼，能消化｜${money}`;
  }

  function setUsage(u) {
    if (!u) return;
    if (u.tokens != null) usage.tokens = Number(u.tokens) || 0;
    hudEl.tok.textContent = fmtTok(usage.tokens);
    hudEl.cost.textContent = fmtMoney(usage.tokens);
    hudEl.rice.textContent = '🍚 ' + Math.floor(usage.tokens / PER_BOWL) + ' 碗';
    root.title = riceLine();
  }

  function setPinned(on) {
    pinned = !!on;
    root.classList.toggle('wc-hud-on', pinned);
  }

  root.classList.toggle('wc-hud-on', pinned);
  setUsage(usage);

  // ---------------------------------------------------------------- 图集播放
  //
  // dsh-pet 包里一个动作就是一串帧，每帧带自己的毫秒数，还可能重复同一格
  // （眨眼就是「睁-闭-睁」，用同一张脸的三个格子）。所以不能用 CSS steps，
  // 只能按帧表自己走——顺带能做轮换和冷却，别让同一段动作反复抖。

  let stage = root.querySelector('.wc-stage');
  let frameEl = root.querySelector('.wc-frame');
  let playTimer = null;
  let playing = null;
  const usedAt = new Map();

  /** 画布像素 → 控件像素。缩容器，不缩每帧。 */
  function scaleStage() {
    if (!stage || !art || !art.pet) return;
    const cv = art.pet.canvas || { width: 132, height: 132 };
    const k = (o.size || 132) / cv.width;
    stage.style.transform = 'scale(' + k + ')';
    // 角色比画布窄的时候，控件高度按画布高的比例收敛，不然下面留一大块空白
    root.style.height = Math.round(cv.height * k) + 'px';
  }

  function paintFrame(fr) {
    if (!frameEl || !art || !art.pet) return;
    const a = art.pet.assets[fr.asset];
    if (!a || !a.src) return;
    const r = fr.rect;
    const cv = art.pet.canvas;
    frameEl.style.width = r[2] + 'px';
    frameEl.style.height = r[3] + 'px';
    // 每帧尺寸不一样，统一「水平居中、底边对齐」——脚不动，人就不会跳
    frameEl.style.left = Math.round((cv.width - r[2]) / 2) + 'px';
    frameEl.style.top = Math.max(0, cv.height - r[3]) + 'px';
    if (frameEl.__bg !== a.src) {
      frameEl.style.backgroundImage = 'url("' + a.src + '")';
      frameEl.style.backgroundSize = a.width + 'px ' + a.height + 'px';
      frameEl.__bg = a.src;
    }
    frameEl.style.backgroundPosition = (-r[0]) + 'px ' + (-r[1]) + 'px';
  }

  function stopPlaying() {
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
    playing = null;
  }

  function playAnim(id) {
    if (!art || art.mode !== 'atlas' || !art.pet) return null;
    const list = art.pet.animations || [];
    const anim = typeof id === 'string' ? list.find((a) => a.id === id) : id;
    if (!anim || !anim.frames || !anim.frames.length) return null;
    stopPlaying();
    playing = anim;
    usedAt.set(anim.id, Date.now());
    let i = 0;
    const step = () => {
      const fr = anim.frames[i];
      paintFrame(fr);
      i += 1;
      if (i >= anim.frames.length) {
        if (!anim.loop) { playing = null; return; }
        i = 0;
      }
      playTimer = setTimeout(step, Math.max(40, fr.durationMs || 200));
    };
    step();
    return anim;
  }

  /**
   * 状态 → 动作。两段式，别纯随机：
   *   1. 六成以上几率走角色包自己指定的 fallback——那是作者配的「这个状态该长什么样」；
   *   2. 剩下的从同标签里按「最久没播过」轮换，并尊重 cooldownMs。
   * 纯随机轮换的毛病是「思考」会随机播成「有点紧张」，看着像 AI 在焦虑。
   */
  function pickAnim(s) {
    const pet = art && art.pet;
    if (!pet || !pet.animations || !pet.animations.length) return null;

    const fbId = (pet.fallbacks || {})[s];
    const fbAnim = fbId ? pet.animations.find((a) => a.id === fbId) : null;
    if (fbAnim && Math.random() < 0.68) return fbAnim;

    const tags = STATE_TAGS[s] || ['idle'];
    let pool = [];
    for (const t of tags) {
      pool = pet.animations.filter((a) => (a.tags || []).indexOf(t) >= 0);
      if (pool.length) break;
    }
    if (!pool.length) return fbAnim || pet.animations.find((a) => (a.tags || []).indexOf('idle') >= 0) || null;

    const now = Date.now();
    const ready = pool.filter((a) => now - (usedAt.get(a.id) || 0) > (a.cooldownMs || 4000));
    const from = (ready.length ? ready : pool).slice()
      .sort((a, b) => (usedAt.get(a.id) || 0) - (usedAt.get(b.id) || 0));
    const pick = from.slice(0, Math.min(3, from.length));
    return pick[Math.floor(Math.random() * pick.length)];
  }

  let state = 'idle';
  let idleTimer = null;
  let lastInteract = Date.now();

  function setState(s, say) {
    if (!STATES[s]) s = 'idle';
    // 只换状态类，别的类（wc-hud-on / wc-dim / wc-say）必须留着
    for (var k in STATES) root.classList.remove(STATES[k].anim);
    root.classList.add(STATES[s].anim);
    // 简单角色包：给了这个状态的专属图就换图，没给就留着底图做动作
    var img = root.querySelector('.wc-img');
    if (img && art && art.mode === 'image') {
      var src = (art.states && art.states[s]) || art.base;
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    }
    // 图集角色包：换一段动画
    if (art && art.mode === 'atlas') {
      var anim = pickAnim(s);
      if (anim && (!playing || playing.id !== anim.id)) playAnim(anim);
    }
    state = s;
    if (say) {
      bubble.textContent = say;
      root.classList.add('wc-say');
      setTimeout(() => root.classList.remove('wc-say'), 2600);
    }
    // 从忙碌回到空闲就重新计时
    if (s === 'idle') armIdle();
  }

  /** 闲置 3 分钟自动安静，10 分钟睡着。陪伴助手不该一直晃。 */
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (Date.now() - lastInteract > 10 * 60_000) setState('sleep');
      else { root.classList.add('wc-dim'); setState('idle'); }
    }, 3 * 60_000);
  }
  armIdle();

  // 拖拽（松手吸附到左右边界，不会飘到屏幕中间挡东西）
  let dragging = false;
  let sx = 0, sy = 0, ox = 0, oy = 0;
  root.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastInteract = Date.now();
    root.setPointerCapture?.(e.pointerId);
    const r = root.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    root.style.right = 'auto';
    root.style.left = ox + 'px';
    root.style.bottom = 'auto';
    root.style.top = oy + 'px';
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    root.style.left = (ox + e.clientX - sx) + 'px';
    root.style.top = (oy + e.clientY - sy) + 'px';
  });
  root.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    lastInteract = Date.now();
    const r = root.getBoundingClientRect();
    const w = host.ownerDocument.documentElement.clientWidth;
    const mid = r.left + r.width / 2;
    const snapLeft = mid < w / 2;
    root.style.left = snapLeft ? '16px' : (w - r.width - 16) + 'px';
    root.style.top = Math.min(Math.max(8, r.top), window.innerHeight - r.height - 8) + 'px';
    root.style.transition = 'left .22s ease, top .22s ease';
    setTimeout(() => { root.style.transition = ''; }, 240);
  });

  // 点一下：唤醒 / 换句招呼
  let taps = 0, tapTimer = null;
  root.addEventListener('click', () => {
    lastInteract = Date.now();
    root.classList.remove('wc-dim');
    taps += 1;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 900);
    if (taps >= 3) { setState('happy', '别戳啦，痒'); taps = 0; return; }
    setState(state === 'sleep' ? 'idle' : 'happy', '在呢');
    armIdle();
  });

  // 双击：HUD 常驻开关 + 把今天吃了多少说出来
  root.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    taps = 0;
    clearTimeout(tapTimer);
    setPinned(!pinned);
    lastInteract = Date.now();
    setState('happy', riceLine());
  });

  // 宿主推来的事件：把 Agent 的真实状态翻译成动作
  function handle(ev) {
    if (!ev || !ev.kind) return;
    lastInteract = Date.now();
    root.classList.remove('wc-dim');
    switch (ev.kind) {
      case 'session-start': setState('greet', '我在这儿'); break;
      case 'thinking': setState('think'); break;
      case 'typing': setState('type'); break;
      case 'tool': setState('tool', ev.tool ? String(ev.tool).replace(/^companion_/, '') : '在动手'); break;
      case 'approval': setState('wait', '等你点确认'); break;
      case 'done': setState('done', ev.text || '好了'); break;
      case 'error': setState('error', ev.text || '出错了'); break;
      case 'usage': setUsage(ev); break;
      case 'character':
        // 宿主可以把尺寸一起推过来（配置里的 characterSize），换包时保持用户设定的大小
        if (ev.size && Number(ev.size) !== o.size) {
          o.size = Number(ev.size);
          root.style.width = o.size + 'px';
        }
        if (ev.art) { applyArt(ev.art); setState(state); }
        break;
      case 'token': setUsage(ev); setState(state, riceLine()); break;
      default: break;
    }
    if (o.onEvent) o.onEvent(ev);
  }

  /** 运行时换角色包（用户在设置里换了形象，不用重开会话） */
  function applyArt(next) {
    art = next || null;
    stopPlaying();
    var old = root.querySelector('.wc-svg, .wc-img, .wc-stage');
    if (old) old.remove();
    var tmp = root.ownerDocument.createElement('div');
    tmp.innerHTML = artMarkup(art, uid);
    var node = tmp.firstElementChild;
    if (node) root.insertBefore(node, root.firstChild);
    stage = root.querySelector('.wc-stage');
    frameEl = root.querySelector('.wc-frame');
    if (art) root.classList.add('wc-has-art');
    scaleStage();
    if (art && art.mode === 'atlas') {
      // 先垫一张静态帧：别让画面空着等第一个动作
      const fb = (art.pet.fallbacks || {}).idle;
      playAnim(fb || (art.pet.animations[0] || {}).id);
    }
  }

  // 开场：有角色包就先动起来
  if (art && art.mode === 'atlas') {
    scaleStage();
    const fb = (art.pet.fallbacks || {}).idle;
    playAnim(fb || (art.pet.animations[0] || {}).id);
  }

  return {
    root, setState, handle, setUsage, setPinned, riceLine,
    setArt: applyArt,
    playAnim, pickAnim,
    get anim() { return playing && { id: playing.id, label: playing.label }; },
    get artKind() { return art ? art.mode : 'svg'; },
    get usage() { return { ...usage, pinned }; },
    destroy: () => { stopPlaying(); root.remove(); },
    states: Object.keys(STATES),
  };
}

module.exports = { mount, whaleSVG, artMarkup, STATES, validatePack, CSS, PALETTES, THEME_IDS };
