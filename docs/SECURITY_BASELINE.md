# Security baseline

This system can control a real computer. Treat every inbound message, model output, webpage, attachment, and tool result as untrusted input.

## Required controls before real mode

- Bind only official QQ OpenID values obtained from verified events.
- Initialize the owner with a local one-time pairing code.
- Reject unknown users and group contexts by default.
- Keep Codex app-server on local stdio; never expose it directly to the internet.
- Keep Peekaboo on local MCP stdio.
- Run the gateway as a normal logged-in macOS user, never root.
- Require chat confirmation for destructive or externally visible operations.
- Require local confirmation for sudo, security settings, account management, Keychain, disk erasure, shutdown, and restart.
- Record user request, thread/turn IDs, command summaries, file changes, approval decisions, and results.
- Provide a local emergency stop command and disable the LaunchAgent before debugging permission loops.

## Remote access boundary

Remote networking is external to FLORAL. Do not publish SSH, Screen Sharing, Codex WebSocket, or MCP ports directly to the public internet. Use a private authenticated network path and restrict access to the dedicated development user.

## Secrets

QQ AppSecret, DeepSeek API key, Better Auth secret, and any future OAuth tokens must never appear in source control, model prompts, audit payloads, or QQ replies.


## Identity and persistence

- Unknown QQ identities fail closed before a model turn is created.
- The owner pairing code must be random, at least 12 characters, and stored only outside Git.
- Pairing attempts are rate-limited and the code is never persisted.
- Duplicate transport message IDs are rejected before authorization and execution.
- Phase 3B accepts only verified C2C events; group and channel events fail closed.
- Passive reply targets are short-lived, bounded, and never reconstructed from guessed identifiers.
- Uncertain QQ delivery failures are not retried automatically, preventing duplicate replies.
- QQ SDK session-resume files remain local and are treated as credential-adjacent state.
- SQLite audit records store bounded event metadata only, never prompts, responses, credentials, reasoning, tool arguments, or tool result bodies.
- `/status` must not reveal OpenIDs, internal IDs, or Codex thread IDs.


## Managed provider runtime

- Real gateway mode generates a fresh random bridge token for each process.
- The bridge binds to loopback and uses an ephemeral port.
- Codex receives the bridge token but not the DeepSeek API key.
- Managed Codex home is mode 0700 and ignored by Git; its per-run configuration is mode 0600 and deleted during clean shutdown.
- Codex thread/session state is retained locally across restarts and must be included in backup/incident-response policy.
- Full-chain acceptance logs only bounded milestones and never user or provider content.

## Phase 5.2 authorization authority

- Every active MCP tool must have an explicit FLORAL capability mapping.
- Role checks, sandbox ceilings, MCP allowlists, capability policy, and approval grants are independent checks; model output cannot override them.
- QQ approvals are owner-only, conversation-bound, one-shot, short-lived, and held only in memory.
- `/stop`, run completion, gateway stop, and service restart invalidate pending approvals.
- Opaque Codex command escalation, granular permission-profile expansion, `system.admin`, and `system.restart` cannot be approved remotely.
- Approval audit payloads never persist raw command bodies, diffs, prompts, tool results, or Codex private request IDs.

## Phase 5.3 controlled capability activation

- Codex app-server turns use `on-request` approvals while the effective sandbox remains `read-only`; approval routing must not be interpreted as a sandbox expansion.
- Only a concrete `codex-file-change` request may bypass the generic read-only denial long enough to request an owner-scoped, conversation-bound, one-shot QQ decision. Generic FLORAL `files.write` stays denied.
- Opaque command execution escalation is never remotely approvable. It requires a separate Mac-local confirmation with its own random public ID and short TTL; the QQ notice omits the command body and detailed request text.
- Local confirmation records live under the private FLORAL runtime directory, use 0700/0600 permissions on POSIX, contain no raw Codex private request ID or secret-bearing command body, and are removed at service-session initialization.
- A local decision must match public ID, service-session ID, and exact request fingerprint. Old-session or forged decision files are ignored.
- Approved Codex requests are answered only with one-shot `accept`; FLORAL does not emit `acceptForSession`, persistent exec-policy amendments, or session-scoped permission-profile grants.
- `item/permissions/requestApproval` remains fail-closed until a later phase implements bounded granular permission subsets.

