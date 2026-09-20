/* set-icon.mjs —— 给 exe 写入图标与版本信息（纯 JS，不依赖 rcedit）

   为什么不用 rcedit：
     它在无交互会话（CI / 脚本环境）里会挂住不退出 —— 打包时表现为
     「rcedit 执行失败或超时，跳过图标设置」，结果 exe 一直带着 Node 默认图标。

   这里改用纯 JS 的 pe-library / resedit 直接操作 PE 资源段，
   不启动外部进程，稳定且可控。

   用法：
     node build/set-icon.mjs <exe路径> [ico路径]
     默认 ico 为 public/reader.ico
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const exePath = process.argv[2];
const icoPath = process.argv[3] || path.join(ROOT, 'public', 'reader.ico');

if (!exePath) {
  console.error('用法: node build/set-icon.mjs <exe路径> [ico路径]');
  process.exit(1);
}
if (!fs.existsSync(exePath)) {
  console.error('找不到 exe: ' + exePath);
  process.exit(1);
}
if (!fs.existsSync(icoPath)) {
  console.error('找不到图标: ' + icoPath);
  process.exit(1);
}

const exeBuf = fs.readFileSync(exePath);
const icoBuf = fs.readFileSync(icoPath);

// 1) 解析 exe 的 PE 结构与资源段
const exe = ResEdit.NtExecutable.from(exeBuf, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

// 2) 解析 ICO，取出所有尺寸
const iconFile = ResEdit.Data.IconFile.from(
  icoBuf.buffer.slice(icoBuf.byteOffset, icoBuf.byteOffset + icoBuf.byteLength),
);

/* 3) 替换图标资源。
      RT_GROUP_ICON 是「图标组」（exe 里显示的那个），
      RT_ICON 是各组内的实际位图数据；replaceIconsForResource 会一起处理。
      这里更新 exe 里所有已有的图标组，保证资源管理器各视图都用新图标；
      若 exe 原本没有图标组，则新建一个 id=1 的组。 */
const GROUP_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const existing = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);

if (existing.length) {
  for (const group of existing) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, group.id, group.lang, iconFile.icons.map((i) => i.data),
    );
  }
  console.log(`已更新 ${existing.length} 个图标组（id: ${existing.map((g) => g.id).join(', ')}）`);
} else {
  let made = false;
  for (const id of GROUP_IDS) {
    const items = iconFile.icons.map((i) => i.data);
    if (items.length) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, 0, items);
      console.log(`已新建图标组 id=${id}`);
      made = true;
      break;
    }
  }
  if (!made) {
    console.error('ICO 里没有可用图标');
    process.exit(1);
  }
}

// 4) 写回资源段
res.outputResource(exe);

// 5) 导出新 exe（ignoreCert：注入 blob 后签名已失效，直接去掉证书表）
const out = Buffer.from(exe.generate({ ignoreCert: true }));
fs.writeFileSync(exePath, out);

console.log(`图标已写入: ${exePath}`);
console.log(`  ICO 尺寸数: ${iconFile.icons.length}   exe 大小: ${(out.length / 1048576).toFixed(1)} MB`);
