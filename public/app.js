/* 阅读器前端逻辑 */
const $ = (id) => document.getElementById(id);

const state = {
  shelves: [],
  settings: {
    theme: "light", fontSize: 19, lineHeight: 1.9, indent: 2, letterSpacing: 0,
    maxWidth: 820, fontFamily: "serif", autoNext: true
  },
  progress: {},
  shelfIndex: -1,
  books: [],
  book: null,          // { rel, title, author, chapters:[{title,idx}], chapterCount }
  chapterIdx: 0,
  bookPage: 1,
  bookPerPage: 20,
  filter: "",
  sort: "name",
  tocVirtual: { itemH: 31, top: 0, count: 0 },
  tocDesc: false,       // 目录倒序：最后一章排在最上面
  fonts: []            // 自定义字体 [{ id, name, file }]
};

const THEMES = [
  ["light", "米白"], ["sepia", "羊皮纸"], ["green", "护眼绿"], ["dark", "夜间"]
];

const FONTS = {
  serif: '"Songti SC","SimSun",Georgia,serif',
  song: '"Source Han Serif SC","Noto Serif SC","Songti SC",serif',
  kai: '"Kaiti SC","KaiTi","STKaiti",serif',
  hei: '"Microsoft YaHei","PingFang SC",sans-serif'
};

const CUSTOM_PREFIX = "custom:";
try { state.tocDesc = localStorage.getItem("tocDesc") === "1"; } catch {}

/* 把用户导入的字体注册成 @font-face */
function loadCustomFonts() {
  let st = document.getElementById("customFonts");
  if (!st) { st = document.createElement("style"); st.id = "customFonts"; document.head.appendChild(st); }
  st.textContent = (state.fonts || []).map((f) =>
    '@font-face{font-family:"rz-' + f.id + '";src:url("/fonts/' + encodeURIComponent(f.file) + '");font-display:swap}'
  ).join("\n");
}

/* 设置里的 fontFamily 值 -> CSS font-family */
function resolveFont(key) {
  if (key && key.startsWith(CUSTOM_PREFIX)) {
    const id = key.slice(CUSTOM_PREFIX.length);
    if ((state.fonts || []).some((f) => f.id === id)) return '"rz-' + id + '",serif';
  }
  return FONTS[key] || FONTS.serif;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

/* ---------------- 设置 ---------------- */

function applySettings() {
  const s = state.settings;
  document.body.dataset.theme = s.theme;
  const c = $("content");
  c.style.fontSize = s.fontSize + "px";
  c.style.lineHeight = s.lineHeight;
  c.style.letterSpacing = s.letterSpacing + "px";
  c.style.maxWidth = s.maxWidth + "px";
  c.style.fontFamily = resolveFont(s.fontFamily);
  // 段落字号/行距/缩进由 .content 继承，--indent 供 .content p 使用
  c.style.setProperty("--indent", s.indent + "em");
  if (typeof updateEndHint === "function") updateEndHint();
}

function saveSettings() {
  api("/api/settings", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: state.settings })
  }).catch(() => {});
}

/** 内置字体（不可删除）。顺序即下拉里的显示顺序。 */
const BUILTIN_FONT_LABELS = {
  serif: "宋体 / 衬线",
  song: "思源宋体",
  kai: "楷体",
  hei: "黑体",
};

/**
 * 字体菜单的预设最大高度（px）。
 *
 * 字体再多，菜单也只占这么高，超出部分靠滚动查看 —— 避免导入几十个字体后
 * 菜单无限往下延伸、把整屏占满。与 style.css 里 .fp-menu 的 max-height 保持一致；
 * 定位时若窗口剩余空间更小，还会进一步收窄（见 positionFontPicker）。
 */
const FP_MENU_MAX_H = 260;

/**
 * 字体选择器：一个按钮 + 浮层列表，替代原来的「原生 <select> + 独立字体列表」两块。
 *
 * 与原生 <select> 的区别：
 *   1) 每一项用它**自己对应的字体**渲染（原生 option 在 Windows 上普遍忽略 font-family）；
 *   2) 自定义字体那几项右侧带 ✕，点了直接删；内置字体没有 ✕。
 *
 * 渲染是幂等的：每次调用都按当前 state.fonts / state.settings.fontFamily 重建，
 * 所以导入 / 删除字体后直接再调一次即可。
 */
function renderFontPicker() {
  const btn = $("fontPickerBtn");
  const menu = $("fontPickerMenu");
  const cur = $("fontPickerCur");
  if (!btn || !menu || !cur) return;

  const key = state.settings.fontFamily || "serif";
  // 顶部按钮显示当前字体名，并用该字体渲染自己
  cur.textContent = fontLabelOf(key);
  cur.style.fontFamily = resolveFont(key);

  menu.innerHTML = "";
  // 内置字体
  for (const k of Object.keys(BUILTIN_FONT_LABELS)) {
    menu.appendChild(fontPickerItem({ value: k, label: BUILTIN_FONT_LABELS[k], deletable: false, active: key === k }));
  }
  // 内置与自定义之间加分隔线：列表长了以后能一眼看出「下面这些是可删的」
  if ((state.fonts || []).length) {
    const sep = document.createElement("div");
    sep.className = "fp-sep";
    menu.appendChild(sep);
  }
  // 自定义字体
  for (const f of state.fonts || []) {
    menu.appendChild(fontPickerItem({
      value: CUSTOM_PREFIX + f.id,
      label: f.name,
      deletable: true,
      active: key === CUSTOM_PREFIX + f.id,
      font: '"rz-' + f.id + '",serif',
      id: f.id,
    }));
  }
}

/** 取某个 fontFamily 值对应的显示名 */
function fontLabelOf(key) {
  if (key && key.startsWith(CUSTOM_PREFIX)) {
    const id = key.slice(CUSTOM_PREFIX.length);
    const f = (state.fonts || []).find((x) => x.id === id);
    if (f) return f.name;
  }
  return BUILTIN_FONT_LABELS[key] || BUILTIN_FONT_LABELS.serif;
}

/** 造一行字体选项 */
function fontPickerItem({ value, label, deletable, active, font, id }) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "fp-item" + (active ? " on" : "");
  item.dataset.value = value;
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", active ? "true" : "false");
  const name = document.createElement("span");
  name.className = "fp-name";
  name.textContent = label;
  name.style.fontFamily = font || resolveFont(value);   // 用该字体渲染自己
  item.appendChild(name);
  if (deletable) {
    const del = document.createElement("span");
    del.className = "fp-del";
    del.title = "删除该字体";
    del.textContent = "✕";
    del.onclick = (e) => { e.stopPropagation(); removeCustomFont(id, label); };
    item.appendChild(del);
  }
  item.onclick = () => {
    state.settings.fontFamily = value;
    applySettings();
    saveSettings();
    closeFontPicker();
    renderFontPicker();
  };
  return item;
}

/**
 * 把菜单摆到按钮正下方（或上方，空间不够时）。
 *
 * 菜单是 position:fixed 且挂在 body 下，所以要自己算坐标。
 * 优先向下展开；下方放不下就向上翻 —— 字体块常在设置面板底部，
 * 只做向下展开的话在窗口不高时仍会被视口切掉。
 */
function positionFontPicker() {
  const menu = $("fontPickerMenu"), btn = $("fontPickerBtn");
  if (!menu || !btn || menu.classList.contains("hidden")) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const vw = window.innerWidth, vh = window.innerHeight;
  // 先按内容测高（此刻菜单已可见，max-height 已生效）
  const mh = menu.offsetHeight || 0;
  const below = vh - r.bottom - gap;
  const above = r.top - gap;
  const openUp = below < Math.min(mh, 160) && above > below;
  const maxH = Math.max(120, Math.floor(openUp ? above : below));
  menu.style.maxHeight = Math.min(FP_MENU_MAX_H, maxH) + "px";
  menu.style.left = Math.round(r.left) + "px";
  menu.style.width = Math.round(r.width) + "px";
  menu.style.top = openUp
    ? Math.round(r.top - gap - Math.min(mh, maxH)) + "px"
    : Math.round(r.bottom + gap) + "px";
}

/**
 * 把当前选中的那一项滚进可视区。
 *
 * 字体多到需要滚动时，当前字体可能在列表很靠下的位置 ——
 * 打开菜单后如果还停在顶部，用户得自己往下翻才能看到「当前用的是哪个」。
 * 这里用 scrollIntoView({block:'nearest'})：已在可视区内就不动，避免无谓跳动。
 */
function revealCurrentFontItem() {
  const menu = $("fontPickerMenu");
  if (!menu) return;
  const active = menu.querySelector(".fp-item.on");
  if (!active) return;
  try { active.scrollIntoView({ block: "nearest" }); }
  catch { /* 老浏览器没有 options 参数，忽略即可 */ }
}

function openFontPicker() {
  const menu = $("fontPickerMenu"), btn = $("fontPickerBtn");
  if (!menu || !btn) return;
  renderFontPicker();
  menu.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  positionFontPicker();
  revealCurrentFontItem();
  // 面板内部滚动 / 窗口缩放时菜单要跟着按钮走（否则会飘在原地）
  window.addEventListener("resize", positionFontPicker);
  const scroller = document.querySelector("#modalSettings .settings-body");
  if (scroller) scroller.addEventListener("scroll", positionFontPicker, { passive: true });
}
function closeFontPicker() {
  const menu = $("fontPickerMenu"), btn = $("fontPickerBtn");
  if (menu) menu.classList.add("hidden");
  if (btn) btn.setAttribute("aria-expanded", "false");
  window.removeEventListener("resize", positionFontPicker);
  const scroller = document.querySelector("#modalSettings .settings-body");
  if (scroller) scroller.removeEventListener("scroll", positionFontPicker);
}
function toggleFontPicker() {
  const menu = $("fontPickerMenu");
  if (!menu) return;
  if (menu.classList.contains("hidden")) openFontPicker(); else closeFontPicker();
}

