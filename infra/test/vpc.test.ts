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
