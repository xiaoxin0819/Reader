/* zip.mjs —— 极简标准 ZIP 打包器（只用 node:zlib，无第三方依赖）

   为什么不用 tar.exe -a：
     Windows 自带的 tar 生成 ZIP 时会把条目名写成 "./Reader.exe"（带 ./ 前缀），
     且外部属性位与常规 zip 工具不一致。实测部分解压工具（旧版 WinRAR、7-Zip、
     部分系统的内置解压）会因此报「压缩包无效」或解出空目录。

   这里按 PKWARE APPNOTE 手写最小实现：
     · 条目名不带任何前缀（Reader.exe 而非 ./Reader.exe）
     · 用 deflateRaw（ZIP 的 method 8），与主流工具一致
     · 目录条目以 "/" 结尾并显式声明
     · 设置正确的 external attributes（Windows 文件属性）
     · 中央目录与 EOCD 结构标准，不写 zip64（本项目文件 < 100MB）
*/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** CRC-32 查表（ZIP 每个条目都要） */
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

/** MS-DOS 时间/日期（ZIP 用的老格式） */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

/**
 * 把一组文件打成 ZIP。
 * @param {Array<{name: string, data: Buffer}>} entries 条目名用正斜杠，不带 ./ 前缀
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    // 目录条目：名字以 / 结尾、内容为空
    const isDir = e.name.endsWith('/');
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(e.data);
    const crc = crc32(raw);
    const comp = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 });
    const method = isDir ? 0 : 8;   // 0 = store, 8 = deflate
    const compSize = comp.length;
    const rawSize = raw.length;

    /* 外部属性：Windows 下 0x10 = FILE_ATTRIBUTE_DIRECTORY，0x20 = ARCHIVE。
       高 16 位给 Unix 权限（0755 / 0644），低 16 位给 DOS 属性。
       不设置会让某些工具解出「无权限」或直接跳过。 */
    const extAttr = isDir ? 0x10 : 0x20;
    const unixMode = isDir ? 0o40755 : 0o100644;
    const externalAttributes = ((unixMode & 0xFFFF) << 16) | extAttr;

    // ---- 本地文件头 ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);      // 签名 PK\03\04
    lh.writeUInt16LE(20, 4);              // 解压所需版本 2.0
    lh.writeUInt16LE(0x0800, 6);          // 标志位：文件名是 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compSize, 18);
    lh.writeUInt32LE(rawSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);              // 扩展字段长度
    localParts.push(lh, nameBuf, comp);

    // ---- 中央目录条目 ----
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);      // 签名 PK\01\02
    ch.writeUInt16LE(0x031E, 4);          // 生成版本：Unix + 3.0
    ch.writeUInt16LE(20, 6);              // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);          // 标志位：UTF-8
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compSize, 20);
    ch.writeUInt32LE(rawSize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);              // 扩展字段
    ch.writeUInt16LE(0, 32);              // 注释
    ch.writeUInt16LE(0, 34);              // 磁盘号
    ch.writeUInt16LE(0, 36);              // 内部属性
    ch.writeUInt32LE(externalAttributes >>> 0, 38);
    ch.writeUInt32LE(offset, 42);         // 本地头偏移
    centralParts.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // 签名 PK\05\06
  eocd.writeUInt16LE(0, 4);               // 当前磁盘
  eocd.writeUInt16LE(0, 6);               // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8);  // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 总条目数
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);         // 中央目录偏移
  eocd.writeUInt16LE(0, 20);              // 注释长度

  return Buffer.concat([...localParts, central, eocd]);
}

/**
 * 把目录打包成 ZIP（递归，条目名相对于 dirPath，不带 ./ 前缀）。
 * @param {string} dirPath 源目录
 * @param {string} outFile 输出 zip 路径
 * @param {string} [prefix] 条目名前缀（如 "Reader"），用于在包里包一层同名目录，
 *   这样用户解压到桌面时不会把 exe 散落出来，而是得到一个 Reader/ 文件夹。
 */
export function zipDirectory(dirPath, outFile, prefix = '') {
  const entries = [];
  const base = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  if (base) entries.push({ name: base, data: Buffer.alloc(0) });

  const walk = (abs, rel) => {
    const items = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      const childAbs = path.join(abs, it.name);
      const childRel = base + (rel ? `${rel}/${it.name}` : it.name);
      if (it.isDirectory()) {
        entries.push({ name: childRel + '/', data: Buffer.alloc(0) });
        walk(childAbs, childRel);
      } else if (it.isFile()) {
        entries.push({ name: childRel, data: fs.readFileSync(childAbs) });
      }
    }
  };

  walk(dirPath, '');
  fs.writeFileSync(outFile, makeZip(entries));
  return entries.length;
}
