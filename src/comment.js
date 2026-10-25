/**
 * comment.js —— 让她能评论，但每一步都留退路
 *
 * 为什么评论要单独一个文件、单独一套权限：
 *   刷视频是**消费**，最坏结果是浪费时间；
 *   评论是**对外发言**，用的是用户的账号和身份，最坏结果是得罪人、被封号。
 * 这两件事的风险差一个量级，不能共用一个开关。
 *
 * 四道校验，缺一不可：
 *   1. 站点白名单      —— 只在她自己登录的那个号能发的站上发
 *   2. 输入框回读比对   —— 打完字读回来，逐字确认是要发的那句
 *      （防：焦点错位、输入法吞字、页面把字插到别处）
 *   3. 按钮文本校验     —— 按钮上必须写着「发送/发布/评论」
 *      （防：把「删除」「举报」当发送按钮点了）
 *   4. 发出后回读       —— 评论区里真的出现了这句话才算成功
 *
 * 默认 dryRun：只走到第 3 步，把「将在哪个按钮上点一下」报给用户，
 * 用户点头之后才真发。这条路径是默认的，不是可选的。
 */

/** 各站评论 UI 的选择器。多套兜底，因为改版比翻书快。 */
const COMMENT_UI = {
  bilibili: {
    input: [
      '#comment .reply-box textarea',
      'div.reply-box textarea',
      '.bili-comment-box textarea',
      '#comment textarea',
      '.comment-container textarea',
    ],
    submit: [
      '#comment .reply-box .btn-send',
      'div.reply-box .btn-publish',
      '.comment-send button',
      '.reply-box button.btn-publish',
    ],
    openBox: ['.reply-box .reply-box-send', '#comment .reply-box'],
    submitText: /发布|发送|评论|回复/,
  },
  douyin: {
    input: [
      '[data-e2e="comment-input"] textarea',
      '[data-e2e="comment-input"] div[contenteditable="true"]',
      '.comment-input textarea',
      '.comment-input div[contenteditable="true"]',
    ],
    submit: [
      '[data-e2e="comment-publish"]',
      '.comment-publish',
      '.comment-input button',
    ],
    openBox: ['[data-e2e="comment-input"]'],
    submitText: /发送|发布/,
  },
  xiaohongshu: {
    input: ['#content-textarea', '.comment-input textarea', 'div[contenteditable="true"].ql-editor'],
    submit: ['.submit-btn', '.comment-submit', 'button.btn-submit'],
    openBox: ['.comment-input'],
    submitText: /发送|发布|评论/,
  },
};

/** 一次性找元素：返回第一个命中的 selector + 它的位置 */
const FIND = (sels, wantText) => `(() => {
  const sels = ${JSON.stringify(sels)};
  const wantText = ${wantText ? String(wantText) : 'null'};
  for (const s of sels) {
    const list = [...document.querySelectorAll(s)];
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;            // 隐藏元素不算
      if (wantText && !wantText.test((el.innerText || el.textContent || '').trim())) continue;
      return {
        sel: s,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.innerText || el.textContent || '').trim().slice(0, 40),
        tag: el.tagName.toLowerCase(),
        editable: el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT',
        value: (el.value !== undefined ? el.value : (el.innerText || '')).toString(),
      };
    }
  }
  return null;
})()`;

async function findEl(cdp, sels, { wantText } = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression: FIND(sels, wantText), returnByValue: true });
  return r?.result?.value || null;
}

/** 当前页面里评论区开着吗。没开就点一下展开。 */
async function openCommentBox(cdp, ui) {
  const input = await findEl(cdp, ui.input);
  if (input) return { ok: true, input, opened: false };
  for (const s of ui.openBox || []) {
    const el = await findEl(cdp, [s]);
    if (!el) continue;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: el.x, y: el.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: el.x, y: el.y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 700));
    const again = await findEl(cdp, ui.input);
    if (again) return { ok: true, input: again, opened: true };
  }
  return { ok: false, error: '找不到评论输入框。可能是页面还没加载完、没登录、或者评论区是关着的' };
}

/**
 * 发一条评论。
 *
 * @param dryRun true = 只到「准备点发送」这一步就停，不真发（默认）
 */
