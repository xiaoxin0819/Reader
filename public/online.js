/* online.js —— 在线阅读扩展
 *
 * 设计原则：不改 app.js 一行。
 * app.js 是传统脚本（非 module），顶层 function 声明会挂到 window 上，
 * 所以这里用「包装 + 覆写」的方式接管数据层：
 *   - state.mode = "local" 时一切走原逻辑（本地 txt 全链路不受影响）
 *   - state.mode = "online" 时覆写 openBook / fetchChapter / saveProgress / prefetchNeighbors
 *     以及书架列表来源（/api/online/shelf），把在线书伪装成本地书条目，
 *     于是目录虚拟滚动、翻章动画、进度条、沉浸模式等全部复用。
 *
 * 在线书条目的形状（与本地条目对齐）：
 *   { rel: "origin|bookUrl", name, author, size, mtime, origin, bookUrl, ... }
 */

const MODE_KEY = "readerMode";

/* ---------------- 原函数引用（覆写前先抓住） ---------------- */

const _loadState = loadState;
const _selectShelf = selectShelf;
const _renderShelfSelect = renderShelfSelect;
const _renderBooks = renderBooks;
const _openBook = openBook;
const _fetchChapter = fetchChapter;
const _saveProgress = saveProgress;
const _prefetchNeighbors = prefetchNeighbors;
const _visibleBooks = visibleBooks;
const _neutralReaderView = neutralReaderView;

/* ---------------- 状态 ---------------- */

state.mode = "local";
state.online = {
  books: [],          // 在线书架原始数据
  sources: [],        // 书源摘要
  sourceGroups: [],   // 书源自身的 bookSourceGroup
  sourceGroupDefs: [],      // 独立书源组定义
  activeSourceGroupId: "",  // 当前生效书源组
  activeSourceGroupName: "",
  bookGroups: [],     // 在线书架分组（BookGroup）
  searchResults: [],
  searchKey: "",
  exploreKinds: [],
  exploreSource: "",
  pool: null
};
const onlineProgress = {};   // key -> { chapter, scroll, total, at }
/** 需求 10：下次抓这一章时强制回源（refresh=1），绕过后端 contentCache */
const forceRefresh = new Set();
const shelfManageState = { selected: new Set(), query: "", books: [] };

/* ---------------- 前端目录缓存（切书不再重下几 MB 目录） ----------------
 * 目录 JSON 动辄几 MB：踏星 5592 章 ≈ 4.3MB、我不是戏神 1928 章 ≈ 4.3MB。
 * 后端 cache/toc 的 6h 磁盘缓存省掉的是「重新回站点解析」，但省不掉这两趟 HTTP +
 * 传输 + JSON.parse + 几千次对象映射；切回旧书时这些全白做一遍，看起来就是
 * 「明明缓存过了还要等一会儿」。这里把已解析好的目录按 rel 缓存在前端。
 */
const onlineTocCache = new Map();           // rel -> { at, info, chapters }
const ONLINE_TOC_TTL = 6 * 60 * 60 * 1000;  // 与后端 TOC_TTL 对齐

function onlineTocCacheGet(rel) {
  const hit = onlineTocCache.get(rel);
  if (!hit) return null;
  if (Date.now() - (hit.at || 0) > ONLINE_TOC_TTL) { onlineTocCache.delete(rel); return null; }
  return hit;
}

function onlineTocCachePut(rel, online, chapters) {
  if (!rel || !Array.isArray(chapters) || !chapters.length) return;
  onlineTocCache.set(rel, {
    at: Date.now(),
    info: {
      name: online.name || "", author: online.author || "",
      origin: online.origin, bookUrl: online.bookUrl,
      originName: online.originName || "", coverUrl: online.coverUrl || "",
      intro: online.intro || "", kind: online.kind || "",
    },
    chapters,
  });
  // 每本几 MB，留最近几本够来回切换就行
  if (onlineTocCache.size > 8) {
    const keep = new Set([...onlineTocCache.keys()].slice(-4));
    for (const k of [...onlineTocCache.keys()]) if (!keep.has(k)) onlineTocCache.delete(k);
  }
}

function onlineTocCacheDrop(rel) { onlineTocCache.delete(rel); }


const okey = (origin, bookUrl) => String(origin || "") + "|" + String(bookUrl || "");

/** 在线书架条目 → 本地条目形状 */
function toLocalShape(b, pr) {
  const k = okey(b.origin, b.bookUrl);
  const p = pr || onlineProgress[k];
  return {
    rel: k, name: b.name || "(无书名)", author: b.author || "",
    size: 0, mtime: b.addedAt || 0,
    origin: b.origin, bookUrl: b.bookUrl, originName: b.originName,
    coverUrl: b.coverUrl, kind: b.kind, intro: b.intro,
    durChapterTitle: b.durChapterTitle || "",
    // legado item_bookshelf_list.xml 的 tv_last：「最新」那一行 = Book.latestChapterTitle，
    // 没有它书架只显示「读到」，最后一行永远是空的。
    latestChapterTitle: b.latestChapterTitle || "",
    totalChapterNum: b.totalChapterNum || 0,
    // Book.kt:89 —— 「最近一次检查目录新增了几章」，0 表示没有新章。
    // BooksAdapterList.kt:113 setHighlight(item.lastCheckCount > 0) 用它决定气泡是否高亮。
    lastCheckCount: b.lastCheckCount || 0,
    // 详情页目录点某一章：从详情页带过来的起始章号，openBook 里消费后即失效
    _startIdx: b._startIdx,
    _p: p || null
  };
}

function onlineBooksShaped() {
  return (state.online.books || []).map((b) => toLocalShape(b));
}

function findOnlineByRel(rel) {
  return (state.online.books || []).find((b) => okey(b.origin, b.bookUrl) === rel) || null;
}

/**
 * 按 rel 解析出「能用来抓正文」的书。
 * 优先书架条目；rel 对不上时退回当前正在读的书（它的 origin/bookUrl 是自己拼出来的 rel，
 * 内容接口并不要求书一定在架上）。两者都不匹配才算真的失效。
 */
function resolveOnlineBookByRel(rel) {
  const hit = findOnlineByRel(rel);
  if (hit) return hit;
  const sb = state.book;
  if (sb && sb.origin && sb.bookUrl && okey(sb.origin, sb.bookUrl) === rel) return sb;
  return null;
}

/* ---------------- 模式切换 ---------------- */

function setMode(mode, opts = {}) {
  state.mode = mode === "online" ? "online" : "local";
  try { localStorage.setItem(MODE_KEY, state.mode); } catch {}
  document.body.dataset.mode = state.mode;
  document.querySelectorAll(".mode-switch button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === state.mode);
  });
  document.querySelectorAll(".only-online").forEach((e) => e.classList.toggle("hidden", state.mode !== "online"));
  if (!opts.silent) enterMode();
}

async function enterMode() {
  if (state.mode === "online") {
    state.shelfIndex = -1;
    // 需求：在线书架上方不再显示任何文字（本地模式仍显示书库根路径），
    // 用 .hidden 隐藏整行，顺便去掉 .shelf-path 的 margin-top 空隙。
    const p = $("shelfPath");
    if (p) { p.textContent = ""; p.classList.add("hidden"); }
    renderShelfSelect();
    state.books = onlineBooksShaped();
    state.bookPage = 1;
    renderBooks();
    // 需求：正文在读哪本，左侧书架就显示那一页（不能出现「读着这本、书架停在别的页」）。
    // 切回在线模式时正文可能还是上次那本在线书 —— 立刻把分页校到它所在的位置。
    const cur = state.book && state.book.rel ? findOnlineByRel(state.book.rel) : null;
    if (cur) syncShelfPageToBook(cur);
  } else {
    const pLocal = $("shelfPath");
    if (pLocal) pLocal.classList.remove("hidden");
    // 从在线切回本地：在线书的正文 / 目录 / 章节头 / 进度条会残留在阅读区，
    // 而本地书又没被重新打开，看起来就是「正文没了、左上角显示不对」。
    // 先把阅读区恢复成本地空视图，再按 lastBookRel 恢复上次那本本地书。
    const lastLocalRel = localStorage.getItem("lastBookRel");
    _neutralReaderView();
    if (!state.shelves.length) {
      // 冷启动时本地书架还没加载完（用户可能在加载完成前就切了模式）。
      // 走一遍完整本地初始化，它会按 lastShelf + lastBookRel 恢复书架和正文。
      if (lastLocalRel) { try { localStorage.setItem("lastBookRel", lastLocalRel); } catch {} }
      await _loadState();
      return;
    }
    const i = Number(localStorage.getItem("lastShelf"));
    // 用覆写版 renderShelfSelect：它会摘掉在线模式给「+ 导入文件夹 / 管理」加的 hidden，
    // 否则从在线切回本地时这两个按钮一直不显示，导致本地书架没法导入。
    await _selectShelf(Number.isInteger(i) && i >= 0 && i < state.shelves.length ? i : 0);
    // _neutralReaderView 会把 lastBookRel 清掉，所以上面先取出来；这里恢复原书的正文与进度。
    if (lastLocalRel) {
      const b = (state.books || []).find((x) => x.rel === lastLocalRel);
      if (b) await openBook(b);
    }
  }
}

/* ---------------- 覆写：书架列表 ---------------- */

renderShelfSelect = function () {
  if (state.mode === "online") {
    const sel = $("shelfSelect");
    sel.innerHTML = '<option value="-1">在线书架（' + (state.online.books || []).length + "）</option>";
    sel.value = "-1";
    // 在线模式书架就是一个整体，顶部不需要「未导入书架」下拉框
    sel.classList.add("hidden");
    const btnAdd = $("btnAddShelf"), btnMgr = $("btnManageShelves");
    if (btnAdd) btnAdd.classList.add("hidden");
    if (btnMgr) btnMgr.classList.add("hidden");
    return;
  }
  const sel = $("shelfSelect");
  if (sel) sel.classList.remove("hidden");
  const btnAdd = $("btnAddShelf"), btnMgr = $("btnManageShelves");
  if (btnAdd) btnAdd.classList.remove("hidden");
  if (btnMgr) btnMgr.classList.remove("hidden");
  _renderShelfSelect();
};

selectShelf = async function (i) {
  if (state.mode === "online") {
    state.shelfIndex = -1;
    state.books = onlineBooksShaped();
    state.bookPage = 1;
    renderBooks();
    return;
  }
  return _selectShelf(i);
};

visibleBooks = function () {
  if (state.mode !== "online") return _visibleBooks();
  const kw = state.filter.trim().toLowerCase();
  let list = state.books;
  if (kw) list = list.filter((b) => b.name.toLowerCase().includes(kw)
    || (b.author || "").toLowerCase().includes(kw)
    || (b.originName || "").toLowerCase().includes(kw));
  if (state.sort === "size") list = list.slice().sort((a, b) => a.name.localeCompare(b.name, "zh"));
  else if (state.sort === "mtime") list = list.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (state.sort === "read") list = list.slice().sort((a, b) => ((a._p?.at || 0) > 0 ? 0 : 1) - ((b._p?.at || 0) > 0 ? 0 : 1));
  else list = list.slice().sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return list;
};

renderBooks = function () {
  if (state.mode !== "online") return _renderBooks();
  const box = $("bookList");
  if (!state.online.books.length) {
    box.innerHTML = '<div class="empty-hint" style="padding:30px 10px;font-size:13px">在线书架还空着<br>点右上「🔍 搜索」找书</div>';
    $("bkPageInfo").textContent = "0 / 0";
    updateBookNav();
    return;
  }
  const list = visibleBooks();
  const avail = box.clientHeight || 400;
  // 先按「一页正好 6 本」反推行高，行高小到摆不下封面时才退成更少本数
  let per = BK_PER_PAGE;
  let rowH = Math.floor((avail - 12) / per);
  while (per > 1 && rowH < BK_ROW_MIN) { per--; rowH = Math.floor((avail - 12) / per); }
  if (rowH > BK_ROW_MAX) rowH = BK_ROW_MAX;   // 超大窗口别把封面拉成海报
  box.style.setProperty("--bk-row-h", rowH + "px");
  state.bookPerPage = per;
  const total = Math.max(1, Math.ceil(list.length / per));
  state.bookPage = Math.min(state.bookPage, total);
  const start = (state.bookPage - 1) * per;
  box.innerHTML = "";
  for (const b of list.slice(start, start + per)) {
    el_onlineBook(b, box);
  }
  $("bkPageInfo").textContent = `${state.bookPage} / ${total}  ·  ${list.length} 本`;
  $("bkPrev").disabled = state.bookPage <= 1;
  $("bkNext").disabled = state.bookPage >= total;
  if (state.bookPage !== bkOnRenderedPage) { bkOnRenderedPage = state.bookPage; box.scrollTop = 0; }
  updateBookNav();
};

/**
 * 书架条目行高不再写死常数。legado item_bookshelf_list.xml 是固定 66x90dp 行，
 * 但我们的书架栏高度随浏览器视口变（视口 860 高 → 列表 677px，视口矮一点就只剩 5 条）。
 * 用户要求「一页刚刚好放下 6 本」→ 先定每页 6 本，再反推行高 =(列表高 - 12px 内边距)/6，
 * 用 CSS 变量 --bk-row-h 传给 .book-item.online，封面按同一比例缩放（见 online.css）。
 * 只有视口太矮（行高 < BK_ROW_MIN，封面会被裁）才退成 5 本。
 */
/* 上一次渲染进 #bookList 的页码：翻页时才回顶，同页重绘（加书架/删除）不动位置 */
let bkOnRenderedPage = 0;

const BK_PER_PAGE = 6;
/* 行高下限：再矮封面就糊了。76px 行高 = 56x76 封面 + 11px 书名，
   对应视口约 651px —— 比这更矮的窗口才退成 5 本（普通浏览器窗口都到不了）。 */
const BK_ROW_MIN = 76;
/* 行高上限：超宽超高窗口下也不把封面拉成海报（160 = 106x140 封面）。 */
const BK_ROW_MAX = 160;

/* legado 书架行用的是 Material 图标（ic_author / iv_read / iv_last），这里内联 SVG 等价物 */
const BK_ICON = {
  author: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z"/></svg>',
  read: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M6 2h12a2 2 0 0 1 2 2v18l-8-5.2L4 22V4a2 2 0 0 1 2-2Z"/></svg>',
  last: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5h-2v6l5 3 1-1.7-4-2.3V7Z"/></svg>',
  intro: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm3 8h8V9H8v2Zm0 4h8v-2H8v2Zm0 4h5v-2H8v2Z"/></svg>',
};

/** BaseBook.kt:getKindList() —— 字数在前，kind 按 [, \n] 切分接在后面 */
function kindList(b) {
  const out = [];
  if (b.wordCount) out.push(String(b.wordCount));
  const k = b.kind;
  if (k) String(k).split(/[,\n]/).map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
  return out;
}

/** 统一封面渲染：加载失败或没有地址都退回首字占位块 */
function coverHtml(b, cls) {
  if (b && b.coverUrl) {
    return '<img class="' + cls + '" loading="lazy" alt="" src="/api/online/image?url='
      + encodeURIComponent(b.coverUrl) + '" onerror="this.classList.add(\'ph\');this.removeAttribute(\'src\')">';
  }
  return '<div class="' + cls + ' ph">' + esc(String((b && b.name) || "?").slice(0, 2)) + "</div>";
}

/** Book.kt:170 —— 未读章节数 = max(总章数 - 当前章序号 - 1, 0) */
function unreadNum(b) {
  const pr = b._p || {};
  const total = Number(b.totalChapterNum) || Number(pr.total) || 0;
  const idx = Number(pr.chapter) || 0;
  return total > 0 ? Math.max(total - idx - 1, 0) : 0;
}

/**
 * 书架条目 —— 版式照 legado res/layout/item_bookshelf_list.xml：
 *   左封面 66x90dp ｜ 右侧：书名16sp（右上角红色未读数气泡）
 *   ⊙作者   ▤读到  🕘最新
 * 高度恒等于 CSS 变量 --bk-row-h（renderBooks() 每页反推出来），分页依赖它。
 */
function el_onlineBook(b, box) {
  const el = document.createElement("div");
  el.className = "book-item online" + (state.book && state.book.rel === b.rel ? " active" : "");
  const pr = b._p || {};
  const idx = Number(pr.chapter) || 0;
  const unread = unreadNum(b);
  const readTitle = b.durChapterTitle || (pr.at ? "第 " + (idx + 1) + " 章" : "");
  const lastTitle = b.latestChapterTitle || "";
  const srcName = b.originName || b.origin || "";
  const author = b.author || "佚名";

  let html = '<div class="bk-left">' + coverHtml(b, "bk-cover") + "</div>";
  html += '<div class="bk-right">';
  html += '<div class="bk-line1"><span class="bn" title="' + esc(b.name) + '">' + esc(b.name) + "</span>"
    + (unread > 0
      // BadgeView.kt:149 setBadgeCount：count == 0 不显示，其余原样输出（legado 没有 99+ 截断）
      ? '<span class="bk-unread' + (Number(b.lastCheckCount) > 0 ? " hl" : "") + '">' + unread + "</span>"
      : "") + "</div>";
  html += '<div class="bk-meta">' + BK_ICON.author
    + "<span>" + esc(author) + (srcName ? ' · <i class="bk-src">' + esc(srcName) + "</i>" : "") + "</span></div>";
  if (readTitle) html += '<div class="bk-meta">' + BK_ICON.read + "<span>读到 " + esc(readTitle) + "</span></div>";
  if (lastTitle) html += '<div class="bk-meta">' + BK_ICON.last + "<span>" + esc(lastTitle) + "</span></div>";
  html += "</div>";
  html += '<button class="bk-del" title="移出书架">✕</button>';
  el.innerHTML = html;

  el.onclick = (e) => {
    if (e.target.closest(".bk-del")) return removeOnlineBook(b);
    openBook(b);
  };
  el.oncontextmenu = (e) => { e.preventDefault(); openBookMenu(b, e.clientX, e.clientY); };
  box.appendChild(el);
}

/** 需求 5a：书架条目右键 —— 换源 / 详情 / 导出 / 移出 */
function openBookMenu(b, x, y) {
  closeBookMenu();
  const menu = document.createElement("div");
  menu.className = "bk-menu";
  menu.id = "bkMenu";
  const items = [
    ["详情", () => openBookDetail(b)],
    ["换源", () => openChangeSource(b)],
  ];
  // legado BooksAdapter.showMenu：禁止导出 TXT 的书源不显示导出入口
  if (!sourceNoExport(b.origin)) items.push(["导出 TXT", () => exportOnlineBook(b)]);
  items.push(["移出书架", () => removeOnlineBook(b)]);
  menu.innerHTML = items.map(([t], i) => '<button class="bk-menu-item" data-i="' + i + '">' + esc(t) + "</button>").join("");
  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth - 150) + "px";
  menu.style.top = Math.min(y, window.innerHeight - items.length * 30 - 12) + "px";
  menu.querySelectorAll(".bk-menu-item").forEach((el) => {
    el.onclick = () => { const f = items[Number(el.dataset.i)][1]; closeBookMenu(); f(); };
  });
  setTimeout(() => document.addEventListener("click", closeBookMenu, { once: true }), 0);
}
function closeBookMenu() { document.getElementById("bkMenu")?.remove(); }

async function removeOnlineBook(b) {
  if (!(await askConfirm("把《" + b.name + "》移出在线书架？（不影响书源）", "移出"))) return;
  await api("/api/online/shelf/remove", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin: b.origin, bookUrl: b.bookUrl })
  }).catch((e) => toast("移除失败：" + e.message));
  if (state.book && state.book.rel === b.rel) { state.book = null; _neutralReaderView(); }
  await refreshOnlineShelf();
  renderBooks();
}

/* ============================================================
 * 书架管理
 * 对应 legado BookshelfManageActivity + BookAdapter + SelectActionBar。
 * 这里保留桌面阅读器的弹窗外壳，但操作语义沿用 legado：行选择、反选、
 * 批量删除/更新策略/分组/换源/清缓存/更新目录，以及拖动调整书架顺序。
 * ============================================================ */
function shelfBookKey(b) { return okey(b.origin, b.bookUrl); }

function shelfSelectedBooks() {
  return (state.online.books || []).filter((b) => shelfManageState.selected.has(shelfBookKey(b)));
}

function shelfGroupText(b) {
  const gid = Number(b.group) || 0;
  if (!gid) return "无分组";
  return (state.online.bookGroups || [])
    .filter((g) => Number(g.groupId) > 0 && (Number(g.groupId) & gid) > 0)
    .map((g) => g.groupName).join(",") || "无分组";
}

function updateShelfManageCount(visible) {
  const total = (state.online.books || []).length;
  const count = shelfSelectedBooks().length;
  $("smCount").textContent = total + " 本";
  $("smSelected").textContent = count ? "已选 " + count + " 本" : "未选择";
  const allVisible = visible.length > 0 && visible.every((b) => shelfManageState.selected.has(shelfBookKey(b)));
  $("smAll").checked = allVisible;
}

function renderShelfManage() {
  const all = state.online.books || [];
  const q = String(shelfManageState.query || "").trim().toLowerCase();
  const visible = q ? all.filter((b) => [b.name, b.author, b.originName, b.origin]
    .some((v) => String(v || "").toLowerCase().includes(q))) : all;
  shelfManageState.books = visible;
  for (const key of [...shelfManageState.selected]) {
    if (!all.some((b) => shelfBookKey(b) === key)) shelfManageState.selected.delete(key);
  }
  const box = $("smList");
  if (!visible.length) {
    box.innerHTML = '<div class="empty-hint" style="padding:32px 12px">没有匹配的书籍</div>';
    updateShelfManageCount(visible);
    return;
  }
  box.innerHTML = visible.map((b) => {
    const key = shelfBookKey(b);
    const selected = shelfManageState.selected.has(key);
    const stateText = b.canUpdate === false ? "禁止更新" : "允许更新";
    return '<div class="sm-row' + (selected ? ' sm-selected' : '') + '" draggable="true" data-key="' + esc(key) + '">'
      + '<label class="sm-check"><input type="checkbox" data-sm-act="select"' + (selected ? ' checked' : '') + '></label>'
      + '<div class="sm-main" data-sm-act="detail" title="点击打开书籍详情">'
      + '<div class="sm-title"><span class="sm-title-name">' + esc(b.name || "(无书名)") + '</span>'
      + '<span class="sm-author">' + esc(b.author || "佚名") + '</span></div>'
      + '<div class="sm-sub"><span class="sm-source" title="' + esc(b.originName || b.origin || "") + '">' + esc(b.originName || b.origin || "未知书源") + '</span>'
      + ((Number(b.group) || 0) ? '<span class="sm-group">' + esc(shelfGroupText(b)) + '</span>' : '') + '</div></div>'
      + '<span class="sm-state">' + stateText + '</span>'
      + '<div class="sm-row-actions"><button class="mini-btn" data-sm-act="detail">详情</button><button class="mini-btn" data-sm-act="remove">删除</button></div>'
      + '</div>';
  }).join("");
  box.querySelectorAll(".sm-row").forEach((row) => {
    const key = row.dataset.key;
    const b = all.find((x) => shelfBookKey(x) === key);
    row.querySelectorAll("[data-sm-act]").forEach((el) => {
      el.onclick = async (e) => {
        e.stopPropagation();
        const act = el.dataset.smAct;
        if (act === "select") {
          if (el.checked) shelfManageState.selected.add(key); else shelfManageState.selected.delete(key);
          renderShelfManage();
        } else if (act === "detail" && b) {
          $("shelfManageModal").classList.add("hidden");
          shelfManageReturn = true;
          openBookDetail(b, { fromShelfManage: true });
        } else if (act === "remove" && b) {
          if (!(await askConfirm("把《" + b.name + "》移出在线书架？", "移出"))) return;
          await runShelfBatch("remove", [b]);
        }
      };
    });
    row.onclick = () => {
      if (!b) return;
      if (shelfManageState.selected.has(key)) shelfManageState.selected.delete(key);
      else shelfManageState.selected.add(key);
      renderShelfManage();
    };
    row.ondragstart = (e) => { e.dataTransfer.setData("text/plain", key); row.classList.add("sm-dragging"); };
    row.ondragend = () => row.classList.remove("sm-dragging");
    row.ondragover = (e) => { e.preventDefault(); row.classList.add("sm-drag-over"); };
    row.ondragleave = () => row.classList.remove("sm-drag-over");
    row.ondrop = async (e) => {
      e.preventDefault(); row.classList.remove("sm-drag-over");
      const from = e.dataTransfer.getData("text/plain");
      if (!from || from === key) return;
      const ordered = (state.online.books || []).slice();
      const fi = ordered.findIndex((x) => shelfBookKey(x) === from);
      const ti = ordered.findIndex((x) => shelfBookKey(x) === key);
      if (fi < 0 || ti < 0) return;
      const [moved] = ordered.splice(fi, 1); ordered.splice(ti, 0, moved);
      state.online.books = ordered;
      renderShelfManage(); renderBooks();
      await api("/api/online/shelf/order", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ordered.map((x) => ({ origin: x.origin, bookUrl: x.bookUrl })) }) }).catch((err) => toast("保存书架顺序失败：" + err.message));
    };
  });
  updateShelfManageCount(visible);
}

async function runShelfBatch(action, books = shelfSelectedBooks(), value = {}) {
  if (!books.length) return toast("先选择要操作的书");
  const r = await api("/api/online/shelf/batch", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, books: books.map((b) => ({ origin: b.origin, bookUrl: b.bookUrl })), ...value }) }).catch((e) => ({ error: e.message }));
  if (!r || r.error) return toast((r && r.error) || "书架操作失败");
  if (action === "remove") books.forEach((b) => shelfManageState.selected.delete(shelfBookKey(b)));
  await refreshOnlineShelf();
  renderBooks();
  renderShelfManage();
  toast(action === "remove" ? "已移出书架" : "书架操作已完成");
}

function openShelfManageMenu(x, y) {
  popupMenu(x, y, [
    ["删除选中", async () => {
      const books = shelfSelectedBooks();
      if (!books.length) return toast("先选择要操作的书");
      if (await askConfirm("移出已选的 " + books.length + " 本书？", "移出")) await runShelfBatch("remove", books);
    }],
    ["允许更新", () => runShelfBatch("update")],
    ["禁止更新", () => runShelfBatch("disableUpdate")],
    ["批量换源", () => {
      const books = shelfSelectedBooks();
      if (!books.length) return toast("先选择要操作的书");
      $("shelfManageModal").classList.add("hidden");
      openChangeAllSource(books);
    }],
    ["清除缓存", () => runShelfBatch("clearCache")],
    ["选中所选区间", () => {
      const pos = shelfManageState.books.map((b, i) => shelfManageState.selected.has(shelfBookKey(b)) ? i : -1).filter((i) => i >= 0);
      if (pos.length) for (let i = Math.min(...pos); i <= Math.max(...pos); i++) shelfManageState.selected.add(shelfBookKey(shelfManageState.books[i]));
      renderShelfManage();
    }],
    ["更新目录", () => runShelfBatch("updateToc")],
    ["刷新书架", async () => { await refreshOnlineShelf(); renderShelfManage(); toast("书架已刷新"); }],
    ["清空选择", () => { shelfManageState.selected.clear(); renderShelfManage(); }],
  ]);
}

function openShelfManage() {
  if (state.mode !== "online") return toast("书架管理仅用于在线书架");
  shelfManageState.query = "";
  shelfManageState.selected.clear();
  $("smSearch").value = "";
  $("shelfManageModal").classList.remove("hidden");
  renderShelfManage();
  $("smClose").onclick = () => $("shelfManageModal").classList.add("hidden");
  $("shelfManageModal").onclick = (e) => { if (e.target === $("shelfManageModal")) $("shelfManageModal").classList.add("hidden"); };
  $("smSearch").oninput = (e) => { shelfManageState.query = e.target.value; renderShelfManage(); };
  $("smAll").onchange = (e) => {
    for (const b of shelfManageState.books) { const k = shelfBookKey(b); if (e.target.checked) shelfManageState.selected.add(k); else shelfManageState.selected.delete(k); }
    renderShelfManage();
  };
  $("smReverse").onclick = () => { for (const b of shelfManageState.books) { const k = shelfBookKey(b); if (shelfManageState.selected.has(k)) shelfManageState.selected.delete(k); else shelfManageState.selected.add(k); } renderShelfManage(); };
  $("smMore").onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openShelfManageMenu(rect.right - 150, rect.bottom + 5);
  };
}

async function refreshOnlineShelf() {
  const r = await api("/api/online/shelf").catch(() => ({ books: [] }));
  state.online.books = r.books || [];
  state.online.bookGroups = r.groups || [];
  // legado 的 durChapterIndex / durChapterPos 存在 books 表里（Book.kt:97 / :94），
  // 我们存在 config.online.progress。刷新时必须把服务端进度取回来填进 onlineProgress，
  // 否则未读章节数 getUnreadChapterNum() 会按「一本没读」算，书架书名后面全是 99+。
  for (const [k, p] of Object.entries(r.progress || {})) onlineProgress[k] = p;
  for (const b of state.online.books) {
    const k = okey(b.origin, b.bookUrl);
    if (!onlineProgress[k]) onlineProgress[k] = { chapter: 0, scroll: 0, total: 0 };
    b._p = onlineProgress[k];
  }
  if (state.mode === "online") { state.books = onlineBooksShaped(); renderShelfSelect(); }
}

/* ---------------- 覆写：章节读取与进度 ---------------- */

chapterUrl = function (rel, idx) {
  if (state.mode !== "online") return `/api/chapter?shelf=${state.shelfIndex}&rel=${encodeURIComponent(rel)}&idx=${idx}`;
  const b = resolveOnlineBookByRel(rel);
  // 解析不到书源时必须显式失败。以前这里返回 "/api/chapter?rel="（本地接口、rel 为空），
  // 服务端会拿书架根目录当章节文件读，报 EISDIR —— 用户看到的就是「章节加载失败」。
  if (!b) return null;
  return "/api/online/content?origin=" + encodeURIComponent(b.origin)
    + "&url=" + encodeURIComponent(b.bookUrl) + "&index=" + idx;
};

fetchChapter = function (rel, idx) {
  if (state.mode !== "online") return _fetchChapter(rel, idx);
  const k = chapterKey(rel, idx);
  const hit = chapterCache.get(k);
  if (hit) return hit;
  if (chapterCache.size > 60) {
    const keep = [...chapterCache.keys()].slice(-30);
    for (const kk of [...chapterCache.keys()]) if (!keep.includes(kk)) chapterCache.delete(kk);
  }
  // 需求 10：强制重抓。光删前端缓存不够 —— 后端 book-worker.taskContent 还有一层
  // contentCache，必须带 refresh=1 才会真的回源（legado 阅读菜单「刷新」的语义）。
  const force = forceRefresh.has(k);
  if (force) forceRefresh.delete(k);
  let url = chapterUrl(rel, idx);
  if (!url) {
    const e = new Error("书籍已不在书架中，请重新从搜索/发现页打开");
    e.code = "NO_BOOK";
    return Promise.reject(e);
  }
  if (force) url += "&refresh=1";
  // 在线正文可能失败（需要验证 / 网络抖动）：把错误号带出去给用户看
  const p = api(url).then((r) => {
    if (r && r.ok === false) {
      const e = new Error(r.error || "正文抓取失败");
      e.code = r.code; e.data = r.data;
      throw e;
    }
    return r;
  }).catch((e) => { chapterCache.delete(k); throw e; });
  p.__readerSettled = false;
  p.then(() => { p.__readerSettled = true; }, () => { p.__readerSettled = true; });
  chapterCache.set(k, p);
  return p;
};

prefetchNeighbors = function (idx, opts = {}) {
  if (state.mode !== "online") return _prefetchNeighbors(idx);
  const b = state.book;
  if (!b) return;
  // 与 app.js 的 prefetchNeighbors 保持一致：当前章前后各 PREFETCH_RADIUS 章、
  // 先往后再往前、每一侧由近到远、串行执行。
  const order = [];
  for (let step = 1; step <= PREFETCH_RADIUS; step++) {
    const after = idx + step;
    if (after < b.chapterCount) order.push(after);
  }
  for (let step = 1; step <= PREFETCH_RADIUS; step++) {
    const before = idx - step;
    if (before >= 0) order.push(before);
  }
  const run = async () => {
    for (const i of order) {
      if (chapterCache.has(chapterKey(b.rel, i))) continue;
      try { await fetchChapter(b.rel, i); } catch (e) { break; }
      if (state.book !== b || state.chapterIdx !== idx) return;   // 用户已翻走，放弃剩余预取
    }
  };
  if (opts.immediate) return run();
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 60);
};

/* 远距离目录跳章不主动预取。
 * legado ReadBook.loadContent() 只加载当前章与前后一章；用户在目录上扫视、悬停
 * 并不代表一定会点击。此前这里按 hover/pointerdown 预抓任意章节，遇到速读谷这类
 * 有风控的站点会放大请求量并触发临时封禁，所以回退为与 legado 一致的策略：
 * 只有点击后才请求目标章，前后相邻章仍由 prefetchNeighbors() 处理。 */

saveProgress = function () {
  if (state.mode !== "online") return _saveProgress();
  if (!state.book) return;
  const el = $("content");
  const ratio = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
  const rel = state.book.rel;
  const chapter = state.chapterIdx;
  const total = state.book.chapterCount;
  onlineProgress[rel] = { chapter, scroll: ratio, total, at: Date.now() };
  const b = findOnlineByRel(rel);
  if (b) b._p = onlineProgress[rel];
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    const cur = findOnlineByRel(rel);
    if (!cur) return;
    api("/api/online/progress", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: cur.origin, bookUrl: cur.bookUrl, chapter, scroll: ratio })
    }).catch(() => {});
  }, 600);
};

/* ---------------- 覆写：正文内嵌图片（legado TextChapterLayout 的 <img> 分支） ----------------
 * 书源常在正文里塞图片：<img src="地址,{json option}">（option 里可有 style / width / click / js）。
 * legado 的处理（TextChapterLayout.kt:670-723 + ImageColumn.kt）：
 *   paramPattern = /\s*,\s*(?=\s*\{)/ 切出地址与 option；
 *   style=TEXT（或没写且图小于 80x80）→ 行内小图标：宽 = 一个字符宽，按原图比例缩放，行内垂直居中；
 *   其余 → 整块插图：width 支持 % / px，style 支持 LEFT / CENTER / RIGHT；
 *   点击 → option.click 走 source.evalJS，option.js 走 AnalyzeRule.evalJS。
 * 脚本里的 java.showBrowser(msg) 在 legado 里弹 BottomWebViewDialog，后端把它收集成
 * actions[].type='openUrl'（含 html + preloadJs + config），前端用 srcdoc iframe 还原，
 * 并用 postMessage 桥接 html 里的 window.qmRun(...) → /api/online/js/run。
 *
 * app.js 的 chapterFrag 把整行当纯文本，所以这里覆写它。每行仍然只产出一个块级 <p>，
 * 因为翻章动画要用 firstChild / lastChild 量高度（app.js:612 / 634）。
 */

const _chapterFrag = chapterFrag;
const CH_IMG_PARAM = /\s*,\s*(?=\s*(?:\{|【))/;

function chImageSource(tag) {
  const attr = /\bsrc\s*=\s*(['"])/i.exec(tag);
  if (!attr) return null;
  const start = attr.index + attr[0].length;
  const rest = tag.slice(start);
  const bracket = /,\s*【/.exec(rest);
  if (bracket) {
    const close = rest.indexOf('】', bracket.index + bracket[0].length);
    if (close >= 0) return rest.slice(0, close + 1);
  }
  const brace = /,\s*\{/.exec(rest);
  if (brace) {
    const open = brace.index + brace[0].lastIndexOf('{');
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = open; i < rest.length; i++) {
      const c = rest[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return rest.slice(0, i + 1);
    }
  }
  const end = rest.indexOf(attr[1]);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function chImageParts(raw) {
  const m = CH_IMG_PARAM.exec(String(raw));
  if (!m) return { url: String(raw), opt: null };
  const tail = String(raw).slice(m.index + m[0].length);
  const t = tail.trim();
  const optionText = t.startsWith('【') && t.endsWith('】') ? '{' + t.slice(1, -1) + '}' : tail;
  return { url: String(raw).slice(0, m.index), opt: chParseOpt(optionText) };
}

function chImgLineParts(line) {
  const out = [];
  const s = String(line == null ? "" : line);
  let pos = 0;
  const tags = /<img\b[^>]*>/ig;
  let match;
  while ((match = tags.exec(s)) !== null) {
    const i = match.index;
    const tag = match[0];
    if (i > pos) out.push({ text: s.slice(pos, i) });
    const raw = chImageSource(tag) || "";
    if (raw) {
      const parts = chImageParts(raw);
      out.push({
        img: true, raw: raw,
        url: parts.url,
        opt: parts.opt && typeof parts.opt === "object" ? parts.opt : null,
      });
    } else out.push({ text: tag });
    pos = i + tag.length;
  }
  if (pos < s.length) out.push({ text: s.slice(pos) });
  return out;
}

/**
 * 解析图片 option —— 对齐 legado 的 Gson 宽松解析（TextChapterLayout.kt:391
 * `GSON.fromJsonObject<Map<String, String>>(urlOptionStr)`）。
 *
 * 光遇聚合的本章说/段评是这么拼的：`<img src="地址,{'type':'qtbzs',"click":"showCmt(...)",'style':'FULL'}">`
 * —— 单引号 + 双引号混用，标准 JSON.parse 必炸；legado 用 Gson（lenient）能正常拿到
 * style / click / width。
 *
 * 注意不能「先把 ' 全替换成 "」：Gson 的单引号串里允许直接出现双引号，
 * `{'click':"showCmt('u','番茄')"}` 会被那种做法切坏（我们之前就踩了这个坑）。
 * 这里按字符扫一遍再重建标准 JSON。
 */
function chNormalizeImageOption(text) {
  const s = String(text == null ? "" : text);
  let out = "";
  let quote = "";
  let escaped = false;
  for (const c of s) {
    if (quote) {
      if (escaped) { out += c; escaped = false; continue; }
      if (c === '\\') { out += c; escaped = true; continue; }
      if ((quote === '"' && (c === '"' || c === '＂')) || (quote === "'" && (c === "'" || c === '＇'))) {
        out += quote; quote = ""; continue;
      }
      out += c; continue;
    }
    if (c === '"' || c === '＂') { quote = '"'; out += '"'; continue; }
    if (c === "'" || c === '＇') { quote = "'"; out += "'"; continue; }
    if (c === '，') { out += ','; continue; }
    if (c === '：') { out += ':'; continue; }
    out += c;
  }
  return out;
}

function chParseOpt(text) {
  const str = chNormalizeImageOption(text).trim();
  if (!str) return null;
  try { const o = JSON.parse(str); return o && typeof o === "object" ? o : null; } catch (e) { /* 落到宽松路径 */ }
  const p = new LenientJson(str);
  try {
    const o = p.parse();
    return o && typeof o === "object" ? o : null;
  } catch (e) { return null; }
}

/** Gson lenient 等价物：单引号串 / 裸键 / 裸值 / 尾逗号 */
class LenientJson {
  constructor(text) { this.s = text; this.i = 0; }
  parse() { this.ws(); const v = this.value(); this.ws(); if (this.i < this.s.length) throw new Error("trailing"); return v; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) return null;
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    const b = this.i;
    while (this.i < this.s.length && !/[,\]}:]/.test(this.s[this.i])) this.i++;
    const raw = this.s.slice(b, this.i).trim();
    if (!raw) throw new Error("empty value");
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return Number(raw);
    return raw;
  }
  string() {
    const q = this.s[this.i++];
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") {
        const n = this.s[this.i + 1];
        this.i += 2;
        if (n === undefined) break;
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "r") out += "\r";
        else if (n === "u") { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4; }
        else out += n;
        continue;
      }
      if (c === q) { this.i++; return out; }
      out += c; this.i++;
    }
    throw new Error("unterminated string");
  }
  key() {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    const b = this.i;
    while (this.i < this.s.length && !/[\s:]/.test(this.s[this.i])) this.i++;
    const raw = this.s.slice(b, this.i);
    if (!raw) throw new Error("empty key");
    return raw;
  }
  object() {
    this.i++;
    const o = {};
    this.ws();
    if (this.s[this.i] === "}") { this.i++; return o; }
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") { this.i++; return o; }
      const k = this.key();
      this.ws();
      if (this.s[this.i] !== ":") throw new Error("expect :");
      this.i++;
      o[k] = this.value();
      this.ws();
      const c = this.s[this.i];
      if (c === ",") { this.i++; continue; }
      if (c === "}") { this.i++; return o; }
      throw new Error("expect , or }");
    }
  }
  array() {
    this.i++;
    const a = [];
    this.ws();
    if (this.s[this.i] === "]") { this.i++; return a; }
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") { this.i++; return a; }
      a.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ",") { this.i++; continue; }
      if (c === "]") { this.i++; return a; }
      throw new Error("expect , or ]");
    }
  }
}

