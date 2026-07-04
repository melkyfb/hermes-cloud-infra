# Fase 7 — Validação Final e Hardening (Implementação)

**Data:** 2026-07-04
**Estado do repo:** Fases 1–6 implementadas em `main` (6 stacks CDK, `cdk synth --all` + `npm test` verdes, **sem deploy**).
**Escopo deste doc:** o que falta para fechar a Fase 7 — hardening implementável (código) + runbooks de validação (pós-deploy).

> A Fase 7 tem duas metades: **(A) Hardening** — mudanças concretas na infra; **(B) Validação**
> — testes de ataque simulado e ponta-a-ponta que exigem um ambiente **já deployado**.
> Nada aqui roda no `cdk synth` atual; é o trabalho pós-Fase-6.

---

## Sumário do que falta

| # | Item | Tipo | Prioridade | Esforço |
|---|------|------|-----------|---------|
| A1 | Substituir `AdministratorAccess` por menor privilégio | Hardening | **Alta** (maior risco real) | Médio |
| A2 | Ativar AWS GuardDuty | Hardening | Alta | Baixo |
| A3 | CloudWatch Alarms (Lambda throttle, ECS fail, WAF spikes) | Hardening | Alta | Médio |
| A4 | AWS Config Rules (EFS enc, SG portas, IAM policy) | Hardening | Média | Médio |
| A5 | Docker TLS 2376 no Sandbox (tirar 2375 plaintext) | Hardening | Média | Alto |
| A6 | Pin de imagens `FROM @sha256` | Hardening | Média | Baixo |
| A7 | Higiene: `containerInsightsV2`, `minHealthyPercent` | Hardening | Baixa | Baixo |
| B1 | Testes de ataque simulado (6 cenários) | Validação | Alta | Médio |
| B2 | Testes funcionais ponta-a-ponta (5 fluxos) | Validação | Alta | Médio |
| B3 | Verificações de runtime R1/R2 (authorizer, UID agent, QR) | Validação | **Alta** (premissas não testadas) | Baixo |

---

# Parte A — Hardening (implementável)

## A1. Menor privilégio no lugar de `AdministratorAccess`

**Falta:** `github-oidc-setup.yml` dá `AdministratorAccess` à `GitHubActionsDeployRole`. Único
maior risco real do repo. Restrito à branch `main` do repo, mas ainda é admin total.

**Abordagem recomendada (delegar aos roles do CDK bootstrap):** a partir do CDK v2 com
bootstrap moderno, o deploy não precisa que a role do CI seja admin — ela só precisa **assumir
os roles que o `cdk bootstrap` cria** (`cdk-hnb659fds-deploy-role-*`, `-cfn-exec-role-*`,
`-file-publishing-role-*`, `-image-publishing-role-*`) e ler o SSM param de versão do bootstrap.
Os roles do bootstrap é que carregam o poder de provisionar, e ficam na conta (não no CI).

Trocar o bloco `ManagedPolicyArns: [AdministratorAccess]` por uma policy inline:

```yaml
Policies:
  - PolicyName: HermesCdkDeployAssume
    PolicyDocument:
      Version: '2012-10-17'
      Statement:
        - Sid: AssumeCdkBootstrapRoles
          Effect: Allow
          Action: sts:AssumeRole
          Resource: arn:aws:iam::*:role/cdk-*-role-*-eu-central-1
        - Sid: ReadBootstrapVersion
          Effect: Allow
          Action: ssm:GetParameter
          Resource: arn:aws:ssm:eu-central-1:*:parameter/cdk-bootstrap/*/version
```

Pré-requisito: `cdk bootstrap aws://<ACCOUNT_ID>/eu-central-1` com uma
`--cloudformation-execution-policies` **também escopada** (não `AdministratorAccess`) — ex.
uma custom policy limitada aos serviços que as stacks usam:
`cloudformation, s3, ecr, ec2, ecs, efs, elasticloadbalancing, apigateway, wafv2, lambda,
logs, secretsmanager(read), kms, iam(scoped PassRole/CreateRole em hermes-*), guardduty, config`.

**Alternativa (policy direta na role do CI):** se não usar bootstrap roles, escrever a custom
policy acima direto na `GitHubActionsDeployRole`. Mais frágil (precisa cobrir tudo que o CDK
faz). Endurecer iterativamente com **IAM Access Analyzer** + CloudTrail: rodar um deploy, gerar
a policy a partir da atividade observada, apertar.

**Validação:** `aws sts assume-role`/deploy de teste ainda funciona; `iam:CreateUser` ou ações
fora do escopo passam a falhar com `AccessDenied`.

---

## A2. AWS GuardDuty

**Falta:** monitoramento contínuo de comportamento anômalo. Não existe stack.

Criar uma `HardeningStack` (nova, `infra/lib/hardening-stack.ts`) e ligar o detector:

```typescript
import * as guardduty from 'aws-cdk-lib/aws-guardduty';

new guardduty.CfnDetector(this, 'GuardDutyDetector', {
  enable: true,
  findingPublishingFrequency: 'FIFTEEN_MINUTES',
});
```

