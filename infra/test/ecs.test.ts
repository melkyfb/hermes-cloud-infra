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