/** 删除一个自定义字体（内置字体走不到这里） */
async function removeCustomFont(id, name) {
  const r = await api("/api/fonts/remove", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error) return toast("删除失败：" + ((r && r.error) || "未知错误"));
  state.fonts = r.fonts || [];
  // 后端会把「正在用这个字体」的设置回退到默认字体，这里跟着同步
  if (r.settings) state.settings = { ...state.settings, ...r.settings };
  loadCustomFonts();
  applySettings();
  renderFontPicker();
  toast("已删除字体：" + name);
}

function syncSettingsUI() {
  const s = state.settings;
  $("setFontSize").value = s.fontSize; $("vFontSize").textContent = s.fontSize;
  $("setLineHeight").value = s.lineHeight; $("vLineHeight").textContent = s.lineHeight.toFixed(2);
  $("setIndent").value = s.indent; $("vIndent").textContent = s.indent + "em";
  $("setLetter").value = s.letterSpacing; $("vLetter").textContent = s.letterSpacing;
  $("setMaxWidth").value = s.maxWidth; $("vMaxWidth").textContent = s.maxWidth;
  renderFontPicker();
  const autoOn = state.settings.autoNext !== false;
  // 打开设置时顺带校正顶栏按钮显示，避免状态漂移
  const ab = $("btnAutoNext");
  if (ab) {
    ab.classList.toggle("on", autoOn);
    ab.title = autoOn ? "自动下一章：已开启（滚到章末自动翻）" : "自动下一章：已关闭（只能手动翻）";
  }
  syncPoolSizeUI();
}

/* ---------------- 书源并发数（worker 池大小） ---------------- */

/**
 * 显示当前 worker 数量。
 * state.settings.sourcePoolSize 为 0 表示「跟随默认」，此时向服务端问真实值，
 * 避免界面显示 0 而实际跑 4 个 worker。
 */
async function syncPoolSizeUI() {
  const el = $("setPoolSize");
  const out = $("vPoolSize");
  if (!el || !out) return;
  let n = Number(state.settings.sourcePoolSize) || 0;
  if (!n) {
    try {
      const r = await api("/api/online/pool");
      n = Number(r.size) || 4;
    } catch { n = 4; }
  }
  el.value = n;
  out.textContent = n;
}

/* ---------------- 书架 ---------------- */

async function loadState() {
  const st = await api("/api/state");
  state.shelves = st.shelves || [];
  state.settings = { ...state.settings, ...(st.settings || {}) };
  state.progress = st.progress || {};
  state.fonts = st.fonts || [];
  loadCustomFonts();
  renderShelfSelect();
  applySettings(); syncSettingsUI();
  if (!state.shelves.length) { renderBooks(); return; }
  let si = Number(localStorage.getItem("lastShelf"));
  if (!Number.isInteger(si) || si < 0 || si >= state.shelves.length) si = 0;
  await selectShelf(si);
  const lastRel = localStorage.getItem("lastBookRel");
  if (lastRel) {
    const b = state.books.find((x) => x.rel === lastRel);
    if (b) { await openBook(b); return; }
  }
}

function renderShelfSelect() {
  const sel = $("shelfSelect");
  sel.innerHTML = "";
  if (!state.shelves.length) {
    sel.innerHTML = '<option value="-1">（未导入书架）</option>';
    $("shelfPath").textContent = "";
    return;
  }
  // 一级 / 二级分开：子文件夹归到其上级书架的 optgroup 里，不再和上级平铺混在一起
  const norm = (x) => x.replace(/[\\/]+$/, "").toLowerCase();
  const paths = state.shelves.map((s) => norm(s.path || ""));
  const parentOf = state.shelves.map((_, i) => {
    let best = -1;
    paths.forEach((pp, j) => {
      if (i === j || !pp) return;
      if (!(paths[i] === pp || paths[i].startsWith(pp + "\\") || paths[i].startsWith(pp + "/"))) return;
      if (best < 0 || pp.length > paths[best].length) best = j;
    });
    return best;
  });
  const topIdx = [];
  const kidsOf = state.shelves.map(() => []);
  state.shelves.forEach((_, i) => {
    const p = parentOf[i];
    if (p < 0) topIdx.push(i); else kidsOf[p].push(i);
  });
  const mkOpt = (i, indent) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = indent + `${state.shelves[i].name}  (${state.shelves[i].count ?? 0})`;
    if (i === state.shelfIndex) o.selected = true;
    return o;
  };
  const SUB_INDENT = "\u3000\u3000";   // 两个全角空格 = 缩进两格，表示是子文件夹
  for (const i of topIdx) {
    sel.appendChild(mkOpt(i, ""));
    const kids = kidsOf[i];
    if (!kids.length) continue;
    kids.sort((a, b) => state.shelves[a].name.localeCompare(state.shelves[b].name, "zh", { numeric: true }));
    for (const k of kids) sel.appendChild(mkOpt(k, SUB_INDENT));
  }
}

let shelfLoadSeq = 0;

async function selectShelf(i) {
  const seq = ++shelfLoadSeq;
  state.shelfIndex = i;
  $("shelfSelect").value = String(i);
  const data = await api("/api/books?shelf=" + i);
  if (seq !== shelfLoadSeq) return;   // 快速连续切换/移除时丢弃旧响应
  state.books = data.books || [];
  $("shelfPath").textContent = data.root || "";
  state.shelves[i].count = state.books.length;
  state.bookPage = 1;
  renderShelfSelect();
  renderBooks();
  // 服务端回的是磁盘快照（stale）：它可能刚启动，正在后台重扫。稍后静默校正一次。
  if (data.stale && seq === shelfLoadSeq) {
    setTimeout(() => {
      if (seq !== shelfLoadSeq) return;
      api("/api/books?shelf=" + i).then((fresh) => {
        if (seq !== shelfLoadSeq) return;
        const n = (fresh.books || []).length;
        if (n === state.books.length) return;
        state.books = fresh.books || [];
        state.shelves[i].count = n;
        renderShelfSelect();
        renderBooks();
      }).catch(() => {});
    }, 1200);
  }
}

/* ---------------- 书籍列表（按窗口高度自动分页） ---------------- */

function dirOf(b) {
  const r = b.rel || "";
  const i = r.lastIndexOf("\\");
  return i >= 0 ? r.slice(0, i) : "";
}

function bookRows() {
  // 估算“一屏能放几条”；实测单条约 51px，这里取小值让估算偏大，再由渲染后的收敛回退
  const listH = $("bookList").clientHeight || 400;
  return Math.max(4, Math.min(60, Math.floor((listH - 12) / 44)));
}

function visibleBooks() {
  const kw = state.filter.trim().toLowerCase();
  let list = state.books;
  if (kw) list = list.filter((b) => b.name.toLowerCase().includes(kw) || (b.author || "").toLowerCase().includes(kw));
  const p = state.progress;
  let inner;
  if (state.sort === "size") inner = (a, b) => b.size - a.size;
  else if (state.sort === "mtime") inner = (a, b) => b.mtime - a.mtime;
  else if (state.sort === "read") inner = (a, b) => ((p[b.rel]?.at || 0) > 0 ? 0 : 1) - ((p[a.rel]?.at || 0) > 0 ? 0 : 1);
  else inner = (a, b) => a.name.localeCompare(b.name, "zh");
  // 排序键：文件夹优先（目录名升序），组内再按所选方式；这样同一目录名不会反复出现
  return list.slice().sort((a, b) => {
    const da = dirOf(a), db = dirOf(b);
    if (da !== db) return da.localeCompare(db, "zh");
    return inner(a, b) || a.name.localeCompare(b.name, "zh");
  });
}

function renderBooks() {
  const box = $("bookList");
  if (!state.shelves.length) {
    box.innerHTML = '<div class="empty-hint" style="padding:30px 10px;font-size:13px">还没有书架<br>点左侧「导入文件夹」添加</div>';
    $("bkPageInfo").textContent = "0 / 0";
    return;
  }
  if (!state.books.length) {
    box.innerHTML = '<div class="empty-hint" style="padding:30px 10px;font-size:13px">此文件夹内没有 txt</div>';
    return;
  }
  const list = visibleBooks();
  // 一页条数：按本页真实内容（条目 51px + 目录标题 19px + 内边距）收敛到刚好铺满，不出现滚动条
  const avail = $("bookList").clientHeight || 400;
  const headsIn = (from2, n) => {
    let h = 0, last = null;
    const end = Math.min(list.length, from2 + n);
    for (let i = from2; i < end; i++) {
      const d = dirOf(list[i]);
      if (d && d !== last) h++;
      last = d;
    }
    return h;
  };
  let per = bookRows();
  let start0 = (state.bookPage - 1) * per;
  for (let k = 0; k < 10 && per > 4; k++) {
    start0 = (state.bookPage - 1) * per;
    if (per * 51 + headsIn(start0, per) * 19 + 12 <= avail) break;
    per--;
  }
  state.bookPerPage = per;
  const total = Math.max(1, Math.ceil(list.length / state.bookPerPage));
  state.bookPage = Math.min(state.bookPage, total);
  const start = (state.bookPage - 1) * state.bookPerPage;
  const slice = list.slice(start, start + state.bookPerPage);

  box.innerHTML = "";
  let lastDir = null;
  for (const b of slice) {
    const dir = b.rel.includes("\\") ? b.rel.slice(0, b.rel.lastIndexOf("\\")) : "";
    if (dir && dir !== lastDir) {
      const h = document.createElement("div");
      h.className = "dir-head";
      h.textContent = dir;
      box.appendChild(h);
      lastDir = dir;
    } else if (!dir) lastDir = "";
    const el = document.createElement("div");
    el.className = "book-item" + (state.book && state.book.rel === b.rel ? " active" : "");
    const pr = state.progress[b.rel];
    const pct = pr && pr.total ? Math.round(((pr.chapter + 1) / pr.total) * 100) : 0;
    el.innerHTML = `<div class="bt"><span class="bn" title="${esc(b.name)}">${esc(b.name)}</span></div>
      <div class="bs">${(b.size / 1024 / 1024).toFixed(1)}MB${tryAuthor(b)}${pct ? " · 已读 " + pct + "%" : ""}</div>`;
    el.onclick = () => openBook(b);
    box.appendChild(el);
  }
  $("bkPageInfo").textContent = `${state.bookPage} / ${total}  ·  ${list.length} 本`;
  $("bkPrev").disabled = state.bookPage <= 1;
  $("bkNext").disabled = state.bookPage >= total;
  // 本地书架翻页也从顶部开始（同页重绘不动位置），和在线书架一致
  if (state.bookPage !== bkRenderedPage) { bkRenderedPage = state.bookPage; box.scrollTop = 0; }
  updateBookNav();
}

