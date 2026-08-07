# Local search service operations

FLORAL uses a loopback-only SearXNG container and the pinned `mcp-searxng@1.0.3` stdio adapter. The container is a local dependency of the Mac agent; it is not exposed to the LAN.

## Runtime boundary

- Colima provides the Docker daemon on the Mac mini.
- Docker Compose keeps `floral-searxng` configured with `restart: unless-stopped`.
- SearXNG listens only on `127.0.0.1:8888`.
- The Compose file must use the official image pinned by a full `sha256` digest.
- The container health check validates SearXNG's internal `/healthz` endpoint.
- FLORAL separately validates the loopback endpoint and result shape.
- Phase 4.0E5 resolves the unified configuration authority before preparation, verifies the reviewed image digest, and records a bounded `/config` adoption observation.

## One-time Mac setup

```bash
brew services start colima
colima status
```

After the pinned Compose file is present:

```bash
cd /Volumes/WORK_1TB/FLORAL
corepack pnpm searxng:up
corepack pnpm searxng:doctor
corepack pnpm config:searxng-adoption:check
```

Once the container has been created, Docker's restart policy restores it when the Colima Docker daemon starts again. Running `searxng:down` removes the container, so a later `searxng:up` is required.

## Routine diagnostics

```bash
corepack pnpm searxng:status
corepack pnpm searxng:health
corepack pnpm searxng:doctor
```

The doctor command checks Docker, Compose validation, the unified runtime contract, the pinned reviewed image, container state, container health, a real loopback search request, and the bounded `/config` observation. It prints bounded metadata only; it does not print the generated SearXNG secret, raw `/config`, or search-result bodies.

The adoption command re-observes `/config` and verifies that the currently running service still matches the active Phase 4.0E5 report:

```bash
corepack pnpm config:searxng-adoption
corepack pnpm config:searxng-adoption:check
```

If unified preparation or startup fails, `searxng:up` attempts one recovery using the checked-in infrastructure template. Search can remain available in this state, but the adoption report is `rolled-back` and the global config cutover gate is intentionally blocked.

## Restart recovery test

```bash
colima restart
corepack pnpm searxng:doctor
corepack pnpm codex:deepseek:web-search:probe
```

A successful recovery ends with both:

```text
searxng.doctor=ok
probe.result=ok
```

## Image upgrade procedure

Do not change the Compose image back to `latest`. Pull and validate a candidate tag on the Mac, capture its repository digest, then update the committed Compose file through the Windows patch workflow. After sync, run the complete typecheck, test, build, doctor, and web-search probe sequence before accepting the new digest.
