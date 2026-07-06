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
