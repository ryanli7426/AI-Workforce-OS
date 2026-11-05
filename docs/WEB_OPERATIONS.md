# 本地 Web 工作空间

这是 R1 第一批可操作页面。页面读取真实 SQLite 数据，经认证 API 执行命令；没有演示数据回退或由浏览器直接改变 Task 状态。

## 启动

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm web:build
node dist/cli/index.js init --data-dir .workforce
```

新数据目录还需按 LOCAL_OPERATIONS.md 配置 settings、项目和员工。已有目录显式 init 增加所需 schema，已有 settings 不覆盖。首次创建 API 凭证：

```sh
node dist/cli/index.js api-init --data-dir .workforce
```

已有 api-auth.json 时跳过 api-init。该命令拒绝覆盖凭证，只输出文件路径。随后：

```sh
node dist/cli/index.js api-serve --data-dir .workforce --port 4310 --web-root "$PWD/web/dist"
```

浏览器打开 http://127.0.0.1:4310。在本机编辑器打开私有数据目录的 api-auth.json，将 token 填入密码输入框。token 仅用于当前页面内存中的 Bearer 请求，不进入 URL、浏览器持久存储或 Cookie。刷新页面、断开连接后重新认证。当前只支持配置中的单一 Owner；不能把此认证机制视为多人权限系统。

服务只监听127.0.0.1。HTML 与明确选定的构建资源可公开读取；每个业务 API（包括 health）仍需认证。未知文件路径不能读取数据目录。生产资源是启动时的有界快照，更新前端后需要重启 API；SIGINT/SIGTERM 关闭 API，独立控制器与 Runner 的生命周期不受其管理。`--port 0` 可申请临时端口，地址以启动 JSON 为准；Web 来源许可根据真实监听端口建立。

## 当前页面与操作

| 页面 | 可操作行为 | 当前边界 |
| --- | --- | --- |
| 概览 | 真实计数、需要关注的任务、刷新与跳转 | 不提供成本或 Runtime 健康推断 |
| 任务列表 | 状态/项目/员工筛选、游标分页、创建任务 | 暂无编辑、重新指派、子任务与看板 |
| 任务详情 | 审批、拒绝、取消请求、允许时重试、当前产物验收、历史与日志 | 独立验证仍由 task-verify CLI 完成 |
| 审批与验收 | 待执行审批及待验收 Task 的真实筛选入口 | 不等同所有操作类型的完整 Approval 中心 |
| AI 员工 | 创建、编辑、明确启停、项目绑定、配置历史及关联任务 | 新建默认停用；敏感配置先停用；当前创建选项为默认 claude-local |
| 项目 | 创建、编辑业务配置、归档、审计及关联任务 | 仓库/工作树路径建立后不可编辑；完整成员/知识/工作流待实现 |
| 执行中心与详情 | 真实列表/筛选/分页、时间、退出结果、关联 Task 与作用域日志 | 不提供 Runtime 未支持的投递、暂停、恢复 |

重要命令填写理由后先预览，再明确确认。请求包含版本和幂等键；网络结果不确定时，相同意图重试复用原键，版本冲突后刷新事实并重新确认。UNKNOWN/活动执行仍占用资源时，界面不提供重试入口。后端仍对所有操作作最终校验。

批准执行将任务入队。实际执行需要另一个终端显式运行 `start --foreground`；Web/API 不自动启动调度器。取消活动任务记录停止意图，执行侧确认退出后才释放资源。审核通过要求当前执行与不可变产物匹配，并且独立验证已通过或被明确豁免；进程成功不能直接使 Task 成为 DONE。

深色/浅色主题、移动端布局、键盘标签和导航焦点已纳入首批实现。这里只是产品 UX 的部分覆盖，19个产品模块的完整验收仍见 DELIVERY_TRACKER.md。

## 前端开发

终端一：

```sh
node dist/cli/index.js api-serve --data-dir .workforce --port 4310 --allow-origin http://127.0.0.1:5173
```

终端二：

```sh
pnpm web:dev
```

只使用 http://127.0.0.1:5173。Vite 将固定 `/api` 路径代理到本地4310端口；显式的 --allow-origin 必不可少，不使用跨域通配 CORS。开发 API 不需要 --web-root。生产推荐同源 API + Web，避免开发代理成为运行依赖。

## 检查与浏览器验收

首次安装浏览器测试环境：

```sh
pnpm exec playwright install chromium
pnpm check
```

完整门禁包含后端/前端类型检查、单元与进程集成测试、Core无node_modules smoke、依赖扫描、Web构建和真实Chromium E2E。测试只创建自有临时 Git 项目与SQLite数据；不会调用模型、操作真实钉钉或接受真实交付物。trace/video 默认关闭，测试输出目录被Git忽略。

`pnpm web:typecheck`、`pnpm web:test`、`pnpm web:build` 和 `pnpm web:e2e` 可分别执行；E2E要求 dist 与 web/dist 已构建。真实 Claude 历史交付的 Web 只读验收另记于 reviews/r1/WEB_CLAUDE_READONLY_PILOT.json，保留 REVIEW，不替人完成验收。

## 配置治理补充（R1-B）

更新后须对现有数据目录显式运行 init，增加 management-schema1；api-serve 的只读预检不会替你升级。员工/项目变更都需理由、幂等键，编辑/启停/归档还需确认的资源版本；UI 会预览实际字段和值。历史包含操作人、理由和前后版本，重复请求不增加记录。

员工编辑期间的轮询不覆盖草稿或悄悄升级版本。版本冲突刷新后需重新确认。已归档项目的原绑定继续可见；可以只修改资料并保留历史绑定，也可明确移除。新增项目绑定限同工作区未归档项目，启用员工也重新检查接单条件。创建员工不自动启用，启用不会启动进程；停用不等同终止旧执行。

项目归档保留历史，只阻止未来接入。仓库路径创建时验证真实Git根，工作树根与仓库分离；此预检在事务外完成。业务负责人字段不改变Workspace的访问权限。当前Web员工创建只提供默认claude-local，其他已配置实例可用CLI，统一Runtime注册与选择器后续交付。

执行中心现在可按实际执行状态、项目、员工和关联任务筛选并分页；权限过滤先于分页。列表中的进程结果不改变任务的验证或验收状态。管理完整浏览器验收见 reviews/r1b/MANAGEMENT_ACCEPTANCE.md。