function chImgSrc(url) {
  return /^data:/i.test(url) ? url : "/api/online/image?url=" + encodeURIComponent(url);
}

function chImgElement(part, ctx) {
  const opt = part.opt || {};
  /**
   * legado TextChapterLayout.kt:425-435 的 when(style) 三分支：
   *   "TEXT" → reviewChar：新式段评气泡，宽度 = 1.5556 个字符宽（比文字略大）
   *   "text" → srcReplaceChar：老式行内小图，宽度 = 1 个字符宽
   *   else   → setTypeImage：整块插图（FULL / LEFT / RIGHT / CENTER）
   * 大小写是**有语义的**，不能 upperCase 后合并 —— 光遇聚合的段评就是小写 "text"，
   * 合并后 68 个段评气泡会全部变成整块大图（用户报的「只有本章说、没有正文」）。
   */
  const rawStyle = String(opt.style == null ? "" : opt.style);
  const style = rawStyle.toUpperCase();
  // legado when(style) 用的是精确比较，"TEXT" 与 "text" 是两个不同分支（大小写有语义）：
  // 之前写成 style === "TEXT"，"text" 被 toUpperCase 之后也命中，七猫/番茄的段评小图标
  // 全被当成 1.7em 的大气泡，用户看到的就是「段评/本章说字体太大」。
  const inline = rawStyle === "TEXT";
  const bubble = rawStyle === "text";
  const width = String(opt.width == null ? "" : opt.width);
  const el = document.createElement("img");
  el.className = "ch-img " + (inline ? "ch-img-inline" : bubble ? "ch-img-bubble" : "ch-img-block");
  el.alt = "";
  // legado TextChapterLayout.kt 的图片列（ImageColumn）是立即加载，没有 lazy 语义；
  // 之前 lazy 会让章节末尾的「本章说」大图一直不加载，必须切章重渲染才能看到。
  el.loading = "eager";
  el.decoding = "async";
  el.draggable = false;
  const imgType = String(opt.type == null ? "" : opt.type).trim();
  if (imgType) el.dataset.type = imgType;
  if (inline || bubble) el.title = "点击查看";
  else if (style === "LEFT" || style === "RIGHT" || style === "CENTER") el.dataset.align = style;
  if (width) el.style.width = width;
  // legado TextChapterLayout.kt:415-421：书源没写 style 时，原图 <80x80 才按 "text"
  // （行内小图）处理，否则用书籍的 imageStyle 整块插图。浏览器要等 onload 才知道原图尺寸。
  el.onload = () => {
    if (!rawStyle && el.naturalWidth > 0 && el.naturalWidth < 80 && el.naturalHeight > 0 && el.naturalHeight < 80) {
      el.classList.remove("ch-img-block");
      el.classList.add("ch-img-bubble");
      el.style.width = "";
      el.title = "点击查看";
    }
    // 部分书源的「神评论」SVG 只带 style=FULL、没有 type（原图 1000x108），
    // 按宽高比识别为评论横幅，避免被正文列整宽铺满后字号显得过大。
    if (el.naturalWidth >= 800 && el.naturalHeight > 0 && el.naturalWidth / el.naturalHeight >= 6) {
      el.classList.add("ch-img-comment-banner");
    }
  };
  const isDataUrl = /^data:/i.test(part.url);
  el.src = chImgSrc(part.url);
  // legado 图片加载失败只占位、不清 src；这里保留 src 并做一次带随机参数的自动重试，
  // 避免首次请求被取消/超时后图片永久空白（用户报的「本章说要切章才显示」）。
  let imgRetried = false;
  el.onerror = () => {
    if (!isDataUrl && !imgRetried) {
      imgRetried = true;
      const base = chImgSrc(part.url);
      setTimeout(() => { el.src = base + (base.indexOf("?") >= 0 ? "&" : "?") + "_r=" + Date.now(); }, 700);
      return;
    }
    el.classList.add("ph");
  };
  const raw = part.raw;
  el.onclick = (e) => { e.stopPropagation(); chImgClick(raw, ctx); };
  return el;
}

chapterFrag = function (text) {
  if (state.mode !== "online") return _chapterFrag(text);
  const b = state.book;
  const ctx = b ? { origin: b.origin, bookUrl: b.bookUrl, index: state.chapterIdx } : null;
  const frag = document.createDocumentFragment();
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter((l) => l.length);
  for (const line of lines) {
    const p = document.createElement("p");
    if (line.indexOf("<img") < 0) { p.textContent = line; frag.appendChild(p); continue; }
    for (const part of chImgLineParts(line)) {
      if (part.img) p.appendChild(chImgElement(part, ctx));
      else if (part.text) p.appendChild(document.createTextNode(part.text));
    }
    frag.appendChild(p);
  }
  return frag;
};

/** 点击正文图片 → legado ReadBookActivity.oldClickImg：把原始 src 回给后端跑 click / js */
async function chImgClick(raw, ctx) {
  if (!ctx || !ctx.origin) return;
  let r = null;
  try {
    r = await api("/api/online/img/click", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: ctx.origin, bookUrl: ctx.bookUrl, src: raw, index: ctx.index }),
    });
  } catch (e) { toast("图片点击处理失败：" + e.message); return; }
  const acts = (r && r.actions) || [];
  await applyActions(acts, ctx);
  if (!acts.length) toast(r && r.error ? r.error : "这个图片没有可执行的动作");
}

/* ============================================================
 * 内置浏览器（legado WebViewActivity / BottomWebViewDialog 的桌面端等价物）
 *
 * 为什么要真浏览器而不是 iframe：
 *   1. 番茄等站点返回 Content-Security-Policy: frame-ancestors 'self'，
 *      iframe 直接被拒（白屏 + 禁止图标），legado 用的是顶层 WebView，没这限制；
 *   2. 登录态必须落到真实 cookie jar 才能回写书源的 CookieStore；
 *   3. 有些站点（七猫 / 光遇）要求桌面 UA、WebSocket 长连接，iframe 里表现不一致。
 * 做法：后端 headless Edge + CDP，Page.startScreencast 投 JPEG 帧，前端 canvas 渲染，
 * 鼠标/键盘事件按比例换算后 Input.dispatch* 回灌，cookie 由后端自动写回 CookieStore。
 * ============================================================ */

/** CDP Input.dispatchKeyEvent 需要的 windowsVirtualKeyCode（只列书源登录页常用的键） */
const WV_KEYCODE = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, " ": 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

/**
 * 把容器变成一个「可交互的远程浏览器视口」。
 * @param {HTMLElement} host 承载 canvas 的容器
 * @param {object} tab  { tabId, width, height }
 * @returns {object} 句柄 { canvas, focus(), close(), onNav(fn) }
 */
function wvMount(host, tab) {
  const cv = document.createElement("canvas");
  cv.className = "wv-canvas";
  cv.width = tab.width;
  cv.height = tab.height;
  cv.tabIndex = 0;
  host.appendChild(cv);
  /* 远端页面视口尺寸（Input.dispatchMouseEvent 用的就是这套坐标）。
     以 screencast 帧上报的 deviceWidth/Height 为准，它才是页面真实视口。 */
  let vw = Number(tab.width) || cv.width;
  let vh = Number(tab.height) || cv.height;
  const g = cv.getContext("2d");
  let closed = false;
  let since = 0;
  let drag = null;
  let img = null;
  let first = true;
  const navs = [];

  function paint(data) {
    if (!img) { img = new Image(); img.onload = () => paint2(); }
    img.__data = "data:image/jpeg;base64," + data;
    if (img.__ready) { img.src = img.__data; return; }
    img.onload = () => { img.__ready = true; img.onload = () => paint2(); paint2(); };
    img.src = img.__data;
  }
  function paint2() {
    try { g.drawImage(img, 0, 0, cv.width, cv.height); } catch (e) { /* 解码失败忽略 */ }
  }

  async function loop() {
    while (!closed) {
      let f = null;
      try { f = await api("/api/online/webview/frame?tab=" + encodeURIComponent(tab.tabId) + "&since=" + since + "&timeout=25000"); }
      catch (e) { await new Promise((r) => setTimeout(r, 600)); continue; }
      if (closed) break;
      if (!f || f.ok === false) { await new Promise((r) => setTimeout(r, 400)); continue; }
      if (f.closed) break;
      if (f.seq) since = f.seq;
      if (f.data) {
        if (first) { first = false; host.classList.add("wv-up"); }
        // 帧里带了视口尺寸就同步过来（页面自己改过 deviceMetrics 时会对不上）
        if (f.width && f.height && (f.width !== vw || f.height !== vh)) {
          vw = f.width; vh = f.height;
          if (cv.width !== vw || cv.height !== vh) { cv.width = vw; cv.height = vh; }
        }
        paint(f.data);
      }
    }
  }
  loop();

  /**
   * 输入回灌统一走一条串行队列：拖动时几十个 mouseMoved 如果各发各的 HTTP 请求，
   * 到达顺序不保证，页面看到的轨迹会乱序甚至倒退。
   */
  let inputChain = Promise.resolve();
  let inflight = 0;
  function send(ev) {
    inflight += 1;
    inputChain = inputChain
      .then(() => api("/api/online/webview/input", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab: tab.tabId, event: ev }),
      }).catch(() => null))
      .then((r) => { inflight -= 1; return r; });
    return inputChain;
  }
  /** canvas 始终铺满容器，显示坐标与 CDP viewport 按同一比例线性换算。 */
  function pt2(e) {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height || !vw || !vh) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(vw, Math.round((e.clientX - r.left) * vw / r.width))),
      y: Math.max(0, Math.min(vh, Math.round((e.clientY - r.top) * vh / r.height))),
    };
  }
  /*
   * 按下 → 移动 → 抬起，如实回灌成 mousePressed / mouseMoved / mouseReleased。
   *
   * 之前这里把「按住拖动」当成页面滚屏手势（换算成 wheel 增量），只在没拖动时才补一次
   * click。普通链接看不出问题，但滑块类验证码（番茄作家专区登录页的「按住左边按钮拖动完成
   * 上方拼图」）要的是真实的按住拖动序列，那条路径下页面只收到滚轮事件，滑块纹丝不动。
   * legado 的 WebView 是把触摸原样交给页面的，这里用同样的语义：按下就发 mousePressed，
   * 拖动期间 buttons 一直保持左键位，抬起回 0；页面滚屏交给滚轮 / 触控板。
   */
  function sendMouse(type, p, extra) {
    return send(Object.assign({ kind: "mouse", type: type, x: p.x, y: p.y }, extra || {}));
  }
  function endDrag(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.removeEventListener("mousemove", onDocMove, true);
    document.removeEventListener("mouseup", endDrag, true);
    // 节流丢掉的那一帧在抬起前补上，保证滑块停在用户松手的位置
    if (d.pending) sendMouse("move", d.pending, { button: d.button, buttons: d.buttons });
    sendMouse("up", e ? pt2(e) : { x: d.x, y: d.y }, { button: d.button, buttons: 0, clickCount: d.clickCount });
  }
  function onDocMove(e) {
    if (!drag) return;
    const p = pt2(e);
    if (p.x === drag.x && p.y === drag.y) return;
    const now = Date.now();
    // 每个 mousemove 都回灌太重，约 60Hz 足够页面画出平滑轨迹（松手前会补齐最后一帧）
    // 队列排得太深（拖动很快）时只留最后一帧，防止松手事件排在一长串 move 后面
    if (now - (drag.at || 0) < 14 || inflight > 3) { drag.pending = p; return; }
    drag.at = now; drag.pending = null;
    drag.x = p.x; drag.y = p.y;
    sendMouse("move", p, { button: drag.button, buttons: drag.buttons });
  }
  cv.addEventListener("mousedown", (e) => {
    cv.focus();
    if (e.button !== 0 && e.button !== 2) return;
    const p = pt2(e);
    const button = e.button === 2 ? "right" : "left";
    drag = { x: p.x, y: p.y, button: button, buttons: e.button === 2 ? 2 : 1, clickCount: Math.max(1, e.detail || 1), at: Date.now() };
    // 拖出弹窗边界（滑块拖到最右、指针越过窗口）也要继续收到事件
    document.addEventListener("mousemove", onDocMove, true);
    document.addEventListener("mouseup", endDrag, true);
    sendMouse("down", p, { button: button, buttons: drag.buttons, clickCount: drag.clickCount });
    e.preventDefault();
  });
  cv.addEventListener("mousemove", (e) => {
    if (drag) return;                     // 按住期间的移动由 onDocMove 负责
    sendMouse("move", pt2(e), { button: "none", buttons: 0 });
  });
  window.addEventListener("blur", () => endDrag(null));
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pt2(e);
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? vh : 1;
    send({ kind: "mouse", type: "wheel", x: p.x, y: p.y,
      deltaX: Math.round(e.deltaX * unit), deltaY: Math.round(e.deltaY * unit) });
  }, { passive: false });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return;            // 交外层：关窗
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ kind: "text", text: e.key });
    else send({ kind: "key", type: "down", key: e.key, code: e.code, keyCode: WV_KEYCODE[e.key] || 0, modifiers: (e.shiftKey ? 8 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.metaKey ? 4 : 0) });
  });
  cv.addEventListener("keyup", (e) => {
    if (e.key === "Escape" || e.key.length === 1) return;
    send({ kind: "key", type: "up", key: e.key, code: e.code, keyCode: WV_KEYCODE[e.key] || 0 });
  });
  // 中文输入法：compositionend 一次把整串塞进去（CDP insertText 支持多字符）
  cv.addEventListener("compositionend", (e) => { if (e.data) send({ kind: "text", text: e.data }); });
  cv.addEventListener("paste", (e) => {
    const t = e.clipboardData && e.clipboardData.getData("text");
    if (t) { e.preventDefault(); send({ kind: "text", text: t }); }
  });

  return {
    canvas: cv,
    focus() { cv.focus(); },
    onNav(fn) { navs.push(fn); },
    async close() { closed = true; },
  };
}

/**
 * 打开一个内置浏览器窗口（等价 WebViewActivity：标题栏 + 返回/刷新 + 完成）。
 * @param {object} o { source, url, title, onDone(result), footer }
 */
async function openWebviewWindow(o) {
  const wrap = document.createElement("div");
  wrap.className = "ch-modal";
  // legado 的工具栏（两处菜单 XML，逐条照抄）：
  //   WebViewActivity（startBrowser / 源验证）→ res/menu/web_view.xml：
  //       menu_web_refresh（always, ic_refresh）+ menu_ok（always, ic_check）
  //   WebViewLoginFragment（登录）→ res/menu/source_webview_login.xml：
  //       只有 menu_ok（always, ic_check）
  // 两个菜单里都**没有后退项**——legado 靠系统返回键（WebViewActivity.kt:127-171 的
  // onBackPressedDispatcher → goBackOrForward(-steps)）。桌面端的等价手势是 Alt+← 与
  // 鼠标侧键，见下面 onKey。✕ 是桌面端必需项（没有系统返回键可以「退出这个 Activity」）。
  const wvKind = o.kind === "login" ? "login" : "browser";
  wrap.innerHTML = '<div class="ch-modal-box wv-box">'
    + '<div class="ch-modal-head"><span class="ch-modal-title"></span>'
    + '<span class="wv-tools">'
    + (wvKind === "browser" ? '<button class="icon-btn wv-reload" title="刷新">\u27f3</button>' : '')
    + '<button class="icon-btn wv-ok" title="完成（保存 Cookie 并关闭）">\u2713</button>'
    + '</span>'
    + '<button class="icon-btn ch-modal-x" title="关闭">\u2715</button></div>'
    + '<div class="wv-wrap"><div class="wv-loading">正在启动内置浏览器…</div></div>'
    + "</div>";
  document.body.appendChild(wrap);
  wrap.querySelector(".ch-modal-title").textContent = o.title || "书源窗口";
  const host = wrap.querySelector(".wv-wrap");

  let session = null;
  let close = async () => {
    document.removeEventListener("keydown", onKey);
    if (session) { try { await session.close(); } catch (e) { /* ignore */ } }
    let after = null;
    if (session && session.tabId) {
      after = await api("/api/online/webview/close", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab: session.tabId }),
      }).catch(() => null);
    }
    wrap.remove();
    // legado SourceLoginJsExtensions.reLoginView() → 回调方刷新（发现页就是 refreshExplore）。
    // ✕/✓ 走的是这里的局部 close，所以钩子必须放在 close 内部：
    // 外部覆盖 w.close 只是换掉一个函数引用副本，按不到按钮上。
    if (typeof o.onClosed === "function") { try { await o.onClosed(after); } catch (e) { /* ignore */ } }
  };
  const doBack = () => {
    if (!session || !session.tabId) return;
    api("/api/online/webview/input", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: session.tabId, event: { kind: "back" } }),
    }).catch(() => {});
  };
  function onKey(e) {
    if (e.key === "Escape") { close(); return; }
    // legado WebViewActivity.onBackPressedDispatcher 的桌面端等价物
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "Left")) { e.preventDefault(); doBack(); }
  }
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".ch-modal-x").onclick = () => close();
  // 注意：这里**没有** wrap.onclick 遮罩关闭。
  // legado 的 WebViewActivity 是独立页面，点边缘不会退出；之前点一下就消失的 bug 就出在这。

  // 先拿到最终可视区尺寸，再创建远端 viewport。旧实现先开 760x620、随后二次 resize，
  // 首帧和 resize 后帧交错时画面尺寸与输入坐标不一致，表现为页面看得到却点不中。
  const hostRect = host.getBoundingClientRect();
  const initialWidth = Math.max(320, Math.round(hostRect.width || 760));
  const initialHeight = Math.max(320, Math.round(hostRect.height || 620));
  const r = await api("/api/online/webview/open", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: o.source, url: o.url, title: o.title, width: initialWidth, height: initialHeight }),
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || r.ok === false) {
    host.innerHTML = '<div class="wv-loading wv-err">打开失败：' + esc((r && r.error) || "未知错误") + "</div>";
    return { wrap, close };
  }
  host.innerHTML = "";
  session = wvMount(host, { tabId: r.tabId, width: r.width || initialWidth, height: r.height || initialHeight });
  session.tabId = r.tabId;
  session.source = o.source;

  /**
   * 远端视口 = 弹窗可视区尺寸（1:1）。
   * 原来远端视口固定 1280x820，塞进弹窗可视区后画面等比缩小、上下留黑边：
   * 文字明显偏小，且鼠标换算要把黑边算进去才准。桌面端窗口尺寸本就自由，
   * 直接把 WebView viewport 设成弹窗可视区（等价 legado 按屏幕尺寸设 WebView），
   * 画面与坐标都变成 1:1。
   */
  const fitViewport = () => {
    const rr = host.getBoundingClientRect();
    if (!rr.width || !rr.height) return;
    const w = Math.max(480, Math.round(rr.width));
    const h = Math.max(360, Math.round(rr.height));
    api("/api/online/webview/input", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: r.tabId, event: { kind: "size", width: w, height: h } }),
    }).catch(() => {});
  };
  let fitTimer = null;
  const onResize = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitViewport, 180); };
  window.addEventListener("resize", onResize);
  const _closeFit = close;
  close = async () => { window.removeEventListener("resize", onResize); clearTimeout(fitTimer); return _closeFit(); };
  const wvReloadBtn = wrap.querySelector(".wv-reload");
  if (wvReloadBtn) wvReloadBtn.onclick = () => api("/api/online/webview/input", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: r.tabId, event: { kind: "reload" } }),
  }).catch(() => {});
  // menu_ok：WebViewActivity 是 saveVerificationResult{finish()}（源验证），
  // WebViewLoginFragment 是 onPageFinished 时 activity?.finish()。
  // 桌面端两者都收敛成「关掉窗口」——cookie 回写由调用方在 close() 里做
  // （见 openSourceLogin / openLoginDialog 的 w.close 包装）。
  wrap.querySelector(".wv-ok").onclick = () => close();
  session.focus();
  return { wrap, close, session, tabId: r.tabId };
}

/**
 * 评论区弹窗标题。
 * 书源里的 java.showBrowser 全部用于「段评 / 书评 / 本章说 / 神评论」这类评论页，
 * 传进来的 html 自带评论标记；legado 的 BottomWebViewDialog 没有标题栏，桌面端补一个标题，
 * 按内容识别为「评论区」，识别不出再退回「书源窗口」。
 */
function commentDialogTitle(html) {
  const s = String(html || "");
  if (/段评|书评|本章说|神评论|条评论|全部评论|评论区|api-cmnt\.wtzw\.com/.test(s)) return "评论区";
  return "书源窗口";
}

/** BottomWebViewDialog 的桌面端等价物：开一个与站内其它弹窗同尺寸的 iframe 弹窗 */
function chOpenAction(a, ctx) {
  // 尺寸由 CSS 统一为站内弹窗规格（与 .tocm-box 相同）：width min(760px,94vw)、height min(82vh,760px)。
  // legado 的 heightPercentage 是相对手机屏幕高；桌面端若照搬会把七猫评论区撑满整屏，故不再据此计算。
  const dialogTitle = a.title || (a.html ? commentDialogTitle(a.html) : (a.url || ""));
  const wrap = document.createElement("div");
  wrap.className = "ch-modal";
  wrap.innerHTML = '<div class="ch-modal-box">'
    + '<div class="ch-modal-head"><span class="ch-modal-title"></span>'
    + '<button class="icon-btn ch-modal-x" title="关闭">\u2715</button></div>'
    + '<div class="ch-modal-stage">'
    + '<div class="ch-modal-loading"><span class="ch-spin"></span><span class="ch-load-text">正在加载…</span><span class="ch-load-sub"></span></div>'
    + '<iframe class="ch-modal-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>'
    + '</div></div>';
  document.body.appendChild(wrap);
  wrap.querySelector(".ch-modal-title").textContent = dialogTitle;
  wrap.querySelector(".ch-load-text").textContent = dialogTitle === "评论区" ? "正在加载评论区…" : "正在加载…";
  const fr = wrap.querySelector("iframe");
  const loadMask = wrap.querySelector(".ch-modal-loading");
  const loadSub = wrap.querySelector(".ch-load-sub");
  let loadPoll = 0, loadSlowTimer = 0, loadMaxTimer = 0, loadMaskDone = false, frameLoaded = false;
  const clearLoadTimers = () => {
    if (loadPoll) clearInterval(loadPoll);
    if (loadSlowTimer) clearTimeout(loadSlowTimer);
    if (loadMaxTimer) clearTimeout(loadMaxTimer);
    loadPoll = loadSlowTimer = loadMaxTimer = 0;
  };
  const dismissLoadMask = () => {
    if (loadMaskDone) return;
    loadMaskDone = true;
    clearLoadTimers();
    loadMask.classList.add("done");
    setTimeout(() => { if (loadMask.isConnected) loadMask.remove(); }, 220);
  };
  // 评论页自带异步接口；在它有可见文本/媒体之前保持遮罩，避免先露出整片白底。
  const framePainted = () => {
    try {
      const d = fr.contentDocument;
      if (!d || !d.body || d.readyState === "loading") return false;
      // 只能用 innerText：textContent 会把尚未执行的 <script> 源码也当成内容，导致遮罩提前消失。
      const text = String(d.body.innerText || "").replace(/\s+/g, "");
      if (text) return true;
      return !!d.querySelector("img,video,canvas,svg,input,button");
    } catch (e) {
      // 极少数跨域 iframe 无法读 DOM；此时以 load 事件为准，不能无限遮住页面。
      return frameLoaded;
    }
  };
  const checkFramePainted = () => { if (framePainted()) dismissLoadMask(); };
  const close = () => { clearLoadTimers(); window.removeEventListener("message", onMsg); wrap.remove(); };
  wrap.querySelector(".ch-modal-x").onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  const onKey = (e) => { if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(); } };
  document.addEventListener("keydown", onKey);

  const onMsg = async (e) => {
    const d = e.data;
    if (d && d.__chReady && e.source === fr.contentWindow) { dismissLoadMask(); return; }
    if (!d || !d.__chCall || e.source !== fr.contentWindow) return;
    let value = "";
    const acts = [];
    try {
      const r = await api("/api/online/js/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: ctx.origin, bookUrl: ctx.bookUrl, index: ctx.index, code: d.code, result: d.result }),
      });
      value = r && r.value != null ? String(r.value) : "";
      for (const x of (r && r.actions) || []) acts.push(x);
    } catch (err) { value = ""; }
    // 书源生成的 HTML 里可能调 java.open / java.startBrowser / java.searchBook，
    // 全部按 legado 语义落地（WebJsExtensions 继承 RssJsExtensions，接口完全一致）。
    await applyActions(acts, ctx);
    try { fr.contentWindow.postMessage({ __chRes: 1, id: d.id, value: value }, "*"); } catch (err) {}
  };
  window.addEventListener("message", onMsg);

  if (a.html) fr.srcdoc = chInjectBridge(a.html, a.url || "", a.preloadJs || "");
  else if (a.url) fr.src = a.url;
  // 轮询会等 iframe 的 readyState 不再是 loading（即 DOMContentLoaded 后）才进行判断；
  // 此时外部样式表通常已就绪，评论页自己的 spinner 会先显示，数据接口继续异步加载，
  // 不会再把外层弹窗留成白屏。
  loadPoll = setInterval(checkFramePainted, 120);
  loadSlowTimer = setTimeout(() => {
    if (!loadMaskDone && loadSub.isConnected) loadSub.textContent = "源站响应较慢，请稍候…";
  }, 8000);
  loadMaxTimer = setTimeout(() => {
    if (!loadMaskDone && loadSub.isConnected) loadSub.textContent = "加载超时，请关闭后重试";
    setTimeout(dismissLoadMask, 900);
  }, 30000);
  fr.onload = () => {
    frameLoaded = true;
    requestAnimationFrame(checkFramePainted);
    try { fr.contentWindow.focus(); } catch (e) {}
  };
}

