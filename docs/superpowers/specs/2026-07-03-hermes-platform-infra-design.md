# Design — Hermes Platform Infra (Monorepo CDK)

**Data:** 2026-07-03
**Autor:** Melky Fernandes (design assistido)
**Fonte:** `HermesCloudInfraDocs/` — Documentação Master + Fases 1 a 6
**Repo alvo:** `melkyfb/hermes-platform-infra` · Região `eu-central-1`

**Apps upstream (referência real do usuário):**
- FreeLLMAPI: https://github.com/tashfeenahmed/freellmapi
- Hermes-Agent: https://github.com/NousResearch/hermes-agent

---

## 1. Objetivo e escopo

Materializar num monorepo a arquitetura dos 7 documentos técnicos do Projeto Hermes, de
forma que **`npx cdk synth --all` passe limpo** e o repo fique pronto para deploy — **sem**
deploy nesta entrega.

> ⚠️ **Nota crítica:** os documentos técnicos foram escritos contra aplicações *idealizadas*
> e divergem dos repos upstream reais (porta, entrypoint, paths, mecanismo de WhatsApp).
> Este design segue os **repos reais**, não a letra dos docs, quando há conflito.

### Premissas fixadas (validadas com o usuário)
- **Entrega = código + `cdk synth`.** Nada é provisionado na AWS. Sem credenciais,
  `AWS_ACCOUNT_ID` real ou valores de secrets.
- **Monorepo completo de uma vez** (todas as stacks + pipelines + OIDC).
- **Fonte das apps é do usuário / upstream.** Vendorizamos os Dockerfiles upstream
  (mudança mínima); não reescrevemos a fonte das apps.
- **CDK v2** (`aws-cdk-lib`), **TypeScript**, **Node 20**, **npm**.
- OIDC / ARNs / workflows usam `repo:melkyfb/hermes-platform-infra`.

### Fora de escopo
- Deploy real, `cdk deploy`, criação de secrets, criação do OIDC provider na conta.
- Reescrita da fonte das aplicações.
- Fase 7 (ataque ao vivo) e hardening pós-validação (GuardDuty, AWS Config, custom IAM
  policy, Docker TLS 2376) — TODO no README.

### Critério de sucesso
1. `cd infra && npm ci && npx cdk synth --all` termina **sem erro**.
2. `npm test` (jest) passa: ~1 assert por stack validando recursos críticos.

---

## 2. Divergências docs → realidade (decisões aplicadas)

| Item | Docs assumem | Real (upstream) | Decisão |
|------|--------------|-----------------|---------|
| Porta FreeLLMAPI | 8080 | **3001** | Usar 3001 no NLB, health check, SG ingress, container port |
| Entry FreeLLMAPI | `node server.js` | `node server/dist/index.js` | Dockerfile upstream (zero mudança) |
| User FreeLLMAPI | UID 1000 (custom) | `USER node` (UID 1000) | Casa com EFS AP 1000 sem mudança |
| DB path FreeLLMAPI | `/app/data/freellmapi.db` | `/app/server/data/freeapi.db` (`FREEAPI_DB_PATH`) | EFS mount em `/app/server/data` |
| Health FreeLLMAPI | `GET /health` | `GET /api/ping` | Health NLB é TCP; rota pública opcional aponta `/api/ping` |
| Secrets FreeLLMAPI | `FREEAPI_MASTER_KEY` | + **`ENCRYPTION_KEY`** (AES-256 at-rest) | Adicionar `ENCRYPTION_KEY` |
| Base Hermes-Agent | `nousresearch/hermes-agent:latest` (pré-build) | Debian 13 + `uv` + Node 22 + s6-overlay, build da fonte (árvore grande) | Vendorizar upstream **ou** espelhar imagem publicada → ver §5 |
| **Home/estado agent** | mount `/home/appuser/.hermes` | **`HERMES_HOME=/opt/data`** (`VOLUME /opt/data`) | **EFS mount em `/opt/data`** (inclui sessão WhatsApp) |
| **UID agent** | 1000 | **10000** (`hermes`, remap via `HERMES_UID`) | **EFS AP do agent = 10000:10000** |
| Entrypoint agent | `python -m hermes_cli.main gateway run` | s6-overlay `/init` + `main-wrapper.sh` (supervisão) | **Não** sobrescrever entrypoint |
| Docker no agent | assume `docker-cli` presente | `docker-cli` já instalado | `DOCKER_HOST` → EC2 sandbox funciona |
| WhatsApp | Business Cloud API (`WHATSAPP_API_KEY`/`PHONE_ID`) | **Baileys** (QR / WhatsApp Web), sessão sob `/opt/data` | Baileys/QR; **dropar** os 2 secrets Cloud API |

