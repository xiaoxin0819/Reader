// legado-text.mjs —— 照 legado 源码逐行移植的文本 / 章节工具
//
// 为什么单独一个模块：换源时要把「旧书的阅读进度」映射到「新书的目录」上，
// legado 的算法在 BookHelp.getDurChapter（app/src/main/java/io/legado/app/help/book/BookHelp.kt:504-551），
// 它依赖 StringUtils.fullToHalf / stringToInt / chineseNumToInt
//（app/src/main/java/io/legado/app/utils/StringUtils.kt:134-219）
// 以及 Apache commons-text 1.13.1 的 JaccardSimilarity。
// 这里逐行对照 Kotlin 移植，不自己造算法 —— 否则换源后停的章节会和 legado 对不上。

/* ---------------- StringUtils.fullToHalf（StringUtils.kt:134-148） ---------------- */

/** 全角转半角：全角空格 12288 转 32；65281..65374 区段整体减 65248 */
export function fullToHalf(input) {
  const out = String(input == null ? "" : input).split("");
  for (let i = 0; i < out.length; i++) {
    const code = out[i].charCodeAt(0);
    if (code === 12288) { out[i] = String.fromCharCode(32); continue; }
    if (code >= 65281 && code <= 65374) out[i] = String.fromCharCode(code - 65248);
  }
  return out.join("");
}

/* ---------------- StringUtils.chnMap（StringUtils.kt:30-51） ---------------- */

/** 中文数字字符到数值。照 Kotlin chnMap getter 的赋值逐条搬过来 */
const CHN_MAP = (() => {
  const map = new Map();
  let s = "零一二三四五六七八九十";
  for (let i = 0; i <= 10; i++) map.set(s[i], i);
  s = "〇壹贰叁肆伍陆柒捌玖拾";
  for (let i = 0; i <= 10; i++) map.set(s[i], i);
  map.set("两", 2);
  map.set("百", 100);
  map.set("佰", 100);
  map.set("千", 1000);
  map.set("仟", 1000);
  map.set("万", 10000);
  map.set("亿", 100000000);
  return map;
})();

/* ---------------- StringUtils.chineseNumToInt（StringUtils.kt:153-204） ---------------- */

const SINGLE_DIGIT_RE = /^[〇零一二三四五六七八九壹贰叁肆伍陆柒捌玖]$/;

/** 中文数字转 int。出现 chnMap 里没有的字符，等价于 Kotlin 的 !! 抛异常，返回 -1 */
export function chineseNumToInt(chNum) {
  const str = String(chNum == null ? "" : chNum);
  const cn = str.split("");
  let result = 0, tmp = 0, billion = 0;
  try {
    // "一零二五" 形式。Kotlin 要求「长度大于 1」与「整串匹配单字符类」同时成立，
    // 该条件实际恒为假（死分支），照抄以保持行为一致。
    if (cn.length > 1 && SINGLE_DIGIT_RE.test(str)) {
      const digits = cn.map((c) => {
        const v = CHN_MAP.get(c);
        if (v === undefined) throw new Error("not a chn num");
        return String.fromCharCode(48 + v);
      });
      return parseInt(digits.join(""), 10);
    }
    for (let i = 0; i < cn.length; i++) {
      const tmpNum = CHN_MAP.get(cn[i]);
      if (tmpNum === undefined) throw new Error("not a chn num");
      if (tmpNum === 100000000) {
        result += tmp; result *= tmpNum;
        billion = billion * 100000000 + result;
        result = 0; tmp = 0;
      } else if (tmpNum === 10000) {
        result += tmp; result *= tmpNum; tmp = 0;
      } else if (tmpNum >= 10) {
        if (tmp === 0) tmp = 1;
        result += tmpNum * tmp; tmp = 0;
      } else {
        const prev = CHN_MAP.get(cn[i - 1]);
        tmp = (i >= 2 && i === cn.length - 1 && prev !== undefined && prev > 10)
          ? tmpNum * prev / 10
          : tmp * 10 + tmpNum;
      }
    }
    return result + tmp + billion;
  } catch (e) { return -1; }
}

/* ---------------- StringUtils.stringToInt（StringUtils.kt:209-219） ---------------- */

/** 字符串转数字：先去空白并全角转半角，parseInt 吃得下就用它，否则走中文数字 */
export function stringToInt(str) {
  if (str === null || str === undefined) return -1;
  const num = fullToHalf(String(str)).replace(/\s+/g, "");
  if (/^[+-]?\d+$/.test(num)) return parseInt(num, 10);
  return chineseNumToInt(num);
}

/* ---------------- BookHelp.getChapterNum（BookHelp.kt:562-589） ---------------- */

const CN = "[\\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+";
const chapterNamePattern1 = new RegExp(".*?第(" + CN + ")[章节篇回集话]");
const chapterNamePattern2 = new RegExp("^(?:[\\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+[,:、])*(" + CN + ")(?:[,:、]|\\.[^\\d])");
const regexA = /\s/g;

/** 从章节名里抽章节序号；抽不到返回 -1 */
export function getChapterNum(chapterName) {
  if (chapterName === null || chapterName === undefined) return -1;
  const name = fullToHalf(String(chapterName)).replace(regexA, "");
  const m = chapterNamePattern1.exec(name) || chapterNamePattern2.exec(name);
  return stringToInt(m ? m[1] : "-1");
}

