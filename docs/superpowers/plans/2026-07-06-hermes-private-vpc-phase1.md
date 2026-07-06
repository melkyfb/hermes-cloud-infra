# Hermes Private VPC — Phase 1: Remove Public Edge + Private Routing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform fully private — delete the public API Gateway/WAF/NLB edge and the EC2 sandbox, and route the agent→FreeLLMAPI traffic through ECS Service Connect instead of the NLB.

**Architecture:** Remove `HermesApiGatewayStack` (API GW, WAF, Lambda authorizer, VPC Link, NLB) and `HermesEc2Stack`. FreeLLMAPI stops being publicly reachable; it advertises `freellmapi.hermes.local:3001` via a Cloud Map private namespace + ECS Service Connect. The agent runs code with the `local` backend (no DOCKER_HOST). This phase alone delivers spec topics 2 (drop ELB) and 5 (/v1 VPC-only), and removes the EC2/ELB resources the AWS account currently blocks.

**Tech Stack:** AWS CDK v2 (`aws-cdk-lib`), TypeScript, Node 20, npm, Jest + `aws-cdk-lib/assertions`.

**Spec:** `docs/superpowers/specs/2026-07-06-hermes-private-vpc-design.md` (this plan = Phase 1 of §9).

## Global Constraints

- Region **`eu-central-1`**. CDK **v2** (`aws-cdk-lib`) only.
- **No EC2, no ELB, no public ingress** after this phase.
- Internal DNS namespace: **`hermes.local`** (Cloud Map private). FreeLLMAPI advertises **`freellmapi.hermes.local:3001`** via ECS Service Connect.
- FreeLLMAPI container port stays **3001**; SG ingress 3001 allowed **only from the VPC CIDR** (`vpc.vpcCidrBlock`).
- Sandbox = **`local`** backend: the agent task has **no** `DOCKER_HOST`, no 2375 ingress, no `ec2:DescribeInstances`.
- Stacks after this phase: `HermesVpcStack`, `HermesEfsStack`, `HermesEcrStack`, `HermesEcsStack` (4 — down from 6).
- Success gate: `cd infra && npm ci && npx cdk synth --all` exits 0 AND `npm test` passes.

---

### Task 1: Remove the public edge (ApiGatewayStack + Lambda authorizer)

**Files:**
- Delete: `infra/lib/apigw-stack.ts`
- Delete: `infra/test/apigw.test.ts`
- Delete: `infra/lambda/authorizer/index.mjs`
- Delete: `infra/test/authorizer.test.mjs`
- Modify: `infra/bin/hermes-app.ts` (remove the ApiGatewayStack import + instantiation)
- Modify: `infra/package.json` (drop the `node --test` half of the `test` script)

**Interfaces:**
- Produces: nothing new. Removes `HermesApiGatewayStack` from the app.

- [ ] **Step 1: Delete the edge files**

```bash
cd infra
git rm lib/apigw-stack.ts test/apigw.test.ts lambda/authorizer/index.mjs test/authorizer.test.mjs
rmdir lambda/authorizer lambda 2>/dev/null || true
```

- [ ] **Step 2: Remove ApiGatewayStack from `infra/bin/hermes-app.ts`**

Delete the import line `import { ApiGatewayStack } from '../lib/apigw-stack';` and the entire `new ApiGatewayStack(app, 'HermesApiGatewayStack', { ... });` block. (Task 2 rewrites the rest of this file; here just remove the ApiGateway references.)

- [ ] **Step 3: Fix the `test` script in `infra/package.json`**

The authorizer test is gone, so `test` must not reference it. Change:

```json
    "test": "jest && node --test test/authorizer.test.mjs",
```
to:
```json
    "test": "jest",
```

- [ ] **Step 4: Verify synth + tests**