/** 把 html 里 window.qmRun(...) 的调用桥回主进程；等价 legado 注入的 WebJsExtensions.JS_INJECTION */
function chInjectBridge(html, baseUrl, preloadJs) {
  const shim = "<script>var __chSeq=0,__chWait={};"
    + "window.addEventListener('message',function(e){var d=e.data;if(!d||!d.__chRes)return;var w=__chWait[d.id];if(w){delete __chWait[d.id];w(d.value)}});"
    + "function __chCall(name,code,result){return new Promise(function(res){var id='j'+(++__chSeq);__chWait[id]=res;"
    + "parent.postMessage({__chCall:1,id:id,name:name,code:code,result:result},'*')})}"
    + "var java={},source=java,run=function(c){return __chCall('run',c,null)},qmRun=run;"
    + "window.java=java;window.source=source;window.run=run;window.qmRun=qmRun;"
    + "window.close=function(){parent.postMessage({__chCall:0,id:'close'},'*')};<\/script>";
  // legado 用 loadDataWithBaseURL 让页面与书源同源；桌面端 iframe 只能是阅读器 origin，
  // 于是把页面里跨域的 fetch/XHR 改写成同源的 /api/online/proxy（后端按 legado 语义带 Cookie 转发）。
  const proxyShim = '<script>(function(){'
    + 'var P=' + JSON.stringify(location.origin + "/api/online/proxy?url=") + ';'
    + 'function toProxy(u){if(u==null)return null;var a;try{a=new URL(String(u),document.baseURI).href}catch(e){return null}'
    + 'if(!/^https?:/i.test(a))return null;try{if(new URL(a).origin===location.origin)return null}catch(e){return null}'
    + 'return P+encodeURIComponent(a)}'
    + 'var F=window.fetch;'
    + 'if(F){window.fetch=function(i,init){var u=(typeof i==="string")?i:(i&&i.url);var n=toProxy(u);'
    + 'if(!n)return F.apply(this,arguments);'
    + 'if(typeof i==="string")return F.call(this,n,init);'
    + 'try{return F.call(this,new Request(n,i))}catch(e){return F.call(this,n,init)}};}'
    + 'var X=window.XMLHttpRequest;'
    + 'if(X&&X.prototype&&X.prototype.open){var O=X.prototype.open;'
    + 'X.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);var n=toProxy(u);if(n)a[1]=n;return O.apply(this,a)};}'
    + 'function fixOne(el){var s=el.getAttribute("src");var n=toProxy(s);if(n)el.setAttribute("src",n)}'
    + 'function fixImgs(r){var d=r||document;if(!d.querySelectorAll)return;var l=d.querySelectorAll("img[src]");for(var i=0;i<l.length;i++)fixOne(l[i])}'
    + 'function boot(){fixImgs();try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var ns=ms[i].addedNodes;for(var j=0;j<ns.length;j++){var nd=ns[j];if(!nd||nd.nodeType!==1)continue;if(nd.tagName==="IMG")fixOne(nd);else fixImgs(nd)}}}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}}'
    + 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();'
    + '})();</script>';
  // <base> 必须排在代理 shim 前面：shim 用 document.baseURI 还原书源的绝对地址。
  let head = "";
  if (baseUrl) head += '<base href="' + String(baseUrl).replace(/"/g, "&quot;") + '">';
  head += proxyShim;
  head += shim;
  if (preloadJs) head += "<script>" + preloadJs + "<\/script>";
  let s = String(html || "");
  // legado 的 BottomWebViewDialog 会让评论页直接从源站加载样式表，
  // 桌面端 srcdoc 则必须先走本地代理，否则 Font Awesome 的字体文件会丢失，
  // 进而把 fa-* 图标渲染成一排缺字方框。仅改写 stylesheet / preload，
  // 不改变书源页面脚本和其它交互逻辑。
  if (baseUrl) {
    const proxyAsset = (href) => {
      let abs = "";
      try { abs = new URL(String(href || ""), baseUrl).href; } catch { return href; }
      if (!/^https?:/i.test(abs)) return href;
      return location.origin + "/api/online/proxy?url=" + encodeURIComponent(abs);
    };
    s = s.replace(/<link\b[^>]*>/gi, (tag) => {
      const rel = (tag.match(/\brel\s*=\s*(["'])(.*?)\1/i) || [])[2] || "";
      const as = (tag.match(/\bas\s*=\s*(["'])(.*?)\1/i) || [])[2] || "";
      const hm = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
      if (!hm || !(/stylesheet|preload/i.test(rel) && (!as || /style|font/i.test(as)))) return tag;
      let abs = "";
      try { abs = new URL(String(hm[2] || ""), baseUrl).href; } catch { return tag; }
      const next = proxyAsset(hm[2]);
      const replaced = tag.slice(0, hm.index) + hm[0].replace(hm[2], next)
        + tag.slice(hm.index + hm[0].length);
      // 晴天评论页使用 Font Awesome 6。旧服务版本只会代理 CSS 本身，
      // 不能重写 CSS 内的 ../webfonts 相对地址，所以在 stylesheet 后面
      // 再声明同名字体，保证已有 7788 进程也不会回退成缺字方框。
      if (!/all\.min\.css|fontawesome|font-awesome/i.test(abs)) return replaced;
      const font = (family, weight, relPath) => {
        const fontUrl = proxyAsset(new URL(relPath, abs).href);
        return '@font-face{font-family:' + JSON.stringify(family)
          + ';font-style:normal;font-weight:' + weight + ';font-display:block;src:url('
          + JSON.stringify(fontUrl) + ') format("woff2");}';
      };
      const fallback = '<style data-reader-icon-fonts>'
        + font('Font Awesome 6 Free', 900, '../webfonts/fa-solid-900.woff2')
        + font('Font Awesome 6 Free', 400, '../webfonts/fa-regular-400.woff2')
        + font('Font Awesome 6 Brands', 400, '../webfonts/fa-brands-400.woff2')
        + font('Font Awesome 5 Free', 900, '../webfonts/fa-solid-900.woff2')
        + font('FontAwesome', 400, '../webfonts/fa-regular-400.woff2')
        + '</style>';
      return replaced + fallback;
    });
  }
  // legado 的 loadDataWithBaseURL(url, html) 会让页面保留 url 的 query。
  // srcdoc 没有自己的地址栏，评论页从 window.location.search 取 book/item/para 时会变成空串；
  // 只改写这个明确的读取点，避免污染页面其它正常创建 URLSearchParams 的逻辑。
  try {
    const search = new URL(String(baseUrl || "")).search;
    if (search) {
      s = s.replace(
        /new\s+URLSearchParams\(\s*window\.location\.search\s*\)/g,
        "new URLSearchParams(" + JSON.stringify(search) + ")",
      );
    }
  } catch (e) {}
  const i = s.search(/<head[^>]*>/i);
  if (i >= 0) {
    const m = /<head[^>]*>/i.exec(s);
    const at = i + m[0].length;
    return s.slice(0, at) + head + s.slice(at);
  }
  const b = s.search(/<body[^>]*>/i);
  if (b >= 0) { const m = /<body[^>]*>/i.exec(s); const at = b + m[0].length; return s.slice(0, at) + head + s.slice(at); }
  return head + s;
}


/* ---------------- 覆写：打开在线书 ---------------- */


/* ---------------- 加载占位 / 目录失败提示（Bug A、死站换源入口） ---------------- */

/** 把后端/网络层抛出的英文错误翻译成用户能看懂的话 */
function humanizeNetError(msg) {
  const m = String(msg == null ? "" : msg);
  if (!m) return "未知错误";
  if (/AggregateError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|Timeout|timed? ?out|aborted/i.test(m)) {
    return "书源站点无法访问（可能已被封 IP，或需要代理 / VPN）";
  }
  if (/^(TypeError|ReferenceError|SyntaxError|RangeError)/.test(m)) {
    return "书源规则执行出错：" + m;
  }
  return m;
}

/** 抓目录期间的正文明区占位。注意：bookTitle / bookMeta 由 openBook 负责，这里不碰。 */
function showLoadHint(online, sub) {
  $("content").innerHTML = '<div class="empty-hint load-hint">正在加载《' + esc(online.name || "")
    + '》…<div class="load-sub">' + esc(sub || "正在抓取目录") + "</div></div>";
}

/**
 * 目录抓取失败时的正文档位。
 * 站点失效时最该做的事就是「换源」——legado 里换源是书籍级操作，不依赖章节列表；
 * 所以这里直接把「换源 / 重试」两个按钮摆出来（样式见 online.css 的 .eh-acts）。
 */
function showTocError(online, msg, help) {
  $("content").innerHTML = '<div class="empty-hint">' + esc(msg) + "<br>" + (help || "")
    + '<div class="eh-acts"><button id="ehSwap" class="ghost-btn">换源</button>'
    + '<button id="ehRetry" class="ghost-btn">重试</button></div></div>';
  const sw = $("ehSwap");
  if (sw) sw.onclick = () => openChangeSource(online);
  const rt = $("ehRetry");
  if (rt) rt.onclick = () => openBook(Object.assign({}, online, { _retry: Date.now() }), { keepChapter: false });
}

let openSeq = 0;

openBook = async function (b, opts = {}) {
  if (state.mode !== "online") return _openBook(b, opts);
  // rel 缺失时按 origin|bookUrl 现算：否则 state.book.rel 会是 undefined，
  // chapterUrl() 会退化成本地 /api/chapter，正文会串成另一本书（实测踩过）。
  const rel = b && b.rel ? b.rel : okey(b && b.origin, b && b.bookUrl);
  // 已在书架的书：findOnlineByRel 拿到的是书架条目，但 b 上可能带着详情页的 _startIdx，
  // 必须先把它接过来，否则「详情页点第 N 章」会被旧进度覆盖回第一章。
  const shelfBook = findOnlineByRel(rel);
  const online = (shelfBook && b && b._startIdx == null) ? shelfBook
    : (b && b.bookUrl && b.origin) ? Object.assign({}, shelfBook || {}, b)
    : shelfBook;
  // 在线模式下拿到本地条目（例如 app.js 启动时按 lastBookRel 恢复）就直接忽略，别弹错
  if (!online || !online.bookUrl || !online.origin) return;

  flushFlip();
  const same = state.book && state.book.rel === rel;
  const previous = same && opts.keepChapter !== false ? state.chapterIdx : null;
  if (state.book && !same) saveProgress();
  // 这里原先有一句 `if (!same) chapterCache.clear();`：chapterKey 里已经带了 rel，
  // 清掉只会让切回旧书时正文重新走一趟网络。去掉后切书能直接命中已读章节。

  $("bookTitle").textContent = online.name || "加载中…";
  $("bookMeta").textContent = (online.originName || "") + (online.author ? "  ·  " + online.author : "");
  try { localStorage.setItem("lastOnlineRel", rel); } catch {}

  // 【Bug A】换书时旧书的目录 / 正文 / 章节头会一直挂在界面上，直到新书目录抓完；
  // 站点慢的时候能挂十几秒，看起来就像"换书没生效、书串了"（实测速读谷²要 21s 才失败）。
  // 所以这里先把阅读区清干净再放"正在加载"占位。清理清单与 app.js neutralReaderView 对齐，
  // 但不动 bookTitle / bookMeta —— 上面已经写成新书的了。
  // seq 用来丢弃"上一本书迟到的响应"：慢请求返回时如果 openSeq 已经变了，直接 return。
  const seq = ++openSeq;
  if (!same) {
    state.chapterIdx = 0;
    chRenderedIdx = -1;
    $("tocList").innerHTML = "";
    $("tocCount").textContent = "";
    $("chapterHead").innerHTML = "";
    $("chapterHead").classList.remove("show");
    $("progressFill").style.width = "0%";
    $("progressText").textContent = "—";
    state.tocVirtual = { itemH: TOC_ITEM_H, top: 0, count: 0 };
    $("content").innerHTML = '<div class="empty-hint load-hint">正在加载《' + esc(online.name || "")
      + '》…<div class="load-sub">正在抓取目录</div></div>';
  }

  const origin = online.origin, bookUrl = online.bookUrl;
  const q = (extra) => "origin=" + encodeURIComponent(origin) + "&url=" + encodeURIComponent(bookUrl) + (extra || "");

  // 站点失效时详情/目录都会失败，但「换源」「刷新」必须仍然可用 ——
  // legado 里 ReadBookActivity 一进来就拿到 ReadBook（已入库的 Book 对象），
  // 抓不到正文只影响内容区，不影响「换源」这种书籍级操作。
  // 我们原先只在目录抓成功后才赋 state.book，于是死站的书连换源入口都点不动。
  state.book = {
    rel, name: online.name, title: online.name, author: online.author || "",
    origin, bookUrl, originName: online.originName || "",
    coverUrl: online.coverUrl || "", intro: online.intro || "",
    size: 0, encoding: "utf-8", chapterCount: 0, chapters: [],
  };
  $("bookTitle").textContent = (online.name || "加载中…") + (online.author ? "  ·  " + online.author : "");
  $("bookMeta").textContent = (online.originName || "") + (online.author ? "  ·  " + online.author : "");

  // 目录快路径：本次会话已经抓过这本书就直接复用，跳过「详情 + 目录」两趟 HTTP。
  const tocHit = opts.noCache ? null : onlineTocCacheGet(rel);
  let chapters;
  if (tocHit) {
    // 详情字段（简介 / 封面 / 作者）一起恢复，否则从书架切回来会丢简介
    Object.assign(online, tocHit.info, { rel });
    chapters = tocHit.chapters;
  } else {
    // 1) 详情（补 tocUrl / 简介 / 封面）。书架记录已经有 tocUrl 时不再请求：
    //    /api/online/chapters 会按需自愈详情；这里多跑一趟只会拖慢首次打开。
    if (!online.tocUrl) {
      try {
        const bi = await api("/api/online/book?" + q());
        if (seq !== openSeq) return;                              // 用户已经点了别的书，丢弃本次迟到的响应
        if (bi && bi.book) Object.assign(online, bi.book, { rel });
        else if (bi && bi.ok === false) toast(bi.error || "详情抓取失败");
      } catch (e) { if (seq !== openSeq) return; toast("详情抓取失败：" + e.message); }
    }

    // 2) 目录
    showLoadHint(online, "正在抓取目录");
    let ch = null;
    try {
      ch = await api("/api/online/chapters?" + q() + "&timeout=150000");
    } catch (e) {
      if (seq !== openSeq) return;
      showTocError(online, humanizeNetError(e && e.message));
      return;
    }
    if (seq !== openSeq) return;
    if (!ch || ch.ok === false) {
      const msg = humanizeNetError((ch && ch.error) || "目录为空");
      const help = ch && ch.code === "VERIFICATION" ? "该书源需要人工验证，去「书源 → 验证」处理<br>" : "";
      showTocError(online, msg, help);
      toast("目录抓取失败：" + msg);
      return;
    }
    chapters = (ch.chapters || []).map((c, i) => ({ title: c.title || ("第 " + (i + 1) + " 章"), idx: i, url: c.url, isVip: !!c.isVip, isPay: !!c.isPay }));
    onlineTocCachePut(rel, online, chapters);
    // 目录这一刻才写进服务端 TOC 缓存，而书架条目的「读到 / 最新」两行是
    // /api/online/shelf 从 TOC 缓存里现算的（server.mjs 的 shelf 分支）。
    // 不重拉一次的话，刚加入书架的书在左侧永远只有书名，那两行要手动刷新才出现。
    // refreshOnlineShelf 会把 state.online.books 整批换成新对象，所以之后要按 rel 重新取，
    // 不能继续用上面那个旧引用（它的 durChapterTitle / latestChapterTitle 还是空的）。
    if (findOnlineByRel(rel)) {
      await refreshOnlineShelf();
      const fresh = findOnlineByRel(rel);
      if (fresh) Object.assign(online, fresh, { rel });
    }
  }

  state.book = {
    rel, name: online.name, title: online.name, author: online.author || "",
    origin, bookUrl, originName: online.originName || "",
    coverUrl: online.coverUrl || "", intro: online.intro || "",
    size: 0, encoding: "utf-8",
    chapterCount: chapters.length, chapters,
  };
  $("bookTitle").textContent = (online.name || "") + (online.author ? "  ·  " + online.author : "");
  $("bookTitle").title = online.name || "";
  $("bookMeta").textContent = (online.originName || "") + " · " + chapters.length + " 章";
  $("tocCount").textContent = chapters.length + " 项";
  renderToc();
  renderBooks();
  updateBookNav();

  if (!chapters.length) {
    $("content").innerHTML = '<div class="empty-hint">这本没有解析到章节</div>';
    return;
  }
  const pr = onlineProgress[rel] || { chapter: 0, scroll: 0 };
  // 详情页目录点章 → 直接落到那一章（legado BookInfoActivity 的 openChapterList 行为），
  // 否则按书架里的阅读进度恢复
  const want = (online._startIdx != null) ? Number(online._startIdx) : null;
  // 详情页/目录弹窗点章：_startIdx 优先级最高 —— 已在读同一本书时 previous(=当前章) 会把它盖掉
  const idx = (want != null && want >= 0 && want < chapters.length) ? want
    : previous !== null ? previous
    : Math.min(pr.chapter || 0, chapters.length - 1);
  if (seq !== openSeq) return;
  // 正文请求提前到这里发起：目录渲染、书架刷新、左侧栏同步都在后面，
  // 不需要等它们完成才开始抓当前章。gotoChapter 会复用这个 promise。
  fetchChapter(rel, idx).catch(() => {});
  // 打开书是用户显式动作：下一章立即进入请求队列，不等正文渲染后的 idle callback。
  // 这样当前章在网络上时，下一章已经排在同一个限速源后面，翻页不需要再从零开始。
  prefetchNeighbors(idx, { immediate: true });
  await gotoChapter(idx, (previous !== null || want != null) ? 0 : (pr.scroll || 0));
};

/* ---------------- 覆写：正文错误提示（runChapter 里 catch 后给出可读信息） ---------------- */

const _runChapter = runChapter;
let onlineChapterLoadTimer = null;

function showOnlineChapterLoading(idx) {
  clearTimeout(onlineChapterLoadTimer);
  onlineChapterLoadTimer = setTimeout(() => {
    const h = $("chapterHead");
    if (!h) return;
    h.innerHTML = '<span class="ch-loading"><span class="ch-loading-text">'
      + '正在加载第 ' + (idx + 1) + ' 章…</span></span>';
    h.classList.add("show");
  }, 100);
}

function hideOnlineChapterLoading() {
  clearTimeout(onlineChapterLoadTimer);
  onlineChapterLoadTimer = null;
}

runChapter = async function (idx, scrollTo = 0, gesture = "direct") {
  if (state.mode !== "online") { hidePayHint(); return _runChapter(idx, scrollTo); }
  const b = state.book;
  const targetPromise = b && chapterCache.get(chapterKey(b.rel, idx));
  // 有 Promise 但未 settled 时同样是“冷章”：不能把 pending 当成已缓存，
  // 否则预取/上次点击仍在网络中时界面会完全没反馈。
  const farCold = !!(b && Math.abs(idx - state.chapterIdx) > 1
    && !(targetPromise && targetPromise.__readerSettled === true));
  if (farCold) showOnlineChapterLoading(idx);
  try {
    const r = await _runChapter(idx, scrollTo, gesture);
    hideOnlineChapterLoading();
    updatePayHint(idx);
    return r;
  } catch (e) {
    hideOnlineChapterLoading();
    const h = $("chapterHead");
    if (h) {
      h.innerHTML = '<span class="ch-loading ch-loading-error">第 ' + (idx + 1) + ' 章加载失败</span>';
      h.classList.add("show");
    }
    const d = e && e.data;
    if (d && d.kind) {
      showVerifyHint(d);
      toast("该书源需要人工验证");
    } else {
      toast("章节加载失败：" + humanizeNetError(e && (e.message || e)));
    }
  }
};

/* ---------------- 付费/广告章节预览提示 ----------------
 * 有些书源（如松鹤阅读接的 QQ 阅读接口）对收费章节只返回几十字的试读片段，
 * 结尾带省略号 —— 这不是净化规则把正文删了，而是源侧就不给全文。
 * legado 遇到这种源同样只能拿到这段预览，唯一出路是换到别的源。
 * 后端 /api/online/content 已经打好 payPreview / payHint 标记，这里负责显示。
 * （read.legado 对这类情况没有专门 UI，我们补一个不挡路的提示条。） */
function hidePayHint() {
  const box = $("payHint");
  if (box) box.classList.add("hidden");
}

function updatePayHint(idx) {
  const box = $("payHint");
  if (!box) return;
  const b = state.book;
  if (state.mode !== "online" || !b) return hidePayHint();
  const p = chapterCache.get(chapterKey(b.rel, idx));
  if (!p || typeof p.then !== "function") return hidePayHint();
  p.then((r) => {
    if (state.chapterIdx !== idx) return;         // 已经翻到别的章了，别把提示贴错地方
    if (r && r.payPreview) {
      $("payHintText").textContent = r.payHint || "本章只返回付费/广告预览，请换源阅读。";
      box.classList.remove("hidden");
    } else hidePayHint();
  }).catch(() => hidePayHint());
}

$("payHintClose").onclick = () => hidePayHint();
$("payHintSwap").onclick = () => {
  const b = state.book && findOnlineByRel(state.book.rel);
  if (b) openChangeSource(b);
  else toast("先打开一本书再换源");
};

/**
 * 需求 10：正文刷新。
 * 场景：换了书源、清了缓存目录、抓取时网络抖了一下 —— 需要给用户一个"重新拉这一章"的余地。
 * legado 对应的入口是 阅读菜单 → 刷新（BookReaderActivity 里 reloadChapter）。
 * 实现要点：
 *   1) 前端 chapterCache 里的这一章必须先删掉，否则 fetchChapter 直接命中旧 promise
 *   2) 请求带 refresh=1，后端 book-worker.taskContent 会跳过 contentCache 重新抓
 *   3) 目录也顺手刷新一次（换了书源后章节列表常常不一样）
 */
async function refreshCurrentChapter(opts = {}) {
  if (state.mode !== "online") return toast("本地书籍不需要刷新正文");
  const b = state.book;
  if (!b) return toast("还没有打开书籍");
  const idx = state.chapterIdx;
  const ck = chapterKey(b.rel, idx);
  chapterCache.delete(ck);
  forceRefresh.add(ck);      // 让 fetchChapter 带上 refresh=1，绕过后端 contentCache
  if (opts.withToc) {
    const cb = findOnlineByRel(b.rel);
    if (cb) {
      try {
        const r = await api("/api/online/chapters?origin=" + encodeURIComponent(cb.origin)
          + "&url=" + encodeURIComponent(cb.bookUrl) + "&refresh=1&timeout=150000");
        if (r && r.ok !== false && (r.chapters || []).length) {
          b.chapters = r.chapters.map((c, i) => ({ title: c.title || ("第 " + (i + 1) + " 章"), idx: i, url: c.url, isVip: !!c.isVip, isPay: !!c.isPay }));
          b.chapterCount = b.chapters.length;
          $("tocCount").textContent = b.chapterCount + " 项";
          renderToc();
          // 目录变了，前端缓存一起更新，否则切走再切回来又拿到旧目录
          const cbNow = findOnlineByRel(b.rel);
          if (cbNow) onlineTocCachePut(b.rel, cbNow, b.chapters);
          toast("目录已刷新：" + b.chapterCount + " 章");
        }
      } catch (e) { toast("目录刷新失败：" + e.message); }
    }
  }
  await runChapter(idx, getScrollRatio());
  toast("已重新抓取本章正文");
}

function getScrollRatio() {
  const el = $("content");
  return el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
}

/* ---------------- 验证面板提示 ---------------- */

let verifyTimer = null;
function showVerifyHint(d) {
  const box = $("verifyBox");
  if (!box) return;
  box.classList.remove("hidden");
  $("verifyMsg").textContent = d.sourceName ? ("书源「" + d.sourceName + "」需要人工验证") : "需要人工验证";
  const a = $("verifyOpen");
  if (d.url) { a.href = d.url; a.classList.remove("hidden"); } else a.classList.add("hidden");
  $("verifyKey").value = d.sourceKey || "";
  clearInterval(verifyTimer);
  verifyTimer = setInterval(pollVerify, 5000);
  pollVerify();
}

async function pollVerify() {
  const box = $("verifyBox");
  if (!box || box.classList.contains("hidden")) { clearInterval(verifyTimer); return; }
  const r = await api("/api/verify/pending").catch(() => null);
  const n = r && r.pending ? r.pending.length : 0;
  $("verifyCount").textContent = n ? n + " 个任务在等待" : "暂无等待中的任务";
}

$("verifySubmit").onclick = async () => {
  const sk = $("verifyKey").value;
  const result = $("verifyResult").value;
  if (!sk) return toast("缺少书源标识");
  if (!result) return toast("请填写验证结果");
  await api("/api/verify/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: sk, result, url: $("verifyOpen").href || "" })
  }).catch((e) => toast("提交失败：" + e.message));
  toast("已提交，抓取将继续");
  $("verifyBox").classList.add("hidden");
  clearInterval(verifyTimer);
};
$("verifyClose").onclick = () => { $("verifyBox").classList.add("hidden"); clearInterval(verifyTimer); };

/* ============================================================
 *  搜索页
 * ============================================================ */

async function openSearch() {
  $("panelSearch").classList.remove("hidden");
  showSearchProgress(false);
  renderSourcePicker();
  if (!state.online.sources.length) {
    await loadSources();
    renderSourcePicker();
  }
  setTimeout(() => $("searchKey").focus(), 30);
}

async function loadSources() {
  const [r, g] = await Promise.all([
    api("/api/sources").catch(() => ({ sources: [], groups: [] })),
    api("/api/source-groups").catch(() => null),
  ]);
  state.online.sources = r.sources || [];
  state.online.sourceGroups = r.groups || [];
  const sg = (r && r.sourceGroup) || g || {};
  state.online.sourceGroupDefs = Array.isArray(sg.groups) ? sg.groups : [];
  state.online.activeSourceGroupId = sg.activeId || "";
  state.online.activeSourceGroupName = sg.activeName || "";
}

function renderSourceGroupBar() {
  const sel = $("sourceGroupSelect");
  if (!sel) return;
  const groups = state.online.sourceGroupDefs || [];
  sel.innerHTML = groups.map((g) => '<option value="' + esc(g.id) + '">' + esc(g.name) + "</option>").join("");
  if (state.online.activeSourceGroupId) sel.value = state.online.activeSourceGroupId;
  const active = groups.find((g) => g.id === state.online.activeSourceGroupId);
  const stat = $("sourceGroupStat");
  if (stat) stat.textContent = active ? ("当前：" + active.name) : "";
  const rename = $("srcGroupRename");
  const del = $("srcGroupDelete");
  if (rename) rename.disabled = !active;
  if (del) del.disabled = !active || groups.length <= 1;
}

async function refreshSourceGroupUI() {
  await loadSources();
  renderSourceGroupBar();
  renderSourceList();
  renderSourcePicker();
}

async function switchSourceGroup(id) {
  if (!id || id === state.online.activeSourceGroupId) return;
  const r = await api("/api/source-groups/switch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch((e) => { toast("切换书源组失败：" + e.message); return null; });
  if (!r || r.error) return;
  state.online.searchPick = [];
  await refreshSourceGroupUI();
  resetSearchForGroupChange();
  toast("已切换到：" + (state.online.activeSourceGroupName || id));
}

async function createSourceGroup() {
  const suggested = "书源组" + ((state.online.sourceGroupDefs || []).length + 1);
  const name = await askPrompt("新建书源组", "名称", suggested);
  if (name === null) return;
  const value = String(name || "").trim();
  if (!value) return toast("书源组名称不能为空");
  const r = await api("/api/source-groups/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: value, switch: true }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error) return toast("新建失败：" + String((r && r.error) || "未知错误"));
  state.online.searchPick = [];
  await refreshSourceGroupUI();
  resetSearchForGroupChange();
  toast("已新建并切换到：" + value);
}

async function renameSourceGroup() {
  const id = state.online.activeSourceGroupId;
  if (!id) return;
  const name = await askPrompt("重命名书源组", "名称", state.online.activeSourceGroupName || "");
  if (name === null) return;
  const value = String(name || "").trim();
  if (!value) return toast("书源组名称不能为空");
  const r = await api("/api/source-groups/rename", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name: value }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error) return toast("重命名失败：" + String((r && r.error) || "未知错误"));
  await refreshSourceGroupUI();
  toast("书源组已重命名");
}

async function deleteSourceGroup() {
  const id = state.online.activeSourceGroupId;
  const active = (state.online.sourceGroupDefs || []).find((g) => g.id === id);
  if (!id || !active) return;
  if ((state.online.sourceGroupDefs || []).length <= 1) return toast("至少保留一个书源组");
  if (!(await askConfirm("删除书源组「" + active.name + "」？", "删除"))) return;
  const r = await api("/api/source-groups/delete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error) return toast("删除失败：" + String((r && r.error) || "未知错误"));
  await refreshSourceGroupUI();
  toast("书源组已删除");
}

function renderSourcePicker() {
  const box = $("searchSources");
  if (!box) return;
  // legado: 搜索只跑启用的书源，禁用的直接不出现（不是灰掉让用户点了没反应）
  const allSrc = state.online.sources;
  const list = allSrc.filter((s) => s.enabled);
  if (!allSrc.length) { box.innerHTML = '<div class="hint">没有书源，先去「书源」页导入</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="hint">没有启用的书源（共 ' + allSrc.length + ' 个，全被禁用了）—— 去「书源」页开启</div>'; return; }
  const live = new Set(list.map((s) => s.url));
  const sel = new Set((state.online.searchPick || []).filter((u) => live.has(u)));   // 书源被禁用后清掉残留勾选
  state.online.searchPick = [...sel];
  const rows = [];
  const liveGroups = state.online.sourceGroups.filter((g) => list.some((s) => (s.group || "").includes(g)));
  if (liveGroups.length) {
    rows.push('<div class="src-grid-head">按分组</div><div class="chip-row">'
      + liveGroups.map((g) => '<button class="chip" data-group="' + esc(g) + '">' + esc(g) + "</button>").join("")
      + '<button class="chip" data-group="">全部启用</button></div>');
  }
  rows.push('<div class="src-grid-head">书源（' + list.length + "，已选 " + sel.size + "）"
    + '<button id="srcPickAll" class="mini-btn">全选</button>'
    + '<button id="srcPickNone" class="mini-btn">清空</button></div>');
  rows.push('<div class="src-grid">' + list.map((s) => {
    const on = sel.has(s.url);
    return '<label class="src-cell"><input type="checkbox" data-url="'
      + esc(s.url) + '"' + (on ? " checked" : "")
      + "><span>" + esc(s.name) + "</span></label>";
  }).join("") + "</div>");
  box.innerHTML = rows.join("");
  box.querySelectorAll("input[data-url]").forEach((c) => {
    c.onchange = () => {
      const set = new Set(state.online.searchPick || []);
      if (c.checked) set.add(c.dataset.url); else set.delete(c.dataset.url);
      state.online.searchPick = [...set];
      renderSourcePicker();
    };
  });
  box.querySelectorAll("[data-group]").forEach((b) => {
    b.onclick = () => {
      const g = b.dataset.group;
      const hit = state.online.sources.filter((s) => s.enabled && (!g || (s.group || "").includes(g)));
      state.online.searchPick = hit.map((s) => s.url);
      renderSourcePicker();
    };
  });
  const all = $("srcPickAll"), none = $("srcPickNone");
  if (all) all.onclick = () => { state.online.searchPick = list.map((s) => s.url); renderSourcePicker(); };
  if (none) none.onclick = () => { state.online.searchPick = []; renderSourcePicker(); };
}

let searchSeq = 0;
let searchAbort = null;          // 需求 2：允许中途停止（legado SearchModel.close）
let searchState = { key: "", author: "", page: 1, hasMore: false, done: 0, total: 0, t0: 0 };
/* 上一次真正渲染进 #searchResults 的页码。
   用途：翻页后必须从**顶部**开始 —— 之前只换 innerHTML 不动 scrollTop，
   上一页滚到底再点「下一页」，新页一渲染就停在尾部（用户反馈漏看上面的内容）。 */
let searchRenderedPage = 0;
/* 搜索结果「按书源折叠」：书源一多（有的源一次返回上百条），整页翻页很费劲。
   搜索过程是增量渲染 —— 每回来一个源就重建一次 #searchResults，
   所以折叠状态必须存在这里，否则每次重建都会把用户收起来的分组又展开。
   只记录「已收起」的分组名（书源名）。 */
const searchCollapsedGroups = new Set();

/* 切换书源组后，上一组的搜索结果与在途搜索都不能再复用：
   否则不仅会残留旧书，翻页时还会把旧结果当成同一轮搜索的 existing 传给新组书源。 */
function resetSearchForGroupChange() {
  if (searchAbort) { try { searchAbort.abort(); } catch {} searchAbort = null; }
  searchSeq++;
  state.online.searchResults = [];
  searchState = { key: "", author: "", page: 1, hasMore: false, done: 0, total: 0, t0: 0 };
  searchRenderedPage = 0;
  searchCollapsedGroups.clear();
  const box = $("searchResults");
  if (box) box.innerHTML = '<div class="hint">已切换书源组，请重新搜索</div>';
  const pager = $("searchPager");
  if (pager) pager.classList.add("hidden");
  const progress = $("searchProgress");
  if (progress) progress.classList.add("hidden");
  const stat = $("searchStat");
  if (stat) stat.textContent = "";
  showSearchProgress(false);
}

/**
 * 需求 2：搜索过程实时可见。
 * legado 是 SearchProgressReporter + onSearchProgress 回调驱动一个进度条，
 * 桌面端没有协程流，就用 NDJSON 流式响应（body.stream=true）逐源回包，
 * 每回来一个源就往进度条和源列表里追一条，搜完再渲染结果。
 * 需求 11：翻页用「同一轮搜索」语义 —— 带上已有结果（existing）让后端 mergeItems 累加，
 * 而不是把上一页丢掉重新来一遍（legado SearchModel.search 里 searchPage++ 的行为）。
 */
async function doSearch(page) {
  const key = $("searchKey").value.trim();
  const author = ($("searchAuthor").value || "").trim();
  if (!key && !author) return toast("请输入关键词或作者");
  const p = Number(page) || 1;
  const groupAtStart = state.online.activeSourceGroupId || "";
  const sameRun = searchState.key === key && searchState.author === author && p > 1;
  /* 同轮翻页（第 2 页之后）：legado 的做法是 searchPage++ 后让每个书源再取对应页码，
     结果**累加**进同一个列表，界面不重建。这里等价为「保留当前列表 → 新页到齐后整体替换 →
     停在本页新增的第一条」。历史问题是翻页时先清空再逐源重绘，看起来像把整轮搜索重跑一遍。 */
  const appendPage = sameRun;
  const prevKeys = appendPage
    ? new Set((state.online.searchResults || []).map((b) => String(b.name || "").trim() + "|" + String(b.author || "").trim()))
    : null;
  if (p === 1 || !sameRun) {
    state.online.searchResults = [];
    searchState = { key, author, page: p, hasMore: false, done: 0, total: 0, t0: Date.now(), arrived: [] };
  } else {
    searchState.page = p;
  }
  const stRef = searchState;   // 本轮搜索的状态对象；被新搜索替换后不再回写
  state.online.searchKey = key;
  const seq = ++searchSeq;
  if (searchAbort) { try { searchAbort.abort(); } catch {} }
  const ac = new AbortController();
  searchAbort = ac;

  showSearchProgress(true);
  paintSearchProgress(0, 0, []);
  searchState.arrived = [];
  if (p === 1 || !sameRun) searchRenderedPage = 0;   // 新一轮搜索：从顶部开始
  if (p === 1 || !sameRun) searchCollapsedGroups.clear();   // 新一轮搜索：分组默认全部展开
  if (appendPage) {
    // 翻页：不动已有结果，只在结果区顶部挂一条吸顶提示（滚动到哪都看得见）
    setSearchPageBusy(p, 0, 0);
  } else {
    renderSearchIncremental(p);
    const r0 = $("searchResults");
    if (r0) r0.scrollTop = 0;
  }
  $("searchStat").textContent = "";
  if (appendPage) {
    // 翻页时保留分页条，只把它切成「加载中」并把按钮禁用，避免整条工具栏消失造成跳动
    $("searchPager").classList.remove("hidden");
    if ($("spPageInfo")) $("spPageInfo").textContent = "正在加载第 " + p + " 页…";
    if ($("spPrev")) $("spPrev").disabled = true;
    if ($("spNext")) $("spNext").disabled = true;
  } else {
    $("searchPager").classList.add("hidden");
  }

  const body = {
    key, author, page: p, precision: $("searchPrecise").checked, stream: true,
    sources: state.online.searchPick || undefined,
    existing: p > 1 ? state.online.searchResults : undefined,
  };
  const seen = [];
  let final = null;
  try {
    const res = await fetch("/api/online/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (seq !== searchSeq || (state.online.activeSourceGroupId || "") !== groupAtStart) return "aborted";
        if (m.type === "start") {
          searchState.total = m.total;
          paintSearchProgress(0, m.total, seen);
        } else if (m.type === "source") {
          searchState.done = m.done; searchState.total = m.total;
          seen.push(m);
          paintSearchProgress(m.done, m.total, seen);
          // 需求 4：不等所有源搜完 —— 这个源一回来就把它搜到的书插进结果区。
          // legado SearchModel.search 里也是每源 notifyDataSetChanged 一次。
          if (!searchState.arrived) searchState.arrived = [];
          searchState.arrived.push(m);
          if (appendPage) setSearchPageBusy(p, m.done, m.total);
          else renderSearchIncremental(p);
        } else if (m.type === "done") {
          final = m;
        }
      }
    }
  } catch (e) {
    if (seq !== searchSeq) return "aborted";
    if (e.name === "AbortError") {
      // 翻页中途停止：这一页没搜完，页码退回上一页，否则「下一页」会从 p+1 开始，把 p 整页跳过
      if (appendPage && searchState === stRef) { searchState.page = p - 1; renderSearchPager(p - 1); }
      toast("已停止搜索"); showSearchProgress(false); return "aborted";
    }
    showSearchProgress(false);
    $("searchResults").innerHTML = '<div class="hint">搜索失败：' + esc(e.message) + "</div>";
    return "error";
  }
  if (seq !== searchSeq || (state.online.activeSourceGroupId || "") !== groupAtStart) return "aborted";
  showSearchProgress(false);
  if (!final) {
    setSearchPageBusy(null);
    if (!appendPage) $("searchResults").innerHTML = '<div class="hint">搜索没有返回结果</div>';
    else { if (searchState === stRef) searchState.page = p - 1; toast("这一页没有返回结果"); renderSearchPager(searchState.page || p); }
    return "empty";
  }
  if (final.ok === false) {
    setSearchPageBusy(null);
    if (!appendPage) $("searchResults").innerHTML = '<div class="hint">搜索失败：' + esc(final.error || "未知错误") + "</div>";
    else { if (searchState === stRef) searchState.page = p - 1; toast("加载第 " + p + " 页失败：" + String(final.error || "未知错误").slice(0, 80)); renderSearchPager(searchState.page || p); }
    return "error";
  }
  setSearchPageBusy(null);
  state.online.searchResults = final.books || [];
  searchState.hasMore = final.hasMore === true;
  // 用户反馈：15 个源里只有 9 个真的搜到书，却显示「15/15 源成功」——
  // 那是「请求成功」的数量，不是「有结果」的数量。这里改成以「有结果」为主口径。
  const srcList = final.sources || [];
  const hitN = srcList.filter((x) => (x.books || []).length).length;
  const okN = srcList.filter((x) => x.ok).length;
  $("searchStat").textContent = `${state.online.searchResults.length} 本书 · ${hitN}/${srcList.length} 源有结果`
    + (okN > hitN ? ` · ${okN} 个源请求成功` : "")
    + (final.filtered ? ` · 作者过滤 ${final.filtered} 本` : "")
    + ` · 第 ${p} 页 · ${((Date.now() - searchState.t0) / 1000).toFixed(1)}s`;
  renderSearchResults(final);
  renderSearchPager(p);
  if (appendPage) focusFirstNewRow($("searchResults"), prevKeys);
}

/** 需求 2：进度区（每源一行，加载中的源逐个点亮） */
function showSearchProgress(on) {
  const el = $("searchProgress");
  if (!el) return;
  el.classList.toggle("hidden", !on);
  const st = $("searchStop");
  if (st) st.classList.toggle("hidden", !on);
}

function paintSearchProgress(done, total, seen) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const f = $("spFill");
  if (f) f.style.width = pct + "%";
  const t = $("spText");
  if (t) t.textContent = total ? `已搜索 ${done}/${total} 个书源（${pct}%）` : "正在准备书源…";
  const box = $("spSources");
  if (!box) return;
  box.innerHTML = (seen || []).map((m) => '<div class="sp-row' + (m.ok ? "" : " bad") + '">'
    + '<span class="sp-name">' + esc(m.sourceName || "") + "</span>"
    + '<span class="sp-res">' + (m.ok ? (m.count ? m.count + " 本" : "无结果") : "失败：" + esc(String(m.error || "").slice(0, 60)))
    + "</span>"
    + '<span class="sp-time">' + (m.respondTime ? m.respondTime + "ms" : "") + "</span></div>").join("");
}

/**
 * 同轮翻页时的吸顶提示：「正在加载第 2 页…（已返回 3 / 15 个书源）」。
 * 挂在 #searchResults 顶部并用 position:sticky，列表多长都看得见，
 * 不会像以前那样把整页结果换成一个「已累计的上一页结果」占位组。
 * 传 null 表示撤掉提示。
 */
function setSearchPageBusy(page, done, total) {
  const box = $("searchResults");
  if (!box) return;
  let el = document.getElementById("srLoadMore");
  if (page == null) { if (el) el.remove(); return; }
  if (!el || !box.contains(el)) {
    el = document.createElement("div");
    el.id = "srLoadMore";
    el.className = "sr-loadmore";
    box.insertBefore(el, box.firstChild);
  }
  el.innerHTML = '<span class="sr-spin"></span>正在加载第 ' + page + " 页…"
    + (total ? "（已返回 " + (Number(done) || 0) + " / " + total + " 个书源）" : "");
}

/**
 * 翻页后定位到「本页新增的第一条」。legado 的搜索列表是累加的，翻页只会把新结果接在后面；
 * 之前统一滚到 scrollTop=0 会把人送回第一页开头，所以这里只滚到新内容起点，
 * 并沿用 140ms 淡入（减少动态效果时关掉）。
 */
function focusFirstNewRow(box, prevKeys) {
  if (!box || !prevKeys) return;
  let target = null;
  for (const row of box.querySelectorAll(".res-row")) {
    const btn = row.querySelector('[data-act="read"]');
    if (!btn) continue;
    let b = null;
    try { b = JSON.parse(decodeURIComponent(btn.dataset.book)); } catch (e) { continue; }
    const k = String((b && b.name) || "").trim() + "|" + String((b && b.author) || "").trim();
    if (!prevKeys.has(k)) { target = row; break; }
  }
  if (target) {
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 6;
    box.scrollTop = Math.max(0, top);
  }
  let reduce = false;
  try { reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}
  if (reduce) return;
  box.classList.remove("list-swap-in");
  void box.offsetWidth;
  box.classList.add("list-swap-in");
}

/** 需求 11：搜索分页条 */
function renderSearchPager(page) {
  const box = $("searchPager");
  if (!box) return;
  const canPrev = page > 1;
  // 用户反馈：没有更多结果时「下一页」仍然可点，点完发现是空的。
  // 这里把上界接到本轮搜索的 hasMore（= 本轮至少有一个源在本页返回了书），
  // 与 legado SearchActivity 一致：只有 hasMore 为 true 才继续 searchPage++。
  const canNext = page < 200 && searchState.hasMore === true;
  box.classList.remove("hidden");
  $("spPageInfo").textContent = "第 " + page + " 页 · 累计 " + state.online.searchResults.length + " 本"
    + (searchState.hasMore ? "" : " · 已全部加载");
  $("spPrev").disabled = !canPrev || searchState.loadingAll === true;
  $("spNext").disabled = !canNext;
  $("spPrev").onclick = () => { if (canPrev) doSearch(page - 1); };
  $("spNext").onclick = () => { if (canNext) doSearch(page + 1); };
  const allBtn = $("spAll");
  if (allBtn) {
    allBtn.disabled = !canNext || searchState.loadingAll === true;
    allBtn.textContent = searchState.loadingAll ? "加载中…" : "加载全部";
    allBtn.onclick = () => { if (!allBtn.disabled) loadAllSearchPages(page); };
  }
}

/**
 * 「加载全部」：把后续页一次拉完。
 * legado 本体是懒加载 —— SearchActivity 只有在滚动到底、上一页搜完且 hasMore 时才 searchPage++，
 * 每次仍然要向所有书源发一次请求（书源的分页就是靠这个 page 参数）。
 * 这里只是把这个「翻到底」的动作自动化：一页一页顺序请求，直到 hasMore 变 false。
 * 设 20 页上限，避免无限翻页触发书源风控 / 长时间卡住；过程中随时可以点「停止」中断。
 */
async function loadAllSearchPages(startPage) {
  if (searchState.loadingAll) return;
  const st = searchState;
  st.loadingAll = true;
  renderSearchPager(startPage);
  let reachedCap = false;
  try {
    let p = startPage + 1;
    const MAX_PAGE = 20;
    while (searchState === st && st.hasMore === true && p <= MAX_PAGE) {
      const before = state.online.searchResults.length;
      const r = await doSearch(p);
      if (searchState !== st || r === "aborted" || st.page !== p) break;
      // 有的书源（光遇聚合这类）不管 page 是几都回全量结果，hasMore 永远是 true。
      // 这一页没带来任何新书就说明翻下去也不会多，直接停，避免空转 20 页。
      if (state.online.searchResults.length <= before) break;
      p = st.page + 1;
      if (p > MAX_PAGE) reachedCap = true;
    }
  } finally {
    if (searchState === st) {
      st.loadingAll = false;
      renderSearchPager(st.page || startPage);
    }
    if (reachedCap) toast("已连续加载到上限，如还需更多请再点一次「加载全部」");
  }
}

/** 结果按来源分组（legado「按源显示」的等价物） */
/** 结果区按钮统一收口（搜索结果 / 发现页 / 增量渲染三处共用） */
function bindResultActions(box) {
  box.querySelectorAll("[data-act]").forEach((el) => {
    el.onclick = () => {
      const b = JSON.parse(decodeURIComponent(el.dataset.book));
      if (el.dataset.act === "read") readOnlineBook(b);
      else if (el.dataset.act === "add") addOnlineBook(b);
      else if (el.dataset.act === "detail") openBookDetail(b);
      else if (el.dataset.act === "swap") {
        const cur = getCurrentBookMeta();
        if (cur) swapTo(cur, b); else openChangeSource(b);
      }
    };
  });
}

/**
 * 需求 4：搜索过程即时可见 —— 哪个书源先返回，就先把它搜到的书显示出来。
 * 依据 legado SearchModel.search()：每个源完成时各自 notifyDataSetChanged 一次，
 * 不等全部源结束，所以响应快的源在界面上先出来。
 *   - 源之间按 respondTime 升序排列（快的在上）
 *   - 书按 name + author 去重（与合并逻辑一致），翻页时保留上一页已累计的结果
 *   - 仍在搜索中的源显示为占位行，条数 = 总源数 - 已返回源数
 */
function renderSearchIncremental(page) {
  const box = $("searchResults");
  if (!box) return;
  // 换页 → 列表从头看起（同一页内增量刷新时保留用户当前位置，不打断浏览）
  const pageChanged = Number(page) !== searchRenderedPage;
  const keyOf = (b) => String(b.name || "").trim() + "|" + String(b.author || "").trim();
  const used = new Set();
  const groups = [];
  const total = Number(searchState.total) || 0;
  const arrived = searchState.arrived || [];

  // 翻页时上一页的累计结果先垫底，避免眼前一空（后端 mergeItems 也只增不减）
  if (page > 1 && state.online.searchResults.length) {
    const prev = [];
    for (const b of state.online.searchResults) {
      const k = keyOf(b);
      if (used.has(k)) continue;
      used.add(k); prev.push(b);
    }
    if (prev.length) groups.push({ name: "已累计的上一页结果", books: prev, rt: -1 });
  }

  const sorted = arrived.slice().sort((a, b) => (Number(a.respondTime) || 0) - (Number(b.respondTime) || 0));
  for (const m of sorted) {
    const books = [];
    for (const b of m.books || []) {
      const k = keyOf(b);
      if (used.has(k)) continue;
      used.add(k); books.push(b);
    }
    groups.push({ name: m.sourceName || m.sourceUrl || "未知书源", books: sortBySourcePriority(books), rt: Number(m.respondTime) || 0, ok: m.ok !== false, error: m.error });
  }

  const hit = groups.filter((g) => g.books.length);
  const parts = [];
  // 失败信息同样放最上面，跟最终结果页保持一致
  // 需求：恢复「未搜索到 / 失败」的书源显示 —— 请求成功但 0 本的源之前被静默吞掉。
  parts.push(missBlock(
    arrived.filter((m) => m.ok === false)
      .map((m) => ({ sourceName: m.sourceName || m.sourceUrl || "", error: m.error })),
    arrived.filter((m) => m.ok !== false && !(m.books || []).length)
      .map((m) => ({ sourceName: m.sourceName || m.sourceUrl || "" })),
  ));
  const pending = Math.max(0, total - arrived.length);
  if (pending > 0) {
    parts.push('<div class="sr-pending"><span class="sr-spin"></span>搜索中… 还有 ' + pending + " 个书源没返回"
      + "（已返回 " + arrived.length + " / " + total + "）</div>");
  }
  if (!hit.length) {
    parts.push('<div class="hint" style="padding:8px 0">' + (pending > 0 ? "还没搜到，继续等…" : "没有搜到结果") + "</div>");
  }
  for (const g of groups) {
    if (!g.books.length) continue;
    parts.push(resGroupHtml(g.name, g.books, g.rt));
  }
  box.innerHTML = parts.join("");
  bindResultActions(box);
  bindResGroupToggles(box);
  syncSearchGroupBar();
  if (pageChanged) { searchRenderedPage = Number(page); scrollToTopSmooth(box); }
}

/**
 * 用户需求：搜索结果栏按书源「展开 / 收起」。
 * 有的源一次返回上百本，整页往下翻很久，点分组头就能把整组收起来。
 * 配合工具条的「收起全部 / 展开全部」快速跳过不关心的书源。
 * 分组名用 encodeURIComponent 放进 data-rg，避免书名/源名里的引号破坏属性。
 */
function resGroupHtml(name, books, rt) {
  const key = String(name || "未知书源");
  const collapsed = searchCollapsedGroups.has(key);
  const head = '<div class="res-head' + (collapsed ? " collapsed" : "") + '" data-rg="'
    + encodeURIComponent(key) + '" title="点击展开 / 收起该来源的结果">'
    + '<span class="res-caret">' + (collapsed ? "▶" : "▼") + "</span>"
    + '<span class="res-gname">' + esc(key) + "</span>"
    + '<span class="res-n">' + books.length + " 本</span>"
    + (rt > 0 ? '<span class="res-rt">' + rt + "ms</span>" : "")
    + "</div>";
  const rows = books.map((b) => resultRow(b)).join("");
  return '<div class="res-group' + (collapsed ? " collapsed" : "") + '">' + head
    + '<div class="res-body">' + rows + "</div></div>";
}

/** 只切当前这一组：不重建列表，避免滚动位置跳动和封面重新加载 */
function bindResGroupToggles(box) {
  box.querySelectorAll(".res-head[data-rg]").forEach((h) => {
    h.onclick = () => {
      const key = decodeURIComponent(h.dataset.rg);
      const group = h.parentElement;
      const collapsed = group.classList.toggle("collapsed");
      h.classList.toggle("collapsed", collapsed);
      if (collapsed) searchCollapsedGroups.add(key); else searchCollapsedGroups.delete(key);
      const caret = h.querySelector(".res-caret");
      if (caret) caret.textContent = collapsed ? "▶" : "▼";
      syncSearchGroupBar();
    };
  });
}

/** 工具条：显示分组数与已收起数，并同步两个按钮的可用态 */
function syncSearchGroupBar() {
  const bar = $("searchGroupBar");
  const box = $("searchResults");
  if (!bar || !box) return;
  const groups = box.querySelectorAll(".res-group");
  if (!groups.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const collapsedN = box.querySelectorAll(".res-group.collapsed").length;
  const st = $("sgText");
  if (st) st.textContent = "共 " + groups.length + " 个书源结果"
    + (collapsedN ? " · 已收起 " + collapsedN + " 个" : "");
  const ca = $("sgCollapseAll");
  const ea = $("sgExpandAll");
  if (ca) ca.disabled = collapsedN === groups.length;
  if (ea) ea.disabled = collapsedN === 0;
}

function applyAllGroups(collapse) {
  const box = $("searchResults");
  if (!box) return;
  box.querySelectorAll(".res-group").forEach((g) => {
    const head = g.querySelector(".res-head[data-rg]");
    if (!head) return;
    const key = decodeURIComponent(head.dataset.rg);
    g.classList.toggle("collapsed", collapse);
    head.classList.toggle("collapsed", collapse);
    if (collapse) searchCollapsedGroups.add(key); else searchCollapsedGroups.delete(key);
    const caret = head.querySelector(".res-caret");
    if (caret) caret.textContent = collapse ? "▶" : "▼";
  });
  syncSearchGroupBar();
}

if ($("sgCollapseAll")) $("sgCollapseAll").onclick = () => applyAllGroups(true);
if ($("sgExpandAll")) $("sgExpandAll").onclick = () => applyAllGroups(false);
/**
 * 聚合书源（光遇聚合这类）一次搜索会返回多个平台（番茄 / 七猫 / 书旗…）的同名书。
 * ruleSearch.lastChapter 是 `{{$.source}} {{$.last_chapter_title}}`，平台名就在
 * latestChapterTitle 开头；bookUrl 的 base64（{"type":"gydetail"}）里也带 sources 字段。
 * 番茄平台的条目信息最全（封面 / 字数 / 完结状态），所以照用户要求优先排在最上面。
 */
const PLATFORM_PRIORITY = ["番茄"];
function bookPlatform(b) {
  const u = String((b && b.bookUrl) || "");
  if (!u.startsWith("data:") || u.indexOf("gydetail") < 0) return "";
  const m = /^data:;base64,([A-Za-z0-9+/=_-]+)/.exec(u);
  if (m) {
    try {
      const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const j = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      const s = String((j && (j.sources || j.source)) || "");
      if (s) return s;
    } catch (e) { /* base64 解不出来就退回 latestChapterTitle */ }
  }
  const t = String((b && b.latestChapterTitle) || "");
  return PLATFORM_PRIORITY.find((p) => t === p || t.startsWith(p + " ")) || "";
}
/**
 * 组内排序 —— 先按 legado SearchModel.mergeItems 的分桶顺序（等值 > 标签 > 包含 > 其他），
 * 同一档再按平台优先级（番茄最前），最后保持原顺序。
 *
 * 历史问题：只按平台排序，于是「我不是戏神：杀青小剧场」（番茄）会盖过
 * 书名与关键词完全相同的《我不是戏神》——因为后者 latestChapterTitle 是「伪69」拿不到平台，
 * 被 rank=50 垫到了组尾。用户反馈「最准确的结果没排在最前面」指的就是这个。
 */
function relevanceTier(b, key) {
  const k = String(key || "").trim();
  if (!k) return 3;
  const name = String((b && b.name) || "");
  const author = String((b && b.author) || "");
  if (name === k || author === k) return 0;
  if (b && b.kind && String(b.kind).includes(k)) return 1;
  if (name.includes(k) || author.includes(k)) return 2;
  return 3;
}
function sortBySourcePriority(books) {
  const list = books || [];
  if (list.length < 2) return list;
  const key = (state.online && state.online.searchKey)
    || (typeof searchState !== "undefined" && searchState && searchState.key) || "";
  const rank = (b) => {
    const p = bookPlatform(b);
    if (!p) return 50;                 // 拿不到平台的垫底
    const i = PLATFORM_PRIORITY.indexOf(p);
    return i < 0 ? 20 : i;             // 已知平台优先，番茄最前
  };
  return list.map((b, i) => ({ b, i }))
    .sort((x, y) => (relevanceTier(x.b, key) - relevanceTier(y.b, key))
      || (rank(x.b) - rank(y.b)) || (x.i - y.i))
    .map((x) => x.b);
}

function renderSearchResults(r) {
  const box = $("searchResults");
  const fails = r.errors || [];
  // 「请求成功但没有一本」的源：要跟失败源一起列在结果上方，别让用户以为没搜过这个源。
  const empties = (r.sources || []).filter((s) => s.ok !== false && !(s.books || []).length)
    .map((s) => ({ sourceName: s.sourceName || s.sourceUrl || "" }));
  if (!state.online.searchResults.length) {
    box.innerHTML = missBlock(fails, empties) + '<div class="hint">没有搜到结果</div>';
    return;
  }
  const groups = new Map();
  for (const b of state.online.searchResults) {
    const k = b.originName || b.origin || "未知来源";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  // 失败信息放最上面：结果列表可能很长，放末尾要翻到底才看得到
  const parts = [missBlock(fails, empties)];
  for (const [name, books] of groups) {
    parts.push(resGroupHtml(name, sortBySourcePriority(books), 0));
  }
  box.innerHTML = parts.join("");
  bindResultActions(box);
  bindResGroupToggles(box);
  syncSearchGroupBar();
}

function failBlock(fails) { return missBlock(fails, []); }

/**
 * 搜索「没有结果」的书源清单 —— 恢复用户反馈里丢掉的「未搜索到 / 失败」行。
 * legado SearchModel 的 SearchProgressReporter 对每个源都会留一条状态：
 *   有结果 → 列表条目；无结果 / 失败 → 也保留一条状态，用户能看到哪个源哑了。
 * 之前只渲染了失败源、且只渲染有结果的分组，于是「请求成功但 0 本」的源被吞掉。
 */
function missBlock(fails, empties) {
  const f = fails || [];
  const e = empties || [];
  if (!f.length && !e.length) return "";
  const title = (e.length && f.length)
    ? e.length + " 个书源无结果 · " + f.length + " 个失败"
    : (e.length ? e.length + " 个书源无结果" : f.length + " 个书源失败");
  let html = '<details class="res-fails"><summary>' + title + "</summary>";
  for (const x of e) html += '<div class="res-miss-row">' + esc(x.sourceName || "") + "：未搜索到结果</div>";
  for (const x of f) html += '<div class="res-miss-row">' + esc(x.sourceName || "") + "：失败 " + esc(String(x.error || "").slice(0, 160)) + "</div>";
  return html + "</details>";
}

/**
 * 搜索结果行 —— 版式照 legado res/layout/item_search.xml：
 *   左封面 80x110 ｜ 右：书名16sp +「作者：」+ 标签行（红底白字圆角）+「最新：」+「简介：」
 * 标签内容走 BaseBook.getKindList()（字数 + kind 切分），跟 legado 一字不差。
 * 右侧按钮是本项目桌面端加的操作入口（legado 是长按菜单），不占 legado 的版式位置。
 */
function resultRow(b) {
  const enc = encodeURIComponent(JSON.stringify(b));
  const n = (b.origins && b.origins.length) || 1;
  const labels = kindList(b);
  const intro = String(b.intro || "").replace(/\s+/g, " ").trim();
  let html = '<div class="res-row">';
  html += '<div class="res-cover">' + coverHtml(b, "res-img") + "</div>";
  html += '<div class="res-main">';
  html += '<div class="res-name">' + esc(b.name)
    + (n > 1 ? '<span class="res-badge">' + n + " 个来源</span>" : "") + "</div>";
  html += '<div class="res-author">作者：' + esc(b.author || "佚名") + "</div>";
  if (labels.length) {
    html += '<div class="res-labels">' + labels.slice(0, 6).map((s) => '<span class="res-label">' + esc(s) + "</span>").join("") + "</div>";
  }
  if (b.latestChapterTitle) html += '<div class="res-latest">最新：' + esc(b.latestChapterTitle) + "</div>";
  if (intro) html += '<div class="res-intro">简介：' + esc(intro) + "</div>";
  html += "</div>";
  // 「阅读」本身就会把书加入书架（readOnlineBook → addOnlineBook），
  // 搜索结果行 / 发现页结果行不再单独留一个「加入书架」，要入架直接点阅读，要移除去详情页。
  html += '<div class="res-btns">'
    + '<button class="mini-btn" data-act="read" data-book="' + enc + '">阅读</button>'
    + '<button class="mini-btn" data-act="detail" data-book="' + enc + '">详情</button>'
    + '<button class="mini-btn only-online" data-act="swap" data-book="' + enc + '">换源</button>'
    + "</div></div>";
  return html;
}

function getCurrentBookMeta() {
  if (state.mode !== "online") return null;
  const b = state.book;
  if (b && b.origin && b.bookUrl) {
    return { name: b.name, author: b.author, origin: b.origin, bookUrl: b.bookUrl, originName: b.originName };
  }
  // 兜底：页面刷新后 state.book 还没恢复，但 localStorage 记着上次读的那本
  let rel = null;
  try { rel = localStorage.getItem("lastOnlineRel"); } catch (e) { }
  const sb = rel ? findOnlineByRel(rel) : null;
  if (sb) return { name: sb.name, author: sb.author, origin: sb.origin, bookUrl: sb.bookUrl, originName: sb.originName };
  return null;
}

async function addOnlineBook(b) {
  const r = await api("/api/online/shelf/add", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ book: b })
  }).catch((e) => { toast("加入失败：" + e.message); return null; });
  if (!r) return;
  toast(r.duplicated ? "已在书架中" : "已加入书架");
  await refreshOnlineShelf();
  if (state.mode === "online") renderBooks();
  // 返回「书架上那条记录」。服务端按 书名+作者 去重：搜索结果里的另一本书源点阅读时，
  // 入架会命中已有条目，这时必须用返回的条目（origin/bookUrl 与搜索结果不同），
  // 否则前端拿搜索结果的 origin 拼 rel，findOnlineByRel 落空 → 正文接口解析不到书源。
  if (r.book) return findOnlineByRel(okey(r.book.origin, r.book.bookUrl)) || r.book;
  return shelfBookByMeta(b);
}

/**
 * 按「书名 + 作者」在书架里找条目，判据与服务端 /api/online/shelf/add 的去重逻辑一致
 * （legado SearchAdapter.areItemsTheSame：书名 + 作者相同即同一本；作者缺失时退化只比书名）。
 */
function shelfBookByMeta(b) {
  if (!b) return null;
  const n = String(b.name || "").trim();
  if (!n) return null;
  const a = String(b.author || "").trim();
  return (state.online.books || []).find((x) => {
    if (String(x.name || "").trim() !== n) return false;
    const xa = String(x.author || "").trim();
    if (!xa || !a) return true;
    return xa === a;
  }) || null;
}

/**
 * 把左侧书架栏翻到「包含这本书」的那一页。
 * legado 的书架是 RecyclerView + keepScrollPosition，条目插入后不需要手动滚；
 * 我们是分页列表，翻页必须自己算，否则正文换了、书架还停在原来那页，看不到高亮。
 * 页序以 visibleBooks() 为准（含筛选与排序），保证和界面上看到的顺序一致。
 */
function syncShelfPageToBook(b) {
  if (state.mode !== "online" || !b) return;
  const rel = b.rel || okey(b.origin, b.bookUrl);
  // 先重绘一次：renderBooks() 会按当前窗口高度反推出「一页几本」，
  // 刚切模式时 state.bookPerPage 可能还是本地模式的旧值。
  renderBooks();
  let list = visibleBooks();
  let pos = list.findIndex((x) => x.rel === rel);
  if (pos < 0 && state.filter) {
    // 书架搜索框把这个词挡住了 —— 书就在架子上，清掉筛选让它露出来
    state.filter = "";
    if ($("bookFilter")) $("bookFilter").value = "";
    list = visibleBooks();
    pos = list.findIndex((x) => x.rel === rel);
  }
  if (pos < 0) return;                       // 确实不在书架里（加入失败等），不动分页
  const per = state.bookPerPage || BK_PER_PAGE;
  const page = Math.floor(pos / per) + 1;
  if (page !== state.bookPage) {
    state.bookPage = page;
    renderBooks();
  }
}

async function readOnlineBook(b) {
  const meta = getCurrentBookMeta();
  if (meta && meta.name === b.name && meta.origin !== b.origin) {
    // 同名不同源：legado 是直接开新书，这里给出换源选择
    if (await askConfirm("《" + b.name + "》已在读（来源：" + (meta.originName || "当前源") + "），要换到「" + (b.originName || b.origin) + "」并保留阅读进度吗？", "换源")) {
      return swapTo(meta, b);
    }
  }
  // 阅读入口可能在搜索面板 / 发现结果面板 / 详情页里。legado 点「阅读」是 Activity 跳转，
  // 列表页直接 finish；我们这里是面板叠层，不收起的话正文虽然换了，屏幕上还盖着结果列表，
  // 看起来就是「点了阅读没跳过去」。tocModal 不在 PANELS 里，由它自己的关闭逻辑处理。
  closePanels();
  if (state.mode !== "online") {
    setMode("online", { silent: true });
    // silent 模式不会走 enterMode()：state.books 会停留在本地书形状，
    // 书架渲染和下面的分页定位都会算错，所以这里补一次完整进入。
    await enterMode();
  }
  // 搜索结果里的书可能和书架已有条目「同名同作者但不同源」——服务端会去重并返回书架那条。
  // 必须用返回的条目打开，否则 rel 用搜索结果的 origin 拼，正文接口找不到书源（EISDIR 的由来）。
  let target = findOnlineByRel(okey(b.origin, b.bookUrl));
  if (!target) target = await addOnlineBook(b);
  target = target || shelfBookByMeta(b) || b;
  // 抓目录可能要几十秒。分页先校一次，让左侧立刻跳到这本书所在的那页并高亮；
  // openBook 之后再校一次（bookPerPage 那时已按最新数据算过）。
  syncShelfPageToBook(target);
  await openBook(toLocalShape(target));
  // 正文已打开，左侧书架栏同步翻到这本书所在的那页
  syncShelfPageToBook(findOnlineByRel(target.rel || okey(target.origin, target.bookUrl)) || target);
}

/**
 * 换源。照 legado ReadBookViewModel.changeTo()（ReadBookViewModel.kt:285-303）：
 *   oldBook.migrateTo(newBook, toc) → oldBook.delete() → insert(newBook) → loadContent()
 * 关键就是「旧书被删掉、新书插进来」——只 openBook 新链接而把旧书留在书架，
 * 阅读器下一轮 refreshOnlineShelf/restore 又会按旧记录抓正文，表现就是「换源之后还没变」。
 * 所以真活儿放在后端 /api/online/changeSource：抓新目录 → 映射章节 → 删旧插新 → 搬进度。
 */
async function swapTo(meta, b) {
  const oldRel = meta ? okey(meta.origin, meta.bookUrl) : "";
  const oldP = (oldRel && onlineProgress[oldRel]) || { chapter: state.chapterIdx, scroll: 0, total: 0 };
  // 正在读这本书：以阅读器的实时章号为准（legado 用的就是 ReadBook.book.durChapterIndex）
  const isCurrent = !!(state.book && oldRel && state.book.rel === oldRel);
  const oldChapterIndex = isCurrent ? state.chapterIdx : (oldP.chapter || 0);
  const oldChapterTitle = (isCurrent && state.book && state.book.chapters && state.book.chapters[state.chapterIdx])
    ? state.book.chapters[state.chapterIdx].title : (meta && meta.durChapterTitle) || "";
  const oldTotal = (isCurrent && state.book && state.book.chapterCount) || oldP.total || 0;
  $("panelSearch").classList.add("hidden");
  $("panelExploreResult") && $("panelExploreResult").classList.add("hidden");
  if (state.mode !== "online") setMode("online", { silent: true });
  toast("正在换源到「" + (b.originName || b.origin) + "」，抓取新目录…");
  let r;
  try {
    r = await api("/api/online/changeSource", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oldOrigin: meta ? meta.origin : "", oldBookUrl: meta ? meta.bookUrl : "",
        // 书名/作者兜底：服务端启动修复可能改写过旧记录的 origin，
        // 只按 origin+bookUrl 查会落空 → 删不掉旧记录，书架留两条同名书。
        oldName: (meta && meta.name) || b.name || "",
        oldAuthor: (meta && meta.author) || b.author || "",
        oldChapterIndex, oldChapterTitle, oldTotalChapterNum: oldTotal,
        newBook: {
          origin: b.origin, bookUrl: b.bookUrl, originName: b.originName,
          name: b.name, author: b.author, kind: b.kind, coverUrl: b.coverUrl,
          intro: b.intro, latestChapterTitle: b.latestChapterTitle, variable: b.variable,
        },
      }),
    });
  } catch (e) { return toast("换源失败：" + e.message); }
  if (!r || r.ok === false) return toast("换源失败：" + ((r && r.error) || "未知错误"));
  delete onlineProgress[oldRel];
  await refreshOnlineShelf();
  const nb = findOnlineByRel(okey(r.book.origin, r.book.bookUrl)) || r.book;
  const target = toLocalShape(nb);
  target._p = { chapter: r.chapter, scroll: 0, total: r.chapters, at: Date.now() };
  onlineProgress[target.rel] = target._p;
  // 目录已由后端写好缓存，openBook 会直接命中；_startIdx 让它落到映射后的那一章
  target._startIdx = r.chapter;
  await openBook(target, { keepChapter: false });
  // 换源是「删旧插新」，新书会排到书架末尾 —— 不跟着翻页的话左侧还停在旧书那页
  syncShelfPageToBook(nb);
  toast("已换源到 " + (nb.originName || nb.origin) + "：" + r.chapterTitle);
}

/* ============================================================
 *  需求 7：书籍详情页 + 需求 5a：换源
 *  对应 legado ui/book/info/BookInfoActivity.kt 与 ui/book/changesource/
 * ============================================================ */

let biBook = null;          // 当前详情页展示的书（在线形状）
let csBook = null;          // 换源基准书
let biRequestSeq = 0;
let shelfManageReturn = false;
// 详情页的上一层窗口（搜索 / 发现结果 / 书源列表…）：✕ 关闭详情时要还原这一层，
// 而不是一律退回阅读主体 —— 详情页不只有书架栏一个入口。
let biReturnPanel = null;

/** 还原详情页下面那一层窗口（书架管理还要重绘一遍列表） */
function restorePanel(id) {
  if (!id) return;
  if (id === "shelfManageModal") {
    $("shelfManageModal")?.classList.remove("hidden");
    renderShelfManage();
    return;
  }
  $(id)?.classList.remove("hidden");
}

/**
 * 详情页能从多个入口打开（书架右键 / 书架管理 / 搜索 / 发现结果 / 书源列表），
 * 这里记下「打开详情页之前」可见的那一层，关闭时原样还原。
 */
function captureBiReturnPanel() {
  if (shelfManageReturn) return "shelfManageModal";
  for (const id of ["panelSearch", "panelExploreResult", "panelExplore", "panelSources", "panelReplace"]) {
    const el = $(id);
    if (el && !el.classList.contains("hidden")) return id;
  }
  return null;
}

function closePanel(id, options = {}) {
  const panel = $(id);
  if (!panel) return;
  if (id === "panelBookInfo") {
    biRequestSeq++;
    panel.classList.add("hidden");
    const restore = options.restoreShelfManage === false
      ? null
      : (biReturnPanel || (shelfManageReturn ? "shelfManageModal" : null));
    biReturnPanel = null;
    shelfManageReturn = false;
    restorePanel(restore);
    return;
  }
  panel.classList.add("hidden");
}

/** 这本书是不是已经在书架里了 —— 决定详情页显示「放入书架」还是「删除书籍」 */
function inShelf(b) {
  if (!b || !b.origin || !b.bookUrl) return null;
  const k = okey(b.origin, b.bookUrl);
  return (state.online.books || []).find((x) => okey(x.origin, x.bookUrl) === k) || null;
}

/**
 * 书籍详情页 —— 照 legado ui/book/info/BookInfoActivity：
 *   showBook() 先铺基础信息 → getBookInfoAwait 抓详情 → updateBookInfo 刷新
 *   upTvBookshelf() 依据 viewModel.inBookshelf 切换「放入书架 / 删除书籍」
 */
async function openBookDetail(b, options = {}) {
  if (!b || !b.origin || !b.bookUrl) return toast("这本书缺少书源信息");
  if (!options.fromShelfManage) shelfManageReturn = false;
  if (options.fromShelfManage) biReturnPanel = "shelfManageModal";
  else if ("returnPanel" in options) biReturnPanel = options.returnPanel || null;
  else biReturnPanel = captureBiReturnPanel();
  const requestSeq = ++biRequestSeq;
  $("panelBookInfo").classList.remove("hidden");
  $("panelSearch").classList.add("hidden");
  biBook = b;
  const q = "origin=" + encodeURIComponent(b.origin) + "&url=" + encodeURIComponent(b.bookUrl);
  $("biHead").textContent = "书籍详情";
  $("biName").textContent = b.name || "加载中…";
  $("biAuthor").textContent = b.author || "佚名";
  $("biOrigin").textContent = b.originName || b.origin || "";
  $("biLatest").textContent = b.latestChapterTitle || "暂无最新章节";
  $("biTocBrief").textContent = "正在抓取目录…";
  $("biIntro").textContent = "正在抓取详情…";
  $("biTags").innerHTML = "";
  paintBiCover(b);
  bindBiButtons();

  let info = b;
  try {
    const r = await api("/api/online/book?" + q);
    if (requestSeq !== biRequestSeq || $("panelBookInfo").classList.contains("hidden")) return;
    if (r && r.book) info = Object.assign({}, b, r.book);
    else if (r && r.ok === false) toast(r.error || "详情抓取失败");
  } catch (e) { toast("详情抓取失败：" + e.message); }
  biBook = info;
  $("biHead").textContent = info.name || "书籍详情";
  $("biName").textContent = info.name || b.name || "（无书名）";
  $("biAuthor").textContent = info.author || "佚名";
  $("biOrigin").textContent = info.originName || info.origin || "";
  $("biLatest").textContent = info.latestChapterTitle || "暂无最新章节信息";
  // 标签行 = BaseBook.getKindList()（字数 + kind 切分）
  const labels = kindList(info);
  $("biTags").innerHTML = labels.map((s) => '<span class="bi-tag">' + esc(s) + "</span>").join("");
  $("biIntro").textContent = info.intro || "简介：暂无简介";
  paintBiCover(info);
  bindBiButtons();   // 详情到手后按钮上的书变了，重新绑一次

  try {
    // 目录命中前端缓存就不再传几 MB；详情页每次打开都重抓一遍纯属浪费
    const _tocKey = b.rel || okey(b.origin, b.bookUrl);
    const _tocHit = onlineTocCacheGet(_tocKey);
    const r = _tocHit ? { ok: true, chapters: _tocHit.chapters } : await api("/api/online/chapters?" + q + "&timeout=150000");
    if (requestSeq !== biRequestSeq || $("panelBookInfo").classList.contains("hidden")) return;
    const chs = (r && r.chapters) || [];
    if (!chs.length) {
      $("biTocBrief").textContent = (r && r.error) || "没有解析到章节";
      return;
    }
    // 统一成阅读页用的形状（带 idx），否则写进缓存后 renderToc / markTocActive 会失灵
    const mappedChs = chs.map((c, i) => ({ title: c.title || ("第 " + (i + 1) + " 章"), idx: i, url: c.url, isVip: !!c.isVip, isPay: !!c.isPay }));
    info.chapters = mappedChs;
    info.totalChapterNum = mappedChs.length;
    if (!info.latestChapterTitle) info.latestChapterTitle = mappedChs[mappedChs.length - 1].title;
    onlineTocCachePut(_tocKey, info, mappedChs);
    biBook = info;
    $("biLatest").textContent = info.latestChapterTitle || "暂无最新章节信息";
    // 右栏只留简介：目录列表移到左栏「查看目录」弹窗（openTocModal）
    $("biTocBrief").textContent = "共 " + chs.length + " 章";
  } catch (e) {
    $("biTocBrief").textContent = "目录抓取失败";
  }
}

function paintBiCover(b) {
  const box = $("biCover");
  if (b && b.coverUrl) {
    box.innerHTML = '<img src="/api/online/image?url=' + encodeURIComponent(b.coverUrl)
      + '" alt="" onerror="this.replaceWith(document.createTextNode(\'无封面\'))">';
  } else box.textContent = String((b && b.name) || "?").slice(0, 2);
}

/**
 * 需求 2：按钮态跟书架保持一致 —— legado BookInfoActivity.upTvBookshelf()
 *   在书架 → 「删除书籍」，点了 deleteBook()；不在 → 「放入书架」，点了 addToBookshelf()
 */
function bindBiButtons() {
  $("biRead").onclick = () => { closePanel("panelBookInfo"); readOnlineBook(biBook); };
  const add = $("biAdd");
  const cur = inShelf(biBook);
  add.textContent = cur ? "删除书籍" : "放入书架";
  add.classList.toggle("on", !!cur);
  add.onclick = async () => {
    const now = inShelf(biBook);
    if (now) {
      await removeOnlineBook(now);
      if (biBook) Object.assign(biBook, {});
    } else {
      await addOnlineBook(biBook);
    }
    bindBiButtons();
  };
  $("biSwap").onclick = () => openChangeSource(biBook);
  const ex = $("biExport");
  const noExp = !!(biBook && sourceNoExport(biBook.origin));
  ex.disabled = noExp;
  ex.title = noExp ? "该书源禁止导出 TXT 小说（站点风控会封 IP）" : "把整本导出为 TXT";
  ex.classList.toggle("off", noExp);
  ex.onclick = () => { if (noExp) return toast("该书源禁止导出 TXT 小说（站点风控会封 IP）"); exportOnlineBook(biBook); };
  // 需求 1：左栏「查看目录」和目录区「查看完整目录」都打开目录弹窗，不再跳去阅读页
  $("biTocView").onclick = () => openTocModal();
  $("biReload").onclick = async () => {
    await api("/api/online/book?origin=" + encodeURIComponent(biBook.origin)
      + "&url=" + encodeURIComponent(biBook.bookUrl) + "&refresh=1").catch(() => {});
    await api("/api/online/chapters?origin=" + encodeURIComponent(biBook.origin)
      + "&url=" + encodeURIComponent(biBook.bookUrl) + "&refresh=1&timeout=150000").catch(() => {});
    onlineTocCacheDrop(biBook.rel || okey(biBook.origin, biBook.bookUrl));
    toast("已重新抓取");
    openBookDetail(biBook, { fromShelfManage: shelfManageReturn, returnPanel: biReturnPanel });
  };
}

/* ============================================================
 *  需求 1：完整目录弹窗
 *  详情页左栏「查看目录」打开；数据直接复用详情页抓到的 biBook.chapters，
 *  不再重新请求。顶部 ⇧/⇩ 对应 legado 目录页的「回到顶部 / 跳到底部」。
 * ============================================================ */

let tocmBook = null;

function openTocModal() {
  if (!biBook || !(biBook.chapters || []).length) return toast("目录还没抓到");
  tocmBook = biBook;
  const chs = biBook.chapters || [];
  $("tocmCount").textContent = chs.length + " 章";
  const head = document.querySelector(".tocm-title");
  if (head) head.textContent = "目录 · " + (biBook.name || "");
  const list = $("tocmList");
  list.innerHTML = chs.map((ch, i) =>
    '<div class="tocm-item" data-i="' + i + '" title="' + esc(ch.title || "") + '">'
    + '<span class="tocm-idx">' + (i + 1) + '</span>'
    + '<span class="tocm-name">' + esc(ch.title || ("第 " + (i + 1) + " 章")) + '</span>'
    + (ch.isVip || ch.isPay ? '<span class="tocm-vip">VIP</span>' : "")
    + "</div>").join("");
  list.querySelectorAll(".tocm-item").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      closeTocModal();
      closePanel("panelBookInfo", { restoreShelfManage: false });
      readOnlineBook(Object.assign({}, tocmBook, { _startIdx: i }));
    };
  });
  list.scrollTop = 0;
  $("tocModal").classList.remove("hidden");
  // 默认高亮当前正在读的章节，并把视图滚到它附近（legado 目录页 openChapterList 的行为）
  const curIdx = (state.book && state.mode === "online"
    && okey(state.book.origin, state.book.bookUrl) === okey(biBook.origin, biBook.bookUrl))
    ? state.chapterIdx : -1;
  if (curIdx >= 0) {
    const el = list.querySelector('.tocm-item[data-i="' + curIdx + '"]');
    if (el) { el.classList.add("cur"); list.scrollTop = Math.max(0, el.offsetTop - list.clientHeight / 3); }
  }
  $("tocModal").onclick = (e) => { if (e.target === $("tocModal")) closeTocModal(); };
  document.addEventListener("keydown", tocmKey);
  $("tocmClose").onclick = closeTocModal;
  $("tocmTop").onclick = () => { list.scrollTop = 0; };
  $("tocmBottom").onclick = () => { list.scrollTop = list.scrollHeight; };
}

function closeTocModal() {
  $("tocModal").classList.add("hidden");
  document.removeEventListener("keydown", tocmKey);
}
function tocmKey(e) { if (e.key === "Escape") closeTocModal(); }
/**
 * 需求 5a：换源。
 * legado ChangeSourceActivity：拿「书名 + 作者」跨源搜一遍，让用户挑一个源继续读，
 * 阅读进度按章节序号映射过去。这里复用 /api/online/search，再逐本给「换到这本」按钮。
 */
async function openChangeSource(b) {
  if (!b) return toast("先打开一本书再换源");
  csBook = b;
  $("panelChangeSource").classList.remove("hidden");
  $("csHead").textContent = "换源：" + (b.name || "");
  $("csStat").textContent = "正在按「" + (b.name || "") + " / " + (b.author || "未知作者") + "」搜索可用书源…";
  $("csList").innerHTML = '<div class="hint">搜索中…</div>';
  $("csRescan").onclick = () => openChangeSource(csBook);
  await runChangeSourceSearch(b);
}

/**
 * 换源搜索 —— 照 legado ui/book/changesource/ChangeBookSourceViewModel.search(source)（:261-282）：
 *   resultBooks = WebBook.searchBookAwait(source, name, filter = { fName, fAuthor, _ ->
 *                    fName == name && (!checkAuthor || fAuthor.contains(author)) })
 *   resultBooks.forEach { searchCallback.searchSuccess(searchBook) }
 * 每个源单独搜、结果直接进列表，**不经过 SearchModel.mergeItems 的「同名合并」**。
 * 所以这里的数据源必须是 r.sources[].books[]（每本 origin/bookUrl 严格对应同一源），
 * 不能用 r.books —— 那是合并结果，同名书只保留先到那条的 origin/bookUrl，
 * 于是「勾了七猫却拿光遇聚合的 bookUrl 去抓」，换源必然失败。
 */
const CS_AUTHOR_RE = /^\s*作\s*者[:：\s]+|\s+著/g;   // AppPattern.kt:33 authorRegex

let csSeq = 0;          // 换源搜索轮次（防止旧的流覆盖新的）
let csAbort = null;     // 允许重开面板时中断上一轮
let csState = { rows: [], arrived: [], total: 0, done: 0, book: null };

/** 换源搜索的「进行中」提示行 —— 与搜索页 .sr-pending 同一套样式 */
function csPendingHtml() {
  const n = Math.max(0, (csState.total || 0) - csState.arrived.length);
  if (!csState.total) return '<div class="sr-pending"><span class="sr-spin"></span>正在准备书源…</div>';
  if (n <= 0) return "";
  return '<div class="sr-pending"><span class="sr-spin"></span>搜索中… 还有 ' + n + ' 个书源没返回'
    + "（已返回 " + csState.arrived.length + " / " + csState.total + "）</div>";
}

/** 把「已返回的源」摊平成换源行 —— 照 legado ChangeBookSourceAdapter 的 item 列表语义 */
function csBuildRows(b, cur, orderOf) {
  const rows = [];
  let fallbackOrder = 900;
  for (const srcItem of csState.arrived) {
    for (const bk of (srcItem.books || [])) {
      const origin = bk.origin || srcItem.sourceUrl;
      if (!origin || !bk.bookUrl) continue;
      const o = orderOf.get(origin) || (fallbackOrder++);
      rows.push({
        name: bk.name || b.name, author: String(bk.author || b.author || "").replace(CS_AUTHOR_RE, "").trim(),
        origin, originName: bk.originName || srcItem.sourceName || origin,
        bookUrl: bk.bookUrl, tocUrl: bk.tocUrl || "",
        latestChapterTitle: bk.latestChapterTitle || null,
        coverUrl: bk.coverUrl || null, intro: bk.intro || null, kind: bk.kind || null,
        wordCount: bk.wordCount || null, variable: bk.variable || null,
        // item_change_source.xml 的 tv_respond_time = getString(R.string.respondTime, item.respondTime)
        respondTime: Number(bk.respondTime != null ? bk.respondTime : srcItem.respondTime) || 0,
        originOrder: o,
        // ivChecked：ChangeBookSourceAdapter.convert :63 —— oldBookUrl == item.bookUrl 即当前源
        isCurrent: okey(origin, bk.bookUrl) === cur,
      });
    }
  }
  // comparatorBase（:86-92）：无书源评分库，用「响应快的在上」+ originOrder 兜底
  rows.sort((x, y) => (x.respondTime - y.respondTime) || (x.originOrder - y.originOrder));
  return rows;
}

/**
 * 换源搜索 —— 照 legado ui/book/changesource/ChangeBookSourceViewModel.search(source)（:261-282）：
 *   resultBooks = WebBook.searchBookAwait(source, name, filter = { fName, fAuthor, _ ->
 *                    fName == name && (!checkAuthor || fAuthor.contains(author)) })
 * 每个源单独搜、结果直接进列表，**不经过 SearchModel.mergeItems 的「同名合并」**。
 * 所以这里的数据源必须是 sources[].books[]（每本 origin/bookUrl 严格对应同一源），
 * 不能用 books —— 那是合并结果，同名书只保留先到那条的 origin/bookUrl。
 *
 * 用户要求：换源搜索也必须和搜索页一样「搜到什么就显示什么」，所以同样走 NDJSON 流式
 * （body.stream=true），每回来一个源就把它搜到的书插进列表，不等全部源结束。
 */
async function runChangeSourceSearch(b) {
  const box = $("csList");
  const name = String(b.name || "").trim();
  // ChangeBookSourceViewModel.initData（:160）：author = it.replace(AppPattern.authorRegex, "")
  const author = String(b.author || "").replace(CS_AUTHOR_RE, "").trim();
  const cur = okey(b.origin, b.bookUrl);
  const orderOf = new Map();
  (state.online.sources || []).forEach((s, i) => orderOf.set(s.url, Number(s.customOrder) || i + 1));

  const seq = ++csSeq;
  if (csAbort) { try { csAbort.abort(); } catch {} }
  const ac = new AbortController();
  csAbort = ac;
  csState = { rows: [], arrived: [], total: 0, done: 0, book: b };
  box.scrollTop = 0;                     // 重新换源搜索：从顶部开始看
  box.innerHTML = '<div class="sr-pending"><span class="sr-spin"></span>正在搜索全部启用书源…</div>';
  $("csStat").textContent = "正在按「" + (name || "") + " / " + (author || "未知作者") + "」搜索…";

  // 只重画有变化的部分：新结果一律追加/重排，但保留滚动位置，不闪屏
  const paint = () => {
    if (seq !== csSeq) return;
    const rows = csBuildRows(b, cur, orderOf);
    csState.rows = rows;
    const hit = rows.filter((x) => x.isCurrent).length;
    const okSrc = csState.arrived.filter((s) => (s.books || []).length).length;
    const failSrc = csState.arrived.filter((s) => s.ok === false).length;
    $("csStat").textContent = rows.length
      ? rows.length + " 个来源（" + okSrc + " 个书源有结果" + (failSrc ? "，" + failSrc + " 个失败" : "")
        + "）原源：" + (b.originName || b.origin || "")
        + (csState.total && csState.arrived.length < csState.total
          ? " · 搜索中 " + csState.arrived.length + "/" + csState.total : "")
      : (csState.total && csState.arrived.length < csState.total
        ? "已返回 " + csState.arrived.length + "/" + csState.total + " 个书源，还没搜到同名书籍…"
        : "没有找到其它书源的同名书籍");
    const st = box.scrollTop;
    box.innerHTML = rows.map((x, i) => csRowHtml(x, i)).join("") + csPendingHtml();
    box.scrollTop = st;
    bindChangeSourceRows(box, rows, b);
    void hit;
  };
  paint();

  const body = {
    key: name, author, page: 1, changeSource: true, checkAuthor: !!author, stream: true,
  };
  try {
    const res = await fetch("/api/online/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (seq !== csSeq) return;
        if (m.type === "start") {
          csState.total = m.total || 0;
          paint();
        } else if (m.type === "source") {
          csState.total = m.total || csState.total;
          csState.done = m.done || csState.done;
          // 后端 onSource 的 item 里带 {sourceUrl, sourceName, books, ok, error, respondTime}
          csState.arrived.push({
            sourceUrl: m.sourceUrl, sourceName: m.sourceName, books: m.books || [],
            ok: m.ok !== false, error: m.error || null, respondTime: m.respondTime || 0,
          });
          paint();
        } else if (m.type === "done") {
          csState.total = csState.total || csState.arrived.length;
        }
      }
    }
  } catch (e) {
    if (seq !== csSeq) return;
    if (e.name === "AbortError") return;
    box.innerHTML = '<div class="hint">搜索失败：' + esc(e.message) + "</div>";
    return;
  }
  if (seq !== csSeq) return;
  paint();
  if (!csState.rows.length) {
    box.innerHTML = '<div class="hint">没有找到其它书源的同名书籍'
      + (author ? "（按「" + esc(name) + " / " + esc(author) + "」匹配）" : "") + "</div>";
  }
}

