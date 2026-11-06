# R1-E Runtime registry delivery contract

目的：移除应用调度器直接构造Claude适配器的耦合，通过可信注册表提供统一声明式Runtime协议、能力目录和可操作查询入口。Core、Runner进程协议、SQLite表结构和任务审核边界不变；Execution的JSON记录增加可选解释身份字段。

## Ownership and boundaries

父Agent实施并集成ports/registry/builtins、Claude类型兼容、Orchestrator与CLI/API/Web接线、所有新增测试与文档。独立本地Codex以gpt-5.6-sol分别做范围设计审查和最终只读代码审查；不得修改用户认证配置或启动真实模型任务。

RuntimeAdapter只将标准任务转为LaunchSpec并解释退出结果。start/status/stop/collect仍由独立Runner及ExecutionService负责，恢复观察不等同Agent会话恢复。当前activeInput/continueSession/reattachMonitor/pause均false，不新增无效操作按钮或模拟成功。

RuntimeRegistry仅由可信应用代码安装工厂，不从settings/HTTP加载模块、命令模板或脚本。构造和查询不启动CLI、不探测认证。实例settings继续保留claude-local单实例，未实现多实例配置、第二产品Runtime或能力自动路由。

## Contract

- ports.ts提供通用任务、结果、用量、驱动能力和工厂类型，不依赖某个模型SDK。
- 注册表拒绝未知/重复/不完整驱动，快照并冻结公开元信息。工厂结果必须匹配驱动身份与能力。驱动声明正整数protocolVersion；id/协议/能力形成SHA256指纹，新的Execution.runtimeRevision持久化该指纹。更改不兼容协议必须提升版本。LaunchSpec必须保留execution/assignment/ticket/generation/cwd与配置的可执行文件，不能提高timeout/output/grace上限。
- Orchestrator通过注册表生成启动规格及解释终端结果，Assignment/Execution记录实际驱动名；CLI明确传入settings.driver。未注册驱动在任何分配前拒绝。
- 重启时仍观察原Runner；未应用终端结果的历史驱动名称/协议指纹不匹配时拒绝解释和释放Assignment，不用当前驱动猜旧结果。恢复原可信配置后再对账。不影响已结束Assignment的历史记录查询。旧无指纹记录仅对已知原Claude print/JSON协议使用固定兼容常量，不能用当前版本动态推定；任意其他无指纹驱动拒绝解释。
- filesystemIsolation如实为false，不将cwd/worktree/tools称为沙箱。能力声明属于已安装驱动实现，未来提供强隔离时必须有实际平台证据。
- runtimes CLI只需已有私有settings，不依赖执行数据库可用；不创建数据目录、settings或数据库。GET /api/v1/runtimes / Web Runtime注册页只展示id、驱动名、capabilities、configured、health not_checked，不返回command路径、认证、环境、CLI版本或虚构在线状态。刷新不启动进程。
- API复用Owner/Host/Origin认证、拒绝未知查询。浏览器使用私有Bearer传输，严格校验DTO关系、能力、重复ID及非预期字段。

## Acceptance

真实自有Node fixture驱动（不是Claude JSON）经Runner、Git worktree、重启、不可变产物进入REVIEW，原仓库不变；错误驱动恢复不释放旧Assignment；正确配置只收集一次，不发生二次启动。未知驱动不分配任务。原Claude适配器/审批/验证/UNKNOWN等回归继续通过。

编译CLI、认证API与生产Web得到相同目录；没有Runtime执行记录、路径或凭证泄露。页面显示已配置与尚未检查、准确的支持/不支持，刷新和390px布局通过。完整pnpm check，依赖扫描、无node_modules Core smoke和原4条浏览器流程均需通过。后续范围加固计划单独记录，不能以本阶段目录查询替代隔离验收。
