# Codex Responses compatibility fixtures

Phase 2B.2-B2.1 protects the FLORAL Responses bridge against silent Codex App Server protocol drift. The compatibility layer records only a sanitized structural view of real `/v1/responses` requests, fingerprints that structure, and replays committed fixtures through the current translator.

## Security boundary

Compatibility capture is disabled during normal bridge operation. It is enabled only by the explicit Mac probe command below.

The sanitizer preserves protocol information needed for compatibility checks:

- object keys and array shape;
- item, role, tool, namespace, and child-function names;
- JSON Schema property names and `required` entries;
- booleans and numeric values;
- stable relationships between request identifiers.

It replaces or normalizes:

- instructions, user text, tool output, descriptions, paths, URLs, and arbitrary strings;
- model names;
- tool argument values;
- call, item, response, and message identifiers;
- keys that look like tokens, API keys, secrets, passwords, cookies, sessions, or credentials.

The bridge callback receives only the sanitized request and its structural SHA-256 fingerprint. Raw request bodies are not written by the compatibility recorder.

## Committed fixtures

Committed fixtures live under:

```text
tests/fixtures/codex-responses/
```

Each fixture contains:

- `schemaVersion` — compatibility fixture format version;
- `name` — stable scenario name;
- `fingerprint` — SHA-256 of canonical sanitized request JSON;
- `request` — sanitized Codex Responses request;
- optional replay context such as cached reasoning by call ID;
- `expect` — protocol summary expected after translation to DeepSeek.

The initial fixtures cover:

- message input with a Codex namespace tool;
- namespace function call plus function output and reasoning restoration;
- custom tool translation with unknown forward-compatible fields.

## Windows and CI check

```powershell
corepack pnpm codex:compat:check
```

Successful output ends with:

```text
codex.compat.fixtures=3
codex.compat.result=ok
```

The ordinary test suite also replays every committed fixture.

## Capture a real Mac request sequence

Run the already validated search chain in explicit capture mode:

```bash
corepack pnpm codex:compat:capture
```

This performs the real Codex → Bridge → DeepSeek → MCP → SearXNG probe and writes only sanitized requests to:

```text
artifacts/codex-compat/latest-capture.json
```

`artifacts/` is ignored by Git. The artifact includes the Codex version, platform, architecture, request count, sanitized requests, and structural fingerprints. It does not include the DeepSeek key, bridge token, user prompt, search query, search-result body, local path, or reasoning text.

Validate the generated artifact:

```bash
corepack pnpm codex:compat:check -- --capture artifacts/codex-compat/latest-capture.json
```

Expected additional output:

```text
codex.compat.capture.requests=2
codex.compat.result=ok
```

The request count may be greater than two if a future Codex version adds an extra provider turn. A count below two fails capture because the search probe should include the initial tool request and the tool-result continuation.

## Updating fixtures after a Codex upgrade

1. Run the full existing tests and real search probe before changing fixtures.
2. Run `codex:compat:capture` on the Mac.
3. Validate the artifact with `codex:compat:check -- --capture ...`.
4. Compare fingerprints and sanitized shapes with committed fixtures.
5. Treat added fields as forward-compatible only when existing semantics are unchanged.
6. Change translator behavior only when a real protocol shape requires it.
7. Promote a reviewed sanitized request into a committed fixture with an explicit expectation.
8. Re-run typecheck, tests, build, compatibility check, and the real web-search probe.

Never commit a raw network capture or an unsanitized provider request.