/** 换源行 —— 版式照 legado res/layout/item_change_source.xml */
function csRowHtml(x, i) {
  const enc = encodeURIComponent(JSON.stringify(x));
  let h = '<div class="cs-row' + (x.isCurrent ? " cur" : "") + '" data-i="' + i + '" data-src="' + enc + '">';
  h += '<div class="cs-good"><span class="cs-up">▲</span><span class="cs-down">▼</span></div>';
  h += '<div class="cs-main">';
  h += '<div class="cs-line1"><span class="cs-origin">' + esc(x.originName) + "</span>"
     + '<span class="cs-author" title="' + esc(x.author || "") + '">' + esc(x.author || "佚名") + "</span>"
     + (x.isCurrent ? '<span class="cs-cur-tag">当前</span>' : "") + "</div>";
  h += '<div class="cs-last">' + esc(x.latestChapterTitle || "无最新章节") + "</div>";
  h += '<div class="cs-time">respondTime: ' + (x.respondTime || 0) + ' ms</div>';
  h += "</div>";
  h += '<div class="cs-btns"><button class="mini-btn cs-swap" data-act="swap">' + (x.isCurrent ? "重新抓取" : "换到这本") + "</button>"
     + '<button class="mini-btn cs-more" data-act="menu" title="书源操作：置顶/置底/禁用/删除/编辑">⋯</button></div>';
  h += "</div>";
  return h;
}

