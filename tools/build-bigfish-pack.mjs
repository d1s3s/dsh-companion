/**
 * build-bigfish-pack.mjs —— 把「大肥鱼」官方角色包转成本插件能直接吃的 dsh-pet 包
 *
 * 为什么要有这个脚本：
 *   社区那套角色包（.dshpet / dsh-pet v1）已经把「素材 + 帧序 + 每帧时长 + 台词」
 *   定义清楚了，格式很干净。与其自己另发明一套，不如直接采用——
 *   这样以后任何人做的 .dshpet 都能丢进来用，不用改插件代码。
 *
 *   大肥鱼官方包有两种形态：
 *     · packs/classic/manifest.json + 6 张图集（内联在 lib/client.js 里）→ 60 个场景动作、72 个姿态
 *     · examples/bigfish-adult/  → 已经是 dsh-pet 格式，原样复制
 *
 * 跑法：
 *   node tools/build-bigfish-pack.mjs <解压后的 dsh-bigfish 目录> [--only classic|adult]
 *
 * 注意：角色美术不是 MIT 授权（见上游 NOTICE）。个人使用没问题，
 * 要分发就把 packs/ 换成你有权分发的素材。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// ------------------------------------------------------------------ 参数

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    flags[k] = v;
  } else pos.push(a);
}
const src = pos[0];
if (!src || !fs.existsSync(src)) {
  console.error('用法：node tools/build-bigfish-pack.mjs <解压后的 dsh-bigfish 目录>');
  process.exit(1);
}
const only = flags.only || 'both';

/**
 * 图集降采样倍率。
 * 12.5 MB 的原图集要整份塞进 data URI 推给前端，太大；而角色实际显示只有 150~200px。
 * 0.5 倍后 444 → 222px，高清屏上仍然够，体积掉到 1/4。
 */
const SCALE = flags.scale == null ? 0.5 : Number(flags.scale);

function findFfmpeg() {
  const la = process.env.LOCALAPPDATA;
  const cands = [
    process.env.FFMPEG,
    'ffmpeg',
    la && path.join(la, 'Microsoft/WinGet/Links/ffmpeg.exe'),
    path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe'),
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch { /* 下一个 */ }
  }
  return null;
}

// ------------------------------------------------------------------ 动作中文名

/** 34 个动作 id 的中文名。图集只有英文 id，名字得自己配，不然气泡里全是 calm / pout。 */
const LABEL = {
  calm: '安静呼吸',
  'hug-tail': '抱着尾巴',
  thinking: '想一想',
  focused: '专注冲刺',
  nervous: '有点紧张',
  pout: '嘟嘴整理',
  dodge: '躲一下',
  dizzy: '转晕了',
  wipe: '擦擦汗',
  'look-back': '回头看',
  panic: '慌了',
  stamp: '盖章确认',
  stumble: '绊了一下',
  book: '翻书',
  peek: '探头看',
  tea: '喝口茶',
  repair: '修东西',
  confused: '有点迷糊',
  wiping: '擦桌子',
  stretch: '伸懒腰',
  nap: '打个盹',
  'wait-sign': '举牌等你',
  wave: '招手',
  'tail-wag': '摇尾巴',
  sigh: '叹口气',
  'sign-overhead': '把牌举过头顶',
  'sign-peek': '举牌偷看',
  'sign-tail': '尾巴帮你举牌',
  'sign-bounce': '举牌蹦两下',
  confirm: '等你确认',
  happy: '开心收工',
  delivery: '交付成果',
  relieved: '松一口气',
  bow: '鞠个躬',
};

const SCENE_LABEL = {
  desk: '书桌',
  library: '书架',
  workshop: '工作台',
  treadmill: '跑步机',
  rest: '休息',
  delivery: '交付',
};

/** 把上游的 states 翻成我们自己的标签，外加几个派生标签 */
const TAG_ALIAS = {
  idle: ['idle', 'greeting'],
  'awaiting-output': ['idle'],
  reasoning: ['thinking'],
  generating: ['writing', 'working'],
  'streaming-gap': ['writing'],
  'tool-running': ['tool', 'working'],
  'waiting-user': ['wait', 'attention'],
  completed: ['success'],
  failed: ['error'],
  retrying: ['error', 'working'],
  disconnected: ['error'],
  cancelled: ['error', 'idle'],
  blocked: ['wait'],
  limited: ['wait'],
  interrupted: ['error'],
  'unknown-end': ['idle'],
};

function tagsOf(states) {
  const out = new Set();
  for (const s of states || []) {
    out.add(s);
    for (const t of TAG_ALIAS[s] || []) out.add(t);
  }
  return [...out];
}

// ------------------------------------------------------------------ 图集几何

/**
 * 从打包后的 client.js 里抠出图集几何表。
 * 它是 `var Ts={classic:{width,height,frames:[{x,y,width,height,anchor}]},...}`，
 * 纯字面量，eval 一次就能拿到对象——比自己写正则去啃安全。
 */
