# 本地操作说明

适用：当前独立仓库。前台控制器与 run-once 已交付；认证本地 HTTP API 与首批 Web 已交付；OS 后台服务和真实钉钉接入尚未交付。显式 `start --foreground` 或 `run-once` 调度已授权任务并可能启动 Agent；管理与查询命令不隐式启动 Agent。

## 工程检查与显式初始化

```sh
pnpm install --frozen-lockfile
pnpm check
node dist/cli/index.js doctor
node dist/cli/index.js init --data-dir .workforce
node dist/cli/index.js status --data-dir .workforce
```

`init` 显式初始化主 schema 和应用模块 schema；现有数据目录必须属于专用私有目录（0700），不会修改共享目录权限。旧 schema 导入不是此命令的隐式行为。status/tickets/employees/projects 为只读查询，缺库或模块未初始化会失败，不会悄悄建库。

## 项目配置

准备一个 JSON 文件（示例中的绝对路径应替换成真实路径）：

```json
{
  "id": "demo",
  "name": "Demo Project",
  "ownerId": "local-owner",
  "repositoryPath": "/absolute/path/to/repository",
  "worktreeRoot": "/absolute/path/to/separate/worktrees",
  "allowedTaskTypes": ["documentation"]
}
```

```sh
node dist/cli/index.js project-create --data-dir .workforce --file project.json
node dist/cli/index.js projects --data-dir .workforce
```

repositoryPath 必须是实际 Git 根，worktreeRoot 必须与仓库不重叠；配置操作不创建工作树或修改项目 Git 配置。当前命令限工作区 local，不能指定其他 workspaceId。

## 员工配置

```json
{
  "id": "local-developer",
  "name": "Local Developer",
  "role": "Developer",
  "responsibilities": ["Complete approved local documentation tasks"],
  "capabilities": ["documentation"],
  "runtimeId": "claude-local",
  "projectIds": ["demo"],
  "maxConcurrency": 1,
  "timeoutMs": 3600000
}
```

```sh
node dist/cli/index.js employee-create --data-dir .workforce --file employee.json
node dist/cli/index.js employees --data-dir .workforce
node dist/cli/index.js employee-enable local-developer --data-dir .workforce --version 1
```

员工默认禁止接单，enable 需要当前 version；配置启用不意味着进程已启动或 Runtime 已健康。CLI 不接收 API key、模型凭证或任意权限扩展字段。

## 数据库备份

```sh
node dist/cli/index.js backup --data-dir .workforce --backup-dir /absolute/path/to/private/backups
```

备份通过 SQLite 一致性快照包含已提交的 WAL 数据，并做完整性与哈希验证。当前只备份数据库；产物、日志和凭证需要各自的备份与保留策略。此命令不恢复或覆盖现有数据库。

## 任务应用与执行边界

LocalTaskService 提供经过规则与本地 Owner 校验的任务创建、审批、取消、重试、验证和验收；ExecutionService 管理持久执行与 Runner 对账。以下 CLI 与认证本地 HTTP API 接入同一应用层。

先显式配置 Claude 的真实绝对路径（不会探测凭证或启动模型）：

```sh
node dist/cli/index.js configure --data-dir .workforce --claude-command /absolute/path/to/claude
```

配置落在私有数据目录的 settings.json（0600），已有文件不会覆盖。默认仅接收 documentation 类型，执行前审批与最终人工验收均开启。Owner 使用本机 OS 用户身份生成，不从 Issue 或 `--actor` 读取。更改规则会改变 policyVersion；旧任务授权不会悄悄沿用。

项目和员工按前文创建并启用后，准备 task.json：

```json
{
  "project": "demo",
  "issue": "manual-docs-001",
  "title": "Fix README typo",
  "description": "Correct the specified README typo in the isolated worktree.",
  "taskType": "documentation"
}
```

```sh
node dist/cli/index.js task-create --data-dir .workforce --file task.json
node dist/cli/index.js task-approve TICKET_ID --data-dir .workforce --reason "Approved local scope"
node dist/cli/index.js run-once --data-dir .workforce
node dist/cli/index.js executions --data-dir .workforce
node dist/cli/index.js tickets --data-dir .workforce
```

同一 project/issue 与相同输入重复创建返回原 Ticket；冲突输入报错。`run-once` 执行一个调度/对账轮次，不等待所有任务结束，也不是后台 daemon。重复调用会观察原 Runner，不能靠重复调用重跑 UNKNOWN；进程结束后，再调用一次收集不可变产物并进入 REVIEW 或 FAILED。