/** 行交互：点击换源（ChangeBookSourceAdapter.registerListener :177）/ 长按菜单（showMenu :189） */
function bindChangeSourceRows(box, rows, b) {
  box.querySelectorAll(".cs-row").forEach((el) => {
    const i = Number(el.dataset.i);
    const t = rows[i];
    el.querySelector('[data-act="swap"]').onclick = (e) => { e.stopPropagation(); doChangeSource(b, t); };
    el.querySelector('[data-act="menu"]').onclick = (e) => {
      e.stopPropagation();
      openCsMenu(b, t, e.clientX, e.clientY);
    };
    el.onclick = () => { if (!t.isCurrent) doChangeSource(b, t); };
    el.oncontextmenu = (e) => { e.preventDefault(); openCsMenu(b, t, e.clientX, e.clientY); };
  });
}

async function doChangeSource(b, t) {
  closePanel("panelChangeSource");
  closePanel("panelBookInfo");
  // swapTo 现在真的会等后端「删旧书 + 插新书」，必须 await 才能把 toast 顺序摆正
  await swapTo({ name: b.name, author: b.author, origin: b.origin, bookUrl: b.bookUrl }, t);
}

/**
 * 换源列表长按菜单 —— legado ChangeBookSourceAdapter.showMenu（:189-223）：
 *   置顶源 / 置底源 / 编辑源 / 禁用源 / 删除源（对应 ChangeBookSourceViewModel :485-533）
 */
function openCsMenu(b, t, x, y) {
  closeCsMenu();
  const items = [
    ["置顶该源", () => csMoveSource(t, "top")],
    ["置底该源", () => csMoveSource(t, "bottom")],
    ["禁用该源", () => csToggleSource(t, false)],
    ["删除该源", () => csDeleteSource(t)],
    ["编辑该源", () => { $("panelChangeSource").classList.add("hidden"); openSources().then(() => editSource(t.origin)); }],
  ];
  const m = document.createElement("div");
  m.className = "bk-menu";
  m.id = "csMenu";
  m.innerHTML = items.map(([s], i) => '<button class="bk-menu-item" data-i="' + i + '">' + esc(s) + "</button>").join("");
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - 150) + "px";
  m.style.top = Math.min(y, window.innerHeight - items.length * 30 - 12) + "px";
  m.querySelectorAll(".bk-menu-item").forEach((el) => {
    el.onclick = () => { const f = items[Number(el.dataset.i)][1]; closeCsMenu(); f(); };
  });
  setTimeout(() => document.addEventListener("click", closeCsMenu, { once: true }), 0);
}
function closeCsMenu() { document.getElementById("csMenu")?.remove(); }

/** ChangeBookSourceViewModel.topSource/bottomSource（:485-533）：改 customOrder 后重搜 */
async function csMoveSource(t, where) {
  const list = state.online.sources.map((s) => s.url);
  const i = list.indexOf(t.origin);
  if (i < 0) return toast("书源不在当前列表里");
  list.splice(i, 1);
  if (where === "top") list.unshift(t.origin); else list.push(t.origin);
  try {
    await api("/api/sources/order", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: list }),
    });
  } catch (e) { return toast("调整顺序失败：" + e.message); }
  const idx = new Map(list.map((u, k) => [u, k + 1]));
  for (const s of state.online.sources) if (idx.has(s.url)) s.customOrder = idx.get(s.url);
  state.online.sources.sort((a, c) => (a.customOrder || 0) - (c.customOrder || 0));
  toast("已" + (where === "top" ? "置顶" : "置底") + "「" + (t.originName || t.origin) + "」");
  if (csBook) await runChangeSourceSearch(csBook);
}

async function csToggleSource(t, enabled) {
  try {
    await api("/api/sources/toggle", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: [t.origin], enabled }),
    });
  } catch (e) { return toast("操作失败：" + e.message); }
  const s = state.online.sources.find((x) => x.url === t.origin);
  if (s) s.enabled = enabled;
  toast("已禁用「" + (t.originName || t.origin) + "」");
  if (csBook) await runChangeSourceSearch(csBook);
}

async function csDeleteSource(t) {
  if (!(await askConfirm("删除书源「" + (t.originName || t.origin) + "」？", "删除"))) return;
  try {
    await api("/api/sources/delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: [t.origin] }),
    });
  } catch (e) { return toast("删除失败：" + e.message); }
  await loadSources();
  toast("已删除「" + (t.originName || t.origin) + "」");
  if (csBook) await runChangeSourceSearch(csBook);
}

/**
 * 需求 9 + A：导出本书 TXT。
 * legado 的「缓存/导出」= CacheBook.kt 把整本逐章抓下来再落盘，
 * 对应 .onEachParallel(AppConfig.threadCount) 的并发抓取 + CacheBook.kt:157 downloadSummary 进度。
 * 这里等价实现：弹窗里可设并发数与章间隔（并发过高会触发站点风控 ban IP），
 * 后端 /api/online/export/stream 用 NDJSON 实时回每章完成情况，前端画进度条，
 * 全部完成后把 txt 交给用户保存。
 */
const EXPORT_CONC_KEY = "readerExportConc";
const EXPORT_GAP_KEY = "readerExportGap";
const EXPORT_MAX_CONC = 9;   // legado AppConst.MAX_THREAD = 9（CacheBookService.kt:44 的上限）

/** 该书源是否被标记禁止导出（防站点风控 ban IP） */
function sourceNoExport(origin) {
  const s = state.online.sources.find((x) => x.url === origin);
  return !!(s && s.noExport);
}

let expBook = null;
let expAbort = null;
let expRun = null;   // 本次导出结果 { name, txt }

function exportOnlineBook(b) {
  if (!b || !b.origin || !b.bookUrl) return toast("这本书缺少书源信息");
  if (sourceNoExport(b.origin)) {
    return toast("该书源禁止导出 TXT 小说（连续请求会被站点风控封 IP）");
  }
  expBook = b;
  expRun = null;
  $("expHead").textContent = "导出 TXT · " + (b.name || "");
  $("expCount").textContent = "";
  $("expText").textContent = "等待开始…";
  $("expFill").style.width = "0";
  $("expLog").innerHTML = "";
  $("expSave").classList.add("hidden");
  $("expStart").classList.remove("hidden");
  $("expCancel").textContent = "取消";
  // 并发默认取抓取池大小（再多也排不上队），章间隔默认 0（站点容易风控就自己调大）
  let def = 4;
  try { const v = Number(localStorage.getItem(EXPORT_CONC_KEY)); if (v >= 1) def = v; } catch (e) { }
  $("expConc").max = String(EXPORT_MAX_CONC);
  $("expConc").value = String(Math.min(EXPORT_MAX_CONC, Math.max(1, def)));
  let g = 0;
  try { const v = Number(localStorage.getItem(EXPORT_GAP_KEY)); if (v >= 0) g = v; } catch (e) { }
  $("expGap").value = String(Math.max(0, Math.min(5000, g)));
  $("expConcHint").textContent = "最多 " + EXPORT_MAX_CONC + "（抓取池上限）";
  // 池大小是后端事实，拿到后把默认值和上限校准一次
  api("/api/online/pool").then((r) => {
    if (!r || !r.size) return;
    if (!$("expConc").value) $("expConc").value = String(r.size);
    $("expConcHint").textContent = "最多 " + Math.max(1, r.size) + "（抓取池 " + r.size + "）";
  }).catch(() => {});
  $("exportModal").classList.remove("hidden");
  $("exportModal").onclick = (e) => { if (e.target === $("exportModal")) closeExportModal(); };
  $("expClose").onclick = closeExportModal;
  $("expStart").onclick = runExportStream;
  $("expCancel").onclick = () => { if (expAbort) { try { expAbort.abort(); } catch (e) { } } else closeExportModal(); };
  $("expSave").onclick = () => {
    if (!expRun) return;
    const blob = new Blob([expRun.txt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (expRun.name || "book") + ".txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
}

function closeExportModal() {
  if (expAbort) { try { expAbort.abort(); } catch (e) { } expAbort = null; }
  $("exportModal").classList.add("hidden");
}

/** 逐章流式导出：读 NDJSON，边到边画进度 */
async function runExportStream() {
  if (!expBook) return;
  const conc = Math.max(1, Math.min(EXPORT_MAX_CONC, Math.trunc(Number($("expConc").value) || 1)));
  const gap = Math.max(0, Math.min(5000, Math.trunc(Number($("expGap").value) || 0)));
  try { localStorage.setItem(EXPORT_CONC_KEY, String(conc)); localStorage.setItem(EXPORT_GAP_KEY, String(gap)); } catch (e) { }
  $("expStart").classList.add("hidden");
  $("expSave").classList.add("hidden");
  $("expCancel").textContent = "停止";
  $("expLog").innerHTML = "";
  $("expFill").style.width = "0";
  $("expText").textContent = "正在启动…";
  const log = (s, bad) => {
    const d = document.createElement("div");
    if (bad) d.className = "bad";
    d.textContent = s;
    $("expLog").appendChild(d);
    $("expLog").scrollTop = $("expLog").scrollHeight;
  };
  expAbort = new AbortController();
  let r = null;
  try {
    r = await fetch("/api/online/export/stream", {
      method: "POST", headers: { "content-type": "application/json" }, signal: expAbort.signal,
      body: JSON.stringify({ origin: expBook.origin, url: expBook.bookUrl, concurrency: conc, gap }),
    });
  } catch (e) {
    expAbort = null; $("expStart").classList.remove("hidden"); $("expCancel").textContent = "取消";
    return toast("导出请求失败：" + e.message);
  }
  if (!r.ok) {
    expAbort = null; $("expStart").classList.remove("hidden"); $("expCancel").textContent = "取消";
    let msg = "HTTP " + r.status;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { }
    return toast("导出失败：" + msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let total = 0, done = 0, failed = 0;
  const paint = () => {
    if (!total) return;
    $("expFill").style.width = Math.round((done / total) * 100) + "%";
    $("expText").textContent = "已导出 " + done + " / " + total + " 章"
      + (failed ? "，失败 " + failed + " 章" : "");
  };
  let aborted = false;
  try {
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m = null;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.type === "start") {
          total = m.total || 0;
          $("expCount").textContent = total + " 章 · 并发 " + m.concurrency;
          log("开始导出《" + m.name + "》，共 " + total + " 章，并发 " + m.concurrency
            + (m.gap ? "，间隔 " + m.gap + "ms" : "") + "。");
          paint();
        } else if (m.type === "chapter") {
          done = m.done || done; failed = m.failed || 0;
          log((m.ok ? "  ✓ " : "  ✗ ") + (m.index + 1) + ". " + m.title, !m.ok);
          paint();
        } else if (m.type === "done") {
          expRun = { name: m.name, txt: m.txt };
          $("expFill").style.width = "100%";
          $("expText").textContent = "完成：共 " + m.total + " 章" + (m.failed ? "，失败 " + m.failed + " 章" : "");
          log("导出完成，点「保存 TXT」下载。");
          $("expSave").classList.remove("hidden");
          $("expCancel").textContent = "关闭";
        } else if (m.type === "error") {
          log("导出失败：" + m.error, true);
          $("expStart").classList.remove("hidden");
          $("expCancel").textContent = "取消";
        }
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") aborted = true;
    else log("读取进度出错：" + e.message, true);
  }
  expAbort = null;
  if (aborted) {
    log("已停止。");
    $("expStart").classList.remove("hidden");
    $("expCancel").textContent = "取消";
  }
}

/* ============================================================
 *  用户需求 1：书架一键换源
 *  对应 legado：书架管理页菜单「换源」→ SourcePickerDialog（只列启用源 + 可调间隔）
 *  → BookshelfManageViewModel.changeSource(books, source)（逐本串行 + "3 / 12" 进度）。
 * ============================================================ */

const CA_DELAY_KEY = "reader.batchChangeSourceDelay";
let caAbort = null;
let caRunning = false;
let caBooks = null;

/** 打开一键换源弹窗：目标源下拉只放「启用」的书源（对齐 legado flowEnabled()） */
async function openChangeAllSource(selectedBooks = null) {
  // 在线模式首次进入时书架已加载，但书源摘要是按需加载的；不能因为用户
  // 直接点「一键换源」而把空列表误判成没有启用书源。
  if (!state.online.sources.length) await loadSources();
  const targetBooks = selectedBooks && selectedBooks.length ? selectedBooks : (state.online.books || []);
  caBooks = targetBooks;
  if (!targetBooks.length) return toast("在线书架还空着，先搜索书籍加入书架");
  const srcs = (state.online.sources || []).filter((s) => s.enabled);
  if (!srcs.length) return toast("没有启用的书源，先去「书源」页开启");
  const sel = $("caSource");
  sel.innerHTML = srcs.map((s) => '<option value="' + esc(s.url) + '">' + esc(s.name) + "</option>").join("");
  const cur = state.book && state.book.rel;
  const cb = cur ? findOnlineByRel(cur) : null;
  if (cb && srcs.some((s) => s.url === cb.origin)) sel.value = cb.origin;
  // AppConfig.batchChangeSourceDelay（秒），记忆在 localStorage
  let d = 0;
  try { const v = Number(localStorage.getItem(CA_DELAY_KEY)); if (v >= 0) d = v; } catch (e) { }
  $("caDelay").value = String(Math.max(0, Math.min(9999, d)));
  $("caCount").textContent = targetBooks.length + " 本待换源";
  $("caText").textContent = "等待开始…";
  $("caFill").style.width = "0";
  $("caLog").innerHTML = "";
  clearChangeAllResult();
  $("caStart").classList.remove("hidden");
  $("caStart").disabled = false;
  $("caCancel").textContent = "取消";
  $("changeAllModal").classList.remove("hidden");
  $("changeAllModal").onclick = (e) => { if (e.target === $("changeAllModal")) closeChangeAll(); };
  $("caClose").onclick = closeChangeAll;
  $("caStart").onclick = runChangeAll;
  $("caCancel").onclick = () => { if (caRunning) stopChangeAll(); else closeChangeAll(); };
}

function closeChangeAll() {
  if (caRunning) return;
  $("changeAllModal").classList.add("hidden");
}

/** 中途停止：只中断剩余队列，已换完的书保留（legado 的 batchChangeSourceCoroutine?.cancel()） */
function stopChangeAll() {
  if (caAbort) { try { caAbort.abort(); } catch (e) { } }
}

/* ---------------- 换源结束后的结果面板 ----------------
 * 只在弹窗里写日志不够：用户关掉弹窗就再也看不到「哪本没换、为什么」。
 * 这里把统计 + 未换成功的清单固定展示在弹窗里，直到用户重新开始或关闭。 */
function clearChangeAllResult() {
  const box = $("caResult");
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

function renderChangeAllResult(summary, results) {
  const box = $("caResult");
  if (!box || !summary) return;
  const changed = Number(summary.changed) || 0;
  const notfound = Number(summary.notfound) || 0;
  const failed = Number(summary.failed) || 0;
  const skipped = Number(summary.skipped) || 0;
  const total = Number(summary.total) || 0;

  let html = '<div class="car-head">' + (summary.error ? "换源失败" : "换源完成") + "</div>";
  html += '<div class="car-target">目标书源：<b>' + esc(summary.sourceName || summary.source || "") + "</b>"
    + "　共 " + total + " 本</div>";
  html += '<div class="car-stats">'
    + '<span class="car-chip ok">成功 ' + changed + " 本</span>"
    + (notfound ? '<span class="car-chip warn">目标源没有 ' + notfound + " 本</span>" : "")
    + (failed ? '<span class="car-chip bad">失败 ' + failed + " 本</span>" : "")
    + (skipped ? '<span class="car-chip">已在该源 ' + skipped + " 本</span>" : "")
    + "</div>";

  // 没换成的书单独列出来，这是用户最关心的部分
  const bad = (results || []).filter((x) => x.state !== "ok");
  if (bad.length) {
    html += '<div class="car-list">' + bad.map((x) => {
      const tag = x.state === "notfound" ? "目标源没有这本书"
        : x.state === "skip" ? "已经是该书源" : "失败";
      return '<div class="car-item"><span class="car-book">《' + esc(x.name || "") + "》</span>"
        + '<span class="car-why">' + esc(tag + "：" + (x.why || "")) + "</span></div>";
    }).join("") + "</div>";
  } else if (total > 0) {
    html += '<div class="car-list">全部 ' + total + " 本都已换到目标书源。</div>";
  }
  box.innerHTML = html;
  box.classList.remove("hidden");
}

async function runChangeAll() {
  const source = $("caSource").value;
  if (!source) return toast("先选一个目标书源");
  const delaySec = Math.max(0, Math.min(9999, Math.trunc(Number($("caDelay").value) || 0)));
  try { localStorage.setItem(CA_DELAY_KEY, String(delaySec)); } catch (e) { }
  caRunning = true;
  $("caStart").disabled = true;
  $("caStart").classList.add("hidden");
  $("caCancel").textContent = "停止";
  $("caLog").innerHTML = "";
  clearChangeAllResult();
  $("caFill").style.width = "0";
  $("caText").textContent = "正在启动…";
  const log = (s, cls) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = s;
    $("caLog").appendChild(d);
    $("caLog").scrollTop = $("caLog").scrollHeight;
  };
  caAbort = new AbortController();
  let total = 0, doneN = 0;
  const results = [];          // 每本书的结局，结束后统一渲染到结果面板
  let r;
  try {
    r = await fetch("/api/online/changeAllSource", {
      method: "POST", headers: { "content-type": "application/json" }, signal: caAbort.signal,
      body: JSON.stringify({ source, delay: delaySec * 1000, books: caBooks && caBooks.length < (state.online.books || []).length ? caBooks.map((b) => ({ origin: b.origin, bookUrl: b.bookUrl })) : undefined }),
    });
  } catch (e) {
    caRunning = false; caAbort = null;
    $("caStart").disabled = false; $("caStart").classList.remove("hidden");
    $("caCancel").textContent = "取消";
    return toast("换源请求失败：" + e.message);
  }
  if (!r.ok || !r.body) {
    caRunning = false; caAbort = null;
    $("caStart").disabled = false; $("caStart").classList.remove("hidden");
    $("caCancel").textContent = "取消";
    return toast("换源请求失败：HTTP " + r.status);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const paint = () => {
    if (!total) return;
    $("caFill").style.width = Math.round((doneN / total) * 100) + "%";
    // legado waitDialog 上那句进度就是 "3 / 12"
    $("caText").textContent = doneN + " / " + total;
  };
  let aborted = false, summary = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m = null;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.type === "start") {
          total = m.total || 0;
          $("caCount").textContent = total + " 本 → " + (m.sourceName || "");
          log("目标书源：" + (m.sourceName || m.source) + "，共 " + total + " 本，逐本串行处理。");
          paint();
        } else if (m.type === "book") {
          if (m.state === "working") continue;
          doneN = m.index || doneN;
          if (m.state === "ok") {
            results.push({ state: "ok", name: m.name, why: "→ " + (m.newOriginName || "") + "（第 " + ((m.chapter || 0) + 1) + " 章）" });
            log("✓ " + m.index + "/" + m.total + " 《" + m.name + "》→ " + (m.newOriginName || "")
              + "，第 " + ((m.chapter || 0) + 1) + " 章 " + (m.chapterTitle || "") + "（" + (m.chapters || 0) + " 章）");
          } else if (m.state === "skip") {
            results.push({ state: "skip", name: m.name, why: m.note || "已经是该书源" });
            log("– " + m.index + "/" + m.total + " 《" + m.name + "》" + (m.note || "跳过"), "warn");
          } else if (m.state === "notfound") {
            // 用户要求：目标书源里没有这本书就绝不换源，只记录「未找到」
            results.push({ state: "notfound", name: m.name, why: m.note || "目标书源没有这本书" });
            log("— " + m.index + "/" + m.total + " 《" + m.name + "》目标书源没有这本书，已保持原书源", "warn");
          } else {
            results.push({ state: "fail", name: m.name, why: m.error || "失败" });
            log("✗ " + m.index + "/" + m.total + " 《" + m.name + "》" + (m.error || "失败"), "bad");
          }
          paint();
        } else if (m.type === "done") {
          summary = m;
        }
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") aborted = true;
    else log("读取进度出错：" + e.message, "bad");
  }
  caRunning = false; caAbort = null;
  $("caStart").disabled = false;
  $("caStart").classList.remove("hidden");
  $("caCancel").textContent = "关闭";
  $("caCancel").onclick = closeChangeAll;
  $("caClose").onclick = closeChangeAll;
  if (summary) {
    if (summary.ok === false) {
      $("caFill").style.width = total ? Math.round((doneN / total) * 100) + "%" : "0";
      $("caText").textContent = "换源失败";
      log("换源失败：" + (summary.error || "服务器未返回具体原因"), "bad");
      renderChangeAllResult(summary, results);
      toast("一键换源失败：" + (summary.error || "请检查书源和网络"));
      await refreshOnlineShelf();
      renderBooks();
      return;
    }
    $("caFill").style.width = "100%";
    $("caText").textContent = "完成：成功 " + summary.changed
      + (summary.notfound ? "，未找到 " + summary.notfound : "")
      + "，失败 " + summary.failed
      + (summary.skipped ? "，跳过 " + summary.skipped : "");
    log("换源结束：成功 " + summary.changed + " 本"
      + (summary.notfound ? "，目标书源没有 " + summary.notfound + " 本（保持原书源）" : "")
      + "，失败 " + summary.failed + " 本"
      + (summary.skipped ? "，跳过 " + summary.skipped + " 本" : "") + "。");
    renderChangeAllResult(summary, results);
    await refreshOnlineShelf();
    renderBooks();
    // 正在读的书被换源了：重新打开，让它从新源继续
    if (state.book) {
      const nb = findOnlineByRel(state.book.rel);
      if (!nb) { state.book = null; _neutralReaderView(); }
      else await openBook(toLocalShape(nb));
    }
    toast("一键换源完成：成功 " + summary.changed + " 本"
      + (summary.notfound ? "，目标源没有 " + summary.notfound + " 本" : "")
      + (summary.failed ? "，失败 " + summary.failed + " 本" : ""));
  } else {
    log(aborted ? "已停止，剩余书籍未处理。" : "换源中断。", aborted ? "warn" : "bad");
    // 中断也要给个交代：已处理的那部分照样列出来
    if (results.length) renderChangeAllResult(
      { total: results.length, changed: results.filter((x) => x.state === "ok").length,
        notfound: results.filter((x) => x.state === "notfound").length,
        failed: results.filter((x) => x.state === "fail").length,
        skipped: results.filter((x) => x.state === "skip").length,
        sourceName: $("caSource").selectedOptions && $("caSource").selectedOptions[0]
          ? $("caSource").selectedOptions[0].textContent : "" },
      results);
    await refreshOnlineShelf();
    renderBooks();
  }
}

/* ============================================================
 *  书源管理页
 * ============================================================ */

async function openSources() {
  $("panelSources").classList.remove("hidden");
  await loadSources();
  renderSourceGroupBar();
  renderSourceList();
}

let srcFilter = "";

/** 书源管理页当前**列表里可见**的书源（跟随顶部筛选框）；
 *  「全选 / 反选」只作用于这里返回的集合，和用户看到的列表严格一致。 */
function srcVisibleList() {
  const kw = (srcFilter || "").trim().toLowerCase();
  const list = state.online.sources || [];
  if (!kw) return list;
  return list.filter((s) => (s.name || "").toLowerCase().includes(kw) || (s.url || "").toLowerCase().includes(kw)
    || (s.group || "").toLowerCase().includes(kw));
}

/** 批量启用/禁用书源：复用 /api/sources/toggle（后端一次落盘 + 重建 worker 池） */
async function setSourcesEnabled(urls, enabled) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return 0;
  const r = await api("/api/sources/toggle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: list, enabled }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error) { toast("操作失败：" + String((r && r.error) || "未知错误")); return 0; }
  for (const s of state.online.sources || []) if (list.includes(s.url)) s.enabled = enabled !== false;
  renderSourceList();
  renderSourcePicker();
  return list.length;
}

function renderSourceList() {
  const box = $("sourceList");
  const kw = (srcFilter || "").trim().toLowerCase();
  const list = srcVisibleList();
  $("sourceStat").textContent = `${state.online.sources.length} 个书源`
    + `（启用 ${state.online.sources.filter((s) => s.enabled).length}）`
    + (kw ? ` · 筛选出 ${list.length}` : "");
  if (!list.length) { box.innerHTML = '<div class="hint">没有书源，点上方「导入」粘贴 JSON</div>'; return; }
  box.innerHTML = list.map((s) => {
    const flags = [s.hasSearch ? "搜索" : "", s.hasExplore ? "发现" : "", s.hasLogin ? "登录" : "",
      s.jsSource ? "JS源" : "", s.useWebView ? "WebView" : ""].filter(Boolean).join("/");
    return '<div class="src-row' + (s.enabled ? "" : " off") + '" data-url="' + esc(s.url) + '">'
      + '<label class="src-toggle"><input type="checkbox"' + (s.enabled ? " checked" : "") + ' data-act="toggle"></label>'
      + '<div class="src-info"><div class="src-name">' + esc(s.name)
      + (s.group ? '<span class="src-group">' + esc(s.group) + "</span>" : "") + "</div>"
      + '<div class="src-sub">' + esc(String(s.url).slice(0, 60)) + (flags ? " · " + flags : "")
      + (s.respondTime ? " · " + s.respondTime + "ms" : "") + "</div></div>"
      + '<label class="src-noexport" title="整本导出=连续几百次请求，部分站点会风控封 IP；勾选后该书源禁止导出 TXT 小说">'
      + '<input type="checkbox" data-act="noexport"' + (s.noExport ? " checked" : "") + ">禁止导出 TXT 小说</label>"
      + '<div class="src-btns">'
      // legado BookSourceAdapter.showMenu：menu_login 仅 source.hasLoginUrl 时可见
      // （!loginUrl.isNullOrBlank()），点击 startActivity<SourceLoginActivity>(key=bookSourceUrl)
      + (s.hasLogin ? '<button class="mini-btn src-login" data-act="login">登录</button>' : "")
      + '<button class="mini-btn" data-act="debug">调试</button>'
      + '<button class="mini-btn" data-act="edit">编辑</button>'
      + '<button class="mini-btn" data-act="del">删除</button>'
      + "</div></div>";
  }).join("");
  initSourceDrag(box);
  box.querySelectorAll(".src-row").forEach((row) => {
    const url = row.dataset.url;
    row.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (act === "toggle") {
        el.onchange = async () => {
          await api("/api/sources/toggle", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ urls: [url], enabled: el.checked })
          }).catch((e) => toast(e.message));
          const s = state.online.sources.find((x) => x.url === url);
          if (s) s.enabled = el.checked;
          renderSourceList();
        };
      } else if (act === "del") {
        el.onclick = async () => {
          if (!(await askConfirm("删除该书源？", "删除"))) return;
          await api("/api/sources/delete", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ urls: [url] })
          }).catch((e) => toast(e.message));
          await loadSources();
          renderSourceList();
          toast("已删除");
        };
      } else if (act === "noexport") {
        el.onchange = async () => {
          await api("/api/sources/update", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, patch: { noExport: el.checked } })
          }).catch((e) => toast(e.message));
          const s = state.online.sources.find((x) => x.url === url);
          if (s) s.noExport = el.checked;
          toast(el.checked ? "已禁止该书源导出 TXT 小说" : "已允许该书源导出");
        };
      } else if (act === "login") {
        el.onclick = () => openSourceLogin(url);
      } else if (act === "edit") {
        el.onclick = () => editSource(url);
      } else if (act === "debug") {
        el.onclick = () => debugSource(url);
      }
    });
  });
}

/**
 * 需求 5b：书源顺序自定义。
 * legado 在「书源管理」里长按拖动排序（BookSourceActivity 的 ItemTouchHelper），
 * 顺序落库到 BookSource.customOrder，搜索时按它决定并发/展示的先后。
 * 后端 POST /api/sources/order 已就绪（按数组下标写 customOrder = i+1），这里只补拖拽交互。
 * 用 HTML5 原生 draggable，不引第三方库；拖放结束把当前 DOM 顺序整体回传。
 */
function initSourceDrag(box) {
  let dragEl = null;
  const rows = [...box.querySelectorAll(".src-row")];
  rows.forEach((row) => {
    row.draggable = true;
    row.classList.add("draggable");
    row.ondragstart = (e) => {
      // 输入框 / 按钮上的拖动不算排序，避免干扰勾选和点击
      if (e.target.closest("button,input,select")) { e.preventDefault(); return; }
      dragEl = row;
      row.classList.add("dragging");
      try { e.dataTransfer.setData("text/plain", row.dataset.url); } catch {}
      e.dataTransfer.effectAllowed = "move";
    };
    row.ondragend = () => {
      row.classList.remove("dragging");
      rows.forEach((r) => r.classList.remove("drag-over", "drag-under"));
      dragEl = null;
    };
    row.ondragover = (e) => {
      if (!dragEl || dragEl === row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle("drag-over", !after);
      row.classList.toggle("drag-under", after);
    };
    row.ondragleave = () => row.classList.remove("drag-over", "drag-under");
    row.ondrop = async (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === row) return;
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      if (after) row.after(dragEl); else row.before(dragEl);
      row.classList.remove("drag-over", "drag-under");
      await saveSourceOrder(box);
    };
  });
}

async function saveSourceOrder(box) {
  const visible = [...box.querySelectorAll(".src-row")].map((r) => r.dataset.url);
  // 有筛选时 DOM 里只有子集：把子集的新顺序按位置回填到完整列表，未显示的书源保持原相对次序，
  // 否则筛选状态下拖一次就会把没显示的书源顺序全部打乱。
  const base = state.online.sources.map((s) => s.url);
  const shown = new Set(visible);
  let k = 0;
  const urls = base.map((u) => (shown.has(u) ? visible[k++] : u));
  if (urls.length !== base.length) for (const u of visible) if (!base.includes(u)) urls.push(u);
  try {
    await api("/api/sources/order", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    // 本地内存顺序同步过去，免得下次渲染又跳回旧顺序
    const idx = new Map(urls.map((u, i) => [u, i + 1]));
    for (const s of state.online.sources) if (idx.has(s.url)) s.customOrder = idx.get(s.url);
    state.online.sources.sort((a, b) => (a.customOrder || 0) - (b.customOrder || 0));
    toast("书源顺序已保存");
  } catch (e) { toast("保存顺序失败：" + e.message); }
}

async function editSource(url) {
  const r = await api("/api/sources/get?url=" + encodeURIComponent(url)).catch(() => null);
  if (!r || !r.source) return toast("读取书源失败");
  const s = r.source;
  // legado BookSourceEditActivity：bookSourceName / bookSourceGroup 都是 TextInputLayout，
  // 这里改用站内多字段弹窗（原生 prompt 会弹在浏览器顶部，与阅读器 UI 割裂）。
  const v = await askFields("编辑书源", [
    { key: "name", label: "书源名称", value: s.bookSourceName || "", placeholder: "bookSourceName" },
    { key: "group", label: "分组（可留空）", value: s.bookSourceGroup || "", placeholder: "bookSourceGroup" },
    { key: "order", label: "排序值（数字越小越靠前）", value: String(s.customOrder || 0), placeholder: "customOrder" },
  ]);
  if (v === null) return;
  if (!String(v.name || "").trim()) return toast("书源名称不能为空");
  await api("/api/sources/update", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, patch: { bookSourceName: v.name, bookSourceGroup: v.group, customOrder: Number(v.order) || 0 } })
  }).catch((e) => toast(e.message));
  await loadSources();
  renderSourceList();
  toast("已保存");
}

async function debugSource(url) {
  const key = await askPrompt("书源调试", "关键词（搜索→详情→目录→正文 全链路跑一遍）", "剑来");
  if (key === null) return;
  if (!String(key).trim()) return;
  const box = $("debugBox");
  box.classList.remove("hidden");
  $("debugLog").textContent = "调试中…（要抓好几次网络，可能要十几秒）";
  let r;
  try {
    r = await api("/api/sources/analyze", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, key })
    });
  } catch (e) { $("debugLog").textContent = "调试失败：" + e.message; return; }
  const lines = [];
  lines.push("书源：" + (r.result?.sourceName || ""));
  if (r.result?.steps) for (const s of r.result.steps) {
    lines.push((s.ok ? "✔ " : "✘ ") + s.name + "  " + s.cost + "ms" + (s.error ? "  " + s.error : ""));
  }
  if (r.result?.bookCount != null) lines.push("搜索命中：" + r.result.bookCount + " 本");
  if (r.result?.chapterCount != null) lines.push("目录章节：" + r.result.chapterCount + " 章");
  if (r.result?.contentPreview) lines.push("正文片段：" + r.result.contentPreview.slice(0, 300));
  if (!r.ok) lines.push("错误：" + r.error);
  if (r.result?.logs?.length) { lines.push("---- 日志 ----"); lines.push(...r.result.logs.slice(-60)); }
  $("debugLog").textContent = lines.join("\n");
}

/* ---------------- 发现（explore） ----------------
 * 1:1 对应 legado ui/main/explore/ExploreAdapter.kt:156-500
 *   Type.url    → chip          （title 以 ERROR: 开头则弹错误对话框）
 *   Type.button → 按钮           （点击跑 action）
 *   Type.text   → 输入框         （有 action 时 600ms 防抖后跑）
 *   Type.toggle → 点击轮转 chars  （写 infoMap[title] 后跑 action）
 *   Type.select → 下拉           （变化时写 infoMap[title] 后跑 action，忽略初始化）
 * 所有 action 一律走后端 /api/online/explore/action（evalButtonClick 语义）。
 */

/** infoMap 按书源各存一份（legado exploreInfoMapList） */
function exploreInfoMap(url) {
  if (!state.online.exploreInfoMap) state.online.exploreInfoMap = {};
  if (!state.online.exploreInfoMap[url]) state.online.exploreInfoMap[url] = {};
  return state.online.exploreInfoMap[url];
}

/** ExploreAdapter.kt Type 常量 */
const EK = { URL: "url", TEXT: "text", BUTTON: "button", TOGGLE: "toggle", SELECT: "select" };

function ekStyle(k) {
  const st = k && k.style && typeof k.style === "object" ? k.style : {};
  const css = [];
  let grow = Number(st.layout_flexGrow);
  const shrink = Number(st.layout_flexShrink);
  let basis = Number(st.layout_flexBasisPercent);
  // 书源偶发把网格子项的 flexBasisPercent 写成非整格的值（如松鹤阅读「剑道」= 0.29 且 grow = 0），
  // 会让同一排子项的宽度和相邻行不一致。这里把 (0,1) 之间明显跑偏的 basis 向下吸附到 1/N 网格并补齐
  // grow = 1，让同一排子项等宽换行；basis >= 1（整行换行，如「男频」「流派」分组头）与未设置(-1)保持原样。
  if (Number.isFinite(basis) && basis > 0 && basis < 1) {
    // 只做「向下吸附」：吸附值一定不大于原值，一行能放下几个子项只会变多不会变少，
    // 不会像「吸附到最近网格」那样把 0.45（原本两列）顶成 0.5（配合 gap 变成一列）。
    let best = null;
    for (let n = 2; n <= 8; n++) {
      const v = 1 / n;
      if (v <= basis + 1e-9 && basis - v <= 0.06 && (best === null || v > best)) best = v;
    }
    if (best !== null) {
      basis = best;
      if (!(Number.isFinite(grow) && grow > 0)) grow = 1;
    }
  }
  if (Number.isFinite(grow) && grow > 0) css.push("flex-grow:" + grow);
  if (Number.isFinite(shrink) && shrink !== 1) css.push("flex-shrink:" + shrink);
  // FlexChildStyle.apply(): flexBasisPercent<0 表示不设置（Android 用 ViewGroup.LayoutParams.MATCH_PARENT）
  if (Number.isFinite(basis) && basis > 0) css.push("flex-basis:" + (basis * 100).toFixed(2) + "%");
  // lp.alignSelf —— legado 用它把「🔍搜索」对齐到输入框基线
  const as = st.layout_alignSelf;
  if (as === "flex_start") css.push("align-self:flex-start");
  else if (as === "flex_end") css.push("align-self:flex-end");
  else if (as === "center") css.push("align-self:center");
  else if (as === "baseline") css.push("align-self:baseline");
  else if (as === "stretch") css.push("align-self:stretch");
  // lp.isWrapBefore —— 该控件强制换行。给了分栏比例(0<basis<1)的控件不能被撑成整行，
  // 否则七猫的「男频/女频/出版」（各 1/4）会各自占满一行。
  if (st.layout_wrapBefore === true && !(Number.isFinite(basis) && basis > 0 && basis < 1)) css.push("flex-basis:100%");
  const js = st.layout_justifySelf;
  if (js === "flex_start") css.push("justify-self:flex-start");
  else if (js === "flex_end") css.push("justify-self:flex-end");
  else if (js === "center") css.push("justify-self:center");
  return css.join(";");
}

/** ExploreAdapter.kt:viewName —— '\'字面量\'' 直接用，否则交给 evalUiJs */
async function ekViewName(url, k, infoMap) {
  const vn = k.viewName;
  if (vn === null || vn === undefined || vn === "") return null;
  if (String(vn).length >= 3 && String(vn).length <= 19 && vn[0] === "'" && vn[vn.length - 1] === "'") return vn.slice(1, -1);
  const r = await api("/api/online/explore/ui", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: url, code: vn, infoMap })
  }).catch(() => null);
  const n = r && r.value;
  if (!n) return "null";
  return String(n);
}

async function openExplore() {
  $("panelExplore").classList.remove("hidden");
  if (!state.online.sources.length) await loadSources();
  const sel = $("exploreSource");
  const list = state.online.sources.filter((s) => s.enabled && s.hasExplore);
  sel.innerHTML = list.map((s) => '<option value="' + esc(s.url) + '">' + esc(s.name) + "</option>").join("")
    || '<option value="">（没有启用发现的书源）</option>';
  if (state.online.exploreSource) sel.value = state.online.exploreSource;
  loadExploreKinds();
}

