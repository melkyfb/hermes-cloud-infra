# Hermes Platform Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `hermes-platform-infra` monorepo (AWS CDK v2 + Dockerfiles + GitHub Actions + OIDC) so `cdk synth --all` and `npm test` pass, ready to deploy — without deploying.

**Architecture:** Six composed CDK stacks (Vpc → Efs → Ec2Sandbox → Ecr → Ecs → ApiGateway) in `infra/`, a Lambda token-introspection authorizer, thin "mirror" Dockerfiles that re-publish the upstream app images to ECR, three path-filtered deploy workflows, and a CloudFormation OIDC trust template. Design source: `docs/superpowers/specs/2026-07-03-hermes-platform-infra-design.md`.

**Tech Stack:** AWS CDK v2 (`aws-cdk-lib`), TypeScript, Node 20, npm, Jest + `aws-cdk-lib/assertions`, `node --test` for the `.mjs` authorizer.

## Global Constraints

- Region: **`eu-central-1`** everywhere.
- CDK **v2** single package `aws-cdk-lib`; `constructs` ^10. No v1 imports.
- GitHub repo identity: **`melkyfb/hermes-platform-infra`**, branch **`main`** (OIDC sub claim, ARNs, workflows).
- **No deploy** in this deliverable. Success = `cd infra && npm ci && npx cdk synth --all` exits 0 AND `npm test` passes.
- **Mirror image strategy:** `services/*/Dockerfile` is a thin `FROM <upstream>` re-published to ECR. Do NOT vendor app source.
- Exact values (do not "improve"):
  - FreeLLMAPI: container port **3001**, EFS mount **`/app/server/data`**, `FREEAPI_DB_PATH=/app/server/data/freeapi.db`, runs as UID **1000** (image `USER node`).
  - Hermes-Agent: EFS mount **`/opt/data`** (`HERMES_HOME`), runs as UID **10000** (image `USER hermes`), **no entrypoint override**, `docker-cli` present.
  - EFS Access Points: freellmapi **`1000:1000`**, agent **`10000:10000`**, perms `750`.
  - ECR repos: **`freellmapi`**, **`hermes-agent`**.
  - EFS filesystems: **`freellmapi-server-data`**, **`hermes-agent-home`**.
  - Lambda authorizer validates via **`GET {NLB}/v1/models`** → Allow iff HTTP 200 (fail-closed). No `/v1/auth/validate`.
  - Secrets in ECS: `hermes/freellmapi-keys` (`FREEAPI_MASTER_KEY`, `FREEAPI_DEFAULT_KEY`, `ENCRYPTION_KEY`), `hermes/telegram-bot-token`. **No WhatsApp secrets** (Baileys/QR).
- All secrets referenced with `Secret.fromSecretNameV2` (name-only; not created here).

---

### Task 1: Bootstrap the CDK project

**Files:**
- Create: `.gitignore`
- Create: `infra/package.json`
- Create: `infra/tsconfig.json`
- Create: `infra/cdk.json`
- Create: `infra/jest.config.js`
- Create: `infra/bin/hermes-app.ts`

**Interfaces:**
- Produces: `bin/hermes-app.ts` exports nothing; defines `const app = new cdk.App()` and `const env = { region: 'eu-central-1' }` used by every later task.

- [ ] **Step 1: Init git + gitignore**

```bash
cd C:/Users/itsal/Documents/hermes-cloud-infra
git init
```

Create `.gitignore`:

```gitignore
node_modules/
infra/cdk.out/
infra/*.js
infra/*.d.ts
!infra/jest.config.js
*.log
cdk-outputs.json
```

- [ ] **Step 2: Create `infra/package.json`**

```json
{
  "name": "hermes-platform-infra",
  "version": "0.1.0",
  "private": true,
  "bin": { "hermes-app": "bin/hermes-app.ts" },
  "scripts": {
    "build": "tsc",
    "synth": "cdk synth --all",
    "test": "jest && node --test test/authorizer.test.mjs",
    "cdk": "cdk"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "aws-cdk": "^2.150.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "~5.5.3"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.150.0",
    "constructs": "^10.3.0",
    "source-map-support": "^0.5.21"
  }
}
```

Note: at execution, run `npm install aws-cdk-lib@latest aws-cdk@latest` to pin the current v2 if `2.150` is stale, then keep versions aligned.

- [ ] **Step 3: Create `infra/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node", "jest"]
  },
  "exclude": ["node_modules", "cdk.out"]
}
```

- [ ] **Step 4: Create `infra/cdk.json`**

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/hermes-app.ts",
  "watch": { "exclude": ["cdk.out", "node_modules", "test"] },
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true
  }
}
```

- [ ] **Step 5: Create `infra/jest.config.js`**

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
};
```

- [ ] **Step 6: Create `infra/bin/hermes-app.ts` (empty app)**

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

const app = new cdk.App();
const env = { region: 'eu-central-1' };

// Stacks are wired in by later tasks (Vpc → Efs → Ec2 → Ecr → Ecs → ApiGateway).

