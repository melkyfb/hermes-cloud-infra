import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EfsStack } from '../lib/efs-stack';

const env = { account: '111111111111', region: 'eu-central-1' };

test('EfsStack: two encrypted filesystems and two access points with correct POSIX ids', () => {
  const app = new App();
  const vpc = new VpcStack(app, 'Vpc', { env });
  const efs = new EfsStack(app, 'Efs', { env, vpc: vpc.vpc });
  const t = Template.fromStack(efs);
  t.resourceCountIs('AWS::EFS::FileSystem', 2);
  t.resourceCountIs('AWS::EFS::AccessPoint', 2);
  t.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
  t.hasResourceProperties('AWS::EFS::AccessPoint', { PosixUser: { Uid: '1000', Gid: '1000' } });
  t.hasResourceProperties('AWS::EFS::AccessPoint', { PosixUser: { Uid: '10000', Gid: '10000' } });
});
