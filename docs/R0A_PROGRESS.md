# R0-A 执行底座：第一批集成与真实验证

日期：2026-11-04。状态：基础模块已集成并通过门禁；R0-A 整体仍在实施，不代表整个产品目标完成。

## 真实实现

- 独立 Runner worker/client：私有文件控制协议、独占启动锁、有序事件、心跳、stdout/stderr、限时、限量、认证停止和进程组终止。
- Execution Repository：活动 Task/Assignment/cwd 唯一占用，UNKNOWN 保留占用，generation/序号/Runner 身份约束，退出证据和原子记录。
- 应用桥接：授权回调 → 持久 reservation → Runner 启动 → 事件对账；本地失联观察不伪造 Runner sequence。
- 真实控制平面进程退出后，新客户端可恢复观察原执行；Runner 被杀后，旧执行进入 UNKNOWN，禁止重复启动。
- Claude adapter：真实 CLI argv 与 JSON 解析，模型用量，权限拒绝识别，显式工具范围，未支持能力如实声明。
- Git Worktree：每个 Execution 独立目录，marker/仓库归属验证，安全清理与 dirty 审批。
- 规则评估、版本化员工/项目、持久意图、单次 scoped 审批、只读分页查询、一致 SQLite 备份、分块凭证脱敏和产物快照模块。

这些模块有独立测试与组合测试。员工、项目和备份已有管理 CLI；Task 应用、持久意图消费者和独立验证器已集成，Task 调度与 CLI 正在组合审查，尚无生产 daemon/API/真实钉钉闭环。LocalStore 的历史 schema 保持不变，应用模块由显式 initializer 在同一事务内初始化。

## 多 Agent 实施与父 Agent Review

累计首批 16 路独立任务：Cursor 8、Codex5.6 3、pi5.6 2、Claude3。Cursor 首路沿用客户端配置，其余明确 Auto。实施者报告见 reviews/r0a；父 Agent 修复并独立执行门禁。下一批继续以 Cursor Auto 为主力，见 tasks/CURSOR_MAINLINE_TASKS.md 与 AGENT_TASK_BOARD.md。

父 Agent 已纠正：

1. 规则配置被调用者修改后影响审批要求；现在使用内部快照。
2. Runner 监控/持久化异常可能遗留子进程；增加受控终止和 UNKNOWN 保留。
3. 远端接入失联与持久 Runner 事件混淆；本地 observation 不占 Runner 序号。
4. 审批以相同时间戳重复消费；现在任何二次消费均拒绝，外部动作幂等需由动作意图负责。
5. UNKNOWN 意图对账绕过最大尝试次数；现在超限拒绝重试，需显式策略变更。
6. Runtime 凭证不能全局继承，也不能永远禁用；增加白名单、内存进程环境注入，不写 launch request/数据库。
7. 输出分块可能泄露凭证；Runner 接入独立 stdout/stderr StreamingRedactor。
8. Claude MCP 可变参数吞 Prompt；增加 `--` 分隔。
9. Claude 返回正常 result 但写操作被拒绝；将 permission_denials 视为执行错误，并对测试范围显式允许 Read/Edit/Write。

## 已完成验证

- 目标新仓库 `pnpm check`：24 文件、387 项测试通过，类型检查、构建、无 node_modules 库 smoke、编译后 CLI smoke 与依赖检查通过。
- 真正调用本地 Claude Code 2.1.181，经编译后的 Runner + ExecutionService，在临时 Git Worktree 中将 README 的 typoo 改为 typo，逐字核验文件内容，并确认原仓库未被修改。
- 真实执行状态为 STARTING → RUNNING → SUCCEEDED；保留退出码0及 CLI usage。摘要见 reviews/r0a/CLAUDE_LIVE_SMOKE.json。完整日志留在私有临时目录，凭证未进入仓库。
- 真实调用不等同完整产品验收：尚未接入真实钉钉，也没有因为该成功自动把一个生产 Task 标成 DONE。

## 明确局限与下一批工作

- 当前 Runner 生命周期可靠终止面向 POSIX；Windows 明确拒绝，需独立实现进程树控制后支持。
- 私有控制目录和随机 stop token 限制本机误操作，不是对同用户恶意程序的 OS 安全隔离。
- ArtifactStore 已支持合法 linked worktree，校验 Git commonDir、registry 与 backlink，并记录相对基线的删除；已对真实 Claude 执行工作树生成快照且独立本地检查通过，见 reviews/r0a/CLAUDE_ARTIFACT_VERIFICATION.json。
- 本机凭证使用方式由应用层选择。CLI 自身加载的用户配置、认证辅助和网络仍需项目治理，不把 prompt/cwd 当强沙箱。
- 第二批 Cursor 5 路、第三批 Cursor 4 路已集成，最新完整门禁为32文件、506项测试通过，无跳过测试。Task CLI 已串联创建、审批、分派、Runner、独立产物检查和明确人工验收；6项编译后 CLI 测试从无关 cwd 启动，使用 mock Runtime，证明重复启动控制 CLI 不会重复执行。
- 父 Agent 另修复：异步操作前数据库被关闭、JSON 字段被错误强制转字符串、HOME 下项目被误拒、Runner 路径依赖 caller cwd、取消先于 Core 观察 RUNNING 导致无法收敛、已存在 UNKNOWN 执行的 launch 重放误确认停止、执行结束前快照被误当最终产物。新增异常回归均随完整门禁通过。
- 以上是 Task CLI 与执行闭环验收，未代表后台长期运行、真实钉钉或完整产品已交付。操作说明见 LOCAL_OPERATIONS.md。
- 钉钉 Issue 实际字段与回写位置仍需真实契约；其准备不阻塞上述独立工程。