async function loadExploreKinds() {
  const url = $("exploreSource").value;
  state.online.exploreSource = url;
  const box = $("exploreKinds");
  box.innerHTML = '<div class="hint">读取分类…</div>';
  $("exploreBooks").innerHTML = "";
  if (!url) { box.innerHTML = ""; return; }
  const im = exploreInfoMap(url);
  const q = "/api/online/explore/kinds?source=" + encodeURIComponent(url)
    + (Object.keys(im).length ? "&infoMap=" + encodeURIComponent(JSON.stringify(im)) : "");
  const r = await api(q).catch(() => null);
  if (!r || r.ok === false || !r.kinds || !r.kinds.length) {
    box.innerHTML = '<div class="hint">该书源没有分类发现' + (r && r.error ? "：" + esc(r.error) : "") + "</div>";
    return;
  }
  await applyExploreKindsResult(r, url);
}

/**
 * ExploreAdapter.refreshExplore()（源菜单「刷新发现」）：
 *   clearExploreKindsCache() → exploreKinds()
 * 后端 /api/online/explore/refresh 就是这两步；登录番茄后必须走它，
 * 否则 ACache 命中的旧分类（登录前生成、没有番茄书架）永远不会更新。
 */
async function refreshExploreKinds() {
  const url = $("exploreSource").value;
  if (!url) return;
  const box = $("exploreKinds");
  const btn = $("exploreRefresh");
  if (btn) { btn.classList.add("busy"); btn.disabled = true; }
  box.classList.add("busy");
  try {
    const r = await api("/api/online/explore/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: url, infoMap: exploreInfoMap(url) }),
    }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || r.ok === false || !r.kinds || !r.kinds.length) {
      toast("刷新发现失败：" + String((r && r.error) || "没有取到分类").slice(0, 120));
      box.innerHTML = '<div class="hint">该书源没有分类发现' + (r && r.error ? "：" + esc(r.error) : "") + "</div>";
      return;
    }
    await applyExploreKindsResult(r, url);
    toast("发现已刷新（" + r.kinds.length + " 项）");
  } finally {
    box.classList.remove("busy");
    if (btn) { btn.classList.remove("busy"); btn.disabled = false; }
  }
}

/** 把 /explore/kinds 或 /explore/refresh 的结果落到 UI（含分类求值期的 java.* 副作用） */
async function applyExploreKindsResult(r, url) {
  if (r.infoMap && typeof r.infoMap === "object") state.online.exploreInfoMap[url] = r.infoMap;
  state.online.exploreKinds = r.kinds;
  await renderExploreKinds(r.kinds, url);
  // 动态 exploreUrl 求值本身也可能调用 java.startBrowser()/open()/searchBook()。
  // legado 在解析分类时立即执行这些副作用；不能只渲染分类后把 actions 丢掉。
  await applyActions(r.actions || [], { origin: url });
}

/** ExploreAdapter：书源把整行分组头用全角空格撑满（如「　　　　　　 都市 　　　　　　」）。
 *  这里识别出来，去掉撑满用的空白并在两侧交替加菱形装饰，避免渲染成一整条空荡荡的长条。 */
const EXPLORE_HEAD_DECOS = [["\u{1F537}\u{1F539}", "\u{1F539}\u{1F537}"], ["\u{1F536}\u{1F538}", "\u{1F538}\u{1F536}"]];
function ekWideHeadName(title) {
  const m = /^[\s\u3000]+(.+?)[\s\u3000]+$/.exec(String(title == null ? "" : title));
  if (!m) return null;
  const name = m[1].trim();
  if (!name || /分类$/.test(name)) return null;   // 「男频分类」这类板块总标题保持朴素
  return name;
}
/** 书源给了「整行」宽度：flexBasisPercent>=1（100% 或更多，七猫的 bar / 松鹤的板块头）。
 *  注意 layout_wrapBefore 只表示「该项开始新的一行」，不是整行宽度；七猫把每行第一个标签
 *  同时标成 wrapBefore，旧代码据此把它当整行头，才出现「爽文 / 兵王 / 逆袭」被撑成整条。 */
function ekIsWideKind(k) {
  const st = k && k.style && typeof k.style === "object" ? k.style : {};
  const b = Number(st.layout_flexBasisPercent);
  return Number.isFinite(b) && b >= 1;
}
/** 书源偶发把网格子项的 flexBasisPercent 写成非整格的值（如松鹤阅读「剑道」= 0.29 且 grow = 0），
 *  会让同一排子项的宽度和相邻行不一致。这里把 (0,1) 之间明显跑偏的 basis 向下吸附到 1/N 网格，
 *  并补齐 grow = 1，让同一排子项等宽；basis >= 1（整行）与未设置保持原样。 */
function ekSnapBasis(basis, grow) {
  let b = basis, g = grow;
  if (Number.isFinite(b) && b > 0 && b < 1) {
    // 只做「向下吸附」：吸附值一定不大于原值，一行能放下几个子项只会变多不会变少。
    let best = null;
    for (let n = 2; n <= 8; n++) {
      const v = 1 / n;
      if (v <= b + 1e-9 && b - v <= 0.06 && (best === null || v > best)) best = v;
    }
    if (best !== null) { b = best; if (!(Number.isFinite(g) && g > 0)) g = 1; }
  }
  return { basis: b, grow: g };
}
/** 发现页分类 chip 的比例排版信息（对应 legado FlexChildStyle 的 flexGrow + flexBasisPercent）。
 *  basis = 0/缺省 → 按内容自适应；= 1/2 → 占 1/2；= 1/3、1/4 → 占 1/3、1/4。
 *  wrapBefore = legado FlexChildStyle.isWrapBefore：本项强制换行。 */
function ekChipLayout(k) {
  const st = k && k.style && typeof k.style === "object" ? k.style : {};
  const snapped = ekSnapBasis(Number(st.layout_flexBasisPercent), Number(st.layout_flexGrow));
  const basis = Number.isFinite(snapped.basis) && snapped.basis > 0 && snapped.basis < 1 ? snapped.basis : 0;
  // legado FlexChildStyle.flexGrow 缺省按 1 处理（一行凑不满时由 flexGrow 把剩余宽度摊掉）
  const grow = basis ? (Number.isFinite(snapped.grow) && snapped.grow > 0 ? snapped.grow : 1) : 0;
  return { basis, grow, wrapBefore: st.layout_wrapBefore === true };
}
/** 等比分栏行里的 chip：宽度由 .ek-chip-row 按比例分配，这里只保留 align-self。 */
function ekChipStyle(k) {
  const st = k && k.style && typeof k.style === "object" ? k.style : {};
  const css = [];
  const as = st.layout_alignSelf;
  if (as === "flex_start") css.push("align-self:flex-start");
  else if (as === "flex_end") css.push("align-self:flex-end");
  else if (as === "center") css.push("align-self:center");
  else if (as === "baseline") css.push("align-self:baseline");
  else if (as === "stretch") css.push("align-self:stretch");
  return css.join(";");
}

/** 发现页分类 chip 统一等宽：同一屏里宽度相同、换行后列与列对齐。
 *  书源给的 flex_grow（QQ 浏览器）或按文字自适应（速读谷²/笔趣阁）都会让行与行错位。 */
function equalizeExploreKindChips(box, attempt) {
  if (!box) return;
  const chips = [...box.children].filter((el) => el.classList && el.classList.contains("chip")
    && el.dataset.ekWide !== "1" && el.dataset.ekFixed !== "1");
  if (chips.length < 2) return;
  for (const el of chips) el.style.setProperty("flex", "0 0 auto", "important");
  void box.offsetWidth;                       // 强制回流后再量自然宽度
  if (!box.offsetWidth) {                     // 面板还没布局出来：按 0 宽算会把宽度算错，下一帧重来
    if ((attempt || 0) < 30) requestAnimationFrame(() => equalizeExploreKindChips(box, (attempt || 0) + 1));
    return;
  }
  let max = 0;
  for (const el of chips) max = Math.max(max, el.getBoundingClientRect().width);
  if (!(max > 0) || max > 180) return;   // 极端长文本不强行走等宽，避免一行只剩一两个
  max = Math.ceil(max) + 1;                   // +1 抵消亚像素舍入
  for (const el of chips) el.style.setProperty("flex", "0 0 " + max + "px", "important");
}
window.addEventListener("resize", () => {
  clearTimeout(equalizeExploreKindChips._t);
  equalizeExploreKindChips._t = setTimeout(() => equalizeExploreKindChips($("exploreKinds")), 150);
});

async function renderExploreKinds(kinds, url) {
  const box = $("exploreKinds");
  const im = exploreInfoMap(url);
  box.innerHTML = "";
  let headIdx = 0;
  let rowEls = null;       // 当前一行等比分栏的标签
  let rowGrowth = 0;
  let usedRatioRow = false; // 出现过 .ek-chip-row（此时不能再套整块网格排版）
  const rows = [];         // 按书源 wrapBefore/basis 还原出来的行

  /* 收尾一行（= legado FlexboxLayout 的一行）：书源的 flexBasisPercent 通常一行加起来是 1
     （1/4 * 4），但七猫这种只给 0.2 * 4 / 0.25 * 3 的行在 legado 里同样靠 flexGrow 补满整行，
     所以这里按该行实际 grow 总和归一化，避免某行缺项（或含「　」占位）时右侧留白。 */
  const flushChipRow = () => {
    if (!rowEls) return;
    const els = rowEls;
    const growth = rowGrowth;
    rowEls = null; rowGrowth = 0;
    if (!(growth > 0)) { for (const el of els) rows.push(el); return; }
    const row = document.createElement("div");
    row.className = "ek-chip-row";
    for (const el of els) {
      // legado FlexboxLayout：flexBasisPercent 决定一行能放几格、flexGrow 把该行剩余宽度摊掉。
      // -6px 是每行 gap 的补偿，否则 5 × 20% 加上 4 个间隙会溢出整行。
      const pct = (el.__ekBasis * 100).toFixed(3);
      el.style.setProperty("flex", (el.__ekGrow > 0 ? el.__ekGrow : 1) + " 1 calc(" + pct + "% - 6px)", "important");
      row.appendChild(el);
    }
    usedRatioRow = true;
    rows.push(row);
  };

  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    const type = String(k.type || EK.URL);
    const title = String(k.title == null ? "" : k.title);
    const style = ekStyle(k);
    if (type === EK.URL) {
      const el = document.createElement("button");
      el.className = "chip";
      el.textContent = title;
      el.dataset.url = k.url || "";
      const L = ekChipLayout(k);
      if (ekIsWideKind(k)) {
        // 整行条：legado flexBasisPercent >= 1（七猫的「筛选」「热门（13）」「情节（84）」等）
        flushChipRow();
        el.dataset.ekWide = "1";
        el.classList.add("ek-head");
        const nice = ekWideHeadName(title);
        if (nice) {
          const d = EXPLORE_HEAD_DECOS[headIdx++ % EXPLORE_HEAD_DECOS.length];
          el.textContent = d[0] + " " + nice + " " + d[1];
        } else {
          el.textContent = title.trim();
        }
        if (style) el.setAttribute("style", style);
        const vn = await ekViewName(url, k, im);
        if (vn !== null) el.textContent = vn;
        rows.push(el);
      } else if (L.basis) {
        // 一行的第 N 格：交给 .ek-chip-row 按 flexBasisPercent 比例铺满整行
        if (L.wrapBefore) flushChipRow();          // legado isWrapBefore：本项开始新的一行
        const cs = ekChipStyle(k);
        if (cs) el.setAttribute("style", cs);
        el.__ekBasis = L.basis;
        el.__ekGrow = L.grow;
        if (!rowEls) { rowEls = []; rowGrowth = 0; }
        rowEls.push(el);
        rowGrowth += L.basis;
      } else {
        // 没给比例的普通标签：按内容自适应，换行交给 .chip-row 的 flex-wrap
        flushChipRow();
        if (style) el.setAttribute("style", style);
        rows.push(el);
      }
      el.onclick = () => {
        box.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
        el.classList.add("on");
        // legado: title 以 ERROR: 开头时弹 TextDialog("ERROR", url)
        if (title.startsWith("ERROR:")) { showErrDialog(title, k.url || ""); return; }
        const u = k.url ? String(k.url) : "";
        if (!u) return;
        // ExploreAdapter.onItemClick → ExploreShowActivity.start（独立页面）
        $("panelExploreResult").classList.remove("hidden");
        loadExploreBooks(u, 1, title);
      };
      continue;
    }
    flushChipRow();
    const rowStart = rows.length;
    if (type === EK.BUTTON) {
      const el = document.createElement("button");
      el.className = "chip chip-btn";
      el.textContent = title;
      if (style) el.setAttribute("style", style);
      const vn = await ekViewName(url, k, im);
      if (vn !== null) el.textContent = vn;
      el.onclick = () => runExploreAction(url, k, im, title);
      rows.push(el);
    } else if (type === EK.TEXT) {
      const el = document.createElement("input");
      el.className = "mini-input ek-text";
      el.placeholder = title;
      el.value = im[title] || "";
      if (style) el.setAttribute("style", style);
      const vn = await ekViewName(url, k, im);
      if (vn !== null) el.placeholder = vn;
      let timer = null;
      el.oninput = () => {
        im[title] = el.value;
        if (k.action) {
          clearTimeout(timer);
          timer = setTimeout(() => runExploreAction(url, k, im, title), 600);   // legado: delay(600) 防抖
        }
      };
      rows.push(el);
    } else if (type === EK.TOGGLE) {
      const el = document.createElement("button");
      el.className = "chip chip-btn";
      const chars = (Array.isArray(k.chars) ? k.chars : []).map((c) => (c == null ? "" : String(c)));
      const useChars = chars.length ? chars : ["chars", "is null"];
      const left = (k.style && k.style.layout_justifySelf) !== "right";
      const cur = im[title] || (k.default != null ? String(k.default) : useChars[0]);
      im[title] = cur;
      let char = cur;
      let name = title;
      if (style) el.setAttribute("style", style);
      const vn = await ekViewName(url, k, im);
      if (vn !== null) name = vn;
      const paint = () => { el.textContent = left ? char + name : name + char; };
      paint();
      el.onclick = () => {
        const ci = useChars.indexOf(char);
        char = useChars[(ci + 1) % useChars.length];
        im[title] = char;
        paint();
        if (k.action) runExploreAction(url, k, im, title);
      };
      box.appendChild(el);
    } else if (type === EK.SELECT) {
      const wrap = document.createElement("label");
      wrap.className = "ek-select";
      if (style) wrap.setAttribute("style", style);
      const chars = (Array.isArray(k.chars) ? k.chars : []).filter((c) => c != null).map(String);
      const useChars = chars.length ? chars : ["chars", "is null"];
      const nm = document.createElement("span");
      nm.className = "ek-select-name";
      nm.textContent = title;
      const vn = await ekViewName(url, k, im);
      if (vn !== null) nm.textContent = vn;
      const sel = document.createElement("select");
      sel.className = "mini-select";
      sel.innerHTML = useChars.map((c) => "<option>" + esc(c) + "</option>").join("");
      const cur = im[title] || (k.default != null ? String(k.default) : useChars[0]);
      im[title] = cur;
      sel.value = useChars.includes(cur) ? cur : useChars[0];
      let initing = true;
      sel.onchange = () => {
        if (initing) { initing = false; return; }   // legado: 忽略初始化选择
        im[title] = useChars[sel.selectedIndex];
        if (k.action) runExploreAction(url, k, im, title);
      };
      wrap.appendChild(nm);
      wrap.appendChild(sel);
      rows.push(wrap);
      initing = false;
    }
    // 书源显式给了排版（basis/grow）的控件不能被 equalizeExploreKindChips 等宽化覆盖，
    // 否则七猫「男频/女频/出版」会退回按文字宽度排布、整行条也不再占满一行。
    {
      const st = k && k.style && typeof k.style === "object" ? k.style : {};
      const b = Number(st.layout_flexBasisPercent), g = Number(st.layout_flexGrow);
      if ((Number.isFinite(b) && b > 0) || (Number.isFinite(g) && g > 0)) {
        for (let ri = rowStart; ri < rows.length; ri++) if (rows[ri] && rows[ri].dataset) rows[ri].dataset.ekFixed = "1";
      }
    }
  }
  flushChipRow();
  for (const el of rows) box.appendChild(el);
  equalizeExploreKindChips(box);
  // 书源只给了 flexGrow（QQ 浏览器等）：交给 CSS 网格，宽度由列数决定，等宽且行列对齐，
  // 不受测量时机、字体加载先后、窗口缩放影响。
  const allPlainChips = !usedRatioRow && kinds.length > 1 && kinds.every((k) => String(k.type || EK.URL) === EK.URL && !ekIsWideKind(k));
  box.classList.toggle("ek-grid", allPlainChips);
  // 中文字体是异步加载的，字体换了之后最长的那个 chip 会变宽，等宽值也要跟着重算
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") {
    document.fonts.ready.then(() => equalizeExploreKindChips(box)).catch(() => {});
  }
}

function showErrDialog(title, detail) {
  $("debugLog").textContent = String(title) + "\n\n" + String(detail || "");
  $("debugBox").classList.remove("hidden");
}

/**
 * 非 http(s) 链接的落地（legado OpenUrlConfirmDialog.kt：Toolbar +
 * 「正在请求跳转链接/应用，是否跳转？」→ Intent(ACTION_VIEW)）。
 * 七猫 loginUrl 里的 QQ 群深链 `mqqapi://card/...` 就走这里：桌面浏览器打不开这类
 * scheme，所以照 legado 先弹确认框，确认后尽力交给系统/浏览器处理。
 */
async function openExternalUrl(a, ctx) {
  const url = String(a.url || "");
  if (!url) return;
  // legado ACTION_VIEW 里 http(s) 也是「打开外部浏览器」；桌面端我们有等价于
  // WebViewActivity 的内置浏览器，直接用它（其余 scheme 才走确认框）。
  if (/^https?:\/\//i.test(url)) { await openBrowserAction(a, ctx); return; }
  const ok = await askConfirm("正在请求跳转链接/应用，是否跳转？\n\n" + url, "跳转", "取消");
  if (!ok) return;
  try { window.open(url, "_blank"); } catch (e) { /* 未知 scheme，浏览器会忽略 */ }
  toast("已请求跳转：" + url.slice(0, 80));
}

/**
 * RssJsExtensions.open(name, url, title, origin)（ui/rss/read/RssJsExtensions.kt:99）
 * 的桌面端分派。legado 的 when (name) 有五个分支：
 *   login   → resolveLoginSource(origin,...) → SourceLoginActivity
 *   search  → title 非空时 SearchActivity.start（origin 有值就只搜那个源）
 *   explore → ExploreShowActivity(exploreName = title, exploreUrl = url)
 *   sort / rss → RSS 模块界面，本项目没有对应页面，按「未实现」提示
 */
async function runOpenAction(a, ctx) {
  const name = String(a.name || "");
  const origin = a.origin || a.sourceUrl || (ctx && ctx.origin) || "";
  if (name === "login") {
    // legado：toSource == null → toast("未找到指定源")；!hasLogin() → toast("源未配置登录")
    if (!origin) { toast("未找到指定源"); return; }
    await openSourceLogin(origin);
    return;
  }
  if (name === "search") {
    // legado：origin 命中书源就 searchBook(title, source)，否则 searchBook(title) 全源搜
    const title = a.title == null ? "" : String(a.title);
    if (!title) return;
    await openSearchFromExplore({ key: title, scopeUrl: origin || null, scopeName: null });
    return;
  }
  if (name === "explore") {
    // legado：ExploreShowActivity(exploreName=title, sourceUrl=origin, exploreUrl=url)
    await openExplore();
    const sel = $("exploreSource");
    if (origin && sel && Array.from(sel.options).some((o) => o.value === origin)) {
      sel.value = origin;
      state.online.exploreSource = origin;
      await loadExploreKinds();
    }
    if (a.url) {
      $("panelExploreResult").classList.remove("hidden");
      loadExploreBooks(String(a.url), 1, a.title == null ? "" : String(a.title));
    }
    return;
  }
  toast("桌面端尚未实现 java.open(\"" + name + "\")（RSS 相关界面）");
}

/**
 * 后端返回的 actions[] 统一落地（发现页按钮 / 登录窗按钮 / 书源窗口 iframe 桥 / 正文图片共用）。
 * 已消费的动作不返回；调用方自行处理剩余项（reLoginView / upLoginData 之类）。
 */
async function applyActions(actions, ctx) {
  const rest = [];
  for (const a of actions || []) {
    if (!a) continue;
    if (a.type === "toast") toast(String(a.msg || ""));
    else if (a.type === "searchBook") await openSearchFromExplore(a);
    else if (a.type === "open") await runOpenAction(a, ctx);
    else if (a.type === "openUrl" && a.url) await openExternalUrl(a, ctx);
    else rest.push(a);
  }
  return rest;
}

/**
 * ExploreAdapter.evalButtonClick + Callback 的桌面端等价物。
 * 后端返回 actions[] 描述脚本想做的副作用，这里逐条落地。
 */
async function runExploreAction(url, k, im, title) {
  const btn = $("exploreKinds");
  btn.classList.add("busy");
  const r = await api("/api/online/explore/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: url, action: k.action, kind: k, infoMap: im, title })
  }).catch((e) => ({ ok: false, error: e.message }));
  btn.classList.remove("busy");
  if (!r) return;
  if (r.infoMap && typeof r.infoMap === "object") state.online.exploreInfoMap[url] = r.infoMap;
  if (r.ok === false) { toast(String(r.error || "按钮执行失败").slice(0, 120)); return; }
  // RssJsExtensions.open 的五个分支（login / search / explore / sort / rss）在 runOpenAction 里分派；
  // SourceVerificationHelp.startBrowser → WebViewActivity 的等价物是站内真内核浏览器（openExternalUrl）。
  // 用 window.open 会跳去外部浏览器，与 legado 的「内置 WebView 里登录后 cookie 回写」语义不符。
  await applyActions(r.actions, { origin: url });
  // java.refreshExplore() → clearExploreKindsCache + exploreKinds()
  if (r.refreshed && Array.isArray(r.kinds) && r.kinds.length) {
    state.online.exploreKinds = r.kinds;
    await renderExploreKinds(r.kinds, url);
  }
}

/** SourceLoginJsExtensions.searchBook(key, "源名::源key") → SearchActivity.start */
async function openSearchFromExplore(a) {
  $("panelExplore").classList.add("hidden");
  await openSearch();
  $("searchKey").value = a.key || "";
  if (a.scopeUrl) {
    state.online.searchPick = [a.scopeUrl];
    renderSourcePicker();
    const d = $("srcPickWrap");
    if (d) d.open = true;
  }
  doSearch();
}

/* ---------------- 发现结果列表（分页：保留旧页，等新页到再切） ---------------- */

/**
 * 翻页后把新页定在顶部。
 *
 * 历史问题：换完 innerHTML 后浏览器会保留 #searchResults / #exploreBooks 的 scrollTop，
 * 于是出现「第一页尾部 → 第二页尾部」，上一页滚到底再翻页就会漏看新页上半段。
 * 上一版改成从旧位置缓动回 0，方向虽然对了，但用户要盯着「新页内容往上滚」，
 * 观感又生硬又慢（距离越远动画越久，正是「缓慢」的来源）。
 *
 * legado 里 ExploreShowActivity / SearchActivity 都是「数据换完 + scrollToPosition(0)」，
 * 没有滚动动画。所以这里等价为：**瞬时归位**，只保留一次 140ms 淡入，
 * 避免内容硬切造成闪烁；系统开启「减少动态效果」时连淡入也去掉。
 */
function scrollToTopSmooth(el) {
  if (!el) return;
  el.scrollTop = 0;
  // 列表刚换完 innerHTML 时，浏览器有时会在下一帧按锚点/图片高度再修正一次 scrollTop，补一帧保险。
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => { if (el.scrollTop !== 0) el.scrollTop = 0; });
  }
  let reduce = false;
  try { reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}
  if (reduce) return;
  el.classList.remove("list-swap-in");
  void el.offsetWidth;                     // 强制重排，让连续翻页也能重新触发动画
  el.classList.add("list-swap-in");
}
let exploreSeq = 0;
/** 发现页书单为空时的提示。legado 的 ExploreShowActivity 空列表等价于“没有内容”，
 *  这里额外把上游状态码暴露给用户（例如源站 502 时给出明确原因，而不是停在“加载中…”）。 */
function exploreEmptyMessage(r) {
  const meta = r && r.meta;
  const st = meta && Number(meta.status);
  if (st >= 400) return "书源接口返回 " + st + "，源站暂时不可用，请稍后再试";
  if (meta && meta.message) return String(meta.message);
  if (r && r.error) return "加载失败：" + r.error;
  return "没有找到内容";
}
async function loadExploreBooks(url, page, title) {
  const src = $("exploreSource").value;
  const box = $("exploreBooks");
  const seq = ++exploreSeq;
  state.online.exploreUrl = url;
  state.online.explorePage = page;
  state.online.exploreTitle = title || state.online.exploreTitle || "";
  const hd = $("expResHead");
  if (hd) hd.textContent = state.online.exploreTitle || "发现";
  // 需求 4：翻页时**保留上一页**，等新页拿到再整体替换（legado ExploreShowActivity 翻页原地刷，不闪）。
  if (!box.querySelector(".res-row")) box.innerHTML = '<div class="hint">加载中…</div>';
  else box.dataset.loading = "1";
  const ld = $("expLoading"); if (ld) ld.classList.remove("hidden");
  const im = exploreInfoMap(src);
  // 用 POST 而不是 GET：番茄「我的书架」的分组 URL 内嵌整串 POST body（258 本可达
  // 十几 KB），塞进 query 会超过 Node 默认 header 上限并被 431 拒绝，表现为书架分组加载失败。
  const r = await api("/api/online/explore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: src, url, page, infoMap: im }),
  }).catch(() => null);
  if (seq !== exploreSeq) return;          // 又翻了一页：丢弃这次结果
  if (!r || r.ok === false) {
    if (!box.querySelector(".res-row")) { box.innerHTML = '<div class="hint">加载失败：' + esc((r && r.error) || "未知错误") + "</div>"; box.scrollTop = 0; }
    else toast("加载失败：" + ((r && r.error) || "未知错误"));
    delete box.dataset.loading;
    const ld4 = $("expLoading"); if (ld4) ld4.classList.add("hidden");
    return;
  }
  // 分类项里有一类是「纯副作用」的（如 光遇聚合的「登录晴天书源 / 登录番茄」，
  // url 就是 {{java.startBrowser(...)}}）。legado 在求值时已经弹出 WebView，
  // 这里后端把副作用收集成 actions 回传，前端照 legado 弹站内 WebView 窗口。
  const expActs = r.actions || [];
  await applyActions(expActs, { origin: src });
  const books = r.books || [];
  if (!books.length) {
    box.innerHTML = expActs.length
      ? '<div class="hint">已打开书源窗口，请在其中完成操作后再刷新分类</div>'
      : '<div class="hint">' + esc(exploreEmptyMessage(r)) + "</div>";
    const ld5 = $("expLoading"); if (ld5) ld5.classList.add("hidden");
    delete box.dataset.loading;
    return;
  }
  const ld3 = $("expLoading"); if (ld3) ld3.classList.add("hidden");
  // 标题已由结果页自己的 TitleBar（#expResHead）显示，列表里不再重复一条 res-head
  box.innerHTML = books.map(resultRow).join("")
    + '<div class="pager"><button class="pg-btn" id="expPrev"' + (page <= 1 ? " disabled" : "") + '>‹ 上一页</button>'
    + '<span class="pg-info">第 ' + page + ' 页 · ' + books.length + ' 本</span>'
    + '<button class="pg-btn" id="expNext">下一页 ›</button></div>';
  // 需求：翻页后新页必须从**顶部**开始。原来只整体替换 innerHTML，滚动容器 #exploreBooks
  // 的 scrollTop 被保留：上一页滚到底再点「下一页」，新页一渲染就停在尾部。
  scrollToTopSmooth(box);
  delete box.dataset.loading;
  box.querySelectorAll("[data-act]").forEach((el) => {
    el.onclick = () => {
      const b = JSON.parse(decodeURIComponent(el.dataset.book));
      if (el.dataset.act === "read") readOnlineBook(b);
      else if (el.dataset.act === "add") addOnlineBook(b);
      else if (el.dataset.act === "detail") openBookDetail(b);
      else if (el.dataset.act === "swap") {
        const cur = getCurrentBookMeta();
        if (cur) swapTo(cur, b); else openChangeSource(b);
      }
    };
  });
  const pv = $("expPrev"), nx = $("expNext");
  if (pv) pv.onclick = () => { if (page > 1) loadExploreBooks(url, page - 1); };
  if (nx) nx.onclick = () => loadExploreBooks(url, page + 1);
}

/**
 * 浏览器动作落地（legado 两个不同入口，桌面端按同一套实现分流）：
 *   java.startBrowser / startBrowserAwait → WebViewActivity      → 真实内核浏览器（openWebviewWindow）
 *   java.showBrowser                      → BottomWebViewDialog  → 有 html 时仍用 srcdoc iframe
 * 只带 url、不带 html 的一律走真浏览器：iframe 会被 frame-ancestors CSP 拒绝（番茄就是这样）。
 */
async function openBrowserAction(a, ctx) {
  if (!a) return;
  const origin = a.sourceUrl || (ctx && ctx.origin) || "";
  if (a.html) { chOpenAction(a, ctx); return; }
   if (!a.url) { toast("书源窗口缺少地址"); return; }
   // 光遇聚合原始规则把「登录番茄」写成 startBrowser(番茄首页)。
   // legado 的对应登录入口实际使用番茄源的 loginUrl；桌面端沿用该入口，
   // 只适配这个明确的登录动作，不改动用户导入的书源内容。
   const title = String(a.title || "");
   const target = /番茄/.test(title) && /^https:\/\/fanqienovel\.com\/?$/i.test(String(a.url).trim())
     ? "https://fanqienovel.com/main/writer/login" : a.url;
   await openWebviewWindow({
     source: origin,
     url: target,
     title: title || (ctx && ctx.name) || "",
     // 在发现页里点「登录番茄」这类入口，登录完成后必须重算发现分类：
     // ACache 命中的旧分类是登录前生成的，没有「番茄书架 / 分组」这些入口。
     onClosed: async () => {
       const panel = $("panelExplore");
       if (panel && !panel.classList.contains("hidden") && $("exploreSource").value === origin) {
         await refreshExploreKinds();
       }
     },
   });
}

/* ============================================================
 * 书源登录（legado SourceLoginActivity 的桌面端等价物）
 *
 * legado 分支：
 *   source.hasLoginForm()  → SourceLoginDialog（loginUi 渲染的表单 + 「√」执行 login()）
 *   否则                    → WebViewLoginFragment（内置 WebView 打开 loginUrl，靠 cookie 登录）
 * 两个分支在桌面端都落地成站内弹窗；WebView 分支用真实内核浏览器（见 openWebviewWindow）。
 * ============================================================ */

/**
 * loginUi 的一行 → DOM。逐类型对齐 legado SourceLoginDialog.rowUiBuilder：
 *   text/password → item_source_edit（根节点 match_parent，独占一整行；带 action 时 TextWatcher 600ms 防抖）
 *   select        → item_selector_single（sp_name + spinner 横排；初始化选择不触发 action）
 *   toggle        → item_fillet_text 药丸，点一下轮换 chars（不是复选框）
 *   button        → item_fillet_text 药丸（长按 >=666ms → isLongClick，200ms 内重复点击忽略）
 * flex 样式来自 RowUi.style（legado FlexChildStyle.layout_*），由 worker 的 rowUiStyle 映射成 CSS。
 */
function loginRowEl(it, getValues, onButton) {
  const row = document.createElement("div");
  row.className = "lg-row";
  const styleObj = (it && it.style && typeof it.style === "object") ? it.style : {};
  for (const [k, v] of Object.entries(styleObj)) { try { row.style.setProperty(k, v); } catch (err) { /* ignore */ } }
  row.style.flexShrink = "1";
  const name = it && it.name == null ? "" : String(it.name || "");
  const type = String((it && it.type) || "text");
  const charsOf = (rowUi) => (Array.isArray(rowUi && rowUi.chars) ? rowUi.chars : []).filter((c) => c != null).map((c) => String(c));
  const curVal = () => { const v = getValues(); return v[name] == null ? "" : String(v[name]); };
  const setVal = (x) => { const v = getValues(); v[name] = x; };

  if (type === "text" || type === "password") {
    // legado 里这一支的根节点是 match_parent，必然独占一行
    row.classList.add("wide");
    row.style.removeProperty("flex-basis");
    row.style.removeProperty("flex-grow");
    const lab = document.createElement("label");
    lab.className = "lg-lab";
    lab.textContent = name;
    const input = document.createElement("input");
    input.className = "lg-input";
    input.type = type === "password" ? "password" : "text";
    // legado 的 item_source_edit 用 TextInputLayout 的 hint（浮动标签）承载 name，
    // 没有第二处重复文案；我们 label 已显示 name，placeholder 再写一遍会重复。
    input.placeholder = "";
    // legado: getLoginData 里「没文本时存空字符串而不是 default」；已有 loginInfo 优先
    const init = getValues()[name];
    input.value = init == null || init === "" ? (it.default == null ? "" : String(it.default)) : String(init);
    setVal(input.value);
    let timer = null, last = input.value;
    input.oninput = () => {
      setVal(input.value);
      // legado TextWatcher.afterTextChanged：内容变了才 postDelayed(action, 600)
      if (input.value === last || !it.action) return;
      last = input.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onButton(it, false); }, 600);
    };
    lab.appendChild(input);
    row.appendChild(lab);
  } else if (type === "select") {
    row.classList.add("sel");
    if (!styleObj["flex-basis"]) row.style.flexBasis = "auto";
    const wrapEl = document.createElement("div");
    wrapEl.className = "lg-sel";
    const nm = document.createElement("span");
    nm.className = "lg-sel-name";
    nm.textContent = name;
    const sel = document.createElement("select");
    sel.className = "lg-select";
    const chars = charsOf(it);
    const list = chars.length ? chars : ["chars", "is null"];
    list.forEach((c, i) => {
      const op = document.createElement("option");
      op.value = c; op.textContent = c;
      sel.appendChild(op);
    });
    // legado: 已有值优先，否则 default ?? chars[0]，并立即写回 loginInfo
    const cur = curVal() || (it.default == null ? "" : String(it.default)) || list[0];
    const ci = list.indexOf(cur);
    sel.selectedIndex = ci < 0 ? 0 : ci;
    setVal(list[sel.selectedIndex]);
    let initing = true;   // legado: 忽略初始化时触发的 onItemSelected
    sel.onchange = () => {
      if (initing) { initing = false; return; }
      setVal(list[sel.selectedIndex] == null ? "" : list[sel.selectedIndex]);
      if (it.action) onButton(it, false);
    };
    initing = false;
    wrapEl.appendChild(nm); wrapEl.appendChild(sel);
    row.appendChild(wrapEl);
  } else if (type === "toggle") {
    // legado Type.toggle：item_fillet_text 药丸，点一下 chars 轮换，文本 = [char][viewName|name]（right 时反序）
    row.classList.add("tog");
    if (!styleObj["flex-basis"]) row.style.flexBasis = "auto";
    const chars = charsOf(it);
    const list = chars.length ? chars : ["chars is null"];
    const left = styleObj["justify-self"] !== "end" && styleStr(it) !== "right";
    let cur = curVal() || (it.default == null ? "" : String(it.default)) || list[0];
    if (list.indexOf(cur) < 0) cur = list[0];
    setVal(cur);
    const btn = document.createElement("button");
    btn.className = "lg-btn tog";
    const paint = () => { btn.textContent = left ? cur + name : name + cur; };
    paint();
    btn.onclick = () => {
      const i = list.indexOf(cur);
      cur = list[(i + 1) % list.length];
      setVal(cur);
      paint();
      if (it.action) onButton(it, false);
    };
    row.appendChild(btn);
  } else {
    // button：legado 里按钮不进 loginData（getLoginData 只取 text/password）
    row.classList.add("tog");
    if (!styleObj["flex-basis"]) row.style.flexBasis = "auto";
    const btn = document.createElement("button");
    btn.className = "lg-btn";
    btn.textContent = name || "按钮";
    let downAt = 0, lastClick = 0;
    btn.onpointerdown = () => { downAt = Date.now(); btn.classList.add("down"); };
    btn.onpointerup = () => btn.classList.remove("down");
    btn.onpointercancel = () => btn.classList.remove("down");
    btn.onclick = () => {
      const now = Date.now();
      if (now - lastClick < 200) return;   // legado: 200ms 内重复点击忽略
      lastClick = now;
      onButton(it, now - downAt > 666);    // legado: upTime > downTime + 666 → isLongClick
    };
    row.appendChild(btn);
  }
  return row;
}

/** StringExtensions.isAbsUrl —— 判断「登录地址」还是「login JS」（loginUrl / loginWebUrl 共用） */
function isAbsUrlText(v) {
  const s = String(v == null ? "" : v).trim();
  return /^https?:\/\//i.test(s);
}

/** legado FlexChildStyle.layout_justifySelf 的原值（right 表示文字在右侧） */
function styleStr(it) {
  const raw = it && it.__rawStyle && it.__rawStyle.layout_justifySelf;
  return raw == null ? "" : String(raw);
}

