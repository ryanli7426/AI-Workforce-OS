> 历史快照说明：本文是API/Web实施前的独立审查，保留原始结论供追溯。2026-11-05后，前台控制器、认证API与首批Web已交付；当前事实以 DELIVERY_TRACKER.md、WEB_OPERATIONS.md 和 reviews/r1/WEB_ACCEPTANCE.md 为准。本文的“无API/Web、0/19”不能作为最新代码状态。

# AI Workforce OS 需求追踪审计报告

## 1. 审计口径与总体结论

- 审计基线：`AGENTS.md`、`docs/product/MASTER_PRD.md`、`docs/product/PRODUCT_UX_SPEC.md`、`docs/AI_WORKFORCE_OS_ARCHITECTURE.md`、`docs/DELIVERY_TRACKER.md`，以及当前 `src/`、`tests/`。
- 仅做静态阅读；未运行测试、构建、外部 Runtime、模型或网络，因此不复核文档中的测试数量与真实服务验收。
- 父任务正在四个 Cursor Auto worktree 实施的 operations 代码未计入完成度。
- 当前代码是可靠性较强的**单机、单 Owner、CLI 控制平面基础**，不是完整 AI Workforce OS 产品。
- 当前产品完成度：
  - **12 个 PRD Center：0 个达到完整产品验收**，其中 6 个有不同程度后端基础。
  - **19 个 UX 页面：0 个实际存在**。
  - **10 条 UX 验收标准：0 条通过**，后端仅为其中若干条提供基础。
- 当前仓库没有 `web/`、`src/api/`、`src/communication/`、`src/knowledge/`、`src/analytics/`、真实 Source/IM Connector 目录。`package.json` 也没有 Web、HTTP Server 或前端依赖。

## 2. 实际入口可用性

| 入口/能力 | 当前事实 | 判定 |
|---|---|---|
| CLI | `src/cli/index.ts`、`src/cli/task-commands.ts` 提供 init/configure、员工、项目、任务、执行、验证、审核、备份等命令 | **基础可用** |
| API | 没有 `src/api/`、HTTP Server、认证、幂等命令接口、SSE | **不存在** |
| Web | 没有 `web/`、路由、组件、主题、页面或前端测试 | **不存在** |
| IM | 只有迁移 Core 中的 Trigger/Thread/ChannelRef/Outbox 抽象；没有平台连接、身份映射或发送器 | **产品不可用** |
| 外部任务来源 | `LocalTaskService` 只接受 `manual:<workspace>:<project>`；没有钉钉/GitHub/API Source Adapter | **仅手工 CLI** |
| Runtime | 一个硬编码的本地 Claude Code driver，加独立 Runner | **单 Runtime 基础，不是 Runtime Center** |
| 长期运营 | 当前公开入口是 `run-once`；`pollIntervalMs` 尚未形成已验收长期控制循环 | **未完成；在途 operations 不计入** |
| 自动测试闭环 | `tests/compiled-task-cli.spec.ts` 的完整闭环使用 mock Claude fixture | **不能等同真实外部 Runtime/IM E2E** |

---

## 3. 12 个 PRD Center 追踪

