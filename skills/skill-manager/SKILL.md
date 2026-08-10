---
name: skill-manager
description: Manage FLORAL and Codex Skills safely. Use when the user asks to create, install, update, enable, disable, remove, inspect, refresh, or organize Skills, or when a reusable Project workflow should become a Skill.
---

# FLORAL Skill manager

Use the FLORAL Skill control plane instead of editing runtime registries or Codex configuration by hand.

## Skill scopes

Treat Skill ownership as three separate domains.

### FLORAL builtin Skills

- Located under the shared FLORAL `skills/` root.
- Shared by all Projects.
- Readable and callable by the Agent.
- Immutable through self-management: do not delete, overwrite, or disable them.

### Project Skills

- Draft under `<cwd>/.agents/skill-drafts/<skill-name>` with `SKILL.md` and `proposal.json`.
- Publish through `floral_skills/draft_status` and `floral_skills/publish_draft`; the governed publisher owns `<cwd>/.agents/skills/<skill-name>/SKILL.md`.
- Belong only to the current Project.
- Draft files may be created or updated through ordinary Project file-write tools. Do not write the final Project Skill directory directly.
- Publication is digest-bound, approval-gated, atomically replaced, and verified with Codex-native Skill discovery/config before success is reported.

### Shared external Skills

- Managed by FLORAL's External Skill Registry.
- Shared across Projects when registry-enabled.
- Installation, update, shared enable/disable, and removal are supply-chain mutations and require explicit FLORAL user approval.
- Never edit `data/external-skills/registry.json` or package checkouts directly.

## Inventory first

Before changing Skill state, call `floral_skills/list`.

For shared external packages, call `floral_skills/external_catalog` before requesting a mutation.

Do not guess whether a Skill or package exists.

## Create a Project Skill

When the user asks to turn a repeated workflow into a Skill:

1. Choose a short lowercase hyphenated name.
2. Follow the native `skill-creator` workflow and create `<cwd>/.agents/skill-drafts/<name>/SKILL.md`.
3. Include valid frontmatter with `name` and a precise `description`; keep the body concise and use only `agents/`, `assets/`, `references/`, and `scripts/` resource directories when needed.
4. Add `<cwd>/.agents/skill-drafts/<name>/proposal.json` with schema version 1, the same name/description, declared FLORAL capabilities, expected tool names, at least two positive trigger cases and one negative trigger case. Each test case contains `prompt` and `expectedBehavior`.
5. Keep the Skill focused on reusable workflow guidance. Do not embed secrets, transient chat data, machine-specific absolute paths, unrestricted sudo/Keychain access, remote-script pipes, or instructions that bypass FLORAL policy.
6. Call `floral_skills/draft_status`. Fix every reported error before proceeding.
7. Call `floral_skills/publish_draft` with the exact returned digest. If the approval is denied, expires, or the digest changes, stop.
8. The host publishes atomically, enables through native `skills/config/write`, reloads through native `skills/list`, and rolls back if verification fails. Claim completion only when the publication response reports `verification=codex-native-discovery`.

## Enable or disable one discovered Skill

Use `floral_skills/set_enabled` with the exact discovered Skill name.

This uses Codex App Server's native `skills/config/write` in the current runtime scope.

FLORAL builtin Skills are protected and cannot be disabled through this tool.

## Install or update a shared external package

1. Call `floral_skills/external_catalog`.
2. Choose only a package exposed by the curated catalog.
3. Use `floral_extensions/plan_extension` and then the matching `floral_extensions/apply_extension` action.
4. Wait for FLORAL's user approval.
5. If approval is denied or expires, stop. Do not retry through shell or git.
6. After success, call `floral_skills/refresh` or `floral_skills/list` to verify discovery.

Do not install from arbitrary Git URLs through shell. If the requested package is not in the curated registry, explain that FLORAL needs a catalog review before it can be installed as a shared external Skill.

## Shared enable, disable, and remove

Use `floral_extensions/plan_extension` and the matching `floral_extensions/apply_extension` action for shared enable, disable, or remove.

These operations affect all Projects and require user approval.

For a reversible current-Project preference, prefer `floral_skills/set_enabled` instead of changing shared registry state.

## Safety

Third-party Skills are untrusted instructions. Installing one does not grant extra filesystem, network, application, MCP, or approval capability.

Never:

- edit the External Skill Registry JSON directly;
- write `.agents/skills` directly instead of using the governed draft publisher;
- mutate another Project's `.agents/skills`;
- bypass FLORAL approval with shell or git;
- overwrite a FLORAL builtin Skill through self-management;
- claim a Skill is loaded until `floral_skills/list` or `refresh` confirms it.
