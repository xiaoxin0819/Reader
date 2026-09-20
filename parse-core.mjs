/* parse-core.mjs —— txt 解析核心：编码识别 + 章节切分 + 标题规范化 */
const GBK = new TextDecoder("gb18030");

export function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8-bom" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buf.subarray(2)), encoding: "utf-16le" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buf.subarray(2)), encoding: "utf-16be" };
  }
  const n = Math.min(buf.length, 1 << 21);
  const head = buf.subarray(0, n);
  const strict = head.subarray(0, Math.max(0, head.length - 3));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(strict);
    return { text: buf.toString("utf8"), encoding: "utf-8" };
  } catch {}
  const badOf = (t) => (t.match(/\uFFFD/g) || []).length;
  const bu = badOf(head.toString("utf8"));
  const bg = badOf(GBK.decode(head));
  if (bu <= bg) return { text: buf.toString("utf8"), encoding: "utf-8" };
  return { text: GBK.decode(buf), encoding: "gb18030" };
}

/* ---------------- 中文数字 ---------------- */

const CN_DIGIT = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9
};
const CN_RUN = "[0-9零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖]";
const UNIT = "章节回话集篇部";

export function cn2num(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (ch === "万") { section = (section + num) * 10000; total += section; section = 0; num = 0; continue; }
    if (ch === "千") { section += (num || 1) * 1000; num = 0; continue; }
    if (ch === "百") { section += (num || 1) * 100; num = 0; continue; }
    if (ch === "十") { section += (num || 1) * 10; num = 0; continue; }
    const d = CN_DIGIT[ch];
    if (d === undefined) return null;
    num = d;
  }
  return total + section + num;
}

/* ---------------- 标题识别 ---------------- */

const STRONG_RE = new RegExp(
  "^[\\s\u3000]*(?:正文[\\s\u3000]*)?[【\\[]?(" +
    "第\\s*" + CN_RUN + "{1,12}\\s*章(?:节)?" +
    "|第\\s*" + CN_RUN + "{1,12}\\s*[" + UNIT + "](?=[\\s\u3000【\\[（(《<:：·・\\-—.、]|$)" +
    "|[Cc]hapter\\s*\\d+|Turn\\s*\\d+" +
    "|序[章言]|楔子|引子|前言|后记|尾声|终章|大结局" +
    "|番外[\\s\\S]{0,20}|外传[\\s\\S]{0,20}" +
    "|卷[0-9零一二两三四五六七八九十百千万]{1,6}[\\s\u3000]*[\\s\\S]{0,30}" +
  ")"
);

// 编号 + 分隔符 + 标题：1：xx / 001 xx / 0001章 xx / 四、xx / 【000】xx
const DIGIT_RE = /^(\d{1,5})\s*([章节回话集篇部]|[：:。.．、,，\-—]|\s)\s*(\S[\s\S]{0,38})?$/;
const BRACKET_RE = /^[【\[]\s*(\d{1,5})\s*[】\]]\s*(\S[\s\S]{0,38})?$/;
const CNHEAD_RE = new RegExp("^(" + CN_RUN + "{1,7})[\\s\u3000]*([、.．:：]|[\\s\u3000])\\s*(\\S[\\s\\S]{1,38})$");

function blankAround(lines, i) {
  const prevBlank = i <= 0 || !lines[i - 1].trim();
  const nextBlank = i >= lines.length - 1 || !lines[i + 1].trim();
  return prevBlank && nextBlank;
}

export function detectTitle(lines, i) {
  const s = String(lines[i] || "").trim();
  if (!s || s.length > 60) return null;

  // 1) 强模式：语义明确，不依赖上下文
  //    含句号且偏长的视为正文（如「第51章也写了：他只能估算护林员的行程。」）
  if (!(s.includes("。") && s.length > 12) && STRONG_RE.test(s)) return { title: s };

  // 2) 弱模式：编号 + 标题，要求前后空行
  if (s.length <= 44) {
    if (!blankAround(lines, i)) return null;
    const b = s.match(BRACKET_RE);
    if (b) return { title: s, weak: true, num: Number(b[1]) };
    const m = s.match(DIGIT_RE);
    if (m) {
      const sep = m[2], rest = (m[3] || "").trim();
      const pureSep = !new RegExp("^[" + UNIT + "]$").test(sep);
      const ok = (pureSep && rest.length >= 1) || (!pureSep && rest.length >= 2);
      if (ok) return { title: s, weak: true, num: Number(m[1]) };
    }
    const c = s.match(CNHEAD_RE);
    if (c) {
      const n = cn2num(c[1]), rest = c[3].trim();
      if (n !== null && rest.length >= 2 && !/[。，、：:]$/.test(rest)) return { title: s, weak: true, num: n };
    }
  }
  return null;
}

/* ---------------- 标题拆解 / 规范化 ---------------- */

// 本身不带编号的标题：保持原样，不强行编号
const SPECIAL_RE = /^(?:序[章言]|楔子|引子|前言|后记|尾声|终章|大结局|上架感言|完本感言|作者的话|第[0-9零一二两三四五六七八九十百千万]{1,6}卷|卷[0-9零一二两三四五六七八九十百千万]|番外|外传)/;

function trimSep(x) {
  return String(x || "").replace(/^[\s\u3000]+/, "").replace(/^[】\]）)。.．、,，:：\-—~～·・]+/, "")
    .replace(/[\s\u3000]+$/, "").replace(/[,，、:：\-—]+$/, "").trim();
}

