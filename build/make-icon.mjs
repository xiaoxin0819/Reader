/* make-icon.mjs —— 生成 Reader 的图标（多尺寸 .ico）

   为什么自己画而不是找现成图片：
     · 应用图标要在 16x16 到 256x256 都清晰，位图缩放会糊，按尺寸重绘才行；
     · 不引第三方依赖（只用 node:zlib 手写 PNG/ICO），可复现、可改配色。

   用法：
     node build/make-icon.mjs                # 默认 teal 配色 → public/reader.ico
     node build/make-icon.mjs dark out.ico   # 指定配色与输出
     可选配色：teal / dark / warm / minimal

   输出：包含 16/24/32/48/64/128/256 七个尺寸的 ICO（每层用 PNG 压缩）。
*/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VARIANT = process.argv[2] || 'teal';
const OUT = process.argv[3] || path.join(ROOT, 'public', 'reader.ico');

const PALETTES = {
  teal:    { bg1: [0x2E, 0x7D, 0x8A], bg2: [0x18, 0x46, 0x52], fg: [0xFF, 0xFF, 0xFF], accent: [0x8F, 0xD4, 0xDE] },
  dark:    { bg1: [0x33, 0x39, 0x42], bg2: [0x14, 0x18, 0x1D], fg: [0xF2, 0xF5, 0xF7], accent: [0x5E, 0xC8, 0xD8] },
  warm:    { bg1: [0xD2, 0x82, 0x45], bg2: [0x93, 0x4A, 0x1E], fg: [0xFF, 0xF8, 0xF0], accent: [0xFF, 0xD9, 0xA8] },
  minimal: { bg1: [0xFF, 0xFF, 0xFF], bg2: [0xE6, 0xEC, 0xF1], fg: [0x2E, 0x7D, 0x8A], accent: [0x2E, 0x7D, 0x8A] },
};
const P = PALETTES[VARIANT];
if (!P) {
  console.error(`未知配色 ${VARIANT}，可选：${Object.keys(PALETTES).join(' / ')}`);
  process.exit(1);
}

/* ---------------- 一个极简的 RGBA 画布 ---------------- */

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
  }

  blend(x, y, rgb, a) {
    if (a <= 0) return;
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const sa = Math.min(1, a);
    const da = this.data[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) { this.data[i + 3] = 0; return; }
    for (let k = 0; k < 3; k++) {
      const sc = rgb[k] / 255;
      const dc = this.data[i + k] / 255;
      this.data[i + k] = Math.round(((sc * sa + dc * da * (1 - sa)) / outA) * 255);
    }
    this.data[i + 3] = Math.round(outA * 255);
  }

  /**
   * 覆盖率采样填充：每像素取 4x4 子采样，按落入比例定 alpha，
   * 边缘自然抗锯齿，且不依赖系统绘图库。
   */
  fill(inside, rgb, bounds) {
    const SS = 4;
    const [x0, y0, x1, y1] = bounds;
    const xs = Math.max(0, Math.floor(x0));
    const ys = Math.max(0, Math.floor(y0));
    const xe = Math.min(this.size - 1, Math.ceil(x1));
    const ye = Math.min(this.size - 1, Math.ceil(y1));
    for (let y = ys; y <= ye; y++) {
      for (let x = xs; x <= xe; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++;
          }
        }
        if (hit) this.blend(x, y, rgb, hit / (SS * SS));
      }
    }
  }
}

/* ---------------- 形状判定 ---------------- */

