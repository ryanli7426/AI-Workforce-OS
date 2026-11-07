# Runtime 文件系统边界：后续实施计划

状态更新（R1-F）：Runner显式required模式及无模型OS probe已实现，Claude产品接入未通过。原设计保留作后续验收依据。当前注册能力filesystemIsolation=false；本文件不是可用功能声明。当前本机Claude Code --version为2.1.181，--help核实存在print、json、tools、setting-sources、safe-mode等选项；本阶段未升级用户CLI或更改认证文件。

## 已确认问题

Git worktree提供独立工作副本和身份检查，不能阻止进程读取工作树之外的路径。当前裸Read/Edit/Write自动许可与user设置可能扩大工具的可达范围。只缩窄提示词或添加未经该版本验证的JSON字段，不能证明隔离。

官方权限文档说明Write(path)不执行按路径匹配，应由Edit规则处理写入；新版blockWritesOutsideWorkingDirectories要求至少2.1.314，且其边界仍只覆盖指定文件工具并有自身运行文件例外。不能把新版文档中的配置直接套在已安装旧版上。来源：[Claude permissions](https://code.claude.com/docs/en/permissions)。

## 拟实施方案与待验证决定

1. 引入独立ContainmentProvider，作为Runner可信组合；要求required隔离时，缺失、不兼容、无有效probe证据即拒绝启动，不能回退裸进程。Core不导入沙箱实现。
2. 首先评估覆盖整个子进程树的OS机制；候选为固定版本的[Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime)。品牌不是绑定条件，Provider必须可替换。R1-F已安装固定0.0.81并验证macOS Node进程树；其他平台和真实Claude仍未验收。详细实施与边界见R1_CONTAINMENT_CONTRACT.md。
3. 每个Execution只授予准确canonical worktree和私有临时目录的写权限。读权限分为任务目录、必要系统库/可执行文件和明确Runtime启动例外；不能默认开放整个HOME、父worktree根或原仓库。网络按本机Runtime实际认证端点建立明确策略，不盲目复制某组域名。
4. 工具权限是第二层防护。先验证目标Claude版本和实际行为，再禁用无关hooks/plugins/skills/MCP；safe-mode与用户模型/认证兼容需要自有临时配置实测。不要为隔离方便静默切换到bare导致OAuth失效，也不读取真实凭证进行排查。
5. 绑定policy/profile摘要、平台/版本、worktree设备/inode、probe结果到Runner证据，启动前复核身份。升级私有协议时保留旧Runner的恢复观察；旧请求不能自动获得“已隔离”标记。
6. 认证例外是明确权衡：可信Runtime自身必须取得认证，不能同时声称整个进程绝不读取任何树外文件。若要求对恶意Runtime或同UID进程对抗，应采用独立OS身份、容器/VM或凭证代理；不以工具hook冒充OS隔离。

## 必须实际运行的无模型负向probe

只在自有临时目录创建≤1KiB哨兵。使用相同固定Provider/profile启动固定Node程序，不运行模型或读取用户文件：

| 场景 | 必须观察到的结果 |
| --- | --- |
| 树内正向对照 | 读、覆盖、新建成功 |
| 树外已有文件 | 读失败；覆盖/截断失败，父进程验证原字节未变 |
| 树外新文件 | 创建失败且文件不存在 |
| 相邻工作树 | 读写创建均失败 |
| 树内符号链接指向树外 | 目标读取、覆盖及目录内创建均失败 |
| 子孙进程 | 同样受限，不能脱离边界 |

超时、信号、中途修改、未知错误或报告缺失都不得计通过。验收报告只记录固定结果与摘要，不输出哨兵内容、认证路径或token。再独立验证真实Claude合法树内编辑和被拒绝的树外工具调用；模型未尝试某项操作不能算拒绝成功。

## 验收和上线顺序

先完成Provider本地负向probe与故障测试，再接Runner协议/恢复、目标CLI版本兼容、可信模型小型pilot，最后开放声明为隔离的自动执行。调度注册、多实例持久身份与第二Runtime另有验收，不用fixture驱动冒充新产品Runtime。72小时运行和真实钉钉闭环依然待验收。

## R1-F 实际结果

新增Runner v2 required分支、逐执行负向probe、HMAC私有证明、准备心跳/停止/预算、UNKNOWN保守处理，以及独立containment-probe命令。旧v1保留原语义，正式Claude配置与能力声明未改变。当前仅macOS srt0.0.81。

自有Node/系统子进程的OS边界和控制协议通过；真实已安装Claude2.1.181执行--version仍以SIGTRAP退出，没有把它计为成功/登录/模型验收。认证/模型使用/应用settings接线仍待完成，禁止把Runner fixture能力等同Claude隔离产品能力。证据见reviews/r1f。
