# 分布式链路事故回放平台 (Distributed Trace Incident Replay)

一个可在 **Windows 本地**运行的分布式链路事故回放平台。它持续接入 NDJSON span
事件，把**不可变原始账本**与**可重建投影**严格分离，让值班同学能够精确复盘
"当时为什么做出那个判断" —— 不受迟到 span、重复、乱序或采集端断线重连的影响。

## 核心保证

| 需求 | 实现 |
| --- | --- |
| 单调 `ingestSequence` | SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`，重启后继续递增、永不复用 |
| 同一 `(traceId, spanId)` 仅更高 `revision` 成为当前版本 | 纯投影中的全序 `beats()`：先比 revision，平手时更早到达者胜（平手永不覆盖） |
| 所有版本都保留 | 账本**只追加**，从不 UPDATE/DELETE；每个 revision 都是一行 |
| 统一回放位置 | `ReplayCursor(eventTimeMs, ingestSequence)` |
| 任意时点视图可重复生成 | `projectView(records, cursor)` 是纯函数，相同输入必得相同输出 |
| 不受迟到/重复/乱序/重连影响 | 视图只由 cursor 过滤不可变账本得出，与到达顺序无关；精确重发按幂等去重 |
| 进程重启从 SQLite 恢复 | 无需重新灌数据；`npm start` 重开同一个库即得到同样的账本与投影 |

`ingestSequence` 表达"**当时已经到达了多少知识**"，`eventTimeMs` 表达"**事故时间轴上的某一刻**"。
两者组合，就能重放"在采集进度 = N 时、看事故第 T 毫秒的拓扑长什么样"。

## 事故快照与对比 (IncidentSnapshot)

复盘时经常要把"两个关键时刻"固定下来比较。快照沿用**同一套** `ReplayCursor`
和事件修订规则，不另做旁路数据模型：

| 需求 | 实现 |
| --- | --- |
| 封存 A、B 两个游标为不可变快照 | `snapshots` 表与账本同库、**只插入不更新**；封存后 cursor/备注/摘要永不改写 |
| 展示两点间 新增/消失/状态变化/关键路径变化 的 span | `diffSnapshotViews()` 纯函数按 span 键归并、排序输出，确定性 |
| 附上调查备注 | `note` 随快照一起封存，并纳入摘要计算 |
| 记录足以证明来源的账本高水位 | `provenance.ledgerHighWater` = 封存时账本的 `maxIngestSequence`（冻结切片） |
| 确定性摘要 | `sha256(canonicalSnapshotContent(...))`，只依赖账本派生事实，与顺序/时钟无关 |
| 相同账本+游标重启后同一摘要 | 快照视图 = `projectView(readUpToIngest(highWater), cursor)`，纯函数 + 只追加切片 |
| 迟到事件产生新快照但不改写旧结果 | 旧快照冻结在其 `highWater` 之下，迟到记录不在切片内；只能封新快照 |

关键点：一个快照被**冻结在它的 `ledgerHighWater`** 上——重建视图时只回放
`ingestSequence <= highWater` 的记录。因此后续迟到、重复、乱序、重连产生的新记录
永远进不了这个切片，摘要天然稳定、旧封存结果无法被改写。`GET /api/snapshots/:id/verify`
可随时重算摘要自证未被篡改。

界面右侧"事故快照对比"面板：拖动时间线到关键时刻 → 填备注 → 封存（自动标 A/B/C…）→
选定 A、B → 比较，即得带 provenance 与摘要指纹的差异列表。

## 跨班协作：共享会话 + 租约/fencing + 备注归并

两个值班小组交接时，以**已封存快照的 id + 摘要**作为交接锚点，围绕它开一个共享
调查会话。这是**协作层，不是通用账号/权限后台**：

| 需求 | 实现 |
| --- | --- |
| 以快照 id + 摘要为交接锚点 | 建会话时校验 `anchorDigest` 必须等于该封存快照的 digest（`createSession`） |
| 只有持租约方能封存/推进共同游标 | 写路径（`POST /api/snapshots` 带 writer、`/cursor`）经 `checkWriter` 租约+token 校验 |
| 租约过期后旧客户端不能覆盖新负责人 | **fencing token**：每次授予/接管单调 +1；写请求 token 必须 == 当前租约 token，过期或被超越一律拒绝（即使请求晚到） |
| 普通备注确定性归并（非 LWW） | `mergeNotes()` 按 id 取并集，按 `(lamport, author, id)` 全序排序；并发备注都保留且各端收敛一致 |
| 租约/token/归并结果持久化 | `sessions`（单行含租约、`highestFencingToken`、共同游标）+ `session_notes`（`(sessionId,noteId)` 幂等）与账本同库 |
| 重启/重连后仍成立 | 全部落 SQLite；重连时前端 `onReconnect` 重新 `GET /api/sessions/:id`（socket 只是加速，REST 才是权威） |

三种参与状态（`classifyRole` 纯函数，界面明确区分）：
- **负责人 (owner)**：持有效租约且 token 为当前值，可封存 / 推进共同游标。
- **跟随负责人 (following)**：非负责人且选择跟随，时间线只读、跟随共同游标。
- **独立查看 (independent)**：非负责人且自行拖动本地游标，不影响共同游标。
- **已失去租约 (lost-lease)**：曾持租约但已过期或被更高 token 接管；写操作会被 fencing 拒绝，需重新接管。

`fencingToken` 单调且**跨重启不回退**（存于 `sessions.highestFencingToken`）。旧负责人
即便断线后携旧 token 晚到，`checkWriter` 也会因 `token !== 当前租约 token` 拒绝，
从而无法覆盖新负责人。

## 目录结构

```
src/
  shared/        # 前后端共享的版本化契约 (zod) + 纯投影/快照/协作函数
    contract.ts    # SpanEventInput / LedgerRecord / ReplayCursor / ProjectionView
                   #   + IncidentSnapshot / SnapshotComparison
                   #   + CollaborationLease / SessionState / InvestigationNote ...
    projection.ts  # projectView(): 唯一的、纯粹的、可复现的视图生成逻辑
    snapshot.ts    # canonicalSnapshotContent() 摘要内容 + diffSnapshotViews() 对比
    collaboration.ts # mergeNotes() 确定性归并 + classifyRole() 三态判定（纯函数）
    ndjson.ts      # NDJSON 解析/序列化
  server/        # Fastify：接入 + WS + 视图 + 快照/对比 + 会话/租约/备注 + 静态托管
    ledger.ts      # 只追加账本（含只插入 snapshots、sessions、session_notes 表）
    snapshots.ts   # 封存/复现/对比/校验 + sha256 摘要 (node:crypto)
    collaboration.ts # 会话/租约/fencing/共同游标/备注服务（时钟注入，便于确定性测试）
    app.ts         # 路由与投影装配（可被测试单独引导）
    main.ts        # npm start 入口
  sample/        # 确定性样例流：制造乱序/重复/修订/重连
  web/           # React + Three.js 主界面 + SnapshotPanel + CollaborationPanel
