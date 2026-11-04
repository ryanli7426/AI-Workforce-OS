# Agent 实施看板

主 Agent 负责架构、review、跨模块集成、真实验证与提交。Cursor Auto 是后续应用与产品实施的主力；Codex 子任务固定 gpt-5.6-sol。任务使用独立 Git Worktree，不能仅凭实施者声称通过就算验收。

## 已派发 Cursor 任务

| 工作区 | 交付范围 | 状态 |
| --- | --- | --- |
| cursor | Runner client | 已交付；父 Agent 已集成 |
| claude-adapter | Claude Code adapter | 已交付；父 Agent 已集成 |
| assessor | Rule assessor | 已交付；父 Agent 已集成 |
| adversarial | Runner fault tests | 已交付；父 Agent 已集成 |
| approvals | Scoped approvals | 已交付；父 Agent 已集成 |
| employees | AI Employee records | 已交付；父 Agent 已集成 |
| projects | Project records | 已交付；父 Agent 已集成 |
| queries | Task queries | 已交付；父 Agent 已集成 |


截至本次记录，Cursor 已交付 8 路任务。各回执见 reviews/r0a；父 Agent 在集成后修复了规则对象可变、审批重复消费、时间校验、Runner 异常清理、真实 Claude 参数解析和权限拒绝等问题。

## 其他工具

- Codex5.6：Execution Repository、Git Worktree Manager、持久意图。
- pi5.6：Runner worker、SQLite 一致性备份。
- Claude Code：真实 Runner 集成测试、产物快照、分块日志脱敏。

以上为首批累计 16 路实施任务，不意味着当前同时有 16 路仍在运行。后续新任务与验收结果继续追加。

## 第二批：Cursor Auto 主力应用与集成

已再次启动5路独立 Cursor Auto 任务（累计 Cursor13路）：

| 工作区 | 文件范围 | 任务 |
| --- | --- | --- |
| cursor-artifact-worktree | artifacts/snapshots + tests | 正式 linked-worktree 产物兼容、删除记录与安全核验 |
| cursor-management-cli | cli/index + management tests | 员工/项目/备份管理命令与显式初始化 |
| cursor-dispatcher | orchestration/dispatcher + tests | 持久启动/停止/回写意图的消费者与租约收敛 |
| cursor-verifier | verification + tests | 不可变产物的独立验证工作目录与本地质量检查 |
| cursor-task-app | application/tasks + tests | 手工 Task 接入、规则/Owner权限和持久 launch/stop 意图 |

第二批 5 路均已交付并经父 Agent review 集成。集成门禁 `pnpm check` 已通过 450 项测试，包括类型检查、构建、独立 smoke 和依赖扫描。父 Agent 另修复了验证器私有字段访问、权限根目录、Task Owner 范围和只读状态统计。真实 Claude linked-worktree 产物与独立质量检查证据见 reviews/r0a/CLAUDE_ARTIFACT_VERIFICATION.json。

## 第三批：Cursor Auto 主导可操作任务闭环

截至此批，Cursor 累计承接 **17 路独立任务**（不把同一任务的返修重复计数）。以下状态以本机进程与产出文件核实；交付不等于已经通过父 Agent 验收。

| 工作区 | 文件范围 | 实际状态 |
| --- | --- | --- |
| cursor-orchestrator | application/local-orchestrator、测试与 mock CLI | 已交付、返修、集成；父 Agent 另补取消观察缺口、UNKNOWN 重放保护和过早快照拒绝 |
| cursor-settings | config/settings 与测试 | 已交付、返修、集成；允许 HOME 下项目配置，校验文件权限与有界读取 |
| cursor-task-cli | cli/task-commands 与测试 | 已交付、返修、集成；配置、Task 创建/审批/取消/验证/人工验收、run-once |
| cursor-compiled-task-smoke | compiled-task-cli 集成测试 | 6 项真实编译后 CLI 测试通过；无关 cwd、Runtime 脱离 CLI、实际独立内容检查和明确验收；Runtime 使用 fixture |

四路均明确使用 `cursor-agent --model auto`，隔离 Git Worktree，禁止自行提交、跨任务改文件及真实模型调用。父 Agent 负责跨模块接线、审查、修复、门禁和用户授权的提交推送。累计数与当前并行数分开记录。

第三批集成后 `pnpm check`：**32 文件、506 项测试通过**，无跳过测试；类型检查、构建、独立 smoke、编译后 CLI smoke 和依赖扫描均通过。交付回执与 review 回执分别保存于 reviews/r0a，不把实施者的初稿报告视为最终验收。

## 第四批：本地可运营能力（2026-11-05）

已启动3路 Cursor Auto，累计 Cursor **20路**独立任务。第三批已完成，不能把历史累计数当成当前并发数。

| 独立 Worktree | 任务 | 状态 |
| --- | --- | --- |
| workforce-cursor-control-loop-20261105 | 串行长期控制循环、退出与错误退避、结构化事件 | 已交付、父 Agent review并集成 |
| workforce-cursor-controller-lease-20261105 | 单控制平面占用、私有 stop 通道、死进程恢复与替换 fencing | 已返修、集成；父 Agent 另补未知证据与悬空链接释放保护 |
| workforce-cursor-execution-logs-20261105 | 只读执行日志、范围授权、脱敏与有界尾部读取 | 已返修、集成；移除生产测试钩子，支持追加并保护截断首行 |
| workforce-cursor-controller-cli-20261105 | start/stop/controller-status/logs命令 | 已返修、集成；真实编译后前台控制进程测试通过 |

共享契约见 tasks/CURSOR_OPERATIONS.md 和 CURSOR_CONTROLLER_CLI.md；每路只拥有一个实现文件及其测试，父 Agent 负责 CLI 接线与组合验收。以上4路使 Cursor 累计完成21路。

本批另有 Claude Code 的独立编译后控制进程验收、pi 的全量 PRD/UX 静态缺口审查，以及明确使用 gpt-5.6-sol 的 Codex 产品查询实现。父 Agent 修正了查询层误将 Project 业务负责人当作 Workspace 权限边界的问题。

组合门禁：38文件、577测试通过，无跳过，类型检查/构建/smoke/依赖扫描通过。真实本地 Claude 通过前台控制器修改临时工作树、独立检查通过、原仓库不变、控制器退出0、Task保留REVIEW。证据和回执见 reviews/r0c。72小时运行与OS后台服务尚未验收。

## 第五批：认证 API（进行中）

Cursor 已累计派发23路独立任务，以下2路尚未验收：

| 独立 Worktree | 任务 | 状态 |
| --- | --- | --- |
| workforce-cursor-api-auth-20261105 | 本地私有凭证、可信Owner、Bearer验证、Origin/Host边界 | Cursor Auto 已启动 |
| workforce-cursor-task-command-receipts-20261105 | 原子命令回执、版本冲突、请求重放与Task状态同事务提交 | Cursor Auto 已启动 |

契约见 tasks/CURSOR_API_FOUNDATION.md。当前还没有可对外操作的 HTTP/Web，不把认证模块或查询层当作产品页面交付。完整范围继续按 PRODUCT_TRACEABILITY_REVIEW.md 与产品基线推进。
