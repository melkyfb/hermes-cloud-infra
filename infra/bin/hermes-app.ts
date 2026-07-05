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

// EC2 sandbox (remote Docker host for the agent's code execution) is opt-out.
// Disable with `-c sandbox=false` — useful when the AWS account can't launch EC2.
const sandboxEnabled = app.node.tryGetContext('sandbox') !== 'false';

const vpc = new VpcStack(app, 'HermesVpcStack', { env });
const efs = new EfsStack(app, 'HermesEfsStack', { env, vpc: vpc.vpc });
const ec2Sandbox = sandboxEnabled
  ? new Ec2SandboxStack(app, 'HermesEc2Stack', { env, vpc: vpc.vpc })
  : undefined;
const ecr = new EcrStack(app, 'HermesEcrStack', { env });
const ecs = new EcsClusterStack(app, 'HermesEcsStack', {
  env,
  vpc: vpc.vpc,
  efsFreellmapi: efs.freellmapiFs,
  efsAgent: efs.agentFs,
  efsApFreellmapi: efs.freellmapiAccessPoint,
  efsApAgent: efs.agentAccessPoint,
  sandboxSecurityGroup: ec2Sandbox?.sandboxSg,
  sandboxPrivateIp: ec2Sandbox?.sandboxPrivateIp,
  freellmapiRepo: ecr.freellmapiRepo,
  agentRepo: ecr.agentRepo,
});
new ApiGatewayStack(app, 'HermesApiGatewayStack', {
  env,
  vpc: vpc.vpc,
  freellmapiService: ecs.freellmapiService,
});

app.synth();
