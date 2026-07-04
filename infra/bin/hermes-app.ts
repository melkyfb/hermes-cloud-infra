#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';

const app = new cdk.App();
const env = { region: 'eu-central-1' };

const vpc = new VpcStack(app, 'HermesVpcStack', { env });

app.synth();
