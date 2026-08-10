# Phase 9 — Autonomous Extension Governance

Status: implementation and Windows validation complete; macOS and Feishu acceptance remain release gates.

Phase 9 lets the Agent discover and manage capabilities without turning the language model into an authorization boundary. FLORAL owns policy, exact-scope approvals, transactions, receipts, and rollback. Codex App Server remains the source of truth for native Skills, Apps, MCP visibility, threads, turns, and sandbox execution.

## Delivery sequence

| Phase | Result | Primary evidence |
| --- | --- | --- |
| 9A | Fine-grained capabilities and exact approval scopes for Skill, MCP, App, GitHub, browser, and GUI operations | policy/authority tests; MCP tool allowlists; scope-bound approval tests |
| 9B | Pinned external supply chain with immutable refs, integrity checks, and a local MCP package cache | curated registries; cache reconciliation; tamper/version tests |
| 9C | Durable extension transactions with expiry, supersede, cancellation, verification, and rollback history | extension control ledger v2 and lifecycle tests |
| 9D | Governed Project Skill draft, validation, exact-digest approval, atomic publication, Codex-native discovery/config, and rollback | `floral_skills` authoring tools and Project Skill tests |
| 9E | Codex-native App discovery/config and supported Plugin user handoff | `app/installed`, `app/list`, `app/read`, `config/value/write`; no production plugin lifecycle RPC |
| 9F | Structural budgets, fault injection, runtime-data Git isolation, documentation, and cross-platform acceptance | `reliability:check`, full test/build gates, Mac smoke, Feishu scenarios |

## Authorization model

Every mutation follows this chain:

```text
model intent
  -> deterministic tool argument validation
  -> current frozen discovery snapshot / controlled plan
  -> FLORAL capability and machine ceiling
  -> exact target/action/digest approval scope
  -> native or curated executor
  -> immediate acceptance check
  -> durable transaction receipt
  -> fresh-turn verification
  -> verified or rolled back
```

An approval for one target never authorizes another target. Project Skill publication additionally binds the project identity, Skill name, create/update action, exact tree digest, and declared permissions. App configuration binds the Codex App ID and enable/disable action. External MCP and Skill operations bind their curated registry IDs and actions.

Session-wide grants are not used for extension mutations. FLORAL never accepts model text, App display metadata, or MCP-reported tool names as proof of authorization.

## Ownership boundary

| Surface | Codex / upstream owns | FLORAL owns |
| --- | --- | --- |
| Project Skills | discovery and enabled state through native Skill APIs | draft boundary, static validation, approval, atomic publish, receipts, rollback |
| External Skills | loading from configured roots | curated source/ref/integrity, install/update/remove transaction |
| Apps | directory, installed state, details/tools, native enabled config | frozen-plan gate, exact approval, permission review summary, transaction and rollback |
| Plugins | Plugin Directory and Codex `/plugins` lifecycle | safe handoff and post-action verification guidance |
| External MCP | Codex MCP runtime exposure | curated package/version/integrity, local cache, tool allowlist, mutation transaction |

Production code does not call the App Server `plugin/list`, `plugin/read`, `plugin/install`, or `plugin/uninstall` methods while those methods are documented as under development. App installation, authentication, OAuth scope consent, and Plugin lifecycle remain user-mediated on supported Codex/ChatGPT surfaces. A new session is required before final verification where upstream lifecycle semantics require it.

## Project Skill publication contract

Drafts live under `.agents/skill-drafts/<name>` and are ignored by Git. A valid draft contains a bounded Codex `SKILL.md` plus `proposal.json` with declared permissions and positive/negative trigger cases. Validation rejects symlinks, path escape, oversized trees, name collisions, direct registry mutation, approval bypass instructions, and unsupported capabilities.

Publication requires `skill.publish` approval for the exact SHA-256 digest. The digest is recomputed after approval and again before the atomic rename. Only runtime Skill files are published to `.agents/skills/<name>`; `proposal.json` is excluded. Codex native discovery and enabled state must then succeed. Failure restores the prior Skill and records a rollback receipt under runtime data.

## Failure and rollback matrix

| Failure | Required behavior |
| --- | --- |
| Draft changes after validation or approval | deny publication; no target mutation |
| Native Skill discovery/config rejects publication | restore previous target or remove new target; record rollback |
| External package ref/integrity mismatch | reject before activation; preserve current registry/cache |
| Extension transaction expires or is superseded | reject stale completion; keep auditable history |
| Native App config write fails | restore previous enabled value; no success receipt |
| Native App readback disagrees | restore previous enabled value; no success receipt |
| Fresh-turn extension verification fails | record failed/rolled-back transaction and surface remediation |
| Plugin lifecycle requested | return supported user-surface handoff; do not invoke experimental production RPC |

## Runtime data and repository boundary

The following are runtime or authoring state and must not enter Git:

- `data/extension-control/`
- `data/external-extensions/`
- `data/external-skills/`
- `data/skill-authoring/`
- `.agents/skill-drafts/`
- transient Skill staging and backup directories
- `artifacts/`, `logs/`, and generated Codex schemas

Published Project Skills under `.agents/skills/` are project source and may be reviewed and committed deliberately.

## Release gates

Windows source validation:

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm reliability:check
corepack pnpm build
corepack pnpm bootstrap:validate
corepack pnpm config:inventory:check
git diff --check
```

After the project owner commits and pushes, macOS validation must use `git pull --ff-only`, run the same typecheck/test/build/reliability gates, then run `corepack pnpm mac:smoke` and inspect service status/logs without exposing App Server or Peekaboo to the network.

Feishu acceptance covers read-only discovery, denied mutation, approved one-shot mutation, rollback evidence, fresh-turn verification, Project Skill authoring/publication, App permission review, Plugin handoff, external MCP supply-chain status, and runtime restart recovery.

## Upstream references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Skills and Plugins](https://learn.chatgpt.com/docs/skills-and-plugins)
- [Build Plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Codex Plugins](https://learn.chatgpt.com/docs/plugins)
- [Apps and connector controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
- [Codex permission modes](https://learn.chatgpt.com/docs/permission-modes)
