# Design — Hermes VPC Privada (Tailscale, sem edge público, sem ELB, sem EC2)

**Data:** 2026-07-06
**Autor:** Melky Fernandes (design assistido)
**Base:** arquitetura atual em `main` (Fases 1–6 do projeto original) + `docs/superpowers/specs/2026-07-03-hermes-platform-infra-design.md`
**Repo:** `melkyfb/hermes-cloud-infra` · Região `eu-central-1`

---

## 1. Objetivo e motivação

Virar a plataforma Hermes de **"edge público (API Gateway + WAF)"** para **"VPC 100% privada, acessada por VPN Tailscale"**, adicionar as interfaces web do Hermes (dashboard + hermes-webui), e trocar o sandbox EC2 por execução `local`.

**Três drivers convergentes:**
1. **Segurança** (tópico 5): `/v1` e as UIs não devem ser acessíveis fora da VPC.
2. **Conta AWS travada:** a conta bloqueia criação de **EC2** e **ELB** (hold de verificação). Esta arquitetura **remove exatamente EC2 e ELB** → provavelmente deploya mesmo sob o hold.
3. **Funcionalidade** (tópico 3): interfaces web (admin + chat) com histórico unificado.

### Cobre os 5 tópicos do brainstorm
1. Sandbox → backend `local` + hardening (sem EC2). §7
2. Substituir ELB → removido; roteamento interno via Service Connect. §6, §8
3. hermes-webui → task hermes multi-container (gateway+dashboard+webui). §5
4. Acesso privado → Tailscale userspace em Fargate. §6
5. `/v1` só na VPC → sem edge + SGs intra-VPC. §8

---

## 2. Decisões (validadas no brainstorm)

| # | Decisão | Motivo |
|---|---------|--------|
| D1 | **Remover** `HermesApiGatewayStack` inteiro (API GW, WAF, Lambda authorizer, VPC Link, **NLB**) | /v1 privado; dropa ELB; destrava sob o hold |
| D2 | Acesso privado via **Tailscale userspace sidecar** em Fargate (NÃO Client VPN, NÃO subnet-router) | Barato, EC2-free; subnet-router precisa de TUN (indisponível no Fargate) |
| D3 | UI Hermes = **task única com 3 containers** (gateway + dashboard + webui) num **HERMES_HOME EFS compartilhado** | Histórico unificado com SQLite seguro (um só cliente NFS) |
| D4 | webui = **nesquena/hermes-webui** (espelho GHCR), dashboard = **embutido** do agent | dashboard controla (admin); webui é o cliente de chat superior |
| D5 | Sandbox = backend **`local`** + hardening (command-approval, task role mínimo, egress restrito) | Sem EC2; aceita o raio de dano documentado |
| D6 | `HermesEc2Stack` sai de cena | sandbox `local` não usa Docker host |
| D7 | UID alinhado em **1000** nas 3 superfícies + EFS AP (segue o padrão testado do nesquena) | permissões do volume compartilhado |

---

## 3. Arquitetura alvo

```
        [ seu laptop no tailnet ]
                 │ (WireGuard/Tailscale)
                 ▼
        ┌─────────── VPC 10.0.0.0/16 (privada) ───────────┐
        │                                                  │
        │  ECS Fargate (subnets privadas)                  │
        │  ┌────────────────────────────────────────────┐ │
        │  │ task "hermes" (awsvpc, 1 ENI)               │ │
        │  │  ├ gateway  (:8642 localhost)  Telegram/WA  │ │
        │  │  ├ dashboard(:9119)  admin                  │ │
        │  │  ├ webui    (:8787)  chat                   │ │
        │  │  └ ts-sidecar (userspace) → serve 9119/8787 │ │
        │  │   HERMES_HOME  ──────┐ (EFS, 1 NFS client)  │ │
        │  └──────────────────────┼─────────────────────┘ │
        │                         ▼                        │
        │                   [ Amazon EFS ]                 │
        │  ┌────────────────────────────────────────────┐ │
        │  │ task "freellmapi" (:3001)                   │ │
        │  │  └ ts-sidecar (userspace) → serve 3001      │ │
        │  │   freellmapi.hermes.local (Service Connect) │ │
        │  └────────────────────────────────────────────┘ │
        │        NAT → Telegram/WhatsApp/LLM egress        │
        └──────────────────────────────────────────────────┘
```

