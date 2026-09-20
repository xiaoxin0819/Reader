# Reader 项目说明与任务状态

更新时间：2026-09-21

## 0. 进度速览（每完成一项就更新这里）

更新时间：2026-09-21

| 模块 | 状态 | 备注 |
| --- | --- | --- |
| 书源导入 / 启停 / 分组 / 排序 / 导入预览 | ✅ | 2026-09-19 用户确认；默认全选，已存在标记 |
| **独立书源组（多套书源集合）** | ✅ **2026-09-19 本次新增** | `sources/groups/index.json` + `<groupId>/book-sources.json`；旧 `book-sources.json` 自动迁移为「书源组1」并保留为当前组镜像。书源管理页顶部可切换/新建/重命名/删除组；一次只启用一个组，导入、启停、排序只写当前组，搜索/发现/换源只看当前组；重启后当前组保持 |
| 搜索（流式返回、失败置顶、只列启用源） | ✅ | 2026-09-19 新增「有结果源数」统计 + 无结果/失败源清单（见更新日志） |
| **搜索结果按书源展开 / 收起** | ✅ **本次新增** | 分组头折叠 + 「收起全部 / 展开全部」，实测 12 组正常 |
| **搜索排序（最准确结果置顶）** | ✅ **2026-09-19 新增** | 等值桶 > 标签桶 > 包含桶；同档按平台优先级（番茄最前）；合并记录优先采用番茄条目身份，实测「我不是戏神」全源搜索第一条为光遇聚合/番茄 9 个来源；并已确认 legado 原生多源搜索同样存在该排序现象，本实现已比原生更准 |
| **搜索翻页（不再重跑一轮）** | ✅ **2026-09-19 新增** | 翻页保留上一页列表 + 吸顶「正在加载第 N 页…」+ 新页到齐后整体替换并定位于新增第一条；`hasMore=false` 时「下一页」禁用并显示「已全部加载」，另加「加载全部」按钮顺序拉完后续页（详见更新日志） |
| **普通搜索不再按作者过滤（2026-09-19 修复）** | ✅ **本次修复** | 普通搜索按作者全局硬过滤导致「手机能搜到、桌面搜不到」（《我的星空武道》173 本只剩 1 本）。已对齐 legado：作者过滤只保留给换源模式，普通搜索仅把作者命中的书提前。实测 173 本 / filtered=0，换源仍 1 本 4 来源 |
| 详情页（简介、6 按钮、完整目录弹窗、加入/移出书架） | ✅ | 用户确认 |
| 书架显示（单页 6 本、读到/最新章节、去重、无 99+） | ✅ | 用户确认 |
| 书架管理页面 | ✅ | 用户确认 |
| **本地「管理书架」删除响应慢** | ✅ **2026-09-19 本次修复** | 根因：移除书架后 `selectShelf()` 同步重扫目标目录；`D:\\小说` 14,044 本旧实现约 2.26s，卡在「确认移除」。修法：前端删除后立即更新弹窗/下拉、非当前书架不再重扫、当前书架先清阅读区再后台载入（`shelfLoadSeq` 丢弃旧响应）；后端 `listBooks()` 改固定并发 64 的异步文件头读取。实测移除 UI 更新 11~12ms、14,044 本扫描降至约 1.0s。详见更新日志 |
| 盘龙正文异常 | ✅ | 已定位：**不是净化规则**。松鹤阅读源第 398 章起走 QQ 阅读 `ads-read` 接口，源侧只返回 47~51 字试读片段（以 `...` 结尾），书源 `ruleContent.payAction` 为 `null`，legado 同样只能拿到这段预览。已新增付费预览识别 + 正文区提示条（含「换源」入口） |
| 晴天番茄正文 + 登录态 | ✅ | 用户确认 |
| 光遇聚合发现页 / 榜单 | ✅ **2026-09-19 完全修复（含点榜单出书）** | 历史缓存已恢复（388 项，12 榜位 + 全部标签）；点榜单/搜索曾因「Cookie 域取错」全部 502，根因与修复详见 4.18：服务器要求带 `deviceId+qttoken` 凭证，而 `AnalyzeUrl` 用 bookSourceUrl（字面量「光遇聚合」）取 Cookie 导致取空；改为按实际请求 URL 取 Cookie（照 legado CookieManager 语义）后：v1~v7 全 200、巅峰榜 30 本书、搜索 364 条 |
| 净化规则（可勾选、取消恢复原文、清缓存生效） | ✅ | 用户确认；底部栏 2026-09-19 精简为「全选 / 反选」 |
| **TXT 目录规则（本地分章 + 右侧目录）** | ✅ **本次新增** | 照搬 legado `TextFile.kt` 与 `defaultData/txtTocRule.json`；26 条内置规则，默认启用 12 条与 legado 一致；支持开关、排序、增删、导入导出、单条试切，规则变更会同时重建本地分章和右侧目录 |
| **替换净化 / TXT 目录规则同步到本地阅读器（阅读器）** | ✅ **本次完成** | 把在线版 ✎ 按钮与面板整份搬到 `阅读器/`（本地 txt）：后端接上 `/api/replace-rules*`、`/api/txt-toc-rules*`，本地分章与正文/章标题实时跑规则；实测 21 条净化规则（默认启用 6）+ 26 条目录规则（默认启用 12），取消规则即恢复原文；单文件 exe 打包脚本同步升级（内联 `src/` 规则引擎与 `sources/` 内置规则，`public/replace.js` 作为前端资源嵌入），已实际出包并验证 |
| **章节号标题（@js 替换引擎）** | ✅ **本次修复** | 修复 legado eval 语义：`@js:` 返回最后表达式值，不再把“第一章”整段删空；七猫《武动乾坤》《斗破苍穹》章节头恢复章节号 |
| **数字标题净化二选一（#00 / #01 互斥）** | ✅ **本次新增** | 新增 `builtin-netclean-0`＝sjshb57 `legado-57` v3.0.1 规则（按用户要求把章节号输出改为 `第 1 章`，中间带空格），原 `builtin-netclean-1` 保留原版（输出 `第001章 内容`）；两条互斥，开启其一自动关闭另一条，前端带「二选一」徽标 + 提示；老配置由 `syncBuiltinReplaceRulesBySignature()` 按内容签名自动补条/还原 |
| **在线目录标题净化统一（正文 / 目录 / 书架 / 目录弹窗）** | ✅ **本次修复** | 对齐 legado `BookChapter.getDisplayTitle()`：右侧目录、正文头、书架「读到/最新」、详情页目录弹窗共用同一套 `scopeTitle` 替换规则；TOC 缓存仍存原始标题，返回时实时套规则 |
| 换源 / 一键换源 | ✅ | 单本换源已由用户确认生效；一键换源的目标源缺失处理 + 结束结果弹窗已实现（2026-09-19） |
| 评论区弹窗 / 图片尺寸 | ✅ **本次补充** | 评论请求参数、正文和图片加载已修复并实测；2026-09-19 新增评论区首帧加载遮罩，点击后立即显示「正在加载评论区…」，iframe 有可见内容后才撤掉，消除先空白再加载；七猫/晴天「神评 / 本章说」SVG 横幅统一按 56% 宽缩放（晴天 903x98/903x768 → 506x55/506x325，七猫同类横幅同步缩放） |
| **发现页分类排版（2026-09-19）** | ✅ **本次新增** | 速读谷²/笔趣阁/QQ浏览器的分类 chip（无自带百分比列宽者）统一等宽，换行后列与列严格对齐；书源自带百分比列宽（松鹤庭沐二级分类 25%）与整行分组头保持原布局；松鹤庭沐整行分组头去撑满空白后按 🔷🔹…🔹🔷 / 🔶🔸…🔸🔶 交替装饰 |
| **QQ 浏览器发现页分类严格对齐（2026-09-19）** | ✅ **本次修复** | QQ浏览器分类 chip 改 `display:grid; repeat(auto-fill,minmax(110px,1fr))`（`.ek-grid`），测量前若面板隐藏则下一帧重试，字体加载完再测一次；实测 22 项全部 117px、6 列严格对齐，「现实」「女频·浪漫青春」不再错位 |
| **番茄（找书版）发现结果页（2026-09-19）** | ✅ **已完成（用户确认）** | 发现分类可进入结果页并显示书目；分类结果页与个人书架入口分开处理，当前内置番茄源 `女频` 分类实测 20 本、封面 URL 正常 |
| **QQ 阅读发现页封面（2026-09-19）** | ✅ **本次修复** | 多段「JSON 路径 + `@js:`」规则被对象快路径截断，封面只取到 `bid`（如 `54818819`）而非完整图片 URL。已对齐 legado 快路径语义：仅单段规则可用对象快路径，链式规则完整执行；实测月票榜 200 本封面均为完整 URL，图片代理返回 200 / image/jpeg / 18196 bytes |
| **番茄书架（光遇聚合 / 晴天）加载（2026-09-19）** | ✅ **本次修复** | 根因：JsonPath 规则以 `.` 开头（如 `.detail_list[*]`）未按 legado 语义补 `$.` 前缀，规则不生效。`analyze-json.mjs` 的 `_normalizePath()` 对齐 Jayway `PathCompiler`（非 `$`/`@` 开头统一前置 `$.`）；实测 `POST` 书架接口 200、`ok:true`、258 本 |
| **前端版本哨兵 `/api/build`（2026-09-19）** | ✅ **本次新增** | `server.mjs` 新增 `/api/build` 返回 public 资源 mtime+大小指纹；`online.js` 的 `watchBuild()` 每 15s / 标签页重新可见时比对，变化即 `location.reload()`，消除「改了代码但旧标签页仍是旧界面」 |
| 分页与滚动位置 | ✅ | 发现页「保留旧页 → 整体替换 → 瞬时置顶」；搜索结果翻页改为同轮累加、保留旧列表 + 吸顶进度，2026-09-19 实测通过 |
| 本地 / 在线模式导航差异 | ✅ | 2026-09-19 用户确认完成 |
| 本地模式与原阅读器一致性（2026-09-19 修复） | ✅ | 7788 已切换为 Reader；顶栏恢复原 grid 三栏，实测坐标与原阅读器一致（12/585、607/196、813/585）；本地书架 6 个、首本阅读进度、字体、设置均已对齐；首本正文 2174 字，差异来自用户启用的 TXT 目录规则 |
| **在线正文首次打开提速（2026-09-20）** | ✅ **本次完成（已实测）** | 启动后先预热最近阅读当前章 + 后 2 章，再后台预热书架全部书的当前章 + 下一章；同章在飞请求去重；打开书跳过不必要详情请求并提前发起正文请求；JSON/JS/CSS gzip；静态资源 ETag 304；在线目录标题净化改批量执行。实测目录接口 229–236ms→32–39ms（1483 章 0 差异），正文传输 112KB→15KB，首次正文渲染 449–713ms，书架预热 17/17 本；书架/正文同步回归 14/14 PASS |
| **清理缓存后自动重建书架正文缓存（2026-09-20）** | ✅ **本次完成** | 点击「清理正文 / 目录 / 发现分类缓存」后，不再只清空；接口返回后立刻后台预热最近阅读 + 书架全部书的当前章/下一章，并提示「正在后台预热书架」。清完马上打开仍受源站冷回源限制，但稍等片刻后命中缓存。 |
| **打开预加载真正生效 + 速读谷取消限速（2026-09-21）** | ✅ **本次完成（已实测）** | `openBook()` 立即预取相邻章（不再等 idle）；预热不再因 `noExport` 跳过速读谷；四个书源文件速读谷 `concurrentRate` 由 `2/1000` → `5/1000` → 按用户要求**彻底取消（`null`）**，与原始书源备份一致，服务端已确认「无任何限速书源」。实测盘龙：当前章 482 / 下一章 483 / 上一章 481 同一时刻发出、各 ~150-165ms（限速时第 3 个被卡 3145ms），首次正文渲染 494ms；打开预取 4/4 PASS、远跳回归 5/5 PASS、书架同步 14/14 PASS；书架预热 17/17 本。详见 4.23 |
| 导出 TXT（并发数 + 进度条 + 禁止导出源） | ✅ | 已实现：`#exportModal`（并发数 / 章间隔可调 + 进度条 + 逐章日志 + 保存 TXT），文案统一为「禁止导出 TXT 小说」（`online.js:2491,2875,3297`、`server.mjs:3078,3144`） |
| **本地切书性能** | ✅ **2026-09-19 已实测** | 前端按书架+路径复用章节缓存；后端 `replace-engine.mjs` 缓存 `@js:` VM context、`server.mjs` `fileCache` 改 LRU（40 本）、`/api/book` 增加标题替换结果缓存（24 本）。49.3MB/5597 章《踏星》`/api/book` 从约 3.4–3.75s 降到首次约 1.1s、命中缓存约 60–70ms（2026-09-19 复测首刷 1070ms、连续两次 14ms / 10ms） |
| 登录窗口交互 / 番茄验证码 | ✅ **本次修复** | 番茄登录验证码窗口「点不动、拖不动」根因：书源 header 被 `Network.setExtraHTTPHeaders` 整包注入到**所有**请求（含跨域子资源），验证中心 SDK 的 CORS 预检全部失败、脚本没跑起来。已对齐 legado `WebViewLoginFragment` + `toWebViewRequestConfig` 语义：UA → `Network.setUserAgentOverride`（全局），其余 header → 只对主框架 Document 走 `Fetch.requestPaused`。实测滑块可按下拖动、进度条跟随、进入下一轮验证图 |
| **书源管理页全选 / 反选位置（2026-09-19）** | ✅ **本次调整** | 从底部工具条移到列表上方独立条目栏，与「N 个书源（启用 M）」统计同一行靠右显示；工具条保留筛选与导入/导出按钮。 |
| **书源组2 被写为全部禁用 / 书架仍可读（2026-09-19 排查）** | ✅ 已恢复 | 组2 17 源曾全部 `enabled=false`，但书架书仍能打开、翻章。书架/阅读按 `book.origin` 从 `sourceMap` 取源，不检查 `enabled`；`enabled` 只过滤搜索/发现候选，对应 legado「getBookSource 不看 enabled、enableSources 才过滤」的设计，不是缓存。组文件已恢复为 17/17 启用（active=`group-mu7z0c55-1603`）。 |
| **书源组2 七猫 API / 光遇 chip 布局（2026-09-19）** | ✅ **本次调整** | 七猫 API 发现页按 legado Flexbox 规则改为 4/4/4/3/3 分栏；光遇发现页 chip 去掉 `min-width:0`，353 个 chip 实测无省略号。 |
| **WebView 缓存目录体积与安全清理（2026-09-20）** | ✅ **本次完成（已实测）** | 原体积 693.5MB。① `src/browser-host.mjs` 新增 `REGENERABLE_CACHE_PATHS` **白名单**（HTTP/Code/GPU/Shader 缓存、Edge 组件与模型缓存、Crashpad/指标文件），只删这些可再生目录；② 启动参数加 `--disk-cache-size=256MB`、`--media-cache-size=64MB`、`--disable-background-networking`、`--disable-component-update`、`--disable-sync`、`--no-pings`、`--disable-breakpad`、`--disable-crash-reporter`，从源头压住 `component_crx_cache` / `ProvenanceData` / `Crashpad` 的增长；③ 新增 `BrowserHost.stop(timeout)`，清理前先关浏览器释放 Windows 文件句柄；④ 新增 `POST /api/online/webview/cache/clear` + 设置页「清理 WebView 缓存」按钮，明细区分「可清理」与「保留登录数据」。**实测**：清理前 693.5MB / 68 条 Cookie → 清理释放 672.6MB、0 失败、剩余 20.8MB；清理后 `Default/Network/Cookies`（68 条，SHA256 不变）、`Preferences`、`Local State`、`Local Storage`、`IndexedDB`、`Storage`、`Service Worker/Database`、`cache/login-state.json` 全部原样；重启 Edge 实测番茄 cookie 仍可读取（`sessionid` / `sid_guard` / `passport_auth_status` 均在），无需重新登录。 |
| **WebView 缓存「用完收摊」源头优化（2026-09-20）** | ✅ **本次完成（已实测）** | 单次打开番茄登录页实测 `Default/Cache` 落盘 37.6~41.6MB，是唯一量级大头。① 对照实验证明 `--disk-cache-size` 从 256MB 压到 8MB 只降到 31.4MB、`--disable-features` 关模块 49.38→49.00MB 几乎无效 —— Chromium 不会因上限小就主动淘汰；② 改为「最后一个窗口关闭后 20s 宽限 → CDP `Network.clearBrowserCache`（必须发在 page session，browser 级发会被静默丢弃）→ 退出浏览器 → 删 `TRANSIENT_CACHE_PATHS` 的代码/GPU/Shader 缓存」；③ `stop()` 改优雅退出（逐个关标签同步 Cookie → `Browser.close` → 超时才 SIGKILL），修复原先强杀导致 LocalStorage 丢失；④ `open()` 增 `_opening` 占位，修复「空闲收摊」误杀刚打开的窗口。**实测**：关窗后 HTTP 缓存 37.65→0.00MB、Cookies 5→5 条不变、LocalStorage 探针 `keepme` 仍在；线上 7788 实测 68.07→0.00MB，LocalStorage 107.3KB / Cookies 49152B 均未减少；阅读链路回归 5/5（书架 11 本、目录 846 章、正文、第 401 章、搜索 413 本）；关窗后宽限期内立刻重开回归 9/9。 |
| **书架「每次重开都要等加载」（2026-09-20）** | ✅ **本次完成（已实测）** | 根因：书架目录在 **USB 移动硬盘**（`D:\小说`，WD2500 USB HDD），Windows 电源方案「20 分钟后关闭硬盘」会让磁盘休眠；服务重启后内存缓存必空，第一次列书架要等**磁盘唤醒 + 全目录扫描**。修法：两个阅读器（7788 `Reader` / 7789 `阅读器`）都加 **书架快照（stale-while-revalidate）**：`.cache/booklist/<root哈希>.json` 落盘上次扫描结果，重启后首次请求**先秒回快照**（响应带 `stale:true`）并在后台重扫，扫完静默刷新；前端 `selectShelf()` 见 `stale` 就 1.2s 后静默重拉一次、数量变了才重绘。**实测**：7788 冷启动首次 **185ms→3ms**（快照命中 401 本）、7789 冷启动 **217ms→4ms**（227 本）；浏览器真实时间线 7788 首本 **106ms（冷 profile）/ 30ms（热）**、7789 **95ms / 24ms**。独立验证脚本 10/10 PASS；快照放在项目 `.cache/booklist` 下，清理接口不会误删，新增/移除书架会即时失效 |
| **大书解析提速（`/api/book` 标题净化批量化，2026-09-20）** | ✅ **本次完成（已实测）** | 根因不是脚本慢，而是 **Node `vm` 的 timeout 看门狗收费**：每章标题各调一次 `runInContext({timeout})`，每次挂中断看门狗固定开销约 113µs，5290 章累计约 600ms。legado 的语义是**整条规则一个 deadline**（`RegexExtensions.kt` 的 `select { job.onJoin / onTimeout }` 包住整个 matcher 循环），原实现比 legado 更碎更慢。修法：`replace-engine.mjs` 新增 `replaceManyWithRule()`（一次 vm 调用内循环 eval 全部输入，256 条一块，每条仍是独立函数作用域），`server.mjs` 新增 `applyTitleRulesBatch()` 并改 `localDisplayChapters()` 为「收集全部标题 → 批量净化 → 回填」；单条规则超时仍按 legado `BookChapter.getDisplayTitle` 语义 `isEnabled=false` 落库。**实测冷解析**：7789 `末世神魔录` 36.3MB/5290 章 **975ms → 106~247ms**；7788 `踏星` 51.7MB/5597 章 **1102ms → 453ms**、`守卫者之星际狂飙` 39.0MB/5797 章 **389ms**、`重生之星空巨蚊` 41.2MB **277ms**，其余 5 本 116~269ms。标题净化批量 vs 逐条对照 **4236 项 0 差异**，回归 5 组全 PASS（详见 4.19） |
| **点「阅读」自动定位左侧书架页（2026-09-20）** | ✅ **本次完成（已实测）** | 发现页 / 搜索结果 / 详情页点阅读时，正文打开新书后左侧书架栏会自动翻到**包含这本书的那一页**并高亮；换源（`swapTo`）同样跟随（后端换源是「删旧插新」，新书排到书架末尾）。`online.js` 新增 `syncShelfPageToBook()`：按 `visibleBooks()` 页序算页码、被书架搜索框挡住时先清筛选、找不到则不强行翻页；`readOnlineBook()` 改为 `closePanels()` + silent 后补 `await enterMode()`（否则 `state.bookPerPage` 还是本地模式旧值）。对照 legado `BooksFragment.kt`（L134-157：插入/刷新不得动滚动位置，只有显式操作才 `scrollToPosition`）。**实测**：15 本 / 第 3 页，目标书定位 `page=3`、面板 4 个全 hidden、高亮 1 项（`.scratch/verify-shelf-sync.mjs`） |
| **刷新后书架分页回退 + 新书条目缺「读到 / 最新」（2026-09-20）** | ✅ **本次完成（已实测）** | 三个现象：① 新加入书架的书在左侧只有书名，「读到 / 最新」两行要手动刷新书架才出现；② F5 刷新后正文仍是原书，左侧书架却回到第 1 页；③ 用户核心诉求 —— 正文读哪本，左侧书架必须停在包含那本的那一页并高亮。根因：① 书架条目三字段由 `/api/online/shelf` 从 `readTocCache()` 现算，新书目录刚抓完时前端 `state.online.books` 里还是加入书架时的旧对象（三字段为空），`openBook()` 没重拉书架接口；② `enterMode()` 把 `state.bookPage` 写死为 1、`initOnline()` 恢复上次阅读时没调 `syncShelfPageToBook()`；③ 点阅读路径先 `await openBook()`（可能抓几十秒目录）才翻页，抓目录慢时左侧停在别的页。修法：`online.js` 的 `enterMode()` / `openBook()` / `readOnlineBook()` / `initOnline()` 四处补分页同步与书架重拉，`server.mjs` 的 `fetchTocForBook()` 抓完目录立刻回写「章节总数 / 读到 / 最新」。**实测**：`.scratch/verify-shelf-page-sync.mjs` 真实 Edge + CDP 端到端 **14/14 PASS**（目标书 17/17 位 → 第 3 页、刷新后仍第 3 页、高亮渲染在当前页、连续刷新稳定、服务端与界面都补齐「读到 / 最新」、`totalChapterNum=274`） |
| **换源残留坏记录导致正文 EISDIR（2026-09-20）** | ✅ **本次完成（已实测）** | 现象：从「🪽松鹤庭沐」加入书架的《末日乐园》手动换源到「👕松鹤阅读」后，正文区报 `章节加载失败：EISDIR: illegal operation on a directory, read`。根因链：换源只插新不删旧 → 书架留下两条同名同作者记录（旧的 `tocUrl=...all-chapter?bookId=` 空参、无 `totalChapterNum`；新的 `bookId=1100505099`、2654 章）→ 点阅读走 `/api/online/shelf/add` 按「书名+作者」去重时命中的是坏的那条 → 前端 `chapterUrl()` 退化 → 服务端 `safeJoin(shelfRoot(0), "")` 落在书架根目录 → `readFileSync(目录)` 抛 EISDIR。修法：`isDegenerateTocUrl()` 增加「URL 查询参数为空」判定（能识别 `bookId=` 这类模板变量未替换的坏 URL）；新增 `bookRecordScore()` / `sameBookMeta()` / `dedupeOnlineBooks()`，`repairAllOnlineBooks()` 启动时自动清理同名同作者的重复记录（保留高分那条、保留 `min(order)` 位置、按需搬迁进度）；`/api/online/shelf/add` 多命中时按分数取最优；`doChangeSource()` 换源时把旧书的所有重复记录一并清掉（含 `oldName` / `oldAuthor` 兜底匹配）；`online.js` 的 `swapTo()` 补传 `oldName` / `oldAuthor`。**实测**：启动日志输出「清理书架重复记录：《末日乐园》👕松鹤阅读（保留 👕松鹤阅读）」，书架 18 → 17 本；`/api/online/book` `ok=true` 2654 章、`/api/online/content&index=0` 3267 字正文正常；CDP 端到端 `bodyLen=3199`、`hasEisdir=false`、无 `/api/chapter` 调用（`.scratch/verify-moleread.mjs`）。附带结论：松鹤阅读目录与正文接口本身完全正常（`all-chapter?bookId=1100505099` → 200 / 212844 字节 / 2654 章；`ads-read` → 200 / 3813 字节），「书源本身没有结果返回」的判断不成立 |
| **历史坏记录「清缓存后目录为空」（2026-09-20）** | ✅ **本次完成（已实测）** | 现象：清缓存后打开《末日乐园》（👕松鹤阅读）正文区显示「目录为空」+ 换源/重试，且重新加书架也修不好。根因：早期版本往书架写记录时把 `bookUrl` 尾部的 `,{"headers":{"Referer":...}}` **URL 选项剥掉了**；松鹤阅读源站要求 Referer（不带 → `incorrect referer` 17 字节），详情接口回错 → `$..resourceID` 取空 → `tocUrl` 模板渲染成 `...all-chapter?bookId=` 空参 → 目录永远为空。规则引擎、`AnalyzeUrl`、`getAbsoluteURL`、`/api/online/search`、`/api/online/shelf/add` 均正确保留选项，问题只在历史落盘数据。修法（`Reader/server.mjs`，全部为「消费时自愈」、**不写回书架记录**）：新增 `sourceBookUrlHasOption()` / `ruleOptionText()` / `transplantRuleHeaders()`（从书源规则移植写死的 `headers`）/ `needsUrlOptionHeal()`（三条件同时成立才触发，避免每次打开白跑精确搜索）/ `healLegacyBookUrl()`（先 `preciseSearchWithRetry` 拿带选项的 bookUrl，失败再按规则移植 `headers`）+ `bookUrlHealCache`（`origin|裸bookUrl` 记忆）；`ensureBookInfo()` / `fetchTocForBook()` / `/api/online/book` 三处接入自愈。**实测**：清缓存 → 打开《末日乐园》目录 **2654 章**、正文 3267 字；《玄鉴仙族》1643 章；七猫（bookUrl 本就带选项）与速读谷²（本就无选项）均未被误触发，第二次打开走缓存 40ms→2ms；`.scratch/verify-shelf-page-sync.mjs` 14/14 PASS 不退化 |
| **在线目录 / 正文内存缓存 LRU 上限（2026-09-20）** | ✅ **本次完成（已实测）** | `tocMem`（目录）和 `contentMem`（正文章节）原先只增不减、无任何淘汰机制，重度使用（书架几十本 × 每本几百章）会到几百 MB 且只有重启才释放。新增 `lruTouch()`（读命中刷新顺序）+ `lruSet()`（超上限淘汰最久未用），目录上限 **200 本**、正文章节上限 **500 章**；磁盘持久缓存不受影响，内存淘汰后下次读会自动落盘回填。LRU 单元断言（淘汰 / 读刷新 / 前缀删除 / clear / 未命中）全部通过；`.scratch/verify-shelf-page-sync.mjs` **14/14 PASS** 不退化 |
| **服务退出时配置防丢（2026-09-20）** | ✅ **本次完成（已实测）** | `saveConfig()` 有 200ms 防抖，服务在写盘前被强杀会丢最近一次设置/进度。两个服务均新增 `flushConfigNow()`：SIGINT/SIGTERM/SIGHUP/SIGBREAK 和 `POST /api/shutdown` 退出前同步取消防抖并立即写盘；两个「关闭」脚本从直接 `taskkill /f` 改为「先请求优雅关闭 → 最多等 5 秒 → 仅端口仍占用才强杀兜底」；`/api/shutdown` 限制同源 Origin，外部网页跨站请求 403。实测 7788 / 7789 均为：设置后立即关闭，配置值正确落盘、端口释放；恶意 Origin 请求 403 且服务仍在，测试后已恢复原设置 |
| **代码审查 M1–M4（静态资源 / 坏目录判据 / 自愈负缓存 / URL 选项，2026-09-20）** | ✅ **本次完成（已实测）** | ① M1：两个服务的静态资源路径检查从裸前缀改为 `path.relative()` 真实包含判断，`%5c` / `%2f` 越界向量均 403；② M2：空查询参数不再一律判坏，普通 `?x=&y=1` 不触发重抓，只有 id 类参数为空或详情 URL 同参数有值才判坏；③ M3：`bookUrlHealCache` 失败负缓存加 10 分钟 TTL，站点/搜索恢复后可重试；④ M4：新增静态完整选项移植（支持 method/body），动态占位符选项拒绝搬运，纵横这类 `bookId={$.bookId}` 仍依赖精确搜索返回完整 URL。`node --check` 通过，M1 双服务实测 403/200，M2–M4 断言 8/8，书架同步回归 14/14 |
| **本地阅读器当前版本 exe 打包（2026-09-21）** | ✅ **本次完成（已自检）** | 旧 SEA 打包脚本与新 `server.mjs` 的 `replaceManyWithRule` 导入和加固后的 `serveStatic()` 不匹配，已同步适配。重新执行 `node build/build-exe.mjs` 成功（含图标与版本信息），产物 `阅读器/dist/LocalReader.exe`，94,125,568 bytes，SHA256 `051DE2CEDCE03F63B83C2A51C5FB40F1977C370A5B3AE542B5316422C9A2E088`；打包脚本 `node --check` 通过，脚本内置 exe 自检 `/api/state` 响应正常。 |
| **远距离跳章 + 速读谷风控回退（2026-09-20）** | ✅ **代码修复完成，待速读谷解封后用户实测** | 保留「直接换章」与冷章节 100ms loading；回退第一版新增的目录悬停 / 按下任意章预取（该行为放大请求量，触发速读谷风控），恢复 legado 同款「当前章 + 前后一章」策略。请求成功后才更新章节状态，pending Promise 不再被误判为已缓存，`AggregateError` 转成可读提示；速读谷 / 速读谷² 统一 `concurrentRate=1/2000` 且禁止导出 TXT，并修复多 worker 下限速记录不共享的问题（同一限速书源固定 worker，对齐 legado 进程级限速）；`noExport` 站点不再参与启动 / 清缓存后的后台预热，避免当前封禁期继续打真实站点。专项回归 **5/5 PASS**（含 hover 不发请求、pending 有 loading、失败保留旧章）；书架 / 正文同步回归改选非速读谷书源后 **14/14 PASS**；限速纯本地实测第 2/3 次间隔 2010/2015ms，worker 固定映射断言通过。当前 IP 被速读谷临时封禁，不继续请求真实站点。 |