| PRD Center | 当前代码/测试证据 | 缺失行为 | 结论 |
|---|---|---|---|
| 1. Command Center | `TaskQueries.counts/list`；CLI `status/tickets`；`tests/task-queries.spec.ts` | 无首页、活跃 Agent、审批、失败、集成异常、团队动态、时间筛选、跳转或操作 | **仅统计查询基础** |
| 2. Workforce Center | `src/workforce/employees.ts` 支持创建、更新、启停、版本快照；`tests/employees.spec.ts`；CLI 仅 create/list/enable | 无头像、团队、Skills、Workspace、Permissions、任务历史、Activity、Performance；无编辑/禁用 CLI；员工状态不含健康/负载 | **配置仓储基础** |
| 3. Organization Center | 无 Organization/Department/Team 实体或测试 | 无组织层级、负责人、成员关系、协作关系、团队权限、组织图 | **未实现** |
| 4. Task Center | `Lifecycle` 状态机；`LocalTaskService`；任务审批、取消、重试、验证、审核；`tests/lao-core.spec.ts`、`task-application.spec.ts`、`compiled-task-cli.spec.ts` | 仅手工来源；无编辑、负责人、重新分配命令、子任务、依赖、项目视图、Discussion、多次执行详情、交付物管理；缺 Planned 状态 | **最强 CLI 基础，但不是完整任务中心** |
| 5. Collaboration Center | 旧 Core 有 Thread 订阅、follow-up、note、输入交接语义，见 `core-engine.spec.ts` | 无 WorkflowDefinition/Run、DAG、子任务、并行节点、人工节点、结果汇总、审查/集成任务 | **未形成多 Agent 协作产品** |
| 6. Communication Center | `Trigger`、`Thread`、`ChannelRef`、`Replies`、SQLite Outbox；大量 Core 测试 | `LocalTaskService` 使用 `noopOutbox`，输入 delivery 明确 unsupported；无 Conversation/Message、用户映射、ChannelBinding、平台连接或真实发送 | **领域遗产基础，IM 不可用** |
| 7. Runtime Center | `ClaudeCodeAdapter`、Runner、ExecutionRepository、进程恢复与 UNKNOWN 占用；相关 Runner/Execution 测试 | 只有 `claude-local`；无 Runtime 注册表、实例 CRUD、版本/健康检查、SDK/API/Remote、第二驱动；activeInput/continue/pause 均为 false | **单 Runtime 执行底座** |
| 8. Governance Center | Task 执行审批/审核；`ApprovalRepository` 提供作用域、过期、自审禁止、单次消费；`tests/approvals.spec.ts` | 通用 ApprovalRepository 未接入任务应用/CLI；其注释明确依赖调用者传入 `authorized`，不认证 actor；无用户/角色、资源授权、ActionExecutor、全局急停 | **规则与仓储基础，产品治理未闭环** |
| 9. Knowledge Center | Artifact、任务审计、来源快照可作为未来来源证据 | 无知识条目、版本、分类、权限、全文搜索、发布审核、项目/Agent 绑定 | **未实现** |
| 10. Performance Center | 有 TaskAudit、ExecutionRecord、持续时间及结果事实 | 无指标投影、复杂度/质量口径、费用、利用率、钻取页面。Claude parser 可返回 usage，但 `LocalOrchestrator.finalizeTerminal` 未持久化 usage/session | **仅少量原始事实** |
| 11. Integration Center | Project 绑定本地 Git；Runtime 命令配置；Intent 类型含 `writeback` | 无连接实体、凭证引用、健康、授权范围、事件日志；LocalOrchestrator 没有 writeback handler；无 DingTalk/GitHub/CI/Webhook 实现 | **未实现集成中心** |
| 12. Automation Center | Intent 队列、规则 assessor、调度 tick 是内部基础设施 | 无 Automation 实体、定时/事件/条件触发器、工作流绑定、启停、预算、运行历史；当前入口仍是 `run-once` | **不是用户自动化产品** |

---

## 4. 19 个 UX 页面追踪