/* 上一次渲染进 #bookList 的页码（本地模式；在线模式在 online.js 里另有一份） */
let bkRenderedPage = 0;

function tryAuthor(b) {
  return b.author ? " · " + esc(b.author) : "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------------- 上一本 / 下一本 ---------------- */

// 当前顺序（与书架列表一致，含筛选与排序）
function currentOrder() {
  return visibleBooks();
}

function stepBook(delta) {
  if (!state.book) {
    const list = currentOrder();
    if (list.length) openBook(list[0]);
    return;
  }
  const list = currentOrder();
  let i = list.findIndex((b) => b.rel === state.book.rel);
  if (i < 0) {
    // 当前书被筛选掉：以全量列表定位
    const all = state.books.slice().sort((x, y) => x.name.localeCompare(y.name, "zh"));
    i = all.findIndex((b) => b.rel === state.book.rel);
    const j = i + delta;
    if (j < 0 || j >= all.length) return toast(delta < 0 ? "已是第一本" : "已是最后一本");
    return switchTo(all[j], delta);
  }
  const j = i + delta;
  if (j < 0) return toast("已是第一本");
  if (j >= list.length) return toast("已是最后一本");
  switchTo(list[j], delta);
}

async function switchTo(book, delta) {
  await openBook(book, { keepChapter: false, silent: true });
  // 同步书架分页，使目标书出现在列表里
  const list = currentOrder();
  const pos = list.findIndex((b) => b.rel === book.rel);
  if (pos >= 0) {
    const page = Math.floor(pos / state.bookPerPage) + 1;
    if (page !== state.bookPage) { state.bookPage = page; renderBooks(); }
  }
  toast((delta > 0 ? "下一本" : "上一本") + "：" + book.name);
}

function updateBookNav() {
  const list = currentOrder();
  const i = state.book ? list.findIndex((b) => b.rel === state.book.rel) : -1;
  const onlyOne = list.length <= 1;
  const atFirst = i <= 0;
  const atLast = i === list.length - 1;
  /**
   * 顶栏按钮（btnPrevBook / btnNextBook）现在翻的是**章**，所以禁用状态按章算；
   * 底部按钮（btnPrev / btnNext）翻的是**本**，仍按书算。
   * 两者语义不同，不能再用同一个 disPrev / disNext。
   */
  const chIdx = Number(state.chapterIdx) || 0;
  const chTotal = Number(state.book && state.book.chapterCount) || 0;
  const chDisPrev = !chTotal || chIdx <= 0;
  const chDisNext = !chTotal || chIdx >= chTotal - 1;
  const bp = $("btnPrevBook"), bn = $("btnNextBook");
  /**
   * tooltip 里的快捷键要和「键盘」段真正绑定的键一致。
   *
   * 翻章是 ← / →（也支持 PageUp / PageDown），见文件末尾的 keydown 处理器；
   * Alt+←/→ 是**翻整本**（stepBook），不要写到这里 —— 顶栏按钮现在是翻章。
   */
  if (bp) { bp.disabled = chDisPrev; bp.title = chDisPrev ? "已是第一章" : "上一章（← / PageUp）"; }
  if (bn) { bn.disabled = chDisNext; bn.title = chDisNext ? "已是最后一章" : "下一章（→ / PageDown）"; }
  const disPrev = onlyOne || atFirst;
  const disNext = onlyOne || atLast;
  ["btnPrev"].forEach((id) => { const e = $(id); if (e) e.disabled = disPrev; });
  ["btnNext"].forEach((id) => { const e = $(id); if (e) e.disabled = disNext; });
  const prvBtn = $("btnPrev");
  const nxtBtn = $("btnNext");
  const prv = i > 0 ? list[i - 1] : null;
  const nxt = i >= 0 && !atLast ? list[i + 1] : null;
  if (prvBtn) prvBtn.title = prv ? "上一本：" + prv.name : "已是第一本";
  if (nxtBtn) nxtBtn.title = nxt ? "下一本：" + nxt.name : "已是最后一本";
}

/* ---------------- 翻章过渡：单层连续滚动 ----------------
   旧实现用「覆盖层 + opacity/transform」做视差，会把正文文字提升为合成层：
   Windows 上合成层拿不到次像素抗锯齿（ClearType），字变灰发虚，加上两层文字错位
   重叠，看起来就是「发花」。
   新实现：把新章直接拼在旧章后（后翻）或前（前翻），前后是同一份连续文本，
   只滚 scrollTop 穿过章界线。单层、无 transform、无透明度 → 不花。 */

/* 翻章缓动：速度曲线 ∝ t^0.55·(1-t)^1.2，数值积分成位移表（一次性，约 30µs）。
   为什么不用对称的 ease-in-out：它起点导数为 0，起步那几十毫秒几乎不动、之后突然加速，
   手感就是「先顿一下再冲」，这是翻章最不顺的地方。本曲线起点速度非零，起步即走。
   指数 (0.55,1.2) 是按「帧间 Δ速度」在 5 组候选里实测定下来的（每组正反各 3 次取中位）：
   P90 抖动 0.269，优于 (0.45,1.4) 的 0.316；帧内峰值/均速 1.49~1.55。
   动画期间实测逐帧跑满 60Hz（帧间隔中位 16.7ms、最大 18ms），无掉帧也无回弹。 */
const FLIP_EASE = (() => {
  const N = 1024;
  const cum = new Float64Array(N + 1);
  let acc = 0;
  for (let i = 1; i <= N; i++) { const t = i / N; acc += Math.pow(t, 0.55) * Math.pow(1 - t, 1.2); cum[i] = acc; }
  return (k) => {
    const x = (k <= 0 ? 0 : k >= 1 ? 1 : k) * N;
    const i = x | 0;
    const v = i >= N ? cum[N] : cum[i] + (cum[i + 1] - cum[i]) * (x - i);
    return v / acc;
  };
})();

const REDUCE_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FLIP_MS_MIN = 300, FLIP_MS_MAX = 620;                // 翻章滑动时长（按距离插值）
const FLIP_SPEED = 1.55;                                   // px/ms，越大越快
const flipMs = (dist) => Math.round(Math.max(FLIP_MS_MIN, Math.min(FLIP_MS_MAX, dist / FLIP_SPEED)));
let flipRAF = 0, flipSeq = 0, flipPending = null;
/* 过渡期进入 #content 的新章节点。落定时只摘掉「其余部分」，不整章重建——
   重建一章要新建上百个 <p> 并重新排版，这笔开销正好落在动画收尾那一帧，就是结尾一卡。 */
let flipKeep = null;

function stopFlip() { cancelAnimationFrame(flipRAF); flipRAF = 0; }

/** 打断进行中的翻章动画：先落定到它的目标，避免 el 里同时留着两章 */
function flushFlip() {
  const f = flipPending;
  flipPending = null;
  stopFlip();
  if (f) f();
}

/** 章节分隔条：过渡期插在两章之间，让「换章」有可见标记；落定时随 innerHTML 一并清掉 */
function dividerFrag(label) {
  const d = document.createElement("div");
  d.className = "ch-divider";
  d.textContent = label;
  return d;
}

/** 章节文本 → <p> 片段 */
function chapterFrag(text) {
  const frag = document.createDocumentFragment();
  for (const line of String(text || "").split("\n").map((l) => l.trim()).filter((l) => l.length)) {
    const p = document.createElement("p");
    p.textContent = line;
    frag.appendChild(p);
  }
  return frag;
}

/** 缓动滚动 scrollTop；结束（或被新动画打断前的最后一次）执行 done。曲线见 FLIP_EASE。 */
function easeScrollTop(el, to, ms, done) {
  stopFlip();
  const from = el.scrollTop, dist = to - from, t0 = performance.now();
  let tPrev = t0;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    let next = from + dist * FLIP_EASE(k);
    const dt = now - tPrev;
    tPrev = now;
    if (dt > 34 && Math.abs(dist) > 1) {
      // 偶发掉帧：按时间算出的落点会一步跨很远，比匀速更「抖」。
      // 把这一帧压在约 3 帧当量内，掉帧只表现为略微变慢，而不是一跳。
      const cap = Math.max(2, Math.abs(dist / ms) * 50);
      next = el.scrollTop + Math.sign(dist) * Math.min(Math.abs(next - el.scrollTop), cap);
    }
    el.scrollTop = next;
    if (k < 1) flipRAF = requestAnimationFrame(step);
    else { el.scrollTop = to; flipRAF = 0; if (done) done(); }
  };
  flipRAF = requestAnimationFrame(step);
}