### 更新日志
- **2026-09-20**：完成「第 10 章直接跳第 57 章远距离跳章卡顿」优化，并回退后续引入风控的任意章预取。
  - 第一阶段根因：目录点击也被复用了滚轮翻章的连续滚动逻辑，远距离跳转时旧章与新章被拼在一起滚动，视觉上既慢又生硬；冷目标章缺少等待反馈，用户感知像卡死。
  - `Reader/public/app.js`：`runChapter()` / `gotoChapter()` 增加 `gesture` 参数；只有滚轮翻章（`wheel`）保留连续阅读动画，目录点击、按钮、键盘、进度条等直接跳章一律瞬时替换正文。
  - 用户实测后确认：速读谷 / 速读谷² 远跳出现无反馈和 `AggregateError`，其它快站点正常；该站本身有风控，历史上并发下载太快也会封 IP。排查结论是第一版新增的「目录悬停 / 按下预取任意章」在用户扫目录时额外放大请求量，不是原本点击跳章必然触发。
  - 已回退 `onlineJumpPrefetch*` 与 `.toc-item` / `.tocm-item` 的 hover / pointerdown 监听，恢复 legado `ReadBook.loadContent()` 同款策略：当前章 + 前后一章，用户未点击的远章不请求。
  - `Reader/public/app.js`：`runChapter()` 增加请求序号；正文成功返回后才更新 `state.chapterIdx`，失败或被新请求打断时保留旧章，避免慢请求晚返回覆盖新请求。
  - `Reader/public/online.js`：给章节 Promise 标记 `__readerSettled`，pending 请求不再被误判为已缓存；`AggregateError` 经 `humanizeNetError()` 转为「书源站点无法访问…」可读提示。
  - 速读谷 / 速读谷² / 书源组2 的 6-速读谷、7-速读谷统一 `concurrentRate=1/2000`、`noExport=true`；限速纯本地实测 3 次访问间隔 0 / 2010 / 2015ms，未再请求真实站点。
  - 追加修复：`Reader/src/book-pool.mjs` 原先每个 worker 各有一份限速记录，理论上同一书源可被轮询到不同 worker，把 `1/2000` 放大成接近 `4/2000`。已按 legado `ConcurrentRateLimiter` 的进程级共享语义，给配置了 `concurrentRate` 的书源按 source key 固定到同一个 worker；未限速书源仍走忙闲轮询。`node --check`、稳定映射断言、`BookPool` 固定 worker 断言均通过。
  - 追加保护：`Reader/server.mjs` 的启动预热和「清缓存后重建」预热跳过 `noExport=true` 的书源（当前即速读谷系列），只保留用户显式点击阅读时的请求；避免服务重启或清缓存时后台预热继续请求已被临时封禁的站点。
  - 回归：`.scratch/verify-far-jump-direct.mjs` **5/5 PASS**（1→58 瞬时换章、hover 0 请求、pending 显示 loading 且状态留旧章、成功后才切换、AggregateError 保留旧章并显示可读错误）；`.scratch/verify-shelf-page-sync.mjs` 改为固定选非速读谷来源后 **14/14 PASS**。7788 已运行新代码，7789 未同步在线专属跳章逻辑。
- **2026-09-20**：完成代码审查修复 M1–M4。
  - M1（静态资源路径检查）：`Reader/server.mjs` 与 `阅读器/server.mjs` 原先用 `abs.startsWith(PUBLIC_DIR)` 判断，存在前缀目录名误配与编码路径风险；现改为 `path.relative(PUBLIC_DIR, abs)` 后检查非空、非 `..`、非 `..\`、非绝对路径，并把 malformed URI decode 直接返回 403。实测两个服务的 `/..%5cserver.mjs`、`/%2e%2e%5cserver.mjs`、`/%2e%2e%2fserver.mjs` 均 403，`/index.html` 均 200。
  - M2（空查询参数误判）：`isDegenerateTocUrl()` 原先只要目录 URL 有任意空查询参数就判坏，会误伤合法 `?x=&y=1` 并触发详情重抓；现只在「id/bid/cid/bookId/chapterId/novelId/resourceId 这类必填标识为空」或「同一参数在 bookUrl 中有非空值」时判坏。目标断言 4/4 通过。
  - M3（负缓存无 TTL）：`bookUrlHealCache` 原先把修复失败记为空串后永不重试；现失败记录为 `{failure:true,expiresAt}`，10 分钟后自动失效可重试；成功结果仍常驻进程内存。目标断言 3/3 通过。
  - M4（裸 bookUrl 自愈选项）：保留原「只移植 headers」的保守兜底，同时新增 `transplantRuleOptions()` 支持移植无未渲染占位符的完整选项（含 method/body）。动态选项明确拒绝：纵横中文网的 body 是 `bookId={$.bookId}`，裸 URL 本身没有 bookId，无法安全反推，必须依赖 `preciseSearchWithRetry` 返回完整结果；这是安全边界而非漏修。目标断言（静态 POST、动态拒绝、headers 回退）通过。
  - 回归：`node --check` 两个服务均通过；M1 双服务原始 HTTP 向量通过；M2–M4 针对性断言 8/8；`.scratch/verify-shelf-page-sync.mjs` **14/14 PASS**；7788 / 7789 已重启并保持监听。
- **2026-09-20**：修复「关闭服务时丢最近配置」。
  - 根因：`saveConfig()` 是 200ms 防抖写盘；旧关闭脚本直接 `taskkill /f`。Windows 强杀等于 `TerminateProcess`，不会触发 SIGINT/SIGTERM，防抖队列里的设置/进度还没写盘进程就没了。
  - 修法：`Reader/server.mjs` 与 `阅读器/server.mjs` 均新增 `flushConfigNow()`（清防抖计时器 + 同步写配置）；`shutdown()` 统一先刷盘再关连接池/浏览器/HTTP 服务；补 SIGINT、SIGTERM、SIGHUP、SIGBREAK；新增 `POST /api/shutdown` 给 Windows 脚本可靠调用，并限制 Origin 为同源（curl/bat 无 Origin 可用，外部网页跨站请求 403）。
  - 脚本：`关闭Reader.bat` / `关闭阅读器.bat` 改为 curl 调 `/api/shutdown` → 最多等 5 秒端口释放 → 仍占用才 `taskkill /f` 兜底；等待用 `ping`，不依赖控制台交互输入。
  - 实测：7788 与 7789 都是「POST `/api/settings` 改字号 → 立即执行关闭脚本」；两边的测试字号均成功写入 `reader.config.json`，端口释放；测试值随后已恢复为原值。`node --check` 两个服务端均通过。
- **2026-09-20**：`tocMem` / `contentMem` 加 LRU 上限，修复内存只增不减。
  - `tocMem`：目录内存缓存，原无上限。每本几百章（标题+URL）约 25~50KB，书架几十本即数百 MB，重启前不释放。现上限 **200 本**，按 Map 插入序淘汰最久未读的那本。
  - `contentMem`：正文章节内存缓存，原无上限。每章 10~30KB，连读几百章同样不释放。现上限 **500 章**，翻回旧章自动从磁盘回填。
  - 实现：`lruTouch(map,key)` 读命中时 delete+set 把条目移到 Map 末尾（最近用）；`lruSet(map,key,val,max)` 写入后 while 超上限删 Map 第一个 key（最久未用）。`dropContentCache` 的前缀删除、`clearContentCache` 的 clear 均不受影响。
  - 验证：LRU 断言 5/5（上限淘汰、读刷新保序、前缀删除、clear、未命中）；语法 `node --check` 通过；回归 `.scratch/verify-shelf-page-sync.mjs` **14/14 PASS**。
- **2026-09-20**：修复「清缓存后打开松鹤阅读的书显示目录为空」（历史记录 bookUrl 丢失 URL 选项）。
  - 现象：用户在设置里清了一次缓存，再打开书架上的《末日乐园》（👕松鹤阅读），正文区显示「目录为空」和「换源 / 重试」；重新加入书架也无效（`/api/online/shelf/add` 按书名+作者去重会命中那条坏记录）。
  - 排查过程：先确认规则引擎、`AnalyzeUrl`、`getAbsoluteURL`、`/api/online/search`、`/api/online/shelf/add` 全都正确保留 `,{...}` URL 选项 —— 说明不是代码在写的时候丢的，而是**历史版本已经落盘的数据就是坏的**。实测源站行为：`GET https://bookshelf.html5.qq.com/qbread/api/novel/intro-info?bookid=1100505099` 不带 Referer → 返回 `incorrect referer`（17 字节）；带 Referer → 正常 JSON。于是链路闭合：bookUrl 缺 Referer → 详情接口回错 → `$..resourceID` 取空 → `tocUrl` 模板渲染成 `...all-chapter?bookId=`（空参）→ 目录恒为空。书架 18 本中坏记录只有松鹤阅读 3 本里的 2 本（《末日乐园》《玄鉴仙族》），《西游，我体内有九只金乌》是好的，速读谷² 5 本 `bookUrl` 本来就不带选项。
  - 修法 1（`Reader/server.mjs` 约 L1168）：`sourceBookUrlHasOption(s)` 判断书源 `ruleSearch/ruleExplore.bookUrl` 模板本来就该带 `,{...}`，作为「这是历史坏记录」的前置判据 —— 没这个判据就不能乱补，很多源的 bookUrl 本来就不带选项。
  - 修法 2（约 L1194）：`transplantRuleHeaders(s, bookUrl)` 兜底修复 —— 从书源规则（`ruleSearch/ruleExplore/ruleBookInfo` 的 `bookUrl/tocUrl`）里把**写死的 `headers`** 移植到裸 bookUrl 上；跳过含未渲染 `{{...}}` 的选项，且只搬 `headers` 一项（`@js` / `body` / `method` 等跟具体请求强绑定，乱搬会出错）。
  - 修法 3（约 L1230）：`needsUrlOptionHeal(origin, bookUrl, tocUrl)` 三条件同时成立才算历史坏记录：① 书源规则本该带选项 ② bookUrl 裸 ③ tocUrl 也裸。第三条是关键 —— 一旦 tocUrl 已带上选项就说明这条记录修过了，不能再触发，否则每次打开书都白跑一次精确搜索，越读越慢。
  - 修法 4（约 L1244）：`healLegacyBookUrl(origin, bookUrl, name, author)` 等价于 legado `WebBook.preciseSearchAwait` —— 先按书名+作者精确搜一次，取搜索结果里那条自带 `,{...}` 的 bookUrl；拿不到就退回 `transplantRuleHeaders()`；异常也走兜底。结果记进 `bookUrlHealCache`（`origin|裸bookUrl` → 修复后 URL，修不好记空串），同一条记录只修一次。
  - 修法 5：三处接入 —— `ensureBookInfo()`（重抓前先自愈，用 `requestUrl` 发详情请求；解析失败保护从 `!info.tocUrl || info.tocUrl === bookUrl` 换成 `isDegenerateTocUrl(info.tocUrl, requestUrl)`，能识别空参数）、`fetchTocForBook()`（触发重抓的条件加 `|| needsUrlOptionHeal(...)`）、`/api/online/book`（触发 `ensureBookInfo` 的条件同上）。
  - **设计决策**：自愈只改「本次请求实际用的 URL」，**不写回书架记录**。bookUrl 是前端 rel、阅读进度 key、目录与正文缓存 key 的组成部分，就地改写会把正在读的这本书的状态全部打乱；legado 里 `Book.bookUrl` 也始终是「url,{jsonOption}」明文形态，只在 `AnalyzeUrl` 消费时才切分。
  - 实测：`node --check` 通过；重启 7788 后 —— 《末日乐园》`/api/online/chapters` **2654 章**、`/api/online/content&index=0` 3267 字正文（「第 1 章 灰姑娘的恐惧」）；《玄鉴仙族》**1643 章**（修复前报「目录为空」）；《西游，我体内有九只金乌》1270 章正常；七猫《斗破苍穹》`tocUrl` 仍带选项、未被误触发；速读谷²《盘龙》`ok=true`、未被误触发。**用户原始路径完整复现通过**：注入 `tocUrl=...bookId=` 空参 + 重启 + 打开 → 目录 2654 章、正文 3267 字，落盘 `tocUrl` 自动补回 `bookId=1100505099`；走真实「清缓存」接口（`POST /api/online/cache/clear`，释放 5016139 字节）后再打开 → 打开 4ms、目录 1274ms / 2654 章、正文 172ms / 3267 字。第二次打开走缓存 40ms → 2ms，自愈只跑一次。回归 `.scratch/verify-shelf-page-sync.mjs` **14/14 PASS**。
