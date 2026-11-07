# R1-F Runner隔离基础验收

本阶段实现低层Runner显式required模式与OS probe，尚未向正式Claude应用settings开放。Claude filesystemIsolation能力仍为false。旧v1运行/恢复语义保持；本阶段不替用户接受任何生产交付。

## 实际实现

- 固定srt0.0.81的macOS Provider；Node probe和目标整个进程树使用同一provider/config。其他平台required模式拒绝；没有原命令fallback。
- literal cwd与显式只读代码/库例外，默认树外读拒绝；只允许cwd写入及必要stdio设备。显式撤销srt共享临时/便利日志写默认值，内部设置私有临时目录；无HOME全局读许可。
- 必须与整个Runner私有根互不包含，用户read exceptions也不能覆盖私有控制根。网络默认拒绝，公网域名需显式配置；拒绝本地/IP/special suffix，并阻止私网/回环/链路本地解析结果。
- 准备期间心跳/认证stop/预算有界；配置拒绝和确定失败在目标spawn前FAILED，辅助进程/清理证据不确定为UNKNOWN。目标结束且辅助清理确认后才发布终端状态。
- 新required请求/快照/事件v2；旧v1不带证明，不自动升级。规范化启动规格包含隔离需求，Runner/Verification重放比较一致。
- 私有containment.json在目标启动前签名、独占0600写入并fsync，绑定请求、Runner、provider版本、cwd设备/inode与requested/effective配置摘要。客户端在接受v2 RUNNING/有processId/成功前验证；损坏或重放返回UNKNOWN。
- 目标不继承库返回的整个process.env；只使用原白名单。代理令牌进入日志脱敏；request控制token不交给目标。

## 直接验收

真实OS测试位于tests/containment.spec.ts、contained-runner.spec.ts、containment-cli.spec.ts：

1. 树内读写成功；树外及相邻目录读/覆盖/新建失败；符号链接越界失败；子进程越界读失败。父进程核验哨兵未变与新文件不存在。
2. required目标自身写树内文件成功、树外写失败；直接TCP连接自有监听器失败且服务未接连接。使用自有临时文件和本地服务，没有外部业务写入。
3. 共享/private/tmp/claude回归只创建随机自有子目录；覆盖哨兵和创建新文件都被OS拒绝，树内正向对照仍成功。未读取/修改已有Claude业务文件。
4. 嵌套控制目录在客户端拒绝；绕过客户端直接启动编译Worker同样在目标启动前FAILED。
5. required请求v2/proof跨新客户端保留，重复start只观察原执行，实际launch-count为一次；策略变化冲突。MAC/证据损坏使status返回UNKNOWN，恢复原私有proof后可观察原终端状态。
6. 实际超时、活动取消、预置认证stop、依赖/策略失败都确认真实目标结果；失败required策略不创建TARGET_WAS_LAUNCHED。
7. 测试Runtime凭证和代理令牌不出现在日志，私有环境channel未下传；参数中的引号、命令替换文本保持字面量。
8. 编译CLI containment-probe不创建DB或配置，不读认证、不调用模型；未知参数拒绝。

tests/containment-evidence.spec.ts为独立Codex交付，父Agent审阅并修正了策略收紧后的测试域名。真实文件测试覆盖精确请求/Runner/密钥绑定、篡改与重放、权限、硬链接/符号链接、畸形/超大/不完整证明。

tests/containment-lifecycle.spec.ts明确使用Provider故障注入，只验证清理失败的UNKNOWN顺序；不把mock当OS边界证据。它运行真实自有Node目标，确认退出0后也没有SUCCEEDED事件。

最终完整门禁与日志摘要见CHECK.json，包括原全部任务/验证/控制器/认证/Web回归及无node_modules Core smoke；新依赖frozen-lockfile安装成功。没有跳过测试或测试专用生产接口。

## 真实Claude兼容性：未通过

使用实际已安装Claude2.1.181二进制，仅运行--version，无模型任务、认证检查或外部网络许可。OS probe/proof通过后，二进制以SIGTRAP终止，version未识别。首先观察到macOS/private/var/select/sh读取拒绝，增加该系统文件的准确只读例外后仍SIGTRAP；修正私有TMPDIR后仍未成功。最终失败记录见CLAUDE_VERSION_PILOT_FAILED.json。

因此默认Claude应用路径/配置和能力不变；Node通过不代表Claude通过。下一步须在不放宽用户目录/私有控制根的条件下定位启动需要，再分别验证可信配置、认证、允许域名和小型模型任务，才接入产品settings。真实钉钉、其他OS、多Runtime路由、多用户/工作流、72小时运行及全量产品仍未验收。
