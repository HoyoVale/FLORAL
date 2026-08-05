#!/usr/bin/env bash
set -euo pipefail
mkdir -p .codex-schemas
codex app-server generate-ts --out .codex-schemas/types
codex app-server generate-json-schema --out .codex-schemas/json
codex --version > .codex-schemas/codex-version.txt
printf 'Codex protocol schemas generated in .codex-schemas/\n'
