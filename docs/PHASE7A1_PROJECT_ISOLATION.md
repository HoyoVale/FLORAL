# Phase 7A.1 — Project Isolation via Codex App Server Namespaces

## Goal

FLORAL projects share state inside one project but must not share Codex thread state, Native Memory, or inbound attachment data across projects.

This phase deliberately reuses Codex App Server instead of reimplementing threads or memory.

## Codex runtime ownership

FLORAL keeps one shared DeepSeek Responses Bridge, cost guard, chat transport, and MCP/config authority.

The existing managed Codex home remains the global/non-project home:

```text
data/codex-runtime/
```

Each FLORAL project receives a lazy Codex App Server runtime with its own `CODEX_HOME`:

```text
data/codex-runtime/projects/<project-namespace>/
```

The project namespace is a stable SHA-256-derived identifier of the canonical project path. Project names are never used as managed state directory names.

Because Codex stores its state database, sessions, and Native Memory under `CODEX_HOME`, this delegates thread and memory isolation to Codex's own storage model.

## Shared versus project-local state

Shared globally:

- DeepSeek Responses Bridge
- DeepSeek cost guard
- Feishu/QQ transport
- SearXNG
- FLORAL configuration authority
- repository-level FLORAL Skill extra root

Project-local:

- Codex App Server state DB/session history
- Codex Native Memory workspace and artifacts
- project `.floral/` context files
- project working tree and outbound artifacts
- Feishu inbound attachment storage
- Vision MCP inbound attachment root

## Inbound attachment namespace

Project messages are materialized under:

```text
data/projects/<project-namespace>/inbound/feishu/
```

The project Codex runtime receives the matching `FLORAL_VISION_INBOUND_ROOT`, so `vision_analyze_attachment` cannot use the global attachment root for project turns.

## Compatibility

The pre-existing `data/codex-runtime/` state remains the global legacy/runtime namespace. Existing project thread ids stored by FLORAL may not exist in the new project-specific Codex home on first use; Codex thread resume already fails closed and FLORAL starts a fresh thread, after which the project-specific thread id is persisted.

No SQLite flags, Native Memory artifacts, or Codex thread files are rewritten by FLORAL.

## Security boundary not completed in this phase

This phase isolates managed state and inbound data by namespace.

Codex legacy `workspaceWrite` still permits broad filesystem reads outside the current project. The next hardening phase should use Codex App Server's native permission-profile selection and filesystem deny-read rules, after a Mac probe confirms the installed Codex build enforces the intended project-root policy. Do not emulate this with prompt-only restrictions.