| UX 页面 | 实际证据 | 关键缺失 | 状态 |
|---|---|---|---|
| 1. Overview | `TaskQueries.counts`、CLI `status` | 无页面、当前工作、关注事项、团队动态、审批/异常操作 | 未实现 |
| 2. Inbox | Core 有 Trigger/Eval/Attention 概念 | 无统一收件箱查询、分类、接受/拒绝、标记处理 | 未实现 |
| 3. Organization | 无对应模型 | 无组织图、部门、目录、组织变更 | 未实现 |
| 4. AI Employees | EmployeeRepository、CLI create/list/enable | 无列表/详情页面及 Profile、Skills、权限、绩效等页签 | 未实现 |
| 5. Teams | 无 Team 实体 | 全部缺失 | 未实现 |
| 6. Tasks | 完整度较高的任务状态机和 CLI 命令 | 无 Web 列表/详情/看板；无子任务、依赖、Discussion、交付物浏览 | 未实现 |
| 7. Projects | ProjectRepository、CLI create/list；仓储还支持 update/archive | 无项目详情、成员、Agent、任务、知识、活动；CLI 未暴露 update/archive | 未实现 |
| 8. Workflows | 名为 `WorkflowRepository` 的接口实际只负责来源绑定、领域事件和审计 | 无工作流定义、版本、节点、运行或编辑器 | 未实现 |
| 9. Automations | Durable Intent 仅是副作用队列 | 无用户自动化对象和运行管理 | 未实现 |
| 10. Conversations | Trigger/Thread/Replies 是可复用概念 | 无 Conversation/Message 数据模型、消息列表或 Web 对话 | 未实现 |
| 11. IM Channels | 只有 `ChannelRef` 类型 | 无连接、Bot、凭证、群绑定、验证、暂停接收、事件日志 | 未实现 |
| 12. Executions | ExecutionRepository；CLI `executions`；Runner 日志文件 | 无页面、实时日志、结构化事件、资源使用、停止/重试 UI；没有安全日志流 API | 未实现 |
| 13. Runtime | Claude adapter 能力声明 | 无 Runtime 列表、详情、实例健康、会话和配置管理 | 未实现 |
| 14. Approvals | 两套基础：Task lifecycle approval 与通用 ApprovalRepository | 无统一列表/详情；两套审批未统一；无要求修改、风险上下文页面 | 未实现 |
| 15. Monitoring | `doctor`、`run-once` counters、UNKNOWN 状态 | 无系统健康读模型、队列深度、Worker/Source 状态、诊断或导出 | 未实现 |
| 16. Knowledge | 无领域模块 | 全部缺失 | 未实现 |
| 17. Analytics | 无分析模块 | 全部指标、维度和钻取缺失 | 未实现 |
| 18. Integrations | 本地 Git/Claude 配置是底层绑定 | 无连接管理页面或统一 Integration 模型 | 未实现 |
| 19. Settings | 私有 `settings.json`、CLI configure；安全校验较完整 | 无 Workspace、用户角色、权限、安全策略、通知、保留、审计、系统健康页面 | 未实现 |

**页面完成度：0/19。** 当前不存在静态 Dashboard，因此也不能把后端查询或 CLI JSON 输出算作页面交付。

---

## 5. 10 条 UX 验收标准

| # | 验收标准 | 实际证据与缺口 | 判定 |
|---|---|---|---|
| 1 | 每个一级导航有完整页面 | 无 Web 应用 | **未通过** |
| 2 | 核心页面有列表、详情和真实操作 | CLI 有部分列表/操作，但没有页面与详情体系 | **未通过** |
| 3 | 加载、空、错误、无权限状态 | CLI 有错误返回；没有页面状态设计 | **未通过** |
| 4 | 重要操作有确认和结果反馈 | 后端有状态校验、取消停止确认；无 UI 影响范围确认和异步反馈 | **未通过** |
| 5 | Task/Agent/Execution/Workflow/Message 可关联跳转 | 存在部分 ID 关联；无 Workflow/Message 产品实体及导航 | **未通过** |
| 6 | Agent/Task 状态及时更新 | Runner 状态可持久化，但需手工 `run-once`/查询；无 daemon/SSE/Web | **未通过** |
| 7 | IM 会话关联任务 | Trigger/Channel 可关联 Ticket，但无会话、身份映射或 IM Connector | **未通过** |
| 8 | 查看工作流节点进度 | 无工作流模型 | **未通过** |
| 9 | 深色和浅色主题 | 无 Web | **未通过** |
| 10 | 桌面完整、移动关键操作可用 | 无 Web/移动响应式实现 | **未通过** |

---

## 6. 不安全的完成度表述

以下表述都缺乏当前代码/测试支持，不能用于发布说明：

1. **“AI Workforce OS 已完成”**  
   当前只是独立本地控制平面与 CLI 闭环。

