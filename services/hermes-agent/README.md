# hermes-agent (mirror)

Re-publishes the upstream Hermes-Agent image to our ECR repo `hermes-agent`.

- Upstream: https://github.com/NousResearch/hermes-agent
- Runtime facts: `USER hermes` (UID **10000**, remap via `HERMES_UID`),
  `HERMES_HOME=/opt/data` (EFS mount), entrypoint is s6-overlay `/init` (do not override),
  `docker-cli` present so `DOCKER_HOST` targets the EC2 sandbox.
- WhatsApp uses **Baileys** (QR). Session persists under `/opt/data/platforms/whatsapp/session`
  on EFS. Bootstrap once via ECS Exec (see root README).

Confirm the published image ref and pin `@sha256` before the first production push.
