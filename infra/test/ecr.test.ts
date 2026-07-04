import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EcrStack } from '../lib/ecr-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('EcrStack: two repositories with scan-on-push', () => {
  const app = new App();
  const ecr = new EcrStack(app, 'Ecr', { env });
  const t = Template.fromStack(ecr);
  t.resourceCountIs('AWS::ECR::Repository', 2);
  t.hasResourceProperties('AWS::ECR::Repository', {
    ImageScanningConfiguration: { ScanOnPush: true },
  });
});