function readGeometry(clientJsPath) {
  const s = fs.readFileSync(clientJsPath, 'utf8');
  const tail = s.lastIndexOf('var Ls={classic:');
  if (tail < 0) throw new Error('client.js 里找不到图集表（版本变了？）');
  // 往前找最近的 `var xxx=`，那就是几何表的开头
  const from = Math.max(0, tail - 200000);
  const m = s.slice(from, tail).match(/(?:^|[;}])(var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g);
  if (!m) throw new Error('找不到几何表变量');
  const last = m[m.length - 1];
  const varName = last.match(/([A-Za-z_$][\w$]*)\s*=\s*\{$/)[1];
  const start = s.lastIndexOf(varName + '={', tail);
  const code = 'globalThis.__G=' + s.slice(start + varName.length + 1, tail).replace(/;$/, '');
  // eslint-disable-next-line no-new-func
  new Function(code)();
  return globalThis.__G;
}

/** 从 client.js 里抳出 6 张图集的 base64 PNG（按 assets 顺序对应 Lt/Vt/Kt/Pt/xt/Wt） */
function readAtlases(clientJsPath, names) {
  const s = fs.readFileSync(clientJsPath, 'utf8');
  const vars = ['Lt', 'Vt', 'Kt', 'Pt', 'xt', 'Wt'];
  const out = [];
  for (let i = 0; i < vars.length; i++) {
    const re = new RegExp('var ' + vars[i] + '="data:image/png;base64,([A-Za-z0-9+/=]+)"');
    const m = s.match(re);
    if (!m) throw new Error(`找不到图集变量 ${vars[i]}`);
    out.push({ name: names[i], buf: Buffer.from(m[1], 'base64') });
  }
  return out;
}

function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ------------------------------------------------------------------ 转换 classic

function buildClassic(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'packs/classic/manifest.json'), 'utf8'));
  const geom = readGeometry(path.join(pkgDir, 'lib/client.js'));
  const atlases = readAtlases(path.join(pkgDir, 'lib/client.js'), manifest.assets.map((a) => a.replace(/^bigfish-|\.png$/g, ''))
    .map((n) => (n === 'atlas' ? 'classic' : n)));
  // manifest.assets 顺序：bigfish-atlas → classic，其余按名字
  const outDir = path.join(root, 'packs/bigfish-classic');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });

  const ff = SCALE === 1 ? null : findFfmpeg();
  const S = ff ? SCALE : 1;
  if (SCALE !== 1 && !ff) console.warn('⚠ 没找到 ffmpeg，按原始分辨率输出（体积会大 4 倍）');

  const px = (n) => Math.max(1, Math.round(n * S));
  const assets = {};
  for (const a of atlases) {
    const file = path.join(outDir, 'assets', a.name + '.png');
    if (ff) {
      const tmp = path.join(pkgDir, '.tmp-atlas.png');
      fs.writeFileSync(tmp, a.buf);
      const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-i', tmp,
        '-vf', `scale=iw*${S}:ih*${S}:flags=lanczos`, '-pix_fmt', 'rgba',
        '-compression_level', '9', file]);
      fs.rmSync(tmp, { force: true });
      if (r.status !== 0) throw new Error('缩放失败：' + a.name + ' ' + String(r.stderr || ''));
    } else {
      fs.writeFileSync(file, a.buf);
    }
    const sz = pngSize(fs.readFileSync(file));
    assets[a.name] = { path: 'assets/' + a.name + '.png', width: sz.width, height: sz.height };
  }

  // 画布尺寸 = 最大的那一帧。超出会被裁掉，这是上游图集本身的约束。
  let cw = 0;
  let ch = 0;
  for (const k of Object.keys(geom)) {
    for (const f of geom[k].frames) {
      cw = Math.max(cw, f.width);
      ch = Math.max(ch, f.height);
    }
  }
  cw = px(cw);
  ch = px(ch);

  const seen = new Set();
  const anims = [];
  for (const scene of manifest.scenes) {
    for (const act of scene.actions || []) {
      let id = `bigfish:${act.id}`;
      // 同名动作在不同场景里是不同姿态，必须去重，否则后一个会被覆盖
      if (seen.has(id)) id = `bigfish:${scene.id}-${act.id}`;
      seen.add(id);

      const an = act.animation || null;
      let frames;
      if (an && Array.isArray(an.frames) && an.frames.length) {
        const g = geom[an.atlas];
        if (!g) continue;
        const per = Math.max(50, Math.round(1000 / (an.fps || 6)));
        frames = an.frames.map((idx) => {
          const f = g.frames[idx];
          return { asset: an.atlas, rect: [px(f.x), px(f.y), px(f.width), px(f.height)], durationMs: per };
        });
      } else {
        // 没有帧序列的动作 = 图集里的一格静态姿态，配上程序位移就够用了
        const g = geom.classic;
        const f = g.frames[act.sprite || 0];
        if (!f) continue;
        frames = [{ asset: 'classic', rect: [px(f.x), px(f.y), px(f.width), px(f.height)], durationMs: 1400 }];
      }

      anims.push({
        id,
        label: (SCENE_LABEL[scene.id] || scene.id) + '·' + (LABEL[act.id] || act.id),
        tags: tagsOf(act.states),
        intensity: 0,
        loop: true,
        weight: act.weight || 1,
        cooldownMs: act.cooldownMs || 4000,
        frames,
      });
    }
  }

  const pet = {
    format: 'dsh-pet',
    formatVersion: 1,
    id: 'bigfish-classic',
    name: '大肥鱼 · 内置',
    version: '0.6.0',
    author: 'gosomea / dsh-bigfish（转换：dsh-companion）',
    description: `${anims.length} 个动作、${Object.keys(assets).length} 张图集，来自 dsh-bigfish 内置大肥鱼。蓝发、鲸鱼尾巴、围裙。`,
    license: '角色美术版权归上游作者，代码 MIT；个人使用，分发自行确认授权',
    canvas: { width: cw, height: ch },
    scale: S,
    assets,
    thumbnail: 'assets/classic.png',
    animations: 'animations.json',
    dialogue: 'dialogue.json',
    fallbacks: {
      greeting: 'bigfish:rest-wave',
      idle: 'bigfish:rest-calm',
      thinking: 'bigfish:desk-thinking',
      writing: 'bigfish:treadmill-focused',
      working: 'bigfish:treadmill-focused',
      tool: 'bigfish:workshop-repair',
      wait: 'bigfish:rest-wait-sign',
      success: 'bigfish:delivery-happy',
      error: 'bigfish:workshop-confused',
    },
  };

  fs.writeFileSync(path.join(outDir, 'animations.json'), JSON.stringify(anims, null, 2));

  // 台词：上游 20 类 × 8 句，直接搬过来当气泡话术
  const dlgSrc = path.join(pkgDir, 'docs/default-dialogue.json');
  if (fs.existsSync(dlgSrc)) fs.copyFileSync(dlgSrc, path.join(outDir, 'dialogue.json'));

  fs.writeFileSync(path.join(outDir, 'pet.json'), JSON.stringify(pet, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'NOTICE.txt'),
    '角色美术来源：dsh-bigfish（github.com/gosomea/dsh-bigfish），角色版权归原作者。\n'
    + '插件代码 MIT；角色美术与标志单独授权，代码许可不代表对第三方角色权利的授权。\n'
    + '个人使用无碍；对外分发请替换为你有权分发的素材。\n',
  );

  const size = Object.values(assets).reduce((a, v) => a + fs.statSync(path.join(outDir, v.path)).size, 0);
  return { dir: outDir, anims: anims.length, assets: Object.keys(assets).length, mb: +(size / 1048576).toFixed(1), canvas: `${cw}x${ch}` };
}

