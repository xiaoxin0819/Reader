// html-format.mjs —— 移植自 legado io.legado.app.utils.HtmlFormatter
import { getAbsoluteURL } from './net-utils.mjs';

const nbspRegex = /(&nbsp;)+/g;
const espRegex = /(&ensp;|&emsp;)/g;
const noPrintRegex = /(&thinsp;|&zwnj;|&zwj;|\u2009|\u200C|\u200D)/g;
const wrapHtmlRegex = /<\/?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>/g;
const commentRegex = /<!--[^>]*-->/g;
const notImgHtmlRegex = /<\/?(?!img)[a-zA-Z]+(?=[ >])[^<>]*>/g;
const otherHtmlRegex = /<\/?[a-zA-Z]+(?=[ >])[^<>]*>/g;
const formatImagePattern = /<img\b[^>]*>/gi;
const indent1Regex = /\s*\n+\s*/g;
const indent2Regex = /^[\n\s]+/;
const lastRegex = /[\n\s]+$/;
const paramPattern = /\s*,\s*(?=\s*(?:\{|【))/;

function getImageAttribute(tag) {
  for (const name of ['src', 'data-src', 'data-original', 'data-srcset']) {
    const attr = new RegExp('\\b' + name + '\\s*=\\s*([\\\'\\"])', 'i').exec(tag);
    if (!attr) continue;
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
  return null;
}

function formatText(html, otherRegex, paragraphIndent) {
  if (html === null || html === undefined) return '';
  return String(html)
    .replace(nbspRegex, ' ')
    .replace(espRegex, ' ')
    .replace(noPrintRegex, '')
    .replace(wrapHtmlRegex, '\n')
    .replace(commentRegex, '')
    .replace(otherRegex, '')
    .replace(indent1Regex, '\n' + paragraphIndent)
    .replace(indent2Regex, paragraphIndent)
    .replace(lastRegex, '');
}

export function format(html, otherRegex = otherHtmlRegex) {
  return formatText(html, otherRegex, '　　');
}

export function formatIntro(html) {
  return formatText(html, otherHtmlRegex, '');
}

export function formatKeepImg(html, redirectUrl = null) {
  if (html === null || html === undefined) return '';
  const keepImgHtml = format(html, notImgHtmlRegex);
  const out = [];
  let appendPos = 0;
  let m;
  formatImagePattern.lastIndex = 0;
  while ((m = formatImagePattern.exec(keepImgHtml)) !== null) {
    const rawWithParam = getImageAttribute(m[0]);
    out.push(keepImgHtml.substring(appendPos, m.index));
    if (rawWithParam === null) {
      out.push(m[0]);
      appendPos = m.index + m[0].length;
      continue;
    }
    const um = paramPattern.exec(rawWithParam);
    const raw = um ? rawWithParam.substring(0, um.index) : rawWithParam;
    const param = um ? ',' + rawWithParam.substring(um.index + um[0].length) : '';
    out.push('<img src="' + getAbsoluteURL(redirectUrl, raw) + param + '">');
    appendPos = m.index + m[0].length;
  }
  if (appendPos < keepImgHtml.length) out.push(keepImgHtml.substring(appendPos));
  return out.join('');
}