**Nota:** um detector por região por conta. Se a conta já tiver GuardDuty ligado (organização),
**não** recriar — importar/pular. Validar no console GuardDuty → Findings.

---

## A3. CloudWatch Alarms

**Falta:** alertas para Lambda throttling, falha de task ECS e picos de block do WAF.
Precisa de um **SNS topic** para notificação (email/Slack).

Na `HardeningStack`, recebendo por props o `authorizerFn` (Lambda), os dois `FargateService` e
o nome da Web ACL (ou expor métricas via CfnOutput na Fase 6). Snippet:

```typescript
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

const alarmTopic = new sns.Topic(this, 'HermesAlarms', { topicName: 'hermes-alarms' });
// sns.Subscription email/https adicionada manualmente ou via prop.

const alarmOf = (id: string, metric: cw.IMetric, threshold: number) =>
  metric.createAlarm(this, id, {
    threshold, evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cw_actions.SnsAction(alarmTopic));

// Lambda authorizer throttles
alarmOf('AuthorizerThrottles', props.authorizerFn.metricThrottles({ period: cdk.Duration.minutes(5) }), 1);

// WAF blocked requests spike (namespace AWS/WAFV2)
alarmOf('WafBlockSpike', new cw.Metric({
  namespace: 'AWS/WAFV2', metricName: 'BlockedRequests',
  dimensionsMap: { WebACL: 'hermes-api-waf', Region: this.region, Rule: 'ALL' },
  statistic: 'Sum', period: cdk.Duration.minutes(5),
}), 500);

// ECS: task count abaixo do desejado (proxy de "task failing / not stabilizing")
alarmOf('FreellmapiTasksDown', props.freellmapiService.metric('RunningTaskCount', {
  statistic: 'Minimum', period: cdk.Duration.minutes(5),
}), 0.9 /* < 1 task rodando dispara */);
```

Para o ECS usar `comparisonOperator: LESS_THAN_THRESHOLD` no alarm de task-count (ajustar o
helper ou criar inline). Validar: derrubar uma task de propósito → alarm dispara → SNS entrega.

---

## A4. AWS Config Rules

**Falta:** compliance contínuo. **Pré-requisito:** Config precisa de um
`ConfigurationRecorder` + `DeliveryChannel` (bucket S3) ligados na conta **antes** das rules.

Na `HardeningStack` (ou uma `ConfigStack` dedicada):

```typescript
import * as config from 'aws-cdk-lib/aws-config';

// (Assume recorder + delivery channel já provisionados na conta — senão criar CfnConfigurationRecorder + CfnDeliveryChannel + role/bucket primeiro.)

new config.ManagedRule(this, 'EfsEncrypted', {
  identifier: config.ManagedRuleIdentifiers.EFS_ENCRYPTED_CHECK,
});
new config.ManagedRule(this, 'SgRestrictedPorts', {
  identifier: config.ManagedRuleIdentifiers.VPC_SG_OPEN_ONLY_TO_AUTHORIZED_PORTS,
  inputParameters: { authorizedTcpPorts: '443' },
});
new config.ManagedRule(this, 'IamPasswordPolicy', {
  identifier: config.ManagedRuleIdentifiers.IAM_PASSWORD_POLICY,
});
```

Validar: console Config → Rules → todas `COMPLIANT` (EFS já é `encrypted: true`; SG do sandbox
só abre 2375 interno — a rule de portas pode flaggar 2375 como não-autorizado, o que é o
comportamento correto de auditoria, e some depois de A5/Docker TLS).

---

## A5. Docker TLS 2376 no Sandbox

**Falta:** hoje o daemon Docker do EC2 Sandbox escuta **2375 plaintext** (só protegido pelo SG,
restrito ao SG do agent). Compliance mais rígido pede TLS mútuo na 2376.

Mudanças:
1. **Certificados** (CA + server cert/key + client cert/key) — gerar e guardar no Secrets Manager
   (`hermes/docker-tls-*`). Não commitar certs.
2. **UserData do EC2** (`ec2-stack.ts`): baixar os certs do Secrets Manager no boot, e trocar o
   override do dockerd para:
   `dockerd -H tcp://0.0.0.0:2376 --tlsverify --tlscacert=/etc/docker/ca.pem --tlscert=/etc/docker/server-cert.pem --tlskey=/etc/docker/server-key.pem`
   (dar `ec2:...`/`secretsmanager:GetSecretValue` no instance role — hoje o sandbox não tem
   instance role; adicionar um).
3. **SG:** trocar ingress 2375 → **2376**.
4. **Agent** (`ecs-stack.ts`): `DOCKER_HOST=tcp://<ip>:2376`, `DOCKER_TLS_VERIFY=1`,
   `DOCKER_CERT_PATH=/opt/data/.docker` + montar os client certs (via secret) no container.

**Esforço alto** (gestão de PKI). Se o modelo de ameaça aceitar "plaintext dentro de subnet
privada + SG restrito", pode ficar como risco documentado. Decisão do usuário.