REVIEW 后，准备 checks.json。command 必须是实际存在的绝对可执行文件路径，args 是参数数组，timeoutMs 是正整数；示例应替换成项目真实检查，验证器在产物的独立副本中运行：

```json
[{"id":"content-check","command":"/absolute/path/to/node","args":["-e","const fs=require('node:fs');if(fs.readFileSync('README.md','utf8').includes('typoo'))process.exit(1)"],"timeoutMs":10000}]
```

```sh
node dist/cli/index.js task-verify TICKET_ID --data-dir .workforce --checks-file checks.json --reason "Independent content check"
node dist/cli/index.js task-review TICKET_ID --data-dir .workforce --execution-id EXECUTION_ID --artifact-revision SHA256 --decision approved --reason "Accepted exact delivery"
```

执行 ID 与产物 SHA256 从当前执行记录和验证报告获取。验证通过仍保持 REVIEW，只有绑定当前产物的明确验收才到 DONE。确实不需要检查时可使用 `--waive --reason TEXT`，它保存豁免理由并记录 not_required；空 checks 数组不能代替豁免。Task 创建或批准不代表 CI 或验收通过。

```sh
node dist/cli/index.js task-cancel TICKET_ID --data-dir .workforce --reason "Stop requested by owner"
node dist/cli/index.js run-once --data-dir .workforce
node dist/cli/index.js task-retry TICKET_ID --data-dir .workforce --reason "Retry after confirmed failure"
```

取消活动任务产生持久 stop 意图，由活动控制器或下一次 run-once 派发并确认退出；取消请求本身不释放占用。重试仅限允许状态、确认旧进程已停止且未超限的任务，当前不自动重试。原始脱敏 stdout/stderr 与协议证据位于数据目录 runners/EXECUTION_ID，产物位于 artifacts，独立验证报告位于 verifications。私有目录中的 request.json 含控制 token，不应发布。

Runtime 凭证只从应用环境白名单在内存传入，不写入 settings、Ticket 或 Runner request。CLI 仍可能使用其用户认证配置。默认没有 Bash、Push、合并或发布工具授权。cwd、提示词与工具清单是约束手段，不能宣称强 OS 文件系统隔离。

## 持续运行、停止与日志

```sh
node dist/cli/index.js start --foreground --data-dir .workforce
```

此命令占用当前终端，先对账再按 settings.scheduler.pollIntervalMs 连续调度。第二个控制器会因单实例锁被拒绝。它没有安装 launchd/systemd，也没有伪装成脱离终端的 daemon。

在另一终端执行：

```sh
node dist/cli/index.js controller-status --data-dir .workforce
node dist/cli/index.js logs TICKET_ID --data-dir .workforce --tail-bytes 65536
node dist/cli/index.js stop --data-dir .workforce
```

stop 返回 requestedtrue 表示私有认证停止请求已写入；等原前台命令退出、controller-status 返回 stopped 才确认控制器停止。SIGINT/SIGTERM 同样优雅结束控制循环。**控制器停止保留独立运行的 Task Runner**；停止任务应先 task-cancel，再由活动控制器或 run-once 处理 stop 意图并确认退出。

控制器异常死亡后，只对确认死亡的 Owner 恢复控制锁，并观察原 Runner；已存在 Task/Execution 不会因此重新启动。锁元数据损坏、恢复中断或归属变化会失败关闭，不自动删除未知证据。controller-status 只报告控制进程归属/存活情况，不代表 Claude、来源或任务质量健康。

controller-events.jsonl 是私有0600结构化事件文件，单文件上限16MiB、最多2份轮转。logs 只读当前 Owner 有权查看的 Ticket 执行，支持 --execution-id。查询不会初始化库、启动 Runtime 或读取控制 token。日志并发追加可读取；跨越尾部截断边界的不完整首行会被丢弃，防止泄露被切掉凭证前缀的后缀，Truncated 字段标记范围受限。

Runner 当前可靠进程组管理只支持 POSIX。UNKNOWN 执行保留资源，不可删除锁或重启来盲目重跑。用户配置与 Runtime 的工具机制不构成完整 OS 安全沙箱。真实控制器/Claude 验证证据见 reviews/r0c/CLAUDE_CONTROLLER_PILOT.json，完整进度与限制见 R0A_PROGRESS.md。72小时连续运行尚未验收。

## 本地认证 HTTP API

```sh
# 旧数据目录也必须显式 init，增加命令回执模块；查询/serve 不迁移数据库。
node dist/cli/index.js init --data-dir .workforce
# 已有 settings.json 可跳过 configure；不要覆盖已有配置。
node dist/cli/index.js api-init --data-dir .workforce
node dist/cli/index.js api-serve --data-dir .workforce --port 4310
```