- **2026-09-20**：修复「刷新后左侧书架分页回退到第 1 页」+「新加入书架的书条目不显示『读到 / 最新』」+「正文与书架栏不一致」。
  - 现象：从发现页 / 搜索结果点阅读加入一本新书，左侧书架条目有时只有书名，「读到 第 N 章」「最新 第 M 章」两行要手动刷新书架才出现；按 F5 刷新页面后正文还是原来那本书，但左侧书架栏回到第 1 页，用户看不到自己在读的那本；用户诉求是**正文读哪本书，左侧书架栏就必须显示包含那本书的那一页并高亮**。
  - 根因 1（缺「读到 / 最新」）：书架条目这三个字段不是前端本地算的，而是 `/api/online/shelf`（`Reader/server.mjs` 约 L2761-2796）遍历 `config.online.books` 时用 `readTocCache(b.origin, b.bookUrl)` 现算的 —— 目录缓存还没落盘时三字段为空。`openBook()` 抓到目录后虽然调了 `onlineTocCachePut()` 并 `renderBooks()`，但 `state.online.books` 里那条仍是加入书架时的旧对象，没有重新拉 `/api/online/shelf`，所以前端 `el_onlineBook()` 里 `readTitle` / `lastTitle` 都空、整行不渲染。
  - 根因 2（刷新回第 1 页）：`enterMode()` 的 online 分支写死 `state.bookPage = 1`；`initOnline()` 恢复上次阅读时只调 `openBook(b)`，**全程没有调用 `syncShelfPageToBook()`**，于是正文恢复、分页丢失。只有从搜索/发现点阅读那条路径（`readOnlineBook()`）才调了分页同步，所以「点阅读没问题、刷新就回第 1 页」。
  - 根因 3（翻页生硬 / 慢）：`readOnlineBook()` 原来是先 `await openBook()`（可能要抓几十秒目录）再翻页，抓目录期间左侧书架一直停在旧页，用户观感就是「没定位」。
  - 修法 1（`Reader/public/online.js`，`enterMode()` 约 L149-163）：`renderBooks()` 之后补 —— 正文在读的在线书存在时立刻 `syncShelfPageToBook(cur)`，切模式/刷新后立即校分页。
  - 修法 2（`Reader/public/online.js`，`openBook()` 抓到目录后约 L1635-1647）：调完 `onlineTocCachePut()` 后 `await refreshOnlineShelf()` 重拉书架，再 `findOnlineByRel(rel)` 取新对象 `Object.assign(online, fresh, { rel })`（不能继续用旧引用，它的 `durChapterTitle` / `latestChapterTitle` 还是空的）。
  - 修法 3（`Reader/public/online.js`，`readOnlineBook()` 约 L2687-2695）：`openBook` **之前**先 `syncShelfPageToBook(target)`（抓目录慢时左侧立刻到位），`openBook` 之后再校一次（那会儿 `bookPerPage` 可能已按新窗口高度重算）。
  - 修法 4（`Reader/public/online.js`，`initOnline()` 约 L6446-6456）：`syncShelfPageToBook(b)` 先校一次，`openBook(b).then(() => syncShelfPageToBook(findOnlineByRel(lastRel) || b))` 再校一次。
  - 修法 5（`Reader/server.mjs`，`fetchTocForBook()` 约 L2988-3020）：对齐 legado `BookChapterList.updateBookTocInfo()`（BookChapterList.kt:171-176）—— 目录抓完立刻把「章节总数 / 读到 / 最新」写回书架条目并 `saveConfig()`，不再等下一次 `/api/online/shelf` 现算；同时按 legado 语义更新 `lastCheckCount` / `latestChapterTime`。
  - 实测：`node --check` 两个文件通过；服务重启后 7788（PID 61244）代码生效；新增只读回归脚本 `.scratch/verify-shelf-page-sync.mjs`（真实 Edge + CDP，`Fetch.enable` 拦断 `/api/online/content*` 与 `/api/online/progress`，绝不写用户进度）—— **14/14 全部 PASS**：目标书《永不独行！》17/17 位、共 3 页 → 刷新后停在第 3 页（显示 `3 / 3 · 17 本`）、目标书高亮且确实渲染在当前页、连续刷新分页稳定、抓完目录后书架条目与服务端接口都补齐「读到 第 1 章 杜安」「最新 第 273 章 崩盘」、`totalChapterNum=274`。
- **2026-09-20**：修复换源残留坏记录导致的正文 `EISDIR`（《末日乐园》手动换源后打不开）。
  - 现象：从「🪽松鹤庭沐」加入书架的《末日乐园》手动换源到「👕松鹤阅读」，正文区报 `章节加载失败：EISDIR: illegal operation on a directory, read`。
  - 根因链（完整确认）：① `doChangeSource()` 换源时只插新记录、没删旧记录，书架留下两条同名同作者的《末日乐园》—— 索引 13（`order=1789827254757`，**坏的**）`tocUrl=https://bookshelf.html5.qq.com/qbread/api/book/all-chapter?bookId=`（`bookId` 为空）、无 `totalChapterNum`；索引 14（`order=1789847273947`，**好的**）`bookId=1100505099`、`totalChapterNum=2654`。② 点阅读时 `/api/online/shelf/add` 按「书名+作者」去重，命中的是坏的那条。③ 前端 `chapterUrl()` 因 `tocUrl` 退化 → `/api/chapter?rel=`。④ 服务端 `safeJoin(shelfRoot(0), "")` 得到书架根目录 → `readFileSync(目录)` 抛 `EISDIR`。
  - 修法 1（`Reader/server.mjs`，`isDegenerateTocUrl()` 约 L954）：新增「URL 查询参数为空」判定，能识别 `bookId=` 这类模板变量未替换成功的坏 URL；注释说明速读谷² 这类 `tocUrl === bookUrl` 是正常形态，由调用方配合 `readTocCache()` 判断。
  - 修法 2（`Reader/server.mjs`，约 L1067）：新增 `bookRecordScore()`（tocUrl 非坏 +100、有 `totalChapterNum` +50、有 `latestChapterTitle` +10、有封面 +5、有简介 +3、有 variable +1）、`sameBookMeta()`、`dedupeOnlineBooks()`（同名同作者只留分数最高那条，保留 `Math.min(order)` 维持书架位置，被删那条有进度且保留那条没有时才搬迁进度，同时清 toc/content 缓存）；`repairAllOnlineBooks()` 末尾追加调用，启动时自动清理。
  - 修法 3（`Reader/server.mjs`，`/api/online/shelf/add` 约 L2799）：去重由「取第一条命中」改为「多命中按 `bookRecordScore` 降序取最优」。
  - 修法 4（`Reader/server.mjs`，`doChangeSource()` 约 L1835）：新增 `oldMatches` 判据（精确命中 `findOnlineBook` OR `normalizeBookUrl(x.bookUrl) === oldBookUrl` OR `sameBookMeta` 书名+作者兜底）、`oldName` / `oldAuthor` 从 `body` 或 `nb` 取；删除逻辑改为把 `oldDupes` 全部清掉（换源后 `bookUrl` 变了，旧记录会变孤儿，而 `/api/online/shelf/add` 按书名+作者去重会选中孤儿）；进度清理改为「`oldDupes` 里非 `oldKey` 的直接删，`oldKey` 最后统一删」。
  - 修法 5（`Reader/public/online.js`，`swapTo()` 约 L2709）：请求 `body` 补传 `oldName` / `oldAuthor`，让服务端能按书名+作者兜底匹配旧记录。
  - 实测：`node --check` 两个文件通过；服务重启（PID 31376，端口 7788）启动日志输出「清理书架重复记录：《末日乐园》👕松鹤阅读（保留 👕松鹤阅读）」；书架 18 → 17 本；`GET /api/online/shelf` 中《末日乐园》只剩 1 条，`tocUrl` 含 `bookId=1100505099`、`totalChapterNum=2654`；`GET /api/online/book` `ok=true chapterCount=2654`；`GET /api/online/chapters` 2654 章（首章「第 1 章 灰姑娘的恐惧」、末章「大家好我来开奖了！」）；`GET /api/online/content&index=0` 3267 字正文正常；CDP 真实浏览器端到端（`.scratch/verify-moleread.mjs`）书架只有 1 条《末日乐园》、`openBook` 后 `bodyLen=3199`、`hasEisdir=false`、`isEmpty=false`、网络请求全部 200、无 `/api/chapter` 调用（截图 `.scratch/eisdir-fixed-2.png`）。
  - 附带结论：用户怀疑的「书源本身没有结果返回」不成立。已实测松鹤阅读目录接口 `GET .../all-chapter?bookId=1100505099` → 200 / 212844 字节 / 2654 章，正文接口 `POST https://novel.html5.qq.com/be-api/content/ads-read` → 200 / 3813 字节；只有空 `bookId=` 才返回 422 `{"ret":422,...,"message":"Validation Failed, code: 422",...}`。真实原因就是换源残留坏记录被去重逻辑选中 + 本地路径退化到书架根目录。
- **2026-09-20**：点「阅读」/ 换源后，左侧书架栏自动翻到目标书所在的那一页。
  - 触发点：从发现页或搜索结果点「阅读」时，正文区确实换了新书，但左侧书架栏还停在原来那一页（或第一页），书在架子上却看不到高亮，用户以为「没加进去」。这与书架已有 12~15 本、一页只显示 6 本的分页设计直接相关。
  - 对照 legado：`BooksFragment.kt`（L134-157）里书架是 `RecyclerView` + `keepScrollPosition`，条目插入/刷新**不得**动滚动位置，只有显式操作（点击跳转）才 `scrollToPosition`。我们这边是分页列表，页码必须自己算 —— 等价语义是「阅读动作 = 显式跳转」，所以要翻页。
  - 修法：`Reader/public/online.js` 新增 `syncShelfPageToBook(b)`：先 `renderBooks()`（`bookPerPage` 依赖窗口高度，切模式后可能是旧值）→ `visibleBooks()` 找目标下标（与界面顺序一致，含筛选/排序）→ 若被书架搜索框过滤掉就先清 `state.filter` 与 `#bookFilter` 再找 → 找不到直接 return（不强行改分页）→ `page = floor(pos / per) + 1`，与当前页不同才改 `state.bookPage` 并重绘。
  - `readOnlineBook()`：原来只关 `panelSearch`，改为 `closePanels()`（搜索 / 书源 / 发现 / 替换 / 调试 / 详情 / 换源 / 发现结果 / 存储弹窗一起收）；切模式由 `setMode("online", { silent: true })` 改为 silent 后再 `await enterMode()` —— silent 不走 `enterMode()`，`state.books` 会停在本地书形状、`bookPerPage` 也可能是旧值，导致页码算错。
  - `swapTo()`：在 `await openBook(target, { keepChapter: false })` 之后同样调用 `syncShelfPageToBook(nb)`。后端换源是「删旧插新」，新书会排到书架末尾，不同步的话左侧还停在旧书那页。
  - 实测（`.scratch/verify-shelf-sync.mjs`，CDP 直连真实页面主 world）：书架 15 本 / 共 3 页，目标书 `永不独行！`（🌑速读谷²，第 15 位）；跳转前 `1 / 3`，跳转后 `page=3`、`activeCount=1`、`activeText=永不独行！`，`panelExplore / panelExploreResult / panelSearch / panelBookInfo` 全部 hidden。`node --check online.js` 通过。
- **2026-09-20**：大书解析提速 —— `/api/book` 的章节标题净化从「逐条 `vm` 调用」改为「整批一次调用」，两个阅读器同步。
  - 触发点：书架冷启动优化后，打开大书时 `/api/book` 仍要 897~1675ms，成为首屏之后最大的一块等待。
  - 定位手法：`阅读器/.scratch/profile-book.mjs` 逐段剖析 + `bench-timeout.mjs` / `bench-parts.mjs` / `bench-batch.mjs` 对照实验。5290 个标题的实测：原实现 616ms、**去掉 `timeout` 参数 150ms**、整批一次执行 + 一次 `timeout` **49ms**。
  - 根因：`vm.runInContext` 每带一次 `timeout` 就挂一个中断看门狗，固定开销约 113µs；乘上 5290 章 ≈ 600ms。**不是脚本慢，是看门狗收费。** 对照 legado：超时是**整条规则一个 deadline**（`RegexExtensions.kt` 里 `select { job.onJoin / onTimeout }` 包住整个 matcher 循环），原实现按「每个匹配点单独计时」，比 legado 更碎、更慢。
  - 修法 1（`阅读器/src/replace-engine.mjs` + `Reader/src/replace-engine.mjs`，两文件 hash 一致）：新增 `replaceManyWithRule(o)` —— 接收 `o.texts` 数组（可选 `o.chapters` / `o.books`），返回等长数组，`null` 表示该条失败。内部 `JS_BATCH_SCRIPT` 在一次 vm 调用里循环 eval 全部输入，每条仍用 `(function(){ return eval(__code); })()` 保持独立函数作用域，与 legado「每个匹配点一次 eval」语义一致；`JS_BATCH_CHUNK = 256` 分块执行。
  - 安全阀：含 `java` 的脚本自动退回逐条（`java.put/get` 状态是每条一份，跨条共享会串状态）——实测当前 5 条 `@js` 规则 bare-java 命中数全为 0，不走此路径；某块批量超时后 `batchUsable = false`，剩余块直接逐条；整批超时 → 退回逐条；逐条再超时 → 抛 `RegexTimeoutError`，由调用方按 legado `BookChapter.getDisplayTitle` 语义把该规则 `isEnabled = false` 落库。
  - 修法 2（两个 `server.mjs`）：新增 `applyTitleRulesBatch(titles, bookName, origin)`，按规则顺序批量净化、结果非空才采纳、单条规则超时即禁用并 `saveConfig()`；`localDisplayChapters()` 改为「先收集全部标题 → 一次批量净化 → 回填」。
  - 实测（冷解析，重启后逐本请求）：**7789** `末世神魔录` 36.3MB/5290 章 975ms → **247ms**；`末世庇护所` 30.7MB 283ms；`无限进化` 26.1MB 174ms；`冰封末世` 23.2MB 176ms；其余 111~186ms。**7788** `踏星` 51.7MB/5597 章 1102ms → **453ms**；`守卫者之星际狂飙` 39.0MB/5797 章 389ms；`重生之星空巨蚊` 41.2MB 277ms；`进化的四十六亿重奏` 35.9MB 269ms；`修真四万年` 34.2MB 188ms；`招黑体质` 29.7MB 204ms；`希灵帝国` 24.2MB 116ms。热命中 9~17ms。
  - 正确性对照：`阅读器/.scratch/verify-batch-equivalence.mjs`（21 条规则 × 全部标题类型，4236 项，**0 差异**）、`verify-batch-edge.mjs`（16 项边界：捕获组 `$1`、命名组 `${num}`、`$$`、反斜杠、js 返回 null/undefined/抛错、空匹配、`chapter` 绑定、`java.put`、字面量、病态规则抛 `RegexTimeoutError`，**ALL PASS**）、`verify-realbook-titles.mjs`（真实 5290 标题批量 vs 逐条，**0 差异**）、`verify-timeout-semantics.mjs`（病态规则 622ms 抛 `RegexTimeoutError`，PASS）。
  - 回归：`verify-bookshelf-snapshot.mjs` 10/10、`verify-clear-cache-safety.mjs`（Cookies/localStorage 均保留）、`verify-idle-cleanup.mjs` 8/8、`verify-reading-after-cache-change.mjs` 5/5、`verify-open-latency.mjs` 7/7。
  - 线上抽查：7789 `末世神魔录` 目录 5290 章、首章 `第 0001 章 大雾，车祸`、末章 `第 5298 章 最终的选择！【全书完】`；7788 `踏星` 5597 章、首章 `第 1 章 陆隐`、末章 `第 5590 章 欢迎回家`（两个项目各自启用的互斥数字标题规则不同，符合预期）。
  - 次瓶颈（本轮未处理）：Reader 书架里几本放在 USB 移动硬盘上的书，冷读文件本身占 361~636ms（`修真四万年` / `招黑体质` / `希灵帝国`），标题净化已降到 27~100ms；如需继续可考虑后台预热。
- **2026-09-20**：修复「每次重新打开阅读器，书架里的书都要重新等加载」。根因是书架在 USB 移动硬盘 + Windows 20 分钟硬盘休眠，服务重启后内存缓存必空、首次列书架要等磁盘唤醒与全目录扫描。
  - 实测根因链：`Get-Partition -DriveLetter D | Get-Disk` → `BusType=USB`（WD2500，233GB HDD）；`powercfg` → 「在此时间后关闭硬盘」交流 `0x4b0` = 1200 秒；`D:\小说\D-末日生存`（7789，227 本）、`D:\小说\B-高武未来`（7788，401 本）都在该盘。
  - 时间线（修复前，`阅读器/.scratch/probe-coldstart.mjs`）：服务端口就绪 78~107ms、`/api/state` 5ms、`/api/books` 服务预热后 19~29ms，但冷进程第一次列书架要等磁盘唤醒；浏览器真实「书架首本出现」130ms（冷 profile）/54ms（热）。另外 `/api/book` 解析 36MB 大书要 897~1675ms，是首屏之后最大的一块（本次未改，因为属于打开书籍而非列书架）。
  - 修法（`Reader/server.mjs` + `阅读器/server.mjs` 同一套）：新增 `BOOKLIST_SNAPSHOT_DIR = <cache>/booklist`、`BOOKLIST_SNAPSHOT_MAX_AGE = 7 天`、`snapshotFileOf(root)`（sha1(小写绝对路径) 前 16 位 + `.json`）、`readBookSnapshot` / `saveBookSnapshotSoon`（400ms 防抖落盘）/ `dropBookSnapshot` / `revalidateBookList`（后台重扫，`revalidating` 防重入）/ `listBooksWithMeta(root, opts)` 返回 `{ books, stale }`，`opts.fresh` 强制真扫；原 `listBooksUncached` 逻辑与 `BOOK_SCAN_CONCURRENCY = 64` 不变，`listBooks` 保留为兼容包装。
  - 路由：`/api/books` 改用 `listBooksWithMeta` 并返回 `stale`；`stale` 时不写 `config.shelves[i].count`（避免旧数量覆盖真值）。`/api/shelves/remove` 增加 `dropBookSnapshot(...)`；`Reader` 的 `/api/shelves/add` 用 `{ fresh: true }` 保证新导入的书立刻出现。
  - 前端：`Reader/public/app.js` 与 `阅读器/public/app.js` 的 `selectShelf()` 在收到 `stale:true` 时，1.2s 后静默重拉一次，只有数量变化才重绘（不打断用户操作、不闪屏）；`阅读器` 冷启动且列表为空时先显示「正在读取文件夹…」占位。
  - 独立验证（`阅读器/.scratch/verify-bookshelf-snapshot.mjs`，独立端口 7799，**10/10 PASS**）：第 1 次启动端口就绪 99ms、首次列书架 29ms（227 本，`stale=false`）；第 2 次启动端口就绪 97ms、首次列书架 **4ms**（227 本，`stale=true`），后台重扫 18ms 后 `stale=false`；快照确实落在项目 `.cache/booklist` 下。
  - 浏览器端实测（`.scratch/probe-reader-shelf-timeline.mjs`，独立端口 7798 + 独立 CDP 9334 + 临时 profile）：7788 冷 profile 书架首本 **106ms**、同 profile 二次 **30ms**；7789（`.scratch/probe-page-timeline.mjs`，端口 7799）：冷 profile 书架首本 **95ms**、二次 **24ms**。
  - 线上实测：7789 冷启动首次 `217ms / 227 本 / stale=true`，随后 3~19ms；7788 重启后首次 `185ms / 401 本 / stale=true`，3 秒后 `4ms / stale=false`。两处错误日志为空。
  - 兼容性：缓存清理接口（`/api/online/cache/clear`、`/api/online/webview/cache/clear`）只动 content/toc/explore/webview，**不会删书架快照**；快照文件损坏或超 7 天会当作未命中，退回真扫，不会影响阅读。
- **2026-09-20**：WebView 缓存从「事后清理」推进到「源头少产生 + 用完收摊」，阅读链路回归通过。
  - 实测构成：单次打开番茄登录页，`Default/Cache` 就落盘 37.6~41.6MB，是唯一量级大头；`Default/Code Cache` 0.05~0.08MB、GPU/Shader 各约 0.5MB。
  - 对照实验（`.scratch/bench-webview-cache.mjs`）：现状 256MB 软上限 37.6MB；降到 8MB 软上限 31.4MB（压不住）；关掉一批 Edge 功能模块（`--disable-features`）49.38→49.00MB（几乎无效）。结论：`--disk-cache-size` 与 `--disable-features` 都压不住大头，Chromium 不会因为上限小就主动淘汰，只能主动回收。
  - 缺陷 A：`Network.clearBrowserCache` 之前发在 browser 级连接上，实测报 `'Network.clearBrowserCache' wasn't found`，命令被静默丢弃 —— 之前「关窗清缓存」的代码从未生效，磁盘一个字节没少。该命令只能发在 page session 上。修法：新增 `_clearHttpCache()`，临时建 `about:blank` target → attach → `Network.enable` → `clearBrowserCache` → 关掉临时 target。实测 41.60MB → 0.78MB；「所有窗口都关掉后新建临时 target」场景同样有效（0.82MB）。
  - 缺陷 B：`closeAll()` 里直接 `proc.kill()` 强杀，而 `stop()` 第一步就调它，导致后面的 `Browser.close` 成死代码。实测强杀会丢刚写入的 LocalStorage（Cookies 即时落盘所以还在），表现就是「刚登录完重启就掉登录」。修法：`stop()` 改为 `_closeTabs()`（逐个关标签并同步 Cookie）→ `Browser.close` → 超时才 SIGKILL 兜底；`closeAll()` 同样先优雅退出、1.5s 后再兜底。
  - 缺陷 C：`open()` 与 20s 空闲收摊存在竞态 —— 关掉最后一个窗口后用户马上再点登录，`_openTab()` 内部多个 `await` 期间 `tabs.size` 还是 0，清理逻辑会误判「没人在用」把新窗口一起关掉（表现「点登录没反应」）。修法：新增 `_opening` 计数器 + `_cancelIdleCleanup()` / `_inUse()` / `_stopping` 标志。
  - 策略：`clearCacheOnClose`（默认 true）+ `idleStopMs`（默认 20000）—— 关掉最后一个窗口后留 20s 宽限，用户马上重开时进程还热着、不会觉得慢；真走了就退出并回收。`TRANSIENT_CACHE_PATHS`（11 项，关窗即清）与 `REGENERABLE_CACHE_PATHS`（33 项，只在手动清理时回收）分开：Edge 组件 / 模型缓存已由启动参数禁止增长，避免每次重开都重新下载。
  - 实测（`.scratch/verify-idle-cleanup.mjs`，8/8 PASS）：关窗后 tabs 为空、宽限期内进程存活、收摊后进程退出、HTTP 缓存 37.65→0.00MB、Code Cache 目录已删、Cookies 5→5 条、探针 Cookie 仍在、LocalStorage 探针 `keepme` 仍在。
  - 线上实测（`.scratch/verify-live-idle-cleanup.mjs`，对运行中的 7788）：开窗前 Cache=0.00MB / LocalStorage=107.3KB / Cookies=49152B → 加载后 7.14MB → 收摊后 0.00MB；LocalStorage 107.3KB 未减少、Cookies 文件仍在、残留窗口 0。
  - 阅读回归（`.scratch/verify-reading-after-cache-change.mjs`，5/5 PASS）：书架可读 books=11；盘龙目录 ok=true n=846；第 1 章正文 len=8118；第 401 章正文 len=4056；搜索 found=413。
  - 使用性回归（`.scratch/verify-reopen-race.mjs`，9/9 PASS）：关掉第一个窗口后 tabs 为空且进程仍存活（宽限期内重开不用等冷启动）→ 宽限期内立刻重开成功且窗口没被误杀 → 重开后过完整宽限期仍存活（确认收摊已被取消）→ 真正关掉后进程退出、HTTP 缓存回到 0.00MB、Cookies 文件仍在（32768B）。
  - 开窗延迟回归（`.scratch/verify-open-latency.mjs`，7/7 PASS）：冷启动 1082ms；关窗后宽限期内重开 **58ms**（热进程，用户几乎无感）；收摊后冷启动重开 965ms，仍然可用。
  - 为什么不影响阅读：正文 / 目录 / 搜索 / 换源全部走 Node 请求池（`book-pool.mjs` + 内置 HTTP 客户端），浏览器只用于 `java.startBrowser`、登录弹窗、评论区 iframe；「用完收摊」只回收 HTTP / 代码 / GPU / Shader 缓存，不动 Cookies / Local Storage / IndexedDB / Storage / Preferences。
  - 备注：删浏览器缓存目录前必须确认进程已退出（Windows 文件句柄）；`Default/Sessions`（会话恢复）保持保守保留，不在关窗清理白名单内。