2. **“API/Web 已可用”**  
   没有 API 或 Web 工程。

3. **“钉钉接入已完成”**  
   当前 `src/` 没有钉钉 Source/IM Connector。测试中的 `ding:team-a` 只是字符串 fixture。

4. **“IM Native 已实现”**  
   Core 的 Trigger/Thread/Outbox 不等同平台连接、身份认证、会话产品和消息投递。

5. **“审批中心已完成”**  
   通用 `ApprovalRepository` 未接入应用命令；任务审批走另一套 Lifecycle 路径，且没有审批列表或可信认证层。

6. **“支持多 Agent 协作”**  
   调度器可从多个员工配置中选择一个执行者，但一个 Task 仍是单 Assignment 路径；没有子任务、DAG、交接或汇总。

7. **“Runtime Agnostic 已实现”**  
   Employee 有 `runtimeId` 字段，但 Orchestrator 硬编码 `claude-code`，设置也只允许 `claude-local`。

8. **“权限已经强制隔离”**  
   Claude 参数限制工具并通过 prompt 约束工作目录，但没有 OS 沙箱、完整文件范围授权或网络隔离；不能把 prompt 当强制治理。

9. **“监控/daemon 可运营”**  
   当前公开执行方式是 `run-once`。在途 operations worktree、72 小时运行与恢复验收均未计入。

10. **“备份覆盖完整产品数据”**  
    `src/storage/backup.ts` 明确是 database-only，不包含 Artifact、Runner 日志或凭证。

11. **“自动测试证明真实 Claude Runtime 可持续运行”**  
    当前完整 CLI E2E 使用 mock fixture；`claude-adapter.spec.ts` 也明确区分 parser mock 与 live Runtime 验证。文档中的历史真实 smoke 不能替代当前可重复自动验收。

12. **“WorkflowRepository 表示工作流已实现”**  
    该接口目前只存领域事件、来源唯一绑定和 TaskAudit，与 UX 工作流定义/节点运行无关。

---

## 7. 关键实现依赖与设计缺口

1. **先统一应用层，再开放 API/Web/IM**  
   Web 和 IM 必须复用同一命令与授权规则，不能直接调用 Repository 或各自实现任务状态机。

2. **需要可信 Principal/认证上下文**  
   当前是单 Owner，Owner 来源于本机设置；通用 ApprovalRepository 只信任调用者传入的 `authorized`。多用户、Web 和 IM 前必须解决认证、Workspace membership 与资源授权。

3. **需要统一两套审批模型**  
   Task 执行审批/最终审核与通用作用域 Approval 目前相互独立。审批中心需要统一列表、版本、状态、actor、风险和审计契约。

4. **需要 RuntimeDefinition/RuntimeInstance Repository**  
   当前 Runtime 只是设置文件中的单实例命令，无法支撑 Runtime 页面、健康检查、第二驱动或员工绑定验证。

5. **需要面向产品的详情读模型**  
   `TaskQueries` 只有简化列表行与计数。Task 详情、Execution 日志、审批上下文、Overview/Inbox 均缺专用查询。

6. **需要持久化 Usage 与能力事实**  
   Claude parser 已能解析 usage/sessionId，但终结流程没有保存；Analytics 和成本无法据此实现。

7. **`reviewRequired` 语义未真正执行**  
   字段被记录，但 Lifecycle 当前无论其值如何都要求 REVIEW→显式 review 才能 DONE。必须明确是始终人工审核，还是实现版本化自动完成策略。

8. **外部来源唯一性需要连接作用域**  
   当前 `source_issue` 唯一键是 `(source, issue_id)`。多组织、多 DingTalk 连接前需要 Connection/Workspace 范围，避免身份碰撞。

9. **writeback 只有类型，没有实现**  
   Intent 支持 `writeback`，但 LocalOrchestrator 只注册 launch/stop handler，尚无回写、UNKNOWN 对账与外部回读。

