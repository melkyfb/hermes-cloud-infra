import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  efsFreellmapi: efs.IFileSystem;
  efsAgent: efs.IFileSystem;
  efsApFreellmapi: efs.IAccessPoint;
  efsApAgent: efs.IAccessPoint;
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
      defaultCloudMapNamespace: {
        name: 'hermes.local',
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
        useForServiceConnect: true,
      },
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
      portMappings: [{ name: 'freellmapi', containerPort: 3001, protocol: ecs.Protocol.TCP }],
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
      serviceConnectConfiguration: {
        services: [{ portMappingName: 'freellmapi', dnsName: 'freellmapi', port: 3001 }],
      },
    });

    // In-VPC only: the agent (and later a Tailscale sidecar) reach FreeLLMAPI on 3001.
    this.freellmapiService.connections.allowFrom(
      ec2.Peer.ipv4('10.0.0.0/16'), // the VPC CIDR (see VpcStack) — literal so the ingress CidrIp is concrete
      ec2.Port.tcp(3001),
      'In-VPC access to FreeLLMAPI',
    );

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
      environment: {},
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

  }
}
