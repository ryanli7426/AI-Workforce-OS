# Phase 1：独立 Core 与 SQLite

> 迁移背景：本文记录旧 dsh-superagent-prototype 工作区的状态与命令。新项目可用能力以 [B0 交付记录](BOOTSTRAP.md) 为准。

本阶段沿用原 Engine、Trigger/Thread/Eval/Decision/Ticket/Assignment/Mandate 和 Repository 事务模型；没有实现第二个推理 Agent，也没有调用 Claude 或钉钉。

## 独立入口与依赖边界

- `src/core/local.ts`：`createLocalEngine(options)`，构造同一个 Engine，但所有 accept 必须携带 `task` 元数据。
- `src/storage/store.ts`：`LocalStore`，使用 Node 内置 SQLite，schema 12。
- `src/storage/sqlite.ts`：从原 `app/store.ts` 提取的共享实现，保留聚合 JSON、SAVEPOINT、afterCommit、索引、KV、Outbox receipts。原 `app/store.ts` 通过继承继续工作；没有复制另一套仓储。
- `src/storage/keys.ts`：类型化 KV 原语，与原应用的 KV 目录分离。
- `policy.ts`：只需 zod 和本地通用模块；已切断通过 environment/deployment 引入宿主类型的路径。

`tsconfig.core.json` 编译 Core、storage 和 policy 的完整类型闭包；边界测试检查 TypeScript Program 的所有输入文件，包含 type-only 引用。`scripts/smoke-core.mjs` 将构建后的 Core/storage 复制到临时目录，不携带任何 `node_modules`，在那里运行真实 Engine → SQLite → 审批队列。

```sh
pnpm check:core
pnpm typecheck
pnpm test:integration
pnpm check
```

Node 版本沿用原项目要求（当前验证环境 v22.23.1）。Node 22 的 `node:sqlite` 会输出 experimental warning。

阶段过渡仍保留原宿主及其 package/lock 依赖，原应用入口不是 LAO daemon。独立 Core/storage 的构建和执行不加载这些依赖；全项目删除安排在后续宿主替换阶段。当前不能宣称 LAO 完整产品已经可以运行。

## 新 Ticket 的生命周期

accept 的 `task` 包含 source instance + issueId、revision、updatedAt、description、priority、closed、taskType 及任务策略。系统建立 NEW 审计，随后进入 QUEUED、WAITING_APPROVAL 或 CANCELLED。关闭 Issue 不分配执行；相同 Issue 的后续 accept 返回同一 Ticket，不创建第二个任务。

Core 提供：

| 命令 | 职责 |
| --- | --- |
| `approveTask` | 记录实际操作人/原因，在授权未失效时进入 QUEUED |
| `rejectTask` | 记录执行前拒绝审批，进入 CANCELLED，不启动任务 |
| `assignTask` | QUEUED → ASSIGNED，创建唯一新 Assignment，事务内只调用“持久化启动意图”的 Executor 端口 |
| `assignmentStarted` | 匹配 Assignment ID 后进入 RUNNING；拒绝过期/已取消的 start |
| `recordExecution` | 接收可信 Executor 收集的结构化终止证据；成功进入 REVIEW、错误进入 FAILED；验证状态强制为 unknown |
| `recordVerification` | 用 executionId + artifactRevision 绑定独立验证结论；未运行 CI 不自动算 passed |
| `reviewTask` | 验证通过或明确 not_required 后，人审通过进入 DONE；拒绝进入 BLOCKED；记录操作人和审批证据 |
| `cancelTask` | 无活动 Assignment 立即取消；有活动 Assignment 只记录 cancelRequested 并排队 stop |
| `confirmProcessStopped` | Runtime 确认进程停止后的事实回调；此后才可释放活动 Assignment |
| `assignmentInterrupted` | 进入 BLOCKED，保留活动 Assignment，不创建新执行 |
| `retryTask` | 仅在旧执行确认结束、策略有效且未超重试次数时进入 QUEUED；记录重试历史 |

这些接口的调用者是可信应用层；不能把整个 Engine 暴露为 Agent 工具。Actor 由未来 CLI/控制通道认证填入，不能取自 Issue 或模型文本。`recordExecution` 的 terminal/exitCode 来自 Executor 的协议解析，不是对模型“完成了”的自然语言解释。真实 OS 进程核查、执行日志和 session 恢复属于 Phase 2/4；当前测试模拟这些可信事实，不伪称已经具备进程监督。

第一版默认人工审核；即便 `reviewRequired=false`，Phase 1 仍保守地要求显式 review，自动完成策略留给后续 Runtime。DONE/CANCELLED 不自动 reopen；显式 reopen 暂不开放。