Run: `cd infra && npx cdk synth --all && npm test`
Expected: synth lists **no** `HermesApiGatewayStack`; no `AWS::WAFv2`, `AWS::ElasticLoadBalancingV2`, or `AWS::ApiGatewayV2` resources anywhere. Jest passes (apigw/authorizer suites gone). Exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(infra): remove public API Gateway edge (WAF, authorizer, NLB)"
```

---

### Task 2: Remove the EC2 sandbox + strip sandbox wiring from EcsStack

**Files:**
- Delete: `infra/lib/ec2-stack.ts`
- Delete: `infra/test/ec2.test.ts`
- Modify: `infra/bin/hermes-app.ts` (remove sandbox flag + Ec2SandboxStack + sandbox props)
- Modify: `infra/lib/ecs-stack.ts` (drop sandbox props, `DOCKER_HOST`, 2375 ingress, `ec2:DescribeInstances`)
- Modify: `infra/test/ecs.test.ts` (remove sandbox-related assertions)

**Interfaces:**
- Produces: `EcsStackProps` without `sandboxSecurityGroup`, `sandboxPrivateIp` (both removed).

- [ ] **Step 1: Delete the EC2 stack files**

```bash
cd infra
git rm lib/ec2-stack.ts test/ec2.test.ts
```

- [ ] **Step 2: Rewrite `infra/bin/hermes-app.ts` to the Phase-1 composition**

Full file content:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsClusterStack } from '../lib/ecs-stack';

const app = new cdk.App();
const env = { region: 'eu-central-1' };

const vpc = new VpcStack(app, 'HermesVpcStack', { env });
const efs = new EfsStack(app, 'HermesEfsStack', { env, vpc: vpc.vpc });
const ecr = new EcrStack(app, 'HermesEcrStack', { env });
new EcsClusterStack(app, 'HermesEcsStack', {
  env,
  vpc: vpc.vpc,
  efsFreellmapi: efs.freellmapiFs,
  efsAgent: efs.agentFs,
  efsApFreellmapi: efs.freellmapiAccessPoint,
  efsApAgent: efs.agentAccessPoint,
  freellmapiRepo: ecr.freellmapiRepo,
  agentRepo: ecr.agentRepo,
});

app.synth();
```

- [ ] **Step 3: Update `EcsStackProps` in `infra/lib/ecs-stack.ts`**

Remove the two sandbox lines. The interface becomes:

```typescript
export interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  efsFreellmapi: efs.IFileSystem;
  efsAgent: efs.IFileSystem;
  efsApFreellmapi: efs.IAccessPoint;
  efsApAgent: efs.IAccessPoint;
  freellmapiRepo: ecr.IRepository;
  agentRepo: ecr.IRepository;
}
```

- [ ] **Step 4: Remove `DOCKER_HOST` from the agent container**

In `infra/lib/ecs-stack.ts`, the agent container currently has:

```typescript
      environment: props.sandboxPrivateIp
        ? { DOCKER_HOST: `tcp://${props.sandboxPrivateIp}:2375` }
        : {},
```

Replace with an empty environment (sandbox is `local`, no remote Docker):

```typescript
      environment: {},
```

- [ ] **Step 5: Remove the `ec2:DescribeInstances` grant and the sandbox ingress**

Delete the whole `if (props.sandboxSecurityGroup) { agentTask.taskRole.addToPrincipalPolicy(... ec2:DescribeInstances ...) }` block, and delete the whole `if (props.sandboxSecurityGroup) { new ec2.CfnSecurityGroupIngress(...2375...) }` block. The agent no longer talks to any sandbox.

- [ ] **Step 6: Update `infra/test/ecs.test.ts`**

Remove the sandbox-disabled test and the `withSandbox` parameter, and drop the 2375 ingress assertion. The `build()` helper no longer passes sandbox props:

```typescript
function build() {
  const app = new App();
  const vpc = new VpcStack(app, 'Vpc', { env });
  const efs = new EfsStack(app, 'Efs', { env, vpc: vpc.vpc });
  const ecr = new EcrStack(app, 'Ecr', { env });
  const ecs = new EcsClusterStack(app, 'Ecs', {
    env,
    vpc: vpc.vpc,
    efsFreellmapi: efs.freellmapiFs,
    efsAgent: efs.agentFs,
    efsApFreellmapi: efs.freellmapiAccessPoint,
    efsApAgent: efs.agentAccessPoint,
    freellmapiRepo: ecr.freellmapiRepo,
    agentRepo: ecr.agentRepo,
  });
  return Template.fromStack(ecs);
}

