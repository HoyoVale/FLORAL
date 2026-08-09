# Phase 7C.1 — Native Skill Self-Management

## Goal

Allow the FLORAL Agent to manage its Skill surface through explicit, audited control planes while continuing to use Codex App Server's native Skill lifecycle.

## Codex primitives reused

- `skills/list`
- `skills/extraRoots/set`
- `skills/config/write`
- `skills/changed` notification
- native project `.agents/skills`
- `skill` turn input items

FLORAL does not implement a second Skill loader.

## Scope model

### FLORAL builtin

The repository `skills/` root is shared by all Projects and protected from Agent self-management.

### Project

Project-local Skills live under:

`<project>/.agents/skills/<name>/SKILL.md`

They are ordinary Project files and remain inside the existing Project filesystem boundary.

### Shared external

External packages remain under the machine-local `data/external-skills` registry. They are validated and exposed to Codex only through `skills/extraRoots/set`.

Supply-chain mutations require one-shot FLORAL approval using the existing owner-only `software.install` capability. The Agent cannot substitute shell/git commands for this approval path.

## Dynamic tool namespace

Threads expose `floral_skills`:

- `list`
- `refresh`
- `set_enabled`
- `external_catalog`
- `manage_external`

`set_enabled` uses native `skills/config/write` and is scoped to the current Codex runtime. FLORAL builtin Skills are immutable.

`manage_external` calls the FLORAL External Skill Manager. On a successful shared mutation, FLORAL recalculates enabled external roots and hot-refreshes active Codex App Server runtimes with native `skills/extraRoots/set`.

## Stable filesystem permission root

Project Codex permission profiles keep the validated active Skill roots read-only and also grant the stable machine-owned `data/external-skills/packages` parent read-only. This allows a newly approved external package to become readable without widening access to sibling Projects or requiring a project runtime restart.

## Refresh behavior

A Codex `skills/changed` notification marks the local catalog dirty. `floral_skills/refresh` also forces `skills/list(forceReload=true)`, so Project Skill creation does not require a service restart.

## Next phase

Phase 7C.2 should expose read-only Codex-native Plugin/App discovery (`plugin/*`, `app/*`) and probe GitHub/Browser availability before enabling any installation surface.

After 7C closure, perform a comprehensive FLORAL Self-Management Audit and then add a system-awareness Skill.