---

## A6. Pin de imagens `FROM @sha256`

**Falta:** `services/*/Dockerfile` usam `:latest` (mutável — supply-chain risk).

```dockerfile
# services/freellmapi/Dockerfile
FROM ghcr.io/tashfeenahmed/freellmapi:latest@sha256:<DIGEST>
```

Resolver os digests atuais e pinar:
```bash
docker buildx imagetools inspect ghcr.io/tashfeenahmed/freellmapi:latest
docker buildx imagetools inspect ghcr.io/nousresearch/hermes-agent:latest   # confirmar o registry publicado
```
Rebump manual quando quiser atualizar (o pipeline já re-tag SHA no ECR). Validar: `docker
build` resolve o digest fixo.

---

## A7. Higiene de synth (warnings)

**Falta:** dois warnings não-fatais no `cdk synth` (flagados no review).

- `ecs-stack.ts`: trocar `containerInsights: true` → `containerInsightsV2: ecs.ContainerInsights.ENABLED` (a prop antiga é deprecated no CDK pinado).
- Nos dois `FargateService`: setar `minHealthyPercent: 100` (com `desiredCount: 1`, evita o warning de default 50% e mantém a task durante rolling deploy junto do circuit breaker).

Validar: `cd infra && npx cdk synth --all` sem warnings + `npm test` verde.

---

# Parte B — Validação (pós-deploy, runbooks)

> Exige o ambiente deployado. Cada item traz o critério de sucesso do Master §10.

## B1. Testes de ataque simulado

| # | Cenário | Método | Esperado |
|---|---------|--------|----------|
| 1 | Rate limit | `for i in $(seq 1 150); do curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <KEY>' https://API/v1/models; done` | Após 100/5min → **429** (WAF) |
| 2 | Token brute force | requests com tokens aleatórios | **403** (authorizer Deny); cache não guarda inválidos |
| 3 | Lambda exhaustion | 51+ requests simultâneas a `/v1/*` | **429** (reserved concurrency 50) |
| 4 | Payload gigante | `POST` body > 256 KB | **403** (WAF BodySizeLimit) |
| 5 | Tor/proxy | request via Tor exit node | **bloqueado** (WAF IP Reputation) |
| 6 | EFS cross-access | do task do agent tentar ler o AP da freellmapi | **Permission denied** (POSIX/AP isolation) |

## B2. Testes funcionais ponta-a-ponta

| # | Fluxo | Critério |
|---|-------|----------|
| 1 | Telegram → agent → resposta | resposta em < 30s |
| 2 | Criar API key → usar no API Gateway | **200** + resposta do modelo |
| 3 | Persistência SQLite | criar key → reboot da task Fargate → key persiste (EFS) |
| 4 | Sandbox exec | agent roda script Python no EC2 → resultado correto, container efêmero removido |
| 5 | Rollback | deploy de imagem quebrada → circuit breaker → task definition anterior estabiliza |

## B3. Verificações de runtime das premissas (R1/R2 — não testáveis no synth)

Estas são **premissas do design** que só se confirmam com deploy — verificar cedo:

- **R1 — authorizer:** confirmar que a FreeLLMAPI real retorna **200** em `GET /v1/models` com key
  válida e **401/403** sem/ inválida. Se `/v1/models` **não** exigir key, o authorizer libera geral
  → escolher outro endpoint autenticado ou ajustar. **Crítico de segurança.**
- **R2 — UID do agent vs EFS:** o container hermes-agent roda como **UID 10000**; o AP do EFS foi
  fixado em `10000:10000`. Confirmar que o agent **escreve** em `/opt/data` sem `Permission denied`
  (checar logs no boot / criar arquivo de teste). Se a imagem remapear via `HERMES_UID`, alinhar.
- **WhatsApp QR bootstrap:** validar o fluxo `aws ecs execute-command ... hermes gateway setup` →
  QR no terminal → escanear → sessão gravada em `/opt/data/platforms/whatsapp/session` → restart
  da task **não** re-pede QR.

---

## Ordem sugerida

1. **B3** (verificar premissas assim que houver 1º deploy — barato, pega problema cedo).
2. **A7 + A6** (higiene + pin — rápido, no código, entra antes do deploy prod).
3. **A1** (menor privilégio — antes de qualquer deploy "sério").
4. **A2 + A3** (GuardDuty + alarms — visibilidade).
5. **A4** (Config rules).
6. **B1 + B2** (bateria de validação com tudo no ar).
7. **A5** (Docker TLS — se o compliance exigir).

## Como implementar

Cada item de hardening (A1–A7) é uma mudança de infra pequena e isolada. Se quiser que eu
**implemente**, o caminho é o mesmo dos docs de Fase 1–6: brainstorm curto → spec → plano →
execução TDD. Sugestão de fatiamento: uma `HardeningStack` nova cobre A2/A3/A4 juntas; A1 é
edição do `github-oidc-setup.yml` + `cdk bootstrap`; A5 é um mini-projeto próprio (PKI).