/* ---------------- 章节正文缓存（预取相邻章，翻章不再等网络） ---------------- */

const chapterCache = new Map();

/**
 * 预取窗口：读到第 N 章时，后台预取 N-1、N+1（上下各 1 章，共 3 章）。
 *
 * 为什么前后都要：用户既可能往后翻，也可能点「上一章」回看。
 * 为什么是 1：速读谷² 这类源一章要串行抓 4 个分页（约 1.4s），
 * 且站点对请求量极敏感 —— 实测前后各 2 章（5 章/本）连续预热就会被封 IP。
 * 收到「上下各一章」后请求量降到 3 章/本，是能在「预取有效」和「不触发风控」
 * 之间取得平衡的最小窗口。
 * 为什么串行：速读谷² 对并发请求敏感（实测并发会被封 IP），只能逐章来。
 */
const PREFETCH_RADIUS = 1;
// 章节请求序号：慢请求晚返回时，只允许“最后一次用户选择的章节”落进 UI / 进度。
let chapterRunSeq = 0;
// 本地 txt 的目录 JSON 也按文件版本缓存。切回已打开的书时不再重复解析/传输整份目录。
// key 带 mtime/size，文件或净化/TXT 目录规则变化后不会错误复用旧目录。
const localBookDataCache = new Map();
let localOpenSeq = 0;
const chapterKey = (rel, idx) => state.shelfIndex + "|" + rel + "|" + idx;

function localBookDataKey(b) {
  return state.shelfIndex + "|" + String(b && b.rel || "") + "|"
    + String(b && b.mtime || 0) + "|" + String(b && b.size || 0);
}

function chapterUrl(rel, idx) {
  return `/api/chapter?shelf=${state.shelfIndex}&rel=${encodeURIComponent(rel)}&idx=${idx}`;
}

function fetchChapter(rel, idx) {
  const k = chapterKey(rel, idx);
  const hit = chapterCache.get(k);
  if (hit) return hit;
  if (chapterCache.size > 60) {
    // 只留最近用的一小批，避免长读时无限增长
    const keep = [...chapterCache.keys()].slice(-30);
    for (const kk of [...chapterCache.keys()]) if (!keep.includes(kk)) chapterCache.delete(kk);
  }
  const p = api(chapterUrl(rel, idx)).catch(() => null);
  chapterCache.set(k, p);
  return p;
}

function prefetchNeighbors(idx) {
  const b = state.book;
  if (!b) return;
  const total = b.chapterCount;
  // 预取窗口：当前章前后各 PREFETCH_RADIUS 章（R=1 时共 3 章）。
  // 顺序：先往后（用户大概率往后翻），再往前；每一侧由近到远，且**串行**执行。
  //   · 速读谷² 一章分 4 页、站点对并发敏感（实测并发会被封 IP），串行是唯一安全方式；
  //   · 串行也保证「最近的一章最先就绪」，用户翻一页时优先命中。
  const order = [];
  for (let step = 1; step <= PREFETCH_RADIUS; step++) {
    const after = idx + step;
    if (after < total) order.push(after);
  }
  for (let step = 1; step <= PREFETCH_RADIUS; step++) {
    const before = idx - step;
    if (before >= 0) order.push(before);
  }
  const run = async () => {
    for (const i of order) {
      if (chapterCache.has(chapterKey(b.rel, i))) continue;   // 已缓存/在飞都跳过
      try { await fetchChapter(b.rel, i); } catch (e) { break; }   // 失败就停，别把错误连成串
      // 用户已经翻走时立刻放弃剩余预取，避免做无用请求
      if (state.book !== b || state.chapterIdx !== idx) return;
    }
  };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 60);
}

/* ---------------- 打开书 ---------------- */

async function openBook(b, opts = {}) {
  flushFlip();                       // 上一本的翻章动画若还在滑，先落定，别把两本书的段落拼在一起
  const seq = ++localOpenSeq;
  const same = state.book && state.book.rel === b.rel
    && state.book.shelfIndex === state.shelfIndex;
  const previous = same && opts.keepChapter !== false ? state.chapterIdx : null;
  if (state.book && !same) saveProgress();
  // chapterKey 已按书架和路径隔离，切书不应清掉其它书的已抓章节。
  // 目录同样复用；规则变更时由 online.js 的 invalidate* 显式清空并传 noCache。
  const dataKey = localBookDataKey(b);
  let data = opts.noCache ? null : localBookDataCache.get(dataKey);
  if (!data) {
    data = await api(`/api/book?shelf=${state.shelfIndex}&rel=${encodeURIComponent(b.rel)}`);
    localBookDataCache.set(dataKey, data);
  }
  if (seq !== localOpenSeq) return;
  state.book = { rel: b.rel, shelfIndex: state.shelfIndex, name: b.name, ...data };
  state.book.chapterCount = data.chapterCount;
  $("bookTitle").textContent = data.title + (data.author ? "  ·  " + data.author : "");
  $("bookTitle").title = data.title;
  $("bookMeta").textContent = `${data.chapterCount} 章 · ${(data.size / 1024 / 1024).toFixed(2)}MB · ${data.encoding}`;
  $("tocCount").textContent = data.chapters.length + " 项";
  state.lastBookRel = b.rel;
  try { localStorage.setItem("lastBookRel", b.rel); localStorage.setItem("lastShelf", String(state.shelfIndex)); } catch {}
  renderToc();
  renderBooks();
  updateBookNav();
  if (data.chapterCount === 0 && !data.chapters.length) {
    $("content").innerHTML = '<div class="empty-hint">这本书没解析到章节，可能不是标准 txt</div>';
    return;
  }
  const pr = state.progress[b.rel];
  const idx = previous !== null ? previous : (pr ? pr.chapter : 0);
  await gotoChapter(Math.min(idx, Math.max(0, data.chapterCount - 1)), pr && previous === null ? pr.scroll : 0);
}

