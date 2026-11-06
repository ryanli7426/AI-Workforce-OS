# R1-E Runtime registry 验收

完成统一声明式适配协议、可信工厂注册表、Claude实现兼容迁移及调度接线。新增runtimes CLI、GET /api/v1/runtimes和Runtime注册页。本阶段没有新增运行时依赖、表结构迁移或Core改动。Execution JSON记录新增可选runtimeRevision用于绑定解释协议。

## 真实验证

- tests/runtime-registry.spec.ts：重复/未知/不完整注册拒绝、不可变能力快照、适配器身份/能力匹配；执行命令、cwd、execution/assignment/ticket/generation不能被工厂改写，时间/输出/退出宽限不能超出应用授权；原Claude JSON成功/权限拒绝解释继续成立。
- tests/local-orchestrator.spec.ts：自有Node fixture驱动输出CUSTOM_RESULT_OK，通过真实Runner进程、Git worktree和重启收集不可变产物。该输出不是Claude格式，说明调度器确实使用注册驱动的解析器。错误驱动、同名不同protocolVersion及能力变化的对账被拒绝，错误解析器调用次数为0且Assignment不结束；恢复正确配置后只存在一条Execution，原仓库字节不变，Task进入REVIEW、verification仍unknown。
- tests/task-cli.spec.ts：runtimes只读查询，不初始化缺失目录、不改变库、不执行配置中的自有哨兵脚本、不显示命令路径；未知探测参数拒绝。另证实只有settings、缺失/损坏数据库时也可诊断，且不会创建或修改数据库。
- tests/api-server.spec.ts：未认证401、未知参数400、同一能力目录、health not_checked，无新增Execution及命令路径。
- web/src/runtime-api.spec.ts和pages/runtimes.spec.tsx：私有认证请求、严格DTO/驱动关系校验、不接收虚构healthy、重复ID或额外command字段，错误显示及刷新真实配置。
- web/e2e/runtime-flow.spec.ts：编译CLI+生产Web+编译API+SQLite，三种入口得到相同目录；已配置/尚未检查及文件系统隔离不支持均准确显示；无Execution启动、凭证未出现在服务输出，390px布局不溢出。截图runtime-registry.png已目视检查。

完整pnpm check通过：63文件836后端测试、14文件110前端测试、5条Chromium流程；无跳过。类型/构建/独立Core+SQLite smoke/编译CLI smoke/DeepSeek依赖扫描通过。日志摘要见CHECK.json。独立审查后增加协议指纹与配置诊断修正，最终完整门禁和审查处置以CHECK.json及PARENT_REVIEW.md为准。

新增存储测试证明指纹跨重开保留、冲突reservation重放被拒绝；旧Claude无指纹记录通过固定历史协议身份恢复。该兼容常量不能随未来驱动修改而重新计算。

## 能力与未完成范围

当前正式驱动仍只有Claude Code，正式settings仍为claude-local单实例；fixture不是第二产品Runtime，也不代表多Agent路由完成。工厂由可信应用代码安装，配置/HTTP不能加载任意模块。CLI可配置Claude可执行路径，Web只读注册目录，不提供动态注册/健康探测或启动按钮。

Runner负责真实进程启动、停止、状态、收集和恢复观察；适配器负责LaunchSpec/解析，不再为每个模型重复写进程管理。未支持的Agent追加输入、会话恢复、Agent监控重连及暂停继续如实为false。filesystemIsolation也为false，Worktree/tools不是强沙箱。后续实施与负向probe要求见tasks/RUNTIME_CONTAINMENT_PLAN.md。

未调用真实模型/钉钉，没有自动执行真实任务或接受历史Claude交付。完整产品、OS服务、72小时运行、真实IM、多实例身份/路由、多用户/组织/工作流/知识/分析等仍待验收。
