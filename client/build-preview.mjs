/**
 * build-preview.mjs —— 生成单文件预览页
 *
 * 不能直接 fetch('./client.cjs')：file:// 下会被 CORS 拦掉，页面一片空白。
 * 所以把源码和角色包图集都内联进来——双击就能开，不依赖本地服务器。
 *
 * 跑法：node client/build-preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(here, 'client.cjs'), 'utf8');
const out = path.join(here, 'preview.html');

/** 把角色包读成客户端吃的 art 对象，图和宿主端一样转 data URI */
function loadPack(dir) {
  const petFile = path.join(dir, 'pet.json');
  if (!fs.existsSync(petFile)) return null;
  const pet = JSON.parse(fs.readFileSync(petFile, 'utf8'));
  const animations = JSON.parse(fs.readFileSync(path.join(dir, pet.animations || 'animations.json'), 'utf8'));
  const assets = {};
  for (const [k, v] of Object.entries(pet.assets || {})) {
    const f = path.join(dir, v.path);
    assets[k] = {
      src: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'),
      width: v.width,
      height: v.height,
    };
  }
  let dialogue = null;
  const dlg = path.join(dir, pet.dialogue || 'dialogue.json');
  if (fs.existsSync(dlg)) dialogue = JSON.parse(fs.readFileSync(dlg, 'utf8'));
  return {
    mode: 'atlas',
    name: pet.name,
    pet: { canvas: pet.canvas, assets, animations, fallbacks: pet.fallbacks || {}, dialogue },
  };
}

const arg = process.argv[2] || 'packs/bigfish-classic';
// theme-xxx 是内置鲸鱼的配色皮肤，不走文件；其余按目录读
const art = String(arg).startsWith('theme-')
  ? { mode: 'svg', theme: String(arg).slice(6) }
  : loadPack(path.resolve(arg || path.join(root, 'packs/bigfish-classic')));
if (!art) {
  console.error('没有可用的角色包：' + packDir);
  process.exit(1);
}

