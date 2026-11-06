# R1-D 实时通知验收

本阶段交付持久化变更通知与认证 SSE，不改变 Task 状态机、验证结果或人工验收权限。SQLite 仍是事实来源，通知只让页面重新查询。完整产品仍按 DELIVERY_TRACKER.md 推进。

## 已验证行为

- ticket/execution/verification_job/employee/project 的15个SQLite触发器在资源事务内写入独立通知表；回滚无通知，不同CLI/Controller/API进程的提交均可观察。
- Owner/Workspace范围先于分页；Task及其执行/验证由实际Task/Project关系证明归属；员工/项目配置按现有工作区共享查询规则通知。通知不含描述、命令、路径、日志或凭证。
- 认证GET /api/v1/events，Bearer保持私有请求头；不支持URL token、Cookie认证或查询调参。恢复游标绑定库epoch及范围。格式错误400，过期/库替换/范围变化/未来游标返回reset；首次连接从当前head重查，ready在初始回放结束后发送。
- 浏览器在处理通知后确认游标，断线按内存游标恢复；页面刷新/断开清除游标与凭证。心跳、握手/空闲/处理超时、帧大小、写入背压、连接数均有界。401/403退出并清理认证会话。
- React50ms合并重复失效请求；确认表示通知已入当前内存批次，不表示HTTP查询成功。断开同时丢弃批次与游标，下次initial reset重新查询。原轮询保留；编辑草稿不被后台刷新覆盖。
- Controller最多每60秒保留最新50,000条通知，不删除领域审计；API单独运行时通知积累至Controller下次对账。过期客户端reset并重查，不能把通知表当永久审计订阅。

## 直接证据

完整pnpm check通过：62文件821后端测试、12文件106前端测试、4条Chromium流程；无跳过。类型/构建、Core+SQLite无node_modules smoke、编译CLI smoke和DeepSeek依赖扫描通过。日志SHA256见CHECK.json。

- tests/change-feed.spec.ts：真实SQLite第二连接/回滚/重开/范围/分页/保留边界/损坏schema及触发器拒绝。
- tests/change-stream.spec.ts：TCP帧顺序、认证组合、游标、心跳、断开/连接限额、背压及关闭。
- tests/realtime-acceptance.spec.ts：真实SQLite+TCP，断线/重启、外部写入、过期恢复、范围和停服。
- tests/compiled-change-stream.spec.ts：编译API保持超过普通10秒超时，实际心跳后带活动流SIGTERM退出0；API停止时外部编译CLI写入，重启后按原游标回放。
- tests/api-idle-connections.spec.ts：停服及时关闭尚未发送HTTP的预连接，已进入处理器的普通HTTP请求正常完成。
- web/e2e/realtime-flow.spec.ts：生产Web+编译API/CLI+SQLite。外部创建2秒内显示（普通轮询5秒）；编辑中停止API、离线写入、同端口重启，观察Last-Event-ID、实时恢复及草稿保留。390px无横向溢出。截图realtime-reconnected.png已目视检查。
- 原创建/批准/取消、员工项目治理、真实独立验证与明确fixture验收三条Chromium流程继续通过。

验收只使用自有临时Git/SQLite/进程，没有模型调用、真实钉钉业务写入，也没有替用户接受历史Claude交付。

## 限制

通知不是日志输出流；仅stdout文件追加不会产生DB变更，日志保留轮询。全局游标存在序号间隔，不声称隐藏所有活动时序。当前单Owner配置与范围校验不是完整多用户权限或实时撤权产品；没有公开的Task跨Owner转移入口。Runtime文件系统隔离、第二驱动、真实IM、多Agent工作流、知识/分析/自动化及72小时运行尚未验收。
