# 产品交付跟踪

目标：完成 MASTER_PRD 与 PRODUCT_UX_SPEC 的完整 AI Workforce OS；由主 Agent review/集成，多本机 Agent 按独立工作区实施。本文按真实验收更新，不把某次阶段交付当作整个产品完成。

| 范围 | 当前状态 | 证据/下一步 |
| --- | --- | --- |
| B0 独立工程/Core/SQLite/基础 CLI | 已验收 | BOOTSTRAP；207 项测试、独立构建与 smoke |
| R0-A 执行底座 | CLI 组合已验收 | Runner 脱离控制进程运行/恢复观察、UNKNOWN 占用、真实故障集成测试；最新完整门禁670后端 + 69前端测试及2项真实浏览器验收 |
| R0-A Claude Runtime 接入 | 基础与 Task CLI 接线已验收 | 真实 Claude 隔离修改/产物检查；mock Runtime 编译后 CLI 全流程分别验收 |
| R0-B 工作接入与调度 | 本地控制器/CLI 已验收；外部入口进行中 | 前台串行控制循环、明确停止、查询日志；真实钉钉待目标和返回契约 |
| R0-C 可运营治理 | 组合已验收；持续运行验证未完成 | 真实控制进程退出/被杀后保留原 Runner、锁恢复；670后端/69前端测试与真实Claude控制器pilot；72小时运行/OS服务尚未验收 |
| R1 独立 API 与 Web | API与首批可操作Web已验收；全量Web继续实施 | 真实TCP与Chromium创建/批准/取消闭环；7类资源视图部分覆盖；员工/项目写API与Web治理、执行列表已交付；异步验证与SSE继续实施 |
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

## 2026-11-05：R1 首批 Web 的真实范围

已提供概览、任务列表与创建、任务详情与治理操作、审批/验收筛选、员工配置只读、项目配置只读、执行详情与日志。单Owner认证、同源部署、内存凭证、版本冲突与幂等重放复用后端应用层；真实Chromium测试使用编译后API和SQLite，未调用模型。

此交付仅覆盖UX中6个模块的部分行为，不是19个模块的完整验收。原真实Claude任务在Web只读展示REVIEW、独立验证passed与执行日志，未代替人点击验收。操作与证据见 WEB_OPERATIONS.md、reviews/r1/WEB_ACCEPTANCE.md。

下一顺序：可靠异步验证命令/API → SSE → Runtime注册/范围加固 → IM真实接入与组织协作。员工/项目治理与执行列表已通过真实浏览器验收。真实钉钉仍缺指定业务目标与字段契约；72小时运行、OS服务、多用户、工作流、知识/分析/自动化仍未完成。

## R1-B：员工/项目治理与执行中心

已完成三路Cursor治理实现、Pi执行查询及父 Agent集成；Codex5.6提供异步验证设计，Claude独立审查。真实浏览器完成项目与员工的创建/启停/编辑/归档和审计，旧任务闭环继续通过。新schema仅显式init安装，进程与Runtime不因配置命令隐式启动。详细证据与当前门禁见 reviews/r1b/MANAGEMENT_ACCEPTANCE.md 和 CHECK.json。

异步验证存储任务已开始；worker/Coordinator、可信plan配置、API/Web和恢复验收仍未完成。组织/团队、多人权限、工作流、知识/分析等完整产品范围保持不变，不将本次配置页算作整个模块验收。