const NAMES = {
  idle: '空闲', greet: '打招呼', think: '思考', type: '写作', tool: '动手',
  wait: '等你确认', done: '完成', error: '出错', sleep: '睡着', happy: '开心',
};

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>陪伴助手 · 形象预览</title>
<style>
  :root { --bg:#F5F8FE; --card:#fff; --ink:#132038; --muted:#6B7A93; --line:#E2E9F4; --acc:#2A5CD6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0E1521; --card:#161F2E; --ink:#E8EFFA; --muted:#93A3BC; --line:#233047; --acc:#7FB2FF; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:22px 26px 34px; background:var(--bg); color:var(--ink);
         font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { font-size:18px; margin:0 0 2px; }
  .sub { color:var(--muted); margin:0 0 16px; font-size:12.5px; }
  .wrap { display:flex; gap:18px; align-items:flex-start; flex-wrap:wrap; }
  .stage-wrap { flex:0 0 320px; }
  .stage { width:320px; height:320px; border-radius:16px; border:1px solid var(--line);
           padding-top:44px;
           background:
             repeating-conic-gradient(from 0deg at 50% 50%, rgba(120,150,200,.06) 0 25%, transparent 0 50%) 0 0/18px 18px,
             var(--card);
           display:flex; align-items:flex-end; justify-content:center; padding-bottom:10px; }
  .panel { flex:1 1 420px; min-width:340px; }
  .row { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
  button, select { font:12.5px system-ui; padding:5px 10px; border-radius:8px; cursor:pointer;
           border:1px solid var(--line); background:var(--card); color:var(--ink); }
  button:hover { border-color:var(--acc); }
  button.on { border-color:var(--acc); color:var(--acc); font-weight:600; }
  .now { font:12.5px ui-monospace,Menlo,monospace; color:var(--muted); margin:2px 0 12px; min-height:20px; }
  .now b { color:var(--ink); }
  .acts { max-height:210px; overflow:auto; border:1px solid var(--line); border-radius:10px;
          background:var(--card); padding:6px; display:flex; flex-wrap:wrap; gap:5px; }
  .acts button { font-size:12px; padding:3px 8px; }
  .hint { margin-top:14px; padding:12px 14px; background:var(--card); border:1px solid var(--line);
          border-radius:12px; font-size:12.5px; color:var(--muted); }
  .hint b { color:var(--ink); }
  .kbd { font:11.5px ui-monospace,Menlo,monospace; background:rgba(120,150,200,.14); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
  <h1>陪伴助手 · 形象预览</h1>
  <p class="sub">${art.mode === 'atlas'
    ? `角色包：<b>${art.name}</b> · ${art.pet.animations.length} 个动作 · 画布 ${art.pet.canvas.width}×${art.pet.canvas.height}`
    : `配色皮肤：<b>${art.name || (art.theme || 'default')}</b> · 内置鲸鱼换色 · 10 个状态 · 零体积`}</p>

  <div class="wrap">
    <div class="stage-wrap">
      <div class="stage" id="stage"></div>
      <div class="now">当前动作：<b id="now">—</b></div>
      <div class="row" id="states"></div>
      <div class="row">
        <button id="hud">切换 HUD 常驻</button>
        <button id="burn">模拟花掉 1 万 token</button>
        <button id="say">让它说一句</button>
      </div>
    </div>

    <div class="panel">
      <div class="row"><b style="font-size:12.5px;color:var(--muted)">全部动作（点一个就播）</b></div>
      <div class="acts" id="acts"></div>
      <div class="hint">
        <b>头上的 HUD：</b>今日 token、折合的钱、多少碗白饭。
        <b>双击角色</b>切「常驻显示 / 只悬停显示」，并让她把今天吃了多少说出来。
        价格与白饭换算在插件配置里（<span class="kbd">pricePerMTokens</span>、<span class="kbd">tokensPerBowl</span>）。
      </div>
      <div class="hint">
        <b>动作来源：</b>直接吃社区的 <span class="kbd">dsh-pet</span> v1 角色包格式，
        所以大肥鱼、成年版、以及任何人做的 <span class="kbd">.dshpet</span> 都能换进来用，不用改代码。
        角色美术版权归原作者，个人使用，分发前请自行确认授权。
      </div>
    </div>
  </div>

<script id="companion-client" type="text/plain">
${src}
</script>
<script>
(function () {
  var mod = { exports: {} };
  var code = document.getElementById('companion-client').textContent;
  new Function('module', 'exports', 'require', 'window', 'document', code)(
    mod, mod.exports, function () { return {}; }, window, document
  );
  var api = mod.exports;
  var ART = ${JSON.stringify(art)};
  var NAMES = ${JSON.stringify(NAMES)};
  var nowEl = document.getElementById('now');

  // inline 模式：位置由外层容器说了算，不用 fixed 去抢屏幕
  // 尺寸按画布比例算，横的画布给宽度，竖的画布给高度——不然成年版会顶出框
  // 配色皮肤没有 pet 字段（它不读图集），给个默认画布，尺寸按内置鲸鱼的比例
  var CV = (ART.pet && ART.pet.canvas) || { width: 132, height: 128 };
  var SIZE = Math.round(Math.min(260, 268 * CV.width / CV.height));
  var live = api.mount(document.getElementById('stage'), {
    inline: true, size: SIZE, tokens: 3420, hud: 'always', pricePerMTokens: 2, art: ART
  });

  function markNow() {
    var a = live.anim;
    nowEl.textContent = a ? (a.label + '  ·  ' + a.id) : (ART.mode === 'svg' ? '配色皮肤（' + (ART.theme || 'default') + '）' : '—');
  }
  setInterval(markNow, 400);
  markNow();

  var states = document.getElementById('states');
  Object.keys(api.STATES).forEach(function (key) {
    var b = document.createElement('button');
    b.textContent = NAMES[key] || key;
    b.onclick = function () {
      Array.prototype.forEach.call(states.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      live.setState(key, NAMES[key]);
      setTimeout(markNow, 30);
    };
    states.appendChild(b);
  });

  var acts = document.getElementById('acts');
  ART.pet.animations.forEach(function (a) {
    var b = document.createElement('button');
    b.textContent = a.label;
    b.title = a.id + ' · tags: ' + (a.tags || []).join(',');
    b.onclick = function () { live.playAnim(a.id); setTimeout(markNow, 30); };
    acts.appendChild(b);
  });

  document.getElementById('hud').onclick = function () {
    var on = live.root.classList.toggle('wc-hud-on');
    live.setPinned(on);
    live.setState('happy', live.riceLine());
  };
  document.getElementById('burn').onclick = function () {
    live.setUsage({ tokens: (live.usage.tokens || 0) + 10000 });
    live.setState('done', live.riceLine());
  };
  document.getElementById('say').onclick = function () {
    var d = (ART.pet.dialogue || {}).idle || ['在呢，慢慢来。'];
    var line = d[Math.floor(Math.random() * d.length)].replace(/\\{[^}]+\\}/g, '手头这件事');
    live.setState('greet', line);
  };

  window.__companion = { api: api, live: live, art: ART };

  // 方便截图/排障：preview.html#tool 直接切状态，preview.html#anim:bigfish:xxx 直接播某段
  var h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h.indexOf('anim:') === 0) {
    live.playAnim(h.slice(5));
  } else if (h && api.STATES[h]) {
    live.setState(h);
  }
  setTimeout(markNow, 60);
})();
</script>
</body>
</html>
`;

fs.writeFileSync(out, html, 'utf8');
console.log('已生成 %s（%d MB，源码与图集已内联）', out, +(html.length / 1048576).toFixed(1));
