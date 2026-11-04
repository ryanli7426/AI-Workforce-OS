# 钉钉接入：真实 CLI 契约与待补证据

2026-11-05，本机离线能力检查；没有读取或改写任何钉钉业务文档。

## 已核实

本机存在 `dws`，版本 v1.0.66，构建 f215043e676d6889e1ddce3464828d8b1ec40c31（2026-10-28）。按 dingtalk-doc / dingtalk-shared 的窄 leaf schema 检查下列命令，没有使用假定的 `issue list/update` API：

| 能力 | 真实命令/参数 | 确认语义 |
| --- | --- | --- |
| 正文读取 | `doc +fetch --node ID_OR_URL --scope full --detail with-ids` | not_required；node/query二选一 |
| 文档信息 | `doc +inspect --node ID_OR_URL` | not_required |
| 容器列表 | `doc +list --folder ID_OR_URL --page-all` | not_required；有界 max-pages/max-items |
| 内容修改 | `doc +update --node ID_OR_URL --command ACTION` | user_required；动作与正文格式受实际参数约束 |
| 结果评论 | `doc +comment-create --node ID_OR_URL --content TEXT` | user_required |

全局 `--format json`、`--profile`、`--timeout` 来自实际 Help。修改的 `--expected-revision` **只适用于 overwrite+jsonml 的服务端条件写**，不能将普通 Markdown str_replace 描述为原子比较更新。正文修改与评论各自的确认要求需要在具体业务授权后满足，不能通过静默添加危险参数绕过。

上述 leaf 当前都没有发布 `result.data_schema`、outcomes 或 pagination 字段契约（投影为 null）。因此仅凭 schema 不能编造业务返回解析器，也不能通过 Help 示例假设真实结果字段。需要目标明确后的真实只读回执，再记录经脱敏的结构契约与回归 fixture。

## 尚缺什么

待用户先前问题的答案：实际 Issue **文档/文件夹 URL 或 node ID**，以及同一文档如何表示一条 Issue（每个文档一条、Markdown 区块、多维表或其他结构）。还需从实际内容确认 Issue ID、标题、状态、优先级、更新时间、关闭语义及回写位置。node ID 不能未经证据就当作 Issue ID；文件夹扫描不完整时不能假设扫描完成。

这些信息阻塞真实 Issue → Task 和远端回写验收，不阻塞本地调度、API/Web、治理及多 Runtime 工作。当前 LocalTaskService 只接受手工 Owner 来源，不能把 DWS 文本伪装成人工审批；后续来源身份和审批必须由独立接入边界校验。

## 后续接线约束

1. DWS 命令只封装在来源适配层。固定 argv、shellfalse、限时/限量、脱敏和退出结果分类；不把 Token 写配置或 Task。
2. 真实读取与写回使用同一明确 profile，零目标/多目标或组织不明确时停止该来源。
3. 幂等键为明确 source + 真实 Issue ID，accepted input 与后续 observed revision 分离。
4. 回写通过持久意图执行；超时/commit-unknown 先回读对账，禁止自动重发追加或评论。
5. 写后核对真实回读/发布回执，保留部分完成、分页和失败项，不凭进程退出码宣称远端成功。

本记录只证明 CLI 能力与缺口，不证明钉钉集成已经可用。
