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
            // Public route table + 3 private route tables (one per AZ)
            template.resourceCountIs('AWS::EC2::RouteTable', 4);
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
        test('configures IPv6 for security groups', () => {
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
        test('creates flow logs for private subnets', () => {
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
        test('creates flow logs for public subnets', () => {
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
        test('creates bucket lifecycle policy for development', () => {
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
        test('creates application security group with correct rules', () => {
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
        test('security groups have proper tags', () => {
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
            template.hasResourceProperties('AWS::S3::Bucket', {
                Tags: [
                    { Key: 'Purpose', Value: 'VPC-Flow-Logs' },
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                ],
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
            template.hasResourceProperties('AWS::S3::Bucket', {
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
            template.hasResourceProperties('AWS::S3::Bucket', {
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
        test('handles zero NAT gateways', () => {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidnBjLXN0YWNrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ2cGMtc3RhY2sudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG1DQUFtQztBQUNuQyx1REFBeUQ7QUFDekQsZ0RBQTRDO0FBRTVDLFFBQVEsQ0FBQyxVQUFVLEVBQUUsR0FBRyxFQUFFO0lBQ3hCLElBQUksR0FBWSxDQUFDO0lBQ2pCLElBQUksUUFBa0IsQ0FBQztJQUV2QixRQUFRLENBQUMseUJBQXlCLEVBQUUsR0FBRyxFQUFFO1FBQ3ZDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxvQkFBUSxDQUFDLEdBQUcsRUFBRSxjQUFjLEVBQUU7Z0JBQzlDLFdBQVcsRUFBRSxNQUFNO2dCQUNuQixTQUFTLEVBQUUsY0FBYztnQkFDekIsR0FBRyxFQUFFO29CQUNILE9BQU8sRUFBRSxjQUFjO29CQUN2QixNQUFNLEVBQUUsV0FBVztpQkFDcEI7YUFDRixDQUFDLENBQUM7WUFDSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsK0JBQStCLEVBQUUsR0FBRyxFQUFFO1lBQ3pDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxlQUFlLEVBQUU7Z0JBQzlDLFNBQVMsRUFBRSxhQUFhO2dCQUN4QixrQkFBa0IsRUFBRSxJQUFJO2dCQUN4QixnQkFBZ0IsRUFBRSxJQUFJO2FBQ3ZCLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLHdCQUF3QixFQUFFLEdBQUcsRUFBRTtZQUNsQyxRQUFRLENBQUMsZUFBZSxDQUFDLGtCQUFrQixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMseUJBQXlCO1lBRTFFLFFBQVEsQ0FBQyxxQkFBcUIs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cnQgeyBUZW1wbGF0ZSwgTWF0Y2ggfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IFZwY1N0YWNrIH0gZnJvbSAnLi4vbGliL3ZwYy1zdGFjayc7XG5cbmRlc2NyaWJlKCdWcGNTdGFjaycsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcDtcbiAgbGV0IHRlbXBsYXRlOiBUZW1wbGF0ZTtcblxuICBkZXNjcmliZSgnQmFzaWMgVlBDIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIFZQQyB3aXRoIGNvcnJlY3QgQ0lEUicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQycsIHtcbiAgICAgICAgQ2lkckJsb2NrOiAnMTAuMC4wLjAvMTYnLFxuICAgICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICAgIEVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcHVibGljIHN1Ym5ldHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpTdWJuZXQnLCA2KTsgLy8gMyBBWnMgKiAyIHN1Ym5ldCB0eXBlc1xuICAgICAgXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTdWJuZXQnLCB7XG4gICAgICAgIE1hcFB1YmxpY0lwT25MYXVuY2g6IHRydWUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcHJpdmF0ZSBzdWJuZXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U3VibmV0Jywge1xuICAgICAgICBNYXBQdWJsaWNJcE9uTGF1bmNoOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBJbnRlcm5ldCBHYXRld2F5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6SW50ZXJuZXRHYXRld2F5JywgMSk7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpWUENHYXRld2F5QXR0YWNobWVudCcsIDEpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBOQVQgR2F0ZXdheSBieSBkZWZhdWx0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDEpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyByb3V0ZSB0YWJsZXMnLCAoKSA9PiB7XG4gICAgICAvLyBQdWJsaWMgcm91dGUgdGFibGUgKyAzIHByaXZhdGUgcm91dGUgdGFibGVzIChvbmUgcGVyIEFaKVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6Um91dGVUYWJsZScsIDQpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBzZWN1cml0eSBncm91cHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwJywgMik7IC8vIEFMQiArIEFwcCBzZWN1cml0eSBncm91cHNcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1ZQQyB3aXRoIEN1c3RvbSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgJ1Rlc3RWcGNTdGFjaycsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogdHJ1ZSxcbiAgICAgICAgbWF4QXpzOiAyLFxuICAgICAgICB2cGNDaWRyOiAnMTAuMS4wLjAvMTYnLFxuICAgICAgICBwdWJsaWNTdWJuZXRDaWRyTWFzazogMjYsXG4gICAgICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgVlBDIHdpdGggY3VzdG9tIENJRFInLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpWUEMnLCB7XG4gICAgICAgIENpZHJCbG9jazogJzEwLjEuMC4wLzE2JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBIQSBOQVQgR2F0ZXdheXMgd2hlbiBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDIpOyAvLyBPbmUgcGVyIEFaXG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNvcnJlY3QgbnVtYmVyIG9mIHN1Ym5ldHMgZm9yIG1heEF6cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OlN1Ym5ldCcsIDQpOyAvLyAyIEFacyAqIDIgc3VibmV0IHR5cGVzXG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdJUHY2IFN1cHBvcnQnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIElQdjYgQ0lEUiBibG9jaycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQ0NpZHJCbG9jaycsIHtcbiAgICAgICAgVnBjSWQ6IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgIEFtYXpvblByb3ZpZGVkSXB2NkNpZHJCbG9jazogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBJUHY2IHJvdXRlcyBmb3IgcHVibGljIHN1Ym5ldHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpSb3V0ZScsIHtcbiAgICAgICAgRGVzdGluYXRpb25JcHY2Q2lkckJsb2NrOiAnOjovMCcsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NvbmZpZ3VyZXMgSVB2NiBmb3Igc2VjdXJpdHkgZ3JvdXBzJywgKCkgPT4ge1xuICAgICAgLy8gTG9hZCBiYWxhbmNlciBzZWN1cml0eSBncm91cCBzaG91bGQgaGF2ZSBJUHY2IHJ1bGVzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwSW5ncmVzcycsIHtcbiAgICAgICAgQ2lkcklwdjY6ICc6Oi8wJyxcbiAgICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgIEZyb21Qb3J0OiA4MCxcbiAgICAgICAgVG9Qb3J0OiA4MCxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwSW5ncmVzcycsIHtcbiAgICAgICAgQ2lkcklwdjY6ICc6Oi8wJyxcbiAgICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgIEZyb21Qb3J0OiA0NDMsXG4gICAgICAgIFRvUG9ydDogNDQzLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdDdXN0b20gSVB2NiBDSURSJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgJ1Rlc3RWcGNTdGFjaycsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICAgICAgaXB2NkNpZHJCbG9jazogJzIwMDE6ZGI4OjovNTYnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIElQdjYgQ0lEUiBibG9jayB3aXRoIGN1c3RvbSByYW5nZScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQ0NpZHJCbG9jaycsIHtcbiAgICAgICAgVnBjSWQ6IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgIElwdjZDaWRyQmxvY2s6ICcyMDAxOmRiODo6LzU2JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnVlBDIEZsb3cgTG9ncycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiB0cnVlLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIFMzIGJ1Y2tldCBmb3IgVlBDIGZsb3cgbG9ncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgICAgICBCdWNrZXROYW1lOiAndGVzdGFwcC12cGMtZmxvdy1sb2dzLXByb2R1Y3Rpb24tMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgQnVja2V0RW5jcnlwdGlvbjoge1xuICAgICAgICAgIFNlcnZlclNpZGVFbmNyeXB0aW9uQ29uZmlndXJhdGlvbjogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBTZXJ2ZXJTaWRlRW5jcnlwdGlvbkJ5RGVmYXVsdDoge1xuICAgICAgICAgICAgICAgIFNTRUFsZ29yaXRobTogJ0FFUzI1NicsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIFB1YmxpY0FjY2Vzc0Jsb2NrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEJsb2NrUHVibGljQWNsczogdHJ1ZSxcbiAgICAgICAgICBCbG9ja1B1YmxpY1BvbGljeTogdHJ1ZSxcbiAgICAgICAgICBJZ25vcmVQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgICAgIFJlc3RyaWN0UHVibGljQnVja2V0czogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBidWNrZXQgbGlmZWN5Y2xlIHBvbGljeSBmb3IgcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgICAgICBMaWZlY3ljbGVDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgUnVsZXM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgSWQ6ICdEZWxldGVPbGRGbG93TG9ncycsXG4gICAgICAgICAgICAgIFN0YXR1czogJ0VuYWJsZWQnLFxuICAgICAgICAgICAgICBFeHBpcmF0aW9uSW5EYXlzOiA5MCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIElkOiAnVHJhbnNpdGlvblRvSUEnLFxuICAgICAgICAgICAgICBTdGF0dXM6ICdFbmFibGVkJyxcbiAgICAgICAgICAgICAgVHJhbnNpdGlvbnM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBTdG9yYWdlQ2xhc3M6ICdTVEFOREFSRF9JQScsXG4gICAgICAgICAgICAgICAgICBUcmFuc2l0aW9uSW5EYXlzOiAzMCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIFN0b3JhZ2VDbGFzczogJ0dMQUNJRVInLFxuICAgICAgICAgICAgICAgICAgVHJhbnNpdGlvbkluRGF5czogOTAsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBidWNrZXQgcG9saWN5IGZvciBWUEMgZmxvdyBsb2dzIHNlcnZpY2UnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6UzM6OkJ1Y2tldFBvbGljeScsIHtcbiAgICAgICAgUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgICAgICBTdGF0ZW1lbnQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgU2lkOiAnQVdTTG9nRGVsaXZlcnlXcml0ZScsXG4gICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgUHJpbmNpcGFsOiB7IFNlcnZpY2U6ICdkZWxpdmVyeS5sb2dzLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgICAgICAgIEFjdGlvbjogJ3MzOlB1dE9iamVjdCcsXG4gICAgICAgICAgICAgIENvbmRpdGlvbjoge1xuICAgICAgICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgICAgICAgJ3MzOngtYW16LWFjbCc6ICdidWNrZXQtb3duZXItZnVsbC1jb250cm9sJyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgU2lkOiAnQVdTTG9nRGVsaXZlcnlDaGVjaycsXG4gICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgUHJpbmNpcGFsOiB7IFNlcnZpY2U6ICdkZWxpdmVyeS5sb2dzLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgICAgICAgIEFjdGlvbjogWydzMzpHZXRCdWNrZXRBY2wnLCAnczM6TGlzdEJ1Y2tldCddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIFZQQyBmbG93IGxvZ3MnLCAoKSA9PiB7XG4gICAgICAvLyBWUEMtbGV2ZWwgZmxvdyBsb2dcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OkZsb3dMb2cnLCB7XG4gICAgICAgIFJlc291cmNlVHlwZTogJ1ZQQycsXG4gICAgICAgIFRyYWZmaWNUeXBlOiAnQUxMJyxcbiAgICAgICAgTG9nRGVzdGluYXRpb25UeXBlOiAnczMnLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNob3VsZCBjcmVhdGUgZmxvdyBsb2dzIGZvciBhbGwgc3VibmV0cyAoMyBwcml2YXRlICsgMyBwdWJsaWMgPSA2IHRvdGFsKVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6Rmxvd0xvZycsIDcpOyAvLyAxIFZQQyArIDYgc3VibmV0IGZsb3cgbG9nc1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBmbG93IGxvZ3MgZm9yIHByaXZhdGUgc3VibmV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OkZsb3dMb2cnLCB7XG4gICAgICAgIFJlc291cmNlVHlwZTogJ1N1Ym5ldCcsXG4gICAgICAgIFRyYWZmaWNUeXBlOiAnQUxMJyxcbiAgICAgICAgTG9nRGVzdGluYXRpb25UeXBlOiAnczMnLFxuICAgICAgICBMb2dEZXN0aW5hdGlvbjoge1xuICAgICAgICAgICdGbjo6U3ViJzogW1xuICAgICAgICAgICAgJyR7YnVja2V0fS9wcml2YXRlLXN1Ym5ldHMvc3VibmV0LTAvJyxcbiAgICAgICAgICAgIHsgYnVja2V0OiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9IH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBmbG93IGxvZ3MgZm9yIHB1YmxpYyBzdWJuZXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6Rmxvd0xvZycsIHtcbiAgICAgICAgUmVzb3VyY2VUeXBlOiAnU3VibmV0JyxcbiAgICAgICAgVHJhZmZpY1R5cGU6ICdBTEwnLFxuICAgICAgICBMb2dEZXN0aW5hdGlvblR5cGU6ICdzMycsXG4gICAgICAgIExvZ0Rlc3RpbmF0aW9uOiB7XG4gICAgICAgICAgJ0ZuOjpTdWInOiBbXG4gICAgICAgICAgICAnJHtidWNrZXR9L3B1YmxpYy1zdWJuZXRzL3N1Ym5ldC0wLycsXG4gICAgICAgICAgICB7IGJ1Y2tldDogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnQXJuJ10gfSB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1ZQQyBGbG93IExvZ3MgZm9yIERldmVsb3BtZW50JywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgJ1Rlc3RWcGNTdGFjaycsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBidWNrZXQgbGlmZWN5Y2xlIHBvbGljeSBmb3IgZGV2ZWxvcG1lbnQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFJ1bGVzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIElkOiAnRGVsZXRlT2xkRmxvd0xvZ3MnLFxuICAgICAgICAgICAgICBTdGF0dXM6ICdFbmFibGVkJyxcbiAgICAgICAgICAgICAgRXhwaXJhdGlvbkluRGF5czogMzAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1NlY3VyaXR5IEdyb3VwcycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgbG9hZCBiYWxhbmNlciBzZWN1cml0eSBncm91cCB3aXRoIGNvcnJlY3QgcnVsZXMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwJywge1xuICAgICAgICBHcm91cERlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXInLFxuICAgICAgICBTZWN1cml0eUdyb3VwSW5ncmVzczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIENpZHJJcDogJzAuMC4wLjAvMCcsXG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA4MCxcbiAgICAgICAgICAgIFRvUG9ydDogODAsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ0FsbG93IEhUVFAgdHJhZmZpYyBmcm9tIGFueXdoZXJlJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIENpZHJJcDogJzAuMC4wLjAvMCcsXG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA0NDMsXG4gICAgICAgICAgICBUb1BvcnQ6IDQ0MyxcbiAgICAgICAgICAgIERlc2NyaXB0aW9uOiAnQWxsb3cgSFRUUFMgdHJhZmZpYyBmcm9tIGFueXdoZXJlJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIENpZHJJcHY2OiAnOjovMCcsXG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA4MCxcbiAgICAgICAgICAgIFRvUG9ydDogODAsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ0FsbG93IEhUVFAgdHJhZmZpYyBmcm9tIGFueXdoZXJlIChJUHY2KScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBDaWRySXB2NjogJzo6LzAnLFxuICAgICAgICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgICAgICBGcm9tUG9ydDogNDQzLFxuICAgICAgICAgICAgVG9Qb3J0OiA0NDMsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ0FsbG93IEhUVFBTIHRyYWZmaWMgZnJvbSBhbnl3aGVyZSAoSVB2NiknLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYXBwbGljYXRpb24gc2VjdXJpdHkgZ3JvdXAgd2l0aCBjb3JyZWN0IHJ1bGVzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cCcsIHtcbiAgICAgICAgR3JvdXBEZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBFQ1MgYXBwbGljYXRpb25zJyxcbiAgICAgICAgU2VjdXJpdHlHcm91cEluZ3Jlc3M6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA4MDAwLFxuICAgICAgICAgICAgVG9Qb3J0OiA4MDAwLFxuICAgICAgICAgICAgU291cmNlU2VjdXJpdHlHcm91cElkOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyB0cmFmZmljIGZyb20gTG9hZCBCYWxhbmNlcicsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgICAgICAgIEZyb21Qb3J0OiA4MDAwLFxuICAgICAgICAgICAgVG9Qb3J0OiA4OTk5LFxuICAgICAgICAgICAgU291cmNlU2VjdXJpdHlHcm91cElkOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvdyBoZWFsdGggY2hlY2sgdHJhZmZpYyBmcm9tIExvYWQgQmFsYW5jZXInLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3NlY3VyaXR5IGdyb3VwcyBoYXZlIHByb3BlciB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cCcsIHtcbiAgICAgICAgVGFnczogW1xuICAgICAgICAgIHsgS2V5OiAnTmFtZScsIFZhbHVlOiAndGVzdGFwcC10ZXN0LWFsYi1zZycgfSxcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICd0ZXN0JyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdMb2FkQmFsYW5jZXInIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cCcsIHtcbiAgICAgICAgVGFnczogW1xuICAgICAgICAgIHsgS2V5OiAnTmFtZScsIFZhbHVlOiAndGVzdGFwcC10ZXN0LWFwcC1zZycgfSxcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICd0ZXN0JyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdBcHBsaWNhdGlvbicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnU3RhY2sgT3V0cHV0cycsICgpID0+IHtcbiAgICBsZXQgc3RhY2s6IFZwY1N0YWNrO1xuXG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICAgICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBjb3JlIFZQQyBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdWcGNJZCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdWUEMgSUQnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RWcGNTdGFjay1WcGNJZCcgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1ZwY0NpZHInLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnVlBDIENJRFIgQmxvY2snLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RWcGNTdGFjay1WcGNDaWRyJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHN1Ym5ldCBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdQcml2YXRlU3VibmV0SWRzJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1ByaXZhdGUgU3VibmV0IElEcycsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLVByaXZhdGVTdWJuZXRJZHMnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdQdWJsaWNTdWJuZXRJZHMnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnUHVibGljIFN1Ym5ldCBJRHMnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RWcGNTdGFjay1QdWJsaWNTdWJuZXRJZHMnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgc2VjdXJpdHkgZ3JvdXAgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnTG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0xvYWQgQmFsYW5jZXIgU2VjdXJpdHkgR3JvdXAgSUQnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RWcGNTdGFjay1Mb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdBcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBTZWN1cml0eSBHcm91cCBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLUFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGZsb3cgbG9ncyBvdXRwdXRzIHdoZW4gZW5hYmxlZCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnRmxvd0xvZ3NCdWNrZXROYW1lJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1ZQQyBGbG93IExvZ3MgUzMgQnVja2V0IE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RWcGNTdGFjay1GbG93TG9nc0J1Y2tldE5hbWUnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdGbG93TG9nc0J1Y2tldEFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdWUEMgRmxvdyBMb2dzIFMzIEJ1Y2tldCBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RWcGNTdGFjay1GbG93TG9nc0J1Y2tldEFybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBJUHY2IG91dHB1dHMgd2hlbiBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdWcGNJcHY2Q2lkckJsb2NrcycsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdWUEMgSVB2NiBDSURSIEJsb2NrcycsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLVZwY0lwdjZDaWRyQmxvY2tzJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGF2YWlsYWJpbGl0eSB6b25lcyBvdXRwdXQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0F2YWlsYWJpbGl0eVpvbmVzJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0F2YWlsYWJpbGl0eSBab25lcycsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdFZwY1N0YWNrLUF2YWlsYWJpbGl0eVpvbmVzJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdSZXNvdXJjZSBUYWdnaW5nJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgJ1Rlc3RWcGNTdGFjaycsIHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgZW5hYmxlVlBDRmxvd0xvZ3M6IHRydWUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2Zsb3cgbG9ncyBidWNrZXQgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdQdXJwb3NlJywgVmFsdWU6ICdWUEMtRmxvdy1Mb2dzJyB9LFxuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESycgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnRW52aXJvbm1lbnQtc3BlY2lmaWMgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICB0ZXN0KCdwcm9kdWN0aW9uIGVudmlyb25tZW50IGhhcyByZXRhaW4gcmVtb3ZhbCBwb2xpY3knLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCAnVGVzdFZwY1N0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdFZwY1N0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6UzM6OkJ1Y2tldCcsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdSZXRhaW4nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdub24tcHJvZHVjdGlvbiBlbnZpcm9ubWVudCBoYXMgZGVzdHJveSByZW1vdmFsIHBvbGljeScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgICAgZW5hYmxlVlBDRmxvd0xvZ3M6IHRydWUsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXQnLCB7XG4gICAgICAgIERlbGV0aW9uUG9saWN5OiAnRGVsZXRlJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnRWRnZSBDYXNlcyBhbmQgRXJyb3IgSGFuZGxpbmcnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBtYXhBenMgb2YgMScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIG1heEF6czogMSxcbiAgICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6U3VibmV0JywgMik7IC8vIDEgQVogKiAyIHN1Ym5ldCB0eXBlc1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDEpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyB6ZXJvIE5BVCBnYXRld2F5cycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIG5hdEdhdGV3YXlzOiAwLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0VnBjU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6Ok5hdEdhdGV3YXknLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ1ZQQyBGbG93IExvZ3MgZGlzYWJsZWQgYnkgZGVmYXVsdCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OlMzOjpCdWNrZXQnLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OkZsb3dMb2cnLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0lQdjYgZGlzYWJsZWQgYnkgZGVmYXVsdCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsICdUZXN0VnBjU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RWcGNTdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6VlBDQ2lkckJsb2NrJywgMCk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBub3QgaGF2ZSBJUHY2IHJ1bGVzIGluIHNlY3VyaXR5IGdyb3Vwc1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cCcsIHtcbiAgICAgICAgU2VjdXJpdHlHcm91cEluZ3Jlc3M6IE1hdGNoLm5vdChNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2UoeyBDaWRySXB2NjogJzo6LzAnIH0pXG4gICAgICAgIF0pKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcbn0pOyJdfQ==