### Auth do FreeLLMAPI (decidido)
- **Sem `/v1/auth/validate`** — não existe no upstream. FreeLLMAPI usa **unified key**
  (`freellmapi-<key>`), auth aplicada em todos os `/v1/*`.
- Authorizer valida via **`GET {NLB}/v1/models`** com o Bearer recebido: **Allow se HTTP
  200**, Deny em qualquer não-200 (401/403), timeout ou erro (**fail-closed**). Sem parse
  de body. Status exato de deny (401 vs 403) a confirmar contra deploy real — irrelevante
  pra lógica (qualquer não-200 = Deny).

### Risco a verificar na fase de plano
- **R1 — health check:** o NLB usa health check **TCP** na 3001 (não depende de `GET
  /health`). A rota pública `GET /health` do API Gateway pode 404 se o upstream não tiver
  esse path — inofensivo. Confirmar no plano se vale manter a rota `/health`.
- **R2 — UID do Hermes-Agent:** o EFS Access Point força POSIX `1000:1000`. Se o container
  upstream rodar com UID diferente, escrita em `.hermes` falha (`Permission denied`).
  Alinhar: rodar container como 1000 **ou** ajustar o `posixUser` do AP ao UID real.

---

## 3. Estrutura do monorepo

```
hermes-platform-infra/
├── infra/                          # AWS CDK (TypeScript)
│   ├── bin/hermes-app.ts           # composição das stacks
│   ├── lib/
│   │   ├── vpc-stack.ts
│   │   ├── efs-stack.ts
│   │   ├── ec2-stack.ts
│   │   ├── ecr-stack.ts            # LACUNA A (nova)
│   │   ├── ecs-stack.ts
│   │   └── apigw-stack.ts
│   ├── lambda/authorizer/index.mjs
│   ├── test/stacks.test.ts
│   ├── package.json / tsconfig.json / cdk.json / jest.config.js
├── services/
│   ├── freellmapi/
│   │   ├── Dockerfile               # upstream vendorizado (zero/mínima mudança)
│   │   └── README.md                # aponta o upstream + onde a fonte entra
│   └── hermes-agent/
│       ├── Dockerfile               # upstream (Python/uv), build da fonte
│       └── README.md
├── .github/workflows/
│   ├── deploy-freellmapi.yml        # on.push.paths: services/freellmapi/**
│   ├── deploy-hermes-agent.yml      # on.push.paths: services/hermes-agent/**
│   └── deploy-infra.yml             # on.push.paths: infra/**
├── github-oidc-setup.yml
└── README.md
```

---

## 4. Stacks CDK

Ordem de composição em `bin/hermes-app.ts`:
```
VpcStack → EfsStack → Ec2SandboxStack → EcrStack → EcsClusterStack → ApiGatewayStack
```

### 4.1. VpcStack (Fase 3)
CIDR `10.0.0.0/16`, `maxAzs: 2`, `natGateways: 1`, subnets `PUBLIC` + `PRIVATE_WITH_EGRESS`,
VPC Flow Logs → CloudWatch (`/vpc/hermes/flow-logs`, 30d).

### 4.2. EfsStack (Fase 3) — nomes ajustados
- FS **`freellmapi-server-data`** (AP path `/freellmapi`, mount na task em `/app/server/data`,
  POSIX **`1000:1000`** — casa com `USER node`).
- FS **`hermes-agent-home`** (AP path `/hermes-agent`, mount na task em **`/opt/data`**,
  POSIX **`10000:10000`** — casa com o user `hermes` da imagem).
- Ambos KMS-encrypted, `RemovalPolicy.RETAIN`, perms `750`.
- Expõe os 2 FS + 2 Access Points.

### 4.3. Ec2SandboxStack (Fase 3)
`t4g.small` (ARM64), AL2023, subnet privada. SG `hermes-sandbox-sg` **sem ingress inicial**
(adicionado na EcsStack). UserData expõe Docker em `tcp://0.0.0.0:2375`. Tags
`Project=hermes`, `Role=sandbox`. Expõe `sandboxSg`, `sandboxPrivateIp`.

