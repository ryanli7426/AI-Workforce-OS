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