async function runChapter(idx, scrollTo = 0, gesture = "direct") {
  if (!state.book) return;
  const book = state.book;
  const total = book.chapterCount;
  idx = Math.max(0, Math.min(idx, total - 1));
  const reqSeq = ++chapterRunSeq;
  flushFlip();                                              // 上次翻章还在滑就先落定，后续判断以真实视觉为准
  const c = await fetchChapter(book.rel, idx);
  // 切书期间旧书的请求可能晚返回；legado 的页面生命周期已结束时不会再回灌旧内容。
  // 状态等正文真正拿到后再切换：网络慢时用户看到、进度条、目录 active 都还停在旧章，
  // 不会出现“界面没反应但内部已经跳到目标章”的错位。
  if (state.book !== book || reqSeq !== chapterRunSeq) return;
  if (!c) return toast("章节加载失败");
  state.chapterIdx = idx;
  const el = $("content");
  const isFlip = chRenderedIdx >= 0 && chRenderedIdx !== idx;
  const dir = idx > chRenderedIdx ? 1 : -1;                 // 后翻：文字向上走；前翻：向下走
  const fromTop = el.scrollTop;
  const vh = el.clientHeight;
  const oldH = el.scrollHeight;
  const cs = getComputedStyle(el);
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  flipKeep = null;
  const seq = ++flipSeq;

  // 旧章节点整体取出（保留节点本体，不改任何样式），供与新章拼成一份连续文本
  const oldFrag = document.createDocumentFragment();
  while (el.firstChild) oldFrag.appendChild(el.firstChild);

  const landTop = () => (scrollTo > 0
    ? (el.scrollHeight - el.clientHeight) * Math.min(1, Math.max(0, scrollTo))
    : 0);

  /** 落定：el 里只留新章一屏，并落到 top（不传则按 scrollTo 推） */
  const settle = (top) => {
    if (seq !== flipSeq) return;
    flipPending = null;
    stopFlip();
    const keep = flipKeep;
    flipKeep = null;
    if (keep && keep.length && keep[0].parentNode === el) {
      const set = new Set(keep);
      for (const n of [...el.childNodes]) if (!set.has(n)) el.removeChild(n);
    } else {
      el.innerHTML = "";
      el.appendChild(chapterFrag(c.text));
    }
    el.scrollTop = top === -1 ? (el.scrollHeight - el.clientHeight) : (top === undefined ? landTop() : top);
    chRenderedIdx = idx;
    if (wheelPin !== null) wheelPin = el.scrollTop;         // 位置变了，别被旧钉点拽回
    requestAnimationFrame(updateEndHint);                    // 别在动画最后一帧里再读 scrollHeight（会强制同步布局）

  };

  /* 只有「滚轮滚到章界」才做连续滚动：旧章与新章拼在同一层里，
     全程只有一份连续文本、没有 transform / 透明度 / 覆盖层，
     所以既不会叠字，也不会因合成层丢次像素抗锯齿而发虚。
     两章之间会插一条「第 xxx 章 …」分隔条并放慢速度：单层连续滚动本身与章内滚动
     毫无区别，不插标记的话翻章根本看不出来。
     点按 / 键盘 / 目录跳转等直接换章（瞬时）。 */
  // 只有滚轮从本章末尾/开头继续滚，才做两章连续拼接过渡。
  // 目录点击、进度条跳章、按钮/键盘翻章都是“直接换章”：
  // 从第 10 章点第 57 章时如果误走这个分支，会先拼上旧章再滚动，远跳看起来又慢又生硬。
  const atBoundary = gesture === "wheel" && (dir > 0 ? scrollTo === 0 : scrollTo > 0);
  let animated = false;
  if (isFlip && atBoundary && !REDUCE_MOTION && vh > 120) {
    const bodyTop = () => el.getBoundingClientRect().top + padT;        // 正文起始线（视口坐标）
    const bodyBottom = () => el.getBoundingClientRect().bottom - padB;  // 正文底线（视口坐标）
    if (dir > 0) {
      /* 后翻：旧章在上，分隔条 + 新章在下。终点 = 新章首行贴住正文起始线，
         与 settle(0) 完全一致（首尾帧零跳变）。用首行实测 rect 反推，分隔条高度、
         段落边距都自动算进去，不用手算。 */
      const nf = chapterFrag(c.text);
      const nfNodes = [...nf.childNodes];
      const firstP = nf.firstChild;
      el.appendChild(oldFrag);
      el.appendChild(dividerFrag(c.title));      // 边界标记：新章从这里开始
      el.appendChild(nf);
      /* 把旧章拼回来这一步会让浏览器重算滚动位置（scroll anchoring），scrollTop
         可能已经不等于 fromTop。先复位再反向测量，否则 to 会偏掉，落定瞬间文字跳一截。 */
      el.scrollTop = fromTop;
      const to = firstP ? fromTop + (firstP.getBoundingClientRect().top - bodyTop()) : oldH - padT - padB;
      const dist = to - fromTop;
      if (dist >= 4 && dist <= vh * 1.6) {
        flipKeep = nfNodes;
        animated = true;
        flipPending = () => settle(0);
        easeScrollTop(el, to, flipMs(dist), () => settle(0));
      } else {
        el.innerHTML = "";
      }
    } else {
      /* 前翻：新章在上，分隔条 + 旧章在下。先把 scrollTop 平移 addH 让旧章文字停在原处
         （视觉不动），再向上滑到新章末行贴住正文底线；终点与 settle(-1) 一致。 */
      const nf = chapterFrag(c.text);
      const nfNodes = [...nf.childNodes];
      const lastP = nf.lastChild;
      el.appendChild(nf);
      el.appendChild(dividerFrag(c.title + " · 本章完"));   // 前翻落到新章末尾：标记新章到此结束
      const addH = (el.appendChild(oldFrag), el.scrollHeight - oldH);
      const start = addH + fromTop;
      el.scrollTop = start;
      const to = lastP ? start + (lastP.getBoundingClientRect().bottom - bodyBottom()) : start - vh;
      const dist = to - start;
      if (addH + padT + padB >= vh && to >= 0 && dist <= -4 && dist >= -vh * 1.6) {
        flipKeep = nfNodes;
        animated = true;
        flipPending = () => settle(-1);
        easeScrollTop(el, to, flipMs(-dist), () => settle(-1));
      } else {
        el.innerHTML = "";
      }
    }
  } else {
    el.innerHTML = "";
  }
  if (!animated) settle();
  // 一次滚轮手势内部有空档（实测可达 350ms），锁窗口太短会让尾巴惯性打到已落定的新章上，
  // 把新章多滚一截。动画启动时把锁窗口一次性放宽，配合每次事件的续锁吃掉整段惯性。
  if (animated && wheelPin !== null) {
    const tl = performance.now();
    wheelLock = Math.max(wheelLock, tl + WHEEL_IDLE);
    wheelMax = Math.max(wheelMax, tl + WHEEL_MAX);
  }
  $("chapterHead").innerHTML = '<span class="ch-title"></span><span class="ch-pos"></span>';
  $("chapterHead").querySelector(".ch-title").textContent = c.title;
  $("chapterHead").querySelector(".ch-pos").textContent = `${idx + 1}/${total}`;
  $("chapterHead").classList.add("show");
  $("qnPrev").disabled = idx <= 0;
  $("qnNext").disabled = idx >= total - 1;
  // chapters 里可能含 简介 等 idx:-1 的 pre 项，数组下标 != 章节号，按 idx 查找
  const chs = state.book.chapters || [];
  const findByNo = (n) => chs.find((c) => c.idx === n) || null;
  const prvCh = idx > 0 ? findByNo(idx - 1) : null;
  const nxtCh = idx < total - 1 ? findByNo(idx + 1) : null;
  $("qnPrev").title = prvCh ? "上一章：" + prvCh.title : "已是第一章";
  $("qnNext").title = nxtCh ? "下一章：" + nxtCh.title : "已是最后一章";
  const nameEl = $("qnName");
  if (nameEl) {
    nameEl.textContent = (nxtCh ? "下一章：" + nxtCh.title : "已是最后一章")
      + (prvCh ? "　｜　上一章：" + prvCh.title : "");
  }
  const totalAll = total;
  $("progressFill").style.width = (((idx + 1) / totalAll) * 100).toFixed(2) + "%";
  $("progressText").textContent = `${idx + 1} / ${totalAll} 章 · ${((idx + 1) / totalAll * 100).toFixed(1)}%`;
  markTocActive(idx);
  updateBookNav();
  saveProgress();
  // 翻章 + 渲染完成：若正处惯性锁定，补一小段锁，避免慢加载时惯性尾巴打到新章
  if (wheelPin !== null && wheelPinIdx === idx) wheelLock = Math.max(wheelLock, performance.now() + WHEEL_IDLE);
  prefetchNeighbors(idx);
}

/* 翻章单击节流：最小间隔 100ms，连点合并为最后一次 */
const GATE_MS = 100;
let gateLast = 0, gateTimer = null, gateArgs = null, gateWaiters = [];

function gotoChapter(idx, scrollTo = 0, gesture = "direct") {
  const now = performance.now();
  if (gateTimer === null && now - gateLast >= GATE_MS) {
    gateLast = now;
    return runChapter(idx, scrollTo, gesture);
  }
  gateArgs = [idx, scrollTo, gesture];
  return new Promise((resolve) => {
    gateWaiters.push(resolve);
    if (gateTimer === null) {
      const wait = Math.max(0, GATE_MS - (now - gateLast));
      gateTimer = setTimeout(async () => {
        gateTimer = null;
        gateLast = performance.now();
        const args = gateArgs || [state.chapterIdx, 0, "direct"];
        gateArgs = null;
        const ws = gateWaiters; gateWaiters = [];
        try { await runChapter(args[0], args[1], args[2]); } catch {}
        ws.forEach((w) => w());
      }, wait);
    }
  });
}

let progressTimer = null;
function saveProgress() {
  if (!state.book) return;
  const el = $("content");
  const ratio = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
  // 快照：切书后旧定时器不会把「新书的 rel + 旧章节号」写进去
  const rel = state.book.rel;
  const chapter = state.chapterIdx;
  const total = state.book.chapterCount;
  state.progress[rel] = { chapter, scroll: ratio, total, at: Date.now() };
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    api("/api/progress", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rel, chapter, scroll: ratio })
    }).catch(() => {});
  }, 400);
}

/* ---------------- 目录（虚拟滚动，支持上万章） ---------------- */

function renderToc() {
  const box = $("tocList");
  box.innerHTML = "";
  if (!state.book) return;
  const n = state.book.chapters.length;
  const pad = document.createElement("div");
  const inner = document.createElement("div");
  const itemH = 31;
  state.tocVirtual = { itemH, top: 0, count: n };
  pad.style.position = "relative";
  inner.style.position = "absolute"; inner.style.left = 0; inner.style.right = 0; inner.style.top = 0;
  box.appendChild(pad);
  box.appendChild(inner);
  const view = Math.ceil((box.clientHeight || 400) / itemH) + 6;
  function paint() {
    const boxH = box.clientHeight || 400;
    const start = Math.max(0, Math.floor(box.scrollTop / itemH) - 3);
    const end = Math.min(n, start + Math.ceil(boxH / itemH) + 6);
    pad.style.height = n * itemH + "px";
    inner.style.top = start * itemH + "px";
    inner.innerHTML = "";
    for (let i = start; i < end; i++) {
      const c = state.book.chapters[state.tocDesc ? n - 1 - i : i];
      const el = document.createElement("div");
      el.className = "toc-item" + (c.idx === state.chapterIdx ? " active" : "");
      el.textContent = c.title;
      el.dataset.idx = c.idx;
      el.onclick = () => gotoChapter(c.idx);
      inner.appendChild(el);
    }
  }
  box.onscroll = paint;
  paint();
  state.tocPaint = paint;
  window.__tocPaint = paint;
}

function markTocActive(idx, force = false) {
  const box = $("tocList");
  const inner = box.lastElementChild;
  if (inner) {
    inner.querySelectorAll(".toc-item.active").forEach((e) => e.classList.remove("active"));
    const el = inner.querySelector(`.toc-item[data-idx="${idx}"]`);
    if (el) el.classList.add("active");
  }
  // 若目标项不在可视区，滚动到中间
  const itemH = state.tocVirtual.itemH;
  const boxH = box.clientHeight || 400;
  const chs = state.book.chapters || [];
  const pos = chs.findIndex((c) => c.idx === idx);
  const row = pos >= 0 ? pos : 0;
  const viewRow = state.tocDesc ? chs.length - 1 - row : row;
  const wantTop = viewRow * itemH - boxH / 2 + itemH / 2;
  if (force || Math.abs(box.scrollTop - wantTop) > boxH) { box.scrollTop = Math.max(0, wantTop); if (window.__tocPaint) window.__tocPaint(); }
}

/* ---------------- 目录顺序（正序 / 倒序） ---------------- */