// ------------------------------------------------------------------ 复制 adult

function buildAdult(pkgDir) {
  const s = path.join(pkgDir, 'examples/bigfish-adult');
  if (!fs.existsSync(s)) return null;
  const outDir = path.join(root, 'packs/bigfish-adult');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(s, outDir, { recursive: true });
  const pet = JSON.parse(fs.readFileSync(path.join(outDir, 'pet.json'), 'utf8'));
  const anims = JSON.parse(fs.readFileSync(path.join(outDir, 'animations.json'), 'utf8'));
  // 下游按 assets[key].path 找文件，上游是相对 pet.json 的路径，这里对齐
  for (const k of Object.keys(pet.assets || {})) {
    const p = path.join(outDir, pet.assets[k].path);
    if (!fs.existsSync(p)) throw new Error('成年版缺素材：' + pet.assets[k].path);
  }
  const size = Object.values(pet.assets || {}).reduce((a, v) => a + fs.statSync(path.join(outDir, v.path)).size, 0);
  return { dir: outDir, anims: anims.length, assets: Object.keys(pet.assets || {}).length, mb: +(size / 1048576).toFixed(1), canvas: `${pet.canvas.width}x${pet.canvas.height}` };
}

// ------------------------------------------------------------------ 跑

const results = [];
if (only === 'both' || only === 'classic') results.push(['classic', buildClassic(src)]);
if (only === 'both' || only === 'adult') {
  const r = buildAdult(src);
  if (r) results.push(['adult', r]);
  else console.log('（这个包里没有成年版，跳过）');
}

console.log('角色包已生成：');
for (const [k, r] of results) {
  console.log(`  ${k.padEnd(8)} ${r.anims} 个动作 · ${r.assets} 张图集 · ${r.mb} MB · 画布 ${r.canvas}`);
  console.log(`           → ${path.relative(root, r.dir)}`);
}
console.log('\n在 dsh 配置里把 characterPack 指向 packs/bigfish-classic 即可。');
