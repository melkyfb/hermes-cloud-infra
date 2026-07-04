import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface Ec2SandboxStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class Ec2SandboxStack extends cdk.Stack {
  public readonly sandboxSg: ec2.SecurityGroup;
  public readonly sandboxPrivateIp: string;

  constructor(scope: Construct, id: string, props: Ec2SandboxStackProps) {
    super(scope, id, props);

    this.sandboxSg = new ec2.SecurityGroup(this, 'SandboxSg', {
      vpc: props.vpc,
      securityGroupName: 'hermes-sandbox-sg',
      description: 'Allow Docker API access only from Hermes-Agent ECS tasks',
      allowAllOutbound: true,
    });
    // Ingress from the Agent SG (tcp 2375) is added in EcsClusterStack (Task 7).

    const instance = new ec2.Instance(this, 'SandboxHost', {
      vpc: props.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: this.sandboxSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    cdk.Tags.of(instance).add('Project', 'hermes');
    cdk.Tags.of(instance).add('Role', 'sandbox');

    instance.addUserData(
      'yum update -y',
      'yum install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      'mkdir -p /etc/systemd/system/docker.service.d',
      'cat > /etc/systemd/system/docker.service.d/override.conf << EOF',
      '[Service]',
      'ExecStart=',
      'ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375',
      'EOF',
      'systemctl daemon-reload',
      'systemctl restart docker',
    );

    this.sandboxPrivateIp = instance.instancePrivateIp;
    new cdk.CfnOutput(this, 'SandboxPrivateIp', {
      value: instance.instancePrivateIp,
      description: 'Private IP of the EC2 Sandbox (Docker Host)',
    });
  }
}