test('EcsClusterStack: two services, exec enabled, no sandbox', () => {
  const t = build();
  t.resourceCountIs('AWS::ECS::Service', 2);
  t.hasResourceProperties('AWS::ECS::Service', { EnableExecuteCommand: true });
  t.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0); // no 2375 sandbox ingress
  expect(JSON.stringify(t.toJSON())).not.toContain('DOCKER_HOST');
});

test('EcsClusterStack: freellmapi container listens on 3001', () => {
  const t = build();
  t.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ PortMappings: Match.arrayWith([Match.objectLike({ ContainerPort: 3001 })]) }),
    ]),
  });
});
```

Also delete the now-unused `import { Ec2SandboxStack } from '../lib/ec2-stack';` at the top of the test file.

- [ ] **Step 7: Verify synth + tests**

Run: `cd infra && npx cdk synth --all && npm test`
Expected: no `HermesEc2Stack`; `HermesEcsStack` synthesizes; jest green. Exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(infra): remove EC2 sandbox, switch agent to local exec (no DOCKER_HOST)"
```

---

### Task 3: Service Connect + private FreeLLMAPI reachability

**Files:**
- Modify: `infra/lib/ecs-stack.ts` (Cloud Map namespace on the cluster; Service Connect on the FreeLLMAPI service; named port mapping; VPC-only ingress on 3001)
- Modify: `infra/test/ecs.test.ts` (assert the private namespace + service-connect)

**Interfaces:**
- Consumes: `vpc`, EFS, ECR (as before).
- Produces: FreeLLMAPI reachable in-VPC at `freellmapi.hermes.local:3001`; no public path.

- [ ] **Step 1: Add the failing assertions to `infra/test/ecs.test.ts`**

Append:

```typescript
test('EcsClusterStack: private Cloud Map namespace hermes.local exists', () => {
  const t = build();
  t.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: 'hermes.local' });
});

test('EcsClusterStack: freellmapi allows 3001 only from the VPC CIDR', () => {
  const t = build();
  t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 3001, ToPort: 3001, IpProtocol: 'tcp', CidrIp: '10.0.0.0/16',
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd infra && npx jest test/ecs.test.ts -t 'Cloud Map'`
Expected: FAIL (no PrivateDnsNamespace yet).

- [ ] **Step 3: Add the Cloud Map namespace to the cluster**

In `infra/lib/ecs-stack.ts`, add the import:

```typescript
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
```

Change the cluster construction to declare the default namespace:

```typescript
    this.cluster = new ecs.Cluster(this, 'HermesCluster', {
      vpc: props.vpc,
      clusterName: 'hermes-cluster',
      containerInsights: true,
      defaultCloudMapNamespace: {
        name: 'hermes.local',
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
        useForServiceConnect: true,
      },
    });
```

- [ ] **Step 4: Name the FreeLLMAPI port mapping**

In the `freellmapiContainer` `addContainer` call, give the port mapping a name (Service Connect requires it):

```typescript
      portMappings: [{ name: 'freellmapi', containerPort: 3001, protocol: ecs.Protocol.TCP }],
```

- [ ] **Step 5: Enable Service Connect on the FreeLLMAPI service + open 3001 to the VPC**

Change the `this.freellmapiService = new ecs.FargateService(...)` to add Service Connect, and after it, open the SG to the VPC CIDR (this ingress used to live in the removed ApiGateway stack):

```typescript
    this.freellmapiService = new ecs.FargateService(this, 'FreellmapiService', {
      cluster: this.cluster,
      serviceName: 'FreellmapiService',
      taskDefinition: freellmapiTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      serviceConnectConfiguration: {
        services: [{ portMappingName: 'freellmapi', dnsName: 'freellmapi', port: 3001 }],
      },
    });

    // In-VPC only: the agent (and later a Tailscale sidecar) reach FreeLLMAPI on 3001.
    this.freellmapiService.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(3001),
      'In-VPC access to FreeLLMAPI',
    );
```

