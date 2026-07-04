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
