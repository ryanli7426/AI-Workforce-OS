# Phase 3: DingTalk Source

> 迁移背景：本文记录旧 dsh-superagent-prototype 工作区的状态与命令。新项目可用能力以 [B0 交付记录](BOOTSTRAP.md) 为准。

Status: local CLI inspected; adapter boundary added. A concrete Issue document codec and writeback are blocked on the Issue document contract.

## Local CLI evidence

- `dws` is installed at `/Users/cuifengshan/.nvm/versions/node/v22.23.1/bin/dws`.
- Installed version: `v1.0.66`.
- The published CLI Schema advertises `doc +list`, `doc +search`, `doc +fetch`, `doc +update`, and `doc +comment-create`.
- `doc +list` can enumerate direct members of a configured folder with bounded pagination. `doc +search` supports query and bounded pagination. `doc +fetch` reads a document by node or URL.
- `doc +update` and `doc +comment-create` report `confirmation=user_required`. Status writeback cannot be run unattended until the target document and its intended write operation are defined and approved.
- The CLI Schema currently returns `result: null` for these leaves. The installed command surface is known, but this does not establish real Issue fields or response JSON shape.

No business document was read or modified: no Issue folder, node ID, or URL was supplied, and no sample Issue document was available to derive a truthful codec. No live Issue data or status mapping has been fabricated.

## Added boundary

`src/sources/dingtalk/adapter.ts` defines normalized Issue fields and the `DingTalkAdapter` port (`listIssues`, `getIssue`, `updateIssue`, `addComment`, `healthCheck`). CLI transport and document parsing belong behind this interface.

## Information required to finish the concrete adapter

1. The Issue folder node ID/URL or a specific Issue document URL, and whether Issue documents are direct children or found by a stable search query.
2. One representative Issue document (sanitized text or exported Markdown/JSONML) showing where ID, title, description, status, priority, timestamps, and related links are stored.
3. The required writeback convention: status field/location, whether result and failure reason should be appended to the document or added as comments, and desired DingTalk status labels.
4. Confirmation that the local `dws` profile is the intended organization. The implementation will use that same active profile for reads and writes.

Until these are known, only the adapter port is implemented; polling and writeback remain pending.
