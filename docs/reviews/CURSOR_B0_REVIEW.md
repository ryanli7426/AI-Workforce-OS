# Cursor B0 范围审查

工具：本机 Cursor Agent，ask 只读模式；模型使用该客户端既有配置，本次未强制指定。以下是对临时工程初稿的审查，最终修改记录见 BOOTSTRAP。

I'll review the product and architecture docs you listed and assess B0 against the vision—without touching CLI or tests.Checking how B0 maps to the R0/W packages and whether acceptance criteria appear elsewhere.## Verdict

**B0 is a sound first delivery** if framed as a *control-plane bootstrap* (independent package, migrated Core/SQLite, non-daemon CLI, honest non-claims)—not as product MVP. That matches Architecture’s risk control (reliability before surface area) and `AGENTS.md`’s “independent local control-plane foundation.” It does **not** yet satisfy Master PRD §9 Experience or Architecture R0 closed-loop acceptance.

## Findings (≤5)

1. **Milestone taxonomy is unmapped** — `docs/BOOTSTRAP.md` defines **B0**; `docs/AI_WORKFORCE_OS_ARCHITECTURE.md` §20 / Appendix C use **R0-A…C** and **W01–W10**, with R0-A precondition “已有独立 Core” but no B0↔R0/W link. Appendix C **W08** completion (“创建、启动、查看、取消、重试、验收和停止”) conflicts with B0’s query-only, non-daemon CLI (`docs/BOOTSTRAP.md` L7–L12).

2. **B0 acceptance criteria are still a placeholder** — `docs/BOOTSTRAP.md` L26–L28 says this file is the acceptance source of truth, then only “待实施后更新…”. Concrete gates already exist in `AGENTS.md` L10 and `package.json` `check`, but B0 never pins pass/fail for: `pnpm check`, migration provenance/`docs/MIGRATION_MANIFEST.json`, Core↔storage dependency boundary, or “queries must not init/migrate” (stated in `AGENTS.md` L8 / `README.md` L19, not as B0 AC).

3. **CLI product contract drifts across docs** — Architecture §14.1 (`docs/AI_WORKFORCE_OS_ARCHITECTURE.md` L483) keeps **`lao`** `init/doctor/start/stop/status/tickets/retry/logs` (+ approve/reject/cancel/create). `package.json` L12–L14 ships bin **`workforce`**; `README.md` L12–L16 and B0 only document help/init/doctor/status/tickets. Brand and command surface disagree without an acceptance note that B0 intentionally subsets W08.

4. **“Next stage” skips the Architecture reliability gate** — `docs/BOOTSTRAP.md` L14–L20 jumps from Runner/Claude → DingTalk → “员工/项目配置与独立 API，逐步构建 Web”. Architecture §20 makes **R0-A** (Runner/Execution matrix) and **R0-C** (approval, recovery, doctor as ops, DSH cleanup) mandatory before **R1** Web (`docs/AI_WORKFORCE_OS_ARCHITECTURE.md` L598–L601). B0’s roadmap understates that gate.

5. **Vision vs B0 honesty is fine in README, weak in PRD tracking** — Master PRD §9 (`docs/product/MASTER_PRD.md` L258–L285) requires Workforce/Task/IM/Runtime/Governance and Web+IM+CLI closed loop. Architecture Appendix A maps those to R0–R3; B0 correctly excludes Executor/IM/Web (`docs/BOOTSTRAP.md` L12; `README.md` L3), but there is no explicit “B0 out-of-scope / deferred AC” crosswalk, so PRD “完成标准” can be misread as B0 exit criteria.

## Proposed next milestone

**R0-A (W01→W04):** Execution repository + independent Runner (start identity, idempotent launch, event sequence) + Claude adapter failure/timeout/stop/artifact tests, then a controlled real smoke—**before** DingTalk closed loop (R0-B) or Web. Treat current B0 CLI as a thin adapter over Core; expand toward Architecture W08 only after Runner evidence exists.