function syncTocOrderBtn() {
  const b = $("tocOrder");
  if (!b) return;
  b.textContent = state.tocDesc ? "倒序" : "正序";
  b.classList.toggle("on", !!state.tocDesc);
  b.title = state.tocDesc ? "目录当前为倒序（最后一章在最上），点击切回正序" : "目录当前为正序，点击切换为倒序";
}

function toggleTocOrder() {
  state.tocDesc = !state.tocDesc;
  try { localStorage.setItem("tocDesc", state.tocDesc ? "1" : "0"); } catch {}
  syncTocOrderBtn();
  if (state.book) {
    // 只把目录列表顺序反过来：滚动位置原地不动，不重新定位到当前章
    const box = $("tocList");
    const keepTop = box.scrollTop;
    renderToc();
    box.scrollTop = keepTop;
    if (window.__tocPaint) window.__tocPaint();
  }
  toast(state.tocDesc ? "目录已倒序" : "目录已正序");
}

/* ---------------- 事件 ---------------- */

$("shelfSelect").onchange = (e) => selectShelf(Number(e.target.value));
$("bkPrev").onclick = () => { if (state.bookPage > 1) { state.bookPage--; renderBooks(); } };
$("bkNext").onclick = () => { state.bookPage++; renderBooks(); };
$("bookFilter").oninput = (e) => { state.filter = e.target.value; state.bookPage = 1; renderBooks(); };
$("bookSort").onchange = (e) => { state.sort = e.target.value; state.bookPage = 1; renderBooks(); };
$("qnPrev").onclick = () => gotoChapter(state.chapterIdx - 1);
$("qnNext").onclick = () => gotoChapter(state.chapterIdx + 1);
/**
 * 顶栏导航：翻章（不是翻书）。
 *
 * 为什么改语义：底部「上一章 / 下一章」（#qnPrev / #qnNext）已经是高频操作，
 * 而顶栏这两个按钮原来翻的是「整本书」（stepBook），两处语义不一致很容易误点。
 * 现在统一成翻章；翻整本仍可用底部保留的「上一本 / 下一本」入口。
 *
 * 没有打开书时退回原来的翻书行为（保持「先选一本开始读」的可用性）。
 */
$("btnPrevBook").onclick = () => {
  if (state.book && (Number(state.book.chapterCount) || 0) > 0) return gotoChapter(state.chapterIdx - 1);
  stepBook(-1);
};
$("btnNextBook").onclick = () => {
  if (state.book && (Number(state.book.chapterCount) || 0) > 0) return gotoChapter(state.chapterIdx + 1);
  stepBook(1);
};
$("btnPrev").onclick = () => stepBook(-1);
$("btnNext").onclick = () => stepBook(1);
$("btnTop").onclick = () => { $("content").scrollTop = 0; };
$("endHint").onclick = () => {
  const total = state.book ? state.book.chapterCount : 0;
  if (!total || state.chapterIdx >= total - 1) return toast("已是最后一章");
  $("endHint").classList.remove("show");
  gotoChapter(state.chapterIdx + 1);
};
$("tocOrder").onclick = toggleTocOrder;
$("tocTop").onclick = () => {
  const box = $("tocList");
  box.scrollTop = 0;
  if (window.__tocPaint) window.__tocPaint();
};
document.querySelector(".progress-bar").onclick = (e) => {
  if (!state.book) return;
  const total = state.book.chapterCount;
  if (!total) return;
  const r = e.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  gotoChapter(Math.min(total - 1, Math.round(ratio * total)));
};
/* 到底提示：快滚到本章末尾时，底部给一行「继续下滚 → 下一章」，让翻页有预告 */
function updateEndHint() {
  const el = $("content"), tip = $("endHint");
  if (!el || !tip) return;
  const scrollable = el.scrollHeight > el.clientHeight + 4;
  const last = state.book ? state.chapterIdx >= state.book.chapterCount - 1 : true;
  const atEnd = scrollable && !last && el.scrollHeight - el.clientHeight - el.scrollTop < 80;
  tip.classList.toggle("show", atEnd);   // 可点按钮：与「自动下一章」开关无关，关掉了也能手动点
}

$("content").onscroll = () => {
  clearTimeout(window.__sc); window.__sc = setTimeout(saveProgress, 300);
  updateEndHint();
};

/* 读到本章末尾继续下滚 -> 下一章；滚到本章开头继续上滚 -> 上一章（落到该章末尾）
   惯性：一次滚轮手势会连发多个 wheel 事件，翻章后剩余惯性会把新章滚过头。
   做法 = 翻章后进入「钉住」锁定期：期间一律 preventDefault，并把 scrollTop 钉在目标位置
   （下一章钉顶部 / 上一章钉末尾）。惯性事件持续到来则延锁，最多 1.2s，惯性停下约 160ms 后自动解锁。 */
let wheelLock = 0, wheelMax = 0, wheelPin = null, wheelPinIdx = null, wheelPinRAF = 0;
/* 一次滚轮手势内，相邻 wheel 事件之间会有空档：实测一次约 500ms 的手势里存在 350ms 的间隔。
   窗口若按「事件间隔 + 少量余量」来算，空档期间锁会过期，剩下的惯性就打到新章上把它滚走。
   所以 idle 要明显大于空档，max 给出总时长上限（超时后自动解锁，不影响下一次翻章）。 */
const WHEEL_IDLE = 420, WHEEL_MAX = 1400;

/** 平滑滚到指定位置（ease-out），收尾比线性更稳 */
function snapScroll(el, to, ms = 100) {
  cancelAnimationFrame(el.__snapRAF);
  const from = el.scrollTop, t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.scrollTop = from + (to - from) * (1 - Math.pow(1 - k, 3));
    if (k < 1) el.__snapRAF = requestAnimationFrame(step);
  };
  el.__snapRAF = requestAnimationFrame(step);
}
let chRenderedIdx = -1;   // runChapter 渲染完成后写入，用于避免新章出来前钉旧章

function pinScroll() {
  if (wheelPin === null) return;
  const el = $("content");
  if (wheelPinIdx !== null && (state.chapterIdx !== wheelPinIdx || chRenderedIdx !== wheelPinIdx)) return;  // 新章没渲染出来前别钉
  const top = wheelPin < 0 ? Math.max(0, el.scrollHeight - el.clientHeight) : wheelPin;
  if (Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top;
}
function pinTick() {
  pinScroll();
  const now = performance.now();
  if (wheelPin === null || now >= wheelLock || now >= wheelMax) { wheelPin = null; wheelPinIdx = null; return; }
  wheelPinRAF = requestAnimationFrame(pinTick);
}
function startWheelLock(pin, targetIdx = state.chapterIdx, idle = WHEEL_IDLE, max = WHEEL_MAX) {
  const now = performance.now();
  wheelLock = now + idle;
  wheelMax = now + max;
  wheelPin = pin;
  wheelPinIdx = targetIdx;
  cancelAnimationFrame(wheelPinRAF);
  wheelPinRAF = requestAnimationFrame(pinTick);
}

$("content").addEventListener("wheel", (e) => {
  if (!state.book || !e.deltaY) return;
  if (state.settings.autoNext === false) return;
  const el = e.currentTarget;
  const now = performance.now();
  if (now < wheelLock && wheelPin !== null) {      // 锁定期：吃掉惯性事件，保持落点
    wheelLock = Math.min(wheelMax, now + WHEEL_IDLE);
    e.preventDefault();
    return pinScroll();
  }
  const short = el.scrollHeight <= el.clientHeight + 4;   // 正文不足一屏，无法靠滚动判断首尾
  if (e.deltaY > 0) {
    if (!short && el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
      // 只差最后一点点：先平滑吸到底，本滚不翻章（否则最后一句会被整章替换切掉，显得突兀）
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (gap > 2 && gap <= 40) {
        e.preventDefault();
        snapScroll(el, el.scrollHeight - el.clientHeight);
      }
      return;
    }
    e.preventDefault();
    if (state.chapterIdx >= state.book.chapterCount - 1) { startWheelLock(el.scrollTop, state.chapterIdx, WHEEL_IDLE, 600); return toast("已是最后一章"); }
    startWheelLock(0, state.chapterIdx + 1);                // 下一章从头看 -> 钉在顶部
    return gotoChapter(state.chapterIdx + 1, 0, "wheel");
  }
  // 只差开头一点点：先平滑吸到顶，本滚不翻章（与到底的吸底对称）
  if (!short && el.scrollTop > 0 && el.scrollTop <= 40) {
    e.preventDefault();
    snapScroll(el, 0);
    return;
  }
  if (!short && el.scrollTop > 2) return;
  e.preventDefault();
  if (state.chapterIdx <= 0) { startWheelLock(el.scrollTop, state.chapterIdx, WHEEL_IDLE, 600); return toast("已是第一章"); }
  startWheelLock(-1, state.chapterIdx - 1);                // 上一章落到末尾 -> 钉在底部
  gotoChapter(state.chapterIdx - 1, 1, "wheel");
}, { passive: false });

/* 点击正文：两侧翻章、中部切换沉浸；但有选区 / 拖动过 / 点在选区内 -> 一律让位给「选择」 */
let downX = 0, downY = 0, downInSel = false, downHadSel = false;

function hasTextSelection() {
  const sel = window.getSelection();
  return !!(sel && sel.rangeCount && sel.toString().trim().length);
}
function pointInSelection(x, y) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.toString().trim()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i).getBoundingClientRect();
    if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
  }
  return false;
}

$("content").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  downX = e.clientX; downY = e.clientY;
  downInSel = pointInSelection(e.clientX, e.clientY);
  downHadSel = hasTextSelection();   // mousedown 的默认行为会清掉选区，先记下来
});

