import * as cdk from 'aws-cdk-lib';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface EfsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class EfsStack extends cdk.Stack {
  public readonly freellmapiFs: efs.FileSystem;
  public readonly agentFs: efs.FileSystem;
  public readonly freellmapiAccessPoint: efs.AccessPoint;
  public readonly agentAccessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: EfsStackProps) {
    super(scope, id, props);

    this.freellmapiFs = new efs.FileSystem(this, 'FreellmapiEfs', {
      vpc: props.vpc,
      fileSystemName: 'freellmapi-server-data',
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.freellmapiAccessPoint = this.freellmapiFs.addAccessPoint('FreellmapiAp', {
      path: '/freellmapi',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
      posixUser: { uid: '1000', gid: '1000' },
    });

    this.agentFs = new efs.FileSystem(this, 'AgentEfs', {
      vpc: props.vpc,
      fileSystemName: 'hermes-agent-home',
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.agentAccessPoint = this.agentFs.addAccessPoint('AgentAp', {
      path: '/hermes-agent',
      createAcl: { ownerUid: '10000', ownerGid: '10000', permissions: '750' },
      posixUser: { uid: '10000', gid: '10000' },
    });
  }
}