app.synth();
```

- [ ] **Step 7: Install and verify empty synth**

Run:
```bash
cd infra && npm install && npx cdk synth --all
```
Expected: exits 0, prints "Successfully synthesized" / nothing to synth (no stacks yet), no errors.

- [ ] **Step 8: Commit**

```bash
git add .gitignore infra/package.json infra/tsconfig.json infra/cdk.json infra/jest.config.js infra/bin/hermes-app.ts infra/package-lock.json
git commit -m "chore: bootstrap hermes-platform-infra CDK project"
```

---

### Task 2: VpcStack

**Files:**
- Create: `infra/lib/vpc-stack.ts`
- Create: `infra/test/vpc.test.ts`
- Modify: `infra/bin/hermes-app.ts`

**Interfaces:**
- Produces: `class VpcStack extends cdk.Stack` with `public readonly vpc: ec2.Vpc`.

- [ ] **Step 1: Write the failing test** — `infra/test/vpc.test.ts`

```typescript
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('VpcStack: single NAT gateway and one flow log', () => {
  const app = new App();
  const stack = new VpcStack(app, 'Vpc', { env });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::EC2::NatGateway', 1);
  t.resourceCountIs('AWS::EC2::FlowLog', 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && npx jest test/vpc.test.ts`
Expected: FAIL — cannot find module `../lib/vpc-stack`.

- [ ] **Step 3: Write `infra/lib/vpc-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'HermesVpc', {
      vpcName: 'hermes-vpc',
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogs', {
          logGroupName: '/vpc/hermes/flow-logs',
          retention: logs.RetentionDays.THIRTY_DAYS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
  }
}
```

- [ ] **Step 4: Wire into `infra/bin/hermes-app.ts`**

Replace the wiring comment with:

```typescript
import { VpcStack } from '../lib/vpc-stack';

const vpc = new VpcStack(app, 'HermesVpcStack', { env });
```

- [ ] **Step 5: Run test + synth to verify pass**

Run: `cd infra && npx jest test/vpc.test.ts && npx cdk synth HermesVpcStack`
Expected: PASS; synth prints the VPC template with no errors.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/vpc-stack.ts infra/test/vpc.test.ts infra/bin/hermes-app.ts
git commit -m "feat(infra): add VpcStack"
```

---

### Task 3: EfsStack

**Files:**
- Create: `infra/lib/efs-stack.ts`
- Create: `infra/test/efs.test.ts`
- Modify: `infra/bin/hermes-app.ts`

**Interfaces:**
- Consumes: `VpcStack.vpc` (`ec2.IVpc`).
- Produces: `class EfsStack` with `EfsStackProps { vpc: ec2.IVpc }` and readonly `freellmapiFs: efs.FileSystem`, `agentFs: efs.FileSystem`, `freellmapiAccessPoint: efs.AccessPoint`, `agentAccessPoint: efs.AccessPoint`.

- [ ] **Step 1: Write the failing test** — `infra/test/efs.test.ts`

```typescript
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('EfsStack: two encrypted filesystems and two access points with correct POSIX ids', () => {
  const app = new App();
  const vpc = new VpcStack(app, 'Vpc', { env });
  const efs = new EfsStack(app, 'Efs', { env, vpc: vpc.vpc });
  const t = Template.fromStack(efs);
  t.resourceCountIs('AWS::EFS::FileSystem', 2);
  t.resourceCountIs('AWS::EFS::AccessPoint', 2);
  t.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
  t.hasResourceProperties('AWS::EFS::AccessPoint', { PosixUser: { Uid: '1000', Gid: '1000' } });
  t.hasResourceProperties('AWS::EFS::AccessPoint', { PosixUser: { Uid: '10000', Gid: '10000' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && npx jest test/efs.test.ts`
Expected: FAIL — cannot find module `../lib/efs-stack`.

- [ ] **Step 3: Write `infra/lib/efs-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface EfsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class EfsStack extends cdk.Stack {
  public readonly freellmapiFs: efs.FileSystem;
  public readonly agentFs: efs.FileSystem;
  public readonly freellmapiAccessPoint: efs.AccessPoint;
  public readonly agentAccessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: EfsStackProps) {
    super(scope, id, props);

    this.freellmapiFs = new efs.FileSystem(this, 'FreellmapiEfs', {
      vpc: props.vpc,
      fileSystemName: 'freellmapi-server-data',
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.freellmapiAccessPoint = this.freellmapiFs.addAccessPoint('FreellmapiAp', {
      path: '/freellmapi',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
      posixUser: { uid: '1000', gid: '1000' },
    });

    this.agentFs = new efs.FileSystem(this, 'AgentEfs', {
      vpc: props.vpc,
      fileSystemName: 'hermes-agent-home',
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.agentAccessPoint = this.agentFs.addAccessPoint('AgentAp', {
      path: '/hermes-agent',
      createAcl: { ownerUid: '10000', ownerGid: '10000', permissions: '750' },
      posixUser: { uid: '10000', gid: '10000' },
    });
  }
}
```

- [ ] **Step 4: Wire into `infra/bin/hermes-app.ts`** (add after the `vpc` line)

```typescript
import { EfsStack } from '../lib/efs-stack';

const efs = new EfsStack(app, 'HermesEfsStack', { env, vpc: vpc.vpc });
```

- [ ] **Step 5: Run test + synth to verify pass**

Run: `cd infra && npx jest test/efs.test.ts && npx cdk synth HermesEfsStack`
Expected: PASS; synth succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/efs-stack.ts infra/test/efs.test.ts infra/bin/hermes-app.ts
git commit -m "feat(infra): add EfsStack with isolated access points"
```

---

### Task 4: Ec2SandboxStack

**Files:**
- Create: `infra/lib/ec2-stack.ts`
- Create: `infra/test/ec2.test.ts`
- Modify: `infra/bin/hermes-app.ts`

**Interfaces:**
- Consumes: `VpcStack.vpc`.
- Produces: `class Ec2SandboxStack` with `Ec2SandboxStackProps { vpc: ec2.IVpc }` and readonly `sandboxSg: ec2.SecurityGroup`, `sandboxPrivateIp: string`.

- [ ] **Step 1: Write the failing test** — `infra/test/ec2.test.ts`

```typescript
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { Ec2SandboxStack } from '../lib/ec2-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('Ec2SandboxStack: t4g.small instance with a dedicated security group', () => {
  const app = new App();
  const vpc = new VpcStack(app, 'Vpc', { env });
  const ec2s = new Ec2SandboxStack(app, 'Ec2', { env, vpc: vpc.vpc });
  const t = Template.fromStack(ec2s);
  t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.small' });
  t.resourceCountIs('AWS::EC2::SecurityGroup', 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && npx jest test/ec2.test.ts`
Expected: FAIL — cannot find module `../lib/ec2-stack`.

- [ ] **Step 3: Write `infra/lib/ec2-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface Ec2SandboxStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class Ec2SandboxStack extends cdk.Stack {
  public readonly sandboxSg: ec2.SecurityGroup;
  public readonly sandboxPrivateIp: string;

  constructor(scope: Construct, id: string, props: Ec2SandboxStackProps) {
    super(scope, id, props);

    this.sandboxSg = new ec2.SecurityGroup(this, 'SandboxSg', {
      vpc: props.vpc,
      securityGroupName: 'hermes-sandbox-sg',
      description: 'Allow Docker API access only from Hermes-Agent ECS tasks',
      allowAllOutbound: true,
    });
    // Ingress from the Agent SG (tcp 2375) is added in EcsClusterStack (Task 7).

    const instance = new ec2.Instance(this, 'SandboxHost', {
      vpc: props.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: this.sandboxSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    cdk.Tags.of(instance).add('Project', 'hermes');
    cdk.Tags.of(instance).add('Role', 'sandbox');

    instance.addUserData(
      'yum update -y',
      'yum install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      'mkdir -p /etc/systemd/system/docker.service.d',
      'cat > /etc/systemd/system/docker.service.d/override.conf << EOF',
      '[Service]',
      'ExecStart=',
      'ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375',
      'EOF',
      'systemctl daemon-reload',
      'systemctl restart docker',
    );

    this.sandboxPrivateIp = instance.instancePrivateIp;
    new cdk.CfnOutput(this, 'SandboxPrivateIp', {
      value: instance.instancePrivateIp,
      description: 'Private IP of the EC2 Sandbox (Docker Host)',
    });
  }
}
```

- [ ] **Step 4: Wire into `infra/bin/hermes-app.ts`**

```typescript
import { Ec2SandboxStack } from '../lib/ec2-stack';

const ec2Sandbox = new Ec2SandboxStack(app, 'HermesEc2Stack', { env, vpc: vpc.vpc });
```

- [ ] **Step 5: Run test + synth to verify pass**

Run: `cd infra && npx jest test/ec2.test.ts && npx cdk synth HermesEc2Stack`
Expected: PASS; synth succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/ec2-stack.ts infra/test/ec2.test.ts infra/bin/hermes-app.ts
git commit -m "feat(infra): add Ec2SandboxStack (remote Docker host)"
```

---

### Task 5: EcrStack

**Files:**
- Create: `infra/lib/ecr-stack.ts`
- Create: `infra/test/ecr.test.ts`
- Modify: `infra/bin/hermes-app.ts`

**Interfaces:**
- Produces: `class EcrStack` (props: `cdk.StackProps`) with readonly `freellmapiRepo: ecr.Repository`, `agentRepo: ecr.Repository`.

- [ ] **Step 1: Write the failing test** — `infra/test/ecr.test.ts`

```typescript
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EcrStack } from '../lib/ecr-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('EcrStack: two repositories with scan-on-push', () => {
  const app = new App();
  const ecr = new EcrStack(app, 'Ecr', { env });
  const t = Template.fromStack(ecr);
  t.resourceCountIs('AWS::ECR::Repository', 2);
  t.hasResourceProperties('AWS::ECR::Repository', {
    ImageScanningConfiguration: { ScanOnPush: true },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && npx jest test/ecr.test.ts`
Expected: FAIL — cannot find module `../lib/ecr-stack`.

- [ ] **Step 3: Write `infra/lib/ecr-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export class EcrStack extends cdk.Stack {
  public readonly freellmapiRepo: ecr.Repository;
  public readonly agentRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const common = {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 30, description: 'Keep last 30 images' }],
    };

    this.freellmapiRepo = new ecr.Repository(this, 'FreellmapiRepo', {
      repositoryName: 'freellmapi',
      ...common,
    });
    this.agentRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'hermes-agent',
      ...common,
    });
  }
}
```

- [ ] **Step 4: Wire into `infra/bin/hermes-app.ts`**

```typescript
import { EcrStack } from '../lib/ecr-stack';

const ecr = new EcrStack(app, 'HermesEcrStack', { env });
```

- [ ] **Step 5: Run test + synth to verify pass**

Run: `cd infra && npx jest test/ecr.test.ts && npx cdk synth HermesEcrStack`
Expected: PASS; synth succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/ecr-stack.ts infra/test/ecr.test.ts infra/bin/hermes-app.ts
git commit -m "feat(infra): add EcrStack (freellmapi + hermes-agent repos)"
```

---

### Task 6: Lambda Authorizer

**Files:**
- Create: `infra/lambda/authorizer/index.mjs`
- Create: `infra/test/authorizer.test.mjs`

**Interfaces:**
- Produces: `index.mjs` exports `handler`, `extractBearerToken(header)`, `generatePolicy(principalId, effect, resourceArn)`. Consumed by `ApiGatewayStack` (Task 8) as a `lambda.Code.fromAsset('lambda/authorizer')` with handler `index.handler` and env `FREELLMAPI_INTERNAL_URL`.

- [ ] **Step 1: Write the failing test** — `infra/test/authorizer.test.mjs`

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, generatePolicy } from '../lambda/authorizer/index.mjs';

test('extractBearerToken parses case-insensitive scheme', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.equal(extractBearerToken('bearer abc'), 'abc');
  assert.equal(extractBearerToken('abc'), null);
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('generatePolicy encodes Allow/Deny and context flag', () => {
  const allow = generatePolicy('tok', 'Allow', 'arn:x');
  assert.equal(allow.policyDocument.Statement[0].Effect, 'Allow');
  assert.equal(allow.policyDocument.Statement[0].Resource, 'arn:x');
  assert.equal(allow.context.tokenValidated, 'true');
  const deny = generatePolicy('tok', 'Deny', 'arn:x');
  assert.equal(deny.policyDocument.Statement[0].Effect, 'Deny');
  assert.equal(deny.context.tokenValidated, 'false');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && node --test test/authorizer.test.mjs`
Expected: FAIL — cannot resolve `../lambda/authorizer/index.mjs`.

- [ ] **Step 3: Write `infra/lambda/authorizer/index.mjs`**

```javascript
// HTTP API Lambda authorizer (IAM response). Validates the caller's FreeLLMAPI
// key by probing GET {NLB}/v1/models — Allow iff the upstream returns 200.
// Fail-closed: any non-200, timeout, or error => Deny.
const NLB_ENDPOINT = process.env.FREELLMAPI_INTERNAL_URL;

export const handler = async (event) => {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const token = extractBearerToken(header);
  if (!token) return generatePolicy('anonymous', 'Deny', event.routeArn);

  try {
    const res = await fetch(`${NLB_ENDPOINT}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return generatePolicy(token, res.ok ? 'Allow' : 'Deny', event.routeArn);
  } catch (err) {
    console.error('authz probe failed:', err.message);
    return generatePolicy(token, 'Deny', event.routeArn);
  }
};

export function extractBearerToken(header) {
  if (!header) return null;
  const parts = header.split(' ');
  return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
}

export function generatePolicy(principalId, effect, resourceArn) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resourceArn }],
    },
    context: { tokenValidated: String(effect === 'Allow') },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd infra && node --test test/authorizer.test.mjs`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/authorizer/index.mjs infra/test/authorizer.test.mjs
git commit -m "feat(infra): add token-introspection Lambda authorizer"
```

