/**
 * gallery.mjs —— 生成形象总览页（preview/gallery.html）
 *
 * 用途：把所有角色包的图集原图、每个动作的首帧、以及全部配色皮肤
 *      铺在一页里，方便肉眼验收「到底长什么样」。
 *
 * 数据全部从 packs/ 和 client/client.cjs 现读，不手抄色值，
 * 避免出现「文档里的颜色和实际渲染不一致」这种老问题。
 *
 *   node tools/gallery.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PALETTES, whaleSVG } = require(path.join(ROOT, 'client/client.cjs'));

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ 读角色包

function loadPack(dir) {
  const pet = readJSON(path.join(dir, 'pet.json'));
  const animPath = path.join(dir, pet.animations || 'animations.json');
  const anims = fs.existsSync(animPath) ? readJSON(animPath) : [];
  const assets = Object.entries(pet.assets || {}).map(([key, a]) => ({
    key,
    ...a,
    src: path.join(dir, a.path),
    // 页面上用 preview/assets/ 下的副本：这样 file:// 打开和本地静态服务（present 预览面板）
    // 都能拿到图，而 ../packs/ 在 http 服务下会被根目录挡掉。
    file: `assets/${pet.id}-${key}.png`,
    exists: fs.existsSync(path.join(dir, a.path)),
    anims: anims.filter((an) => (an.frames || []).some((f) => f.asset === key)).length,
  }));
  return { ...pet, dir, anims, assets };
}

const packsDir = path.join(ROOT, 'packs');
const packs = fs
  .readdirSync(packsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(packsDir, d.name, 'pet.json')))
  .map((d) => loadPack(path.join(packsDir, d.name)))
  .sort((a, b) => b.anims.length - a.anims.length);

// ------------------------------------------------------------------ 片段

/** 一个动作的首帧，用 sprite 坐标裁出来，等比缩进 boxW×boxH 的框里（留 4% 呼吸） */
function frameBox(pack, anim, boxW, boxH) {
  const f = (anim.frames || [])[0];
  if (!f) return `<div class="frame empty" style="width:${boxW}px;height:${boxH}px">无帧</div>`;
  const asset = pack.assets.find((a) => a.key === f.asset);
  if (!asset) return `<div class="frame empty" style="width:${boxW}px;height:${boxH}px">缺图集</div>`;
  const [x, y, w, h] = f.rect;
  const s = Math.min(boxW / w, boxH / h) * 0.94;
  const bw = asset.width * s;
  const bh = asset.height * s;
  const left = (boxW - w * s) / 2;
  const top = (boxH - h * s) / 2;
  return `<div class="frame" style="width:${boxW}px;height:${boxH}px;background-image:url('${
    asset.file
  }');background-size:${bw.toFixed(2)}px ${bh.toFixed(2)}px;background-position:${(left - x * s).toFixed(
    2
  )}px ${(top - y * s).toFixed(2)}px"></div>`;
}

function packSection(pack) {
  const atlasCards = pack.assets
    .map(
      (a) => `
      <figure class="atlas">
        <div class="atlas-img"><img src="${a.file}" data-full="${a.file}" alt="${esc(pack.name)} ${esc(
        a.key
      )}" loading="lazy"></div>
        <figcaption>
          <b>${esc(a.key)}</b>
          <span>${a.width}×${a.height} · ${a.anims} 个动作</span>
        </figcaption>
      </figure>`
    )
    .join('');

  const ratio = pack.canvas.height / pack.canvas.width;
  const boxW = ratio > 1.2 ? 84 : 104;
  const boxH = ratio > 1.2 ? Math.round(104 * Math.min(ratio, 1.55)) : 104;
  const animCards = pack.anims
    .map((an) => {
      const cover = an.frames?.length ? `${an.frames.length} 帧` : '';
      return `<div class="anim">
        ${frameBox(pack, an, boxW, boxH)}
        <div class="anim-meta">
          <b>${esc(an.label || an.id)}</b>
          <code>${esc(an.id)}</code>
          <span>${esc((an.tags || []).join(' · '))}${cover ? ' · ' + cover : ''}</span>
        </div>
      </div>`;
    })
    .join('');

  return `
  <section class="pack">
    <header class="pack-head">
      <div>
        <h2>${esc(pack.name)} <code class="pid">${esc(pack.id)}</code></h2>
        <p>${esc(pack.description || '')}</p>
      </div>
      <ul class="facts">
        <li><b>${pack.anims.length}</b><span>动作</span></li>
        <li><b>${pack.assets.length}</b><span>图集</span></li>
        <li><b>${pack.canvas.width}×${pack.canvas.height}</b><span>单帧画布</span></li>
        <li><b>v${esc(pack.version || '—')}</b><span>版本</span></li>
      </ul>
    </header>
    <h3 class="sub">图集原图 <small>点开看全尺寸</small></h3>
    <div class="atlas-row">${atlasCards}</div>
    <h3 class="sub">全部动作 <small>每格是该动作的第 1 帧</small></h3>
    <div class="anim-grid">${animCards}</div>
    <p class="lic">${esc(pack.license || '')}</p>
  </section>`;
}

