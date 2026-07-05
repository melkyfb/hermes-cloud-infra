import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  efsFreellmapi: efs.IFileSystem;
  efsAgent: efs.IFileSystem;
  efsApFreellmapi: efs.IAccessPoint;
  efsApAgent: efs.IAccessPoint;
  sandboxSecurityGroup: ec2.ISecurityGroup;
  sandboxPrivateIp: string;
  freellmapiRepo: ecr.IRepository;
  agentRepo: ecr.IRepository;
}

export class EcsClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly freellmapiService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'HermesCluster', {
      vpc: props.vpc,
      clusterName: 'hermes-cluster',
      containerInsights: true,
    });

    const telegramSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'TelegramSecret', 'hermes/telegram-bot-token',
    );
    const freellmapiKeys = secretsmanager.Secret.fromSecretNameV2(
      this, 'FreellmapiKeys', 'hermes/freellmapi-keys',
    );

    // ---- FreeLLMAPI ----
    const freellmapiTask = new ecs.FargateTaskDefinition(this, 'FreellmapiTask', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    freellmapiTask.addVolume({
      name: 'efs-freellmapi',
      efsVolumeConfiguration: {
        fileSystemId: props.efsFreellmapi.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: props.efsApFreellmapi.accessPointId, iam: 'ENABLED' },
      },
    });
    const freellmapiContainer = freellmapiTask.addContainer('freellmapi', {
      image: ecs.ContainerImage.fromEcrRepository(props.freellmapiRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'freellmapi',
        logGroup: new logs.LogGroup(this, 'FreellmapiLogs', {
          logGroupName: '/ecs/hermes/freellmapi',
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3001',
        FREEAPI_DB_PATH: '/app/server/data/freeapi.db',
      },
      secrets: {
        FREEAPI_MASTER_KEY: ecs.Secret.fromSecretsManager(freellmapiKeys, 'FREEAPI_MASTER_KEY'),
        ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(freellmapiKeys, 'ENCRYPTION_KEY'),
      },
      portMappings: [{ containerPort: 3001, protocol: ecs.Protocol.TCP }],
    });
    freellmapiContainer.addMountPoints({
      containerPath: '/app/server/data',
      sourceVolume: 'efs-freellmapi',
      readOnly: false,
    });
    props.efsFreellmapi.grant(
      freellmapiTask.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    );

    this.freellmapiService = new ecs.FargateService(this, 'FreellmapiService', {
      cluster: this.cluster,
      serviceName: 'FreellmapiService', // fixed name so deploy-freellmapi.yml can target it
      taskDefinition: freellmapiTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
    });

    // ---- Hermes-Agent ----
    const agentTask = new ecs.FargateTaskDefinition(this, 'AgentTask', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    agentTask.addVolume({
      name: 'efs-agent',
      efsVolumeConfiguration: {
        fileSystemId: props.efsAgent.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: props.efsApAgent.accessPointId, iam: 'ENABLED' },
      },
    });
    const agentContainer = agentTask.addContainer('hermes-agent', {
      image: ecs.ContainerImage.fromEcrRepository(props.agentRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hermes-agent',
        logGroup: new logs.LogGroup(this, 'AgentLogs', {
          logGroupName: '/ecs/hermes/agent',
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        DOCKER_HOST: `tcp://${props.sandboxPrivateIp}:2375`,
      },
      secrets: {
        TELEGRAM_BOT_TOKEN: ecs.Secret.fromSecretsManager(telegramSecret),
        FREEAPI_DEFAULT_KEY: ecs.Secret.fromSecretsManager(freellmapiKeys, 'FREEAPI_DEFAULT_KEY'),
      },
    });
    agentContainer.addMountPoints({
      containerPath: '/opt/data',
      sourceVolume: 'efs-agent',
      readOnly: false,
    });
    props.efsAgent.grant(
      agentTask.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    );
    agentTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/Project': 'hermes' } },
    }));

    const agentService = new ecs.FargateService(this, 'AgentService', {
      cluster: this.cluster,
      serviceName: 'AgentService', // fixed name so deploy-hermes-agent.yml can target it
      taskDefinition: agentTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: true, // one-time WhatsApp QR bootstrap via ECS Exec
    });

    // LACUNA C: allow the Agent to reach the sandbox Docker daemon (tcp 2375).
    new ec2.CfnSecurityGroupIngress(this, 'SandboxIngressFromAgent', {
      groupId: props.sandboxSecurityGroup.securityGroupId,
      sourceSecurityGroupId: agentService.connections.securityGroups[0].securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 2375,
      toPort: 2375,
      description: 'Hermes-Agent -> sandbox Docker daemon',
    });
  }
}