- **2026-09-20**：WebView（登录内置浏览器）缓存拆分与安全清理上线，已实测。
  - 现状盘点：`Reader/cache/webview` 693.5MB / 2218 文件。其中 `Default/Cache` 235MB、`component_crx_cache` 178MB、`ProvenanceData` 169MB、`Default/Code Cache` 28MB、`Edge Wallet` 14MB、`Subresource Filter` 12MB、`Edge Entity Extraction` 10MB 等属于纯可再生缓存；`Default/Network/Cookies`（68 条，含 .fanqienovel.com×30、.bing.com×15、m.elkoparts.info×9）、`Local Storage`、`IndexedDB`、`WebStorage`、`Storage`、`Preferences`、`Local State`、`Service Worker/Database` 是登录态载体，必须保留。
  - 代码：`src/browser-host.mjs` 增 `REGENERABLE_CACHE_PATHS` 白名单 + `dirBytesSync` / `METRICS_FILE_RE` / `cacheStats()` / `clearRegenerableCache()` / `async stop(timeout)`；`_launch()` 增 `--disk-cache-size=268435456`、`--media-cache-size=67108864`、`--disable-background-networking`、`--disable-component-update`、`--disable-sync`、`--no-pings`、`--disable-breakpad`、`--disable-crash-reporter`。`server.mjs` 的 `cacheStorageInfo()` 增 webview 明细，新增 `POST /api/online/webview/cache/clear`（先 `stop(8000)` 释放句柄再删）。前端 `index.html` / `online.js` / `online.css` 增按钮、明细标签与确认弹窗。
  - 实测（7788 正式服务）：清理前 693.5MB / 68 Cookie → 接口返回 `ok:true, freedBytes:705297081, removed:33, failed:[]` → 剩余 20.8MB。`Cookies`（68 条，SHA256 `078AA056…21DC6` 未变）、`Preferences`、`Local State`、`Local Storage`、`IndexedDB`、`Storage`、`Service Worker/Database`、`cache/login-state.json` 全部原样。
  - 回归：清理后重新拉起 Edge，`Network.getCookies` 仍取到番茄 `sessionid` / `sid_guard` / `passport_auth_status` 等，登录态无需重建；`host.stop(8000)` 后进程正确退出，无残留。
  - 备注：`Default/Sessions`（会话恢复数据）已在最后一轮从白名单移除，改为保守保留。
- **2026-09-19**：修复「桌面搜索比手机 legado 少很多结果」+ 搜索翻页收口。
  - 现象：搜索《我的星空武道》时手机 legado 出 11 条，桌面只出 1 条，统计条还写着「作者过滤 182 本」。
  - 根因：`Reader/src/book-pool.mjs` 的 `searchAll()` 在**普通搜索**里也按 `author` 做全局硬过滤（`if (author && !changeSource) merged = merged.filter(...)`），把 173 本里 172 本直接丢掉。核对 `.research/legado-master`：普通搜索 `SearchModel.startSearch()` 只用 `key + page`，filter 是拿同一个 key 去比 name/author/kind（`app/src/main/java/io/legado/app/model/webBook/SearchModel.kt:104-110`），**没有按作者做全局过滤**；作者过滤只属于换源（`ChangeBookSourceViewModel` 的 `fName == name && (!checkAuthor || fAuthor.contains(author))`）。
  - 修法：`book-pool.mjs` 普通搜索不再丢结果，只把作者命中的书提到前面（排序，不删除）；`changeSource` 换源模式保持原逐本过滤不变。
  - 现象 2：结果没到底时「下一页」也能点，点进去是空的。根因：`Reader/public/online.js` 的 `renderSearchPager()` 用 `canNext = page < 200`，注释里说「实际由 hasMore 提示」但没接上。
  - 修法：`canNext = page < 200 && searchState.hasMore === true`，到底时显示「已全部加载」；并新增「加载全部」按钮（`loadAllSearchPages()`），顺序翻页直到 `hasMore=false`、或某页不再带来新书、或到达 20 页上限，过程中可随时点「停止」。同时给 `doSearch()` 加返回值（`ok` / `aborted` / `empty` / `error`）让自动翻页能识别中断。
  - 说明：legado 本体就是懒加载分页（`SearchActivity` 滚动到底且 hasMore 才 `searchPage++`，每页仍要向各书源发一次请求），所以「翻页会再请求书源」是预期行为；本次修的是「结果被作者过滤掉」和「没到底却还能翻」。
  - 实测（`PORT=7790` 临时实例，未影响正式服务）：`POST /api/online/search` `{key:"我的星空武道",author:"小道白霜"}` → `books=173 filtered=0`，首条正是《我的星空武道 / 小道白霜》；`changeSource=true` 仍为 `books=1 / origins=4`（换源语义未回归）；第 2~4 页各返回 194/198/199 本且 `hasMore=true`（光遇聚合这类源不分页，回全量）。`node --check` 两个文件均通过。
- **2026-09-19**：本地阅读器（阅读器/）同步收口 + 规则反转验证 + exe 出包验证。
  - 反转验证（headless Edge，`.scratch/verify-reader-reversal.mjs`）：打开《21世纪的死灵法师》，新增一条「。→。※」替换规则后正文出现 26 处标记、长度 2174→2200，删除该规则后正文/目录/章标题与基线逐字节一致；再只留一条自定义 TXT 目录规则（replacement 追加【T校验】），正文标题「第 2 章 聚餐【T校验】」与右侧目录「前言【T校验】/第 1 章 …【T校验】」同时生效，删除并还原 12 条启用态后同样逐字节恢复。收尾清点：净化 21 条、目录 26 条（启用 12），期间无控制台异常或未捕获异常。
  - exe 打包脚本修复：`build/build-exe.mjs` 仍按旧版 `server.mjs` 锚点做精确替换，接入规则引擎后已失效（`server.mjs 的 import 块` 命中 0 次）。本次补齐：内联 `src/java-regex.mjs`、`src/replace-engine.mjs`、`src/txt-toc-rules.mjs`（各自包 IIFE 避免同名符号冲突），`replace.js` 与两份内置规则 JSON 作为 SEA assets 嵌入，并给 `fs.readFileSync` 加 ENOENT 回退从内联资源读规则。
  - exe 实测：`node build/build-exe.mjs` 通过（rcedit 下载失败仅跳过图标，不影响产物），`dist/LocalReader.exe` 以 `PORT=7791`、独立数据目录启动，`/api/replace-rules` 21 条（启用 6）、`/api/txt-toc-rules` 26 条（启用 12）、`/replace.js` 200；headless Edge 打开面板两个 Tab 正常、无控制台异常。
  - 阅读器 `README.md` 补充「替换净化 / TXT 目录规则」章节与目录结构说明。测试服务用 7790 / 7791，未触碰用户 7788 正式服务。
- **2026-09-19**：书源组2 全部禁用排查与恢复，并收口本轮 UI 调整。
  - 用户确认现象：书源组2 的 17 个书源显示「启用 0」，但书架里的书仍可正常打开、翻章，且并非缓存。根因分两部分：书架/阅读路径用 `book.origin` 从 `sourceMap` 取源，不检查 `enabled`；`enabled` 只用于搜索/发现候选过滤（`Reader/server.mjs:718`、`791-798`、`978-1016`）。这与 legado `BookSourceDao.getBookSource()` 与 `enableSources` 的分工一致。
  - 组文件确实曾被写成全部 `enabled=false`。已通过 `POST /api/sources/toggle` 将书源组2 的 17 条全部恢复启用；接口复核 `activeId=group-mu7z0c55-1603`、`total=17`、`enabled=17`，组文件与顶层镜像文件均为 17/17 启用。
  - 同时记录：书源管理页「全选 / 反选」已移到列表上方独立条目栏；七猫 API 发现页分栏为 4/4/4/3/3；光遇发现页 353 个 chip 无省略。WebView 缓存约 693.5MB 的清理方案已于 2026-09-20 完成（白名单清理 + 启动参数限制，实测释放 672.6MB 且登录态无损）。
- **2026-09-19**：书源组切换边界收口 + 本地切书可靠复测。
  - 修复切组残留：切换/新建书源组后清空上一组搜索结果与分页状态（`resetSearchForGroupChange()`），并给搜索流加「起始组 ID」校验，切组后在途搜索的后续回包直接丢弃，避免旧结果混入新组或翻页时把旧结果当 `existing` 传给新组书源。
  - 边界实测（headless Edge，`.scratch/verify-source-group-boundary.mjs`）：仅 1 组时删除按钮禁用；新建「边界测试组」后自动切换、旧「旧组残留书」被清空并提示「已切换书源组，请重新搜索」、删除按钮变为可用；切回并删除测试组后仍为 `书源组1`、31 源（启用 21）。
  - 本地切书复测（后端缓存，绕开不稳定的旧 UI 脚本）：49.3MB / 5597 章《踏星》`/api/book` 首次 1070ms、第二次 14ms、第三次 10ms，章节数与首章标题一致（首章「第 1 章 陆隐」、`tocRule=目录(去空白)`）。
  - 清理临时基准脚本：删除 `Reader/_prof.mjs`、`Reader/_bench.mjs`、`Reader/_bench2.mjs`、`Reader/_t-jsonpath.mjs`；`node --check Reader/server.mjs`、`node --check Reader/public/online.js` 均通过。
- **2026-09-19**：新增「独立书源组」并完成本地切书后端卡顿修复。
  - 书源组：`Reader/sources/groups/index.json` + `<groupId>/book-sources.json`；首次启动把旧 `book-sources.json` 迁移为「书源组1」，旧文件继续作为当前组镜像。新增 `/api/source-groups` CRUD/切换接口；书源管理页顶部增加当前组下拉、新建、重命名、删除。导入、启停、排序只写当前组，搜索、发现、换源只使用当前组启用书源；一次一个组生效，当前组选择重启后保持。
  - 书源组实测：当前组 31 源（启用 21）→ 新建测试组（0 源）→ 导入 1 源 → 切回组1 后 31 源与顺序完全一致 → 重命名 → 删除测试组；重启服务后当前组保持；headless Edge 书源管理窗口显示组下拉、当前组与 31 行书源。
  - 本地切书：`Reader/src/replace-engine.mjs` 缓存 `@js:` VM context；`server.mjs` 的 `fileCache` 改 LRU（40 本），`/api/book` 增加按路径 + 标题规则指纹的本地标题替换结果缓存（24 本）。49.3MB/5597 章《踏星》的 `/api/book` 从约 3.4–3.75s 降到首次约 1.1s、命中缓存约 60–70ms。
- **2026-09-19**：修复「本地阅读 - 管理书架删除反应很慢」。
  - 现象：在本地模式的「管理书架」弹窗点「确认移除」后要等很久才响应（截图确认）。
  - 根因：`removeShelf()` 移除成功后 `await selectShelf(next)`，而 `selectShelf()` 会请求 `/api/books?shelf=i`；`/api/books` 对目标书架目录做完整递归扫描。用户配置里 `D:\\小说` 有 14,044 本，旧扫描实现逐个文件同步 `stat + openSync/readSync 4KB` 实测约 **2.26s**，整段卡在确认按钮上。
  - 修法（`Reader/public/app.js`）：引入请求序号 `shelfLoadSeq` 防止快速连点旧响应回灌；`removeShelf(index, btn)` 点击后按钮立即置「移除中…」并禁用；移除成功先把弹窗与书架下拉刷新掉——**删除非当前书架时不重扫任何目录**；删除当前书架时先 `neutralReaderView()` 并显示「正在载入书架…」，再后台 `selectShelf(next)`，不再阻塞确认按钮。
  - 修法（`Reader/server.mjs`）：`listBooks(root)` 由「逐文件串行 stat + 同步读取 4KB」改为「先串行递归收集 `.txt/.md`，再用固定并发池 `BOOK_SCAN_CONCURRENCY = 64` 异步 `fsp.open/stat/read` 读文件头」；隐藏项/深度 <=6/小于 1KB/返回字段等过滤规则保持不变，末尾仍按中文书名排序。
  - 实测：`D:\\小说` 扫描 14,044 本 **约 1.0s**（旧实现 2.26s，并发 16≈1.03s，并发 128 无进一步收益）。Headless Edge 回归（可逆，测试后书架恢复原样）：非当前书架移除 **12ms**、当前书架移除（下一个书架为大目录）**11ms** 且阅读区立刻显示「正在载入书架…」、随后稳定落在 `小说 (14044)`；无控制台异常；`node --check` 两文件均通过。测试脚本 `.scratch/verify-shelfdel.mjs`。
- **2026-09-19**：任务状态收口。用户确认 **4.6 分页和滚动位置**、**4.9 书源管理和导入**、**4.10 登录窗口和网页交互** 均已完成；文档已同步移除对应待确认标记，当前无遗留待开发任务。
- **2026-09-19**：补充实测「番茄（找书版）发现结果页」与「本地切书缓存复用」。
  - 番茄发现：用户确认修复完成；当前内置番茄源 `女频` 分类实测渲染 20 本，书名/作者/封面 URL 正常，结果页翻页入口存在。
  - 本地切书：`Reader/public/app.js` 已移除切书时清空 `chapterCache` 的旧逻辑，缓存键包含书架索引与书路径；headless Edge 按 A→B→A 切换，第三次进入 A 后 `/api/chapter` 资源请求数仍为 5，未重复抓章。
- **2026-09-19**：修复「QQ 阅读发现页不加载封面」（同时修复同类链式规则被截断）。
  - 现象：QQ 阅读月票榜等发现页能返回书目，但封面全部加载失败；封面规则实际输出是裸的 `bid`（例如 `54818819`），不是可访问的图片地址。
  - 根因：`Reader/src/analyze-rule.mjs` 的 `_getString()` / `_getStringList()` 对象快路径见到 `JSON.parse` 得到的普通对象时，只执行 `ruleList[0]` 就返回。QQ 阅读封面规则是多段链式规则 `$..bid\n@js:\n...`，因此只跑了 `$..bid`，后面的 `@js:` 拼完整封面 URL 的段落被整段丢掉。legado 的快路径只用于 Rhino NativeObject / GSON LinkedTreeMap；Jayway JSON 解析产物不会走该快路径，而是完整执行规则链。
  - 修法：两处快路径均要求 `ruleList.length === 1`（`analyze-rule.mjs:200`、`analyze-rule.mjs:747`）；多段规则一律走通用循环完整执行。
  - 回归实测：`test-qq-cover.mjs` 输出完整封面 URL 且普通单段 `$.title` 正常；`qq-explore-2.mjs` 月票榜 200 本每本 coverUrl/bookUrl 完整；`/api/online/image` 返回 HTTP 200、image/jpeg、18196 bytes；headless Edge 发现页前 5 本封面 naturalWidth=140 / naturalHeight=186，截图 `.scratch/diag-qqread-covers.png`。
  - 影响范围：扫描到 30 条同类「JSON 路径段 + JS 段」链式规则，包括 QQ 浏览器 / 松鹤庭沐搜索的 coverUrl、bookUrl 等；以 `@js:` 开头的规则原本就不受该快路径影响。
- **2026-09-19**：发现页分类排版优化（速读谷²/笔趣阁/QQ浏览器/松鹤庭沐）。
  - 现象：速读谷²、笔趣阁的分类 chip 宽度随文字长度变化（48~72px），换行后每行起点对不齐；QQ浏览器的分类项带 `layout_flexGrow=1`，被 flex 拉成一行几种宽度，视觉参差；松鹤庭沐的一级分类被书源用全角空格撑满整行，渲染成一整条空荡荡的长条。
  - 修法：`Reader/public/online.js` 新增 `equalizeExploreKindChips()`，渲染完成后按同屏最大自然宽度统一 `flex: 0 0 <w>px`；`ekHasOwnBasis()` 让书源自带百分比列宽的元素（如松鹤庭沐二级分类 25%）保持原分栏；`ekIsWideKind()` 识别整行分组头；`ekWideHeadName()` 去掉撑满用空白，按 `EXPLORE_HEAD_DECOS` 交替加 🔷🔹/🔶🔸 镜像装饰（「男频分类」这类总标题保持朴素）。宽度 >180px 的极端长文本不强行走等宽。窗口 resize 后 150ms 重算。
  - 实测（headless Edge，发现面板内容区 721px）：速读谷² 19 项全部 73x26、步长 79px 严格对齐；笔趣阁 16 项同为 73x26；QQ浏览器 22 项统一 100x26、每行 6 列；松鹤庭沐分组头「🔷🔹 都市 🔹🔷」「🔶🔸 玄幻 🔸🔶」「🔷🔹 仙侠 🔹🔷」交替正常，二级分类保持 236x26 三列。光遇聚合发现页未受影响（select 行、搜索框行、通栏头原样）。截图 `.scratch/explore3-*.png`。
- **2026-09-19**：修复「QQ 浏览器发现页分类仍不对齐」+「番茄书架加载不出」。
  - QQ 浏览器：保留原有 `flex: 0 0 <w>px` 实测仍有 117px 一致宽度，但为确保换行后严格对齐，改用 CSS Grid（`.chip-row.ek-grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}`）；`equalizeExploreKindChips()` 在面板宽度为 0 时下一帧重试、字体加载完再测一次。实测 22 项全部 117px、x 坐标 235/358/480/603/726/848 每行一致，6 列对齐，截图 `.scratch/diag-qqb-chips.png`。
  - 番茄书架：书源 JsonPath 规则以 `.` 开头（`.detail_list[*]`）以前不生效；核对该书源在 legado 下 Jayway `PathCompiler` 对非 `$`/`@` 开头规则统一补 `$.`，改为 `_normalizePath()` 前置 `$.`。实测书架接口 200、`ok:true`、258 本，搜索/发现也一并恢复。
  - 新增 `/api/build` 版本哨兵：旧标签页不再长期停留在旧 JS/CSS，15s 轮询 + 重新可见即时比对，指纹变化自动 reload（服务已重启加载该路由）。

- **2026-09-19**：修复晴天番茄「神评论 / 本章说」SVG 横幅仍按正文整宽显示、字号偏大的问题。
  - 现象：《我不是戏神》第 1 章「神评论」原图 1000x108，原渲染 903x98；「本章说」原图 1000x590 级别，原渲染 903x768，内嵌评论字号随整宽放大后明显大于 26px 正文。
  - 根因：`qtbzs` 未纳入既有七猫评论图 79% 规则；部分「神评论」图片只有 `style=FULL`、没有 `type`，无法按 `data-type="qmpl-god"` 命中。
  - 修法：`Reader/public/online.js` 图片 onload 按原图宽高比 `>=6` 标记 `ch-img-comment-banner`；`Reader/public/online.css` 把 `qtbzs` 和该标记与七猫 `qmpl-god/qmpl-chapter-preview` 统一收到 `56%`。
  - 实测：headless Edge 打开《我不是戏神》第 1 章，「神评论」903x98 → 506x55，「本章说」903x768 → 506x325；正文 26px、段评气泡 32x32 未受影响；点击图片仍打开评论区（晴天 64 条评论；七猫《斗破苍穹》第 1 章段评也可打开「评论区」）。截图 `.scratch/cmt-size-before.png`、`.scratch/cmt-qm-after.png`。
- **2026-09-19**：**修复根因**——「书源 URL 是字面量」的书源（光遇聚合等）请求全部 502（Cookie 域匹配用错对象，照 legado CookieManager 语义修正）。
  - 现象：光遇聚合的发现页、搜索、书单全部 502；手机 legado（已登录）却能正常加载。
  - 根因：服务器只对带登录凭证（`Cookie: deviceId=...; qttoken=...`）的请求返回数据，无凭证请求被拒（Cloudflare 502）。而 `AnalyzeUrl._buildHeaders()/_saveCookies()` 用 `getSubDomain(source.bookSourceUrl)` 找 Cookie——光遇聚合的 `bookSourceUrl` 是字面量「光遇聚合」（不是 URL），归一化后仍是「光遇聚合」，查不到存在「gyks.cf」桶里的登录 Cookie → 所有请求都不带 Cookie → 全部 502。
  - 对照 legado：`CookieManager.loadRequest(request)` 用 **request.url**（实际请求 URL）归一化 domain；`saveResponse(response)` 用 **response.request.url**。即「按实际请求地址取 Cookie」，而不是书源名。
  - 修法（`Reader/src/analyze-url.mjs`）：新增 `_cookieDomain()`（`getSubDomain(this.url || this.urlNoQuery)` 回退 `this.domain`）；`_buildHeaders()` 与 `_saveCookies()` 全部改用它。
  - 实测：带 Cookie 直测 v1~v7 全部 **200**；`GET /api/online/explore`（巅峰榜）返回 **30 本书** / meta.status 200；headless Edge 点击「巅峰榜」渲染书列表（《时停时停…》/ 六个葫芦 等）；`POST /api/online/search` 「斗破苍穹」**364 条结果**（3 个失败源，不影响其余源），光遇聚合条目 182 条。

- **2026-09-19**：光遇聚合发现页「能显示分类但点不出书」网络层排查（证据留档）。
  - 书源自带 9 条线路（v1~v7 域名 + 2 个 IP 直连），jsLib 的 `request()` 失败时会自动切换线路重试（`switchToNextLine`）。
  - 本机（桌面宽带）逐条实测：v1~v7 全部 **502**（~0.7-2.3s）；2 个 IP 直连线路 **UND_ERR_CONNECT_TIMEOUT**（~10.7s）。也就是说桌面网络对 9 条线路均不可达。
  - 已排除的因素：UA（浏览器/okhttp）、Cloudflare 节点（多 IP）、海外出口（allorigins 美国）、静态资源（`/static/*` 仍 200）、缓存（已恢复 388 项）。
  - 当前判断：桌面所在网络到源站数据接口不可达（源站侧 502 / IP 线路不可连）；手机端若真实时可用，则说明手机网络（蜂窝/代理）能命中可用路径。待验：手机浏览器打开 `/discovestyle?...` 看返回 JSON 还是 502；手机 legado 点「巅峰榜」能否出书。