---

### Task 7: EcsClusterStack

**Files:**
- Create: `infra/lib/ecs-stack.ts`
- Create: `infra/test/ecs.test.ts`
- Modify: `infra/bin/hermes-app.ts`

**Interfaces:**
- Consumes: `vpc`, `EfsStack.{freellmapiFs, agentFs, freellmapiAccessPoint, agentAccessPoint}`, `Ec2SandboxStack.{sandboxSg, sandboxPrivateIp}`, `EcrStack.{freellmapiRepo, agentRepo}`.
- Produces: `class EcsClusterStack` with `EcsStackProps` (below) and readonly `cluster: ecs.Cluster`, `freellmapiService: ecs.FargateService`.

**EcsStackProps:**
```typescript
export interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  efsFreellmapi: efs.IFileSystem;
  efsAgent: efs.IFileSystem;
  efsApFreellmapi: efs.IAccessPoint;
  efsApAgent: efs.IAccessPoint;
  sandboxSecurityGroup: ec2.ISecurityGroup;
  sandboxPrivateIp: string;
  freellmapiRepo: ecr.IRepository;
  agentRepo: ecr.IRepository;
}
```

- [ ] **Step 1: Write the failing test** — `infra/test/ecs.test.ts`

```typescript
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';
import { Ec2SandboxStack } from '../lib/ec2-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsClusterStack } from '../lib/ecs-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

function build() {
  const app = new App();
  const vpc = new VpcStack(app, 'Vpc', { env });
  const efs = new EfsStack(app, 'Efs', { env, vpc: vpc.vpc });
  const ec2s = new Ec2SandboxStack(app, 'Ec2', { env, vpc: vpc.vpc });
  const ecr = new EcrStack(app, 'Ecr', { env });
  const ecs = new EcsClusterStack(app, 'Ecs', {
    env,
    vpc: vpc.vpc,
    efsFreellmapi: efs.freellmapiFs,
    efsAgent: efs.agentFs,
    efsApFreellmapi: efs.freellmapiAccessPoint,
    efsApAgent: efs.agentAccessPoint,
    sandboxSecurityGroup: ec2s.sandboxSg,
    sandboxPrivateIp: ec2s.sandboxPrivateIp,
    freellmapiRepo: ecr.freellmapiRepo,
    agentRepo: ecr.agentRepo,
  });
  return Template.fromStack(ecs);
}

test('EcsClusterStack: two services, sandbox ingress 2375, exec enabled', () => {
  const t = build();
  t.resourceCountIs('AWS::ECS::Service', 2);
  t.hasResourceProperties('AWS::ECS::Service', { EnableExecuteCommand: true });
  t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 2375, ToPort: 2375, IpProtocol: 'tcp',
  });
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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && npx jest test/ecs.test.ts`
Expected: FAIL — cannot find module `../lib/ecs-stack`.

