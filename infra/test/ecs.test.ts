import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';
import { EcrStack } from '../lib/ecr-stack';
import { EcsClusterStack } from '../lib/ecs-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

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

test('EcsClusterStack: private Cloud Map namespace hermes.local exists', () => {
  const t = build();
  t.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: 'hermes.local' });
});

test('EcsClusterStack: freellmapi allows 3001 only from the VPC CIDR', () => {
  const t = build();
  t.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        FromPort: 3001, ToPort: 3001, IpProtocol: 'tcp', CidrIp: '10.0.0.0/16',
      }),
    ]),
  });
});