**Stacks depois:**
- `HermesVpcStack` — mantém. NAT fica (agent precisa egress p/ mensageria/LLM).
- `HermesEfsStack` — mantém 2 FS. O AP do agent vira o **home compartilhado** das 3 superfícies (UID 1000). FreeLLMAPI segue com FS/AP próprio.
- `HermesEcrStack` — +1 repo **`hermes-webui`** (espelho `ghcr.io/nesquena/hermes-webui`).
- `HermesEcsStack` — reescrita: task `freellmapi` (inalterada, +sidecar TS) + task `hermes` multi-container + Service Connect namespace `hermes.local`.
- `HermesEc2Stack` — **removida**.
- `HermesApiGatewayStack` — **removida** (e `lambda/authorizer/` deletado).

---

## 4. Peça central: task `hermes` multi-container + home EFS

**Por que uma task só (e não 3 tasks):** o compose oficial do nesquena roda gateway+dashboard+webui compartilhando um **volume Docker local** (1 host → locks SQLite POSIX funcionam). Nosso home é **EFS (NFS)**. Tasks Fargate separadas = **clientes NFS distintos** → lock cross-client (NLM) não-confiável → corrompe o SQLite (mesmo motivo que fixa a FreeLLMAPI em 1 writer). **Solução:** os 3 containers na **mesma task** compartilham **um único mount EFS** → **um só cliente NFS** → o kernel arbitra fcntl/POSIX locks localmente → concorrência segura. No `awsvpc`, os 3 dividem a rede → conversam por `localhost`.

**Task `hermes`** (Fargate x86_64, ~**4 vCPU / 8 GB**), 4 containers:

| Container | Imagem | Comando/porta | Papel |
|-----------|--------|---------------|-------|
| `gateway` | `hermes-agent` (ECR) | `gateway run` · :8642 (interno) | Telegram/WhatsApp/cron/tools |
| `dashboard` | `hermes-agent` (ECR) | `dashboard --host 0.0.0.0 --insecure --port 9119` · :9119 | admin (keys, models, MCP, plugins) |
| `webui` | `hermes-webui` (ECR) | :8787 | chat (cliente) |
| `ts` | `tailscale/tailscale` | userspace | expõe 9119+8787 ao tailnet |