$("content").onclick = (e) => {
  if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;  // 拖动过，多半在划选
  if (downInSel || downHadSel || hasTextSelection()) return;                       // 已有/刚有选区，交给选择
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  if (x < 0.25) return gotoChapter(state.chapterIdx - 1);
  if (x > 0.75) return gotoChapter(state.chapterIdx + 1);
  toggleImmersive();
};

/* 沉浸阅读开关（点击正文中部 / 右键菜单共用） */
function toggleImmersive(force) {
  const on = typeof force === "boolean" ? force : !document.body.classList.contains("immersive");
  document.body.classList.toggle("immersive", on);
  document.body.classList.toggle("hide-books", on);
  document.body.classList.toggle("hide-toc", on);
  if (on) hint("沉浸阅读：再点正文中部退出");
  setTimeout(() => {
    renderBooks(); if (window.__tocPaint) window.__tocPaint();
    updateEndHint();          // 标题栏高度变了，顶部按钮要重新让位
  }, 260);
  return on;
}

/* ---------------- 右键菜单（限定为阅读常用项） ---------------- */

const ctx = document.createElement("div");
ctx.id = "ctxMenu";
ctx.className = "ctx-menu hidden";
document.body.appendChild(ctx);

let ctxRanges = [];        // 右键瞬间浏览器可能清掉选区，先存下来以便还原

function selText() {
  const sel = window.getSelection();
  return sel ? sel.toString() : "";
}
function snapshotSelection() {
  const sel = window.getSelection();
  ctxRanges = sel && sel.rangeCount && sel.toString().trim()
    ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange())
    : [];
}
function restoreSelection() {
  if (selText().trim() || !ctxRanges.length) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  ctxRanges.forEach((r) => sel.addRange(r));
}

function hideCtx() { ctx.classList.add("hidden"); }

function selectAllContent() {
  const r = document.createRange();
  r.selectNodeContents($("content"));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

async function copyText(t) {
  if (!t || !t.trim()) return toast("没有可复制的内容");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); }
    else throw new Error("no clipboard api");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
  toast("已复制 " + t.trim().length + " 字");
}

function showCtx(x, y, items) {
  ctx.innerHTML = "";
  for (const it of items) {
    if (it === "-") { const d = document.createElement("div"); d.className = "ctx-sep"; ctx.appendChild(d); continue; }
    const b = document.createElement("button");
    b.className = "ctx-item" + (it.disabled ? " disabled" : "") + (it.info ? " info" : "");
    b.append(it.label);
    if (it.hint) {
      const sp = document.createElement("span");
      sp.className = "ctx-hint";
      sp.textContent = it.hint;
      b.appendChild(sp);
    }
    if (!it.disabled) b.onclick = (ev) => { ev.stopPropagation(); hideCtx(); it.act(); };
    ctx.appendChild(b);
  }
  ctx.classList.remove("hidden");
  const r = ctx.getBoundingClientRect();
  const pad = 8;
  ctx.style.left = Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)) + "px";
  ctx.style.top = Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)) + "px";
}

function chapterItems() {
  const total = state.book ? state.book.chapterCount : 0;
  const i = state.chapterIdx;
  return [
    { label: "上一章", hint: i > 0 ? "第 " + i + " 章" : "", disabled: i <= 0, act: () => gotoChapter(i - 1) },
    { label: "下一章", hint: i < total - 1 ? "第 " + (i + 2) + " 章" : "", disabled: i >= total - 1, act: () => gotoChapter(i + 1) }
  ];
}
function bookItems() {
  const list = currentOrder();
  const i = state.book ? list.findIndex((b) => b.rel === state.book.rel) : -1;
  const onlyOne = list.length <= 1;
  return [
    { label: "上一本", disabled: onlyOne || i <= 0, act: () => stepBook(-1) },
    { label: "下一本", disabled: onlyOne || i === list.length - 1, act: () => stepBook(1) }
  ];
}

document.addEventListener("mousedown", (e) => {
  if (e.target && e.target.closest && e.target.closest("#ctxMenu")) return;   // 点在菜单里，交给菜单自己处理
  if (e.button !== 2) { hideCtx(); return; }
  snapshotSelection();
}, true);
document.addEventListener("wheel", hideCtx, { passive: true });
window.addEventListener("blur", hideCtx);
window.addEventListener("resize", hideCtx);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtx(); });

/* 正文右键 */
$("content").addEventListener("contextmenu", (e) => {
  if (!state.book) return;
  e.preventDefault();
  restoreSelection();
  const sel = selText();
  const n = sel.trim().length;
  showCtx(e.clientX, e.clientY, [
    { label: "复制", hint: n ? n + " 字" : "", disabled: !n, act: () => copyText(sel) },
    // 需求：右键「刷新」取代原「复制本章」（在线模式才刷新正文；本地模式保留复制本章）
    state.mode === "online"
      ? { label: "刷新", hint: "重新抓本章", act: () => { if (typeof refreshCurrentChapter === "function") refreshCurrentChapter(); } }
      : { label: "复制本章", act: () => copyText($("content").innerText) },
    { label: "全选本章", act: selectAllContent },
    "-",
    ...chapterItems(),
    ...bookItems(),
    "-",
    // 需求：换源入口放到「回到本章开头」上面（仅在线书）
    ...(state.mode === "online" ? [{
      label: "换源",
      hint: "换到其它书源",
      act: () => {
        if (typeof openChangeSource !== "function") return toast("换源不可用");
        const rel = state.book && state.book.rel;
        const cur = (typeof findOnlineByRel === "function" && rel ? findOnlineByRel(rel) : null) || state.book;
        openChangeSource(cur);
      }
    }] : []),
    { label: "回到本章开头", act: () => { $("content").scrollTop = 0; } },
    {
      label: document.body.classList.contains("immersive") ? "退出沉浸阅读" : "沉浸阅读",
      act: () => toggleImmersive()
    },
    { label: "阅读设置", act: () => { syncSettingsUI(); renderFontPicker(); $("modalSettings").classList.remove("hidden"); } }
  ]);
});

function hint(msg) {
  const el = $("immersiveHint");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(window.__hintT);
  window.__hintT = setTimeout(() => el.classList.remove("show"), 2000);
}

$("btnShelf").onclick = () => document.body.classList.toggle("hide-books");
$("btnToc").onclick = () => document.body.classList.toggle("hide-toc");
$("btnChapterCollapse").onclick = () => {
  const both = document.body.classList.contains("hide-books") && document.body.classList.contains("hide-toc");
  document.body.classList.toggle("hide-books", !both);
  document.body.classList.toggle("hide-toc", !both);
  setTimeout(renderBooks, 220);
};

$("btnTheme").onclick = () => {
  const i = THEMES.findIndex((t) => t[0] === state.settings.theme);
  state.settings.theme = THEMES[(i + 1) % THEMES.length][0];
  applySettings(); saveSettings();
};

/* 设置面板 */
$("btnSettings").onclick = () => { syncSettingsUI(); renderFontPicker(); $("modalSettings").classList.remove("hidden"); };
/* 关闭设置面板时必须顺带收起字体菜单 —— 菜单挂在 body 下，
   不跟着面板走，否则面板关了菜单还浮在屏幕上。 */
$("setClose").onclick = () => { closeFontPicker(); $("modalSettings").classList.add("hidden"); };
$("modalSettings").onclick = (e) => {
  if (e.target.id === "modalSettings") { closeFontPicker(); $("modalSettings").classList.add("hidden"); }
};

const bindRange = (id, key, out, fmt) => {
  $(id).oninput = (e) => {
    state.settings[key] = Number(e.target.value);
    $(out).textContent = fmt ? fmt(state.settings[key]) : state.settings[key];
    applySettings();
  };
  $(id).onchange = () => saveSettings();
};
bindRange("setFontSize", "fontSize", "vFontSize");
bindRange("setLineHeight", "lineHeight", "vLineHeight", (v) => Number(v).toFixed(2));
bindRange("setIndent", "indent", "vIndent", (v) => v + "em");
bindRange("setLetter", "letterSpacing", "vLetter");
bindRange("setMaxWidth", "maxWidth", "vMaxWidth");

/**
 * 自动下一章开关（顶栏按钮 #btnAutoNext 的唯一入口）。
 *
 * 状态源是 state.settings.autoNext；顶栏按钮用 .on 类表示开启。
 * 设置面板里已无同名复选框（唯一入口就是这个顶栏按钮），故不再保留兼容分支。
 */
function setAutoNext(on) {
  const v = on !== false;
  state.settings.autoNext = v;
  const btn = $("btnAutoNext");
  if (btn) {
    btn.classList.toggle("on", v);
    btn.title = v ? "自动下一章：已开启（滚到章末自动翻）" : "自动下一章：已关闭（只能手动翻）";
  }
  saveSettings();
}

$("btnAutoNext").onclick = () => setAutoNext(state.settings.autoNext === false);

/* 书源并发数：拖动时只更新显示，松手（change）才真正热改 worker 池，
   避免拖动过程中反复建 / 拆 worker。 */
const poolEl = $("setPoolSize");
if (poolEl) {
  poolEl.oninput = (e) => { $("vPoolSize").textContent = e.target.value; };
  poolEl.onchange = async (e) => {
    const n = Number(e.target.value) || 4;
    $("vPoolSize").textContent = n;
    try {
      const r = await api("/api/online/pool", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ size: n }),
      });
      const applied = Number(r.size) || n;
      state.settings.sourcePoolSize = applied;
      $("setPoolSize").value = applied;
      $("vPoolSize").textContent = applied;
      toast("书源并发数已设为 " + applied + "（立即生效）");
    } catch (err) {
      toast("设置失败：" + (err && err.message ? err.message : err));
      syncPoolSizeUI();
    }
  };
}
/* 字体选择器：点按钮展开/收起；点外面或按 Esc 收起。
   具体选项的点击/删除逻辑在 fontPickerItem() 里绑定。 */