`api-init` 在已初始化的私有目录独占创建 api-auth.json（0600），只输出路径与创建时间，重复初始化拒绝覆盖。API 使用该文件中的 Bearer 凭证；不得提交该文件或把 token 放到 URL、日志、Ticket 中。只监听127.0.0.1，所有 API 路由包括 health 都需认证。默认只允许当前端口的 localhost/127.0.0.1 Origin；`--allow-origin http://127.0.0.1:5173` 可显式指定单一本地前端来源。当前未提供跨域 CORS，前端开发应同源代理。

API 前缀 `/api/v1`：GET health/me/overview/employees/projects/tasks/tasks/:id/executions/:id/tasks/:id/logs；POST tasks、tasks/:id/approve|reject|cancel|retry|review。任务列表支持状态、项目、员工和有界游标分页。详细请求契约见 tasks/CURSOR_HTTP_API.md 和实际 JSON schema。

所有写请求需 `Idempotency-Key`；非创建操作还需当前 `expectedVersion`。相同键及请求重放返回原提交结果，键冲突或版本冲突返回409。请求人由服务端 Owner 确定。命令回执与状态变更同一事务提交；API 不启动 Agent 或控制器。验证可通过可信计划异步入队；旧 task-verify 仍提供同步本地检查与显式豁免。API 不接受 passed 字段。SIGINT/SIGTERM 仅关闭 API，保留独立控制器与 Runner。

真实编译后 TCP 验收通过，证据见 reviews/r1/HTTP_API_PILOT.json。首批 Web 的同源启动和真实页面操作见 [Web 操作说明](WEB_OPERATIONS.md)。员工/项目写API与Web治理操作已交付，需显式init增加management-schema1；异步验证接线见下节；SSE已交付；多用户身份和真实钉钉闭环尚未交付。

## 持久异步验证（R1-C）

更新现有数据目录须先显式 init 安装 verification-schema1。API/CLI查询不会安装或修复schema。可信计划从本机私有JSON一次性注册，API和Web只选择id/revision，不接受任意命令、环境变量或passed结果。

计划输入文件格式（先将命令改为实际Node二进制绝对路径；文件权限0600）：

```json
{"plans":[{"id":"artifact-content","revision":"v1","checks":[{"id":"readme","command":"/absolute/path/to/node","args":["-e","require('node:fs').accessSync('README.md')"],"timeoutMs":5000}]}]}
```

```sh
node dist/cli/index.js init --data-dir .workforce
node dist/cli/index.js verification-plans-init --data-dir .workforce --file /absolute/path/to/private-plans.json
node dist/cli/index.js verification-plans --data-dir .workforce
node dist/cli/index.js verification-create TICKET_ID --data-dir .workforce --plan artifact-content --plan-revision v1 --expected-version TASK_VERSION --execution-id EXECUTION_ID --artifact-revision ARTIFACT_SHA256 --reason "检查当前交付产物" --key OWNER_COMMAND_ID
node dist/cli/index.js verification-status VERIFICATION_ID --data-dir .workforce
node dist/cli/index.js verification-cancel VERIFICATION_ID --data-dir .workforce --expected-version JOB_VERSION --reason "停止本次检查" --key CANCEL_COMMAND_ID
```

注册拒绝覆盖已有 verification-plans.json。同一工作区/Owner已使用的id/revision不能换成不同命令；内容变更使用新revision。当前注册器只负责首次创建，后续可信配置更新仍需本机Owner人工维护、保留旧revision并重启API以载入快照，不提供Web任意改命令入口。检查命令是本机Owner信任的代码；不要在命令参数中写凭证。检查进程只继承基础环境，不获得Runtime认证白名单。

持续运行 start --foreground 或单次 run-once 会同时对账和调度执行任务与验证队列；两者共享Controller占用，不能并发调度。验证并发池上限使用settings.scheduler.maxConcurrency，与Agent执行池分别计数。API本身只入队；Controller停止时QUEUED保持等待，已启动的独立验证继续运行。

每个验证固定Task版本、策略版本、执行ID、产物修订及完整计划，复制经过校验的产物后运行。COMPLETED/outcome failed表示检查确实失败；FAILED表示基础设施故障；UNKNOWN表示无法证明原进程及检查组已结束，继续占用且不会自动重跑。取消请求只写意图，需Controller送达并收集退出证据。若启动早期被杀、包装进程被SIGKILL或结果文件缺失，可能保守进入UNKNOWN；不得删除输入目录、清锁或换ID绕过占用。