/** SourceLoginDialog：Toolbar（menu/source_login.xml）+ FlexboxLayout 表单 + 「✓」 */
async function openLoginDialog(url, info) {
  const wrap = document.createElement("div");
  wrap.className = "ch-modal";
  wrap.innerHTML = '<div class="ch-modal-box">'
    + '<div class="ch-modal-head lg-head"><span class="ch-modal-title"></span>'
    + '<span class="lg-tools">'
    // legado SourceLoginDialog 的菜单只有「✓ / 登录信息 / ⊘ / 日志」；
    // 「打开登录页」= WebViewLoginFragment 分支的入口。判定用 worker 给的 loginWebUrl：
    // loginUrl 是 URL → 取它；loginUrl 是 JS 但 loginUi 写的是 URL（饿狼小说）→ 取 loginUi，
    // 否则 legado 会走进「hasLoginForm=true 的表单分支」并渲染出 0 行空白表单，用户无处可登。
    + (isAbsUrlText(info.loginWebUrl) ? '<button class="lg-act lg-open" title="用内置浏览器打开登录页（WebViewLoginFragment 分支）">打开登录页</button>' : '')
    + '<button class="lg-act lg-header" title="查看登录请求头">登录信息</button>'
    + '<button class="lg-act icon lg-clear" title="清除登录信息与 Cookie">⊘</button>'
    + '<button class="lg-act primary lg-ok" title="保存并执行 login()（Enter）">✓ 登录</button>'
    + '<button class="icon-btn ch-modal-x" title="关闭">✕</button>'
    + '</span></div>'
    + '<div class="lg-body"></div></div>';
  document.body.appendChild(wrap);
  wrap.querySelector(".ch-modal-title").textContent = info.sourceName ? ("登录 " + info.sourceName) : "登录";
  const body = wrap.querySelector(".lg-body");

  let uis = Array.isArray(info.uis) ? info.uis.slice() : [];
  let values = Object.assign({}, info.loginInfo || {});
  const getValues = () => values;
  let closed = false;
  const onKey = (e) => {
    if (e.key === "Escape") close();
    // legado：Toolbar 的 menu_ok 是 always，回车即「✓ 登录」
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); wrap.querySelector(".lg-ok").click(); }
  };
  const close = () => { if (closed) return; closed = true; document.removeEventListener("keydown", onKey); wrap.remove(); };
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".ch-modal-x").onclick = () => close();
  // 需求：不能点空白就关（legado 是独立 Activity / Dialog，误触不会丢登录窗）

  function render() {
    body.innerHTML = "";
    if (!uis.length) {
      // 有 web 入口才提「打开登录页」；没有就别给死指引（legado 这里是 0 行空白表单）
      const hasWeb = isAbsUrlText(info.loginWebUrl);
      body.innerHTML = '<div class="hint">' + (hasWeb
        ? '这个书源的登录界面交给内置浏览器：点右上角「打开登录页」登录，关窗时会自动保存 Cookie。'
        : '这个书源没有可填写的登录界面（loginUi 解析不出任何表单行）。') + '</div>';
      return;
    }
    const grid = document.createElement("div");
    grid.className = "lg-grid";
    for (const it of uis) grid.appendChild(loginRowEl(it, getValues, onButton));
    body.appendChild(grid);
  }

  /** 按钮 action：isAbsUrl → 内置浏览器；否则 evalJS(loginJs + action) */
  async function onButton(it, isLongClick) {
    const act = it && it.action != null ? String(it.action) : "";
    if (!act) return;
    if (/^https?:/i.test(act)) {
      await openWebviewWindow({ source: url, url: act, title: it.name || "登录" });
      return;
    }
    const r = await api("/api/online/login/action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: url, action: act, name: it.name || "", result: values, rowUis: uis, isLongClick: isLongClick === true }),
    }).catch((e) => ({ ok: false, error: e.message }));
    if (r && r.loginInfo && typeof r.loginInfo === "object") values = Object.assign({}, r.loginInfo, values);
    // makeLoginJava 收集的 java.open / java.openUrl / java.searchBook 全部按 legado 语义落地；
    // openUrl 在登录上下文里必须走站内浏览器并回写 Cookie（不然番茄这类站点登录态拿不到）。
    const rest = await applyActions(r && r.actions, { origin: url });
    for (const a of rest) {
      if (a.type === "reLoginView" || a.type === "refreshExplore") await refresh();
      else if (a.type === "upLoginData") applyUpLoginData(a.data);
    }
    if (r && r.ok === false) toast("执行失败：" + String(r.error || "").slice(0, 120));
  }

  /**
   * java.upLoginData / reUiView（legado handleUpUiData）：把新值灌回表单。
   * legado 用 findViewById(index+1000) 回填，这里按同名行重建整张表单更稳。
   */
  function applyUpLoginData(data) {
    if (data == null) {
      values = {};
    } else if (typeof data === "object") {
      const next = Object.assign({}, values);
      for (const [k, v] of Object.entries(data)) next[k] = v == null ? "" : String(v);
      values = next;
    }
    render();
  }

  /** java.reLoginView / upLoginData：重新求值 loginUi（legado 是重跑 @js: 那段） */
  async function refresh() {
    const r = await api("/api/online/login/info?source=" + encodeURIComponent(url)).catch(() => null);
    if (r && r.ok && Array.isArray(r.uis)) { uis = r.uis; render(); }
  }

  wrap.querySelector(".lg-ok").onclick = async () => {
    // legado SourceLoginDialog.getLoginData()：
    //   viewModel.loginInfo.toMutableMap() + 当前 text/password 输入值。
    // values 在 rowUiBuilder 渲染时会被所有行（select/toggle 也会）写回，
    // 因此这里等价于「loginInfo 全量 + 当前输入」，而不是只取输入框。
    const data = Object.assign({}, values);
    for (const it of uis) {
      if (!it || it.type === "button") continue;
      if (it.type === "text" || it.type === "password") data[it.name] = values[it.name] == null ? "" : String(values[it.name]);
    }
    if (!Object.keys(data).length) {
      // legado SourceLoginDialog.login()：loginData.isEmpty() → source.removeLoginInfo() + dismiss()。
      // removeLoginInfo 只删 userInfo（不动 Cookie / 请求头），legado 这里也没有 Toast —— 直接关窗。
      // 「清除登录信息与 Cookie」是工具栏 ⊘ 的语义，两者不能混。
      await api("/api/online/login/logout", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: url, clearCookies: false, clearHeaders: false }),
      }).catch(() => {});
      close();
      return;
    }
    const r = await api("/api/online/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: url, loginData: data }),
    }).catch((e) => ({ ok: false, error: e.message }));
    await applyActions(r && r.actions, { origin: url });
    if (r && r.ok) { toast("登录已保存"); close(); }
    else toast("登录出错：" + String((r && r.error) || "").slice(0, 120));
  };
  // 该按钮只在 loginUrl 是 URL 时渲染（见上方 lg-tools），JS 形态下不存在 → 必须判空，
  // 否则这里会抛 TypeError 打断 openLoginDialog，导致整个表单渲染不出来。
  const lgOpenBtn = wrap.querySelector(".lg-open");
  if (lgOpenBtn) lgOpenBtn.onclick = async () => {
    // loginWebUrl 已由 worker 归一：loginUrl（URL 形态）优先，其次 URL 形态的 loginUi
    const u = info.loginWebUrl;
    if (!isAbsUrlText(u)) { toast("该书源没有可用的登录页地址"); return; }
    const w = await openWebviewWindow({ source: url, url: u, kind: "login", title: "登录" + (info.sourceName ? (" " + info.sourceName) : "") });
    // 关窗时把浏览器 cookie 回写进书源 CookieStore，再顺手跑一次 login()
    if (w && w.session) {
      const prev = w.close;
      w.close = async () => {
        const cookie = await api("/api/online/webview/cookies", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ tab: w.session.tabId, source: url, loginData: values }),
        }).catch(() => null);
        await prev();
        if (cookie && cookie.cookie) toast("已保存登录 Cookie");
      };
    }
  };
  wrap.querySelector(".lg-header").onclick = async () => {
    const r = await api("/api/online/login/info?source=" + encodeURIComponent(url)).catch(() => null);
    const hm = (r && r.headerMap) || {};
    const keys = Object.keys(hm);
    const msg = "登录信息：\n" + JSON.stringify(values, null, 2)
      + "\n\n登录请求头：" + (keys.length ? ("\n" + keys.map((k) => k + ": " + hm[k]).join("\n")) : "（无，说明还没登录成功过）");
    await askConfirm(msg, "复制", "关闭") && navigator.clipboard && navigator.clipboard.writeText(msg).catch(() => {});
  };
  wrap.querySelector(".lg-clear").onclick = async () => {
    if (!(await askConfirm("清除该书源的登录信息与 Cookie？", "清除"))) return;
    await api("/api/online/login/logout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: url }),
    }).catch(() => {});
    values = {};
    await refresh();
    toast("已清除登录信息");
  };

  render();
}

/**
 * 书源登录入口（SourceLoginActivity.initView）。
 * 有 loginUi 表单 → 表单弹窗；否则 → 内置浏览器打开 loginUrl（WebViewLoginFragment）。
 */
async function openSourceLogin(url) {
  const info = await api("/api/online/login/info?source=" + encodeURIComponent(url)).catch((e) => ({ ok: false, error: e.message }));
  if (!info || info.ok === false) { toast("读取登录信息失败：" + String((info && info.error) || "未知错误")); return; }
  const hasForm = info.hasLoginForm === true;
  if (hasForm) { await openLoginDialog(url, info); return; }
  // 无表单分支 = legado 的 WebViewLoginFragment：优先 loginUrl，其次 URL 形态的 loginUi
  const webUrl = isAbsUrlText(info.loginWebUrl) ? info.loginWebUrl : (isAbsUrlText(info.loginUrl) ? info.loginUrl : null);
  if (!webUrl && !info.loginUrl) { toast("该书源没有登录界面"); return; }
  // legado WebViewLoginFragment.loadUrl 走 NetworkUtils.getAbsoluteURL：
  // loginUrl 可能是相对路径（得奇小说 login.php?...），交给服务端按书源地址拼绝对地址。
  // 但若整段是 JS（光遇/七猫这种 hasLoginForm 为真的源不会走到这里），不能当地址用。
  if (!isAbsUrlText(info.loginUrl) && /function\s|=>|\bjava\./.test(String(info.loginUrl))) {
    toast("该书源的 loginUrl 是 JS 代码，请用「✓ 登录」执行"); return;
  }
  const w = await openWebviewWindow({ source: url, url: webUrl || info.loginUrl, kind: "login", title: "登录" + (info.sourceName ? (" " + info.sourceName) : "") });
  if (!w || !w.session) return;
  const prev = w.close;
  // 关闭前：CookieManager.getCookie(url) → CookieStore.setCookie(source.getKey(), cookie)
  w.close = async () => {
    await api("/api/online/webview/cookies", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: w.session.tabId, source: url }),
    }).catch(() => null);
    await prev();
    toast("已保存登录 Cookie");
  };
}

/* ============================================================
 *  需求 C2：确认框居中
 *  原来用原生 confirm()，弹在浏览器顶部，与阅读器 UI 不协调。
 *  legado 的 AlertDialog 是屏幕居中的 Material 对话框，这里等价还原。
 * ============================================================ */

function askConfirm(msg, okText = "确定", cancelText = "取消") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask-modal";
    const box = document.createElement("div");
    box.className = "ask-box";
    const m = document.createElement("div");
    m.className = "ask-msg";
    m.textContent = msg;
    const foot = document.createElement("div");
    foot.className = "ask-foot";
    const no = document.createElement("button");
    no.className = "ghost-btn";
    no.textContent = cancelText;
    const ok = document.createElement("button");
    ok.className = "ask-ok";
    ok.textContent = okText;
    foot.appendChild(no); foot.appendChild(ok);
    box.appendChild(m); box.appendChild(foot);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    function onKey(e) {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    }
    ok.onclick = () => done(true);
    no.onclick = () => done(false);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

/* ============================================================
 *  站内输入 / 文本查看弹窗（本轮补齐）
 *  之前这里到处是原生 prompt()/alert()：弹在浏览器顶部、样式与阅读器割裂，
 *  而且 prompt 是阻塞式的，脚本只能停在原地。legado 全部用 AlertDialog：
 *    · 单个输入  → alert { DialogEditTextBinding }         dialog_edit_text.xml
 *    · 多个输入  → alert { DialogMultipleEditTextBinding } dialog_multiple_edit_text.xml
 *    · 只读长文  → TextDialog                              dialog_text_view.xml
 *  下面三个函数就是这三者的等价物，样式沿用本项目的 .ask-modal / .ask-box。
 * ============================================================ */

/**
 * 多字段输入（legado dialog_multiple_edit_text.xml：N 个 TextInputLayout 竖排）。
 * @param {string} title 标题
 * @param {Array<{key:string,label:string,value?:string,placeholder?:string,area?:boolean,check?:{label:string,checked:boolean}}>} fields
 * @returns {Promise<Object|null>} 确认 → { 字段key: 值, __check: {key:bool} }；取消 → null
 */
function askFields(title, fields, opts) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask-modal";
    wrap.innerHTML = '<div class="ask-box ask-form">'
      + '<div class="ask-title"></div><div class="ask-fields"></div>'
      + '<div class="ask-foot"><button class="ghost-btn ask-no">取消</button>'
      + '<button class="ask-ok ask-yes">确定</button></div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector(".ask-title").textContent = title || "";
    const box = wrap.querySelector(".ask-fields");
    const inputs = [];
    const checks = [];
    for (const f of fields || []) {
      const row = document.createElement("div");
      row.className = "ask-field";
      // 纯复选框行（label 为空白、只带 check）在 legado 里是独立的 CheckBox 控件
      // （activity_replace_edit.xml 的 cb_use_regex 等），没有配套 EditText。
      // 之前这里无条件渲染输入框，于是「使用正则表达式」下面多出一个空文本框。
      const checkOnly = !!f.check && !String(f.label == null ? "" : f.label).trim();
      if (!checkOnly) {
        const lab = document.createElement("div");
        lab.className = "ask-lab";
        lab.textContent = f.label || f.key || "";
        row.appendChild(lab);
        let el;
        if (f.area) {
          el = document.createElement("textarea");
          el.className = "ask-area";
          if (f.rows) el.rows = f.rows;
        } else {
          el = document.createElement("input");
          el.className = "ask-input";
          el.type = f.type || "text";
        }
        el.value = f.value == null ? "" : String(f.value);
        if (f.placeholder) el.placeholder = f.placeholder;
        row.appendChild(el);
        inputs.push({ f, el });
      }
      if (f.check) {
        const cl = document.createElement("label");
        cl.className = "ask-lab imp-row";
        cl.innerHTML = '<input type="checkbox"><span></span>';
        cl.querySelector("span").textContent = f.check.label || "";
        const cb = cl.querySelector("input");
        cb.checked = f.check.checked !== false;
        checks.push({ f, cb });
        row.appendChild(cl);
      }
      box.appendChild(row);
    }
    const done = (v) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const collect = () => {
      const out = {};
      for (const { f, el } of inputs) out[f.key] = el.value;
      for (const { f, cb } of checks) out["__" + f.key] = cb.checked;
      return out;
    };
    function onKey(e) {
      // textarea 里回车是换行，不能当确认
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") done(collect());
    }
    document.addEventListener("keydown", onKey);
    // legado 编辑页菜单里的「拷贝规则 / 粘贴规则」以底部附加按钮的形式塞进来
    const o = opts || {};
    if (Array.isArray(o.footExtra)) {
      for (const x of o.footExtra) {
        const eb = document.createElement("button");
        eb.className = "ghost-btn";
        eb.textContent = x.text;
        eb.onclick = () => x.run({
          values: collect,
          set: (k, v) => {
            const h = inputs.find((a) => a.f.key === k);
            if (h) h.el.value = v == null ? "" : String(v);
            const c = checks.find((a) => a.f.key === k);
            if (c) c.cb.checked = !!v;
          },
        });
        wrap.querySelector(".ask-foot").insertBefore(eb, wrap.querySelector(".ask-no"));
      }
    }
    wrap.querySelector(".ask-no").onclick = () => done(null);
    wrap.querySelector(".ask-yes").onclick = () => done(collect());
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    if (inputs.length) { inputs[0].el.focus(); inputs[0].el.select && inputs[0].el.select(); }
  });
}

/** 单字段输入（legado dialog_edit_text.xml）。返回字符串；取消返回 null。 */
async function askPrompt(title, label, value, opts) {
  const o = opts || {};
  const r = await askFields(title, [{ key: "v", label, value, area: o.area, rows: o.rows, placeholder: o.placeholder }]);
  return r === null ? null : r.v;
}

/**
 * 只读文本窗（legado TextDialog / dialog_text_view.xml：Toolbar + 可滚动 TextView）。
 * @param {string} title 标题
 * @param {string} content 正文
 * @param {object} [opts] { copy: boolean } 是否给「复制」按钮
 */
function askText(title, content, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "ask-modal";
    wrap.innerHTML = '<div class="txt-box">'
      + '<div class="txt-head"><span class="txt-title"></span>'
      + '<button class="icon-btn txt-x" title="关闭">\u2715</button></div>'
      + '<pre class="txt-body"></pre>'
      + '<div class="txt-foot"><button class="ghost-btn txt-copy">复制</button>'
      + '<button class="primary-btn txt-ok">关闭</button></div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector(".txt-title").textContent = title || "";
    // legado TextDialog 对超长文本会截断（32KB），这里同样保护一下 DOM
    const s = String(content == null ? "" : content);
    wrap.querySelector(".txt-body").textContent = s.length > 200000 ? (s.slice(0, 200000) + "\n\n…（内容过长，已截断显示）") : s;
    if (o.copy === false) wrap.querySelector(".txt-copy").remove();
    const done = () => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(true); };
    function onKey(e) { if (e.key === "Escape" || e.key === "Enter") done(); }
    document.addEventListener("keydown", onKey);
    wrap.querySelector(".txt-x").onclick = done;
    wrap.querySelector(".txt-ok").onclick = done;
    const cp = wrap.querySelector(".txt-copy");
    if (cp) cp.onclick = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(s).then(() => toast("已复制"), () => toast("复制失败"));
    };
    wrap.onclick = (e) => { if (e.target === wrap) done(); };
    wrap.querySelector(".txt-ok").focus();
  });
}

/* ============================================================
 *  需求 C1：右侧目录栏放大字号 + 加大行距
 *  app.js 的虚拟滚动把行高硬编码成 itemH = 31（app.js:749），
 *  且 markTocActive 会读 state.tocVirtual.itemH（app.js:788），
 *  所以这里整体覆写 renderToc，并把 itemH 提到 38：
 *      18px * 1.5556 + 2 * 5px = 38px  （online.css .toc-item 同步）
 * ============================================================ */

const TOC_ITEM_H = 38;

renderToc = function () {
  const box = $("tocList");
  box.innerHTML = "";
  if (!state.book) return;
  const chapters = state.book.chapters;
  const n = chapters.length;
  const pad = document.createElement("div");
  const inner = document.createElement("div");
  const itemH = TOC_ITEM_H;
  state.tocVirtual = { itemH, top: 0, count: n };
  pad.style.position = "relative";
  inner.style.position = "absolute"; inner.style.left = 0; inner.style.right = 0; inner.style.top = 0;
  box.appendChild(pad);
  box.appendChild(inner);
  function paint() {
    const boxH = box.clientHeight || 400;
    const start = Math.max(0, Math.floor(box.scrollTop / itemH) - 3);
    const end = Math.min(n, start + Math.ceil(boxH / itemH) + 6);
    pad.style.height = n * itemH + "px";
    inner.style.top = start * itemH + "px";
    inner.innerHTML = "";
    for (let i = start; i < end; i++) {
      const c = chapters[state.tocDesc ? n - 1 - i : i];
      if (!c) continue;
      const el = document.createElement("div");
      el.className = "toc-item" + (c.idx === state.chapterIdx ? " active" : "");
      el.textContent = c.title;
      el.dataset.idx = c.idx;
      el.onclick = () => gotoChapter(c.idx);
      inner.appendChild(el);
    }
  }
  box.scrollTop = 0;
  box.onscroll = paint;
  paint();
  state.tocPaint = paint;
  window.__tocPaint = paint;
};

/* ============================================================
 *  替换净化（legado ui/replace/ReplaceRuleActivity + ReplaceRuleAdapter）
 *  · 顶部搜索框 = SearchView：支持「已启用 / 已禁用 / 未分组 / group:xxx」四种前缀，
 *    其余按 ReplaceRuleDao.flowSearch（group like OR name like）过滤。
 *  · 列表项 = item_replace_rule.xml：[checkbox 名称(分组)] [启用开关] [编辑] [⋮]
 *    ⋮ = menu/replace_rule_item.xml：置顶(to_top) / 置底(to_bottom) / 删除(delete)
 *  · 底部 SelectActionBar 只保留「全选 / 反选」两个批量按钮（2026-09-19 用户指定）：
 *    全选 = 一键启用当前可见规则（全部已启用时变「取消全选」→ 一键停用），反选 = 已启用的停用、未启用的启用
 *    原来的启用/禁用/置顶/置底/导出/删除批量按钮全部删除，行内 ⋮ 菜单仍保留置顶/置底/删除
 *  · 编辑 = ReplaceEditActivity（activity_replace_edit.xml 字段顺序），菜单里带
 *    拷贝规则 / 粘贴规则（replace_edit.xml）。
 * ============================================================ */

let replaceRules = [];
let replaceGroups = [];
let replaceFilter = "";
let replaceOpen = false;
let txtTocRules = [];
let txtTocFilter = "";
let replaceTab = "replace";

const RP_I18N = {
  enabled: "已启用", disabled: "已禁用", noGroup: "未分组",
  all: "全选", cancelAll: "取消全选", delete: "删除", edit: "编辑",
  toTop: "置顶", toBottom: "置底", copyRule: "拷贝规则", pasteRule: "粘贴规则",
};

async function openReplace() {
  $("panelReplace").classList.remove("hidden");
  replaceOpen = true;
  // 需求：TXT 目录规则只对本地 txt 生效（legado TextFile.kt）——
  // 移到「本地」阅读界面；在线模式不再提供该 Tab。
  const local = state.mode !== "online";
  document.querySelectorAll("#replaceTabs .rt-tab").forEach((b) => {
    if (b.dataset.rtab === "txtToc") b.classList.toggle("hidden", !local);
  });
  let tab = replaceTab || "replace";
  if (!local && tab === "txtToc") tab = "replace";
  activateReplaceTab(tab);
  await Promise.all([reloadReplaceRules(), local ? reloadTxtTocRules() : Promise.resolve()]);
}

function activateReplaceTab(tab) {
  replaceTab = tab === "txtToc" ? "txtToc" : "replace";
  const isToc = replaceTab === "txtToc";
  $("replacePane")?.classList.toggle("hidden", isToc);
  $("txtTocPane")?.classList.toggle("hidden", !isToc);
  $("replacePanelTitle").textContent = isToc ? "TXT 目录规则" : "替换净化";
  document.querySelectorAll("#replaceTabs .rt-tab").forEach((b) => b.classList.toggle("active", b.dataset.rtab === replaceTab));
  if (isToc) reloadTxtTocRules().catch(() => {});
  else reloadReplaceRules().catch(() => {});
}

/**
 * 替换净化改动后让正文按新规则重渲染。
 * 后端 /api/online/content 是「抓原始正文 → 实时跑净化」，所以规则改动只需失效前端
 * chapterCache 再读一次即可恢复原样；后端 contentCache 存的是未净化的原文，不受影响。
 */
function invalidateChapterRender() {
  chapterCache.clear();
  if (state.mode !== "online") {
    if (typeof localBookDataCache !== "undefined") localBookDataCache.clear();
    // 本地：替换净化同时作用于正文与标题（对齐 legado ReadBook / BookChapter.getDisplayTitle），
    // 规则变动后重读 /api/book 与当前章即可。
    const lb = state.book;
    if (lb && lb.rel) {
      const keepIdx = state.chapterIdx;
      const keepRatio = getScrollRatio();
      openBook({ rel: lb.rel, name: lb.name || lb.title || "" }, { keepChapter: false })
        .then(() => gotoChapter(keepIdx, keepRatio))
        .catch(() => {});
    }
    return;
  }
  if (state.book) {
    // 标题净化规则同时作用于正文标题与目录标题（legado BookChapter.getDisplayTitle）。
    // 规则一变：丢掉本会话目录缓存 → 重新拉一次目录（后端命中 TOC 缓存，开销极小），
    // 就地改写章标题，保证「右侧目录 / 正文头 / 详情页目录弹窗」三处始终一致。
    const rel = state.book.rel;
    if (rel) onlineTocCacheDrop(rel);
    refreshOnlineTocTitles().catch(() => {});
    runChapter(state.chapterIdx, getScrollRatio()).catch(() => {});
  }
}

/** 只刷新当前书的章标题（不动章序、不动阅读位置）；净化规则启停/改序后调用。 */
async function refreshOnlineTocTitles() {
  const bk = state.book;
  if (!bk || !bk.origin || !bk.bookUrl) return;
  const qp = "origin=" + encodeURIComponent(bk.origin) + "&url=" + encodeURIComponent(bk.bookUrl);
  const r = await api("/api/online/chapters?" + qp).catch(() => null);
  if (!state.book || state.book !== bk) return;                 // 中途换书就丢弃
  const list = (r && r.ok !== false && r.chapters) || [];
  const prev = bk.chapters || [];
  if (!list.length || list.length !== prev.length) return;      // 长度不一致宁可不动
  let changed = false;
  for (let i = 0; i < prev.length; i++) {
    const t = list[i] && list[i].title;
    if (t && prev[i] && prev[i].title !== t) { prev[i].title = t; changed = true; }
  }
  if ($("tocCount")) $("tocCount").textContent = prev.length + " 项";
  if (changed) renderToc();
  // 详情页目录弹窗复用的是 biBook.chapters，同一本书时一并同步
  if (biBook && biBook.chapters && biBook.chapters.length === prev.length
    && okey(biBook.origin, biBook.bookUrl) === okey(bk.origin, bk.bookUrl)) {
    for (let i = 0; i < prev.length; i++) biBook.chapters[i].title = prev[i].title;
    const head = document.querySelector(".tocm-title");
    if (head && !$("tocModal").classList.contains("hidden")) {
      const li = $("tocmList");
      if (li) li.querySelectorAll(".tocm-item").forEach((el, i) => {
        const nm = el.querySelector(".tocm-name");
        if (nm && biBook.chapters[i]) nm.textContent = biBook.chapters[i].title || "";
        if (biBook.chapters[i]) el.title = biBook.chapters[i].title || "";
      });
    }
  }
}

async function reloadReplaceRules(touchContent) {
  const [r, g] = await Promise.all([
    api("/api/replace-rules").catch(() => ({ rules: [] })),
    api("/api/replace-rules/groups").catch(() => ({ groups: [] })),
  ]);
  replaceRules = r.rules || [];
  replaceGroups = g.groups || [];
  renderReplaceRules();
  if (touchContent) invalidateChapterRender();
}

/** 数字标题两条内置规则互斥（与 server.mjs NUMERIC_TITLE_RULE_IDS 对应） */
const NUMERIC_TITLE_IDS = ["builtin-netclean-0", "builtin-netclean-1"];

/** ReplaceRule.getDisplayNameGroup()：group 空 → name，否则 "name (group)" */
function replaceDisplayName(r) {
  const g = r.group == null ? "" : String(r.group);
  return g.trim() ? r.name + " (" + g + ")" : (r.name || "");
}

/** 复刻 ReplaceRuleActivity.observeReplaceRuleData 的六路分支 */
function replaceFiltered() {
  const k = (replaceFilter || "").trim();
  const list = replaceRules.slice();
  if (!k) return list;
  if (k === RP_I18N.enabled) return list.filter((r) => r.isEnabled !== false);
  if (k === RP_I18N.disabled) return list.filter((r) => r.isEnabled === false);
  if (k === RP_I18N.noGroup) return list.filter((r) => !String(r.group == null ? "" : r.group).trim()
    || String(r.group).trim().includes(RP_I18N.noGroup));
  if (k.startsWith("group:")) {
    const key = k.slice("group:".length);
    return list.filter((r) => String(r.group == null ? "" : r.group).includes(key));
  }
  const low = k.toLowerCase();
  return list.filter((r) => String(r.group == null ? "" : r.group).toLowerCase().includes(low)
    || String(r.name || "").toLowerCase().includes(low));
}

/** 通用小浮层菜单（复用 .bk-menu 样式），items = [[文字, 回调, 是否危险]] */
function popupMenu(x, y, items) {
  document.getElementById("popMenu")?.remove();
  const menu = document.createElement("div");
  menu.className = "bk-menu";
  menu.id = "popMenu";
  menu.innerHTML = items.map(([t], i) => '<button class="bk-menu-item' + (items[i][2] ? " danger" : "")
    + '" data-i="' + i + '">' + esc(t) + "</button>").join("");
  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth - 150) + "px";
  menu.style.top = Math.min(y, window.innerHeight - items.length * 30 - 12) + "px";
  menu.querySelectorAll(".bk-menu-item").forEach((el) => {
    el.onclick = () => { const f = items[Number(el.dataset.i)][1]; menu.remove(); f(); };
  });
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

function renderReplaceRules() {
  const box = $("replaceList");
  const list = replaceFiltered();
  $("replaceStat").textContent = replaceRules.length
    ? `${replaceRules.length} 条（启用 ${replaceRules.filter((x) => x.isEnabled !== false).length}）`
      + (replaceFilter.trim() ? ` · 筛选出 ${list.length}` : "")
    : "";
  if (!list.length) {
    box.innerHTML = '<div class="hint">' + (replaceRules.length
      ? "没有匹配的规则" : "还没有替换规则。点上方「新建替换」添加，或「本地导入 / 网络导入」导入规则集") + "</div>";
    renderReplaceSelBar();
    return;
  }
  box.innerHTML = list.map((r) => {
    const on = r.isEnabled !== false;
    const sub = "替换内容 " + esc(String(r.pattern).slice(0, 40))
      + " → " + esc(String(r.replacement == null ? "" : r.replacement).slice(0, 20))
      + (r.isRegex === false ? " · 纯文本" : " · 正则")
      + (r.scopeTitle === true ? " · 标题" : "")
      + (r.scopeContent !== false ? " · 正文" : "")
      + (String(r.scope || "").trim() ? " · 范围:" + esc(String(r.scope).slice(0, 20)) : "")
      + (String(r.excludeScope || "").trim() ? " · 排除:" + esc(String(r.excludeScope).slice(0, 20)) : "");
    return '<div class="src-row rp-row' + (on ? "" : " off") + '" data-id="' + esc(r.id) + '">'
      + '<label class="rp-check" title="勾选启用这条净化规则"><input type="checkbox" data-act="toggle"' + (on ? " checked" : "") + "></label>"
      + '<div class="src-info"><div class="src-name">' + esc(replaceDisplayName(r))
      + (r.builtin ? '<span class="rp-builtin">内置</span>' : '')
      + (NUMERIC_TITLE_IDS.includes(String(r.id)) ? '<span class="rp-builtin rp-xor" title="数字标题两条规则互斥：开启其中一条会自动关闭另一条">二选一</span>' : '')
      + "</div>"
      + '<div class="src-sub">' + sub + "</div></div>"
      + '<button class="mini-btn rp-ico" data-act="edit" title="编辑">✎</button>'
      + '<button class="mini-btn rp-ico" data-act="menu" title="更多">⋮</button>'
      + "</div>";
  }).join("");
  box.querySelectorAll(".rp-row").forEach((row) => {
    const id = row.dataset.id;
    const rule = replaceRules.find((x) => x.id === id);
    row.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (act === "toggle") {
        el.onchange = async () => {
          const res = await api("/api/replace-rules/toggle", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [id], enabled: el.checked }),
          }).catch((e) => ({ error: e.message }));
          if (res && res.error) { toast("保存失败：" + res.error); el.checked = !el.checked; return; }
          const autoOff = (res && Array.isArray(res.mutexDisabled)) ? res.mutexDisabled : [];
          if (autoOff.length) {
            toast(`「${autoOff[0].name}」已自动关闭（两条数字标题规则互斥，只能启用一条）`);
            await reloadReplaceRules(true);
            return;
          }
          rule.isEnabled = el.checked;
          row.classList.toggle("off", !el.checked);
          renderReplaceSelBar();
          $("replaceStat").textContent = replaceRules.length
            ? `${replaceRules.length} 条（启用 ${replaceRules.filter((x) => x.isEnabled !== false).length}）`
            : "";
          invalidateChapterRender();
        };
      } else if (act === "edit") {
        el.onclick = () => editReplaceRule(rule);
      } else if (act === "menu") {
        el.onclick = (e) => {
          e.stopPropagation();
          const rect = el.getBoundingClientRect();
          popupMenu(rect.right - 120, rect.bottom + 4, [
            [RP_I18N.toTop, () => replaceOrder(id, "top")],
            [RP_I18N.toBottom, () => replaceOrder(id, "bottom")],
            [RP_I18N.delete, () => replaceDelete([id]), true],
          ]);
        };
      }
    });
  });
  renderReplaceSelBar();
}

/**
 * 底部栏（2026-09-19 用户指定只留两个按钮）：
 *   [全选 (已启用/可见)]  全部已启用时按钮变「取消全选」，点一下即停用全部可见规则
 *   [反选]               可见规则里已启用的停用、未启用的启用
 * 计数与 legado SelectActionBar.upCountView 一致（已选/总数），这里对应「已启用/可见条数」。
 * 栏位常显，不再随勾选浮出。
 */
function renderReplaceSelBar() {
  const bar = $("replaceSelBar");
  if (!bar) return;
  const list = replaceFiltered();
  const on = list.filter((r) => r.isEnabled !== false).length;
  const allOn = list.length > 0 && on >= list.length;
  const allBtn = bar.querySelector('[data-sel="all"]');
  if (allBtn) allBtn.textContent = (allOn ? RP_I18N.cancelAll : RP_I18N.all) + `（${on}/${list.length}）`;
}

/** 批量开关替换规则；返回 false 表示请求失败 */
async function replaceToggleIds(ids, enabled) {
  const res = await api("/api/replace-rules/toggle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, enabled }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) { toast("操作失败：" + res.error); return false; }
  const autoOff = (res && Array.isArray(res.mutexDisabled)) ? res.mutexDisabled : [];
  if (autoOff.length) toast(`「${autoOff[0].name}」已自动关闭（两条数字标题规则互斥，只能启用一条）`);
  return true;
}

async function replaceOrder(id, action) {
  const res = await api("/api/replace-rules/order", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("操作失败：" + res.error);
  await reloadReplaceRules(true);
}

async function replaceDelete(ids) {
  const one = ids.length === 1 ? replaceRules.find((x) => x.id === ids[0]) : null;
  if (!(await askConfirm("是否确认删除？" + (one ? "\n" + replaceDisplayName(one) : ""), "删除"))) return;
  const res = await api("/api/replace-rules/delete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("删除失败：" + res.error);
  await reloadReplaceRules(true);
  toast("已删除");
}


/* ============================================================
 *  TXT 目录规则（legado TxtTocRuleActivity + TxtTocRuleAdapter）
 *  · 搜索：名称 / 示例，对应 TxtTocRuleFilter.filterByKeyword
 *  · 行：[勾选 名称] [示例] [启用开关] [编辑] [⋮ 置顶/置底/删除]
 *  · 底部 SelectActionBar 只保留「全选 / 反选」（批量启用、停用），行内 ⋮ 菜单保留置顶/置底/删除
 *  · 编辑：名称 / 正则 / 替换（JS） / 示例，对应 dialog_toc_regex_edit.xml
 * ============================================================ */
function txtTocDisplayName(r) {
  return r && r.name ? String(r.name) : "未命名规则";
}

function txtTocFiltered() {
  const k = String(txtTocFilter || "").trim().toLowerCase();
  const list = txtTocRules.slice();
  if (!k) return list;
  return list.filter((r) => String(r.name || "").toLowerCase().includes(k)
    || String(r.example || "").toLowerCase().includes(k));
}

async function reloadTxtTocRules(touchContent) {
  const r = await api("/api/txt-toc-rules").catch(() => ({ rules: [] }));
  txtTocRules = Array.isArray(r.rules) ? r.rules : [];
  renderTxtTocRules();
  if (touchContent) invalidateTocRuleRender();
}

function invalidateTocRuleRender() {
  chapterCache.clear();
  if (typeof localBookDataCache !== "undefined") localBookDataCache.clear();
  if (state.mode === "local" && state.book) {
    openBook(state.book, { keepChapter: true }).catch(() => {});
  }
}

function renderTxtTocRules() {
  const box = $("txtTocList");
  if (!box) return;
  const list = txtTocFiltered();
  const total = txtTocRules.length;
  const enabled = txtTocRules.filter((x) => x.enable === true).length;
  const stat = $("txtTocStat");
  if (stat) stat.textContent = total ? total + " 条（启用 " + enabled + "）" + (txtTocFilter.trim() ? " · 筛选出 " + list.length : "") : "";
  if (!list.length) {
    box.innerHTML = '<div class="hint">' + (total
      ? "没有匹配的目录规则" : "还没有 TXT 目录规则。点上方「新增」或「导入默认规则」添加") + "</div>";
    renderTxtTocSelBar();
    return;
  }
  box.innerHTML = list.map((r) => {
    const on = r.enable === true;
    const rule = String(r.rule == null ? "" : r.rule);
    const rep = String(r.replacement == null ? "" : r.replacement);
    const sub = "正则 " + esc(rule.slice(0, 52))
      + (rep ? " · 替换 " + esc(rep.slice(0, 34)) : "")
      + (r.builtin ? " · 内置" : "");
    return '<div class="src-row rp-row' + (on ? "" : " off") + '" data-id="' + esc(r.id) + '">'
      + '<label class="rp-check" title="勾选启用这条目录规则"><input type="checkbox" data-act="toggle"' + (on ? " checked" : "") + "></label>"
      + '<div class="src-info"><div class="src-name">' + esc(txtTocDisplayName(r))
      + (r.builtin ? '<span class="rp-builtin">内置</span>' : '') + "</div>"
      + '<div class="src-sub">' + sub + (r.example ? " · 示例：" + esc(String(r.example).slice(0, 44)) : "") + "</div></div>"
      + '<button class="mini-btn rp-ico" data-act="edit" title="编辑">✎</button>'
      + '<button class="mini-btn rp-ico" data-act="menu" title="更多">⋮</button>'
      + "</div>";
  }).join("");
  box.querySelectorAll(".rp-row").forEach((row) => {
    const id = String(row.dataset.id);
    const rule = txtTocRules.find((x) => String(x.id) === id);
    row.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (act === "toggle") {
        el.onchange = async () => {
          const res = await api("/api/txt-toc-rules/toggle", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [id], enabled: el.checked }),
          }).catch((e) => ({ error: e.message }));
          if (res && res.error) { toast("保存失败：" + res.error); el.checked = !el.checked; return; }
          rule.enable = el.checked;
          row.classList.toggle("off", !el.checked);
          renderTxtTocRules();
          invalidateTocRuleRender();
        };
      } else if (act === "edit") {
        el.onclick = () => editTxtTocRule(rule);
      } else if (act === "menu") {
        el.onclick = (e) => {
          e.stopPropagation();
          const rect = el.getBoundingClientRect();
          popupMenu(rect.left - 118, rect.bottom + 3, [
            [RP_I18N.toTop, () => txtTocOrder([id], "top")],
            [RP_I18N.toBottom, () => txtTocOrder([id], "bottom")],
            [RP_I18N.delete, () => txtTocDelete([id]), true],
          ]);
        };
      }
    });
  });
  renderTxtTocSelBar();
}

/** 同 renderReplaceSelBar：底部只留「全选 / 反选」，计数 = 已启用 / 当前可见 */
function renderTxtTocSelBar() {
  const bar = $("txtTocSelBar");
  if (!bar) return;
  const list = txtTocFiltered();
  const on = list.filter((r) => r.enable === true).length;
  const allOn = list.length > 0 && on >= list.length;
  const allBtn = bar.querySelector('[data-sel="all"]');
  if (allBtn) allBtn.textContent = (allOn ? RP_I18N.cancelAll : RP_I18N.all) + "（" + on + "/" + list.length + "）";
}