- **2026-09-19**：修复「发现页点榜单后一直卡在『加载中…』」。
  - 根因：`online.js` 的 `loadExploreBooks()` 在书单为空时调用 `exploreEmptyMessage(r)`，但该函数**从未定义**（全文仅 1 处调用、 0 处定义）→ `ReferenceError` 让 async 函数静默中断，UI 停在「加载中…」，也看不到上游的真实状态码。
  - 修法：补上 `exploreEmptyMessage()`：上游状态码 >=400 时显示「书源接口返回 502，源站暂时不可用，请稍后再试」；有 `meta.message` 显示该消息；有 `error` 显示错误；否则「没有找到内容」。
  - 实测（headless Edge）：点击「巅峰榜」后列表区显示「书源接口返回 502，源站暂时不可用，请稍后再试」，不再卡加载中。
  - 背景（已实测证据）：gyks.cf 动态接口（`/get_discover` `/discovestyle`）目前**全线 502**：v1~v7 域名、2 个 IP 直连线路、桌面出口、第三方海外代理出口、浏览器 UA 与 okhttp UA 均为 502；仅 `/static/*` 静态文件 200。发现页的 380 个分类按钮来自已恢复的缓存；书单必须实时请求，源站恢复前无法加载。

- **2026-09-19**：恢复光遇聚合发现页完整榜单缓存（用户确认「当然成功过」，此前「从未成功」的判断有误）。
  - 事实澄清：桌面端**历史上确实成功加载过完整榜单**（用户截图 `codex-clipboard-853dde68` 可见 12 个榜位 + 热门标签；会话日志里也留有当时的完整缓存 dump）。
  - 丢失原因：9-19 凌晨排查登录 / 评论区期间，刷新路径触发 `clearExploreKindsCache()` -> 重跑 `exploreUrl` 脚本 -> `/discovestyle` 已 502 -> 只剩筛选框的残缺结果覆盖了磁盘缓存，`.good` 也被同步覆盖。
  - 恢复方法：从 Codex 会话日志第 85882 行（2026-09-18T23:02:48Z 的缓存 dump）流式提取出完整 388 项 JSON（`.scratch/recovered-gy-kinds.json`，358 项带 url），校验格式后写回 `Reader/cache/explore/627715079` 与 `.good`（原 11 项残缺版已备份到 `.scratch/broken-gy-kinds-11items-backup.json`）。
  - 实测：`GET /api/online/explore/kinds?source=光遇聚合` 返回 388 项；headless Edge 发现页渲染 380 个 chip + 4 个按钮，12 个榜位与全部热门标签全部显示（截图 `.scratch/gy-explore-verify.png`）。
  - 说明：榜单数据接口（`/get_discover` 等）在源站 502 恢复前仍可能取书失败，但入口、分类与布局不再丢失。

- **2026-09-19**：修复「光遇书源评论区点击后先出现空白，过一会才加载」。
  - 根因：评论页 `java.showBrowser` 返回的 HTML 是一个异步 SPA，iframe 首次绘制前弹窗只有白色背景；源站 CSS/数据接口加载期间，外层弹窗没有自己的加载态，所以先看到整片空白。
  - `Reader/public/online.js` `chOpenAction()`：弹窗增加即时 `ch-modal-loading` 遮罩；轮询 iframe 的 `contentDocument`，只有出现可见文本或 img/video/canvas/svg/input/button 等实际内容后才淡出；8 秒后显示「源站响应较慢，请稍候…」，30 秒兜底撤掉遮罩避免永久遮挡。识别依据只使用 `innerText`，避免把尚未执行的 `<script>` 源码误判成可见内容。
  - `Reader/public/online.css`：新增 `.ch-modal-stage` / `.ch-modal-loading` / spinner 样式，iframe 在遮罩下先铺满弹窗。
  - 实测：合成慢页面（2 秒后才写 body）在 120ms、620ms 均保持「正在加载评论区…」，2.2 秒正文出现后遮罩才进入淡出；真实光遇聚合/番茄《我不是戏神》评论页回归：点击后弹窗标题为「评论区」，3.5 秒内显示 64 条评论、20 条 `.comment-item`，无白屏；`node --check Reader/public/online.js` 通过。
- **2026-09-19**：替换净化 / TXT 目录规则的底部栏精简为「全选 + 反选」两个按钮（用户指定）。
  - 删掉了 全选（重复文案）/ 启用所选 / 禁用所选 / 置顶所选 / 置底所选 / 导出所选 / 删除 七个按钮，只留：
    `全选（已启用/可见）`——一键启用当前可见规则，全部已启用时按钮变「取消全选」，点一下即全部停用；`反选`——可见规则里已启用的停用、未启用的启用（对齐 legado `SelectActionBar` 的 `selectAll` / `revertSelection`，计数文案同 `upCountView` 的「全选(n/m)/取消全选(n/m)」）。
  - 底部栏改为**常显**（不再随勾选浮出，与 legado ReplaceRuleActivity「打开即处于选择模式」一致）；两个按钮等宽铺满整行，不再右侧留白。
  - 顶置/置底/删除仍在每行的 ⋮ 菜单；单条启用/停用仍在行首勾选框。前端同时移除了 `replaceSel` / `txtTocSel` 两个已无用的选中集合和相关代码。
  - 实测（headless Edge，用临时规则过滤后操作、不影响现有规则）：底部栏只有 `all:全选（6/22）| invert:反选` 两个按钮、未勾选也常显、两按钮等宽（361/361 于 758 宽栏内）；反选→启用、取消全选→停用、全选→启用、再反选→停用全部通过；TXT 目录规则同套逻辑通过；测试后规则条数、顺序、启用状态与测试前逐条一致。
- **2026-09-19**：修复「源站故障时发现页内容又不见了」（光遇聚合）。
  - 直接根因：`server.mjs:2083` 在 worker 已经 `clearExploreKindsCache() -> exploreKinds()` 写回新缓存之后，又广播清了一次；刚写好的缓存被删，下次只能重跑脚本，而 `/discovestyle` 全线 502 -> `style_list` 空 -> 榜单入口消失。该行已删除（保留 worker 内 legado 原生语义）。
  - `src/explore.mjs` 读取路径统一到 `bestCachedKinds()` / `readKindFile()`：内存、主缓存、`<key>.good` 三处取「带 url 入口数」最多的一份；主缓存残缺时用 `.good` 自愈回填；`exploreKindsJson()` 增加 `.good` 只读兜底。
  - 新增 `tools/import-explore-cache.mjs`：把手机 legado 的 `cache/explore/<hashCode>` 文件直接导入本机（key = `md5(bookSourceUrl + exploreUrl)`，落盘名 = Java `String.hashCode(key)`，与 legado 同名同值）。
  - 实测：`GET /api/online/explore/kinds?source=光遇聚合` -> `ok=true`；`POST /api/online/explore/action` 后主缓存仍在（不再被二次清空），`627715079` 与 `627715079.good` 当时为 2946B / 11 项；2026-09-19 已从会话日志恢复完整 388 项版本并写回（详见新日志与 4.17 节）。
  - 上游现状：`v1~v7.gyks.cf` 的 `/discovestyle`、`/fqrank`、`/qmrank`、`/fqrecommend`、`/get_book_shelf`、`/fquser` 全部 HTTP 502（`/static/source_config/config.json` 仍 200）。榜单数据只能来自旧缓存，恢复完整榜单需从手机 legado 导入那份缓存。
- **2026-09-19**：修复番茄登录验证码「点不动 / 拖不动」。
  - 根因：`browser-host.mjs` 用 `Network.setExtraHTTPHeaders` 把书源 header 整包注入**所有**请求。番茄书源 header 带 `ismobile: 0`，跨域子资源（`lf-rc*.yhgfb-cn-static.com/obj/rc-verifycenter/.../index.js` 等）的 CORS 预检因此全部失败，滑块 SDK 没注册 → 窗口渲染出来但没有任何交互。
  - 对照 legado：`WebViewLoginFragment.kt` 把 UA 设到 `WebSettings.userAgentString`，其余 header 只作为 `loadUrl(url, additionalHeaders)` 的顶层导航头；安卓 WebView 的 `additionalHttpHeaders` **不会**带到 XHR / fetch / script / img 上。
  - 修法（`Reader/src/browser-host.mjs`）：拆 `splitSourceHeaders()` 分出 UA；UA 走 `Network.setUserAgentOverride`（全局生效），其余 header 走 `Fetch.enable` + `Fetch.requestPaused` 只对主框架 Document 合并。新增 `tab.mainFrameId` 记录（`Page.frameNavigated`）用于识别主框架。
  - 实测：本地回显测试 `.scratch/verify-header-scope2.mjs` PASS（主文档带 `ismobile`、跨域子资源不带、UA 全局生效）；番茄真实页面 CORS 报错归零；经前端同一条链路（`/api/online/webview/input`）发按下 → 拖动 → 抬起，滑块移动、绿色进度条跟随并进入下一轮验证图。
- **2026-09-19**：修复「源站故障时发现页分类越刷越空」。
  - 现象：光遇聚合发现页只剩筛选框和按钮，番茄等榜单入口消失（`Reader/cache/explore/627715079` 只剩 11 项、2 个 url 入口）。
  - 根因：`exploreUrl` 脚本里 `java.ajax(base_url + '/discovestyle?...')` 外面套了 try/catch，源站 502 时异常被吞、`style_list` 保持空数组；旧实现会把这份残缺结果 `aCache.put()` 回写磁盘，把上次那份完整分类覆盖掉；`clearExploreKindsCache()`（点「刷新」触发）还会先删磁盘缓存，等于连退路一起删。
  - 修法（`Reader/src/explore.mjs`）：新增 `kindScore()` / `keepBetterKinds()`，先比「带 url 的分类入口数」（榜单有无是质变）再比总数；残缺结果只进内存、**不回写磁盘**；内存 TTL 命中时若磁盘上有更完整的缓存则以磁盘为准；`clearExploreKindsCache()` 改为只清内存，保留磁盘上的完整缓存。
  - 实测 `.scratch/test-keepbest.mjs`：磁盘种入一份含额外榜单入口的缓存并把 mtime 推到 31 分钟前（绕过 TTL 强制重算），接口返回 12 项 / 3 个 url 入口（保留完整那份），磁盘文件未被残缺结果覆盖。
-- **2026-09-19**：把七猫 / 光遇评论弹窗的标题从「书源窗口」改为「评论区」。
  - 书源用 `java.showBrowser` 传评论 HTML，`openBrowserAction` 走 `chOpenAction`；该弹窗标题兜底原先写死 `"书源窗口"`。
  - 新增 `commentDialogTitle(html)`（`online.js:1239-1249`）：按 html 里的 `段评|书评|本章说|神评论|条评论|全部评论|评论区|api-cmnt.wtzw.com` 标记识别为「评论区」；识别不出仍退回「书源窗口」。
  - `online.js:1263` 改为 `a.title || (a.html ? commentDialogTitle(a.html) : (a.url || ""))`；`node --check online.js` 通过，`GET /online.js` 已提供新版本。
- **2026-09-19**：按用户要求把 `#00 数字标题#JS` 的章节号输出由 `第1章` 改成 `第 1 章`（数字与「第」「章」之间各保留一个空格）。
  - 只改 `assemble()` 的头部拼装：新增 `headText = /^第.+$/.test(prefix) ? ('第 ' + prefix.slice(1) + ' ' + suffix) : (prefix + suffix)`，5 处 `return prefix + suffix` 全部改为 `return headText`；`pattern` 与其他 20 条规则逐字段比对无变化，`replacement` 长度 9354 → 9518。零值「序章」分支保持原样。
  - 实测（`POST /api/replace-rules/test`）：`第一章 内容`→`第 1 章 内容`、`第001章 内容`→`第 001 章 内容`、`4 月光下`→`第 4 章 月光下`、`第12章 标题`→`第 12 章 标题`。
- **2026-09-19**：按用户要求把 `sjshb57/legado-57` 数字标题规则做成内置 **第 0 条**，与原 `#01 数字标题` 并存且互斥（用户自行选择启用哪条）。
  - `Reader/sources/builtin-replace-rules.json`：新增 `id:0`（name `#00 数字标题#JS`，order 0，与 #01 强制互斥，replacement 9518 字符），`id:1` 还原为原版规则体（replacement 483 字符，已与 `阅读器/sources/builtin-replace-rules.json` 逐字节比对一致）。
  - 规则体按用户要求做**最小改写**：`assemble()` 中新增 `headText`，把章节号输出改成 `第 1 章` 形式（数字与「第」「章」之间各留一个空格），其余逻辑与上游 v3.0.1 一致。前缀序号剥离行为不变（`1. 章节名 标题`→`章节名 标题`、`8.29 请假条`→`请假条`）。实测 `第一章 内容`→`第 1 章 内容`、`1. 章节名 标题`→`章节名 标题`、`8.29 请假条`→`请假条`、`4 月光下`→`第 4 章 月光下`、`第001章 内容`→`第 001 章 内容`；零值「序章」分支保持原样。
  - 原规则 `#01` 保持 `第001章 内容` 不变（legado 原生行为）。
  - `Reader/server.mjs`：新增 `NUMERIC_TITLE_RULE_IDS` / `numericTitleRuleMutex()`，在 toggle / save / import / builtin-reset 四处强制互斥并回传 `mutexDisabled`；把内置规则内容同步改为**内容签名守卫**（`BUILTIN_REPLACE_SIGNATURE` + `syncBuiltinReplaceRulesBySignature()`）——源文件一变就自动补条/同步规则体，并保留用户开关与排序。
  - `Reader/public/online.js` + `online.css`：两条规则显示「二选一」徽标，开启时若自动关闭另一条会 toast 提示并刷新列表。
  - 实测（`http://127.0.0.1:7788`）：`GET /api/replace-rules` → `builtin-netclean-0`(order 0, 默认关闭) / `builtin-netclean-1`(order 1, 默认开启)；toggle 互斥三次均正确（开启 #00 自动关 #01，反之亦然，全部关闭不误伤）。
- **2026-09-19**：修复本地阅读回归：7788 改为运行 Reader，原阅读器仅保留 7799 对照；恢复顶栏原版 grid 三栏；对齐原阅读器书架/进度/字体/设置，切换本地/在线不再残留在线正文。
- **2026-09-19**：把「替换净化 / TXT 目录规则」同步到本地阅读器（`阅读器/`）。
  - 依据：legado 的替换净化对本地书同样生效（`LocalBook.kt:170-184` → `ReadBook.kt:798-805`）；
    TXT 目录规则本来就是 `TextFile.kt` 拆本地 txt 用的，只作用于本地书。
  - 后端 `阅读器/server.mjs`：新增 `src/java-regex.mjs` / `src/replace-engine.mjs` / `src/txt-toc-rules.mjs` 三个模块，
    以及 `sources/builtin-replace-rules.json`（20 条）、`sources/builtin-txt-toc-rules.json`（26 条）；
    `reader.config.json` 新增 `replaceRules` / `txtTocRules` 字段（含内置规则初始化与迁移标记）；
    `/api/book`、`/api/chapter` 的目录标题与正文（含卷标题清空正文）改为实时跑净化；
    新增 `/api/replace-rules*`（列表 / 增删改 / 启停 / 排序 / 分组 / 导入导出 / 测试）与
    `/api/txt-toc-rules*` 路由，与在线版完全同形。
  - 前端 `阅读器/public/{index.html,app.js,style.css}`：顶栏加 `✎ 替换净化 / TXT 目录规则` 按钮；
    面板（`#modalReplace`）与 `online.js` 的替换净化逻辑整段复制（含 `askConfirm/askFields/askPrompt/askText` 弹窗、
    规则列表 / 多选条 / 导入预览），只把「改动后重渲染」改成本地版语义（清章缓存 → 重开书 → 回到原章节与滚动位置）。
  - 验证（实测服务 <http://127.0.0.1:7788/>）：
    `GET /api/replace-rules` → 20 条（启用 6），`GET /api/txt-toc-rules` → 26 条（启用 12），分组 `["格式","净化","可选"]`；
    《21世纪的死灵法师》分章命中 `目录(去空白)`，1084 章，正文头 `第001章 世纪死灵法师`；
    停用 `builtin-netclean-1` → 变回 `第一章 世纪死灵法师`，重新启用 → 回到 `第001章`（取消即恢复原文）；
    目录规则切到 `目录` 再切回 `目录(去空白)`，`tocRule` 字段同步变化（分章规则实时重算）。
    `阅读器/reader.config.json` 书架（6 个书架 / 1555 本）与规则数据均未被破坏。
- **2026-09-19**：回答「为什么不同书的目录格式也不一样，有的是 001 开始，有的是 1」。
  - 结论：**不是 bug，也不是 TXT 目录规则**，而是替换净化 `#01 数字标题#JS`（`builtin-netclean-1`，`scopeTitle:true`）的匹配范围决定的。
    它的正则第一条分支只命中**中文数字**标题 `^第[零〇一二三四五六七八九十百千两]{1,7}[章节]`，命中后顺手把序号补零到 3 位；
    **本来就是阿拉伯数字**的标题（`第1章` / `第12章`）不在匹配范围内，原样保留。
  - 实测（直接跑 `src/replace-engine.mjs`，规则开启）：`第一章 陨落的天才`→`第001章 陨落的天才`、`第十章 试炼`→`第010章 试炼`、
    `第一百零二章 试炼`→`第102章 试炼`；而 `第1章 天道酬勤`、`第12章 天道`、`第210章 教廷的对策`、`楔子 少年时` 全部原样不动。
  - 也就是说：**书源给的原始标题是什么格式，决定最终显示 `001` 还是 `1`**。本项目 TOC 缓存里能直接看到这个差别：
    `cache/toc/0fa0a37a….json`（七猫《斗破苍穹》）原始标题 `第一章 陨落的天才` → 显示 `第001章`；
    `cache/toc/dd34ebae….json`（七猫《巫师之上》）原始标题 `第1章 天道酬勤…` → 显示 `第1章`。
  - legado 侧完全一致：`BookChapter.getDisplayTitle()`（`app/src/main/java/io/legado/app/data/entities/BookChapter.kt:124`）
    对目录 / 正文 / 书架标题跑同一套 `scopeTitle` 规则，空结果用 `isNotBlank()` 丢弃；本项目 `displayChapterTitle()`（`server.mjs:2331`）
    行为与之对齐（空结果回退原标题）。所以「同一本书内 `001` 与 `第一章` 不一致」是之前修掉的 bug；
    「不同书之间 `001` 与 `1` 不一致」是该内置规则本身的固有行为，legado 同样如此。
  - 如需跨书统一：可新增一条**可选**（默认关闭）的标题规则，把阿拉伯数字标题补零到 3 位，或反过来去掉 `#01` 规则的补零；
    需用户确认采用哪种样式再动手，避免擅自改掉 legado 原生行为。

- **2026-09-19**：修复「正文头显示 `第001章`、右侧目录显示 `第一章`」不一致。
  - 结论（用户问「TXT 目录规则应用上了吗」）：**不是 TXT 目录规则的问题**。TXT 目录规则只用于本地 TXT 拆章
    （legado `TextFile.kt` + `defaultData/txtTocRule.json`），在线书源的目录由书源直接给出，不经过它。
    真正该管标题样式的是**替换净化**里 `scopeTitle:true` 的规则（`#01 数字标题#JS`，id `builtin-netclean-1`）。
  - 根因：`/api/online/content` 早就对正文标题调了 `applyTitleRules()`，但 `/api/online/chapters`、
    `/api/online/shelf`、`/api/online/progress` 返回的都是 TOC 缓存里的**原始标题**，于是出现「一处净化、一处没净化」。
  - 后端 `server.mjs`：新增 `displayChapterTitle()` / `displayChapters()`；`/api/online/chapters` 返回前实时套标题规则
    （缓存继续存原始标题，不污染）；`durChapterTitle` / `latestChapterTitle` 三处写入点同样改为净化后标题
    （对齐 legado `BookChapterList.updateBookTocInfo()`、`ReadBook.kt:1022`）。
  - 前端 `public/online.js`：`invalidateChapterRender()` 现在在净化规则启停/改序后同时丢弃本会话 TOC 缓存并调用新增的
    `refreshOnlineTocTitles()`，就地更新右侧目录标题，并同步详情页目录弹窗，不必重开书。
  - 验证：API 层 `/api/online/chapters` 与 `/api/online/content` 对《斗破苍穹》均返回 `第001章 陨落的天才`；
    规则 ON/OFF 双向切回均即时生效；headless Edge 端到端实测正文头 `第001章 陨落的天才`、右侧目录
    `["第001章 陨落的天才","第002章 斗气大陆","第003章 客人","第004章 云岚宗"]`；书架《斗破苍穹》读到=`第001章 陨落的天才`、
    《武动乾坤》读到=`第007章 淬体第四重`。服务已重启到 <http://127.0.0.1:7788/>。

- **2026-09-19**：接入 legado TXT 目录规则（本地分章 + 右侧目录）。
  - 新增 `src/txt-toc-rules.mjs`，逐行对应 legado `TextFile.kt` 的 `getTocRule()` / `analyze(rr)` /
    `replacement()`：支持 `result`、`book`、`index`、`prevTitle`、`prevLength`、`lastVolumeTitle`、
    `java.putVolume()`，并按 512KB 探测、卷标题误识别计数和 3 倍阈值选规则。
  - 新增 `sources/builtin-txt-toc-rules.json`：直接使用 legado `defaultData/txtTocRule.json` 的 26 条规则，
    默认启用 12 条（ID -1、-2、-8、-9、-11、-12、-14、-16、-17、-21、-22、-24）。
  - `server.mjs` 新增 TXT 目录规则初始化、迁移、保存、批量启停、排序、删除、单条试切、导入预览等接口；
    本地解析缓存 key 加入规则指纹，`/api/book` 与 `/api/chapter` 共用同一份解析结果，规则一变目录和正文同步重建。
  - 替换净化窗口改为「替换净化 / TXT 目录规则」双 Tab；目录规则列表支持搜索、勾选、启用/禁用、置顶/置底、
    新增、本地导入、网络导入、导入默认规则和导出。
  - 验证：Node 语法检查通过；`GET /api/txt-toc-rules` 返回 26 条、启用 12 条；
    `POST /api/txt-toc-rules/test` 用 8 章示例文本按内置「目录」规则切出 8 章，标题为
    `第1章 标题1` … `第8章 标题8`；与 legado `defaultData/txtTocRule.json` 逐字段比对：
    26/26 条相同、默认启用 12/12 条相同；服务已用新代码重启到 <http://127.0.0.1:7788/>，HTTP 200。