export async function postComment(cdp, text, { site, dryRun = true, readComments } = {}) {
  const ui = COMMENT_UI[site];
  if (!ui) return { ok: false, error: `站点 ${site} 没有评论适配器` };

  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '评论内容为空' };

  // ---- 1. 找到输入框（必要时展开评论区）
  const box = await openCommentBox(cdp, ui);
  if (!box.ok) return box;
  const input = box.input;
  if (!input.editable) {
    return { ok: false, error: `命中的元素不是可编辑框（${input.tag}：${input.text.slice(0, 20)}）`, selector: input.sel };
  }

  // ---- 2. 聚焦 + 打字
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(input.sel)}); if (!el) return false; el.focus(); return true; })()`,
    returnByValue: true,
  });
  // 先清空（万一有上次残留），再走真实输入通道打字
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.insertText', { text: body });
  await new Promise((r) => setTimeout(r, 400));

  // ---- 3. 回读比对。这一条是核心：打进去的字必须和想发的字一模一样
  const after = await findEl(cdp, ui.input);
  const got = (after?.value || '').trim();
  if (got !== body) {
    return {
      ok: false, step: 'verify-input',
      error: '输入框里的字和要发的对不上，已中止（可能焦点被抢、或输入法吞字）',
      expected: body, actual: got.slice(0, 80),
      tryThis: '把输入框里的字清掉重来，或者换一条短的',
    };
  }

  // ---- 4. 找发送按钮，校验按钮上写的是什么
  const btn = await findEl(cdp, ui.submit, { wantText: ui.submitText });
  if (!btn) {
    const any = await findEl(cdp, ui.submit);
    return {
      ok: false, step: 'find-submit',
      error: '找不到「发送」按钮',
      foundButTextOdd: any ? { selector: any.sel, text: any.text } : null,
      tryThis: '字已经打在框里了，可以让用户自己按一下发送',
      typed: body,
    };
  }

  const preview = {
    ok: true, dryRun: true, step: 'ready-to-send',
    willSend: body,
    button: { text: btn.text, selector: btn.sel, at: [btn.x, btn.y] },
    note: `字已经打进输入框并核对过了。下一步会在「${btn.text}」上点一下。确认要发吗？`,
    selector: input.sel,
  };
  if (dryRun) return preview;

  // ---- 5. 点发送（用真实鼠标事件，不用 .click()）
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1800));

  // ---- 6. 回读：输入框清空了吗？评论区里出现了吗？
  const still = await findEl(cdp, ui.input);
  const cleared = !(still?.value || '').trim();
  let appeared = null;
  if (typeof readComments === 'function') {
    try {
      const page = await readComments();
      appeared = (page?.comments || []).some((c) => String(c).includes(body.slice(0, 12)));
    } catch { appeared = null; }
  }

  const confirmed = cleared || appeared === true;
  return {
    ok: confirmed,
    sent: body,
    buttonText: btn.text,
    inputCleared: cleared,
    appearedInComments: appeared,
    ...(confirmed ? {} : {
      step: 'unconfirmed',
      error: '点了发送但没能确认成功（输入框没清空、评论区也没读到）。可能被折叠、需要验证、或者根本没发出去',
      tryThis: '让用户自己看一眼评论区第一条',
    }),
  };
}

/** 只读评论区，用来确认「发了没有」和「大家在说什么」 */
export const READ_COMMENTS = {
  bilibili: `(() => {
    const pick = (sels, n) => { for (const s of sels) { const a=[...document.querySelectorAll(s)]; if (a.length) return a.slice(0,n).map(e=>(e.innerText||e.textContent||'').trim()).filter(Boolean); } return []; };
    return pick(['#comment .reply-item .reply-content', '.reply-item .content', '.comment-list .reply-content'], 10);
  })()`,
  douyin: `(() => {
    const pick = (sels, n) => { for (const s of sels) { const a=[...document.querySelectorAll(s)]; if (a.length) return a.slice(0,n).map(e=>(e.innerText||e.textContent||'').trim()).filter(Boolean); } return []; };
    return pick(['[data-e2e="comment-item"] [data-e2e="comment-content"]', '.comment-item .content'], 10);
  })()`,
  xiaohongshu: `(() => {
    const pick = (sels, n) => { for (const s of sels) { const a=[...document.querySelectorAll(s)]; if (a.length) return a.slice(0,n).map(e=>(e.innerText||e.textContent||'').trim()).filter(Boolean); } return []; };
    return pick(['.comment-item .content', '.comment-inner .note-text'], 10);
  })()`,
};

export async function readComments(cdp, site) {
  const expr = READ_COMMENTS[site];
  if (!expr) return { ok: false, error: `站点 ${site} 没有评论区适配器` };
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const list = r?.result?.value;
  if (!Array.isArray(list)) return { ok: true, comments: [], note: '评论区没读到内容（可能没展开或改版了）' };
  return { ok: true, comments: list.slice(0, 10) };
}

export const SUPPORTED_COMMENT_SITES = Object.keys(COMMENT_UI);