## Phase 7.1 Codex-native remote execution modes

This section supersedes the conflicting Phase 5.2/5.3 bullets above for Codex-native command, file-change, and structured permission approvals.

- `ask` keeps `workspace-write + untrusted + reviewer=user`; Codex-native approvals are answered by the authenticated owner through FLORAL.
- `auto` keeps `workspace-write + untrusted` and selects Codex `auto_review`; FLORAL does not silently widen the sandbox.
- `full` is unavailable by default. It requires both the paired `owner` role and the Mac-local startup ceiling `FLORAL_REMOTE_MODE_CEILING=full`.
- The ceiling defaults to `auto`, is read by the FLORAL parent process, and is removed from the Codex child-process environment.
- `full` uses Codex `dangerFullAccess` with `untrusted`, not `never`. FLORAL automatically accepts only Codex-native command/file/structured-permission approval requests. Keeping the native approval event preserves the hard GUI-shell bypass rejection before any automatic grant.
- MCP capability authorization and artifact DLP remain separate FLORAL boundaries in every execution mode. `full` does not convert a prompted MCP mutation into an automatic grant.
- Execution-mode selection is in-memory and conversation-scoped; service restart returns every conversation to `ask`.

## Phase 7.2A workspace/project/chat routing

- `FLORAL_WORKSPACE_ROOT` is a Mac-local trust boundary. It is inventoried and classified but is not projected into project-owned `config/floral.toml`, and it is removed from the Codex child-process environment.
- A remotely selectable project must be an existing, real, non-symlink direct child directory of the canonical Workspace Root. Remote project names are never accepted as arbitrary paths.
- Project switching changes the Codex turn `cwd`. A Codex thread ID is persisted only in the state bucket for the project whose cwd created/listed it; FLORAL must never resume one project's thread under another project's cwd.
- `/chats` is backed by Codex `thread/list(cwd=projectPath)`. FLORAL does not copy turns, messages, or rollout content into SQLite; it stores only control-plane selection metadata.
- User-facing chat selection uses a short-lived numbered list. Raw Codex thread IDs are not exposed by `/status`, `/chats`, or `/chat`.
- Changing project or chat clears the conversation artifact catalog to prevent stale cross-project artifact references.
- Terminal-produced outbound files must still be under the selected run's `<project>/artifacts/outbound` staging root. Adding a Workspace Root does not permit arbitrary project files to be registered for chat delivery.

## Phase 7.2B lifecycle mutation boundary

- `/project new <name>` is owner-only and may create only a non-hidden, non-symlink direct child directory under the Mac-local Workspace Root. It cannot import an arbitrary path and therefore does not expand the configured root.
- `/chat archive <index>` is owner-only, requires a fresh cwd-scoped `/chats` list, and forwards only the cached opaque ID to Codex `thread/archive`.
- Both lifecycle mutations are rejected while a run is active and are audited.
- Project import/delete and filesystem deletion remain unsupported in this phase.

## Phase 7.3A project-shared context boundary

- Project-shared context is stored inside the selected real project directory as `AGENTS.md`/`AGENTS.override.md` guidance plus `.floral/CONTEXT.md`, `.floral/DECISIONS.md`, and `.floral/KNOWN_ISSUES.md`.
- `/project new <name>` initializes the context structure before the first Codex thread. `/project context init` is owner-only and is rejected while a run is active.
- Existing context documents are never overwritten by bootstrap. Existing active Codex instruction files are preserved and receive at most one bounded FLORAL managed block; malformed duplicate markers fail closed.
- `AGENTS.override.md` takes precedence over `AGENTS.md` in Codex discovery, so FLORAL links the managed block to the existing override when present instead of writing an ignored AGENTS block.
- Symlink or non-regular instruction/context entries are rejected. `.floral` must be a real project-local directory.
- The shared context files are project guidance, not a permission authority. They cannot raise Workspace Root, remote mode ceiling, sandbox, MCP capability, or artifact egress policy.
- Phase 7.3A performs no automatic chat summarization or memory extraction. Context documents are read-mostly unless the owner/user explicitly asks to update them.

