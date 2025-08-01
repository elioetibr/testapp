import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { TestAppInfrastructureStack } from '../lib/testapp-infrastructure-stack';

describe('TestAppInfrastructureStack', () => {
  let app: cdk.App;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
  });

  test('creates VPC with correct configuration for dev environment', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check VPC creation
    template.hasResourceProperties('AWS::EC2::VPC', {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });

    // Check NAT Gateway count for dev (should be 1)
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('creates VPC with IPv6 and HA NAT Gateways for production', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'production',
      enableIPv6: true,
      enableHANatGateways: true,
      maxAzs: 3,
      natGateways: 3,
      desiredCount: 3,
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    template = Template.fromStack(stack);

    // Check VPC IPv6 CIDR Block
    template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
      AmazonProvidedIpv6CidrBlock: true,
    });

    // Check NAT Gateway count for production (should be 2 as VPC only creates that many AZs)
    template.resourceCountIs('AWS::EC2::NatGateway', 2);
  });

  test('creates ECS cluster with basic configuration', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check ECS Cluster creation
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'testapp-cluster-dev',
    });
  });

  test('creates ECR repository with lifecycle policies', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check ECR Repository creation
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: {
        ScanOnPush: true,
      },
      LifecyclePolicy: {
        LifecyclePolicyText: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              description: 'Keep last 10 images',
              selection: {
                tagStatus: 'any',
                countType: 'imageCountMoreThan',
                countNumber: 10,
              },
              action: {
                type: 'expire',
              },
            },
          ],
        }),
      },
    });
  });

  test('creates Fargate service with correct task definition', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'production',
      enableIPv6: true,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 2,
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    template = Template.fromStack(stack);

    // Check ECS Service creation
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      LaunchType: 'FARGATE',
    });

    // Check Task Definition
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
    });
  });

  test('creates Application Load Balancer with health checks', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check Application Load Balancer
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'application',
      Scheme: 'internet-facing',
    });

    // Check Target Group with health check
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health/',
      HealthCheckProtocol: 'HTTP',
      Port: 80,
      Protocol: 'HTTP',
      TargetType: 'ip',
    });
  });

  test('creates CloudWatch Log Group with appropriate retention', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'production',
      enableIPv6: true,
      enableHANatGateways: true,
      maxAzs: 3,
      natGateways: 3,
      desiredCount: 3,
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    template = Template.fromStack(stack);

    // Check CloudWatch Log Group
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/ecs/testapp-production',
      RetentionInDays: 30, // Production retention
    });
  });

  test('creates IAM roles with least privilege principles', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check Task Execution Role
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'ecs-tasks.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      ManagedPolicyArns: [
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
            ],
          ],
        },
      ],
    });
  });
});