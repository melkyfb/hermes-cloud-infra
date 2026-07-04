#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

const app = new cdk.App();
// @ts-ignore - env used by later tasks for Vpc, Efs, Ec2, Ecr, Ecs, ApiGateway stacks
const env = { region: 'eu-central-1' };

// Stacks are wired in by later tasks (Vpc → Efs → Ec2 → Ecr → Ecs → ApiGateway).
// Minimal placeholder stack removed when first real stack is added
new cdk.Stack(app, 'placeholder', { env });

app.synth();