/** 批量开关 TXT 目录规则；返回 false 表示请求失败 */
async function txtTocToggleIds(ids, enabled) {
  const res = await api("/api/txt-toc-rules/toggle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, enabled }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) { toast("操作失败：" + res.error); return false; }
  return true;
}

async function txtTocOrder(ids, action) {
  const res = await api("/api/txt-toc-rules/order", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(ids.length === 1 ? { id: ids[0], action } : { ids, action }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("操作失败：" + res.error);
  await reloadTxtTocRules(true);
}

async function txtTocDelete(ids) {
  const one = ids.length === 1 ? txtTocRules.find((x) => String(x.id) === String(ids[0])) : null;
  if (!(await askConfirm("是否确认删除？" + (one ? "\n" + txtTocDisplayName(one) : ""), "删除"))) return;
  const res = await api("/api/txt-toc-rules/delete", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  }).catch((e) => ({ error: e.message }));
  if (res && res.error) return toast("删除失败：" + res.error);
  await reloadTxtTocRules(true);
  toast("已删除");
}

async function editTxtTocRule(rule) {
  const r = rule || {};
  const v = await askFields(r.id == null ? "新增 TXT 目录规则" : "编辑 TXT 目录规则", [
    { key: "name", label: "名称", value: r.name || "", placeholder: "例如：目录(去空白)" },
    { key: "rule", label: "正则（rule）", value: r.rule || "", area: true, rows: 5,
      placeholder: "Pattern.MULTILINE" },
    { key: "replacement", label: "替换 / JS（replacement）", value: r.replacement == null ? "" : String(r.replacement), area: true, rows: 5,
      placeholder: "可留空；支持 result、index、prevTitle、java.putVolume()" },
    { key: "example", label: "示例", value: r.example == null ? "" : String(r.example) },
  ]);
  if (v === null) return false;
  if (!String(v.name || "").trim()) { toast("名称不能为空"); return false; }
  const body = {
    id: r.id,
    name: String(v.name).trim(),
    rule: String(v.rule || ""),
    replacement: String(v.replacement == null ? "" : v.replacement),
    example: String(v.example || ""),
    serialNumber: Number.isFinite(Number(r.serialNumber)) ? Number(r.serialNumber) : undefined,
    enable: r.enable !== false,
    order: Number.isFinite(Number(r.order)) ? Number(r.order) : undefined,
    builtin: r.builtin === true,
    builtinSource: r.builtinSource || "",
  };
  const res = await api("/api/txt-toc-rules/save", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule: body }),
  }).catch((e) => ({ error: e.message }));
  if (!res || res.error || res.ok === false) {
    toast("保存失败：" + String((res && res.error) || "未知错误"));
    return false;
  }
  await reloadTxtTocRules(true);
  return true;
}

async function txtTocPreviewImport({ text, url, from }) {
  toast("正在解析 " + (from || "") + " …");
  const r = await api("/api/txt-toc-rules/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(url ? { url } : { text }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error || !r.ok) return toast("解析失败：" + String((r && r.error) || "格式不对"));
  const list = Array.isArray(r.rules) ? r.rules : [];
  if (!list.length) return toast("格式不对");

  const wrap = document.createElement("div");
  wrap.className = "ask-modal";
  wrap.innerHTML = '<div class="imp-box">'
    + '<div class="imp-head"><span class="imp-title">导入 TXT 目录规则</span><span class="imp-stat hint"></span>'
    + '<button class="icon-btn imp-x" title="关闭">✕</button></div>'
    + '<div class="imp-tools"><button class="mini-btn imp-all">全选</button>'
    + '<button class="mini-btn imp-none">全不选</button>'
    + '<button class="mini-btn imp-new">只选新增</button></div>'
    + '<div class="imp-list"></div>'
    + '<div class="imp-foot"><button class="ghost-btn imp-cancel">取消</button>'
    + '<button class="primary-btn imp-ok">导入</button></div></div>';
  document.body.appendChild(wrap);
  const listEl = wrap.querySelector('.imp-list');
  const boxes = [];
  for (const s of list) {
    const row = document.createElement('label');
    row.className = 'imp-row' + (s.exists ? ' exists' : '');
    row.innerHTML = '<input type="checkbox" checked><span class="imp-name"></span><span class="imp-tags"></span>';
    row.querySelector('.imp-name').textContent = s.name || '未命名规则';
    row.querySelector('.imp-tags').innerHTML = '<span class="imp-tag' + (s.exists ? ' ex' : '') + '">' + esc(s.state || (s.exists ? '已有' : '新增')) + '</span>';
    row.title = String(s.rule || '');
    boxes.push({ s, cb: row.querySelector('input') });
    listEl.appendChild(row);
  }
  wrap.querySelector('.imp-stat').textContent = "新增 " + list.filter((x) => x.state === '新增').length
    + "，更新 " + list.filter((x) => x.state === '更新').length
    + "，已有 " + list.filter((x) => x.state === '已有').length;
  const setChecked = (fn) => { for (const b of boxes) b.cb.checked = fn(b.s); };
  wrap.querySelector('.imp-all').onclick = () => setChecked(() => true);
  wrap.querySelector('.imp-none').onclick = () => setChecked(() => false);
  wrap.querySelector('.imp-new').onclick = () => setChecked((x) => x.state === '新增');
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.imp-x').onclick = close;
  wrap.querySelector('.imp-cancel').onclick = close;
  wrap.querySelector('.imp-ok').onclick = async () => {
    const ids = boxes.filter((b) => b.cb.checked).map((b) => b.s.id);
    if (!ids.length) return toast('没有勾选任何规则');
    close();
    const res = await api('/api/txt-toc-rules/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(url ? { url, ids } : { text, ids }),
    }).catch((e) => ({ error: e.message }));
    if (!res || res.error || res.ok === false) return toast('导入失败：' + String((res && res.error) || '未知错误'));
    toast("导入完成：新增 " + res.added + "，更新 " + res.updated);
    await reloadTxtTocRules(true);
  };
}

/**
 * 替换规则编辑（legado ReplaceEditActivity + activity_replace_edit.xml）。
 * 字段顺序：名称 / 分组 / 替换内容(pattern) / 使用正则(isRegex) / 替换为(replacement) /
 *   作用于标题(scopeTitle) / 作用于正文(scopeContent) / 替换范围(scope) /
 *   排除范围(excludeScope) / 超时毫秒数。
 * 菜单 append：拷贝规则 / 粘贴规则（replace_edit.xml）。
 */
async function editReplaceRule(rule) {
  const r = rule || {};
  const v = await askFields(r.id ? "编辑替换规则" : "新建替换", [
    { key: "name", label: "替换规则名称", value: r.name || "", placeholder: "replace_rule_summary" },
    { key: "group", label: "分组（可留空）", value: r.group || "", placeholder: "group" },
    { key: "pattern", label: "替换规则（pattern）", value: r.pattern || "", area: true, rows: 4,
      placeholder: "replace_rule" },
    { key: "isRegex", label: " ", value: "", check: { label: "使用正则表达式", checked: r.isRegex !== false } },
    { key: "replacement", label: "替换为（留空即删除）", value: r.replacement == null ? "" : String(r.replacement), area: true, rows: 3,
      placeholder: "replace_to" },
    { key: "scopeTitle", label: " ", value: "", check: { label: "作用于标题", checked: r.scopeTitle === true } },
    { key: "scopeContent", label: " ", value: "", check: { label: "作用于正文", checked: r.scopeContent !== false } },
    { key: "scope", label: "替换范围，选填书名或者书源 URL", value: r.scope || "", placeholder: "replace_scope" },
    { key: "excludeScope", label: "排除范围，选填书名或者书源 URL", value: r.excludeScope || "", placeholder: "replace_exclude_scope" },
    { key: "timeoutMillisecond", label: "超时毫秒数", value: String(r.timeoutMillisecond || 3000), type: "number" },
  ], {
    footExtra: [
      { text: RP_I18N.copyRule, run: (h) => {
          const body = { ...h.values(), isEnabled: r.isEnabled !== false };
          delete body.__isRegex; delete body.__scopeTitle; delete body.__scopeContent;
          const t = JSON.stringify({ ...body, isRegex: !!h.values().__isRegex,
            scopeTitle: !!h.values().__scopeTitle, scopeContent: !!h.values().__scopeContent }, null, 2);
          if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast("已复制规则"), () => toast("复制失败"));
        } },
      { text: RP_I18N.pasteRule, run: async (h) => {
          const t = await askPrompt("粘贴规则", "把规则 JSON 粘贴到这里", "");
          if (t === null || !String(t).trim()) return;
          let one;
          try { one = JSON.parse(String(t).trim()); } catch { return toast("格式不对"); }
          if (Array.isArray(one)) one = one[0];
          if (!one || typeof one !== "object") return toast("格式不对");
          const src = one.pattern != null ? one
            : { pattern: one.regex, name: one.replaceSummary, replacement: one.replacement,
                isRegex: one.isRegex, scope: one.useTo, isEnabled: one.enable };
          h.set("name", src.name || "");
          h.set("group", src.group || "");
          h.set("pattern", src.pattern || "");
          h.set("replacement", src.replacement == null ? "" : src.replacement);
          h.set("isRegex", src.isRegex !== false);
          h.set("scopeTitle", src.scopeTitle === true);
          h.set("scopeContent", src.scopeContent !== false);
          h.set("scope", src.scope || "");
          h.set("excludeScope", src.excludeScope || "");
          h.set("timeoutMillisecond", src.timeoutMillisecond || 3000);
          toast("已粘贴规则");
        } },
    ],
  });
  if (v === null) return false;
  const body = {
    id: r.id,
    name: String(v.name || "").trim() || "未命名规则",
    group: String(v.group || ""),
    pattern: String(v.pattern),
    replacement: String(v.replacement == null ? "" : v.replacement),
    isRegex: !!v.__isRegex,
    isEnabled: r.isEnabled !== false,
    scopeTitle: !!v.__scopeTitle,
    scopeContent: !!v.__scopeContent,
    scope: String(v.scope || ""),
    excludeScope: String(v.excludeScope || ""),
    timeoutMillisecond: Number(v.timeoutMillisecond) || 3000,
    order: Number.isFinite(Number(r.order)) ? Number(r.order) : undefined,
  };
  // ReplaceRule.isValid()：pattern 空 / 正则写坏 / 以「|」结尾（转义过的 \| 除外）
  if (!body.pattern) { toast("替换规则为空或者不满足正则表达式要求"); return false; }
  if (body.isRegex) {
    try { new RegExp(body.pattern); }
    catch (e) { toast("替换规则为空或者不满足正则表达式要求：" + e.message); return false; }
    if (/\|$/.test(body.pattern) && !/\\\|$/.test(body.pattern)) {
      toast("替换规则为空或者不满足正则表达式要求（正则不能以「|」结尾）"); return false;
    }
  }
  const res = await api("/api/replace-rules/save", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule: body }),
  }).catch((e) => ({ error: e.message }));
  if (!res || res.error || res.ok === false) {
    toast("保存失败：" + String((res && (res.error || res.error)) || "未知错误"));
    return false;
  }
  await reloadReplaceRules(true);
  return true;
}

$("replaceAdd").onclick = async () => {
  if (await editReplaceRule(null)) toast("已新增替换规则");
};

$("replaceBuiltin").onclick = async () => {
  const r = await api("/api/replace-rules/builtin/reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).catch((e) => ({ error: e.message }));
  if (r && r.error) return toast("恢复内置规则失败：" + r.error);
  await reloadReplaceRules(true);
  toast("已恢复 " + ((r && r.count) || 0) + " 条内置净化规则");
};

$("replaceFilter").oninput = (e) => {
  replaceFilter = e.target.value || "";
  renderReplaceRules();
};

/** 底部栏：全选（= 全部启用 / 全部停用）+ 反选（= 反转可见规则的启用状态） */
$("replaceSelBar").onclick = async (e) => {
  const b = e.target.closest("[data-sel]");
  if (!b) return;
  const list = replaceFiltered();
  if (!list.length) return;
  const act = b.dataset.sel;
  if (act === "all") {
    const allOn = list.every((r) => r.isEnabled !== false);
    if (await replaceToggleIds(list.map((r) => r.id), !allOn)) await reloadReplaceRules(true);
    return;
  }
  if (act === "invert") {
    const off = list.filter((r) => r.isEnabled === false).map((r) => r.id);
    const on = list.filter((r) => r.isEnabled !== false).map((r) => r.id);
    let ok = true;
    if (off.length) ok = await replaceToggleIds(off, true);
    if (ok && on.length) ok = await replaceToggleIds(on, false);
    if (ok) await reloadReplaceRules(true);
  }
};

/**
 * 测试替换 —— 对齐 ReplaceRuleController.testRule：入参 { rule, text }。
 * 编辑页里没有「测试」按钮，测试入口在管理页（拿当前正在读的这一章正文试跑）。
 */
$("txtTocAdd").onclick = async () => {
  if (await editTxtTocRule(null)) toast("已新增 TXT 目录规则");
};

$("txtTocBuiltin").onclick = async () => {
  const r = await api("/api/txt-toc-rules/builtin/reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).catch((e) => ({ error: e.message }));
  if (r && r.error) return toast("导入默认规则失败：" + r.error);
  await reloadTxtTocRules(true);
  toast("已导入 " + ((r && r.count) || 0) + " 条默认目录规则");
};

$("txtTocFilter").oninput = (e) => {
  txtTocFilter = e.target.value || "";
  renderTxtTocRules();
};

$("txtTocImport").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,.txt";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    await txtTocPreviewImport({ text: await file.text(), from: file.name });
  };
  inp.click();
};

$("txtTocImportUrl").onclick = async () => {
  const v = await askPrompt("网络导入 TXT 目录规则", "规则订阅 / 直链地址（http/https）", "");
  if (v === null) return;
  const url = String(v || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) return toast("仅支持 http(s) 地址");
  await txtTocPreviewImport({ url, from: url });
};

/** 底部栏：全选（= 全部启用 / 全部停用）+ 反选（= 反转可见规则的启用状态） */
$("txtTocSelBar").onclick = async (e) => {
  const b = e.target.closest("[data-sel]");
  if (!b) return;
  const list = txtTocFiltered();
  if (!list.length) return;
  const act = b.dataset.sel;
  if (act === "all") {
    const allOn = list.every((r) => r.enable === true);
    if (await txtTocToggleIds(list.map((r) => String(r.id)), !allOn)) await reloadTxtTocRules(true);
    return;
  }
  if (act === "invert") {
    const off = list.filter((r) => r.enable !== true).map((r) => String(r.id));
    const on = list.filter((r) => r.enable === true).map((r) => String(r.id));
    let ok = true;
    if (off.length) ok = await txtTocToggleIds(off, true);
    if (ok && on.length) ok = await txtTocToggleIds(on, false);
    if (ok) await reloadTxtTocRules(true);
  }
};

$("replaceTabs").onclick = (e) => {
  const b = e.target.closest("[data-rtab]");
  if (b) activateReplaceTab(b.dataset.rtab);
};

$("replaceTest").onclick = async () => {
  const v = await askFields("测试替换", [
    { key: "name", label: "替换规则名称（可留空）", value: "" },
    { key: "pattern", label: "替换规则（pattern）", value: "", area: true, rows: 4 },
    { key: "isRegex", label: " ", value: "", check: { label: "使用正则表达式", checked: true } },
    { key: "replacement", label: "替换为（留空即删除）", value: "", area: true, rows: 2 },
  ]);
  if (v === null) return;
  const pattern = String(v.pattern || "");
  if (!pattern) return toast("替换规则为空或者不满足正则表达式要求");
  const cur = ($("content") && $("content").textContent) || "";
  if (!cur.trim()) return toast("先打开一本书，用当前章节正文测试");
  const rule = { name: v.name || "", pattern, replacement: String(v.replacement || ""), isRegex: !!v.__isRegex, timeoutMillisecond: 3000 };
  const r = await api("/api/replace-rules/test", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule, text: cur.slice(0, 4000) }),
  }).catch((e) => ({ error: e.message }));
  if (!r) return toast("测试失败");
  if (r.ok === false) return askText("测试失败", String(r.error || "未知错误"));
  const src = cur.slice(0, 4000);
  const out = String(r.text || "");
  await askText("替换结果（原文 " + src.length + " 字 → 结果 " + out.length + " 字）", out.slice(0, 4000));
};

/* ---------------- 替换规则导入 / 分组管理 ---------------- */

/** 导入预览（legado ImportReplaceRuleDialog + ReplaceRuleImportComparison） */
async function replacePreviewImport({ text, url, from }) {
  toast("正在解析 " + (from || "") + " …");
  const r = await api("/api/replace-rules/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(url ? { url } : { text }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error || !r.ok) return toast("解析失败：" + String((r && r.error) || "格式不对"));
  const list = Array.isArray(r.rules) ? r.rules : [];
  if (!list.length) return toast("格式不对");

  const wrap = document.createElement("div");
  wrap.className = "ask-modal";
  wrap.innerHTML = '<div class="imp-box">'
    + '<div class="imp-head"><span class="imp-title"></span><span class="imp-stat hint"></span>'
    + '<button class="icon-btn imp-x" title="关闭">\u2715</button></div>'
    + '<div class="imp-tools">'
    + '<button class="mini-btn imp-all">全选</button>'
    + '<button class="mini-btn imp-none">全不选</button>'
    + '<button class="mini-btn imp-new">只选新增</button>'
    + '<button class="mini-btn imp-group">自定义源分组</button>'
    + "</div>"
    + '<div class="imp-list"></div>'
    + '<div class="imp-foot"><button class="ghost-btn imp-cancel">取消</button>'
    + '<button class="primary-btn imp-ok">导入选中</button></div></div>';
  document.body.appendChild(wrap);
  wrap.querySelector(".imp-title").textContent = "导入替换规则 · " + (from || "");
  wrap.querySelector(".imp-stat").textContent = `共 ${list.length} 条，新增 ${list.filter((x) => x.state === "新增").length}，更新 ${list.filter((x) => x.state === "更新").length}，已有 ${list.filter((x) => x.state === "已有").length}`;

  const boxes = [];
  const listEl = wrap.querySelector(".imp-list");
  for (const s of list) {
    const row = document.createElement("label");
    row.className = "imp-row";
    row.innerHTML = '<input type="checkbox" checked><span class="imp-name"></span><span class="imp-tags"></span>';
    row.querySelector(".imp-name").textContent = s.group ? `${s.name}(${s.group})` : (s.name || "未命名规则");
    const tags = [];
    if (s.state === "已有") tags.push('<span class="imp-tag ex">已有</span>');
    else if (s.state === "更新") tags.push('<span class="imp-tag">更新</span>');
    else tags.push('<span class="imp-tag">新增</span>');
    if (s.isRegex) tags.push('<span class="imp-tag">正则</span>');
    row.querySelector(".imp-tags").innerHTML = tags.join("");
    row.title = s.pattern;
    boxes.push({ s, cb: row.querySelector("input") });
    listEl.appendChild(row);
  }
  const setChecked = (fn) => { for (const b of boxes) b.cb.checked = fn(b.s); };
  wrap.querySelector(".imp-all").onclick = () => setChecked(() => true);
  wrap.querySelector(".imp-none").onclick = () => setChecked(() => false);
  // legado ReplaceRuleImportComparison：selectStatus = existingRules == null → 默认只勾新增
  wrap.querySelector(".imp-new").onclick = () => setChecked((s) => s.state === "新增");
  setChecked((s) => s.state === "新增" || s.state === "更新");

  let group = "", addGroup = false;
  const gBtn = wrap.querySelector(".imp-group");
  gBtn.onclick = async () => {
    const v = await askFields("自定义源分组", [
      { key: "group", label: "分组名称", value: group },
      { key: "add", label: " ", value: "", check: { label: "加入分组（不勾选=直接替换成分组）", checked: addGroup } },
    ]);
    if (v === null) return;
    group = String(v.group || "").trim();
    addGroup = !!v.__add;
    gBtn.textContent = group ? (addGroup ? "+" : "") + "自定义源分组：" + group : "自定义源分组";
  };

  const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".imp-x").onclick = close;
  wrap.querySelector(".imp-cancel").onclick = close;
  wrap.querySelector(".imp-ok").onclick = async () => {
    const ids = boxes.filter((b) => b.cb.checked).map((b) => b.s.id);
    if (!ids.length) return toast("没有勾选任何规则");
    close();
    const res = await api("/api/replace-rules/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(url ? { url, ids, group, addGroup } : { text, ids, group, addGroup }),
    }).catch((e) => ({ error: e.message }));
    if (!res || res.error) return toast("导入失败：" + String((res && res.error) || "未知错误"));
    toast(`导入完成：新增 ${res.added}，更新 ${res.updated}`);
    await reloadReplaceRules();
  };
}

$("replaceImport").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,.txt";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    await replacePreviewImport({ text: await file.text(), from: file.name });
  };
  inp.click();
};

$("replaceImportUrl").onclick = async () => {
  const v = await askPrompt("网络导入", "替换规则订阅 / 直链地址（http/https）", "");
  if (v === null) return;
  const url = String(v || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) return toast("仅支持 http(s) 地址");
  await replacePreviewImport({ url, from: url });
};



/* ============================================================
 *  导入书源 / 导出
 * ============================================================ */

$("srcImport").onclick = () => $("srcFile").click();
$("srcFile").onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const text = await file.text();
  await previewImport({ text, from: file.name });
};
$("srcPaste").onclick = async () => {
  // 原生 prompt 无法粘贴多行大文本（换行会被截断），改成站内多行输入框。
  const v = await askFields("粘贴书源 JSON", [
    { key: "text", label: "书源 JSON（支持数组 / {bookSources:[]} / 单个书源对象）", area: true, rows: 12,
      placeholder: '{"bookSourceName":"...","bookSourceUrl":"..."}' },
  ]);
  if (v === null) return;
  const text = String(v.text || "").trim();
  if (!text) return toast("没有粘贴内容");
  await previewImport({ text, from: "剪贴板" });
};

/**
 * 需求：导入书源时**不直接导入**，先弹窗列出集合里的书源交给用户勾选。
 * 默认全选；源库里已有的在条目右侧标「已存在」（仍可勾，勾了就是覆盖更新）。
 * 对应 legado「导入书源」的导入清单页（BookSourceImportDialog）。
 */
async function previewImport({ text, url, from }) {
  toast("正在解析 " + (from || "") + " …");
  const r = await api("/api/sources/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(url ? { url } : { text }),
  }).catch((e) => ({ error: e.message }));
  if (!r || r.error || !r.ok) { toast("解析失败：" + String((r && r.error) || "未知错误")); return; }
  const list = Array.isArray(r.sources) ? r.sources : [];
  if (!list.length) { toast("这个集合里没有可用书源"); return; }

  const wrap = document.createElement("div");
  wrap.className = "ask-modal";
  wrap.innerHTML = '<div class="imp-box">'
    + '<div class="imp-head"><span class="imp-title"></span>'
    + '<span class="imp-stat hint"></span>'
    + '<button class="icon-btn imp-x" title="关闭">\u2715</button></div>'
    + '<div class="imp-tools">'
    + '<button class="mini-btn imp-all">全选</button>'
    + '<button class="mini-btn imp-none">全不选</button>'
    + '<button class="mini-btn imp-new">只选新书源</button>'
    + '</div>'
    + '<div class="imp-list"></div>'
    + '<div class="imp-foot"><button class="ghost-btn imp-cancel">取消</button>'
    + '<button class="primary-btn imp-ok">导入选中</button></div></div>';
  document.body.appendChild(wrap);
  wrap.querySelector(".imp-title").textContent = "导入书源 · " + (from || "");
  wrap.querySelector(".imp-stat").textContent = `共 ${list.length} 个，其中 ${list.filter((x) => x.exists).length} 个已存在`;

  const boxes = [];
  const listEl = wrap.querySelector(".imp-list");
  for (const s of list) {
    const row = document.createElement("label");
    row.className = "imp-row" + (s.exists ? " exists" : "");
    row.innerHTML = '<input type="checkbox" checked>'
      + '<span class="imp-name"></span>'
      + '<span class="imp-tags"></span>';
    row.querySelector(".imp-name").textContent = s.name || s.key;
    const tags = [];
    if (s.exists) tags.push('<span class="imp-tag ex">已存在</span>');
    if (s.hasLogin) tags.push('<span class="imp-tag">登录</span>');
    if (s.hasSearch) tags.push('<span class="imp-tag">搜索</span>');
    if (s.hasExplore) tags.push('<span class="imp-tag">发现</span>');
    row.querySelector(".imp-tags").innerHTML = tags.join("");
    row.title = s.key;
    const cb = row.querySelector("input");
    boxes.push({ s, cb });
    listEl.appendChild(row);
  }
  const setChecked = (fn) => { for (const b of boxes) b.cb.checked = fn(b.s); };
  wrap.querySelector(".imp-all").onclick = () => setChecked(() => true);
  wrap.querySelector(".imp-none").onclick = () => setChecked(() => false);
  wrap.querySelector(".imp-new").onclick = () => setChecked((s) => !s.exists);

  const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".imp-x").onclick = close;
  wrap.querySelector(".imp-cancel").onclick = close;
  wrap.querySelector(".imp-ok").onclick = async () => {
    const keys = boxes.filter((b) => b.cb.checked).map((b) => b.s.key);
    if (!keys.length) { toast("没有勾选任何书源"); return; }
    close();
    toast("正在导入 …");
    const res = await api(url ? "/api/sources/import-url" : "/api/sources/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(url ? { url, keys } : { text, keys }),
    }).catch((e) => ({ error: e.message }));
    if (!res || res.error) { toast("导入失败：" + String((res && res.error) || "未知错误")); return; }
    toast(`导入完成：新增 ${res.added}，更新 ${res.updated}` + (res.skipped ? `，跳过 ${res.skipped}` : ""));
    await loadSources();
    renderSourceList();
    renderSourcePicker();
  };
}

$("srcExport").onclick = () => { window.location.href = "/api/sources/export"; };

$("sourceFilter").oninput = (e) => { srcFilter = e.target.value; renderSourceList(); };

/** 需求：书源管理界面全选 / 反选（作用于当前筛选出的列表） */
$("srcSelAll").onclick = async () => {
  const list = srcVisibleList();
  if (!list.length) return toast("列表里没有书源");
  const off = list.filter((s) => !s.enabled).map((s) => s.url);
  if (!off.length) return toast("当前 " + list.length + " 个书源都已启用");
  const n = await setSourcesEnabled(off, true);
  if (n) toast("已启用 " + n + " 个书源（当前列表 " + list.length + " 个）");
};

$("srcSelInvert").onclick = async () => {
  const list = srcVisibleList();
  if (!list.length) return toast("列表里没有书源");
  const on = list.filter((s) => !s.enabled).map((s) => s.url);
  const off = list.filter((s) => s.enabled).map((s) => s.url);
  if (on.length) await setSourcesEnabled(on, true);
  if (off.length) await setSourcesEnabled(off, false);
  toast("已反选 " + list.length + " 个书源 → 启用 " + on.length + "、禁用 " + off.length);
};

$("sourceGroupSelect").onchange = (e) => switchSourceGroup(e.target.value);
$("srcGroupCreate").onclick = createSourceGroup;
$("srcGroupRename").onclick = renameSourceGroup;
$("srcGroupDelete").onclick = deleteSourceGroup;

/* ============================================================
 *  书源打包 / 迁移（legado 风格：整包导入导出）
 * ============================================================ */

$("srcImportUrl").onclick = async () => {
  const v = await askPrompt("从网址导入书源", "书源订阅 / 直链地址（http/https）", "");
  if (v === null) return;
  const url = String(v || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) return toast("仅支持 http(s) 地址");
  await previewImport({ url, from: url });
};

/* ============================================================
 *  面板开关
 * ============================================================ */

const PANELS = ["panelSearch", "panelSources", "panelExplore", "panelReplace", "debugBox", "panelBookInfo", "panelChangeSource", "panelExploreResult", "storageModal"];
function closePanels() { for (const id of PANELS) $(id)?.classList.add("hidden"); }

/* 发现结果页返回键 = ExploreShowActivity 的 TitleBar 返回 → 回分类面板 */
$("expBack").onclick = () => {
  $("panelExploreResult").classList.add("hidden");
  $("panelExplore").classList.remove("hidden");
};

$("btnSearch").onclick = openSearch;
$("bookChangeAll").onclick = openChangeAllSource;
$("bookManage").onclick = openShelfManage;
$("btnSources").onclick = openSources;
$("btnExplore").onclick = openExplore;
$("btnReplace").onclick = openReplace;
$("btnPool").onclick = async () => {
  const r = await api("/api/online/pool").catch(() => null);
  if (!r) return toast("读取抓取池状态失败");
  await askText("抓取池状态", [
    "worker 数：" + r.size,
    "网络槽位：" + r.netSlots,
    "正在忙：" + r.busy,
    "启用书源：" + r.sources,
  ].join("\n"), { copy: false });
};
/* 需求 C3：换源 / 刷新挪到顶栏右侧（原来换源只藏在右键菜单和搜索结果行里，找不到） */
$("btnRefresh").onclick = () => refreshCurrentChapter();
$("btnChangeSource").onclick = () => {
  const meta = getCurrentBookMeta();
  if (meta) {
    // 用当前生效的在线书条目（带 originName / coverUrl），而不是 state.book 的精简快照
    const cur = findOnlineByRel(state.book.rel) || state.book;
    openChangeSource(cur);
  } else {
    toast("先打开一本书再换源");
  }
};
/* ============================================================
 *  缓存与数据位置（legado 设置页「缓存管理」的桌面形态）
 *  路径由后端统一给出，默认固定为 Reader/cache，前端不允许传任意目录。
 * ============================================================ */
function storageBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

async function refreshStoragePanel() {
  const summary = $("storageSummary"), list = $("storageList");
  if (!summary || !list) return;
  summary.textContent = "读取中…";
  list.innerHTML = '<div class="hint">正在统计缓存占用…</div>';
  let info;
  try { info = await api("/api/online/storage"); }
  catch (e) {
    summary.textContent = "读取失败：" + (e.message || e);
    list.innerHTML = "";
    return;
  }
  const total = Number(info.totalBytes) || 0;
  const dirInput = $("storageDir");
  if (dirInput) dirInput.value = info.root || "";
  const dirHint = $("storageDirHint");
  if (dirHint) {
    dirHint.textContent = info.envLocked
      ? "当前目录由 READER_CACHE_DIR 环境变量指定，界面不能修改。"
      : "修改后需重启 Reader 生效；旧目录中的缓存不会自动搬移。";
  }
  summary.textContent = "共 " + storageBytes(total) + " · " + (Number(info.totalFiles) || 0).toLocaleString("zh-CN") + " 个文件";
  list.innerHTML = (info.items || []).map((item) => {
    const bytes = Number(item.bytes) || 0;
    const pct = total > 0 ? Math.max(1, Math.round(bytes / total * 100)) : 0;
    const keep = item.keep ? '<span class="cache-row-keep">保留</span>' : "";
    return '<div class="cache-row">'
      + '<div class="cache-row-top"><span class="cache-row-name">' + esc(item.label || item.key) + '</span>'
      + keep + '<span class="cache-row-size">' + storageBytes(bytes) + '</span></div>'
      + '<div class="cache-bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="cache-row-path" title="' + esc(item.path || "") + '">' + esc(item.path || "") + '</div>'
      + '</div>';
  }).join("");

  // WebView 明细：可再生缓存（可清）与登录数据（保留）分开列出，
  // 让用户看清「清理 WebView 缓存」到底会动哪些、不会动哪些。
  const wv = info.webview;
  const wvBox = $("storageWebviewDetail");
  const wvBtn = $("storageWebviewClear");
  if (wvBox) {
    if (!wv) {
      wvBox.innerHTML = "";
    } else {
      const clearable = (wv.clearable || []).slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
      const kept = (wv.keep || []).filter((x) => (x.bytes || 0) > 0).sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
      wvBox.innerHTML = ''
        + '<div class="cache-subhead"><span>登录 WebView 数据</span>'
        + '<span class="hint">可清理 ' + storageBytes(wv.totalBytes) + ' · 登录数据 ' + storageBytes(wv.keepBytes) + '</span></div>'
        + '<div class="cache-wv-tags">'
        + (clearable.length
          ? clearable.map((x) => '<span class="cache-wv-tag clear" title="' + esc(x.path || "") + '">'
              + esc(x.label || x.key) + ' · ' + storageBytes(x.bytes) + '</span>').join("")
          : '<span class="hint">暂无可清理的 WebView 缓存</span>')
        + '</div>'
        + (kept.length
          ? '<div class="cache-wv-keep"><span class="hint">保留登录数据：</span>'
            + kept.map((x) => '<span class="cache-wv-tag keep" title="' + esc(x.path || "") + '">'
              + esc(x.label) + ' · ' + storageBytes(x.bytes) + '</span>').join("")
            + '</div>'
          : "");
    }
  }
  if (wvBtn) wvBtn.disabled = !wv || !(Number(wv.totalBytes) > 0);
}

function openStoragePanel() {
  $("storageModal").classList.remove("hidden");
  refreshStoragePanel();
}

$("storageClose").onclick = () => $("storageModal").classList.add("hidden");
$("storageModal").onclick = (e) => { if (e.target === $("storageModal")) $("storageModal").classList.add("hidden"); };
$("storageRefresh").onclick = () => refreshStoragePanel();
$("storageOpen").onclick = async () => {
  const r = await api("/api/online/storage/open", { method: "POST" }).catch((e) => ({ error: e.message }));
  if (r && r.error) toast("打开缓存文件夹失败：" + r.error);
  else toast("已打开缓存文件夹");
};
async function saveStorageDir(dir) {
  const r = await api("/api/online/storage/dir", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir }),
  }).catch((e) => ({ error: e.message }));
  if (r && r.error) { toast("设置失败：" + r.error); return null; }
  return r;
}
$("storageDirSave").onclick = async () => {
  const dir = ($("storageDir").value || "").trim();
  if (!dir) return toast("请输入绝对路径，或点「恢复默认」");
  if (!/^[A-Za-z]:[\\/]/.test(dir) && !dir.startsWith("\\\\")) return toast("请输入绝对路径，例如 D:\\ReaderCache");
  if (!(await askConfirm("缓存目录改为：\n" + dir + "\n\n需要重启 Reader 后生效，是否继续？", "保存"))) return;
  const r = await saveStorageDir(dir);
  if (!r) return;
  toast("缓存目录已保存，重启 Reader 后生效");
  refreshStoragePanel();
};
$("storageDirDefault").onclick = async () => {
  const info = await api("/api/online/storage").catch(() => null);
  if (info && info.envLocked) return toast("当前目录由环境变量指定，不能改为默认目录");
  if (!(await askConfirm("恢复默认缓存目录？\n" + ((info && info.defaultDir) || "Reader/cache") + "\n\n需要重启 Reader 后生效。", "恢复"))) return;
  const r = await saveStorageDir("");
  if (!r) return;
  toast("已恢复默认缓存目录，重启 Reader 后生效");
  refreshStoragePanel();
};
$("storageClear").onclick = async () => {
  if (!(await askConfirm("清理正文 / 目录 / 发现分类缓存？\n登录信息与书架不会删除。", "清理"))) return;
  const r = await api("/api/online/cache/clear", { method: "POST" }).catch((e) => ({ error: e.message }));
  if (r && r.error) return toast("清理失败：" + r.error);
  chapterCache.clear();
  onlineTocCache.clear();
  toast("缓存已清理"
    + (r && r.freedBytes ? "，释放 " + storageBytes(r.freedBytes) : "")
    + (r && r.warming ? "，正在后台预热书架" : ""));
  refreshStoragePanel();
};
$("storageWebviewClear").onclick = async () => {
  if (!(await askConfirm(
    "清理 WebView 可再生缓存？\n\n"
    + "会清理：HTTP 缓存、代码缓存、GPU 着色器缓存、Edge 组件 / 模型缓存。\n"
    + "不会清理：Cookies、Local Storage、IndexedDB、Service Worker 注册信息 —— 登录态保留，无需重新登录。\n\n"
    + "清理前会自动关闭内置浏览器窗口，清理后下次打开登录页会稍慢一点。",
    "清理"
  ))) return;
  const btn = $("storageWebviewClear");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "清理中…";
  const r = await api("/api/online/webview/cache/clear", { method: "POST" })
    .catch((e) => ({ error: e.message }));
  btn.textContent = old;
  if (r && r.error) { toast("清理失败：" + r.error); refreshStoragePanel(); return; }
  const failN = (r && r.failed && r.failed.length) || 0;
  toast("WebView 缓存已清理"
    + (r && r.freedBytes ? "，释放 " + storageBytes(r.freedBytes) : "")
    + (failN ? "，有 " + failN + " 项被占用未删除" : ""));
  refreshStoragePanel();
};
$("btnClearCache").onclick = openStoragePanel;

document.querySelectorAll("[data-close]").forEach((el) => {
  el.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePanel(el.dataset.close);
  };
});
document.querySelectorAll(".panel").forEach((p) => {
  p.onclick = (e) => { if (e.target === p) closePanel(p.id); };
});
document.querySelectorAll(".mode-switch button").forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode);
});

/* 搜索框回车（关键词 / 作者都触发） */
$("searchKey").onkeydown = (e) => { if (e.key === "Enter") doSearch(1); };
$("searchAuthor").onkeydown = (e) => { if (e.key === "Enter") doSearch(1); };
$("searchGo").onclick = () => doSearch(1);
$("searchStop").onclick = () => { if (searchAbort) { try { searchAbort.abort(); } catch {} } };
$("searchPrecise").onchange = () => { if ($("searchKey").value.trim()) doSearch(1); };
$("exploreSource").onchange = loadExploreKinds;
const expRefreshBtn = $("exploreRefresh");
if (expRefreshBtn) expRefreshBtn.onclick = refreshExploreKinds;

/* ============================================================
 *  启动：先按存储的模式进入
 * ============================================================ */

(async function initOnline() {
  state.online.searchPick = null;
  let mode = "local";
  try { mode = localStorage.getItem(MODE_KEY) || "local"; } catch {}
  // 先同步落一次 mode，避免首屏把在线按钮闪出来
  setMode(mode, { silent: true });
  document.body.dataset.mode = state.mode;
  await refreshOnlineShelf();
  if (mode === "online") {
    setMode("online", { silent: true });
    await enterMode();
    const lastRel = (() => { try { return localStorage.getItem("lastOnlineRel"); } catch { return null; } })();
    const b = lastRel ? state.books.find((x) => x.rel === lastRel) : null;
    if (b) {
      // 刷新（F5）后 enterMode() 把分页打回了第 1 页；如果只恢复正文不校分页，
      // 就会出现「正文还是那本书、左侧书架却停在第 1 页」——用户明确要求两者必须匹配。
      // 先按当前数据校一次（立刻到位，不用等目录抓完），openBook 之后再校一次
      // （那会儿 bookPerPage 可能已按新窗口高度重算）。
      syncShelfPageToBook(b);
      openBook(b).then(() => syncShelfPageToBook(findOnlineByRel(lastRel) || b)).catch(() => {});
    }
  } else {
    setMode("local", { silent: true });
  }
})();

/* ============================================================
 *  版本哨兵：长期开着的标签页会一直跑旧的 JS/CSS。
 *  定期（以及标签页重新可见时）比对服务端 /api/build 指纹，
 *  发现 public/* 有新版本就自动重载，避免「改了没生效」。
 * ============================================================ */
(function watchBuild() {
  let cur = null;
  let reloading = false;
  const poke = async () => {
    if (reloading) return;
    try {
      const r = await fetch("/api/build", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const t = String((j && j.token) || "");
      if (!t) return;
      if (cur === null) { cur = t; return; }
      if (t !== cur) { reloading = true; location.reload(); }
    } catch { /* 服务重启中，下一轮再试 */ }
  };
  poke();
  setInterval(poke, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poke(); });
})();

/* 供样式钩子用 *//* 供样式钩子用 */
document.documentElement.classList.add("reader-online-ready");
