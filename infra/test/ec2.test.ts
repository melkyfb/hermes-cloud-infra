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