重启只观察原Runner。只有外层Runner实际终止且签名结果有效才释放验证占用；匹配当前Task/策略/执行/产物时，检查证据、来源审计与应用状态同事务提交，Task保持REVIEW。中途Task或策略已变化则记录superseded，不覆盖较新证据。最后仍需Owner对准确产物显式task-review或Web审核。

验证私有证据位于verification-inputs、verification-runners和verifications；input.json包含控制密钥，不应展示、提交或分享。HMAC证明同用户控制平面的结果来源，不提供对恶意同用户可执行文件的OS隔离。平台仍需Runtime范围加固与长期运行验收。

认证API新增：GET verification-plans；POST tasks/:id/verifications；GET tasks/:id/verifications（limit/beforeRowid）；GET verifications/:id；POST verifications/:id/cancel。写请求需Idempotency-Key与明确版本，返回202及verificationId/replayed；入队成功不表示工作进程已启动。计划与作业查询只公开检查元信息，不公开命令参数或签名密钥。完整实现和异常测试见reviews/r1c与tests/verification-*。

## 持久实时通知（R1-D）

显式init安装change-feed-schema1及事务触发器；已有目录需先init再启动新版API，查询/serve不迁移。GET /api/v1/events复用Bearer、Host/Origin校验，可传单一Last-Event-ID请求头，不接受查询参数或URL凭证。change/reset/ready为失效通知协议，HTTP查询仍是事实来源；ready仅在初始回放完成后发出。客户端应正确处理reset后重新查询，不能依赖无限历史。

Controller对账/tick后最多每60秒保留最近50,000条通知；永久Task审计不变。只有API时通知继续积累。通知范围按当前Owner/Workspace，元信息不含任务正文、日志、命令或凭证。心跳10秒、慢消费者断开、连接数上限8；浏览器回退原轮询。完整契约见tasks/R1_REALTIME_CONTRACT.md，真实TCP/编译CLI/Chromium证据见reviews/r1d。

## Runtime 注册与能力目录（R1-E）

```sh
node dist/cli/index.js runtimes --data-dir .workforce
```

只读列出正式注册的驱动和已配置实例。只需已有私有settings，执行数据库缺失或损坏时仍能诊断。不会生成缺失配置。不执行CLI、不探测登录/版本、不创建或迁移数据。实例显示configured与health: not_checked；不公开command、环境或凭证。认证API为GET /api/v1/runtimes（无查询参数），Web入口为Runtime注册。

当前正式settings仍只有claude-local/claude-code；未提供多实例或第二产品Runtime。适配器由可信应用注册，配置不能动态加载代码。未知驱动在Assignment前拒绝；新Execution持久化驱动名称/协议/能力指纹；未收集历史Execution的驱动或指纹不匹配时保留Assignment并要求恢复原配置，不尝试用新驱动解释旧输出。已结束的历史Assignment不因此阻断查询。

Runner的恢复观察与Agent会话恢复分别处理。Claude当前结构化结果为支持，执行中投递/会话恢复/Agent监控重连/暂停和强文件系统隔离为不支持。范围加固尚待实际OS边界与负向probe验收；详见tasks/RUNTIME_CONTAINMENT_PLAN.md和reviews/r1e。

## 显式OS隔离诊断与Runner required模式（R1-F）

```sh
# 本机Homebrew Node示例：显式批准诊断进程读取其运行库目录。
node dist/cli/index.js containment-probe --read-path /opt/homebrew/Cellar
```

--read-path可重复，必须为明确绝对路径。此例是本机代码/库的只读例外，生产策略应按实际依赖收窄；不会授予写权限或隐式读取HOME。未提供足够运行库、平台不支持或任何负向probe不通过，退出1并返回available:false；退出0仅表示这一次provider/config的无模型probe通过，不是Claude健康检查。

命令不读数据库、业务文档或认证配置，不调用模型；临时文件均自有，网络默认拒绝。不能确认辅助进程清理时保留私有证据，不能靠重新运行绕过UNKNOWN。

底层Runner现支持显式LaunchSpec.containment={version:1,mode:"required",provider:"srt-macos",readOnlyPaths:[...],allowedDomains:[]}。包含此项才产生v2；无此项仍为原v1。required失败不执行目标；通过后每个目标都附有与请求/Runner绑定的私有containment.json证据。该文件使用原控制token认证，不应公开request.json或签名原件。

正式configure/start/run-once的Claude设置尚未开启该分支；Web能力仍如实显示不支持文件系统隔离。真实Claude --version在严格边界内SIGTRAP，未通过兼容性验收。详见tasks/R1_CONTAINMENT_CONTRACT.md及reviews/r1f。不要因Node fixture通过就手动更改产品能力或放开用户目录。
