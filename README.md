# hermes-platform-infra

AWS CDK monorepo for the Hermes platform: FreeLLMAPI (OpenAI-compatible proxy) and
Hermes-Agent (messaging gateway), on ECS Fargate behind API Gateway + WAF.
Region: `eu-central-1`. Design: `docs/superpowers/specs/2026-07-03-hermes-platform-infra-design.md`.

## Layout
- `infra/` — CDK app (Vpc → Efs → Ec2Sandbox → Ecr → Ecs → ApiGateway).
- `services/` — thin mirror Dockerfiles (re-publish upstream images to ECR).
- `.github/workflows/` — per-target deploy pipelines.
- `github-oidc-setup.yml` — one-time OIDC trust bootstrap.

## Validate locally (no AWS needed)
```bash
cd infra && npm ci && npx cdk synth --all && npm test
```

## First deploy (ordered — resolves the image chicken-and-egg)
1. Deploy OIDC trust once (admin creds):
   ```bash
   aws cloudformation deploy --template-file github-oidc-setup.yml \
     --stack-name github-oidc-trust-stack --capabilities CAPABILITY_NAMED_IAM --region eu-central-1
   ```
2. Set GitHub secret `AWS_ACCOUNT_ID`.
3. Create the secrets in Secrets Manager (see below).
4. Deploy `HermesEcrStack` first so the repos exist:
   `cd infra && npx cdk deploy HermesEcrStack`.
5. Trigger the service workflows (or run them manually) to mirror images into ECR.
6. Deploy the rest: `npx cdk deploy --all`.

## Secrets (create manually before deploy)
- `hermes/freellmapi-keys` (JSON): `{ "FREEAPI_MASTER_KEY": "...", "FREEAPI_DEFAULT_KEY": "...", "ENCRYPTION_KEY": "..." }`
- `hermes/telegram-bot-token` (plaintext): the BotFather token.
- No WhatsApp secret — WhatsApp uses Baileys (QR), see below.

## WhatsApp (Baileys / QR) one-time bootstrap
Session persists on EFS at `/opt/data/platforms/whatsapp/session`, so the QR scan is
one-time and survives task restarts. To scan:
```bash
aws ecs execute-command --cluster hermes-cluster --task <agent-task-id> \
  --container hermes-agent --interactive --command "hermes gateway setup"
```
Scan the printed QR in WhatsApp → Linked devices. (QR refreshes ~20s; restart the command if it times out.)

## Hardening TODO (Fase 7 — not implemented)
- Replace `AdministratorAccess` on `GitHubActionsDeployRole` with a least-privilege custom policy.
- Enable GuardDuty, AWS Config rules, CloudWatch alarms (Lambda throttle, ECS failures, WAF spikes).
- Consider Docker TLS (2376) for the sandbox if compliance requires it.
- Pin all mirror `FROM` images to `@sha256` digests.