- [ ] **Step 3: Write `infra/lib/ecs-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  efsFreellmapi: efs.IFileSystem;
  efsAgent: efs.IFileSystem;
  efsApFreellmapi: efs.IAccessPoint;
  efsApAgent: efs.IAccessPoint;
  sandboxSecurityGroup: ec2.ISecurityGroup;
  sandboxPrivateIp: string;
  freellmapiRepo: ecr.IRepository;
  agentRepo: ecr.IRepository;
}

export class EcsClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly freellmapiService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'HermesCluster', {
      vpc: props.vpc,
      clusterName: 'hermes-cluster',
      containerInsights: true,
    });

    const telegramSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'TelegramSecret', 'hermes/telegram-bot-token',
    );
    const freellmapiKeys = secretsmanager.Secret.fromSecretNameV2(
      this, 'FreellmapiKeys', 'hermes/freellmapi-keys',
    );

    // ---- FreeLLMAPI ----
    const freellmapiTask = new ecs.FargateTaskDefinition(this, 'FreellmapiTask', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    freellmapiTask.addVolume({
      name: 'efs-freellmapi',
      efsVolumeConfiguration: {
        fileSystemId: props.efsFreellmapi.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: props.efsApFreellmapi.accessPointId, iam: 'ENABLED' },
      },
    });
    const freellmapiContainer = freellmapiTask.addContainer('freellmapi', {
      image: ecs.ContainerImage.fromEcrRepository(props.freellmapiRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'freellmapi',
        logGroup: new logs.LogGroup(this, 'FreellmapiLogs', {
          logGroupName: '/ecs/hermes/freellmapi',
          retention: logs.RetentionDays.THIRTY_DAYS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3001',
        FREEAPI_DB_PATH: '/app/server/data/freeapi.db',
      },
      secrets: {
        FREEAPI_MASTER_KEY: ecs.Secret.fromSecretsManager(freellmapiKeys, 'FREEAPI_MASTER_KEY'),
        ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(freellmapiKeys, 'ENCRYPTION_KEY'),
      },
      portMappings: [{ containerPort: 3001, protocol: ecs.Protocol.TCP }],
    });
    freellmapiContainer.addMountPoints({
      containerPath: '/app/server/data',
      sourceVolume: 'efs-freellmapi',
      readOnly: false,
    });
    props.efsFreellmapi.grant(
      freellmapiTask.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    );

    this.freellmapiService = new ecs.FargateService(this, 'FreellmapiService', {
      cluster: this.cluster,
      taskDefinition: freellmapiTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
    });

    // ---- Hermes-Agent ----
    const agentTask = new ecs.FargateTaskDefinition(this, 'AgentTask', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    agentTask.addVolume({
      name: 'efs-agent',
      efsVolumeConfiguration: {
        fileSystemId: props.efsAgent.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: props.efsApAgent.accessPointId, iam: 'ENABLED' },
      },
    });
    const agentContainer = agentTask.addContainer('hermes-agent', {
      image: ecs.ContainerImage.fromEcrRepository(props.agentRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hermes-agent',
        logGroup: new logs.LogGroup(this, 'AgentLogs', {
          logGroupName: '/ecs/hermes/agent',
          retention: logs.RetentionDays.THIRTY_DAYS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        DOCKER_HOST: `tcp://${props.sandboxPrivateIp}:2375`,
      },
      secrets: {
        TELEGRAM_BOT_TOKEN: ecs.Secret.fromSecretsManager(telegramSecret),
        FREEAPI_DEFAULT_KEY: ecs.Secret.fromSecretsManager(freellmapiKeys, 'FREEAPI_DEFAULT_KEY'),
      },
    });
    agentContainer.addMountPoints({
      containerPath: '/opt/data',
      sourceVolume: 'efs-agent',
      readOnly: false,
    });
    props.efsAgent.grant(
      agentTask.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    );
    agentTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/Project': 'hermes' } },
    }));

    const agentService = new ecs.FargateService(this, 'AgentService', {
      cluster: this.cluster,
      taskDefinition: agentTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: true, // one-time WhatsApp QR bootstrap via ECS Exec
    });

    // LACUNA C: allow the Agent to reach the sandbox Docker daemon (tcp 2375).
    props.sandboxSecurityGroup.addIngressRule(
      agentService.connections.securityGroups[0],
      ec2.Port.tcp(2375),
      'Hermes-Agent -> sandbox Docker daemon',
    );
  }
}
```

- [ ] **Step 4: Wire into `infra/bin/hermes-app.ts`**

```typescript
import { EcsClusterStack } from '../lib/ecs-stack';

