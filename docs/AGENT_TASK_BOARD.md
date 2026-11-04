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

## 第五批：认证 API（已验收）

Cursor 累计完成 **25路独立任务**；同一任务的review不重复计数。

| 独立 Worktree | 任务 | 状态 |
| --- | --- | --- |
| workforce-cursor-api-auth-20261105 | 私有凭证、Owner Bearer验证、Origin/Host边界 | 已返修、父 Agent集成验收 |
| workforce-cursor-task-command-receipts-20261105 | 原子命令回执、版本冲突、请求重放 | 已返修、父 Agent抽取存储模块后集成验收 |
| workforce-cursor-http-api-20261105 | Fastify认证查询/任务命令边界 | 已返修、父 Agent集成验收 |
| workforce-cursor-api-cli-20261105 | api-init/api-serve与真实进程退出 | 已返修、父 Agent集成验收 |

完整633测试、类型/构建/smoke/依赖扫描通过；真实TCP验收见 reviews/r1/HTTP_API_PILOT.json。回执见 reviews/r1。Web下一批推进，不把API当作页面完成。

## 第六批：可操作 Web（集成验收）

Cursor 累计 **29路独立任务**：本批3路实现加1路独立审查，既有任务的返修仍不重复计数。

| 工作区 | 任务 | 实际交付 |
| --- | --- | --- |
| workforce-cursor-web-api-20261105 | 同源类型化客户端、凭证闭包、超时/取消/流式上限 | 26项测试，父 Agent纠正DTO字段、TS收窄及完整请求返回 |
| workforce-cursor-web-tasks-20261105 | Task/审批视图、显式确认/版本/回执、筛选与分页 | 10项测试；返修关联链接、UNKNOWN重试与操作进行中保护 |
| workforce-cursor-web-overview-20261105 | 概览、员工、项目与执行详情 | 11项测试；父 Agent完成布局及实际Claude数据验收 |
| main只读审查 | 父 Agent的登录/同源部署/静态边界与E2E | 报告与逐项处置见 reviews/r1/WEB_ACCEPTANCE.md |

父 Agent拥有登录内存会话、路由/主题/布局、静态资源服务、CLI接线和真实浏览器测试；没有让子任务自行接受生产Task。浏览器完成创建/批准/取消的SQLite闭环，另只读展示原真实Claude的REVIEW/验证/执行日志。门禁及未完成范围见 WEB_OPERATIONS.md 与交付跟踪。