### 4.4. EcrStack — LACUNA A (nova)
Repos **`freellmapi`** e **`hermes-agent`**, `imageScanOnPush: true`, tag `MUTABLE`,
lifecycle "últimas 30 tags", `RemovalPolicy.RETAIN`. Stack separada (pipeline precisa dela
antes do build). Expõe os 2 repos por referência.

### 4.5. EcsClusterStack (Fase 5) — lacunas + realidade
- Cluster `hermes-cluster`, `containerInsights: true`.
- Secrets via `fromSecretNameV2`: `hermes/freellmapi-keys`, `hermes/telegram-bot-token`.
  **Sem** `hermes/whatsapp-credentials` (Baileys não usa).
- **FreeLLMAPI TaskDef** (1 vCPU/2 GB, x86_64):
  - imagem via `fromEcrRepository(freellmapiRepo, 'latest')`.
  - container port **3001**; NLB/health/SG usam 3001.
  - EFS mount `/app/server/data` (AP freellmapi).
  - env `FREEAPI_DB_PATH=/app/server/data/freeapi.db`.
  - secrets `FREEAPI_MASTER_KEY` + **`ENCRYPTION_KEY`** (de `hermes/freellmapi-keys`).
  - log group `/ecs/hermes/freellmapi`. Service `desiredCount:1`, circuit breaker+rollback.
- **Hermes-Agent TaskDef** (2 vCPU/4 GB, x86_64):
  - imagem `fromEcrRepository(agentRepo, 'latest')`.
  - EFS mount **`/opt/data`** (AP agent, POSIX 10000) — é o `HERMES_HOME`, **inclui a
    sessão Baileys** (`/opt/data/platforms/whatsapp/session`), persistente entre restarts.
  - **Sem override de entrypoint** — usa o s6-overlay `/init` da imagem.
  - env `DOCKER_HOST=tcp://<sandboxPrivateIp>:2375` (imagem já tem `docker-cli`).
  - secrets injetados como env `TELEGRAM_BOT_TOKEN`, `FREEAPI_DEFAULT_KEY` (nomes de var
    consumidos pelo hermes a confirmar no plano vs config do gateway).
  - **`enableExecuteCommand: true`** no service (bootstrap do QR via ECS Exec:
    `hermes` roda dentro do container) + perms SSM (`ssmmessages:*`) na task role.
  - log group `/ecs/hermes/agent`. Service `desiredCount:1`, circuit breaker.
- IAM: grants EFS `ClientMount/ClientWrite` por task role; agent com `ec2:DescribeInstances`
  condicionado a `Project=hermes`.
- **LACUNA C — ingress do Sandbox:**
  `props.sandboxSecurityGroup.addIngressRule(agentService.connections.securityGroups[0],
  ec2.Port.tcp(2375))`.
- Expõe `freellmapiService`.

### 4.6. ApiGatewayStack (Fase 6) — lacuna + porta real
- NLB interno (`internetFacing:false`, `crossZoneEnabled:true`), target group IP porta
  **3001**, health check TCP, deregistration 30s. `attachToNetworkTargetGroup(freellmapiService)`.
- **LACUNA D — conectividade NLB→FreeLLMAPI:**
  `props.freellmapiService.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock),
  ec2.Port.tcp(3001))`.
- VPC Link, Lambda Authorizer (Node 20, 128 MB, timeout 5s, reserved concurrency 50, cache
  3600s, `FREELLMAPI_INTERNAL_URL` = DNS do NLB). Valida com **`GET /v1/models`** →
  Allow sse 200, senão Deny (fail-closed). Cache por token (1h) preserva o backend.
- HTTP API: `ANY /v1/{proxy+}` com authorizer; `GET /health` sem authorizer.
- WAF Web ACL REGIONAL, 4 regras (rate 100/5min, Bot Control, IP Reputation, body 256 KB),
  associada ao stage `$default`.
- Outputs `ApiEndpoint`, `NlbDns`.

### 4.7. Lacunas B e E — documentação
- **B — ordem ovo-galinha:** ECS referencia `:latest`, que só existe após o primeiro build.
  Não afeta `synth`. README documenta a sequência do 1º deploy.