const ecs = new EcsClusterStack(app, 'HermesEcsStack', {
  env,
  vpc: vpc.vpc,
  efsFreellmapi: efs.freellmapiFs,
  efsAgent: efs.agentFs,
  efsApFreellmapi: efs.freellmapiAccessPoint,
  efsApAgent: efs.agentAccessPoint,
  sandboxSecurityGroup: ec2Sandbox.sandboxSg,
  sandboxPrivateIp: ec2Sandbox.sandboxPrivateIp,
  freellmapiRepo: ecr.freellmapiRepo,
  agentRepo: ecr.agentRepo,
});
```

- [ ] **Step 5: Run test + synth to verify pass**

Run: `cd infra && npx jest test/ecs.test.ts && npx cdk synth HermesEcsStack`
Expected: PASS (both tests); synth succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/ecs-stack.ts infra/test/ecs.test.ts infra/bin/hermes-app.ts
git commit -m "feat(infra): add EcsClusterStack with EFS mounts, secrets, sandbox wiring"
```

---

### Task 8: ApiGatewayStack (completes composition)

**Files:**
- Create: `infra/lib/apigw-stack.ts`
- Create: `infra/test/apigw.test.ts`
- Modify: `infra/bin/hermes-app.ts`

**Interfaces:**
- Consumes: `vpc`, `EcsClusterStack.freellmapiService`, and the asset at `infra/lambda/authorizer` (Task 6).
- Produces: `class ApiGatewayStack` with `ApiGatewayStackProps { vpc: ec2.IVpc; freellmapiService: ecs.FargateService }`.

- [ ] **Step 1: Write the failing test** — `infra/test/apigw.test.ts`

