# AI Workforce OS

本地优先、由人治理的 AI 员工组织与工作管理平台。当前提供独立 Core/SQLite、持久 Runner、前台控制器、员工/项目配置和任务创建/审批/隔离执行/验证/验收 CLI。真实本地 Claude 已通过控制器完成隔离修改与独立内容检查；认证本地 HTTP API、任务治理、员工/项目编辑、执行中心及可信计划异步验证及断线恢复实时通知及 Runtime 能力目录 Web 已交付；OS 后台服务、真实钉钉业务接入及完整产品功能继续实施。

## 开发

使用 `.node-version` 中已验证的 Node 版本，安装项目固定的 pnpm 版本。

```sh
pnpm install
pnpm exec playwright install chromium
pnpm check
node dist/cli/index.js --help
node dist/cli/index.js init --data-dir .workforce
node dist/cli/index.js status --data-dir .workforce
node dist/cli/index.js tickets --data-dir .workforce
node dist/cli/index.js doctor
```

`init` 是显式数据库初始化；查询命令不创建数据库。显式 `start --foreground` 或 `run-once` 调度已授权任务并可能启动 Agent；管理命令不启动 Agent。编译后 CLI 完整流程测试和独立检查已通过，真实 Claude 证据分别记录。配置、Task、员工、项目和备份命令见 [本地操作说明](docs/LOCAL_OPERATIONS.md)。

## 产品与架构

- [Master PRD](docs/product/MASTER_PRD.md)
- [UX 规格](docs/product/PRODUCT_UX_SPEC.md)
- [架构设计](docs/AI_WORKFORCE_OS_ARCHITECTURE.md)
- [技术栈](docs/TECH_STACK.md)
- [Web 启动与页面能力](docs/WEB_OPERATIONS.md)
- [首批交付与后续工作](docs/BOOTSTRAP.md)
- [完整产品交付跟踪](docs/DELIVERY_TRACKER.md)
- [多 Agent 实施看板](docs/AGENT_TASK_BOARD.md)
- [R0-A 当前实现与真实验证](docs/R0A_PROGRESS.md)
- [Agent 开发与协作规范](AGENTS.md)
- [审查处置与验收记录](docs/reviews/PARENT_ACCEPTANCE.md)
- [迁移来源](NOTICE.md)

旧项目的审计与 Phase 记录保留为迁移背景，其中的命令与实现状态只适用于原仓库，不表示本项目已有这些能力。
