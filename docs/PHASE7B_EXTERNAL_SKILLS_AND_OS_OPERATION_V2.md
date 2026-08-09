# Phase 7B — External Skill Registry + macOS Operation Skill v2

## External Skill Registry

FLORAL keeps repository-owned Skills under `skills/` and machine-local third-party Skill packages under `data/external-skills/`. Third-party packages are not copied into the FLORAL source tree.

The first curated package is `superpowers` from `https://github.com/obra/superpowers.git`. The manager supports list, doctor, install, update, enable, disable, and remove. Only curated package IDs are accepted; arbitrary git URLs are not accepted by this phase.

At service startup FLORAL validates enabled external Skill roots, rejects symlinks and Skill-name collisions, and passes the resulting roots together with `FLORAL/skills` to Codex App Server through the existing native `skills/extraRoots/set` path. Project Codex permission profiles receive those enabled roots as read-only filesystem roots so supporting Skill files remain readable without widening sibling Project access.

An external registry change requires a FLORAL service restart so every global/project Codex App Server receives the same root set.

## macOS Operation Skill v2

The macOS operation policy is now terminal/native-CLI first. Deterministic application operations such as launching an app or opening a file should use macOS `open` or a documented installed application CLI before considering GUI interaction.

Peekaboo and Vision become observation, verification, and GUI-only fallback layers. Shell remains forbidden as synthetic GUI automation: AppleScript/System Events, `cliclick`, direct Peekaboo mutation, coordinate automation, and ad-hoc accessibility click scripts remain blocked. When GUI fallback is necessary, the safe state machine remains `see → one click → see`.
