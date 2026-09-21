# 回归脚本

这些脚本用无头 Edge + CDP 驱动真实浏览器，对运行中的 Reader 做端到端验证。
它们**只读**：会拦断 `/api/online/progress` 写请求，不改动服务端阅读进度。

## 前置条件

1. Reader 已在 `http://127.0.0.1:7788` 运行（`node server.mjs` 或双击 `Reader.exe`）
2. 书架里至少有一本书
3. 本机装了 Edge（默认路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）

## 脚本

| 脚本 | 验证内容 |
| --- | --- |
| `verify-api-smoke.mjs` | 13 个只读接口都返回 200 且结构正确 |
| `verify-no-console-errors.mjs` | 打开页面 + 常用交互过程中无控制台错误 / 未捕获异常 |
| `verify-open-prefetch.mjs` | 打开书后是否立即预取相邻章、有无远距离章节请求 |
| `verify-far-jump-direct.mjs` | 目录远距离跳章是瞬时换章、hover 不预取、失败保留旧章 |
| `verify-shelf-page-sync.mjs` | 刷新后书架停在该书所在页、抓完目录补齐「读到/最新」 |
| `verify-online-first-open.mjs` | 重启后首次打开书的正文渲染耗时 |
| `verify-source-concurrency.mjs` | 书源并发闸门：同书源同时最多 N 个在飞（纯本地，不连源站） |
| `verify-font-picker.mjs` | 字体选择器：逐项字体渲染、自定义项带 ✕、内置项不可删 |
| `verify-auto-next-button.mjs` | 顶栏「自动下一章」按钮与 state 同步、设置面板已无残留 |
| `verify-nav-hotkeys.mjs` | 顶栏翻章按钮的快捷键标注与 ←/→/PageUp/PageDown 实际行为 |

## 用法

```bash
cd Reader
node tools/regress/verify-api-smoke.mjs
node tools/regress/verify-open-prefetch.mjs
```

可用环境变量：

| 变量 | 说明 |
| --- | --- |
| `PROBE_BASE` | 服务地址，默认 `http://127.0.0.1:7788` |
| `PROBE_BOOK` | 指定测试书名（子串匹配），默认取最近阅读 |
| `PROBE_JUMP` | `verify-far-jump-direct` 的跳章距离 |
| `PROBE_CDP_PORT` | CDP 端口，默认每个脚本不同，避免并发冲突 |

## 注意

- 脚本会在系统临时目录建独立的浏览器 Profile，跑完自动删除，不影响你的登录态。
- 验证涉及真实书源请求，**速读谷² 这类有风控的站点不要反复跑**。
