# DeepSeek provider notes

DeepSeek remains a planned model-provider option, but FLORAL does not enable or assume direct Codex compatibility in Phase 1.

The current Codex App Server expects its configured provider path to satisfy the protocol required by that Codex release. Keep `CODEX_MODEL` blank until the Mac's Codex configuration has been validated with the intended provider. Do not copy a stale model catalog or hard-code an unverified model id into the repository.

`src/agent/model-bridge.ts` reserves a future Responses API ↔ provider protocol boundary. It is intentionally interface-only in this phase.

Keep API keys in the target user's protected Codex configuration or a secret store. Do not commit them to this repository or inject them into QQ messages or logs.
