# freellmapi (mirror)

This directory does **not** vendor source. The `Dockerfile` re-publishes the
upstream FreeLLMAPI image to our ECR repo `freellmapi` so it passes ECR scanning
and lifecycle policy.

- Upstream: https://github.com/tashfeenahmed/freellmapi
- Runtime facts (do not diverge in the infra): port **3001**, `USER node` (UID 1000),
  DB at `/app/server/data` via `FREEAPI_DB_PATH`, health `GET /api/ping`.
- Requires env `FREEAPI_DB_PATH`, `PORT`, and secrets `FREEAPI_MASTER_KEY`,
  `ENCRYPTION_KEY` (injected by the ECS task definition).

Pin the `FROM` to a `@sha256` digest before the first production push.