```typescript
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';
import { Ec2SandboxStack } from '../lib/ec2-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsClusterStack } from '../lib/ecs-stack';
import { ApiGatewayStack } from '../lib/apigw-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('ApiGatewayStack: WAF with 4 rules and a Lambda authorizer', () => {
  const app = new App();
  const vpc = new VpcStack(app, 'Vpc', { env });
  const efs = new EfsStack(app, 'Efs', { env, vpc: vpc.vpc });
  const ec2s = new Ec2SandboxStack(app, 'Ec2', { env, vpc: vpc.vpc });
  const ecr = new EcrStack(app, 'Ecr', { env });
  const ecs = new EcsClusterStack(app, 'Ecs', {
    env, vpc: vpc.vpc,
    efsFreellmapi: efs.freellmapiFs, efsAgent: efs.agentFs,
    efsApFreellmapi: efs.freellmapiAccessPoint, efsApAgent: efs.agentAccessPoint,
    sandboxSecurityGroup: ec2s.sandboxSg, sandboxPrivateIp: ec2s.sandboxPrivateIp,
    freellmapiRepo: ecr.freellmapiRepo, agentRepo: ecr.agentRepo,
  });
  const api = new ApiGatewayStack(app, 'Api', { env, vpc: vpc.vpc, freellmapiService: ecs.freellmapiService });
  const t = Template.fromStack(api);
  t.resourceCountIs('AWS::WAFv2::WebACL', 1);
  t.hasResourceProperties('AWS::WAFv2::WebACL', { Rules: Match.arrayWith([]) });
  t.resourceCountIs('AWS::Lambda::Function', 1);
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { Port: 3001 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra && npx jest test/apigw.test.ts`
Expected: FAIL — cannot find module `../lib/apigw-stack`.

