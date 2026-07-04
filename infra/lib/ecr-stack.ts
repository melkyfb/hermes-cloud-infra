import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export class EcrStack extends cdk.Stack {
  public readonly freellmapiRepo: ecr.Repository;
  public readonly agentRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const common = {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 30, description: 'Keep last 30 images' }],
    };

    this.freellmapiRepo = new ecr.Repository(this, 'FreellmapiRepo', {
      repositoryName: 'freellmapi',
      ...common,
    });
    this.agentRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'hermes-agent',
      ...common,
    });
  }
}
