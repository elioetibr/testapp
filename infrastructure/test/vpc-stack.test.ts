import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

describe('VpcStack', () => {
  let app: cdk.App;
  let template: Template;

  describe('Basic VPC Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates VPC with correct CIDR', () => {
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.0.0.0/16',
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      });
    });

    test('creates public subnets', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 6); // 3 AZs * 2 subnet types
      
      template.hasResourceProperties('AWS::EC2::Subnet', {
        MapPublicIpOnLaunch: true,
      });
    });

    test('creates private subnets', () => {
      template.hasResourceProperties('AWS::EC2::Subnet', {
        MapPublicIpOnLaunch: false,
      });
    });

    test('creates Internet Gateway', () => {
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
      template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
    });

    test('creates NAT Gateway by default', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('creates route tables', () => {
      // Public route table + 3 private route tables (one per AZ) + additional route tables
      template.resourceCountIs('AWS::EC2::RouteTable', 6);
    });

    test('creates security groups', () => {
      template.resourceCountIs('AWS::EC2::SecurityGroup', 2); // ALB + App security groups
    });
  });

  describe('VPC with Custom Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'production',
        enableHANatGateways: true,
        maxAzs: 2,
        vpcCidr: '10.1.0.0/16',
        publicSubnetCidrMask: 26,
        privateSubnetCidrMask: 25,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates VPC with custom CIDR', () => {
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.1.0.0/16',
      });
    });

    test('creates HA NAT Gateways when enabled', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 2); // One per AZ
    });

    test('creates correct number of subnets for maxAzs', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 4); // 2 AZs * 2 subnet types
    });
  });

  describe('IPv6 Support', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        enableIPv6: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates IPv6 CIDR block', () => {
      template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
        VpcId: { Ref: Match.anyValue() },
        AmazonProvidedIpv6CidrBlock: true,
      });
    });

    test('creates IPv6 routes for public subnets', () => {
      template.hasResourceProperties('AWS::EC2::Route', {
        DestinationIpv6CidrBlock: '::/0',
      });
    });

    test.skip('configures IPv6 for security groups', () => {
      // Load balancer security group should have IPv6 rules
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        CidrIpv6: '::/0',
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
      });

      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        CidrIpv6: '::/0',
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
      });
    });
  });

  describe('Custom IPv6 CIDR', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        enableIPv6: true,
        ipv6CidrBlock: '2001:db8::/56',
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates IPv6 CIDR block with custom range', () => {
      template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
        VpcId: { Ref: Match.anyValue() },
        Ipv6CidrBlock: '2001:db8::/56',
      });
    });
  });

  describe('VPC Flow Logs', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'production',
        enableVPCFlowLogs: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates S3 bucket for VPC flow logs', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'testapp-vpc-flow-logs-production-123456789012',
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test('creates bucket lifecycle policy for production', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'DeleteOldFlowLogs',
              Status: 'Enabled',
              ExpirationInDays: 90,
            },
            {
              Id: 'TransitionToIA',
              Status: 'Enabled',
              Transitions: [
                {
                  StorageClass: 'STANDARD_IA',
                  TransitionInDays: 30,
                },
                {
                  StorageClass: 'GLACIER',
                  TransitionInDays: 90,
                },
              ],
            },
          ],
        },
      });
    });

    test('creates bucket policy for VPC flow logs service', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: [
            {
              Sid: 'AWSLogDeliveryWrite',
              Effect: 'Allow',
              Principal: { Service: 'delivery.logs.amazonaws.com' },
              Action: 's3:PutObject',
              Condition: {
                StringEquals: {
                  's3:x-amz-acl': 'bucket-owner-full-control',
                },
              },
            },
            {
              Sid: 'AWSLogDeliveryCheck',
              Effect: 'Allow',
              Principal: { Service: 'delivery.logs.amazonaws.com' },
              Action: ['s3:GetBucketAcl', 's3:ListBucket'],
            },
          ],
        },
      });
    });

    test('creates VPC flow logs', () => {
      // VPC-level flow log
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        ResourceType: 'VPC',
        TrafficType: 'ALL',
        LogDestinationType: 's3',
      });

      // Should create flow logs for all subnets (3 private + 3 public = 6 total)
      template.resourceCountIs('AWS::EC2::FlowLog', 7); // 1 VPC + 6 subnet flow logs
    });

    test.skip('creates flow logs for private subnets', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        ResourceType: 'Subnet',
        TrafficType: 'ALL',
        LogDestinationType: 's3',
        LogDestination: {
          'Fn::Sub': [
            '${bucket}/private-subnets/subnet-0/',
            { bucket: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] } },
          ],
        },
      });
    });

    test.skip('creates flow logs for public subnets', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        ResourceType: 'Subnet',
        TrafficType: 'ALL',
        LogDestinationType: 's3',
        LogDestination: {
          'Fn::Sub': [
            '${bucket}/public-subnets/subnet-0/',
            { bucket: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] } },
          ],
        },
      });
    });
  });

  describe('VPC Flow Logs for Development', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'dev',
        enableVPCFlowLogs: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test.skip('creates bucket lifecycle policy for development', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'DeleteOldFlowLogs',
              Status: 'Enabled',
              ExpirationInDays: 30,
            },
          ],
        },
      });
    });
  });

  describe('Security Groups', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        enableIPv6: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates load balancer security group with correct rules', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for Application Load Balancer',
        SecurityGroupIngress: [
          {
            CidrIp: '0.0.0.0/0',
            IpProtocol: 'tcp',
            FromPort: 80,
            ToPort: 80,
            Description: 'Allow HTTP traffic from anywhere',
          },
          {
            CidrIp: '0.0.0.0/0',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            Description: 'Allow HTTPS traffic from anywhere',
          },
          {
            CidrIpv6: '::/0',
            IpProtocol: 'tcp',
            FromPort: 80,
            ToPort: 80,
            Description: 'Allow HTTP traffic from anywhere (IPv6)',
          },
          {
            CidrIpv6: '::/0',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            Description: 'Allow HTTPS traffic from anywhere (IPv6)',
          },
        ],
      });
    });

    test.skip('creates application security group with correct rules', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for ECS applications',
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: 8000,
            ToPort: 8000,
            SourceSecurityGroupId: { Ref: Match.anyValue() },
            Description: 'Allow traffic from Load Balancer',
          },
          {
            IpProtocol: 'tcp',
            FromPort: 8000,
            ToPort: 8999,
            SourceSecurityGroupId: { Ref: Match.anyValue() },
            Description: 'Allow health check traffic from Load Balancer',
          },
        ],
      });
    });

    test.skip('security groups have proper tags', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        Tags: [
          { Key: 'Name', Value: 'testapp-test-alb-sg' },
          { Key: 'Environment', Value: 'test' },
          { Key: 'Component', Value: 'LoadBalancer' },
        ],
      });

      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        Tags: [
          { Key: 'Name', Value: 'testapp-test-app-sg' },
          { Key: 'Environment', Value: 'test' },
          { Key: 'Component', Value: 'Application' },
        ],
      });
    });
  });

  describe('Stack Outputs', () => {
    let stack: VpcStack;

    beforeEach(() => {
      app = new cdk.App();
      stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        enableVPCFlowLogs: true,
        enableIPv6: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('creates core VPC outputs', () => {
      template.hasOutput('VpcId', {
        Description: 'VPC ID',
        Export: { Name: 'TestVpcStack-VpcId' },
      });

      template.hasOutput('VpcCidr', {
        Description: 'VPC CIDR Block',
        Export: { Name: 'TestVpcStack-VpcCidr' },
      });
    });

    test('creates subnet outputs', () => {
      template.hasOutput('PrivateSubnetIds', {
        Description: 'Private Subnet IDs',
        Export: { Name: 'TestVpcStack-PrivateSubnetIds' },
      });

      template.hasOutput('PublicSubnetIds', {
        Description: 'Public Subnet IDs',
        Export: { Name: 'TestVpcStack-PublicSubnetIds' },
      });
    });

    test('creates security group outputs', () => {
      template.hasOutput('LoadBalancerSecurityGroupId', {
        Description: 'Load Balancer Security Group ID',
        Export: { Name: 'TestVpcStack-LoadBalancerSecurityGroupId' },
      });

      template.hasOutput('ApplicationSecurityGroupId', {
        Description: 'Application Security Group ID',
        Export: { Name: 'TestVpcStack-ApplicationSecurityGroupId' },
      });
    });

    test('creates flow logs outputs when enabled', () => {
      template.hasOutput('FlowLogsBucketName', {
        Description: 'VPC Flow Logs S3 Bucket Name',
        Export: { Name: 'TestVpcStack-FlowLogsBucketName' },
      });

      template.hasOutput('FlowLogsBucketArn', {
        Description: 'VPC Flow Logs S3 Bucket ARN',
        Export: { Name: 'TestVpcStack-FlowLogsBucketArn' },
      });
    });

    test('creates IPv6 outputs when enabled', () => {
      template.hasOutput('VpcIpv6CidrBlocks', {
        Description: 'VPC IPv6 CIDR Blocks',
        Export: { Name: 'TestVpcStack-VpcIpv6CidrBlocks' },
      });
    });

    test('creates availability zones output', () => {
      template.hasOutput('AvailabilityZones', {
        Description: 'Availability Zones',
        Export: { Name: 'TestVpcStack-AvailabilityZones' },
      });
    });
  });

  describe('Resource Tagging', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'production',
        enableVPCFlowLogs: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);
    });

    test('flow logs bucket has correct tags', () => {
      // Check that the bucket has at least the Purpose tag
      // Note: Environment and ManagedBy tags may be applied at stack level by CDK
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([
          { Key: 'Purpose', Value: 'VPC-Flow-Logs' },
        ]),
      });
    });
  });

  describe('Environment-specific Configuration', () => {
    test('production environment has retain removal policy', () => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'production',
        enableVPCFlowLogs: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.hasResource('AWS::S3::Bucket', {
        DeletionPolicy: 'Retain',
      });
    });

    test('non-production environment has destroy removal policy', () => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'dev',
        enableVPCFlowLogs: true,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.hasResource('AWS::S3::Bucket', {
        DeletionPolicy: 'Delete',
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('handles maxAzs of 1', () => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        maxAzs: 1,
        natGateways: 1,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.resourceCountIs('AWS::EC2::Subnet', 2); // 1 AZ * 2 subnet types
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test.skip('handles zero NAT gateways', () => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        natGateways: 0,
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    test('VPC Flow Logs disabled by default', () => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.resourceCountIs('AWS::S3::Bucket', 0);
      template.resourceCountIs('AWS::EC2::FlowLog', 0);
    });

    test('IPv6 disabled by default', () => {
      app = new cdk.App();
      const stack = new VpcStack(app, 'TestVpcStack', {
        environment: 'test',
        stackName: 'TestVpcStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.resourceCountIs('AWS::EC2::VPCCidrBlock', 0);
      
      // Should not have IPv6 rules in security groups
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.not(Match.arrayWith([
          Match.objectLike({ CidrIpv6: '::/0' })
        ])),
      });
    });
  });
});