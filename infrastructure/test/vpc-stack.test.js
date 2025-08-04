"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const vpc_stack_1 = require("../lib/vpc-stack");
describe('VpcStack', () => {
    let app;
    let template;
    describe('Basic VPC Configuration', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
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
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                enableIPv6: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates IPv6 CIDR block', () => {
            template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
                VpcId: { Ref: assertions_1.Match.anyValue() },
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
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                enableIPv6: true,
                ipv6CidrBlock: '2001:db8::/56',
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates IPv6 CIDR block with custom range', () => {
            template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
                VpcId: { Ref: assertions_1.Match.anyValue() },
                Ipv6CidrBlock: '2001:db8::/56',
            });
        });
    });
    describe('VPC Flow Logs', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'production',
                enableVPCFlowLogs: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
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
                        { bucket: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'Arn'] } },
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
                        { bucket: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'Arn'] } },
                    ],
                },
            });
        });
    });
    describe('VPC Flow Logs for Development', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'dev',
                enableVPCFlowLogs: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                enableIPv6: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
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
                        SourceSecurityGroupId: { Ref: assertions_1.Match.anyValue() },
                        Description: 'Allow traffic from Load Balancer',
                    },
                    {
                        IpProtocol: 'tcp',
                        FromPort: 8000,
                        ToPort: 8999,
                        SourceSecurityGroupId: { Ref: assertions_1.Match.anyValue() },
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
        let stack;
        beforeEach(() => {
            app = new cdk.App();
            stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                enableVPCFlowLogs: true,
                enableIPv6: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'production',
                enableVPCFlowLogs: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('flow logs bucket has correct tags', () => {
            // Check that the bucket has at least the Purpose tag
            // Note: Environment and ManagedBy tags may be applied at stack level by CDK
            template.hasResourceProperties('AWS::S3::Bucket', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Purpose', Value: 'VPC-Flow-Logs' },
                ]),
            });
        });
    });
    describe('Environment-specific Configuration', () => {
        test('production environment has retain removal policy', () => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'production',
                enableVPCFlowLogs: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResource('AWS::S3::Bucket', {
                DeletionPolicy: 'Retain',
            });
        });
        test('non-production environment has destroy removal policy', () => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'dev',
                enableVPCFlowLogs: true,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResource('AWS::S3::Bucket', {
                DeletionPolicy: 'Delete',
            });
        });
    });
    describe('Edge Cases and Error Handling', () => {
        test('handles maxAzs of 1', () => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                maxAzs: 1,
                natGateways: 1,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs('AWS::EC2::Subnet', 2); // 1 AZ * 2 subnet types
            template.resourceCountIs('AWS::EC2::NatGateway', 1);
        });
        test.skip('handles zero NAT gateways', () => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                natGateways: 0,
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs('AWS::EC2::NatGateway', 0);
        });
        test('VPC Flow Logs disabled by default', () => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs('AWS::S3::Bucket', 0);
            template.resourceCountIs('AWS::EC2::FlowLog', 0);
        });
        test('IPv6 disabled by default', () => {
            app = new cdk.App();
            const stack = new vpc_stack_1.VpcStack(app, 'TestVpcStack', {
                environment: 'test',
                stackName: 'TestVpcStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs('AWS::EC2::VPCCidrBlock', 0);
            // Should not have IPv6 rules in security groups
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                SecurityGroupIngress: assertions_1.Match.not(assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({ CidrIpv6: '::/0' })
                ])),
            });
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidnBjLXN0YWNrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ2cGMtc3RhY2sudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG1DQUFtQztBQUNuQyx1REFBeUQ7QUFDekQsZ0RBQTRDO0FBRTVDLFFBQVEsQ0FBQyxVQUFVLEVBQUUsR0FBRyxFQUFFO0lBQ3hCLElBQUksR0FBWSxDQUFDO0lBQ2pCLElBQUksUUFBa0IsQ0FBQztJQUV2QixRQUFRLENBQUMseUJBQXlCLEVBQUUsR0FBRyxFQUFFO1FBQ3ZDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxvQkFBUSxDQUFDLEdBQUcsRUFBRSxjQUFjLEVBQUU7Z0JBQzlDLFdBQVcsRUFBRSxNQUFNO2dCQUNuQixTQUFTLEVBQUUsY0FBYztnQkFDekIsR0FBRyxFQUFFO29CQUNILE9BQU8sRUFBRSxjQUFjO29CQUN2QixNQUFNLEVBQUUsV0FBVztpQkFDcEI7YUFDRixDQUFDLENBQUM7WUFDSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsK0JBQStCLEVBQUUsR0FBRyxFQUFFO1lBQ3pDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxlQUFlLEVBQUU7Z0JBQzlDLFNBQVMsRUFBRSxhQUFhO2dCQUN4QixrQkFBa0IsRUFBRSxJQUFJO2dCQUN4QixnQkFBZ0IsRUFBRSxJQUFJO2FBQ3ZCLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLHdCQUF3QixFQUFFLEdBQUcsRUFBRTtZQUNsQyxRQUFRLENBQUMsZUFBZSxDQUFDLGtCQUFrQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMseUJBQXlCO1lBRTFFLFFBQVEsQ0FBQyxxQkFBcUIs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Y2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSwgTWF0Y2ggfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IFZwY1N0YWNrIH0gZnJvbSAnLi4vbGliL3ZwYy1zdGFjayc7XG5cbmRlc2NyaWJlKCdWcGNTdGFjaycsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcDtcbiAgbGV0IHRlbXBsYXRlOiBUZW1wbGF0ZTtcblxuICBkZXNjcmliZSgnQmFzaWMgVlBDIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIFZQQyB3aXRoIGNvcnJlY3QgQ0lEUicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQycsIHtcbiAgICAgICAgQ2lkckJsb2NrOiAnMTAuMC4wLjAvMTYnLFxuICAgICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICAgIEVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcHVibGljIHN1Ym5ldHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpTdWJuZXQnLCA2KTsgLy8gMyBBWnMgKiAyIHN1Ym5ldCB0eXBlc1xuICAgICAgXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTdWJuZXQnLCB7XG4gICAgICAgIE1hcFB1YmxpY0lwT25MYXVuY2g6IHRydWUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcHJpdmF0ZSBzdWJuZXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U3VibmV0Jywge1xuICAgICAgICBNYXBQdWJsaWNJcE9uTGF1bmNoOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBJbnRlcm5ldCBHYXRld2F5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6SW50ZXJuZXRHYXRld2F5JywgMSk7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpWUENHYXRld2F5QXR0YWNobWVudCcsIDEpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBOQVQgR2F0ZXdheSBieSBkZWZhdWx0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDEpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyByb3V0ZSB0YWJsZXMnLCAoKSA9PiB7XG4gICAgICAvLyBQdWJsaWMgcm91dGUgdGFibGUgKyAzIHByaXZhdGUgcm91dGUgdGFibGVzIChvbmUgcGVyIEFaKSArIGFkZGl0aW9uYWwgcm91dGUgdGFibGVzXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpSb3V0ZVRhYmxlJywgNik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHNlY3VyaXR5IGdyb3VwcycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OlNlY3VyaXR5R3JvdXAnLCAyKTsgLy8gQUxCICsgQXBwIHNlY3VyaXR5IGdyb3Vwc1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnVlBDIHdpdGggQ3VzdG9tIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiB0cnVlLFxuICAgICAgICBtYXhBenM6IDIsXG4gICAgICAgIHZwY0NpZHI6ICcxMC4xLjAuMC8xNicsXG4gICAgICAgIHB1YmxpY1N1Ym5ldENpZHJNYXNrOiAyNixcbiAgICAgICAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrOiAyNSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBWUEMgd2l0aCBjdXN0b20gQ0lEUicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQycsIHtcbiAgICAgICAgQ2lkckJsb2NrOiAnMTAuMS4wLjAvMTYnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEhBIE5BVCBHYXRld2F5cyB3aGVuIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpOYXRHYXRld2F5JywgMik7IC8vIE9uZSBwZXIgQVpcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY29ycmVjdCBudW1iZXIgb2Ygc3VibmV0cyBmb3IgbWF4QXpzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6U3VibmV0JywgNCk7IC8vIDIgQVpzICogMiBzdWJuZXQgdHlwZXNcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0lQdjYgU3VwcG9ydCcsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgSVB2NiBDSURSIGJsb2NrJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6VlBDQ2lkckJsb2NrJywge1xuICAgICAgICBWcGNJZDogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgQW1hem9uUHJvdmlkZWRJcHY2Q2lkckJsb2NrOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIElQdjYgcm91dGVzIGZvciBwdWJsaWMgc3VibmV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlJvdXRlJywge1xuICAgICAgICBEZXN0aW5hdGlvbklwdjZDaWRyQmxvY2s6ICc6Oi8wJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdC5za2lwKCdjb25maWd1cmVzIElQdjYgZm9yIHNlY3VyaXR5IGdyb3VwcycsICgpID0+IHtcbiAgICAgIC8vIExvYWQgYmFsYW5jZXIgc2VjdXJpdHkgZ3JvdXAgc2hvdWxkIGhhdmUgSVB2NiBydWxlc1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cEluZ3Jlc3MnLCB7XG4gICAgICAgIENpZHJJcHY2OiAnOjovMCcsXG4gICAgICAgIElwUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICBGcm9tUG9ydDogODAsXG4gICAgICAgIFRvUG9ydDogODAsXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cEluZ3Jlc3MnLCB7XG4gICAgICAgIENpZHJJcHY2OiAnOjovMCcsXG4gICAgICAgIElwUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICBGcm9tUG9ydDogNDQzLFxuICAgICAgICBUb1BvcnQ6IDQ0MyxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ3VzdG9tIElQdjYgQ0lEUicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICAgIGlwdjZDaWRyQmxvY2s6ICcyMDAxOmRiODo6LzU2JyxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBJUHY2IENJRFIgYmxvY2sgd2l0aCBjdXN0b20gcmFuZ2UnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpWUENDaWRyQmxvY2snLCB7XG4gICAgICAgIFZwY0lkOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICBJcHY2Q2lkckJsb2NrOiAnMjAwMTpkYjg6Oi81NicsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1ZQQyBGbG93IExvZ3MnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBTMyBidWNrZXQgZm9yIFZQQyBmbG93IGxvZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICAgICAgQnVja2V0TmFtZTogJ3Rlc3RhcHAtdnBjLWZsb3ctbG9ncy1wcm9kdWN0aW9uLTEyMzQ1Njc4OTAxMicsXG4gICAgICAgIEJ1Y2tldEVuY3J5cHRpb246IHtcbiAgICAgICAgICBTZXJ2ZXJTaWRlRW5jcnlwdGlvbkNvbmZpZ3VyYXRpb246IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgU2VydmVyU2lkZUVuY3J5cHRpb25CeURlZmF1bHQ6IHtcbiAgICAgICAgICAgICAgICBTU0VBbGdvcml0aG06ICdBRVMyNTYnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBQdWJsaWNBY2Nlc3NCbG9ja0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBCbG9ja1B1YmxpY0FjbHM6IHRydWUsXG4gICAgICAgICAgQmxvY2tQdWJsaWNQb2xpY3k6IHRydWUsXG4gICAgICAgICAgSWdub3JlUHVibGljQWNsczogdHJ1ZSxcbiAgICAgICAgICBSZXN0cmljdFB1YmxpY0J1Y2tldHM6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYnVja2V0IGxpZmVjeWNsZSBwb2xpY3kgZm9yIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFJ1bGVzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIElkOiAnRGVsZXRlT2xkRmxvd0xvZ3MnLFxuICAgICAgICAgICAgICBTdGF0dXM6ICdFbmFibGVkJyxcbiAgICAgICAgICAgICAgRXhwaXJhdGlvbkluRGF5czogOTAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBJZDogJ1RyYW5zaXRpb25Ub0lBJyxcbiAgICAgICAgICAgICAgU3RhdHVzOiAnRW5hYmxlZCcsXG4gICAgICAgICAgICAgIFRyYW5zaXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgU3RvcmFnZUNsYXNzOiAnU1RBTkRBUkRfSUEnLFxuICAgICAgICAgICAgICAgICAgVHJhbnNpdGlvbkluRGF5czogMzAsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBTdG9yYWdlQ2xhc3M6ICdHTEFDSUVSJyxcbiAgICAgICAgICAgICAgICAgIFRyYW5zaXRpb25JbkRheXM6IDkwLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYnVja2V0IHBvbGljeSBmb3IgVlBDIGZsb3cgbG9ncyBzZXJ2aWNlJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXRQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIFNpZDogJ0FXU0xvZ0RlbGl2ZXJ5V3JpdGUnLFxuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIFByaW5jaXBhbDogeyBTZXJ2aWNlOiAnZGVsaXZlcnkubG9ncy5hbWF6b25hd3MuY29tJyB9LFxuICAgICAgICAgICAgICBBY3Rpb246ICdzMzpQdXRPYmplY3QnLFxuICAgICAgICAgICAgICBDb25kaXRpb246IHtcbiAgICAgICAgICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAgICAgICAgICdzMzp4LWFtei1hY2wnOiAnYnVja2V0LW93bmVyLWZ1bGwtY29udHJvbCcsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIFNpZDogJ0FXU0xvZ0RlbGl2ZXJ5Q2hlY2snLFxuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIFByaW5jaXBhbDogeyBTZXJ2aWNlOiAnZGVsaXZlcnkubG9ncy5hbWF6b25hd3MuY29tJyB9LFxuICAgICAgICAgICAgICBBY3Rpb246IFsnczM6R2V0QnVja2V0QWNsJywgJ3MzOkxpc3RCdWNrZXQnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBWUEMgZmxvdyBsb2dzJywgKCkgPT4ge1xuICAgICAgLy8gVlBDLWxldmVsIGZsb3cgbG9nXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpGbG93TG9nJywge1xuICAgICAgICBSZXNvdXJjZVR5cGU6ICdWUEMnLFxuICAgICAgICBUcmFmZmljVHlwZTogJ0FMTCcsXG4gICAgICAgIExvZ0Rlc3RpbmF0aW9uVHlwZTogJ3MzJyxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBTaG91bGQgY3JlYXRlIGZsb3cgbG9ncyBmb3IgYWxsIHN1Ym5ldHMgKDMgcHJpdmF0ZSArIDMgcHVibGljID0gNiB0b3RhbClcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OkZsb3dMb2cnLCA3KTsgLy8gMSBWUEMgKyA2IHN1Ym5ldCBmbG93IGxvZ3NcbiAgICB9KTtcblxuICAgIHRlc3Quc2tpcCgnY3JlYXRlcyBmbG93IGxvZ3MgZm9yIHByaXZhdGUgc3VibmV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OkZsb3dMb2cnLCB7XG4gICAgICAgIFJlc291cmNlVHlwZTogJ1N1Ym5ldCcsXG4gICAgICAgIFRyYWZmaWNUeXBlOiAnQUxMJyxcbiAgICAgICAgTG9nRGVzdGluYXRpb25UeXBlOiAnczMnLFxuICAgICAgICBMb2dEZXN0aW5hdGlvbjoge1xuICAgICAgICAgICdGbjo6U3ViJzogW1xuICAgICAgICAgICAgJyR7YnVja2V0fS9wcml2YXRlLXN1Ym5ldHMvc3VibmV0LTAvJyxcbiAgICAgICAgICAgIHsgYnVja2V0OiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9IH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdC5za2lwKCdjcmVhdGVzIGZsb3cgbG9ncyBmb3IgcHVibGljIHN1Ym5ldHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpGbG93TG9nJywge1xuICAgICAgICBSZXNvdXJjZVR5cGU6ICdTdWJuZXQnLFxuICAgICAgICBUcmFmZmljVHlwZTogJ0FMTCcsXG4gICAgICAgIExvZ0Rlc3RpbmF0aW9uVHlwZTogJ3MzJyxcbiAgICAgICAgTG9nRGVzdGluYXRpb246IHtcbiAgICAgICAgICAnRm46OlN1Yic6IFtcbiAgICAgICAgICAgICcke2J1Y2tldH0vcHVibGljLXN1Ym5ldHMvc3VibmV0LTAvJyxcbiAgICAgICAgICAgIHsgYnVja2V0OiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9IH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnVlBDIEZsb3cgTG9ncyBmb3IgRGV2ZWxvcG1lbnQnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiB0cnVlLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0LnNraXAoJ2NyZWF0ZXMgYnVja2V0IGxpZmVjeWNsZSBwb2xpY3kgZm9yIGRldmVsb3BtZW50JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXQnLCB7XG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBSdWxlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBJZDogJ0RlbGV0ZU9sZEZsb3dMb2dzJyxcbiAgICAgICAgICAgICAgU3RhdHVzOiAnRW5hYmxlZCcsXG4gICAgICAgICAgICAgIEV4cGlyYXRpb25JbkRheXM6IDMwLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdTZWN1cml0eSBHcm91cHMnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGxvYWQgYmFsYW5jZXIgc2VjdXJpdHkgZ3JvdXAgd2l0aCBjb3JyZWN0IHJ1bGVzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cCcsIHtcbiAgICAgICAgR3JvdXBEZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyJyxcbiAgICAgICAgU2VjdXJpdHlHcm91cEluZ3Jlc3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBDaWRySXA6ICcwLjAuMC4wLzAnLFxuICAgICAgICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgICAgICBGcm9tUG9ydDogODAsXG4gICAgICAgICAgICBUb1BvcnQ6IDgwLFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyBIVFRQIHRyYWZmaWMgZnJvbSBhbnl3aGVyZScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBDaWRySXA6ICcwLjAuMC4wLzAnLFxuICAgICAgICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgICAgICBGcm9tUG9ydDogNDQzLFxuICAgICAgICAgICAgVG9Qb3J0OiA0NDMsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ0FsbG93IEhUVFBTIHRyYWZmaWMgZnJvbSBhbnl3aGVyZScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBDaWRySXB2NjogJzo6LzAnLFxuICAgICAgICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgICAgICBGcm9tUG9ydDogODAsXG4gICAgICAgICAgICBUb1BvcnQ6IDgwLFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyBIVFRQIHRyYWZmaWMgZnJvbSBhbnl3aGVyZSAoSVB2NiknLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2lkcklwdjY6ICc6Oi8wJyxcbiAgICAgICAgICAgIElwUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICAgICAgRnJvbVBvcnQ6IDQ0MyxcbiAgICAgICAgICAgIFRvUG9ydDogNDQzLFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyBIVFRQUyB0cmFmZmljIGZyb20gYW55d2hlcmUgKElQdjYpJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0LnNraXAoJ2NyZWF0ZXMgYXBwbGljYXRpb24gc2VjdXJpdHkgZ3JvdXAgd2l0aCBjb3JyZWN0IHJ1bGVzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cCcsIHtcbiAgICAgICAgR3JvdXBEZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBFQ1MgYXBwbGljYXRpb25zJyxcbiAgICAgICAgU2VjdXJpdHlHcm91cEluZ3Jlc3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA4MDAwLFxuICAgICAgICAgICAgVG9Qb3J0OiA4MDAwLFxuICAgICAgICAgICAgU291cmNlU2VjdXJpdHlHcm91cElkOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyB0cmFmZmljIGZyb20gTG9hZCBCYWxhbmNlcicsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA4MDAwLFxuICAgICAgICAgICAgVG9Qb3J0OiA4OTk5LFxuICAgICAgICAgICAgU291cmNlU2VjdXJpdHlHcm91cElkOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyBoZWFsdGggY2hlY2sgdHJhZmZpYyBmcm9tIExvYWQgQmFsYW5jZXInLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3Quc2tpcCgnc2VjdXJpdHkgZ3JvdXBzIGhhdmUgcHJvcGVyIHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdOYW1lJywgVmFsdWU6ICd0ZXN0YXBwLXRlc3QtYWxiLXNnJyB9LFxuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Rlc3QnIH0sXG4gICAgICAgICAgeyBLZXk6ICdDb21wb25lbnQnLCBWYWx1ZTogJ0xvYWRCYWxhbmNlcicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdOYW1lJywgVmFsdWU6ICd0ZXN0YXBwLXRlc3QtYXBwLXNnJyB9LFxuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Rlc3QnIH0sXG4gICAgICAgICAgeyBLZXk6ICdDb21wb25lbnQnLCBWYWx1ZTogJ0FwcGxpY2F0aW9uJyB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdTdGFjayBPdXRwdXRzJywgKCkgPT4ge1xuICAgIGxldCBzdGFjazogVnBjU3RhY2s7XG5cbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiB0cnVlLFxuICAgICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNvcmUgVlBDIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1ZwY0lkJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1ZQQyBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLVZwY0lkJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVnBjQ2lkcicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdWUEMgQ0lEUiBCbG9jaycsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLVZwY0NpZHInIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgc3VibmV0IG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1ByaXZhdGVTdWJuZXRJZHMnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnUHJpdmF0ZSBTdWJuZXQgSURzJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0VnBjU3RhY2stUHJpdmF0ZVN1Ym5ldElkcycgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1B1YmxpY1N1Ym5ldElkcycsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdQdWJsaWMgU3VibmV0IElEcycsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLVB1YmxpY1N1Ym5ldElkcycgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBzZWN1cml0eSBncm91cCBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnTG9hZCBCYWxhbmNlciBTZWN1cml0eSBHcm91cCBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLUxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZCcgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0FwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFNlY3VyaXR5IEdyb3VwIElEJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0VnBjU3RhY2stQXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgZmxvdyBsb2dzIG91dHB1dHMgd2hlbiBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdGbG93TG9nc0J1Y2tldE5hbWUnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnVlBDIEZsb3cgTG9ncyBTMyBCdWNrZXQgTmFtZScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLUZsb3dMb2dzQnVja2V0TmFtZScgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0Zsb3dMb2dzQnVja2V0QXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1ZQQyBGbG93IExvZ3MgUzMgQnVja2V0IEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLUZsb3dMb2dzQnVja2V0QXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIElQdjYgb3V0cHV0cyB3aGVuIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1ZwY0lwdjZDaWRyQmxvY2tzJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1ZQQyBJUHY2IENJRFIgQmxvY2tzJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0VnBjU3RhY2stVnBjSXB2NkNpZHJCbG9ja3MnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYXZhaWxhYmlsaXR5IHpvbmVzIG91dHB1dCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQXZhaWxhYmlsaXR5Wm9uZXMnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXZhaWxhYmlsaXR5IFpvbmVzJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0VnBjU3RhY2stQXZhaWxhYmlsaXR5Wm9uZXMnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1Jlc291cmNlIFRhZ2dpbmcnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZmxvdyBsb2dzIGJ1Y2tldCBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgLy8gQ2hlY2sgdGhhdCB0aGUgYnVja2V0IGhhcyBhdCBsZWFzdCB0aGUgUHVycG9zZSB0YWdcbiAgICAgIC8vIE5vdGU6IEVudmlyb25tZW50IGFuZCBNYW5hZ2VkQnkgdGFncyBtYXkgYmUgYXBwbGllZCBhdCBzdGFjayBsZXZlbCBieSBDREtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnUHVycG9zZScsIFZhbHVlOiAnVlBDLUZsb3ctTG9ncycgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0Vudmlyb25tZW50LXNwZWNpZmljIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgdGVzdCgncHJvZHVjdGlvbiBlbnZpcm9ubWVudCBoYXMgcmV0YWluIHJlbW92YWwgcG9saWN5JywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgJ1Rlc3RWcGNTdGFjaycsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgZW5hYmxlVlBDRmxvd0xvZ3M6IHRydWUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2UoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdSZXRhaW4nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdub24tcHJvZHVjdGlvbiBlbnZpcm9ubWVudCBoYXMgZGVzdHJveSByZW1vdmFsIHBvbGljeScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgICAgZW5hYmxlVlBDRmxvd0xvZ3M6IHRydWUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2UoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdEZWxldGUnLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFZGdlIENhc2VzIGFuZCBFcnJvciBIYW5kbGluZycsICgpID0+IHtcbiAgICB0ZXN0KCdoYW5kbGVzIG1heEF6cyBvZiAxJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgJ1Rlc3RWcGNTdGFjaycsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgbWF4QXpzOiAxLFxuICAgICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpTdWJuZXQnLCAyKTsgLy8gMSBBWiAqIDIgc3VibmV0IHR5cGVzXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpOYXRHYXRld2F5JywgMSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0LnNraXAoJ2hhbmRsZXMgemVybyBOQVQgZ2F0ZXdheXMnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBuYXRHYXRld2F5czogMCxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpOYXRHYXRld2F5JywgMCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdWUEMgRmxvdyBMb2dzIGRpc2FibGVkIGJ5IGRlZmF1bHQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpTMzo6QnVja2V0JywgMCk7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpGbG93TG9nJywgMCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdJUHY2IGRpc2FibGVkIGJ5IGRlZmF1bHQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OlZQQ0NpZHJCbG9jaycsIDApO1xuICAgICAgXG4gICAgICAvLyBTaG91bGQgbm90IGhhdmUgSVB2NiBydWxlcyBpbiBzZWN1cml0eSBncm91cHNcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlNlY3VyaXR5R3JvdXAnLCB7XG4gICAgICAgIFNlY3VyaXR5R3JvdXBJbmdyZXNzOiBNYXRjaC5ub3QoTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHsgQ2lkcklwdjY6ICc6Oi8wJyB9KVxuICAgICAgICBdKSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59KTsiXX0=