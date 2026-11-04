# Product Context: AI Workforce OS and LAO

> 迁移背景：本文记录旧 dsh-superagent-prototype 工作区的状态与命令。新项目可用能力以 [B0 交付记录](BOOTSTRAP.md) 为准。

Source baseline: `AI_Workforce_OS_Product_Documents/MASTER_PRD.md` and `PRODUCT_UX_SPEC.md` supplied by the product owner (version 1.0).

Detailed architecture proposal: [AI Workforce OS 架构设计与实施蓝图](AI_WORKFORCE_OS_ARCHITECTURE.md).

## Product north star

The intended product is **AI Workforce OS**: a human-governed platform for organizing AI employees into teams, receiving work from IM and other sources, assigning work to suitable agents, coordinating execution, controlling permissions, and recording delivery and performance.

It is Agent First, IM Native, Runtime Agnostic, Model Agnostic, Organization First, and Persistent/Observable. It is not a model, a new general-purpose agent runtime, or a UI wrapper for one coding CLI.

## LAO's role

**Local Agent Orchestrator (LAO) is the first local execution and orchestration foundation of AI Workforce OS.** The initial release deliberately proves a narrow vertical slice:

`DingTalk Issue → normalized Task/Ticket → policy and assignment → local Agent Runtime → evidence and human review → DingTalk update`

The first source is DingTalk documents; the first runtime is local Claude Code CLI; SQLite is the local system of record; a CLI is sufficient for initial operations. This MVP should validate durable work intake, assignment, execution evidence, recovery boundaries, human governance, and external result delivery.

The narrow first slice does not redefine the eventual product as a single-Issue automation tool. It gives the broader platform a reusable task, execution, event, policy, and audit kernel.

## Product concepts to preserve in architecture

- **AI Employee:** identity, role, responsibilities, capabilities, skills, runtime binding, workspace, permissions, concurrency, and work history. In the first slice this can be represented by one configured local agent, while `agent_id` and runtime remain separate concepts.
- **Task:** source-independent work with project, priority, owner, executing agent, dependencies, deadline, multiple attempts, execution history, and deliverables. A DingTalk Issue is one source representation of a Task.
- **Organization and teams:** own agents, responsibilities, projects, scopes, and collaboration relationships. The first local deployment can have one owner and one agent without encoding that as a permanent domain limit.
- **Collaboration:** supports decomposition, dependencies, handoffs, parallel work, review, and result aggregation in later stages. The first slice remains one assignment at a time.
- **Communication:** IM is a first-class product surface. DingTalk document polling is only the first intake path; future message, conversation, approval, and delivery channels should fit the same source/adapter boundary.
- **Runtime and Model:** Runtime executes an Agent; model choice belongs to the Runtime or Agent configuration. Neither should become the Core's identity or dependency.
- **Governance:** a person owns final decisions. Runtime output is evidence, not authority to complete a task, grant permission, or mark review/CI successful.
- **Knowledge and performance:** execution history, decisions, artifacts, quality and cost data should remain traceable so future knowledge and analytics do not require scraping logs.

## Delivery boundary

The current LAO phases are an infrastructure-first sequence, not a complete AI Workforce OS roadmap:

1. Keep the source repository's reusable domain kernel and establish the independent Core/storage boundary.
2. Add the first Agent Runtime adapter and isolated execution evidence.
3. Add DingTalk as the first real task source and result destination, based on the actual Issue document contract.
4. Run the durable local orchestrator with polling, queueing, recovery, retries and graceful shutdown.
5. Complete approval, audit, process and security controls.
6. Keep multi-agent routing, IM conversations, teams, projects, workflow graphs, web management, CI, knowledge and analytics as explicit extension points and later product work.

Do not pull the full Workforce, Organization, Collaboration, Communication, Governance, Knowledge, Performance or Web UX scope into the first executor milestone. Do not make the first milestone's single agent, one source, one machine or CLI-only interface permanent assumptions in Core contracts.

## Current planning consequence

The current DingTalk CLI supports document list/search/fetch/update/comment operations, but the product baseline does not specify the actual Issue document schema or where its status and execution result should be written. The PRD establishes the business flow, not those field-level integration facts. Keep the `DingTalkAdapter` boundary and derive the concrete codec from a real sanitized Issue document and its expected writeback convention.

Claude Code remains the first Runtime implementation, not the product itself. Its live protocol and model execution still require a controlled smoke run before claiming real runtime acceptance.