function roundRect(x0, y0, x1, y1, r) {
  return (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = Math.min(Math.max(px, x0 + r), x1 - r);
    const cy = Math.min(Math.max(py, y0 + r), y1 - r);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

function polygon(pts) {
  return (px, py) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

function rect(x0, y0, x1, y1) {
  return (px, py) => px >= x0 && px <= x1 && py >= y0 && py <= y1;
}

function circle(cx, cy, r) {
  return (px, py) => {
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

/* ---------------- 绘制图标 ---------------- */

function drawIcon(size) {
  const c = new Canvas(size);
  const s = size;
  const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  // 1) 背景：圆角方形 + 对角渐变（逐像素算色，只有 <=256px，够快）
  const bg = roundRect(0, 0, s - 1, s - 1, s * 0.22);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (bg(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
        }
      }
      if (!hit) continue;
      const t = Math.min(1, Math.max(0, (x + y) / (2 * (s - 1))));
      c.blend(x, y, lerp(P.bg1, P.bg2, t), hit / 16);
    }
  }

  // 2) 书本：两页对称，中间留书脊缝，顶部斜切出翻折感
  const top = s * 0.27;
  const bottom = s * 0.75;
  const left = s * 0.20;
  const right = s * 0.80;
  const cx = s / 2;
  const gap = Math.max(0.6, s * 0.030);
  const fold = s * 0.085;

  c.fill(polygon([
    [left, top + fold],
    [cx - gap, top],
    [cx - gap, bottom],
    [left, bottom],
  ]), P.fg, [left - 1, top - 1, cx, bottom + 1]);

  c.fill(polygon([
    [cx + gap, top],
    [right, top + fold],
    [right, bottom],
    [cx + gap, bottom],
  ]), P.fg, [cx, top - 1, right + 1, bottom + 1]);

  // 3) 书页上的文字线：小尺寸少画几条，避免糊成一团
  /* 线条颜色 = 书页颜色的对比色：
     minimal 的书页是深青色（fg=#2E7D8A），线条必须用浅色才看得见；
     其余配色书页是白色，线条用深色（背景色）。 */
  const lineColor = VARIANT === 'minimal' ? [0xFF, 0xFF, 0xFF] : P.bg2;
  const lines = s <= 20 ? 2 : s <= 40 ? 3 : 4;
  const lineH = Math.max(0.9, s * 0.028);
  const startY = top + fold + s * 0.05;
  const step = (bottom - startY - s * 0.06) / Math.max(1, lines);
  const pad = s * 0.045;
  for (let i = 0; i < lines; i++) {
    const y = startY + i * step;
    if (y + lineH > bottom - s * 0.02) break;
    const shrink = (i === lines - 1) ? s * 0.055 : 0;   // 末行短一点，像段末
    const w = (cx - gap) - left - pad * 2 - shrink;
    if (w <= 0.5) continue;
    c.fill(rect(left + pad, y, left + pad + w, y + lineH), lineColor, [left + pad - 1, y - 1, left + pad + w + 1, y + lineH + 1]);
    c.fill(rect(cx + gap + pad, y, cx + gap + pad + w, y + lineH), lineColor, [cx + gap + pad - 1, y - 1, cx + gap + pad + w + 1, y + lineH + 1]);
  }

  // 4) 右下角强调圆点（>=48 才画，小尺寸会挤）
  //    minimal 用青色点（与书页同色系），其余用 accent
  if (s >= 48) {
    const dr = s * 0.070;
    const dx = s - s * 0.145 - dr;
    const dy = s - s * 0.145 - dr;
    const dotColor = VARIANT === 'minimal' ? P.fg : P.accent;
    c.fill(circle(dx, dy, dr), dotColor, [dx - dr - 1, dy - dr - 1, dx + dr + 1, dy + dr + 1]);
  }

  return c;
}

/* ---------------- PNG 编码（只用 zlib） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(canvas) {
  const { size, data } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;   // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * size * 4, size * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 组装 ICO ---------------- */

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = SIZES.map((sz) => ({ size: sz, buf: encodePng(drawIcon(sz)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);              // type = icon
header.writeUInt16LE(pngs.length, 4)     // count

let offset = 6 + 16 * pngs.length;
const entries = [];
for (const p of pngs) {
  const e = Buffer.alloc(16);
  const dim = p.size >= 256 ? 0 : p.size;   // 256 用 0 表示
  e[0] = dim; e[1] = dim;
  e.writeUInt16LE(1, 4);                    // color planes
  e.writeUInt16LE(32, 6);                   // bits per pixel
  e.writeUInt32LE(p.buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.buf.length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);

console.log(`已生成图标（配色 ${VARIANT}）: ${OUT}`);
console.log(`  尺寸 ${SIZES.join(' / ')}   大小 ${(ico.length / 1024).toFixed(1)} KB`);
