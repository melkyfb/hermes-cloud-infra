#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';

const app = new cdk.App();
const env = { region: 'eu-central-1' };

const vpc = new VpcStack(app, 'HermesVpcStack', { env });
const efs = new EfsStack(app, 'HermesEfsStack', { env, vpc: vpc.vpc });

app.synth();