- [ ] **Step 6: Verify**

Run: `cd infra && npx jest test/ecs.test.ts && npx cdk synth HermesEcsStack`
Expected: all ecs tests PASS; synth succeeds; the template contains `AWS::ServiceDiscovery::PrivateDnsNamespace` (hermes.local) and the ECS service has `ServiceConnectConfiguration`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(infra): private FreeLLMAPI via Service Connect (freellmapi.hermes.local:3001)"
```

---

### Task 4: Update the README for the private architecture

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Replace the architecture + first-deploy sections**

Rewrite `README.md` so it reflects Phase 1. Ensure it states:
- Layout: `infra/` now has 4 stacks (Vpc → Efs → Ecr → Ecs); the public edge and EC2 sandbox are gone.
- FreeLLMAPI is **private**, reachable in-VPC at `freellmapi.hermes.local:3001` (Service Connect). There is **no public `/v1`**.
- The agent runs code with the **`local`** backend (no sandbox host). Set the hermes exec backend to `local` and keep command-approval on in the agent config under `HERMES_HOME`.
- First deploy: unchanged order minus the edge — `cdk bootstrap` → deploy `HermesEcrStack` → mirror images → `cdk deploy --all`. Secrets: `hermes/freellmapi-keys` (FREEAPI_MASTER_KEY, FREEAPI_DEFAULT_KEY, ENCRYPTION_KEY) + `hermes/telegram-bot-token`.
- A short "**Coming next (Phase 2+)**" note: hermes dashboard + hermes-webui as a multi-container task, and Tailscale for private access — until then the private services have no external access path.

Concretely, replace the `## EC2 sandbox (optional)`, `## First deploy`, and top architecture lines. Keep `## Secrets`, adjusting the WhatsApp note as-is. Remove any mention of API Gateway, WAF, NLB, `/v1` public endpoint, and the `-c sandbox=false` flag (the sandbox stack no longer exists).

- [ ] **Step 2: Verify**

Run: `grep -c '^#' README.md` → positive count. `grep -i 'API Gateway\|WAF\|sandbox=false\|NLB' README.md` → **no matches** (stale edge references removed).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for private (edge-less) architecture"
```

---

## Self-Review (completed during authoring)

**Spec coverage (Phase 1 only):** D1 remove edge → Task 1; D6 remove Ec2 + D5 sandbox-local infra → Task 2; §6 Service Connect + §8 /v1 VPC-only SG → Task 3; docs → Task 4. Phases 2–4 (multi-container webui, Tailscale, sandbox hardening polish) are **out of scope for this plan** — see Follow-up.

**Placeholder scan:** No TBD/TODO in steps. Task 4 is prose-guided (a README rewrite) with explicit required content + a grep gate — acceptable for a docs task.

**Type consistency:** `EcsStackProps` (Task 2/3) matches the `bin` wiring (Task 2). `freellmapiService`, `freellmapiRepo`, `agentRepo`, EFS field names unchanged from the existing stack. Port mapping name `freellmapi` is used consistently in the container mapping and the Service Connect config.

---

## Follow-up (separate plans — NOT this phase)

These carry the spec's open risks and need a **prototype first** (superpowers:prototype) before a no-placeholder plan:

- **Phase 2 — hermes multi-container task (dashboard + webui):** blocked on **R2** (how the webui image gets the agent source for `uv pip install` in a Fargate multi-container task) and **R1** (validate SQLite on EFS survives 3 containers in one task = one NFS client). Prototype: run `docker-compose.three-container.yml` locally, then a single-task ECS analog, before writing CDK.
- **Phase 3 — Tailscale userspace sidecar:** blocked on **R3** (confirm `tailscale serve` in userspace exposes 9119/8787/3001 to the tailnet on Fargate; auth-key rotation). Prototype: a one-off Fargate task with the sidecar.
- **Phase 4 — sandbox hardening polish:** restricted egress SG + confirm command-approval config. Small; can fold into Phase 2's task or its own quick plan.
