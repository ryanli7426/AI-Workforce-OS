# B0：独立工程与领域内核迁移

状态：B0 已迁入独立 Git 仓库，并在目标目录通过完整验收。

## 里程碑映射与验收边界

B0 是 R0-A 的独立 Core/Storage 前置里程碑，仅交付工程与管理 CLI 基础；不等于架构中的 W08 完成，更不等于 Master PRD 的完整产品验收。CLI 产品命令统一使用 `workforce`，架构历史方案中的 `lao` 在本项目映射为该命令；B0 仅包含 help/doctor/init/status/tickets，其他命令尚未实现。

下一个里程碑为 R0-A（W01–W04）：Execution、Runner、Claude 适配与真实受控 smoke；之后 R0-B 接入钉钉，R0-C 完成权限/恢复/备份与连续运行验收。通过 R0-C 后才进入 R1 Web。PRD 的组织、多员工、IM、工作流、知识、绩效等验收仍分别属于 R1–R3。

## 范围

- 独立 TypeScript/Node ESM 工程，当前不引入前端和 API 框架。
- 按文件迁入 Core 与 SQLite Repository；保留领域和存储测试、MIT 许可和文件哈希。
- 基础 CLI：显式初始化、健康诊断、只读状态和任务列表。它不是调度 daemon。
- 复制产品 PRD/UX 与架构；旧项目阶段记录仅作为历史证据。

未迁入未完成真实协议验证的 Claude Executor、DSH runtime、DSH 插件或旧前端。

## 下一阶段

1. 独立 Execution 持久化、资源占用、受控 Runner 和身份对账。
2. 迁移并修复 Claude Adapter，补充超时/停止/异常/输出与产物测试，再做真实 smoke。
3. 规则判断、持久 launch/stop intent 和调度器桥接。
4. 钉钉真实 Issue codec、轮询、Outbox 回写与复验。
5. R0-C 的审批身份、恢复、备份和 72 小时连续运行门禁。
6. 通过 R0 后进入 R1 员工/项目配置与独立 API，再逐步构建 Web。

## 协作约定

主 Agent 负责设计、review、集成和验收。按用户约定，Codex 子任务固定 GPT-5.6 系列，本次明确指定 gpt-5.6-sol；不可静默换成其他系列。pi 可承担独立审查；Cursor 当前未登录，不依赖其完成基础工作。每个子任务限定目录与交付物，禁止自行 commit、push、安装依赖或修改其他任务目录。

## 验收

已于 2026-11-04 在 `/Users/cuifengshan/Desktop/AI-Workforce-OS` 复验通过：

- `pnpm check`：生产与测试两套 TypeScript 类型检查；6 个测试文件、207 项测试；构建；隔离目录无 node_modules 的 Engine/SQLite smoke；依赖扫描。
- 编译后的 CLI help/doctor/init/status/tickets smoke 全通过。
- 迁入文件原始哈希与本次有意修改后的哈希分开保存，架构测试核验来源。
- 无运行时 npm dependencies，无 DeepSeek Harness 包或导入；锁文件只包含开发工具依赖。

实际协作：Codex CLI `gpt-5.6-sol` 实现 CLI；pi `openai-codex/gpt-5.6-sol` 审查领域/存储；本机 Cursor Agent 只读审查产品范围；父 Agent 修复问题、追加回归、执行门禁并集成。详见 reviews/。

已修复审查问题：来源更新不再静默丢弃；闭合来源阻止启动或请求停止；旧库先只读校验再写入；CLI 不修改已有共享目录权限；CLI 查询不初始化/迁移数据库。

本里程碑不验收：生产调度 daemon、真实 Runtime 执行、钉钉线上读写、Web、多员工工作流或 72 小时连续运行。当前 Node 22 的 SQLite 实验性警告会显示，这是已知运行环境提示，不影响本次通过的测试。
