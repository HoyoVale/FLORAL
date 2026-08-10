# Phase 8G Completion Audit

This audit maps every `plan.log` workstream to direct implementation and verification evidence. Windows implementation may be published only when all repository gates below pass. Mac and Feishu remain separate real-machine acceptance gates after the owner push.

| Workstream | Implemented contract | Direct evidence |
|---|---|---|
| 8G.0A GitHub Owner MCP | `github-readonly` remains read-only; `github-owner` is owner-only and excludes repository/ref publication and account/organization administration required to remain owner-operated by `AGENTS.md` | `external-mcp-registry.ts`, `authorization-authority.ts`, their tests |
| 8G.0B Context self-management | Governed status/read/propose/apply/verify/history/compact/refresh-agents surface; proposal approval; managed-block preservation; provenance, freshness, stale/reactivation reconciliation | `floral-context-tools.ts`, `project-context.ts`, `project-context-ledger.ts`, context tests |
| 8G.1 unified journal | SQLite transaction/event lifecycle, bounded payloads, idempotency keys, attempts, retry time, leases, diagnostics; maintenance/extension/context domain ledgers mirror into the unified journal | `durable-state.ts`, `durable-journal.ts`, `durable-domain-journal.test.ts` |
| 8G.2 durable delivery | Persist-before-send outbox, ACK receipt, bounded retry, stable Feishu UUID, restart recovery, terminal ambiguity quarantine for transports/media without an idempotent contract | outbox store/coordinator, Feishu transport, delivery tests |
| 8G.3 run queue and attachment spool | Inbound receipt follows attachment materialization and durable queue commit; FIFO queue survives restart; remote-only references are rejected; missing/changed files are safely rejected before Codex starts | run queue/coordinator, attachment spool, gateway durable-run tests |
| 8G.4 recovery coordinator | Startup recovery is journalled; expired delivery leases recover; unstarted queued runs resume; interrupted executing turns are quarantined and durably reported rather than blindly replayed | startup coordinator and recovery tests |
| 8G.5 idempotency | Inbound transport/bot/message key, delivery key, stable Feishu chunk UUID, domain transaction IDs, no whole-turn retry after output or ambiguous mutation | durable stores, retry policy, bridge/outbox tests |
| 8G.6 decomposition | Reliability scheduling, delivery, attachment, startup recovery, artifact egress, approval, Context, Extension, System and presentation policies live behind dedicated boundaries; frozen size budgets prevent monolith regrowth | coordinators/controllers and `reliability-architecture.test.ts` |
| 8G.7 fault matrix | Network/429/500/stream faults, Codex exit, Feishu timeout/worker failure, duplicate input, receipt interruption, SQLite busy/corrupt/unavailable/full, attachment disappearance, MCP prerequisite, maintenance interruption, extension pending verification | named fault tests included by `pnpm reliability:check` |
| 8G.8 operator UX | Compact `/status` exposes Agent, transport, queue, delivery, recovery and Self-Heal state; `--debug` retains deterministic evidence; compact `/diagnose` never repairs and `--debug` exposes full evidence | gateway status/diagnostics and command tests |
| 8G.8 soak closure | 160 runs plus 160 deliveries drain, reopen and prove no loss, duplicate, recoverable residue or executing lease | `reliability-soak.test.ts` |
| Git pollution boundary | Runtime databases, artifacts, logs and schemas are untracked and tested as a publication invariant | `.gitignore`, `runtime-data-git-boundary.test.ts` |

## Fault decisions

- Safe queued work resumes automatically.
- An executing Agent turn can already have mutated an external system, so crash recovery quarantines it and asks the owner to inspect/retry.
- Text delivery is replayed only when the transport provides a stable idempotency contract.
- Ambiguous non-idempotent text and media delivery are terminal and require owner action.
- Required journal failures prevent durable acknowledgement; telemetry failures do not grant or alter authority.
- Maintenance handoff/running state older than its bounded worker verification window becomes failed and releases the control plane.

## Publication gates

Windows:

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm reliability:check`
4. `pnpm build`
5. `pnpm bootstrap:validate`
6. `pnpm config:inventory:check`
7. `git diff --check`
8. zero Git-tracked runtime-data paths

After owner commit/push, Mac repeats typecheck, full tests, reliability, build, service restart/status and clean-worktree checks. Feishu then validates status/diagnostics, FIFO, attachment input/output, cancellation, owner-only control plane and Context management through the real transport.