- **2026-09-19**：修复章节号时有时无（@js 替换返回值被吞）。
  - 现象：七猫《武动乾坤》《斗破苍穹》章节头只剩“林动 / 陨落的天才”，而《巫师之上》原题已是阿拉伯数字所以看起来正常。
  - 根因：`src/replace-engine.mjs` 把 `@js:` 替换代码包成 function 后直接调用，但没有 `return`；Rhino `eval` 本应返回最后一条表达式的值，这里却得到 `undefined`，整段匹配被替换为空串。
  - 修复：改为函数内直接 `eval(__code)`，取最后一条表达式的 completion value，与 legado `RegexExtensions.kt` 的 `eval(replacement1, bindings)` 一致；每次匹配仍有独立函数作用域，避免 `let/const` 重复声明。
  - 实测 `/api/online/content`：武动乾坤 → `第001章 林动`，斗破苍穹 → `第001章 陨落的天才`，巫师之上 → `第1章 天道酬勤`。

- **2026-09-19**：搜索结果统计口径修正 + 恢复「无结果 / 失败」书源显示。
  - 问题：15 个启用源里只有 9 个真的搜到书，统计行却显示「15/15 源成功」；并且「请求成功但 0 本」的源
    在分组列表里完全消失，用户以为这个源没搜过。
  - 根因：统计用的是「请求成功（ok）」而非「有结果」；且最终/增量渲染都只输出有书的分组 + 失败块，
    sources 里那些 ok:true 但 books 为空的源被静默吞掉。
  - 改动 public/online.js：
    - 统计行改为「N 本书 · X/Y 源有结果」（X = 有结果的源数，Y = 本轮源总数）；
      X 不等于请求成功数时再补「· Z 个源请求成功」。
    - 新增 missBlock(fails, empties)（failBlock 保留为 missBlock(fails, []) 的别名），
      在结果最上方用 details 汇总「N 个书源无结果 · M 个失败」，逐条列出源名 + 原因；
      最终渲染与增量渲染都接上。
  - 实测：POST /api/online/search（关键词「盘龙」，15 源）→
    「平板电子书」「速读谷」返回 0 本，其余 13 源有结果；
    新口径显示「13/15 源有结果」，并列出这 2 个无结果源。
- **2026-09-19**：单本换源「换源之后还没变」—— 用户确认已生效，状态改 ✅。

- **2026-09-19**：一键换源 —— 目标书源里没有这本书时不再触发换源，并在结束后弹出结果面板。
  - 后端 `doChangeAllSource`：`preciseSearch` 返回 `未搜索到 X(Y) 书籍` 时记为独立的 `state:"notfound"`
    （不再混进 `failed`），`done` 汇总新增 `notfound` 字段；这类书**完全不动书架记录**。
    语义对齐 legado `BookshelfManageViewModel.changeSource` 的 `getOrNull()?.let{...}`（搜不到就跳过）。
  - 前端 `runChangeAll`：新增 `#caResult` 结果面板（`renderChangeAllResult` / `clearChangeAllResult`），
    统计「成功 / 目标源没有 / 失败 / 已在该源」，并把没换成的书逐条列出原因；toast 与进度文案同步带上「未找到」。
    中途停止时也会把已处理的那部分结果列出来。
  - 端到端实测（真实书架、未改配置）：
    用 `POST /api/online/search/precise` 先筛出一组真实「目标源没有」的组合，
    再跑 `POST /api/online/changeAllSource`（《踢球的时候要称GOAT》/夜之城不养闲人 → 🐱七猫小说）：
    `{"state":"notfound","note":"目标书源没有这本书，保持原书源不变"}` + `done{"changed":0,"notfound":1}`，
    换源前后书架列表完全一致（该书仍是 🌑速读谷²）。
    另用不存在的书名验证错误文案确实以「未搜索到」开头，`/^未搜索到/` 判定成立。
- **2026-09-19**：盘龙 400+ 章「正文只剩几十字」定位完成 —— **不是净化规则把正文删了，是源侧的付费/广告试读**。
  - 直接 POST 源接口复现：第 1 章 8120 字、第 2 章 3316 字（完整）；第 399/400/401/402 章分别只有 47/51/51/48 字，结尾统一是 `...`。
  - 源侧原始响应即带 `"ErrMsg":"get content err: ads read is not supported, ads status 0, ret:2"` 与 `Price: 2000`；换 GUID、加 Referer、走桌面端同样结果。
  - 书源定义 `ruleContent.content = "<p>{{$.data.Content[0].Content}}</p>"`、`payAction: null` —— 书源本身就没有拿全文的规则，legado 行为一致。
  - 缓存文件可直接佐证：正常章 7~25 KB，试读章 545~560 B；净化前后的文本长度完全一致。
  - 代码改动：`server.mjs` 新增 `looksLikePayPreview()`（≤400 字 + ≤3 行 + 结尾省略号，避免误伤正常短章），
    `/api/online/content` 增加 `payPreview` / `payHint` 字段；`public/online.js` 新增 `updatePayHint()` / `hidePayHint()`，
    正文上方显示可关闭提示条并提供「换源」按钮；`public/index.html` + `public/online.css` 补对应结构样式。
  - 回归：第 1/2 章 `payPreview=false` 不提示，第 399~402 章 `payPreview=true` 正常提示。


- **2026-09-19**：复测多源排序。直接 POST `/api/online/search`（15 源，关键词「我不是戏神」，page=1）返回 339 条合并结果，第一条为「我不是戏神 / 三九音域 / 光遇聚合 / 番茄」，与只用光遇聚合单源搜索一致。用户反馈「legado 里也有这个问题」，属于 legado `SearchModel.mergeItems` 的原始合并表现；Reader 当前保留了更准的优先策略。

- **2026-09-19**：搜索排序与翻页两处重构：
  - 排序：新增 `relevanceTier()`（legado `SearchModel.mergeItems` 的等值 / 标签 / 包含 / 其他分桶），
    组内先按相关性、再按平台优先级（番茄）排序；后端 `mergeItemsLocal` 在「先到的是普通源、后来的是番茄条目」
    时把整条记录的身份换成番茄条目（番茄信息最全，且 `originName`/`bookUrl` 整套替换不会自相矛盾）。
    实测：全源搜「我不是戏神」，第一条 = 光遇聚合 / 番茄 / 9 个来源 / 400.36 万字 / 9.9 分，
    与只用光遇聚合单源搜索的结果一致。
  - 翻页：`doSearch(page>1)` 不再清空结果、不再逐源重绘整页；改为保留当前列表 + 结果区顶部吸顶提示
    「正在加载第 N 页…（已返回 x / y 个书源）」，新页到齐后整体替换并滚到本页新增的第一条。
    实测：第 1 页 339 本 → 点「下一页」过程中旧列表保持可见 → 完成后 454 本并停在新增第一条。

- **2026-09-19**：搜索结果栏新增「按书源展开 / 收起」（分组头点击折叠 + 收起全部 / 展开全部）；
  实测真实搜索 610 本 / 12 组，收起后一屏可看完全部书源条目数。
- **2026-09-19**：盘龙正文、晴天番茄正文与登录态、光遇聚合发现页、净化规则可逆、书架/详情细节
  —— 由用户确认完成，状态由 ⬜ 改为 ✅。
## 1. 项目定位

`Reader` 是一个电脑端在线阅读器，目标是让 legado 书源可以直接工作，并尽量把 legado 的书源解析、搜索、发现、详情、目录、正文、登录和换源能力迁移到桌面浏览器环境。

项目使用本地阅读器的阅读体验作为主体布局，但运行代码、配置和缓存都放在新建的 `Reader/` 文件夹中。原“阅读器”文件夹只作为参考，当前工作范围没有修改原文件夹内容。

核心目标：

- 兼容 legado 格式书源，而不是为每个站点单独写一套解析器。
- 书源规则优先按照 legado 的 Kotlin 行为移植，包括 CSS、XPath、JSONPath、正则、JS 和 `java.*` 桥接。
- 在线书架与本地书架共用阅读界面。
- 对桌面端不具备的 Android WebView 能力，使用桌面浏览器和本地桥接实现等价行为。
- 搜索和发现结果尽量实时展示，不能因为慢书源阻塞已经返回的结果。

## 2. 当前运行方式

服务已启动并可访问：

- 地址：<http://127.0.0.1:7788/>
- 当前检查结果：HTTP `200`
- 当前 Node 服务进程正在监听 `127.0.0.1:7788`（2026-09-19 核对 PID：53516）

手动启动：

```powershell
cd Reader
npm install
node server.mjs
```

关闭服务可使用 `Reader/关闭Reader.bat`，启动服务可使用 `Reader/启动Reader.bat`。

## 3. 已完成或代码中已有的能力

以下项目已经有对应实现，后续仍需针对真实书源做回归，不代表每个站点都已经验收通过。

### 3.1 书源和解析引擎

- 导入 legado JSON 书源。
- 导入前预览书源清单，默认全选，可单独选择，已有书源显示“已存在”。
- 书源启用、停用、分组、排序、编辑、导出和规则调试。
- 搜索只显示已启用书源，停用书源不再出现在搜索选择列表。
- CSS 选择器、XPath、JSONPath、正则和规则组合解析。
- `@js:`、`<js>`、`mainJs`、`java.*`、`source.*`、`jsLib` 等规则运行能力。
- URL 尾部请求参数、请求头、编码、POST、Cookie 和登录态处理。
- 多页目录、多页正文、卷标题、章节顺序、章节去重和正文替换。
- worker 池并发抓取，避免同步书源 JS 阻塞主线程。

### 3.2 在线阅读流程

- 搜索、实时显示先返回的书源结果，并显示书源响应时间和失败信息。
- 搜索结果按书源分组，可单独展开 / 收起，并提供「收起全部 / 展开全部」，避免上百条结果逐页翻。
- 发现页分类、按钮、输入框、下拉选项和分页。
- 书籍详情页、简介、封面、作者、目录和加入/移出书架状态切换。
- 详情页可打开完整目录窗口，支持跳到目录顶部和底部。
- 正文阅读、上一章/下一章、目录、刷新正文、换源、阅读进度和缓存目录。
- 书架同一本书去重，其他书源通过换源查看。
- 在线书架显示封面、书名、作者、来源、简介、已读章节和最新章节。
- 书架管理页面、拖动排序、批量操作和一键换源接口已有代码。
- 目录加载链路做过多轮提速：前端按 `rel` 缓存已解析目录（TTL 6 小时，与后端 `cache/toc` 对齐），
  切到别的书再切回来不再重新传输几 MB 的目录 JSON；切书不再清空正文 `chapterCache`，已读章节直接复用；
  `tocUrl == bookUrl` 的「详情页本身就是目录页」站点（速读谷² 等）不再每次打开都重抓一次详情。
  右侧目录虚拟列表 `renderToc` 改为捕获当次渲染的章节数组并跳过缺失项，切书时不再出现陈旧的滚动回调读取新书章节导致的报错。

### 3.3 登录和站内页面

- 书源登录规则、Cookie Jar、登录信息、登录检查和清除登录信息。
- 使用桌面 Edge/Chromium 的 CDP 远程浏览器承载需要真实网页交互的登录页。
- 支持输入、点击、拖动、滚动和登录后 Cookie 回写。
- 对 `java.showBrowser`、`java.startBrowser`、`java.openUrl` 等动作提供桌面窗口桥。

### 3.4 正文图片和评论入口

- 正文中的图片和图片参数可以保留，不再把包含图片的整段正文误判为空白。
- 已增加七猫特殊的 `,【...】` 图片参数识别。
- 已区分 legado 的 `style: TEXT` 和 `style: text`：前者为行内评论图，后者为更小的行内图，普通图片按块级图片处理。
- 已有点击正文图片后执行 `click/js` 并打开评论窗口的后端和前端桥接。
- 评论窗口使用固定的站内窗口尺寸，不再按书源传入的异常高度撑满整个页面。
- 七猫/晴天「神评 / 本章说」SVG 横幅按正文宽度 56% 缩放；无 `type` 的超宽评论横幅按原图宽高比识别，避免整宽铺满。

### 3.5 导出、净化和兼容接口

- TXT 导出接口和导出弹窗已有实现方向。
- 导出窗口支持参数设置、进度显示和并发数设置的代码入口。
- 书源可标记为禁止导出，界面文字统一为“禁止导出 TXT 小说”。
- 替换/净化规则支持按书名、书源、标题或正文作用域过滤。
- 已提供部分 legado HTTP API 兼容接口。

### 3.6 发现页分类缓存（ACache 落盘，2026-09-19 完成）

- 新增 `src/acache.mjs`，按 legado `app/src/main/java/io/legado/app/utils/ACache.kt` 实现 ACache：
  一个 key 一个文件，文件名用 Java `String.hashCode()`（与 legado 的同名同值），文件内容就是原始字符串。
- `src/explore.mjs` 的 `exploreKinds()` 改为先读 `Reader/cache/explore` 磁盘缓存，命中就不再执行 exploreUrl 里的 JS，
  与 legado `BookSourceExtensions.exploreKinds()` 的 `aCache.getAsString(key) ?: 执行脚本 + put` 一致。
  清缓存、`clearExploreKindsCache()`、书源设置里改分类后的刷新都会删掉对应文件。
- 这一步修的是「服务一重启分类就没了」：legado 里发现页能扛住源站挂掉，靠的就是这份永不过期的磁盘缓存，
  我们之前用的是 worker 内的内存 Map，重启即丢。
- 在 legado 之外补了两条保护（legado 本身没有）：一是新增 `<key>.good` 备份文件，只在结果「带 url 的榜单入口数」变多时覆盖，残缺结果永远不写盘；
  二是主缓存比备份残缺时自动用备份回填主缓存。内存 TTL 已移除（与 legado 一致：只要磁盘缓存非空就不再重算），
  因此不会再有「30 分钟后重算 -> 源站 502 -> 分类变空」这条退化路径；`clearExploreKindsCache()` 只删主缓存、保留 `.good`。
- 源站故障时可以直接把 legado 的 `cache/explore` 目录拷进 `Reader/cache/explore` 复用，文件名规则完全一致。

### 3.7 缓存统一到 Reader 文件夹（2026-09-19 完成）

- `server.mjs` 新增统一 `CACHE_DIR`，默认 `Reader/cache`，并支持 `READER_CACHE_DIR` 覆盖；
  `webview/toc/content/explore/login-state.json` 全部由这一处派生，不再散落硬编码。
- `src/acache.mjs` 与 `src/browser-host.mjs` 同样读取 `READER_CACHE_DIR`；浏览器 profile 的兜底路径
  也从系统临时目录改成 `Reader/cache/webview`，避免删除 Reader 后残留垃圾。
- 新增 `GET /api/online/storage`：返回缓存根目录、总占用、各分类占用和文件数。
- 新增 `POST /api/online/storage/open`：只允许打开固定缓存目录，不接受前端传入任意路径。
- 顶栏垃圾桶按钮改为打开「缓存与数据位置」窗口，显示实际路径、占用分类，并提供打开文件夹和清理阅读缓存。
  「清理阅读缓存」只清正文、目录、发现分类；登录 Cookie、WebView profile 和书架不会删除。
- 2026-09-20 补充：`GET /api/online/storage` 的 `webview` 字段拆成「可清理 / 保留」两类并附体积；
  新增 `POST /api/online/webview/cache/clear` 只清白名单内的可再生缓存，设置页对应按钮带明细与确认提示。
  对应 legado 的 `WebView.clearCache(true)` 语义 —— 只清网页资源缓存，不动 Cookie / Local Storage / IndexedDB。

### 3.8 WebView 缓存「用完收摊」（2026-09-20 完成）

- 背景：手动清理只是兜底，真正占体积的是登录内置浏览器每次会话长出的 HTTP 缓存（单次打开番茄登录页 37.6~41.6MB）。对照实验证明 `--disk-cache-size` / `--disable-features` 都压不住它，只能主动回收。
- 策略（`src/browser-host.mjs`）：最后一个窗口关闭 → 20s 宽限（`idleStopMs`）→ 有活进程就先 CDP `Network.clearBrowserCache`（page session）→ 优雅退出浏览器 → 删除 `TRANSIENT_CACHE_PATHS` 里的代码 / GPU / Shader 缓存。期间若用户重新开窗，`_opening` / `_inUse()` 会取消收摊，不会误杀。
- 与登录态的关系：收摊只碰可再生缓存，Cookies / Local Storage / IndexedDB / Storage / Preferences 全部保留；`stop()` 改为 `Browser.close` 优雅退出，反而修掉了原先强杀丢 LocalStorage 的问题（「刚登录完重启就掉登录」）。
- 与阅读的关系：正文 / 目录 / 搜索 / 换源不经过浏览器，走 Node 请求池，因此收摊不影响阅读；评论区 iframe 需要时会重新拉起浏览器。
- 验证脚本：`.scratch/verify-idle-cleanup.mjs`（8/8）、`.scratch/verify-live-idle-cleanup.mjs`（线上 7788）、`.scratch/verify-reading-after-cache-change.mjs`（阅读回归 5/5）、`.scratch/verify-reopen-race.mjs`（宽限期内重开 9/9）、`.scratch/verify-open-latency.mjs`（开窗延迟 7/7）。
- 文档：`README.md` 的「配置与缓存位置」补上「用完收摊」说明（清什么、留什么、为什么阅读不受影响）。

## 4. 任务状态清单（✅ 已完成 / ⏳ 待确认 / ⬜ 未完成）

**2026-09-19 状态约定（重要）**：每完成一项，必须立刻回到这里改标记，避免下轮重复劳动。
标 ✅ 的是用户已确认可用的；⏳ 是代码已改但还没拿到用户确认；⬜ 是确实还没做完。

### P0：当前直接影响阅读的故障

#### ✅ 4.1 七猫和晴天评论区参数兼容（已完成 · 2026-09-19）

- 2026-09-19 实测：七猫《斗破苍穹》第 1 章点击段评气泡可打开「评论区」（评论列表正常）；晴天《我不是戏神》第 1 章点击「本章说」大图可打开「评论区」，最终显示 64 条评论。
- 全角标点归一化已在前端图片参数解析中处理：`chNormalizeImageOption()` 覆盖 `＂`、`＇`、`，`、`：`；action 执行链路不再报 `Invalid or unexpected token`。
- `style: "text"` 的段评图保持 32x32 气泡；`style: "FULL"` 的「神评 / 本章说」SVG 横幅统一按正文宽 56% 缩放，已不再当作正文大图铺满。
- 验收标准已满足：七猫/晴天评论图点击可打开窗口；评论图和底部「本章说」大小接近正文，不再是超大横幅。

#### ✅ 4.2 盘龙正文过短或读错内容（已完成 · 2026-09-19 用户确认）

已观察到同一本盘龙：

- 规则调试接口能返回完整正文。
- 书架 `/api/online/content` 曾返回很短内容，已知长度约为 116、127、316 字。

需要比较书架阅读链路与调试链路的：

- `origin`、`bookUrl`、章节 URL 和章节索引是否一致。
- 书架缓存是否复用了错误书源或错误章节内容。
- worker 状态、Cookie、变量和 `book.variable` 是否在不同请求间丢失。
- 正文净化规则是否错误截断盘龙正文。
- `refresh=1` 连续请求是否在不同 worker 间得到不同结果。

验收标准：从书架打开盘龙，至少连续切换前 3 章，正文标题和正文内容都与调试结果一致，不能出现别人的书名、空白、短摘要或错误缓存。

#### ✅ 4.3 晴天源番茄正文和登录态（已完成 · 2026-09-19 用户确认）

- 番茄登录页仍有“页面不能点击/拖不到登录按钮”的历史问题，需要用实际登录窗口回归。
- 登录成功后短时间又显示普通账户，需确认 Cookie、登录头和 `loginCheckJs` 的保存及跨 worker 同步。
- 书架上的《我不是戏神》当前曾出现只有很大的本章说、没有正文；需要确认正文请求、评论图片和正文内容是三条独立数据，不得用评论结果覆盖正文。
- 切换章节曾显示“章节加载失败”，需要在晴天源连续切章验证。

### P1：核心功能仍需验收或修复

#### ✅ 4.4 换源和一键换源（已完成 · 2026-09-19）

- 单本换源已由用户确认可换源并刷新到目标源正文；一键换源在目标书源没有该书时不会误换，结束后会弹出结果/提示。
- 以下为历史验收项，保留用于回归：
- 单本换源曾出现“换了书源但正文没有变化”。
- 书站失效时换源曾无法启动搜索。
- 书架一键换源目前用户反馈“无效”，需要检查目标源搜索、书名作者匹配、详情、目录、进度迁移和原书替换是否完整。
- 换源搜索必须和普通搜索一样即时展示先返回的结果，不能长时间只显示“搜索中”。
- 换源后必须刷新当前书的 `origin`、`bookUrl`、目录、正文缓存和阅读进度。

验收标准：用一个原站点失效的书架条目执行单本换源和一键换源，能看到目标源结果，换源后打开的是目标源正文，而不是旧源缓存。

#### ✅ 4.5 光遇聚合发现页（已完成 · 2026-09-19 用户确认）

- 2026-09-19 实测：光遇聚合后端 `v1`~`v7.gyks.cf` 和两个备用 IP 的 `/discovestyle`、`/search`、`/detail`、
  `/catalog`、`/content` 全部返回 Cloudflare `502`（只有 `/static/source_config/config.json` 还是 200），
  也就是源站整体不可用；legado 上能看分类和目录是因为读的是它自己的磁盘缓存，不是接口还通。
- 分类缓存已经改成落盘（见 3.6）：源站恢复后最长 30 分钟自动补全；源站挂掉期间分类只剩
  线路 / 类型 / 频道 / 平台 / 搜索关键词 / 搜索 / 更新配置 / 更新书源 / 书源设置 / 晴天书架 / 登录番茄 这 11 个控件。
- 光遇发现页曾出现分组无法加载、内容不显示、只有榜单可用的问题。
- 分类顶部控件需要居中对齐，并保持合理高度。
- 发现页不同分类和榜单要在独立结果窗口显示，结果区域不能出现下半截大面积空白。
- 点击下一页时，第二页必须从第二页开头显示，不能停在第二页尾部，也不能先收起第一页再长时间空白。
- 发现页进入书籍详情后，从第二页结果打开详情，返回或继续翻页时页码和滚动位置需要正确。

#### ✅ 4.6 分页和滚动位置（已完成 · 2026-09-19 用户确认）

历史上多处存在“翻到下一页仍在尾部”的问题，需统一检查：