tests/
  unit/          # 投影/样例/契约/摘要/diff + 协作归并与三态判定
  integration/   # 账本 + HTTP + 重启恢复 + 快照不可变 + 会话租约/fencing/备注/重启
  e2e/           # Playwright：真实服务 + 浏览器；快照封存/迟到/重启 + 双浏览器协作交接
```

## 命令入口

```bash
npm ci          # 干净安装（使用 package-lock.json）
npm test        # 单元 + 集成：投影确定性、修订解析、cursor 重建、存储重开、契约校验
npm run build   # 编译服务端 (tsc) + 打包前端 (vite) 到 web/dist
npm run e2e     # Playwright：启动打包后的真实服务，真 HTTP/WS 接入 + 浏览器交互 + 重启复现
npm start       # 以 dist/server/main.js 托管真实页面（默认 http://127.0.0.1:4180）
```

辅助命令：

```bash
npm run sample -- --url http://127.0.0.1:4180 --seed 1 --sessions 3   # 灌入确定性样例流
npm run sample -- --print                                            # 仅打印 NDJSON
npm run dev:server   # tsx watch 后端
npm run dev:web      # vite 前端（代理 /api 与 ws 到后端）
```

## 本地跑通一次

```bash
npm ci
npm run build
npm start
# 另开一个终端：
npm run sample -- --url http://127.0.0.1:4180
# 浏览器打开 http://127.0.0.1:4180
```

## 界面操作

- **实时跟随 ↔ 暂停回放**：顶部按钮切换；拖动任一时间线自动进入 REPLAY。
- **两条时间线**：
  - *事件时间*：事故时间轴，隐藏"未来"的 span。
  - *采集进度 (ingestSequence)*：往回拖可回到"修订尚未到达"的那一刻。
- **三维因果拓扑**：节点按 trace/深度布局，父→子连线；错误源红色、错误传播路径橙色。
- **三处联动**：3D 场景点选、列表点选、详情面板始终同步高亮同一个 span。
- **版本生效理由**：详情面板解释"为什么显示这个 revision"，并在存在更晚到达的
  更高 revision 时明确提示它被有意隐藏。
- **响应式**：桌面左右分栏，窄屏上下堆叠，核心操作均可完成。

## 契约与类型

- 前后端共享 `src/shared/contract.ts` 中的 **zod** 模式，`CONTRACT_VERSION` 双端断言。
- 全仓 TypeScript `strict`，`noUncheckedIndexedAccess` 等开启，**不使用 `any` 绕过契约**。
- 账本层与投影层严格分离：账本只存事实，投影只读派生，二者互不写入对方。
