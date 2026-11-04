# Cursor 主力实施：本地 Task CLI 闭环验收

2026-11-04，父 Agent 集成验收。Cursor 累计17路独立实施任务；返修不重复计数。各工作区只交付指定文件，主工作区由父 Agent 审查、修正和接线。

## 已验证行为

- 员工/项目配置与显式启用；私有本地 settings 配置，不接受凭证字段。
- 手工 Task 幂等接入、规则评估、Owner 审批、持久 Assignment/launch/stop 意图与受限并发。
- 独立 Git Worktree、脱离 CLI 的 Runner、结构化 Claude 结果、不可变产物和失败证据。
- 编译后 CLI 从无关 cwd 启动，重复 run-once 观察同一执行；独立验证副本执行真实内容检查；验证通过仍保持 REVIEW，版本绑定的明确验收才进入 DONE。
- 取消先于 Core 收到 RUNNING 时仍等待退出证据；UNKNOWN 的取消和 launch 重放保留占用；同一 execution ID 的过早快照被拒绝。
- 查询不初始化/迁移库；初始化显式安装各模块 schema；SQLite 一致备份保留已提交 WAL 内容。

## 实际门禁

`pnpm check`：32个测试文件、506项测试通过，无跳过；TypeScript 源码/测试类型检查、构建、无 node_modules 独立 Core/SQLite smoke、编译后 CLI smoke、DeepSeek Harness 依赖/import 扫描均通过。完整流程6项测试位于 tests/compiled-task-cli.spec.ts；异常组合位于 tests/local-orchestrator.spec.ts。

完整流程采用本机 mock Claude 进程，明确区分真实模型验证。此前真实本地 Claude 2.1.181 已经通过 Runner 修改独立工作树；linked-worktree 产物和本地内容检查结果见 CLAUDE_ARTIFACT_VERIFICATION.json，基础进程证据见 CLAUDE_LIVE_SMOKE.json。

## 尚未验收

长期控制循环/单实例服务运维、72小时运行、真实钉钉 Issue 字段与远端回写、HTTP/Web、多组织/多人授权、多 Runtime、工作流、知识与运营指标。当前 run-once 不是后台服务；无自动失败重试、无自动验收。未知进程需要对账，不通过重启或清锁盲目重跑。执行范围与工具清单不构成 OS 强沙箱。