- 搜索结果分页。
- 发现结果分页。
- 换源结果。
- 详情页完整目录分页或跳转。
- 下一章/上一章切换。

所有分页切换后应明确执行目标页容器的 `scrollTop = 0`，但不能破坏详情页回到原章节的行为。

**2026-09-19 用户确认通过**

- 搜索结果分页、发现结果分页原先用「从旧位置缓动回顶部」（90~220ms，距离越远越久），
  用户反馈「又生硬又缓慢」；根因是动画期间用户要盯着新页内容往上滚，而不是页本身跳转慢。
- 已改为与 legado `ExploreShowActivity` / `SearchActivity` 等价的语义：**数据换完瞬时 `scrollTop = 0`**，
  只保留一次 140ms 淡入（`.list-swap-in`，`prefers-reduced-motion` 时连淡入也去掉），
  实现见 `public/online.js` 的 `scrollToTopSmooth()` 与 `public/online.css` 的 `@keyframes listSwapIn`。
- 书架分页（`bkOnRenderedPage`）、换源列表（流式增量、无分页）已确认不涉及该问题。
- 发现页 select（线路/类型/频道/平台）：**标签靠左、下拉框内容居中**。headless Edge 实测
  `label left=431 → select left=465`、`text-align:center`、`justify-content:flex-start`，
  四项均符合；用户如仍看到旧样式，强刷一次即可（静态资源已是 `cache-control: no-store`）。

#### ✅ 4.7 评论图片加载和尺寸（已完成 · 2026-09-19）

- 晴天番茄段评弹窗原先显示多个方框“❌”，根因不是评论数据缺失，而是 `srcdoc` 没有正确加载评论页引用的
  Font Awesome 图标字体：外部 CSS 的 `@font-face` 相对 `../webfonts/*.woff2` 地址在桌面端失效。
- `public/online.js` 的 `chInjectBridge()` 现在会把评论页 stylesheet/preload 资源改走 `/api/online/proxy`，
  保留书源原有 HTML/CSS/JS 和点击逻辑；同时补充 Font Awesome 6/5 的字体回退声明，旧服务进程也能正常加载图标。
- `server.mjs` 的代理对 CSS 中的相对 `url()` 做绝对化代理重写，字体、背景图等资源继续带正确的源站 Referer/Cookie，
  不再因为跨域或相对路径退化成缺字方框。
- 2026-09-19 在当前 `http://127.0.0.1:7788/` 用真实 `get_para_review` 评论页回归：引用、默认/最热/最新、极简/主题、用户、爱心、
  展开回复等图标均正常显示，排序按钮仍可见且可点击；评论图片和 `showCmt` 弹窗逻辑未被正文图片解析吞掉。
- 评论弹窗仍统一使用站内窗口规格（`760px / 82vh` 上限），不会被书源参数撑满屏幕。

#### ✅ 4.8 书架管理页面（已完成 · 2026-09-19 用户确认）

- 书架管理页面的详情返回路径和关闭按钮仍需回归，历史上存在点击详情后不能回到管理页、关闭按钮延迟卡顿。
- “更多操作”菜单曾无法打开，需要检查事件委托、弹层层级和关闭事件。
- 书架管理底部不应再有“加入分组”功能，相关 UI、事件和后端逻辑应彻底移除或确认已经移除。
- 一键换源和书架管理两个按钮需要和上方按钮同一行、同等尺寸、撑满行宽，不能右侧留大块空白。
- 删除确认弹窗应位于屏幕正中间。
- 书架顺序应按加入时间/用户拖动顺序稳定保存。

#### ✅ 4.9 书源管理和导入（已完成 · 2026-09-19 用户确认）

- 书源排序、拖动后的持久化和重启恢复需要验证。
- 搜索、发现和换源只应使用启用源；登录、调试和手动操作仍可打开停用源，这是有意设计，需保持一致。
- 导入书源预览需要覆盖 URL 导入、文件导入和文本导入三种入口。
- 书源集合中已存在的源要正确标识，重复导入不能覆盖用户的启用状态、顺序和登录态。

#### ✅ 4.10 登录窗口和网页交互（已完成 · 2026-09-19 用户确认）

- 光遇登录窗口关闭后再次点击其它区域，应明确提示“已打开书源窗口，请在其中完成操作后再刷新分类”。
- 番茄登录不能只打开空白窗口，必须能滚动、输入和点击登录按钮。
- 光遇发现页“登录番茄”不能停留在番茄首页，应直接打开番茄登录页；源文件中的动作仍保持原样，由桌面端按 legado 语义适配。
- 晴天内置浏览器需要验证鼠标点击、拖动、滚轮和登录按钮可见性。
- 登录成功提示不能只依赖页面文字，要同时检查实际 Cookie/登录头/登录检查结果。
- 登录页面乱码和排版问题需要继续检查其它书源页面，不能只修一个源。

### P2：界面和体验收尾

#### ✅ 4.11 详情页（已完成 · 2026-09-19 用户确认）

- 详情页窗口尺寸与发现页、评论窗口、目录窗口统一。
- 左侧 6 个操作按钮需要统一尺寸、对齐和视觉样式，不能只有第一排样式正常。
- 中间区域只保留简介，目录移动到左侧按钮和“查看完整目录”弹窗。
- 详情页“加入书架/移除书架”状态必须实时对应当前书架状态。
- 返回、关闭和详情窗口切换不能有明显延迟。
- 2026-09-19 实测（headless Edge）：六个按钮 `biAdd`/`biRead`/`biSwap`/`biExport`/`biTocView`/`biReload`
  尺寸完全一致（80×38，13px，圆角 8px），左栏两列排布；中间内容区只剩简介，
  目录已移到左栏「查看目录」弹窗；《盘龙》在书架内显示「删除书籍」，未在书架时显示「放入书架」。

#### ✅ 4.12 书架显示（已完成 · 2026-09-19 用户确认）

- 在线书架上方不显示“在线书架（书源）”文字。
- 单页布局目标为刚好显示 6 本书，需在实际浏览器窗口和缩放比例下验证，而不是只按 CSS 理论高度计算。
- 书架条目左侧封面、右侧书名/作者/来源和简介的比例要保持稳定。
- “读到”显示最近阅读章节；未开始阅读时显示第一章；另显示最新章节章节名。
- 不能再出现书名后的异常 `99+` 提示。

#### ✅ 4.13 本地/在线模式导航（2026-09-19 用户确认完成）

- 本地阅读模式顶部不显示“搜索、书源、发现”。
- 在线模式不显示“未导入书架”之类的无关框。
- 本地和在线模式切换时不能丢失当前书架、窗口状态和阅读进度。

#### ✅ 4.14 导出 TXT（已完成 · 2026-09-19）

- 已有导出参数弹窗：并发数、章间隔、当前章节/总章节、成功/失败数量、实时进度条和逐章日志。
- 并发数在前端和后端均有限制；导出失败会保留已完成章节并记录失败项。
- 速读谷²等源可标记并拦截导出，界面文案统一为“禁止导出 TXT 小说”。

#### ✅ 4.15 净化规则（已完成 · 2026-09-19 用户确认取消勾选能恢复原文）

已完成并实测：

- 顶部搜索框文案精简为「搜索规则…」，去掉旧截图里的一长串“（已启用 / 已禁用 / 未分组 …）”。
- 移除「分组管理」按钮及对应的 `openGroupManage()` 死代码（含“分组管理”残留关键字）。
- 内置净化规则在 `sources/builtin-replace-rules.json` 中现为 21 条（新增 `#00 数字标题#JS`）；运行时默认只启用用户勾选的 6 条（`#00`、`#13`~`#17`），其余全部关闭，必须由用户手动勾选才生效。
- 新增一次性迁移 `migrateBuiltinReplaceRules()`（`server.mjs`）：旧配置里默认启用的 #01/#13~#17 已全部关闭，
  用户自建规则状态不受影响；迁移标记 `builtinReplaceDefaultDisabledMigrated` 已写入配置。
- 内置规则只作为“候选规则”存在，必须由用户在界面勾选“启用”后才生效，不是强制全开。
- 规则开关可逆：实测盘龙第 1 章正文 8123 → 启用 #17 后 8122 → 关闭后回到 8123。
- 清缓存真实生效：实测 `cache/toc` 目录文件 2 → 0，再请求正文时按需回源重建 1 个。
- scope 作用域按 legado `ReplaceRuleDao` 的 SQL `LIKE` 语义重写 `ruleInScope`（支持 `%`/`_` 通配、ASCII 大小写不敏感、
  scope 为 NULL 或空串时命中、excludeScope 命中即排除）。实测书名命中生效、书名不命中不生效。

结论（2026-09-19 已实测闭环）：
- 段评气泡保持 32x32；晴天「神评论」506x55、「本章说」506x325，均小于 960px 正文列且缩放后内嵌字号略小于 26px 正文。
- 点击「本章说」横幅仍可打开「评论区」弹窗（标题正确、评论列表正常）。

#### ✅ 4.16 评论区首次打开白屏（已完成 · 2026-09-19）

**问题现象**

- 光遇聚合书源的评论入口点击后，评论弹窗会先出现一整片白色区域，过一会才显示评论正文、头像和图片。
- 同一弹窗最终能够正常加载，说明评论接口和书源规则本身没有坏，坏的是弹窗打开阶段的加载反馈。

**具体原因**

- 评论入口走的是 `java.showBrowser` / `actions[].type=openUrl`，前端由 `chOpenAction()` 用 `iframe.srcdoc` 还原评论页。
- 评论页不是一张已经渲染好的静态 HTML，而是异步 SPA：先加载 HTML、外部字体/样式，再在 `DOMContentLoaded` 后调用 `loadComments()` 请求评论接口。
- 旧实现直接创建白色 iframe，没有自己的加载遮罩；在外部 CSS、字体和评论接口返回之前，iframe 的可视区域就是空白。
- 源站本身响应较慢时，这个空白阶段会被放大，所以看起来像“点击后白屏，过一会才加载”。

**解决方法**

- `Reader/public/online.js` 的 `chOpenAction()`：弹窗创建时立即加入 `.ch-modal-loading` 遮罩，评论区显示「正在加载评论区…」，其他书源窗口显示「正在加载…」。
- iframe 放在 `.ch-modal-stage` 中，遮罩覆盖在 iframe 上方；轮询检查 iframe 的 `contentDocument.readyState`，只有页面脱离 loading 且出现可见文本、图片、视频、画布、SVG 或交互控件后，才淡出遮罩。
- 判断可见文本时只使用 `innerText`，不使用 `textContent`；否则 `<script>` 源码会被误判成页面内容，导致遮罩提前消失。
- 8 秒后仍未完成时显示「源站响应较慢，请稍候…」；30 秒兜底撤掉遮罩，避免评论页异常时永久遮挡。
- `Reader/public/online.css` 新增 `.ch-modal-stage`、`.ch-modal-frame`、`.ch-modal-loading` 和旋转指示器样式，保持评论窗口原有 `760px / 82vh` 尺寸不变。

**验证记录**

- 合成慢页面：2 秒后才写入正文；120ms、620ms 时遮罩仍存在，2.2 秒正文出现后遮罩才进入淡出。
- 真实光遇聚合/番茄《我不是戏神》评论页：弹窗标题为「评论区」，最终显示 64 条评论、20 条评论项，无首帧白屏。
- 真实回归还确认了评论页自己的「正在加载评论...」指示器会接替外层遮罩，直到评论列表出现。
- `node --check Reader/public/online.js` 通过；HTTP 服务的 `/online.js`、`/online.css` 已返回新版本。

#### ✅ 4.17 光遇聚合发现页完整榜单丢失与恢复（已完成 · 2026-09-19）

**问题现象**

- 光遇聚合发现页一度只剩「线路 / 类型 / 频道 / 平台 / 搜索」筛选框和几个按钮，番茄相关榜单（巅峰榜、黑马榜……）与热门标签全部消失。
- 用户明确指出历史上该页面完整显示过榜单，且曾要求把「线路 / 类型 / 频道 / 平台」的**框内内容**居中。

**具体原因**

- 榜单列表由书源 `exploreUrl` 脚本提供：脚本内 `java.ajax(base_url + '/discovestyle?...')` 返回的 `style_list` 中包含 12 个榜位和全部热门标签。
- `v1~v7.gyks.cf` 全线 502 后，该调用抛异常被脚本 try/catch 吞掉，`style_list` 为空，重新生成的分类只剩静态筛选框。
- 2026-09-19 凌晨排查登录 / 评论区期间，刷新路径触发 `clearExploreKindsCache()` 并重跑脚本；这份残缺结果覆盖了磁盘缓存，`.good` 也被同步覆盖，完整备份不可用。
- 结论：**不是从未成功过，而是完整缓存被残缺结果覆盖**。

**恢复过程**

- 流式扫描会话日志 `C:/Users/xidian/.codex/sessions/2026/09/17/rollout-2026-09-17T14-55-34-01a0ae26-3291-7f30-b611-3593cbc8de26.jsonl` 第 85882 行（2026-09-18T23:02:48Z），其中包含当时对 `Reader/cache/explore/627715079` 的完整 dump。
- 提取并落盘 `.scratch/recovered-gy-kinds.json`（103,627 字节 / 388 项，358 项带 url，host 统一为 `v4.gyks.cf`），核对结构与 `explore.mjs` 读取格式一致。
- 备份残缺版到 `.scratch/broken-gy-kinds-11items-backup.json`，再将完整版写回 `Reader/cache/explore/627715079` 与 `627715079.good`。

**验证记录**

- 接口：`GET /api/online/explore/kinds?source=光遇聚合` 返回 `ok=true`、388 项，榜单与标签齐全。
- UI：headless Edge 渲染 380 个 chip + 4 个按钮；截图 `.scratch/gy-explore-verify.png` 可见 12 个榜位与全部热门标签。
- 保护：`keepBetterKinds()`（带 url 入口数优先）与 `.good` 兜底继续生效，残缺结果不会再覆盖完整缓存。
#### ✅ 4.18 光遇聚合「全部 502」根因排查与修复（已完成 · 2026-09-19）

**问题现象**

- 发现页分类能显示（缓存恢复后），但**点击榜单加载不出书**；搜索同样失败。
- 后端直接调 `GET /api/online/explore`（巅峰榜）返回：`ok=true, books=[], meta.status=502`（快速返回，非超时）。
- 先前版本前端在书单为空时会抛异常（`exploreEmptyMessage` 未定义），卡在「加载中…」；已单独修复（见更新日志）。
- 关键对照：**用户手机 legado 能正常加载**（含重装 App、重新导入书源后）；用户手机浏览器直开同一接口也是 502，且**未开 VPN**。

**排查过程（按时间顺序）**

1. **确认上游故障范围**：
   - v1~v7 域名线路的 `/get_discover` `/discovestyle` `/search` 全部 502；
   - 2 个 IP 直连线路（101.35.133.34:8888 / 103.236.85.221:8888）连接超时；
   - `/static/source_config/config.json`（带随机参数）**200** —— 说明服务器本体没关，初步看像「动态接口后端挂了」。
2. **排除客户端因素**：浏览器 UA 与 okhttp UA、多个 Cloudflare 节点 IP、第三方海外代理出口（allorigins）——均失败，初步怀疑「服务器真坏了」。
3. **缓存假设与证伪**：用户反馈「重装 App + 重新导入书源后手机依然能加载」（新装应无缓存）——缓存假设不能完全解释，改从「请求差异」入手。
4. **读书源 jsLib（146KB 公共库）**，发现三个关键机制：
   - 内置 9 条线路清单（`hosts`）与 **失败自动切换线路**重试（`request()` 内 `switchToNextLine` 递归）；
   - `request()` 发请求时**必带认证头**：`cookie: qttoken=...;deviceId=...`；
   - `getToken()` 从 CookieStore 读取 `gyks.cf` 域的 `qttoken`。
5. **关键假设与验证**：服务器可能只对「带登录凭证」的请求返回数据。读本地 `Reader/cache/login-state.json`，发现 `gyks.cf` 桶里存着 `deviceId=...; qttoken=...`（用户之前登录晴天/光遇时留下）。
6. **带 Cookie 直测→破案**：
   - `GET /discovestyle?...` + Cookie → **200**（65KB JSON）；
   - `GET /get_discover?...`（巅峰榜）+ Cookie → **200**（24KB，含书单）；
   - `GET /search...` + Cookie → **200**（274KB 结果）。
   - 结论：上游没坏！**无凭证请求被服务器拒绝（伪装成 502）**。
7. **定位我们代码的 bug**：本地明明存着 Cookie，为什么请求时没带？
   - 追请求链：`java.ajax` → `JsNetwork.ajax` → `AnalyzeUrl` → `_buildHeaders()`；
   - `_buildHeaders()` 用 `this.cookieStore.getCookie(this.domain)` 取 Cookie；
   - 而 `this.domain = getSubDomain(this.source.bookSourceUrl)` —— 光遇聚合的 `bookSourceUrl` 是字面量 **「光遇聚合」**（不是网址），归一化后仍是「光遇聚合」→ 去「光遇聚合」桶找——而凭证存在「**gyks.cf**」桶里 → 取空 → 请求不带 Cookie → 全部 502。
8. **对照 legado 源码确认正确语义**：
   - `CookieManager.loadRequest(request)`：`NetworkUtils.getSubDomain(request.url)`——**用实际请求 URL**；
   - `CookieManager.saveResponse(response)`：用 `response.request.url`；
   - 实例：`this.source.bookSourceUrl` 在 legado 里只用于其他语义，不参与 Cookie 域计算。

**最终根因（两层）**

1. **服务器侧**：gyks.cf 的数据接口对「无登录凭证」的请求返回 502（以 Cloudflare 错误页伪装），对带 `deviceId+qttoken` Cookie 的请求正常返回数据。
2. **客户端（我们）**：`AnalyzeUrl` 取 Cookie 时用 `source.bookSourceUrl`（字面量「光遇聚合」）而非实际请求 URL 归一化域名，导致已登录的 Cookie 永远取不到、永远不上车。

**解决方法**

- 文件：`Reader/src/analyze-url.mjs`
- 新增方法：`_cookieDomain()` —— 用 `getSubDomain(this.url || this.urlNoQuery)`（实际请求 URL）归一化，失败时回退 `this.domain`；
- 替换两处调用点：`_buildHeaders()`（请求前加 Cookie）与 `_saveCookies()`（响应后写 Cookie）；
- 注释里标明对照 `CookieManager.loadRequest/saveResponse` 语义，避免后续回归。

**验证记录**

| 验证项 | 结果 |
| --- | --- |
| v1~v7 直连（带 Cookie） | **全部 200**（0.7~1.0s） |
| `GET /api/online/explore`（巅峰榜） | ok=true、**30 本书**、meta.status=200 |
| headless Edge 点击「巅峰榜」 | 书列表渲染成功（封面/书名/作者/简介） |
| `POST /api/online/search`「斗破苍穹」 | **364 条结果**（3 个失败源，不影响） |
| 光遇聚合条目 | 182 条 |

**影响范围**

- 相同机制受影响的书源（`bookSourceUrl` 为字面量）：光遇聚合、UU小说、免费看书（31 个书源中 3 个）；
- 一般书源（bookSourceUrl 为网址）不受影响，但统一走 `_cookieDomain()` 后行为一致。

**经验教训**

- **502 不一定是服务器坏了**：本例中它是「鉴权失败」的伪装；判定上游故障前，必须先排除「凭证/登录态」变量。
- **对照手机 legado 行为时，要注意它带着登录态**：手机能用→先查「手机有什么我们没有」（Cookie/字段/环境），而不是先怀疑网络。
- **书源 URL 是字面量的书源是高危区**：任何「用 bookSourceUrl 归一化域名」的写法在这类书源上都会失效，必须用实际请求 URL。
- 排查顺序建议：现象复现 → 排除网络/节点/UA → 读书源脚本与 jsLib → 检查存储的凭证 → 带凭证直测 → 对照 legado 源码定位语义差异。

#### ✅ 4.19 大书解析提速（已完成 · 2026-09-20）

**问题现象**

- 书架已经能秒出，但打开一本 30MB+ 的 TXT，`/api/book` 仍要 **897~1675ms** 才返回目录，是首屏之后最大的一块等待。
- 现象集中在「章节数多的大书」：5290 章、5597 章的书明显慢，几千章以下感知不强。

**排查过程（按时间顺序）**

1. **先分段剖析，确认慢在哪一段**：`阅读器/.scratch/profile-book.mjs` 对单本逐段计时 —— 文件读取、分章正则、标题净化、组装响应各占多少。
2. **锁定标题净化**：分章本身很快，慢的是对**每一章标题**跑一遍启用中的替换规则。
3. **对照实验（5290 个真实标题）**：

| 做法 | 5290 个标题耗时 |
| --- | --- |
| 原实现：每标题一次 `runInContext({ timeout })` | 616 ms |
| 去掉 `timeout` 参数 | 150 ms |
| **整批一次执行 + 一次 `timeout`** | **49 ms** |

4. **根因确认**：`vm.runInContext` 每带一次 `timeout` 就挂一个中断看门狗，固定开销约 **113µs**；乘 5290 章 ≈ 600ms。**不是脚本慢，是看门狗收费。**
5. **对照 legado**：`RegexExtensions.kt` 里超时是**整条规则一个 deadline**（`select { job.onJoin / onTimeout }` 包住整个 matcher 循环），不是每个匹配点单独计时。原实现比 legado 更碎、更慢。

**解决方法**

- 文件：`阅读器/src/replace-engine.mjs` + `Reader/src/replace-engine.mjs`（两份 hash 一致）
  - 新增导出函数 `replaceManyWithRule(o)`：接收 `o.texts` 数组（可选 `o.chapters` / `o.books`），返回等长数组，`null` = 该条失败；
  - 内部 `JS_BATCH_SCRIPT` 在一次 vm 调用里循环 eval 全部输入，每条仍用 `(function(){ return eval(__code); })()` 保持独立函数作用域（与 legado「每个匹配点一次 eval」语义一致）；
  - `JS_BATCH_CHUNK = 256` 分块。
- 安全阀：
  - 含 `java` 的脚本自动退回逐条（`java.put/get` 状态是每条一份，跨条共享会串状态）——实测当前 5 条 `@js` 规则 bare-java 命中数全为 0，不走此路径；
  - 某块批量超时后 `batchUsable = false`，剩余块直接逐条；整批超时 → 退回逐条；逐条再超时 → 抛 `RegexTimeoutError`；
  - 调用方按 legado `BookChapter.getDisplayTitle` 语义把超时规则 `isEnabled = false` 落库。
