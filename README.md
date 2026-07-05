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

> Local `cdk deploy` needs AWS credentials configured (`aws configure` / env vars) with
> permission to deploy — the same admin creds used for the OIDC step below. No `.env` file is
> used: region comes from `bin/hermes-app.ts` (`eu-central-1`) and the account from your creds.

1. Deploy OIDC trust once (admin creds):
   ```bash
   aws cloudformation deploy --template-file github-oidc-setup.yml \
     --stack-name github-oidc-trust-stack --capabilities CAPABILITY_NAMED_IAM --region eu-central-1
   ```
2. Set GitHub secret `AWS_ACCOUNT_ID`.
3. Create the secrets in Secrets Manager (see below).
4. **Install deps and bootstrap the environment (first time only):**
   ```bash
   cd infra
   npm ci                                              # REQUIRED — installs aws-cdk-lib etc.
   npx cdk bootstrap aws://<AWS_ACCOUNT_ID>/eu-central-1   # needed for asset-bearing stacks
   ```
   Skipping `npm ci` causes `Cannot find module 'aws-cdk-lib'` (all stack props then look like
   they lack `env`). `cdk bootstrap` is required because the ApiGateway stack ships the Lambda
   authorizer as an asset.
5. Deploy `HermesEcrStack` first so the repos exist:
   ```bash
   npx cdk deploy HermesEcrStack
   ```
6. Trigger the service workflows (or run them manually) to mirror images into ECR.
7. Deploy the rest: `npx cdk deploy --all`.

## EC2 sandbox (optional)
The `HermesEc2Stack` sandbox (remote Docker host for the agent's code execution) is opt-out.
Disable it with `-c sandbox=false` on any cdk command:
```bash
npx cdk deploy --all -c sandbox=false
```
Use this when the AWS account can't launch EC2 (e.g. a new/unverified account returns
`This account is currently blocked ... account-verification`). With the sandbox off, the agent
runs without `DOCKER_HOST` (no remote code exec) and no 2375 ingress is created. Re-enable later
by deploying without the flag once EC2 is available.

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