- **E — secrets manuais:** `fromSecretNameV2` só monta ARN. README documenta criação manual
  de `hermes/freellmapi-keys` (`FREEAPI_MASTER_KEY`, `FREEAPI_DEFAULT_KEY`, `ENCRYPTION_KEY`)
  e `hermes/telegram-bot-token`, com schema JSON.

---

## 5. Imagens das apps — estratégia (decisão)

Ambos os apps já **publicam imagens prontas** (freellmapi → GHCR; hermes-agent → registry
oficial). Dois modelos possíveis para popular o ECR:

- **(V) Vendorizar a fonte:** copiar a árvore completa de cada repo para `services/*/` e
  buildar via `docker build` no pipeline. Casa com "já tenho o código", mas o build do
  hermes-agent é pesado (uv + node22 + playwright + s6, vários minutos) e a árvore é enorme.
- **(M) Espelhar a imagem publicada:** o pipeline faz `docker pull <upstream>` →
  re-tag → `docker push` pro ECR. `services/*/` guarda só um `Dockerfile` fino
  (`FROM <upstream-digest>`) + README. Muito mais simples e rápido; ainda passa por ECR
  (scan on-push, lifecycle). **Recomendado** para um projeto focado em infra.

> **Decisão: (M) Espelhar imagem publicada.** `services/*/` guarda um `Dockerfile` fino
> `FROM <upstream>` (tag/digest pinado) + README. O pipeline builda esse Dockerfile (só
> puxa + re-exporta a imagem upstream) e faz push pro ECR. Sem vendorizar fonte.

Fatos upstream (valem para os dois modelos):
- **freellmapi:** Node 20, multi-arch, porta 3001, `USER node` (UID 1000), DB
  `/app/server/data`, health `GET /api/ping`. Zero mudança.
- **hermes-agent:** Debian 13 + uv + Node 22 + s6-overlay, `USER hermes` (UID 10000, remap
  `HERMES_UID`), `HERMES_HOME=/opt/data`, entrypoint s6 `/init`, `docker-cli` embutido.

---

## 6. Pipelines — 3 workflows independentes por alvo

Cada serviço deploya sozinho; mudar o Dockerfile do hermes **não** toca a freellmapi nem a
infra. Todos via OIDC (Fase 2), sem credenciais estáticas. Único GitHub Secret: `AWS_ACCOUNT_ID`.

| Workflow | Trigger (`on.push.paths`) | Ação |
|----------|---------------------------|------|
| `deploy-freellmapi.yml` | `services/freellmapi/**` | login ECR → `docker build` do Dockerfile fino (mirror do upstream) → push (`freellmapi`, SHA+latest) → `ecs update-service --force-new-deployment` (freellmapi). **Sem cdk.** |
| `deploy-hermes-agent.yml` | `services/hermes-agent/**` | mirror build+push (`hermes-agent`, SHA+latest) → force redeploy (agent). **Sem cdk.** |
| `deploy-infra.yml` | `infra/**` | `npm ci` → `cdk diff` → `cdk deploy` (stacks afetadas). |

Racional: imagem é `:latest`; um `cdk deploy` não detecta troca de imagem de mesma tag —
`force-new-deployment` é o mecanismo correto e suficiente para mudança só de imagem. Infra é
o único caso que exige `cdk`.

`github-oidc-setup.yml` (Fase 2): OIDC provider + `GitHubActionsDeployRole`, trust restrito a
`repo:melkyfb/hermes-platform-infra:ref:refs/heads/main`, `AdministratorAccess` (TODO:
custom policy no hardening).

---

## 7. Verificação

```bash
cd infra && npm ci && npx cdk synth --all   # sem erro
npm test                                     # jest — asserts mínimos
```

Testes jest (`aws-cdk-lib/assertions`), ~1 assert crítico por stack:
- Vpc: 1 NAT + Flow Logs · Efs: 2 FS + 2 AP · Ec2: `t4g.small` + SG
- Ecr: 2 repos scan-on-push · Ecs: 2 services + ingress 2375 no sandbox SG
- ApiGw: WAF 4 regras + rota `/v1/{proxy+}` com authorizer + ingress 3001

---

## 8. Decisões em aberto
- Nenhum bloqueio para `synth`. R1 e R2 são validações de integração para a fase de plano
  (não impedem synth; impedem funcionamento real).
- `AdministratorAccess` na role OIDC — hardening como TODO no README.
- Versões exatas de `aws-cdk-lib`/`constructs` pinadas na fase de plano.
