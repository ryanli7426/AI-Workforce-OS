# AI Workforce OS 技术栈建议

> 本文区分新仓库实际依赖、历史迁移背景和后续选型。当前交付范围以 [交付跟踪](DELIVERY_TRACKER.md)、[执行底座进度](R0A_PROGRESS.md) 和 [本地操作说明](LOCAL_OPERATIONS.md) 为准。

日期：2026-11-05。状态：已实施组件与后续选型分开记录。配套：[架构设计与实施蓝图](AI_WORKFORCE_OS_ARCHITECTURE.md)。

## 1. 判断

保留 TypeScript + Node.js + SQLite + React 的主路线。当前产品主要处理事件、数据库事务、CLI 子进程、外部集成和管理界面，这一组合能够复用现有实现，并让前后端共享契约。

优先补齐可靠执行、权限和产品入口，而非更换语言。Python Agent 可作为后续 Runtime 接入，控制平面无需随之更换语言。

## 2. 新仓库实际技术与历史处理意见

新仓库已使用 TypeScript 6、Node.js 22/24 engines、pnpm 11、Vitest 4、`tsc` 和内置 `node:sqlite`。已在本机 Node 22.23.1 通过类型、单元/进程集成、编译后 CLI、独立 smoke 与依赖扫描。当前运行时 npm 依赖为 **Fastify 5.12.8、React/React DOM 19.3.1、TanStack Query 5.105.3**。前端工具为 **Vite 8.3.5、React插件5.2.0**；Web测试已安装Testing Library、jsdom和Playwright1.64.1。Core/SQLite 的无 node_modules smoke 仍通过。Zod、proper-lockfile、Pino、TanStack Router、Tailwind/shadcn尚未安装；下表这些项目描述的是旧仓库的迁移背景，不能视为新项目已提供的能力。路径与进程控制当前按 POSIX 验收，Windows 运行执行链路尚不支持。

以下是历史组件的处理建议：

| 当前组件 | 处理意见 | 原因 |
| --- | --- | --- |
| TypeScript strict / ESM | 保留 | 领域与端口已有基础，适合维护跨层契约 |
| Node.js，当前项目支持 22/24 等版本 | 保留，发布前收窄到已验证版本线 | 进程、信号、SQLite、CLI 行为需要版本兼容测试；不能只使用无限上限的 engines 范围 |
| SQLite / node:sqlite DatabaseSync | 保留并封装 | 避免为技术选型重写成熟事务；限制同步查询耗时 |
| Zod | 保留 | 校验配置、外部输入和协议；TypeScript 类型不能替代运行时校验 |
| proper-lockfile | 保留本地单实例用途 | 不能代替任务资源占用、进程身份核验和跨节点租约 |
| React 18 | 保留现有组件；新 Web 初始化时决定统一主版本 | 升级与去宿主分步进行，按组件依赖和测试选择版本 |
| Vitest / jsdom | 保留 | Core 与 Node 集成测试基础已具备 |
| pnpm / tsdown / tsc | 保留 | 包管理、Node 构建与类型检查可沿用 |
| Cordis、DSH Session、Workspace、权限预设等 | 随独立入口替换后删除 | 违反独立于 DSH 的目标 |
| window.__ModuleLoader__ 前端注入 | 替换为独立 Web 构建 | 当前前端仍依附宿主 |
| 默认插件 exports、engines.dsh、插件 patch | 清理并建立独立发布入口 | 当前 package 仍不代表可独立安装的产品 |

## 3. 推荐目标组合

| 层 | 推荐技术 | 引入阶段与用途 |
| --- | --- | --- |
| 领域与应用 | TypeScript + Node.js LTS + 现有 Core | 立即沿用；LTS 版本以发布兼容矩阵固定 |
| HTTP API | Fastify | 独立 API 阶段；请求生命周期、模块封装和结构化日志接入 |
| 输入契约 | Zod + 显式 API DTO | Core 类型不直接作为所有外部可写字段；与 Fastify 的校验桥接单独验证 |
| API 描述 | OpenAPI | 发布外部 API 时生成/校验契约，避免手写类型漂移 |
| 数据库 | SQLite WAL + 现有 Repository | 本地与单控制平面首版 |
| SQL 与迁移 | 参数化 SQL + 编号迁移 | 暂时沿用；不为跨数据库预期重写 ORM |
| 调度 | SQLite Effects / Outbox / Inbox | 首版；幂等消费、恢复和重试由应用层负责 |
| 执行 | 独立 Node Runner + Runtime Adapter + Git Worktree | R0 必需；Runner 脱离 HTTP 进程生命周期 |
| 日志 | Pino JSON 日志 + 独立 stdout/stderr 文件 | 独立应用阶段；限制大小、权限与敏感信息 |
| Web 基础 | React + TypeScript + Vite | R1；独立 SPA，生产静态资源可由同一本地服务提供 |
| 路由 | TanStack Router | R1；资源详情、嵌套路由和筛选参数 |
| 服务端数据 | TanStack Query | R1；查询缓存、mutation 状态和刷新；数据库仍为事实来源 |
| UI | Tailwind CSS + shadcn/ui | R1；建立产品设计变量、表格、详情面板和审批交互 |
| 实时状态 | SSE + 普通 HTTP 命令 | R1；断线重连和游标恢复需应用实现 |
| 工作流画布 | React Flow | R2；仅负责可视编辑/展示，执行仍由后端工作流模块管理 |
| 自动化测试 | Vitest + Playwright | Vitest 沿用；Web 阶段补真实浏览器 E2E |
| 本地运维 | 前台 CLI + 后续 OS 服务封装 | launchd/systemd 等按平台验收，不依赖终端窗口长期存活 |