10. **Web 实时状态依赖 operations + SSE**  
    在长期控制循环、恢复对账和事件游标稳定之前，不应让前端显示“实时运行”或自动启用停止/恢复按钮。

---

## 8. Operations 之后建议的 3 个代码交付 Slice

### Slice 1：R1 应用 API 与产品读模型

**目标：** 从 CLI 基础升级为可供 Web/IM 共同使用的本机认证 HTTP API，不先做静态页面。

**并行文件所有权：**

| Agent | 独占范围 |
|---|---|
| A | `src/application/workforce/**`、`src/application/projects/**` 及对应测试 |
| B | `src/application/work-management/**`：Task、Execution、Verification、Review、Cancellation |
| C | `src/storage/read-models/**`：Overview、Inbox、Task Detail、Execution Detail、Approval/Monitoring 查询 |
| D | `src/api/**`、`tests/api/**`：认证、幂等键、版本冲突、错误码、SSE、composition root |

**完成判据：**

- 本机可信认证，不接受客户端自报 actor。
- 员工、项目、任务、执行、审批、监控均有命令与查询 API。
- API 查询不初始化或迁移存储。
- Task/Execution/Approval 使用 version、idempotency key 和稳定错误码。
- SSE 可恢复游标；断线不伪造实时性。
- API E2E 覆盖创建→审批→执行→验证→审核→DONE，以及取消、失败、UNKNOWN。

### Slice 2：R1 Web 管理中心与核心 10 页

**目标：** 交付第一个真实可操作 Web 产品，而不是统计原型。

**并行文件所有权：**

| Agent | 独占范围 |
|---|---|
| A | `web/src/app/**`、`web/src/ui/**`：布局、路由、API client、深浅主题、响应式、全局状态 |
| B | `web/src/features/tasks/**`、`web/src/features/executions/**` |
| C | `web/src/features/employees/**`、`runtime/**`、`projects/**` |
| D | `web/src/features/overview/**`、`inbox/**`、`approvals/**`、`monitoring/**`、`settings/**` |

**完成判据：**

- 首批真实页面：Overview、Inbox、AI Employees、Tasks、Projects、Executions、Runtime、Approvals、Monitoring、Settings。
- 每页具备 loading、empty、error、forbidden、conflict、operation-in-progress。
- 所有按钮根据后端权限、状态和 Runtime capabilities 决定可用性。
- Task、Employee、Execution、Approval 可双向跳转。
- 深色/浅色可用；桌面完整，移动端至少支持任务查看、审批、取消和监控告警。

### Slice 3：R1–R2 IM Native 基础与 DingTalk 首连接

**目标：** 形成真实 Conversation/Message/Identity/Channel 产品闭环，而不是把 Core Thread 当成 IM 产品。

**并行文件所有权：**

| Agent | 独占范围 |
|---|---|
| A | `src/communication/domain/**`、`src/communication/storage/**`：PrincipalMapping、Conversation、Message、ChannelBinding |
| B | `src/integrations/dingtalk/**`：连接、鉴权引用、事件校验、分页/去重、发送与回读 |
| C | `src/application/communication/**`、`src/api/routes/communication/**`：消息→Task、审批、查询、Outbox/Delivery |
| D | `web/src/features/conversations/**`、`im-channels/**`、`integrations/**`、`notifications/**` |

**完成判据：**

- 外部身份使用稳定 userId + organization + connectionId，禁止昵称授权。
- 群聊可绑定 Agent/Team；消息可关联或转换为 Task。
- 重复事件不重复建 Task；消息、任务、审批和交付可追踪。
- writeback 支持 DELIVERED/FAILED/UNKNOWN，UNKNOWN 必须回读，不盲重发。
- Fixture 契约测试与真实 DingTalk sandbox 验收分开记录。
- 未完成真实 sandbox 验证前，不声明 DingTalk 已运营。

完成以上三片后，下一优先队列应是：**Organization/Teams → Workflow DAG/多 Agent 协作 → Automations → Knowledge/Analytics**，而不是继续扩大 CLI 命令面。