- 文件：两个 `server.mjs`
  - 新增 `applyTitleRulesBatch(titles, bookName, origin)`：按规则顺序批量净化，结果非空才采纳，单条规则超时即禁用并 `saveConfig()`；
  - `localDisplayChapters()` 改为「收集所有标题 → 一次批量净化 → 回填」。

**实测结果**

冷解析（重启服务后逐本请求）：

| 项目 | 书 | 大小 | 章节 | 改前 | 改后 |
| --- | --- | --- | --- | --- | --- |
| 7789 | 末世神魔录 | 36.3MB | 5290 | 975 ms | **247 ms** |
| 7789 | 末世庇护所 | 30.7MB | — | — | 283 ms |
| 7789 | 无限进化 | 26.1MB | — | — | 174 ms |
| 7789 | 冰封末世 | 23.2MB | — | — | 176 ms |
| 7788 | 踏星 | 51.7MB | 5597 | 1102 ms | **453 ms** |
| 7788 | 守卫者之星际狂飙 | 39.0MB | 5797 | — | 389 ms |
| 7788 | 重生之星空巨蚊 | 41.2MB | 3563 | — | 277 ms |
| 7788 | 进化的四十六亿重奏 | 35.9MB | 4827 | — | 269 ms |
| 7788 | 修真四万年 | 34.2MB | 3291 | — | 188 ms |
| 7788 | 招黑体质开局修行在废土 | 29.7MB | 3120 | — | 204 ms |
| 7788 | 希灵帝国 | 24.2MB | 1676 | — | 116 ms |

热命中 9~17ms。标题净化单独对照：批量 80ms / 逐条 655ms / **差异 0**。

**验证记录**

| 验证项 | 结果 |
| --- | --- |
| `verify-batch-equivalence.mjs`（21 条规则 × 全部标题类型，4236 项） | **0 差异** |
| `verify-batch-edge.mjs`（16 项边界：捕获组、命名组、`$$`、反斜杠、js 返回 null/undefined/抛错、空匹配、`chapter` 绑定、`java.put`、字面量、病态规则超时） | **ALL PASS** |
| `verify-realbook-titles.mjs`（真实 5290 标题批量 vs 逐条） | **0 差异** |
| `verify-timeout-semantics.mjs`（病态规则 622ms 抛 `RegexTimeoutError`） | **PASS** |
| `verify-bookshelf-snapshot.mjs` | 10/10 |
| `verify-clear-cache-safety.mjs`（Cookies/localStorage 均保留） | PASS |
| `verify-idle-cleanup.mjs` / `verify-reading-after-cache-change.mjs` / `verify-open-latency.mjs` | 8/8 · 5/5 · 7/7 |
| 线上抽查 7789 `末世神魔录` | 5290 章，首章 `第 0001 章 大雾，车祸`，末章 `第 5298 章 最终的选择！【全书完】` |
| 线上抽查 7788 `踏星` | 5597 章，首章 `第 1 章 陆隐`，末章 `第 5590 章 欢迎回家` |

**影响范围**

- 两个阅读器的本地 TXT 分章标题净化路径（`localDisplayChapters`）；在线书源目录不走这条路径，不受影响。
- 正文净化仍走原逐条实现（正文只处理当前章，无批量收益）。
- 未改变任何规则语义与启用状态；用户配置 `reader.config.json` 未改动。

**遗留**

- Reader 侧部分书放在 USB 移动硬盘上，冷读文件本身仍占 361~636ms（`修真四万年` / `招黑体质` / `希灵帝国`），标题净化已降到 27~100ms。如需继续压，可考虑打开书架时后台预热常用大书。

#### ✅ 4.20 代码审查 M1–M4（静态资源 / 坏目录判据 / 自愈负缓存 / URL 选项，已完成 · 2026-09-20）

**问题与修复**

| 项 | 原问题 | 修复 |
| --- | --- | --- |
| M1 | `abs.startsWith(PUBLIC_DIR)` 少分隔符，存在前缀误配与编码路径风险 | 两个服务均改为 `path.relative()` 包含判断；malformed URI decode 返回 403 |
| M2 | 任意空查询参数都判坏目录，合法 `?x=&y=1` 会误触发详情重抓 | 仅 id 类参数为空、或同参数在 bookUrl 有非空值时判坏 |
| M3 | 自愈失败负缓存空串永久生效，站点恢复后不重试 | 失败记录加 10 分钟 TTL；成功结果仍常驻进程内存 |
| M4 | 裸 bookUrl 自愈只补 headers，静态 method/body 无法补 | 新增静态完整选项移植；动态 `bookId={$.bookId}` 明确拒绝，仍走精确搜索 |

**验证**

- `node --check Reader/server.mjs`、`node --check 阅读器/server.mjs`：通过。
- M1 原始 HTTP 越界向量：7788 / 7789 的 `..%5c`、`%2e%2e%5c`、`%2e%2e%2f` 全部 403；`/index.html` 全部 200。
- M2–M4 针对性断言：8/8 PASS（普通空参数不误判、id 空参判坏、负缓存过期重试、静态完整选项可移植、动态选项拒绝、headers 兜底）。
- 阅读回归：`.scratch/verify-shelf-page-sync.mjs` **14/14 PASS**。
- 服务状态：7788（Reader）/ 7789（阅读器）已重启并监听。

#### ✅ 4.21 在线正文首次打开提速（已完成 · 2026-09-20）

**背景**

- 用户确认：服务重启后内存缓存为空导致第一轮慢是正常现象，但希望提高第一次打开速度。
- 实测瓶颈：正文冷回源主要来自源站（约 0.85–3s，视章节而定）；缓存命中路径中，前端仍要等待书架、目录和正文多段串行请求，目录接口本身也有重复成本。

**改动**

1. **启动预热最近阅读**
   - `Reader/server.mjs` 新增 `warmRecentOnlineReading()`。
   - 服务监听成功后 `setImmediate()` 后台预热最近阅读书的当前章 + 后 2 章。
   - 预热走本机 `/api/online/content`，与真实阅读共用目录自愈、登录、净化与缓存语义；单章 30s 超时，任一章失败即停止后续。
2. **启动后台预热书架**
   - 新增 `warmOnlineShelfBooks()`。
   - 最近阅读预热完成后，书架全部书按最近阅读时间排序，逐本预热当前章 + 下一章。
   - 只预热两章，不整本抓取；已缓存章节直接命中持久缓存，只有真实回源后书与书之间才短暂等待 150ms，避免启动时打满源站。
   - 实测当前书架 **17/17 本**全部预热完成。
3. **清理缓存后自动预热**
   - `POST /api/online/cache/clear` 清空正文 / 目录 / 发现分类缓存后，立即后台触发同一套预热流程。
   - 前端提示「正在后台预热书架」；用户马上打开书时，同章节请求会复用 `contentInflight`，避免重复等待。
   - 该行为只发生在用户明确点击清理缓存之后，不是无条件批量联网。
4. **同章在飞请求去重**
   - 新增 `contentInflight`。
   - 同一章节的非刷新请求复用同一个 Promise，避免启动预热和用户首次打开同时请求同一章时重复打源站。
5. **打开书链路瘦身**
   - `Reader/public/online.js` 的 `openBook()` 在书架记录已有 `tocUrl` 时不再额外请求 `/api/online/book`。
   - `gotoChapter()` 前提前调用 `fetchChapter()`；目录渲染、书架刷新、左侧栏同步不再阻塞正文请求发起。
6. **文本响应 gzip**
   - `send()` 对 JSON / JS / CSS / SVG 等文本类型启用 gzip（压缩后确实变小才启用）。
   - 实测：书架 288,095B → 97,766B；目录 1,156,685B → 113,945B；正文 112,214B → 15,484B。
7. **静态资源 ETag**
   - `serveStatic()` 按 size + mtime 生成弱 ETag，`If-None-Match` 命中返回 304。
   - 静态资源 `Cache-Control` 从 `no-store` 改为 `no-cache`，文件不变时浏览器可复用本地缓存，文件变化时 ETag 变化仍会重新拉取。
8. **在线目录标题净化批量化**
   - `displayChapters()` 改用已有 `applyTitleRulesBatch()`，一次批量处理全书标题，不再逐章调用 `applyTitleRules()`。
   - 原始 TOC 缓存仍存原始标题，返回时实时套 `scopeTitle` 规则，编辑/取消规则后仍立即生效。

**实测**

| 指标 | 改前 | 改后 |
| --- | ---: | ---: |
| 目录接口（1483 章，gzip 后） | 229–236 ms | **32–39 ms** |
| 目录批量净化结果对比 | — | **1483 章 0 差异** |
| 正文响应传输 | 112,214 B | **15,484 B** |
| 首次正文渲染（正式 7788） | 约 0.8–0.9 s | **629 ms** |
| 静态资源重验证 | 每次重传 | **304 Not Modified** |

**验证**

- `node --check Reader/server.mjs`：通过。
- `.scratch/verify-online-first-open.mjs`：正式 7788 实测首次正文渲染 **629ms**，目录 55ms、正文 159ms。
- 启动后台书架预热：正式 7788 实测 **17/17 本**完成，日志输出 `书架正文预热完成：17/17 本`。
- `.scratch/verify-shelf-page-sync.mjs`：**14/14 PASS**。
- gzip / ETag 冒烟：`/api/online/shelf` 返回 `content-encoding: gzip`；`/online.js` 带 ETag，二次请求返回 `304 Not Modified`。
- 基础接口冒烟：`/api/state`、`/api/sources`、`/api/source-groups`、`/api/replace-rules`、`/api/txt-toc-rules` 均正常返回 JSON 并可解析。

**边界说明**

- 如果当前章从未缓存且源站本身需要 2–3s 才返回，无法凭客户端把源站响应变快；预热和去重保证服务启动后尽早开始请求，用户打开时复用在飞请求，避免重复等待。
- `refresh=1` 仍强制回源并覆盖缓存，语义不变。
- 本项只改 Reader / 7788 在线链路；阅读器 / 7789 的本地快照与本地大书解析优化此前已完成，未盲目同步在线专属逻辑。

#### ✅ 4.22 远距离跳章 + 速读谷风控回退（代码完成 · 待用户侧解封复测 · 2026-09-20）

**问题现象**

- 第一阶段：从第 10 章直接点第 57 章，误走滚轮连续滚动动画，既慢又生硬。
- 第二阶段：为提速新增「目录悬停 / 按下预取任意章」后，速读谷 / 速读谷² 远跳无反馈并弹出 `AggregateError`；其它响应快的站点正常。用户确认该站历史上并发下载太快也会封 IP。

**根因**

1. 目录点击、按钮跳章、键盘跳章、进度条跳章等都走同一条翻章路径，没有区分操作手势；远跳被误做成连续滚动。
2. 第一版修复时新增任意章 hover / pointerdown 预取。用户扫视目录会触发多次未点击章节请求；速读谷有风控，请求量放大后被临时封 IP。
3. 在飞 Promise 被仅按 `chapterCache.has()` 判断为“已缓存”，界面因此没有 loading；同时章节状态过早切换，失败后 UI/进度/目录 active 停在错误章。

**修改**

- `Reader/public/app.js`
  - 保留 `gesture` 区分：滚轮跨界仍走连续阅读动画；目录 / 按钮 / 键盘 / 进度条远跳一律 `direct` 瞬时换章。
  - `runChapter()` 增加 `chapterRunSeq` / `reqSeq`，只有最后一次用户选择的章节能落 UI。
  - 正文成功返回后才更新 `state.chapterIdx`；失败或被新请求打断时旧章状态与旧正文保持一致。
- `Reader/public/online.js`
  - 完全删除 `onlineJumpPrefetch*` 与 `.toc-item` / `.tocm-item` 的 hover / pointerdown 预取监听。
  - 对齐 legado `ReadBook.loadContent()`：只处理当前章与前后一章；未点击的远章不请求。
  - `fetchChapter()` 给 Promise 标记 `__readerSettled`；pending、失败、未请求都会给出正确 loading / 重试行为。
  - `humanizeNetError()` 把 `AggregateError` / 超时 / 断连翻译为可读提示，不再把底层异常名直接抛给用户。
- `Reader/public/online.css`
  - 新增 `.ch-loading` / `.ch-loading-error` 与加载动画。
- `Reader/src/book-pool.mjs`
  - 追加对齐 legado `ConcurrentRateLimiter` 的进程级语义：配置了 `concurrentRate` 的书源按 source key 固定到同一个 worker，避免每个 worker 各自维护一份限速记录导致实际并发被放大；未限速书源仍走原忙闲轮询。
- `Reader/server.mjs`
  - 启动预热和「清缓存后重建」预热跳过 `noExport=true` 的书源，避免后台任务在用户未显式打开书时请求这类已知容易触发风控的站点。
- 书源配置：`sources/book-sources.json`、`sources/shuyuan-default.json`、书源组1 / 书源组2 中全部速读谷来源统一 `concurrentRate=1/2000`、`noExport=true`。

**验证**

| 验证项 | 结果 |
| --- | --- |
| `node --check Reader/public/app.js` | 通过 |
| `node --check Reader/public/online.js` | 通过 |
| `.scratch/verify-far-jump-direct.mjs` | **5/5 PASS** |
| 第 1 章目录直接跳第 58 章 | `state.chapterIdx` 正确变为目标章，`flipRAF=0`，无连续滚动动画 |
| 目录条目悬停预取 | **0 请求**，`calls=[]`，不再扫射源站 |
| pending 远跳 | 100ms 后显示 loading；请求中 `state.chapterIdx` / `chRenderedIdx` 均留在旧章；Promise 完成才切换 |
| `AggregateError` 失败 | 状态和正文均留在旧章，toast 显示「书源站点无法访问（可能已被封 IP，或需要代理 / VPN）」 |
| `.scratch/verify-shelf-page-sync.mjs` | 固定选非速读谷来源后 **14/14 PASS**；脚本不再请求速读谷 |
| 源级限速 | `1/2000` 纯本地实测 3 次访问间隔 0 / 2010 / 2015ms |
| 限速书源 worker 固定 | `node --check` 通过；同一 source key 连续 20 次映射同一 slot，未限速 / 未匹配 source 返回不固定；`BookPool` 固定 slot 断言通过 |
| 后台预热保护 | `noExport=true` 的速读谷系列不进入启动 / 清缓存预热；点击阅读仍走正常请求与源级限速 |
| 服务状态 | 7788 已优雅重启并运行新代码（PID 52992），启动日志 `书架正文预热完成：13/13 本`（17 本书架中 4 本速读谷系列按保护规则跳过）；7789 未改、仍在监听（PID 13140） |

**边界说明**

- 如果目标章从未缓存且源站本身需要 2–3 秒返回，网络等待仍存在；本次只消除误用慢动画、请求放大、pending 无反馈和失败状态错位。
- 当前 IP 已被速读谷临时封禁，代码层不再主动请求真实站点；等解封或换网络后，让用户只点一个远章节复测，不做连续跳章和导出。
- 7789 本地阅读器未同步该在线专属逻辑，避免引入在线书源行为。

## 5. 剩余任务的建议处理顺序

已完成项（盘龙正文、晴天番茄正文与登录态、净化规则可逆、书架/详情细节、光遇聚合发现页 / 榜单、远距离跳章）不再重复做。
光遇聚合发现页与榜单接口已按实际请求 URL 取 Cookie（对齐 legado CookieManager 语义）修复；完整榜单入口 388 项仍在磁盘缓存中，缓存保护（`keepBetterKinds` + `.good`）保留，避免残缺结果覆盖。

1. ~~换源 / 一键换源真正生效~~ ✅ 已完成（2026-09-19 用户确认；一键换源缺失目标源处理 + 结果面板已实现）。
2. ~~**本地切书性能**~~ ✅ 已完成代码核对与 headless 实测（见更新日志）。
3. ~~登录窗口交互收尾~~ ✅ 已完成（2026-09-19；番茄验证码滑块可正常拖动，见更新日志）。
4. ~~评论区图片尺寸最后回归~~ ✅ 已完成（2026-09-19；晴天番茄真实评论页已确认原始图标字体和评论交互正常）。
5. ~~分页与滚动位置~~ ✅ 已完成（2026-09-19 用户确认；搜索结果、发现页翻页及本地/在线导航均已确认）。
6. ~~**WebView 缓存体积**~~ ✅ 已完成（2026-09-20；白名单清理 + 启动参数限制，实测释放 672.6MB、登录态无损）。
7. ~~**大书解析提速（`/api/book`）**~~ ✅ 已完成（2026-09-20；标题净化批量化，5290 章 975ms→247ms、5597 章 1102ms→453ms，见 4.19）。
8. ~~**换源残留坏记录导致正文 EISDIR**~~ ✅ 已完成（2026-09-20；换源时旧记录未清理导致同名同作者双记录、去重命中坏记录、路径退化到书架根目录。已加坏 URL 识别 + 启动自动去重 + 换源清理旧记录 + 多命中取最优，见更新日志顶部）。
9. ~~**刷新后书架分页回退 + 新书条目缺「读到 / 最新」**~~ ✅ 已完成（2026-09-20；`enterMode()` 写死第 1 页、`initOnline()` 恢复阅读时不校分页、`openBook()` 抓完目录不重拉书架接口三处根因已修；`server.mjs` 抓完目录立刻回写章节总数/读到/最新。`.scratch/verify-shelf-page-sync.mjs` 真实浏览器端到端 14/14 PASS）。
10. ~~**历史坏记录「清缓存后目录为空」（松鹤阅读）**~~ ✅ 已完成（2026-09-20；早期版本写书架时把 `bookUrl` 尾部的 `,{"headers":{"Referer":...}}` 剥掉了，导致详情接口恒回 `incorrect referer`、`tocUrl` 渲染成 `bookId=` 空参、目录永远为空。已加「消费时自愈」：精确搜索找回选项 + 规则移植 `headers` 兜底，三条件判据避免误触发与性能回退；清缓存后打开《末日乐园》实测 2654 章 / 3267 字正文，见更新日志顶部）。

11. **速读谷风控解除后用户实测** ⏳ 待复测（代码已完成：任意章节 hover / pointerdown 预取已回退，恢复 legado 同款「当前章 + 前后一章」；远跳直接切换；速读谷源级限速 `1/2000`；禁止 TXT 导出；专项回归 5/5 PASS）。当前 IP 被速读谷临时封禁，代码层不再请求真实站点。等解封或换网络后，只打开一本速读谷书、只点一个远章节，不连续跳章、不导出 TXT，确认 loading、成功切换、无 `AggregateError` 后关闭本项。

12. ~~**打开预加载（打开书即预取相邻章）+ 速读谷取消限速**~~ ✅ 已完成（2026-09-21，见 4.23）。

**当前未闭环项：速读谷风控解除后的用户侧复测。** 已知可继续优化的点：Reader 侧放在 USB 移动硬盘上的大书，冷读文件本身仍有 361~636ms 开销（非代码问题）。

#### ✅ 4.23 打开预加载真正生效 + 速读谷取消限速（2026-09-21）

**问题现象**

- 用户反馈「在线阅读器的打开预加载没实现，还是很卡」，尤其是速读谷来源。
- 用户指出速读谷的「安全阈值设太高」，正常翻页不会触发风控，先后要求放宽、随后要求**直接取消限速**。

**排查**

- 启动预热确实覆盖了速读谷（4 本速读谷书的当前章 + 下一章均有落盘时间戳），
  但前端 `openBook()` 里相邻章预取走的是 `requestIdleCallback`，用户马上翻页时经常还没发出去。
- 实测时间线暴露真正瓶颈：当前章 + 下一章 + 上一章 3 个请求同时排队，
  原 `2/1000` 限速下第 3 个请求要等到 **3145ms** 才发出。

**修改**

- `Reader/public/online.js`：`prefetchNeighbors(idx, { immediate: true })` 支持立即执行；
  `openBook()` 先发当前章、随即把相邻章同步排进请求队列，不再等 idle callback。
- `Reader/server.mjs`：`shouldSkipBackgroundWarm()` 只跳过 `noPrewarm=true`；
  `noExport` 不再跳过预热（`noExport` 只表示整本导出会触发风控，不等于不能预取当前章）。
- 四个书源文件的速读谷条目 `concurrentRate` 从 `2/1000` 先放宽为 `5/1000`，随后按用户要求 **彻底取消（`null`）**：
  `sources/book-sources.json`、`sources/shuyuan-default.json`、
  `sources/groups/group-1/book-sources.json`、`sources/groups/group-mu7z0c55-1603/book-sources.json`。
  依据：用户原始书源备份里速读谷 `concurrentRate` 为 `null`（无限制），本项目的限速是自加的；取消后与备份完全一致。
  「当前章 + 前后一章」的 3 个请求不再排队，正常翻页与打开书都不再被限速拖慢；连续批量请求的风控风险由「禁止 TXT 导出」与「不主动 hover 预取」两条约束兜住。

**验证**

| 验证项 | 结果 |
| --- | --- |
| `.scratch/verify-open-prefetch.mjs`（新增） | 盘龙：当前章 482 / 下一章 483 / 上一章 481 三个请求同一时刻发出，各 ~150ms；无远距离章节请求；**4/4 PASS** |
| 首次正文渲染 | 盘龙 495ms（放宽前同场景 502ms，且上一章被卡 3145ms） |
| `.scratch/verify-far-jump-direct.mjs` | **5/5 PASS**（远跳瞬时换章、hover 不预取、pending 有 loading、失败保留旧章） |
| 限速器本地实测 | `5/1000`：前 5 次立即通过，第 6 次起每 ~1000ms 放 5 个；`2/1000`：第 3 次起每 ~1000ms 放 2 个 |
| 服务状态 | 7788 已优雅重启并运行新代码（PID 5600），启动日志 `书架正文预热完成：17/17 本` |

## 6. 验收记录模板

每个问题关闭前记录：

- 测试书名：
- 书源名称：
- 操作路径：
- 请求接口：
- 预期结果：
- 实际结果：
- 是否清理目录/正文缓存后复测：
- 浏览器窗口尺寸：
- 结论：通过 / 失败 / 待继续

## 7. 重要约束

- 禁止修改原“阅读器”文件夹；需要复用时只能复制到 `Reader/`。
- 书源优先按 legado 原始实现和行为对照，不用针对单个错误随意猜规则。
- 书源数据、Cookie、缓存和用户配置不能因为调试而清空；清缓存必须是明确的用户操作。
- 调试和回归结束后清理临时脚本、临时日志和无关生成文件。
