# Reader · 电脑端在线阅读器

复刻 [legado](https://github.com/xiaoxin0819/legado)（阅读）的电脑端实现。书源规则引擎、搜索/发现/详情/目录/正文解析
全部按 legado 的 Kotlin 源码逐层移植；界面沿用本地阅读器的三栏布局，额外提供「在线」模式。

## 下载（普通用户）

**[⬇ 下载 Reader-portable.zip](https://github.com/xiaoxin0819/Reader/releases/latest/download/Reader-portable.zip)**（34 MB）

解压后双击 `Reader.exe` 即可，**无需安装 Node.js**。

- 首次运行自动释放内置的 31 个书源，浏览器自动打开 <http://127.0.0.1:7788/>
- 数据全在 exe 同级目录（便携模式）：`reader.config.json` / `sources/` / `cache/` / `fonts/`
- 不要放在 `C:\Program Files` 等需要管理员权限的目录

全部版本见 [Releases](https://github.com/xiaoxin0819/Reader/releases)。

## 快速开始

### 方式一：单文件 exe

`dist/Reader-portable.zip` 解压后双击 **`Reader.exe`** 即可，无需安装 Node.js。

- 首次运行会在 exe 同级目录自动生成 `reader.config.json`、`sources/`、`cache/`、`fonts/`，
  并把内置的 31 个书源释放到 `sources/groups/group-1/`。
- 浏览器会自动打开 <http://127.0.0.1:7788/>；关闭那个命令行窗口即退出。
- 数据全在同级目录，整个文件夹拷走就带走了全部数据（含书源、书架、缓存、登录态）。
- **不要放在 `C:\Program Files` 等需要管理员权限的目录**，否则无法写入数据。

自行打包：

```bash
cd Reader
npm install --no-save esbuild     # 打包脚本依赖 esbuild
node build/build-exe.mjs          # 产出 dist/Reader.exe、dist/Reader-portable.zip
```

发布新版本（把压缩包发到 GitHub Release，不走 git 提交二进制）：

```bash
git tag v1.0.1 && git push origin v1.0.1
set GITHUB_TOKEN=ghp_xxx          # 需要 repo 权限
node build/publish-release.mjs v1.0.1
```

> exe 有 94 MB，直接提交进 git 会让仓库体积暴涨（Git 对二进制不做增量），
> 所以用 Release 附件分发 —— 不占仓库体积，且自带下载统计。

打包脚本用 Node.js SEA（Single Executable Application）：
esbuild 把 `server.mjs` 与两个 worker 打成自包含 CJS，前端资源与内置书源作为 SEA assets 嵌入，
再用 postject 注入 `node.exe` 副本。worker 在 exe 里改用 `new Worker(源码字符串, { eval: true })` 启动
（单文件下磁盘没有 worker 文件），见 `src/exe-env.mjs`。

### 方式二：源码运行（开发者）

双击 **`启动Reader.bat`**，浏览器会自动打开 <http://127.0.0.1:7788/>。
关闭服务双击 **`关闭Reader.bat`**。

需要 Node.js（脚本会自动找 `node.exe`；也支持 `C:\Develop\nodejs\node.exe` 等常见路径）。

手动启动：

```bash
cd Reader
npm install          # 首次运行，装规则引擎依赖
node server.mjs      # 默认端口 7788，可用 PORT 环境变量覆盖
```

## 两种模式

顶栏左上角切换：

| 模式 | 说明 |
| --- | --- |
| 本地 | 导入 txt 文件/文件夹，走本地解析（`parse-core.mjs`），与「阅读器」行为一致 |
| 在线 | 从书源抓取，支持搜索、发现、换源、目录、正文、替换规则 |

## 界面

- **书架**：本地书 + 在线书混排；在线书显示来源名，支持分组筛选
- **阅读区**：正文渲染、章节目录、上一章/下一章、进度条、字号/行距/边距/主题
- **书源**：导入（JSON 文本 / 文件 / URL）、启用停用、分组、排序、编辑、导出、规则调试
- **发现**：按书源的发现页分类浏览
- **替换规则**：正则/文本替换，可作用于标题或正文
- **大书解析**：本地 TXT 目录的标题净化走批量执行（`replaceManyWithRule`，一次 VM 调用 256 条），超时语义对齐 legado「整条规则一个 deadline」。5290 章 / 36MB 冷解析约 250ms，5597 章 / 51.7MB 约 450ms

## 书源

内置 `sources/shuyuan-default.json`（31 个书源，默认启用 18 个）。
用户改动（启用状态、分组、排序、编辑结果）写入 `sources/book-sources.json`，加载时优先生效，因此升级内置源不会覆盖你的设置。

支持 legado 书源的全部主要能力：

- CSS 选择器 / XPath / JSONPath / 正则（`analyze-jsoup` `analyze-xpath` `analyze-json` `analyze-regex`）
- 规则里的 JS：`@js:` / `<js>` 块、`java.*` 桥、`source.*` 变量、`jsLib` 公共库、`{{ }}` 插值
- 单文件 JS 书源（`mainJs`，`search`/`explore`/`getBookInfo`/`getChapters`/`getContent`）
- 请求侧：自定义 header、charset、POST body、`{{key}}`/`{{page}}` 占位、URL 尾部 JSON 选项（`,{"headers":{...}}`）
- 正文：多页拼接、`nextChapterUrl`、图片样式、正文替换规则
- 目录：多页目录、`isVolume` 卷、`updateTime`、章节顺序与去重
- 登录/验证：`loginUrl`、`loginCheckJs`、Cookie Jar、`enabledCookieJar`
- 错误可见：书源失败会列出原因，可在书源页跑「规则调试」看每一步耗时与日志

## legado HTTP API 兼容

实现了 legado `api.md` 的接口，可被阅读类 App 直接调用。裸路径和 `/api/legado/` 前缀都可用。

| 方法 | 路径 |
| --- | --- |
| GET | `/getBookSources` `/getBookSource` `/getBookshelf` `/getBookInfo` `/getChapterList` `/getBookContent` `/refreshToc` `/getReplaceRules` `/getReadConfig` `/cover` `/image` |
| POST | `/saveBookSource` `/saveBookSources` `/saveJsSource` `/deleteBookSources` `/saveBook` `/deleteBook` `/saveBookProgress` `/saveReadConfig` `/saveReplaceRule` `/deleteReplaceRule` `/testReplaceRule` |
| WS | `/searchBook` `/bookSourceDebug` |

鉴权：在 `reader.config.json` 里配置 `legadoToken` 后，请求需带 `X-Legado-Token` 头；不配置则放行（便于本机使用）。

## 架构

```
public/            前端（index.html / app.js / online.js / *.css）
server.mjs         HTTP 服务、静态资源、REST API、legado 兼容 API 挂载
parse-core.mjs     本地 txt 解析（与「阅读器」一致）
src/
  book-pool.mjs        worker 池：多源并发搜索、任务分发、超时重建
  book-worker.mjs      worker 内任务：search/explore/bookInfo/chapters/content/debug
  web-book.mjs         抓取编排（对应 legado WebBook/BookList/BookInfo/BookChapterList/BookContent/SearchModel）
  js-source.mjs        单文件 JS 书源
  analyze-url.mjs      URL + 请求选项解析
  analyze-jsoup.mjs    CSS 选择器引擎
  analyze-xpath.mjs    XPath
  analyze-json.mjs     JSONPath
  analyze-regex.mjs    正则
  analyze-rule.mjs     规则串解析与组合（|| && %% ## @js: 等）
  rule-engine.mjs      规则求值、JS 绑定、字段拼装
  js-runtime.mjs       规则 JS 运行时（Rhino 语义）
  java-bridge.mjs      java.* / source.* 桥
  sync-net.mjs         同步 HTTP 桥（Atomics.wait，供 js 里 java.ajax 阻塞调用）
  net-worker.mjs       同步 HTTP 的 worker 侧实现
  http-core.mjs        请求执行（重定向 / 编码 / Cookie）
  net-utils.mjs        URL 工具
  charset.mjs          编码探测与转换
  crypto-utils.mjs     AES/RSA/MD5 等（书源签名用）
  crypto-js.mjs        CryptoJS 兼容层
  html-format.mjs      HTML 排版与清洗
  verification.mjs     需要人工验证时的挂起/回灌
  verification 相关 UI  见 public/online.js 的验证弹窗
  packages-shim.mjs    书源 JS 里 require() 的包垫片
  rule-analyzer.mjs    规则调试的日志收集
  explore.mjs          发现页辅助
  book-source-model.mjs 书源模型 / 导入导出
  legado-api.mjs       legado api.md 兼容端点 + WebSocket
  wrap.mjs             书源包装（BaseSource 语义）
vendor/cryptojs.min.js  书源 JS 里 CryptoJS 的注入源
sources/           书源 JSON
cache/toc/         目录缓存（TTL 6h）
cache/content/     正文缓存
cache/explore/     发现页分类 ACache（与 legado 同名同格式）
cache/booklist/    书架快照（按书架根目录哈希命名，重启后秒出书架）
cache/webview/     登录用 Edge/Chromium profile（登录态、网页数据）
cache/login-state.json  书源 Cookie / 登录信息
fonts/             自定义字体
```

**为什么在线抓取要跑 worker**：书源规则里的 JS 是同步的（Rhino 语义），
`src/sync-net.mjs` 用 `Atomics.wait` 阻塞线程来实现 `java.ajax` 这类同步调用。
放主线程会把整个 HTTP 服务冻住，所以每个 worker 线程各自带一个同步网络线程，多源并发 = 多个 worker 并行。

## 配置与缓存位置

`reader.config.json` 保存书架、进度、字体、阅读设置、书源列表、在线书架与替换规则。
删掉它会恢复默认（书架数据会丢）。

缓存默认统一放在 `Reader/cache`，不会写到系统临时目录或浏览器默认用户目录：

- `cache/content/`：正文缓存
- `cache/toc/`：目录缓存
- `cache/explore/`：发现页分类缓存
- `cache/booklist/`：书架快照（stale-while-revalidate，见下）
- `cache/webview/`：登录用 Edge/Chromium profile
- `cache/login-state.json`：书源 Cookie / 登录信息

如果确实需要把缓存放到别的盘，可以设置环境变量 `READER_CACHE_DIR`；不设置时固定为
`Reader/cache`。阅读器顶栏的垃圾桶按钮会打开「缓存与数据位置」窗口，显示实际路径和占用，
并提供「打开缓存文件夹」「清理阅读缓存」。清理阅读缓存不会删除登录 Cookie、WebView 数据和书架。

书架快照（`cache/booklist/`）用于解决「书架在移动硬盘上、硬盘休眠后每次重开都要等扫描」：
服务重启后第一次请求 `/api/books` 会**先返回上次的快照**（响应带 `stale: true`，页面立刻出书），
同时在后台重新扫描目录，扫完静默刷新一次；前端只有在数量变化时才重绘，不会闪屏或打断操作。
快照按书架根目录路径哈希命名，超过 7 天或解析失败自动当作未命中并退回真扫；
新增 / 移除书架会立即失效对应快照。清理阅读缓存不会删除 `cache/booklist/`。

登录内置浏览器（`cache/webview`）额外做了一层「用完收摊」，从源头压住体积：
最后一个登录/评论区窗口关闭后留 20s 宽限（期间重开是热进程，几乎瞬时），随后清掉本次会话
长出的 HTTP 缓存并退出浏览器进程，再回收代码 / GPU / Shader 缓存。整个过程只碰可再生缓存，
Cookies、Local Storage、IndexedDB、站点 Storage 与 `cache/login-state.json` 全部保留；
正文 / 目录 / 搜索 / 换源走 Node 请求池、不经过浏览器，因此阅读不受影响。

## 说明

书源规则与解析语义参考 legado（GPL-3.0）源码移植，本项目为学习/自用目的的电脑端复刻。
