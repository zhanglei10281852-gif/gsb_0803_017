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

## 目录结构

```
src/
  shared/        # 前后端共享的版本化契约 (zod) + 纯投影函数
    contract.ts    # SpanEventInput / LedgerRecord / ReplayCursor / ProjectionView ...
    projection.ts  # projectView(): 唯一的、纯粹的、可复现的视图生成逻辑
    ndjson.ts      # NDJSON 解析/序列化
  server/        # Fastify：NDJSON 接入 + WS 实时跟随 + 视图查询 + 静态托管
    ledger.ts      # 只追加的 SQLite 账本
    app.ts         # 路由与投影装配（可被测试单独引导）
    main.ts        # npm start 入口
  sample/        # 确定性样例流：制造乱序/重复/修订/重连
  web/           # React + Three.js 主界面
tests/
  unit/          # 投影语义、样例确定性、契约校验
  integration/   # 账本 + HTTP 应用 + 重启恢复
  e2e/           # Playwright：启动 dist 真实服务，真网络接入 + 浏览器交互 + 重开存储
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