- **Home compartilhado:** os 3 (gateway/dashboard/webui) montam o EFS AP do agent no mesmo path (`/home/hermes/.hermes`), `HERMES_HOME` idêntico, `HERMES_UID=HERMES_GID=1000` / `WANTED_UID=WANTED_GID=1000`. EFS AP posixUser = **1000**.
- **Comunicação interna:** `dashboard.GATEWAY_HEALTH_URL=http://localhost:8642`; `webui.HERMES_API_URL=http://localhost:8642`; `webui.HERMES_WEBUI_STATE_DIR=/home/hermes/.hermes/webui`.
- **Secrets:** `TELEGRAM_BOT_TOKEN`, `FREEAPI_DEFAULT_KEY` (no gateway); `HERMES_WEBUI_PASSWORD` (no webui, defesa em profundidade mesmo privado).
- **agent-src p/ webui (#681 / init):** o webui instala deps do agent a partir de `/opt/hermes` (`uv pip install`) no boot. Compartilhar via **volume task-scoped** entre `gateway` e `webui` (ro) — **estratégia exata a definir no plano** (copiar `/opt/hermes`→volume no init do gateway, ou usar o mecanismo do próprio webui). ⚠️ item de integração.
- Service `desiredCount: 1`, circuit breaker + rollback.

**Task `freellmapi`** — inalterada (1 vCPU/2 GB, :3001, EFS próprio single-writer, Service Connect `freellmapi.hermes.local:3001`), **+ sidecar `ts`** se quiser `/v1` acessível do laptop.

---

## 5. Tailscale (acesso privado, EC2-free)

- **Modo userspace** (`TS_USERSPACE=true`, sem `/dev/net/tun`/`NET_ADMIN` — que o Fargate não permite). Cada task exposta roda um sidecar `tailscale` que **entra no tailnet como um nó** e serve as portas locais via `tailscale serve` (9119/8787 na task hermes; 3001 na freellmapi).
- **Auth key** efêmera/reutilizável no **Secrets Manager** (`hermes/tailscale-authkey`), injetada no sidecar. Estado do TS em volume (ou ephemeral + key reutilizável).
- **Subnet-router descartado:** anunciar rotas exige TUN → indisponível no Fargate. Por isso cada serviço vira um nó (não há roteamento de sub-rede).
- Do laptop (no tailnet) você acessa `dashboard`/`webui`/`freellmapi` pelos nomes MagicDNS dos nós. Sem exposição pública.

---

## 6. Roteamento interno (substitui o ELB)

- **ECS Service Connect** com namespace Cloud Map `hermes.local`.
- `freellmapi.hermes.local:3001` — o `gateway` chama a FreeLLMAPI por esse nome (dispensa NLB).
- Sem nenhum load balancer.

---

## 7. Sandbox — backend `local` + hardening (tópico 1)

- `gateway` roda exec de código no **próprio container** (backend `local`), **sem** `DOCKER_HOST`.
- Hardening obrigatório (o código roda com o raio de dano do agent):
  - **command-approval on** (human-in-loop; padrão do hermes).
  - **task role mínimo** — só os grants de EFS que precisa; sem `ec2:DescribeInstances` (era do sandbox).
  - **SG de egress restrito** — permitir só o necessário (mensageria/LLM/endpoints AWS), não `0.0.0.0/0` aberto.
- Descartado: **Fargate efêmero** (não é backend nativo do hermes; latência 15-40s/exec; shim Docker-API caro). **Modal/Daytona** fica como evolução futura (isolamento real via SaaS).

---

## 8. `/v1` e UIs só na VPC (tópico 5)

- Sem edge público, não há rota da internet.
- SG da `freellmapi`: ingress 3001 só de origem intra-VPC (agent + faixa do sidecar TS).
- SG da task `hermes`: 9119/8787 só intra-VPC.
- Acesso externo **apenas** pelo tailnet (§5).

---

## 9. Fases (para o plano)

1. **Despir o edge** — remover `HermesApiGatewayStack` + `lambda/authorizer/` + o teste apigw; remover `HermesEc2Stack`; adicionar Service Connect (`hermes.local`) e travar SGs intra-VPC. Gate: `cdk synth --all` limpo, /v1 sem rota pública.
2. **Task hermes multi-container** — reescrever a task do agent p/ 3 containers (gateway+dashboard+webui) home EFS compartilhado UID 1000; +repo ECR `hermes-webui`; resolver o agent-src p/ webui.
3. **Tailscale** — sidecar userspace nas tasks expostas + secret da auth key.
4. **Sandbox `local` + hardening** — backend local, remover DOCKER_HOST, task role mínimo, egress SG restrito.

---

## 10. Riscos / itens a validar

- **R1 — SQLite em EFS mesmo com 1 task:** a premissa é que 3 containers numa task = 1 cliente NFS → locks locais OK. **Validar** em runtime (as 3 superfícies escrevendo sessões sem corrupção). Se falhar, fallback: 1 escritor + demais read-only, ou tirar o SQLite do EFS (RDS — fora de escopo).
- **R2 — agent-src p/ webui:** a estratégia de compartilhar `/opt/hermes` entre containers no Fargate (§4) precisa ser fechada no plano; #681 (tools do webui rodam no container do webui) é aceito.
- **R3 — Tailscale userspace serve:** confirmar que `tailscale serve` em userspace expõe as portas ao tailnet de forma estável no Fargate; auth key rotation.
- **R4 — sandbox `local`:** risco aceito (código = raio do agent); mitigações do §7 são obrigatórias, não opcionais.
- **Conta AWS:** este design não usa EC2/ELB → deve deployar sob o hold; mas o hold pode restringir outros serviços — validar no primeiro deploy.

---

## 11. Verificação

- `cd infra && npm ci && npx cdk synth --all` sem erro.
- `npm test` (jest) verde. Testes: remover `apigw.test.ts`; atualizar `ecs.test.ts` (2 tasks, task hermes com 3 containers + sidecar, sem 2375/DOCKER_HOST, Service Connect); novo teste do sidecar TS; asserts de SG intra-VPC.

## 12. Fora de escopo

- Histórico unificado via RDS/Postgres (tirar SQLite do EFS).
- AWS Client VPN (trocado por Tailscale).
- Sandbox Modal/Daytona (evolução futura).
- Edge público / WAF (removidos).
- Resolver o hold da conta AWS (assunto de billing/suporte, não código).