/** 把一行标题拆成 { num, name }；num 为 null 表示没有可识别编号 */
export function splitTitle(raw) {
  const s = String(raw || "").trim();

  let m = s.match(/^[【\[]\s*(\d{1,5})\s*[】\]]\s*([\s\S]*)$/);
  if (m) return { num: Number(m[1]), name: trimSep(m[2]) };

  m = s.match(new RegExp("^第\\s*(" + CN_RUN + "{1,12})\\s*[" + UNIT + "][\\s\u3000:：。.．、,，\\-—·・]*([\\s\\S]*)$"));
  if (m) {
    const n = cn2num(m[1]);
    if (n !== null) return { num: n, name: trimSep(m[2]) };
  }
  m = s.match(/^[Cc]hapter\s*(\d+)[\s:：.。\-—]*([\s\S]*)$/);
  if (m) return { num: Number(m[1]), name: trimSep(m[2]) };
  m = s.match(/^Turn\s*(\d+)[\s:：.。\-—]*([\s\S]*)$/i);
  if (m) return { num: Number(m[1]), name: trimSep(m[2]) };
  m = s.match(/^(\d{1,5})\s*(?:[" + UNIT + "]\\s*)?[：:。.．、,，\-—\s]\s*([\s\S]*)$/);
  if (m) return { num: Number(m[1]), name: trimSep(m[2]) };
  m = s.match(new RegExp("^(" + CN_RUN + "{1,7})[\\s\u3000]*[、.．:：][\\s\u3000]*([\\s\\S]*)$"));
  if (m) {
    const n = cn2num(m[1]);
    if (n !== null) return { num: n, name: trimSep(m[2]) };
  }
  m = s.match(new RegExp("^(" + CN_RUN + "{1,7})[\\s\u3000]+([\\s\\S]{2,})$"));
  if (m) {
    const n = cn2num(m[1]);
    if (n !== null) return { num: n, name: trimSep(m[2]) };
  }
  if (SPECIAL_RE.test(s)) return { num: null, name: s, special: true };
  return { num: null, name: s };
}

/** 把整本的章节标题统一成「第 N 章 名称」 */
export function normalizeTitles(rawTitles) {
  const parts = rawTitles.map((t) => splitTitle(t));
  const numbered = parts.filter((p) => p.num !== null).length;
  // 原编号可用：多数标题带编号，且严格递增（分卷重编号的书会被判为不可用，改为顺序编号）
  let useOrig = numbered >= parts.length * 0.6;
  for (let i = 1; i < parts.length && useOrig; i++) {
    const a = parts[i - 1].num, b = parts[i].num;
    if (a === null || b === null) continue;
    if (b <= a) useOrig = false;
  }

  let seq = 0;
  return parts.map((p, i) => {
    if (p.num === null) return { label: p.name, num: null, name: p.name };
    // 开头的「序章 / 楔子 / 前言」这类不带编号的卷首标题：保持原样
    if (i < 3 && SPECIAL_RE.test(p.name)) return { label: p.name, num: null, name: p.name };
    const num = useOrig ? p.num : ++seq;
    return { label: p.name ? `第${num}章 ${p.name}` : `第${num}章`, num, name: p.name };
  });
}

/* ---------------- 文件头元信息 ---------------- */

export function findBodyStart(lines) {
  let t = null, a = null, consumed = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const s = lines[i].trim();
    if (/^书名[:：]/.test(s)) { t = s.replace(/^书名[:：]\s*/, "").trim(); consumed = i + 1; continue; }
    if (/^作者[:：]/.test(s)) { a = s.replace(/^作者[:：]\s*/, "").trim(); consumed = i + 1; continue; }
    if (/^简介[:：]/.test(s)) { consumed = i + 1; break; }
  }
  return { bodyStart: consumed, title: t, author: a };
}

/* ---------------- 兜底切分（完全无标题时按字数切） ---------------- */

function fallbackChapters(lines, bodyStart) {
  const out = [];
  const TARGET = 2500;
  let i = bodyStart, n = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const start = i;
    let len = 0;
    while (i < lines.length && len < TARGET) { len += lines[i].length; i++; }
    out.push({ title: `第${++n}节`, start, end: i, noHead: true });
  }
  return out;
}

export function analyzeText(text, fallbackTitle = "") {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const head = findBodyStart(lines);
  const title = head.title || fallbackTitle;
  const author = head.author || "";
  const bodyStart = head.bodyStart;

  const chapters = [];
  let preEnd = -1;
  let lastWeakNum = -Infinity;

  for (let i = bodyStart; i < lines.length; i++) {
    const hit = detectTitle(lines, i);
    if (!hit) continue;
    if (hit.weak && hit.num !== null) {
      if (hit.num < lastWeakNum) continue;   // 弱标题必须递增，否则多半是正文误判
      lastWeakNum = hit.num;
    }
    if (chapters.length === 0) preEnd = i;
    chapters.push({ title: hit.title, start: i });
  }

  let fellBack = false;
  if (chapters.length === 0) {
    const fb = fallbackChapters(lines, bodyStart);
    if (fb.length) { chapters.push(...fb); fellBack = true; preEnd = -1; }
  }
  for (let i = 0; i < chapters.length; i++) {
    chapters[i].end = i + 1 < chapters.length ? chapters[i + 1].start : lines.length;
  }

  const norms = normalizeTitles(chapters.map((c) => c.title));
  chapters.forEach((c, i) => { c.label = norms[i].label; c.num = norms[i].num; c.name = norms[i].name; });

  const pre = !fellBack && preEnd > bodyStart ? { title: "简介", start: bodyStart, end: preEnd } : null;
  return { lines, chapters, pre, title, author, fellBack };
}