/* ---------------- BookHelp.getPureChapterName（BookHelp.kt:591-614） ---------------- */

// 所有非字母数字中日韩文字：CJK 区加扩展 A-F 区。
// Kotlin 写 "\u20000"，JS 需要 u 标志下的 "\u{20000}"。
const regexOther = /[^\w\u4E00-\u9FEF〇\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2EBEF}]/gu;
// 章节序号，排除处于结尾的状况，避免将章节名替换为空字串
const regexB = new RegExp("^.*?第(?:[\\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+)[章节篇回集话](?!$)|^(?:[\\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+[,:、])*(?:[\\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+)(?:[,:、](?!$)|\\.(?=[^\\d]))", "g");
// 前后附加内容，整个章节名都在括号中时只剔除首尾括号，避免将章节名替换为空字串
const regexC = new RegExp("(?!^)(?:[〖【《〔\\[{(][^〖【《〔\\[{()〕》】〗\\]}]+)?[)〕》】〗\\]}]$|^[〖【《〔\\[{(](?:[^〖【《〔\\[{()〕》】〗\\]}]+[〕》】〗\\]})])?(?!$)", "g");

/** 剥掉章节名里的序号与装饰括号，只留纯名字（用于相似度比对） */
export function getPureChapterName(chapterName) {
  if (chapterName === null || chapterName === undefined) return "";
  return fullToHalf(String(chapterName))
    .replace(regexA, "")
    .replace(regexB, "")
    .replace(regexC, "")
    .replace(regexOther, "");
}

/* ---------------- Apache commons-text JaccardSimilarity ---------------- */

/**
 * commons-text 1.13.1 的 JaccardSimilarity.apply(CharSequence, CharSequence)：
 * 两串各自摊成字符集合（SimilarityInput 的 Character 版），返回 交集大小 / 并集大小。
 * 两边都空返回 1；一边空返回 0（照抄源码的三条早退分支）。
 */
export function jaccardSimilarity(left, right) {
  const a = String(left == null ? "" : left);
  const b = String(right == null ? "" : right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const ls = new Set(a.split(""));
  const rs = new Set(b.split(""));
  const union = new Set([...ls, ...rs]);
  const inter = ls.size + rs.size - union.size;
  return inter / union.size;
}

/* ---------------- BookHelp.getDurChapter（BookHelp.kt:504-551） ---------------- */

/**
 * 换源时把「旧书读到第几章」映射到「新书目录里的第几章」。
 * 照 legado BookHelp.getDurChapter(oldDurChapterIndex, oldDurChapterTitle, newChapterList, oldChapterListSize)：
 *   1) 先在估算位置前后 10 章内找「纯章节名 Jaccard 相似度最高」的那一章；
 *   2) 相似度不到 0.96 时，再按「章节序号最接近」匹配；
 *   3) 两条都不成立就退回按旧章号在新目录长度里夹紧。
 * @param {number} oldIdx   旧书当前章号（Book.durChapterIndex）
 * @param {string} oldTitle 旧书当前章节名（Book.durChapterTitle）
 * @param {Array<{title:string}>} toc 新书目录
 * @param {number} oldTotal 旧书章节总数（Book.totalChapterNum，0 表示未知）
 */
export function getDurChapter(oldIdx, oldTitle, toc, oldTotal) {
  const oldDurChapterIndex = Number(oldIdx) || 0;
  const newChapterList = toc || [];
  if (oldDurChapterIndex <= 0) return 0;
  if (newChapterList.length === 0) return oldDurChapterIndex;
  const oldChapterNum = getChapterNum(oldTitle);
  const oldName = getPureChapterName(oldTitle);
  const newChapterSize = newChapterList.length;
  const oldChapterListSize = Number(oldTotal) || 0;
  const durIndex = oldChapterListSize === 0
    ? oldDurChapterIndex
    : Math.floor(oldDurChapterIndex * oldChapterListSize / newChapterSize);
  const lo = Math.max(0, Math.min(oldDurChapterIndex, durIndex) - 10);
  const hi = Math.min(newChapterSize - 1, Math.max(oldDurChapterIndex, durIndex) + 10);
  let nameSim = 0.0;
  let newIndex = 0;
  let newNum = 0;
  if (oldName.length > 0) {
    for (let i = lo; i <= hi; i++) {
      const newName = getPureChapterName(newChapterList[i].title);
      const temp = jaccardSimilarity(oldName, newName);
      if (temp > nameSim) { nameSim = temp; newIndex = i; }
    }
  }
  if (nameSim < 0.96 && oldChapterNum > 0) {
    for (let i = lo; i <= hi; i++) {
      const temp = getChapterNum(newChapterList[i].title);
      if (temp === oldChapterNum) { newNum = temp; newIndex = i; break; }
      else if (Math.abs(temp - oldChapterNum) < Math.abs(newNum - oldChapterNum)) { newNum = temp; newIndex = i; }
    }
  }
  return (nameSim > 0.96 || Math.abs(newNum - oldChapterNum) < 1)
    ? newIndex
    : Math.min(Math.max(0, newChapterList.length - 1), oldDurChapterIndex);
}