- [ ] **Step 3: Write `infra/lib/apigw-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface ApiGatewayStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  freellmapiService: ecs.FargateService;
}

export class ApiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    // ---- Internal NLB ----
    const nlb = new elbv2.NetworkLoadBalancer(this, 'FreellmapiNlb', {
      vpc: props.vpc,
      internetFacing: false,
      crossZoneEnabled: true,
    });
    const targetGroup = new elbv2.NetworkTargetGroup(this, 'FreellmapiTg', {
      vpc: props.vpc,
      port: 3001,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { protocol: elbv2.Protocol.TCP, port: '3001' },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const listener = nlb.addListener('Listener', { port: 3001, defaultTargetGroups: [targetGroup] });
    props.freellmapiService.attachToNetworkTargetGroup(targetGroup);

    // LACUNA D: NLB has no SG; allow the VPC CIDR to reach the task on 3001.
    props.freellmapiService.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(3001),
      'NLB -> FreeLLMAPI task',
    );

    // ---- VPC Link + Lambda authorizer ----
    const vpcLink = new apigwv2.VpcLink(this, 'HermesVpcLink', {
      vpc: props.vpc,
      vpcLinkName: 'hermes-vpc-link',
    });
    const authorizerFn = new lambda.Function(this, 'TokenAuthorizer', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/authorizer'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      reservedConcurrentExecutions: 50,
      environment: { FREELLMAPI_INTERNAL_URL: `http://${nlb.loadBalancerDnsName}` },
    });
    const authorizer = new authorizers.HttpLambdaAuthorizer('HermesAuthorizer', authorizerFn, {
      authorizerName: 'hermes-token-introspection',
      responseTypes: [authorizers.HttpLambdaResponseType.IAM],
      resultsCacheTtl: cdk.Duration.seconds(3600),
      identitySource: ['$request.header.Authorization'],
    });

    // ---- HTTP API ----
    const httpApi = new apigwv2.HttpApi(this, 'HermesApi', {
      apiName: 'hermes-freellmapi',
      description: 'Public API Gateway for FreeLLMAPI (OpenAI-compatible)',
    });
    httpApi.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpNlbIntegration('NlbIntegration', listener, { vpcLink }),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/api/ping', // upstream FreeLLMAPI health path; public, no authorizer
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpNlbIntegration('HealthIntegration', listener, { vpcLink }),
    });

    // ---- WAF ----
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true,
    });
    const webAcl = new wafv2.CfnWebACL(this, 'HermesWaf', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      name: 'hermes-api-waf',
      visibilityConfig: visibility('hermes-waf-metrics'),
      rules: [
        {
          name: 'RateLimitPerIP', priority: 1, action: { block: {} },
          statement: { rateBasedStatement: { limit: 100, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
          visibilityConfig: visibility('rate-limit'),
        },
        {
          name: 'AWSBotControl', priority: 2, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesBotControlRuleSet' } },
          visibilityConfig: visibility('bot-control'),
        },
        {
          name: 'AWSIPReputation', priority: 3, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
          visibilityConfig: visibility('ip-reputation'),
        },
        {
          name: 'BodySizeLimit', priority: 4, action: { block: {} },
          statement: {
            sizeConstraintStatement: {
              fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
              comparisonOperator: 'GT', size: 262144,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          visibilityConfig: visibility('body-size'),
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/apis/${httpApi.apiId}/stages/$default`,
      webAclArn: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.url!, description: 'Public API Gateway endpoint' });
    new cdk.CfnOutput(this, 'NlbDns', { value: nlb.loadBalancerDnsName, description: 'Internal NLB DNS (debug only)' });
  }
}
```

- [ ] **Step 4: Wire into `infra/bin/hermes-app.ts` (final composition)**

The complete file must read:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';
import { Ec2SandboxStack } from '../lib/ec2-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsClusterStack } from '../lib/ecs-stack';
import { ApiGatewayStack } from '../lib/apigw-stack';

const app = new cdk.App();
const env = { region: 'eu-central-1' };

const vpc = new VpcStack(app, 'HermesVpcStack', { env });
const efs = new EfsStack(app, 'HermesEfsStack', { env, vpc: vpc.vpc });
const ec2Sandbox = new Ec2SandboxStack(app, 'HermesEc2Stack', { env, vpc: vpc.vpc });
const ecr = new EcrStack(app, 'HermesEcrStack', { env });
const ecs = new EcsClusterStack(app, 'HermesEcsStack', {
  env,
  vpc: vpc.vpc,
  efsFreellmapi: efs.freellmapiFs,
  efsAgent: efs.agentFs,
  efsApFreellmapi: efs.freellmapiAccessPoint,
  efsApAgent: efs.agentAccessPoint,
  sandboxSecurityGroup: ec2Sandbox.sandboxSg,
  sandboxPrivateIp: ec2Sandbox.sandboxPrivateIp,
  freellmapiRepo: ecr.freellmapiRepo,
  agentRepo: ecr.agentRepo,
});
new ApiGatewayStack(app, 'HermesApiGatewayStack', {
  env,
  vpc: vpc.vpc,
  freellmapiService: ecs.freellmapiService,
});

app.synth();
```

- [ ] **Step 5: Run full test suite + synth all**

Run: `cd infra && npm test && npx cdk synth --all`
Expected: all Jest tests PASS, authorizer node:test PASS, `cdk synth --all` exits 0 for all six stacks.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/apigw-stack.ts infra/test/apigw.test.ts infra/bin/hermes-app.ts
git commit -m "feat(infra): add ApiGatewayStack (NLB, VPC Link, authorizer, WAF)"
```

---

### Task 9: Service Dockerfiles (mirror upstream)

**Files:**
- Create: `services/freellmapi/Dockerfile`
- Create: `services/freellmapi/README.md`
- Create: `services/hermes-agent/Dockerfile`
- Create: `services/hermes-agent/README.md`

**Interfaces:** none (build inputs for the service workflows in Task 10).

- [ ] **Step 1: Create `services/freellmapi/Dockerfile`**

```dockerfile
# Mirror of the upstream FreeLLMAPI image, re-published to our ECR.
# Upstream: https://github.com/tashfeenahmed/freellmapi
# Pin @sha256 digest at execution time: `docker buildx imagetools inspect ghcr.io/tashfeenahmed/freellmapi:latest`
FROM ghcr.io/tashfeenahmed/freellmapi:latest
```

- [ ] **Step 2: Create `services/freellmapi/README.md`**

```markdown
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
```

- [ ] **Step 3: Create `services/hermes-agent/Dockerfile`**

```dockerfile
# Mirror of the upstream Hermes-Agent image, re-published to our ECR.
# Upstream: https://github.com/NousResearch/hermes-agent
# NOTE: confirm the published registry/tag (Docker Hub `nousresearch/hermes-agent`
# vs GHCR) and pin @sha256 before the first production push.
FROM ghcr.io/nousresearch/hermes-agent:latest
```

- [ ] **Step 4: Create `services/hermes-agent/README.md`**

```markdown
# hermes-agent (mirror)

Re-publishes the upstream Hermes-Agent image to our ECR repo `hermes-agent`.

- Upstream: https://github.com/NousResearch/hermes-agent
- Runtime facts: `USER hermes` (UID **10000**, remap via `HERMES_UID`),
  `HERMES_HOME=/opt/data` (EFS mount), entrypoint is s6-overlay `/init` (do not override),
  `docker-cli` present so `DOCKER_HOST` targets the EC2 sandbox.
- WhatsApp uses **Baileys** (QR). Session persists under `/opt/data/platforms/whatsapp/session`
  on EFS. Bootstrap once via ECS Exec (see root README).

Confirm the published image ref and pin `@sha256` before the first production push.
```

- [ ] **Step 5: Verify Dockerfiles parse**

Run:
```bash
grep -l '^FROM ' services/freellmapi/Dockerfile services/hermes-agent/Dockerfile
```
Expected: both paths printed (each has a valid `FROM`). (Full `docker build` is deferred to deploy — it needs registry access.)

- [ ] **Step 6: Commit**

```bash
git add services/
git commit -m "feat(services): add mirror Dockerfiles for freellmapi and hermes-agent"
```

---

### Task 10: Deploy workflows (3 path-filtered pipelines)

**Files:**
- Create: `.github/workflows/deploy-freellmapi.yml`
- Create: `.github/workflows/deploy-hermes-agent.yml`
- Create: `.github/workflows/deploy-infra.yml`

**Interfaces:** consume GitHub Secret `AWS_ACCOUNT_ID`; assume role `GitHubActionsDeployRole` (Task 11).

- [ ] **Step 1: Create `.github/workflows/deploy-freellmapi.yml`**

```yaml
name: 'Deploy FreeLLMAPI Image'
on:
  push:
    branches: [ "main" ]
    paths: [ "services/freellmapi/**" ]
  workflow_dispatch:
permissions:
  id-token: write
  contents: read
env:
  AWS_REGION: eu-central-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.eu-central-1.amazonaws.com
  REPO: freellmapi
  SERVICE: FreellmapiService
jobs:
  mirror-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS Credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/GitHubActionsDeployRole
          aws-region: ${{ env.AWS_REGION }}
      - name: Login to Amazon ECR
        run: aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
      - name: Build (mirror) & push
        run: |
          IMAGE=$ECR_REGISTRY/$REPO
          docker build -t $IMAGE:${{ github.sha }} -t $IMAGE:latest ./services/freellmapi
          docker push $IMAGE --all-tags
      - name: Force ECS redeploy
        run: aws ecs update-service --cluster hermes-cluster --service $SERVICE --force-new-deployment --region $AWS_REGION
```

- [ ] **Step 2: Create `.github/workflows/deploy-hermes-agent.yml`**

```yaml
name: 'Deploy Hermes-Agent Image'
on:
  push:
    branches: [ "main" ]
    paths: [ "services/hermes-agent/**" ]
  workflow_dispatch:
permissions:
  id-token: write
  contents: read
env:
  AWS_REGION: eu-central-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.eu-central-1.amazonaws.com
  REPO: hermes-agent
  SERVICE: AgentService
jobs:
  mirror-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS Credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/GitHubActionsDeployRole
          aws-region: ${{ env.AWS_REGION }}
      - name: Login to Amazon ECR
        run: aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
      - name: Build (mirror) & push
        run: |
          IMAGE=$ECR_REGISTRY/$REPO
          docker build -t $IMAGE:${{ github.sha }} -t $IMAGE:latest ./services/hermes-agent
          docker push $IMAGE --all-tags
      - name: Force ECS redeploy
        run: aws ecs update-service --cluster hermes-cluster --service $SERVICE --force-new-deployment --region $AWS_REGION
```

Note: `FreellmapiService` / `AgentService` are the ECS service names CloudFormation derives from the construct ids. Confirm the exact service names from the first `cdk deploy` (CfnOutput or console) and update the `SERVICE` env if they differ.

- [ ] **Step 3: Create `.github/workflows/deploy-infra.yml`**

```yaml
name: 'Deploy Infra (CDK)'
on:
  push:
    branches: [ "main" ]
    paths: [ "infra/**" ]
  workflow_dispatch:
permissions:
  id-token: write
  contents: read
env:
  AWS_REGION: eu-central-1
jobs:
  cdk-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: infra/package-lock.json
      - name: Configure AWS Credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/GitHubActionsDeployRole
          aws-region: ${{ env.AWS_REGION }}
      - name: Install deps
        working-directory: infra
        run: npm ci
      - name: CDK Diff (audit trail)
        working-directory: infra
        run: npx cdk diff --all 2>&1 || true
      - name: CDK Deploy
        working-directory: infra
        run: npx cdk deploy --all --require-approval never --outputs-file cdk-outputs.json
      - name: Upload CDK outputs
        uses: actions/upload-artifact@v4
        with:
          name: cdk-outputs
          path: infra/cdk-outputs.json
          retention-days: 30
```

- [ ] **Step 4: Verify all three parse as YAML**

Run:
```bash
python -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]; print('ok')"
```
Expected: prints `ok` (no YAML errors).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "ci: add per-target deploy workflows (freellmapi, hermes-agent, infra)"
```

---

### Task 11: OIDC CloudFormation template

**Files:**
- Create: `github-oidc-setup.yml`

**Interfaces:** none (bootstrap infra deployed once, out of band).

- [ ] **Step 1: Create `github-oidc-setup.yml`**

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: 'OIDC Identity Provider para GitHub Actions - Projeto Hermes'
Resources:
  GitHubOidcProvider:
    Type: AWS::IAM::OIDCProvider
    Properties:
      Url: https://token.actions.githubusercontent.com
      ClientIdList:
        - sts.amazonaws.com
      ThumbprintList:
        - 1c58a3a8518e8759bf075b76b750d4f2df264fcd
        - 6938fd4d98bab03faadb97b34396831e3780aea1
  GitHubActionsDeployRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: GitHubActionsDeployRole
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Action: sts:AssumeRoleWithWebIdentity
            Principal:
              Federated: !Ref GitHubOidcProvider
            Condition:
              StringEquals:
                token.actions.githubusercontent.com:aud: sts.amazonaws.com
              StringLike:
                token.actions.githubusercontent.com:sub:
                  - repo:melkyfb/hermes-platform-infra:ref:refs/heads/main
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AdministratorAccess
Outputs:
  RoleArn:
    Description: 'ARN da Role para os workflows do GitHub Actions'
    Value: !GetAtt GitHubActionsDeployRole.Arn
```

- [ ] **Step 2: Verify YAML parses**

Run: `python -c "import yaml; yaml.safe_load(open('github-oidc-setup.yml')); print('ok')"`
Expected: prints `ok`. (Note: CloudFormation `!Ref`/`!GetAtt` are custom tags — if `safe_load` errors on them, instead run `grep -c 'AWS::IAM' github-oidc-setup.yml` and confirm it prints `2`.)

- [ ] **Step 3: Commit**

```bash
git add github-oidc-setup.yml
git commit -m "feat(oidc): add GitHub Actions OIDC trust CloudFormation template"
```

---

### Task 12: Root README

**Files:**
- Create: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Create `README.md`**

````markdown
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
````

- [ ] **Step 2: Verify it renders (headings present)**

Run: `grep -c '^#' README.md`
Expected: a positive count (≥ 6 headings).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add root README (deploy order, secrets, WhatsApp bootstrap, hardening)"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** Vpc/Efs/Ec2/Ecr/Ecs/ApiGw stacks (§4) → Tasks 2–8; the 5 gap fixes (§3/§4: EcrStack, sandbox ingress 2375, freellmapi ingress 3001, image-order + secrets docs) → Tasks 5, 7, 8, 12; authorizer via `/v1/models` (§4.6) → Task 6; mirror Dockerfiles (§5) → Task 9; three workflows (§6) → Task 10; OIDC (§4/§6) → Task 11; verification (§7) → every task + Task 8 full-suite gate.

**Placeholder scan:** No TBD/TODO in executable steps. The two `FROM :latest` lines and ECS service-name note are real, runnable values flagged for digest/name pinning at deploy — not plan gaps.

**Type consistency:** Prop names (`efsFreellmapi`, `efsApAgent`, `sandboxSecurityGroup`, `sandboxPrivateIp`, `freellmapiRepo`, `agentRepo`, `freellmapiService`) are identical across Tasks 3–8 definitions, the `bin` wiring, and the tests. Public readonly fields (`vpc`, `freellmapiFs`, `agentFs`, `freellmapiAccessPoint`, `agentAccessPoint`, `sandboxSg`, `freellmapiRepo`, `agentRepo`, `freellmapiService`) match their consumers.
