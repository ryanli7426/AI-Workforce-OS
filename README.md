# AI Workforce OS

本地优先、由人治理的 AI 员工组织与工作管理平台。当前交付独立 Core、SQLite、领域测试与基础管理 CLI，尚未提供运行调度服务、真实 Agent 执行、钉钉接入或 Web。

## 开发

使用 `.node-version` 中已验证的 Node 版本，安装项目固定的 pnpm 版本。

```sh
pnpm install
pnpm check
node dist/cli/index.js --help
node dist/cli/index.js init --data-dir .workforce
node dist/cli/index.js status --data-dir .workforce
node dist/cli/index.js tickets --data-dir .workforce
node dist/cli/index.js doctor
```

`init` 是显式数据库初始化；查询命令不创建数据库。执行 Runtime 与钉钉暂未连接，CLI 不会启动 Agent 或发送远端消息。

## 产品与架构

- [Master PRD](docs/product/MASTER_PRD.md)
- [UX 规格](docs/product/PRODUCT_UX_SPEC.md)
- [架构设计](docs/AI_WORKFORCE_OS_ARCHITECTURE.md)
- [技术栈](docs/TECH_STACK.md)
- [首批交付与后续工作](docs/BOOTSTRAP.md)
- [迁移来源](NOTICE.md)

旧项目的审计与 Phase 记录保留为迁移背景，其中的命令与实现状态只适用于原仓库，不表示本项目已有这些能力。