## Phase 7.3B durable project memory boundary

- Project-memory mutation is explicit and owner-only; ordinary user messages are never auto-extracted into durable project files.
- Mutation is rejected while the conversation has an active Agent run, avoiding concurrent model/file updates.
- The target must be an initialized project-local `.floral` regular file with no symlink/hardlink substitution.
- A single normalized memory entry is limited to 1,200 characters, each managed file is capped at 64 KiB, and each file accepts at most 256 FLORAL-managed entries.
- Exact categorized entries are deduplicated by SHA-256-derived marker. Audit records retain the fingerprint and metadata, not the raw durable-memory text.
- Malformed FLORAL memory markers or concurrent file changes fail closed.


## Phase 7.4A Codex-native memory boundary

- Native memories are enabled only through FLORAL's generated unified Codex config; direct editing of files under `CODEX_HOME/memories` is not a supported control path.
- Codex owns extraction, consolidation, storage, and recall. FLORAL may inspect only bounded existence/status metadata for diagnostics and must not treat generated memory files as a second application database.
- `memories.disable_on_external_context=false` is explicit for the first native-memory adoption pass. In Codex semantics, setting it to `true` lets external-context sources mark a thread memory mode as `polluted`; FLORAL does not add a second interpretation of that state.
- Native memory currently has `CODEX_HOME` scope, not FLORAL Project scope. Therefore project `AGENTS.md`, repository documentation, and other project-local sources of truth take precedence over recalled memory when they disagree.
- The existing controlled-cutover fallback is retained. If the installed Codex cannot parse or activate the native memory configuration, FLORAL rolls back to legacy config rather than preventing service startup; diagnostics must surface that memory is not active.
- Memory-generation provider traffic still traverses the FLORAL model bridge and cost guard; enabling memories does not bypass provider accounting or request limits.


## Phase 7.4B native memory diagnostics

- `/memory` and `codex:native-memory:lifecycle` are observation-only surfaces. They expose lifecycle state, file presence, bounded file counts, byte sizes, and latest artifact time; they never return memory text.
- Generated memory artifacts remain upstream-owned implementation state.
- Lifecycle labels are intentionally conservative: `armed` means the feature is active with no observed artifacts; `generated` means raw/rollout evidence exists; `consolidated` means a Codex-generated `MEMORY.md` or `memory_summary.md` exists. None of these labels alone proves cross-thread recall.
- The feature probe may fall back to the official standalone Codex binary under `$HOME/.local/bin` when an interactive shell PATH is incomplete. This does not modify shell profiles or the service PATH.
- `feature_probe=unavailable` is a diagnostic warning rather than an authorization/configuration failure. `feature_probe=disabled` still fails when native memories are configured on.


## Phase 7.4C read-only upstream state inspection

- Deep diagnosis is owner-only over chat (`/memory diagnose`); the local CLI equivalent is `codex:native-memory:diagnose`.
- Candidate Codex runtime databases are limited to regular files named `state_<n>.sqlite` or `memories_<n>.sqlite` directly under the managed `CODEX_HOME`. No arbitrary database path is accepted from chat input.
- Databases are opened with `better-sqlite3` in `readonly + fileMustExist` mode. Only `sqlite_master`, `PRAGMA table_info`, bounded aggregate/count queries, and the `memory_consolidate_global` job metadata are queried. No SQL write, migration, transaction, job reset, retry edit, watermark edit, or VACUUM is performed.
- Raw memory columns are never selected. Raw `jobs.last_error` may be inspected in-process only to classify the failure into a bounded non-secret category; the original error text is never returned to chat/CLI diagnostics.
- Schema drift is fail-soft. Missing or changed upstream tables return `schema-unsupported` rather than causing FLORAL startup failure.
- The diagnostic must never be used as a supported Codex repair API. Upstream-owned state remains upstream-owned.