以上是针对本产品的工程判断，并不意味着必须在第一天引入全部包。版本在对应阶段按 Node、React 和插件兼容性锁定，避免一律安装 latest。

## 4. 三个关键边界

### 4.1 SQLite 可以继续，但查询需要受控

WAL 允许读写更好地并行，但同一时刻仍只有一个 writer，不适合多个机器通过网络文件系统共享数据库。远程 Runner 应连接控制平面 API，由控制平面写库，不能挂载同一个 SQLite 文件。

当前 DatabaseSync 的数据库操作在调用线程同步执行。短事务、索引查询和受限分页适合首版；日志不逐字符写业务表，重型指标计算不要挤占心跳与停止命令。先测量事件循环延迟；若出现阻塞，再通过存储接口将重查询/数据库所有权移入专门 Worker，而非先做破坏性重写。

多用户并不自动要求 PostgreSQL。出现多控制平面副本、明显写争用、集中托管高可用或运维要求时，再设计 PostgreSQL 迁移。更换数据库也不能消除进程与外部副作用的一致性问题。

### 4.2 Web 服务与 Runner 必须分开

Web、CLI、IM 调用同一应用层；HTTP 框架不拥有 Task 生命周期。重启 Fastify 或重新发布前端，不应切断 Runner 对活动执行的记录。

首版独立 SPA 没有明确 SEO/SSR 需求，因此推荐 Vite 方案。若以后增加公开内容站，可独立选用 SSR 方案，避免把长时执行依附于页面请求或短生命周期函数。

### 4.3 数据管理与本地 UI 状态分开

Task、Employee、Approval、Execution 通过 TanStack Query 管理服务端数据，SSE 驱动失效刷新或版本化更新。筛选和资源定位优先保存在 URL；弹窗和编辑中的临时状态使用 React 本地状态。出现明确的跨页面临时状态需求时再考虑额外状态库。

React Flow 的节点状态只是后端运行状态的展示，不能因为前端连了两条边就视为工作流已获授权或已持久化。

## 5. 按阶段引入

1. **R0**：保留现有 TypeScript、SQLite、Vitest 和构建工具，交付独立 Runner、CLI、配置、日志、真实 Claude 与钉钉闭环；完成 DSH 清理。
2. **R1**：补 Fastify API、OpenAPI、React/Vite、Router/Query、设计系统、SSE 和 Playwright。先交付 Tasks、Executions、Approvals、Employees 等真实操作。
3. **R2**：按工作流需求加入 React Flow，增加第二 Runtime 与多人身份授权；按实测容量决定是否需要数据库演进。
4. **R3**：根据知识和分析需求增加检索、指标投影与远程运维；数据库、对象存储和检索系统分别评估。

首版不把微服务、Redis、消息中间件、容器编排或向量数据库作为启动依赖。它们应解决已证实的问题，而非成为实现产品蓝图的先决条件。

## 6. 选型参考

- [React：从构建工具建立应用](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite 官方指南](https://vite.dev/guide/)
- [Fastify 官方文档](https://fastify.dev/docs/latest/)
- [SQLite WAL 的并发与部署约束](https://www.sqlite.org/wal.html)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)：实施时必须使用部署 Node 主版本对应文档核验能力。
- [TanStack Router](https://tanstack.com/router/latest/docs/overview) 与 [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
- [shadcn/ui](https://ui.shadcn.com/docs)
- [React Flow](https://reactflow.dev/learn)
- [Playwright](https://playwright.dev/docs/intro)

## 2026-11-05 实施补充

第一批Web使用独立web/目录、类型隔离、Vite生产构建及同源Fastify资源服务。当前7类资源视图使用轻量hash路由，避免本地静态服务的任意路径回退；不将菜单当作完整模块交付。Query承担服务端数据刷新，命令使用原子回执和显式版本。CSS设计变量提供响应式和深浅主题；尚未引入Router或组件库。后续路由/表单复杂度增长时统一路由层，不重写领域状态机。

安装时发现本地npm镜像尚未同步最新Query内部依赖，最终固定已完整可用的5.105.3并从官方registry解析，没有保留临时的依赖发布时间策略例外。运行命令及浏览器门禁见 WEB_OPERATIONS.md。
