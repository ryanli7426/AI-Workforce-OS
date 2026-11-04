# 产品交付跟踪

目标：完成 MASTER_PRD 与 PRODUCT_UX_SPEC 的完整 AI Workforce OS；由主 Agent review/集成，多本机 Agent 按独立工作区实施。本文按真实验收更新，不把某次阶段交付当作整个产品完成。

| 范围 | 当前状态 | 证据/下一步 |
| --- | --- | --- |
| B0 独立工程/Core/SQLite/基础 CLI | 已验收 | BOOTSTRAP；207 项测试、独立构建与 smoke |
| R0-A 执行底座 | CLI 组合已验收 | Runner 脱离控制进程运行/恢复观察、UNKNOWN 占用、真实故障集成测试；最新完整门禁506测试 |
| R0-A Claude Runtime 接入 | 基础与 Task CLI 接线已验收 | 真实 Claude 隔离修改/产物检查；mock Runtime 编译后 CLI 全流程分别验收 |
| R0-B 工作接入与调度 | 本地 CLI 已验收；外部入口进行中 | Task/持久消费者/调度器/配置与CLI已集成；长期循环、真实钉钉待后续验收 |
| R0-C 可运营治理 | 进行中 | 版本审批/取消/一致备份模块已集成；前台长期循环、端到端恢复和72小时连续运行待验收 |
| R1 独立 API 与 Web | 待实施 | 员工、任务、执行、审批、监控和真实管理操作 |
| R1–R2 IM 原生交互 | 待实施 | 身份、会话、渠道、@员工、审批及交付 |
| R2 组织/团队/项目与多 Runtime | 待实施 | 能力路由、第二驱动、授权隔离 |
| R2 工作流与多 Agent 协作 | 待实施 | 计划、DAG、并行、交接、人工节点与汇总 |
| R3 知识、分析与自动化 | 待实施 | 来源权限、知识发布、质量/成本、预算化主动工作 |
| 完整 UX 与发布运维 | 待实施 | 页面操作、主题、移动端关键操作、可访问性和部署验收 |

## 当前委派：R0-A 第一批

共享契约：tasks/R0A_EXECUTION_CONTRACT.md。首批四个独立 Git Worktree，后续扩至累计16路任务，主 Agent 负责类型、协议、存储接入、review、故障修复和验收。

- Codex CLI：gpt-5.6-sol；Execution Repository 与存储测试。
- pi：openai-codex/gpt-5.6-sol；独立 Runner worker。
- Cursor Agent：作为主力，首路沿用客户端配置，后续显式 Auto；已交付客户端、适配器、规则、故障测试、审批、员工、项目和查询。详见 [实施看板](AGENT_TASK_BOARD.md)。
- Claude Code：当前客户端已配置模型；真实进程 fixture 与 Runner 集成测试。只开放 Read/Write/Edit，不运行 Shell。

所有任务禁止自行提交/推送和跨任务改文件。主 Agent 通过审查与门禁后按用户授权提交推送。

## 验收规则

1. 单元、集成和真实外部服务验证分别标注；fixture 通过不等于真实 Runtime 验收。
2. 进程失联进入不确定/阻塞，不释放资源并盲目重跑。
3. Task 完成与进程成功、质量验证、审批和外部交付分别记录。
4. 每项产品范围必须有可操作行为与直接证据，不能用菜单、类型声明或计划作为完成证据。
