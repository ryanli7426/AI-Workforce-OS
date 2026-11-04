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
