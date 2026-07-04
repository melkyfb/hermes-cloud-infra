import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface ApiGatewayStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  freellmapiService: ecs.FargateService;
}

export class ApiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    // ---- Internal NLB ----
    const nlb = new elbv2.NetworkLoadBalancer(this, 'FreellmapiNlb', {
      vpc: props.vpc,
      internetFacing: false,
      crossZoneEnabled: true,
    });
    const targetGroup = new elbv2.NetworkTargetGroup(this, 'FreellmapiTg', {
      vpc: props.vpc,
      port: 3001,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { protocol: elbv2.Protocol.TCP, port: '3001' },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const listener = nlb.addListener('Listener', { port: 3001, defaultTargetGroups: [targetGroup] });
    props.freellmapiService.attachToNetworkTargetGroup(targetGroup);

    // LACUNA D: NLB has no SG; allow the VPC CIDR to reach the task on 3001.
    props.freellmapiService.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(3001),
      'NLB -> FreeLLMAPI task',
    );

    // ---- VPC Link + Lambda authorizer ----
    const vpcLink = new apigwv2.VpcLink(this, 'HermesVpcLink', {
      vpc: props.vpc,
      vpcLinkName: 'hermes-vpc-link',
    });
    const authorizerFn = new lambda.Function(this, 'TokenAuthorizer', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/authorizer'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      reservedConcurrentExecutions: 50,
      environment: { FREELLMAPI_INTERNAL_URL: `http://${nlb.loadBalancerDnsName}` },
    });
    const authorizer = new authorizers.HttpLambdaAuthorizer('HermesAuthorizer', authorizerFn, {
      authorizerName: 'hermes-token-introspection',
      responseTypes: [authorizers.HttpLambdaResponseType.IAM],
      resultsCacheTtl: cdk.Duration.seconds(3600),
      identitySource: ['$request.header.Authorization'],
    });

    // ---- HTTP API ----
    const httpApi = new apigwv2.HttpApi(this, 'HermesApi', {
      apiName: 'hermes-freellmapi',
      description: 'Public API Gateway for FreeLLMAPI (OpenAI-compatible)',
    });
    httpApi.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpNlbIntegration('NlbIntegration', listener, { vpcLink }),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/api/ping', // upstream FreeLLMAPI health path; public, no authorizer
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpNlbIntegration('HealthIntegration', listener, { vpcLink }),
    });

    // ---- WAF ----
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true,
    });
    const webAcl = new wafv2.CfnWebACL(this, 'HermesWaf', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      name: 'hermes-api-waf',
      visibilityConfig: visibility('hermes-waf-metrics'),
      rules: [
        {
          name: 'RateLimitPerIP', priority: 1, action: { block: {} },
          statement: { rateBasedStatement: { limit: 100, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
          visibilityConfig: visibility('rate-limit'),
        },
        {
          name: 'AWSBotControl', priority: 2, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesBotControlRuleSet' } },
          visibilityConfig: visibility('bot-control'),
        },
        {
          name: 'AWSIPReputation', priority: 3, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
          visibilityConfig: visibility('ip-reputation'),
        },
        {
          name: 'BodySizeLimit', priority: 4, action: { block: {} },
          statement: {
            sizeConstraintStatement: {
              fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
              comparisonOperator: 'GT', size: 262144,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          visibilityConfig: visibility('body-size'),
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/apis/${httpApi.apiId}/stages/$default`,
      webAclArn: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.url!, description: 'Public API Gateway endpoint' });
    new cdk.CfnOutput(this, 'NlbDns', { value: nlb.loadBalancerDnsName, description: 'Internal NLB DNS (debug only)' });
  }
}