原始 `report()` 对 LAO Ticket 拒绝改变状态；关联 PR/Thread 关闭不会跳过审核；普通人类后续消息不会自动重开。新输入持久保留，但暂不自动 deliver，待 Phase 2 实测 CLI 能力后由调度器投递。

新生命周期暂存于原 Ticket 聚合的 `lifecycle` 字段，不维护第二份 Ticket 状态。旧数据没有该字段时保持原宿主行为；独立 LocalStore 的迁移会转换所有旧 Ticket，且独立入口拒绝无 task 元数据的 accept。

## 持久化、事务和迁移

新增：

- `source_issue`：`PRIMARY KEY(source, issue_id)` 与 `UNIQUE(ticket_id)`，防止多源冲突和重复绑定。
- `event_log`：追加式生命周期、执行证据、审批、取消和重试记录。
- `domain_event`：Trigger/Decision 等原领域事件的事务内持久记录。
- `approval_history`、`retry_history`：event_log 的只读 SQL views，避免维护两份历史。
- 执行/验证证据和 task policy snapshot 暂保存在 Ticket 聚合；完整 Execution 表、日志路径、usage 等在 Phase 2 引入。

MemoryRepositories 与 SQLite 共享领域契约；接受任务失败时，Ticket/Decision/Issue 绑定/事件一起回滚。SQLite 的 afterCommit 只在最外层提交后运行，回滚的回调被丢弃。真实进程不能在事务内启动；异步 Executor facade 必须把 launch intent 写入同一 SQLite 事务的 effect 表。

新库直接初始化 schema 12。schema 11 需要显式 `new LocalStore(path, { migrateLegacy: true })`：

1. 使用 SQLite `VACUUM INTO` 创建包含 WAL 中已提交数据的一致性备份，权限 0600。
2. 在事务内升级并保留所有旧聚合。未结束任务进入 BLOCKED，保留活动 Assignment，不假设旧进程已死。
3. 旧来源身份使用 `legacy-import + ticketId`，不猜测原记录对应哪个钉钉 Issue。
4. 原 Effects/Outbox 复制到 legacy 历史表；清除旧 effect 的可派发状态、将旧 pending 回写标记 dropped；原 Thread 的等待评估快照归档后停止重放。
5. 成功后版本升到 12；失败回滚，原版本、任务和 effect 保持不变，备份保留。

**明确调整**：Phase 1 不直接导入 schema 10（拒绝并报错），因为它还需要复杂的旧 prompt/source 数据转换；用户当前 Fork 是 schema 11，独立 LAO 不应为了导入更旧数据重新加载 Harness。确需 schema 10 时单独增加离线转换器。已有 schema 11 导入无须安装/运行 DSH。

独立 store 必须由唯一 Runtime 在持有实例锁后打开；Phase 1 的数据库级 Issue 唯一约束不是完整的进程租约/工作树锁，后者由后续阶段实现。迁移必须离线执行，禁止旧 daemon 同时写入。

## 验证范围与剩余工作

新增测试覆盖：规则接受元数据、Issue 唯一性、审批/策略变化、成功不等于 DONE、验证与审阅分离、旧回调、取消确认、阻止中断重跑、重试次数、关闭 Issue、真实 SQLite 重开、多个连接、事务及迁移失败回滚、无 Harness 构建闭包。

同时修复原 `environment.spec.ts` 的本机基线问题：为该测试自己创建的 Git 子进程 env 加入 `LC_ALL=C` / `LANG=C`，不改全局配置和业务环境。

尚未实现：ClaudeCodeExecutor、实际 Worktree/进程管理、钉钉 Adapter、规则 Assessor 实现、daemon/CLI、定时器/优先级派发、自动重试、真实认证与权限沙箱、完整执行日志。这些仍按 Phase 2–5 交付；本阶段没有提前宣称闭环。

## Phase 1 最终复验（2026-11-04）

- `pnpm check:core`：独立类型检查通过；184 项 Core/生命周期/SQLite/边界测试通过；独立 TypeScript 构建通过；临时无依赖运行通过。
- `pnpm typecheck`：全仓类型检查通过。
- `tests/docs.spec.ts` + `tests/class-docs.spec.ts`：7 项通过。
- 更广的完整套件此前通过：62 个文件、1234 项；之后只增加了两个生命周期测试并调整审计字段。本次以 Core 套件和文档门禁复验，完整套件未重复运行。
- `git diff --check`：通过。

Phase 1 的明确边界：Core/SQLite 的状态与持久化契约已落地；执行器进程监督、Source 轮询、自动派发、恢复守护进程和真实外部回写不属于本阶段交付。