$("fontPickerBtn").onclick = (e) => { e.stopPropagation(); toggleFontPicker(); };
document.addEventListener("click", (e) => {
  const picker = $("fontPicker");
  const menu = $("fontPickerMenu");
  // 菜单挂在 body 下（不是 #fontPicker 的子节点），必须单独判断，
  // 否则点菜单里的任何一项都会被这里当成「点外面」而先关掉菜单。
  const inside = (picker && picker.contains(e.target)) || (menu && menu.contains(e.target));
  if (!inside) closeFontPicker();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFontPicker(); });

$("btnAddFont").onclick = () => $("fontFile").click();
$("fontFile").onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) return toast("字体文件太大（>80MB）");
  toast("正在导入 " + file.name + " …");
  try {
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] || "");
      fr.onerror = () => rej(new Error("读取失败"));
      fr.readAsDataURL(file);
    });
    const r = await api("/api/fonts/upload", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, data: b64 })
    });
    state.fonts = r.fonts || [];
    loadCustomFonts();
    const last = state.fonts[state.fonts.length - 1];
    if (last) {
      state.settings.fontFamily = CUSTOM_PREFIX + last.id;
      applySettings(); saveSettings();
    }
    renderFontPicker(); syncSettingsUI();
    openFontPicker();     // 导入后自动展开，让用户立刻看到新字体并已选中
    toast("已添加字体：" + (last ? last.name : file.name));
  } catch (err) { toast("导入失败：" + err.message); }
};

$("setReset").onclick = () => {
  Object.assign(state.settings, { theme: "light", fontSize: 19, lineHeight: 1.9, indent: 2, letterSpacing: 0, maxWidth: 820, fontFamily: "serif" });
  applySettings(); syncSettingsUI(); saveSettings();
};

/* 键盘 */
document.addEventListener("keydown", (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); return stepBook(-1); }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); return stepBook(1); }
  if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); gotoChapter(state.chapterIdx - 1); }
  else if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); gotoChapter(state.chapterIdx + 1); }
  else if (e.key === "Home") { e.preventDefault(); $("content").scrollTop = 0; }
  else if (e.key === "End") { e.preventDefault(); $("content").scrollTop = $("content").scrollHeight; }
});

window.addEventListener("resize", () => { renderBooks(); if (window.__tocPaint) window.__tocPaint(); updateEndHint(); });

/* ---------------- 管理书架 ---------------- */

const SHELF_ARM_MS = 4000;
let shelfArmTimer = null;

function neutralReaderView() {
  state.book = null;
  state.chapterIdx = 0;
  $("bookTitle").textContent = "未选择书籍";
  $("bookMeta").textContent = "";
  $("chapterHead").innerHTML = "";
  $("chapterHead").classList.remove("show");
  $("content").innerHTML = '<div class="empty-hint">从左侧书架选一本书开始阅读</div>';
  $("tocList").innerHTML = "";
  $("tocCount").textContent = "";
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "—";
  try { localStorage.removeItem("lastBookRel"); } catch {}
}

function renderShelfManager() {
  const box = $("shelfList");
  if (!box) return;
  box.innerHTML = "";
  if (!state.shelves.length) {
    box.innerHTML = '<div class="empty-hint" style="padding:22px 6px;font-size:13px">还没有导入任何文件夹</div>';
    return;
  }
  state.shelves.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "shelf-row";

    const info = document.createElement("div");
    info.className = "shelf-info";
    const nm = document.createElement("div");
    nm.className = "shelf-name";
    nm.textContent = s.name + (i === state.shelfIndex ? "（当前）" : "");
    const sub = document.createElement("div");
    sub.className = "shelf-sub";
    sub.textContent = s.path + "  ·  " + (s.count ?? 0) + " 本";
    sub.title = s.path;
    info.appendChild(nm);
    info.appendChild(sub);

    const del = document.createElement("button");
    del.className = "ghost-btn shelf-del";
    del.textContent = "移除";
    del.onclick = () => {
      if (del.dataset.armed === "1") { clearTimeout(shelfArmTimer); removeShelf(i, del); return; }
      // 两段式确认：第一次点击进入待确认，4 秒后自动复位
      box.querySelectorAll(".shelf-del.arm").forEach((b) => { b.classList.remove("arm"); b.dataset.armed = "0"; b.textContent = "移除"; });
      del.classList.add("arm");
      del.dataset.armed = "1";
      del.textContent = "确认移除";
      clearTimeout(shelfArmTimer);
      shelfArmTimer = setTimeout(() => {
        if (!del.isConnected) return;
        del.classList.remove("arm"); del.dataset.armed = "0"; del.textContent = "移除";
      }, SHELF_ARM_MS);
    };

    row.appendChild(info);
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function removeShelf(index, btn) {
  const s = state.shelves[index];
  if (!s) return;
  if (btn) { btn.disabled = true; btn.textContent = "移除中…"; }
  let r;
  try {
    r = await api("/api/shelves/remove", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ index })
    });
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "移除"; }
    return toast("移除失败：" + e.message);
  }

  const wasCurrent = index === state.shelfIndex;
  state.shelves = r.shelves || [];
  toast("已移除：" + s.name);

  if (!state.shelves.length) {
    shelfLoadSeq++;
    state.shelfIndex = -1;
    state.books = [];
    $("shelfPath").textContent = "";
    neutralReaderView();
    try { localStorage.removeItem("lastShelf"); } catch {}
    renderShelfSelect();
    renderBooks();
    renderShelfManager();
    return;
  }

  let next = state.shelfIndex;
  if (index < state.shelfIndex) next = state.shelfIndex - 1;
  else if (wasCurrent) next = Math.min(index, state.shelves.length - 1);
  if (next < 0 || next >= state.shelves.length) next = 0;
  state.shelfIndex = next;
  try { localStorage.setItem("lastShelf", String(next)); } catch {}

  // 先把弹窗和下拉框刷新掉；删除非当前书架时不需要重扫目录。
  renderShelfManager();
  renderShelfSelect();

  if (!wasCurrent) return;

  // 当前书架被删掉：立即清空阅读区并异步加载下一个书架，
  // 不再让「确认移除」按钮等整轮目录扫描。
  state.books = [];
  neutralReaderView();
  $("bookList").innerHTML = '<div class="empty-hint" style="padding:30px 10px;font-size:13px">正在载入书架…</div>';
  $("bkPageInfo").textContent = "…";
  selectShelf(next).catch((e) => {
    toast("载入书架失败：" + e.message);
    renderBooks();
  });
}

$("btnManageShelves").onclick = () => { renderShelfManager(); $("modalShelves").classList.remove("hidden"); };
$("shelfClose").onclick = () => $("modalShelves").classList.add("hidden");
$("shelfMgrDone").onclick = () => $("modalShelves").classList.add("hidden");
$("modalShelves").onclick = (e) => { if (e.target.id === "modalShelves") $("modalShelves").classList.add("hidden"); };

/* ---------------- 导入文件夹 ---------------- */

function openBrowse(dir) {
  $("modalBrowse").classList.remove("hidden");
  loadBrowse(dir || "");
}
async function loadBrowse(dir) {
  const j = await api("/api/browse" + (dir ? "?dir=" + encodeURIComponent(dir) : ""));
  $("browsePath").value = j.dir || "";
  $("browseUp").disabled = !j.parent;
  $("browseUp").onclick = () => loadBrowse(j.parent);
  const box = $("browseList");
  box.innerHTML = "";
  if (!j.dir) {
    j.dirs.forEach((d) => box.appendChild(row(d, d)));
    $("browseHint").textContent = "选择一个盘符";
  } else {
    if (j.parent) box.appendChild(row("📁 ..", j.parent));
    j.dirs.forEach((d) => box.appendChild(row("📁 " + d.split("\\").pop(), d)));
    j.files.slice(0, 40).forEach((f) => box.appendChild(row("📄 " + f, null)));
    $("browseHint").textContent = `${j.dirs.length} 个子文件夹 · ${j.files.length} 个 txt`;
  }
  $("browsePick").onclick = async () => {
    const target = $("browsePath").value.trim();
    if (!target) return;
    try {
      const r = await api("/api/shelves/add", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: target })
      });
      state.shelves = r.shelves;
      $("modalBrowse").classList.add("hidden");
      const idx = typeof r.index === "number" ? r.index : 0;
      localStorage.setItem("lastShelf", String(idx));
      await selectShelf(idx);
      toast(r.duplicated ? "该文件夹已在书架中" : "已导入书架：" + state.shelves[idx].name);
    } catch (e) { $("browseHint").textContent = "导入失败：" + e.message; }
  };
}
function row(label, dir) {
  const el = document.createElement("div");
  el.className = "browse-row";
  el.textContent = label;
  el.onclick = () => { if (dir) { $("browsePath").value = dir; loadBrowse(dir); } };
  return el;
}
$("btnAddShelf").onclick = () => {
  openBrowse("");                              // 从盘符列表开始浏览
};

$("browseClose").onclick = () => $("modalBrowse").classList.add("hidden");
$("modalBrowse").onclick = (e) => { if (e.target.id === "modalBrowse") $("modalBrowse").classList.add("hidden"); };
$("browseGo").onclick = () => loadBrowse($("browsePath").value.trim());

/* 启动 */
syncTocOrderBtn();
loadState();