function themesSection() {
  const ids = Object.keys(PALETTES);
  const cards = ids
    .map((id) => {
      const p = PALETTES[id];
      const swatches = ['body0', 'body1', 'belly0', 'fin', 'glow', 'accent']
        .map((k) => `<i style="background:${p[k]}" title="${k} ${p[k]}"></i>`)
        .join('');
      return `<div class="theme" data-theme="${id}">
        <div class="theme-art">${whaleSVG('g-' + id, id)}</div>
        <div class="theme-meta">
          <b>${esc(p.label)}</b>
          <code>theme-${id}</code>
          <div class="swatches">${swatches}</div>
        </div>
      </div>`;
    })
    .join('');

  const rows = ids
    .map(
      (id) => `<tr><td><code>theme-${id}</code></td><td>${esc(PALETTES[id].label)}</td>
      <td><code>${PALETTES[id].body0}</code></td><td><code>${PALETTES[id].body1}</code></td>
      <td><code>${PALETTES[id].fin}</code></td><td><code>${PALETTES[id].accent}</code></td></tr>`
    )
    .join('');

  return `
  <section class="pack">
    <header class="pack-head">
      <div>
        <h2>配色皮肤 <code class="pid">零素材</code></h2>
        <p>同一个 SVG 换色，不占体积、跟深浅色走。借的是气质，不是三家的官方 logo——那是商标。</p>
      </div>
      <ul class="facts"><li><b>${ids.length}</b><span>套</span></li><li><b>0 KB</b><span>图片体积</span></li></ul>
    </header>
    <div class="theme-grid">${cards}</div>
    <h3 class="sub">色值</h3>
    <table class="tbl"><thead><tr><th>包 id</th><th>气质</th><th>body0</th><th>body1</th><th>fin</th><th>accent</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

// ------------------------------------------------------------------ HTML

const totalAnims = packs.reduce((n, p) => n + p.anims.length, 0);

const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-companion · 形象总览</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --ink:#16191d; --dim:#6b7280;
    --chk1:#eef0f3; --chk2:#fff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:36px 22px 80px}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.3px}
  .lede{color:var(--dim);margin:0 0 8px}
  .toc{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 30px}
  .toc a{font-size:12.5px;padding:5px 11px;border:1px solid var(--line);border-radius:99px;
    background:var(--card);color:#374151;text-decoration:none}
  .toc a:hover{border-color:#b9c0ca;color:#111}
  code{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#4b5563;
    background:#f1f3f5;padding:1px 5px;border-radius:4px}
  .pack{background:var(--card);border:1px solid var(--line);border-radius:16px;
    padding:22px 24px 26px;margin:0 0 22px;scroll-margin-top:16px}
  .pack-head{display:flex;gap:24px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
  .pack-head h2{font-size:19px;margin:0 0 4px}
  .pid{font-size:12px;vertical-align:middle}
  .pack-head p{margin:0;color:var(--dim);max-width:620px;font-size:13px}
  .facts{display:flex;gap:22px;list-style:none;margin:0;padding:0}
  .facts li{text-align:right}
  .facts b{display:block;font-size:16px}
  .facts span{font-size:11.5px;color:var(--dim)}
  .sub{font-size:13px;margin:26px 0 10px;color:#374151;
    border-top:1px solid var(--line);padding-top:16px}
  .sub small{font-weight:400;color:#9aa1ab;margin-left:6px}
  .atlas-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
  .atlas{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fbfcfd}
  .atlas-img{display:flex;align-items:center;justify-content:center;padding:10px;min-height:130px;
    background-image:linear-gradient(45deg,var(--chk1) 25%,transparent 25%),
      linear-gradient(-45deg,var(--chk1) 25%,transparent 25%),
      linear-gradient(45deg,transparent 75%,var(--chk1) 75%),
      linear-gradient(-45deg,transparent 75%,var(--chk1) 75%);
    background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}
  .atlas-img img{max-width:100%;max-height:260px;display:block;image-rendering:auto}
  .atlas figcaption{display:flex;justify-content:space-between;gap:8px;align-items:baseline;
    padding:8px 11px;border-top:1px solid var(--line);background:#fff;font-size:12.5px}
  .atlas figcaption span{color:var(--dim);font-size:11.5px}
  .anim-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}
  .anim{border:1px solid #edf0f3;border-radius:10px;padding:8px 6px;text-align:center;background:#fcfdfe}
  .frame{width:104px;height:104px;margin:0 auto;background-repeat:no-repeat;
    background-image:linear-gradient(45deg,var(--chk1) 25%,transparent 25%),
      linear-gradient(-45deg,var(--chk1) 25%,transparent 25%),
      linear-gradient(45deg,transparent 75%,var(--chk1) 75%),
      linear-gradient(-45deg,transparent 75%,var(--chk1) 75%);
    background-size:12px 12px;background-position:0 0,0 6px,6px -6px,-6px 0;border-radius:8px;
    image-rendering:auto}
  .frame.empty{display:flex;align-items:center;justify-content:center;font-size:11px;color:#b0b6bf}
  .anim .frame{background-blend-mode:normal}
  .anim-meta{margin-top:6px}
  .anim-meta b{display:block;font-size:11.5px;line-height:1.3;font-weight:500;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .anim-meta code{display:block;font-size:9.5px;background:none;padding:0;color:#9aa1ab;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .anim-meta span{display:block;font-size:9.5px;color:#b0b6bf;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lic{font-size:11.5px;color:#9aa1ab;margin:18px 0 0}
  .theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
  .theme{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fbfcfd}
  .theme-art{padding:16px 10px 2px;display:flex;justify-content:center;align-items:center;min-height:186px}
  .theme-art svg{width:168px;height:auto;animation:bob 3.4s ease-in-out infinite}
  .theme-meta{padding:10px 13px 13px;border-top:1px solid var(--line);background:#fff}
  .theme-meta b{font-size:14px;display:block}
  .theme-meta code{font-size:10.5px;background:none;padding:0;color:#9aa1ab}
  .swatches{display:flex;gap:4px;margin-top:8px}
  .swatches i{width:16px;height:16px;border-radius:4px;border:1px solid rgba(0,0,0,.07)}
  .tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:4px}
  .tbl th,.tbl td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
  .tbl th{font-weight:500;color:var(--dim);font-size:11.5px;background:#fafbfc}
  @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  .atlas-img img{cursor:zoom-in}
  .lb{position:fixed;inset:0;background:rgba(12,15,20,.87);display:none;
    align-items:center;justify-content:center;padding:24px;z-index:99;cursor:zoom-out}
  .lb.on{display:flex}
  .lb img{max-width:96vw;max-height:92vh;border-radius:10px;background:#fff;
    box-shadow:0 24px 70px rgba(0,0,0,.55)}
  .lb .cap{position:absolute;bottom:14px;left:0;right:0;text-align:center;
    color:#cfd6df;font-size:12px}
  @media (max-width:560px){
    .facts{gap:14px}.anim-grid{grid-template-columns:repeat(auto-fill,minmax(94px,1fr))}
    .frame{width:88px;height:88px}
  }
</style>
</head><body><div class="wrap">
  <h1>dsh-companion · 形象总览</h1>
  <p class="lede">${packs.length} 个角色包 · ${totalAnims} 个动作 · ${Object.keys(PALETTES).length} 套配色皮肤。
    图集为原始 PNG，动作格是该动作的第 1 帧（按 sprite 坐标实裁，非重绘）。</p>
  <nav class="toc">
    ${packs.map((p) => `<a href="#${esc(p.id)}">${esc(p.name)}</a>`).join('')}
    <a href="#themes">配色皮肤</a>
  </nav>
  <div id="${esc(packs[0]?.id || '')}"></div>
  ${packs
    .map(
      (p, i) => `${i ? `<div id="${esc(p.id)}"></div>` : ''}${packSection(p)}`
    )
    .join('')}
  <div id="themes"></div>
  ${themesSection()}
  <div class="lb" id="lb"><img alt=""><span class="cap">点任意处关闭 · Esc</span></div>
  <script>
    const lb = document.getElementById('lb');
    const lbImg = lb.querySelector('img');
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t.tagName === 'IMG' && t.dataset.full) {
        lbImg.src = t.dataset.full;
        lb.classList.add('on');
      } else if (lb.classList.contains('on')) {
        lb.classList.remove('on');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') lb.classList.remove('on');
    });
  </script>
</div></body></html>`;

const outDir = path.join(ROOT, 'preview');
const assetDir = path.join(outDir, 'assets');
fs.mkdirSync(assetDir, { recursive: true });
let copied = 0;
for (const p of packs) {
  for (const a of p.assets) {
    if (!a.exists) continue;
    fs.copyFileSync(a.src, path.join(outDir, a.file));
    copied++;
  }
}
const out = path.join(outDir, 'gallery.html');
fs.writeFileSync(out, html, 'utf8');

console.log(`wrote ${path.relative(ROOT, out)}（图集副本 ${copied} 张 → preview/assets/）`);
for (const p of packs) {
  console.log(`  ${p.id}: ${p.anims.length} anims, ${p.assets.length} atlases, canvas ${p.canvas.width}×${p.canvas.height}`);
}
console.log(`  themes: ${Object.keys(PALETTES).join(', ')}`);
console.log(`  size: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
