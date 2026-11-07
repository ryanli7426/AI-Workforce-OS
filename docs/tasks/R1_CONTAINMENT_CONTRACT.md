# R1-F required Runner containment contract

范围：为独立Runner提供显式required模式、真实OS负向probe与可验证私有证据。当前仅macOS/srt0.0.81；其他平台要求该模式时失败关闭。正式Claude应用配置保持原语义，filesystemIsolation:false不变，未通过真实Claude启动/认证/模型任务验收前不接入产品自动执行。

## 实施与审查

父Agent拥有provider/policy/evidence、Runner客户端/工作进程/协议、验证器规格比较、CLI、实际OS/编译CLI/Runner测试及集成。Codex明确gpt-5.6-sol做只读设计、实现审查，以及仅拥有tests/containment-evidence.spec.ts的独立证据测试。代码审查结果与最终门禁记录于reviews/r1f。

## Boundary

- 使用独立于Core/模型的srt-macos provider。@anthropic-ai/sandbox-runtime固定0.0.81，无API key或模型服务依赖；仅worker/probe调用时动态加载。Zod固定3.25.76覆盖srt的损坏3.25.0发行包，pnpm11的override位于pnpm-workspace.yaml。
- 默认拒绝树外读取与写入；允许准确canonical cwd、明确只读Runtime代码/库例外及有限系统路径。只读例外不能暴露整个Runner控制根目录及其上下级；cwd与Runner控制根目录必须互不包含，在客户端和工作进程分别检查。系统shell selector只读路径/private/var/select/sh来自真实失败证据，不开放整个HOME。
- 显式撤销srt的隐式树外写入默认值（含共享/tmp/claude及HOME便利日志目录），仅保留标准输出/错误/null设备。不能只改变TMPDIR而仍允许按绝对路径写共享目录。摘要包含初始化后的effective read/write配置；真实回归仅创建自有共享临时子目录哨兵。
- 网络默认全部拒绝，可信请求可列出明确公网域名；拒绝IP literal、单标签/local特殊域名，并配置解析结果的私网/回环/链路本地拒绝范围；无通配URL/交互ask callback、本地bind或用户srt配置。目标实际获得的网络策略不等同所有程序都支持HTTP代理。
- 所有路径以literal方式交给srt，shell参数完整单引号转义，不拼接未转义任务文本。library返回的env在macOS等于process.env，禁止转发；目标只继承Runner原白名单环境。srt生成的代理认证token加入日志脱敏。私有运行临时目录在cwd内，显式在sandbox内部重设TMPDIR/TMP/TEMP覆盖srt默认/tmp/claude。
- srt基于OS进程树限制，不提供对独立同UID恶意宿主进程的对抗。明确读取例外本身可被该进程读取，不声称整个进程绝不读取任何系统/运行文件。

## Probe and lifecycle

每个required执行都在目标启动前，使用相同provider/config运行固定无凭证Node程序：树内读写正向成功；树外及相邻目录读/覆盖/新建均失败；树内符号链接越界失败；子进程越界读失败。宿主检查外部哨兵原字节与新文件不存在。helper进程组、读写缓冲、准备/包装/终止时限均有界；不能确认终止或清理时UNKNOWN保留证据，不当作确定失败释放任务。

准备期间写心跳、轮询认证stop并受独立10秒准备预算约束；目标timeout从真实包装进程spawn后计时。显式stop与超时均在spawn前再次检查。确定的依赖/策略/probe拒绝产生pre-target FAILED，无processId，不运行原命令；不回退裸spawn。运行后沿用原进程组停止和终端确认机制。

## Protocol and persistence

- 旧无containment请求/快照/事件保持v1。包含required策略的新请求/快照/事件为v2。v1携带策略或v2缺策略均拒绝；旧执行不自动升级。
- canonicalLaunchSpec用于Runner重放、签名及Verification wrapper比较，包含策略深拷贝。已有v1目录收到带required的新start时保持严格规格冲突，不能静默返回未隔离成功。
- probe通过后，以0600独占写containment.json、fsync文件及父目录；内容包括provider版本、canonical config摘要、cwd设备/inode、固定通过标记/时间、准确规范化请求摘要、Runner身份及HMAC。不是内部Seatbelt profile字节摘要。
- v2的RUNNING/SUCCEEDED或任何已有目标processId的快照，必须有私有proof且匹配签名、请求/Runner身份与快照。证明异常读者返回UNKNOWN。旧v1不能携带隔离证明。proof私有读取有大小/权限/属主/单链接/descriptor及最终inode围栏。
- request.json与proof始终在目标可写范围之外，目标不获得控制token。Runner控制证据仍保留在私有数据目录；未新增DB表或修改Core状态机。

## Acceptance and limits

真实Node/系统进程fixture覆盖OS拒绝、direct TCP拒绝、argv转义、证据损坏/请求冲突、重启只观察、超时、取消、preflight stop与私有目录拒绝。编译containment-probe只运行自有临时文件、无模型、无数据库/认证读取。原全套Task、验证与Web流程必须继续通过。

真实已安装Claude2.1.181的--version尝试在该严格策略下SIGTRAP，属于明确失败；没有调用模型、检查登录或接受真实Task。该失败不降低required模式要求，也不把fixture通过算作Claude适配完成。后续需在保持边界的前提下处理系统运行需求、可信配置/认证例外、域名策略及真实模型小型pilot，才考虑显式settings接线和产品能力声明。
