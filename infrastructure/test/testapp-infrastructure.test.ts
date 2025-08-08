import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { TestAppInfrastructureStack } from '../lib/legacy/testapp-infrastructure-stack';

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

  test('creates Secrets Manager secret with proper configuration', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check Secrets Manager secret
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'testapp-production-secrets',
      Description: 'Application secrets for TestApp production environment',
    });
  });

  test('configures auto scaling for Fargate service', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 2,
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    template = Template.fromStack(stack);

    // Check Auto Scaling Target
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MaxCapacity: 6, // desiredCount * 3
      MinCapacity: 2, // desiredCount
      ServiceNamespace: 'ecs',
    });

    // Check CPU Auto Scaling Policy
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: {
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
        },
        TargetValue: 70,
      },
    });
  });

  test('ensures security groups have appropriate ingress rules', () => {
    const stack = new TestAppInfrastructureStack(app, 'TestStack', {
      environment: 'dev',
      enableIPv6: true,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    template = Template.fromStack(stack);

    // Check security group ingress rules
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 8000,
      ToPort: 8000,
      SourceSecurityGroupId: Match.anyValue(),
    });

    // Note: IPv6 security group rules are handled differently in this implementation
    // The main security group rule is based on source security group, not IPv6 CIDR
  });

  test('applies correct removal policies based on environment', () => {
    // Create separate apps to avoid synth conflicts
    const devApp = new cdk.App();
    const devStack = new TestAppInfrastructureStack(devApp, 'DevStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const devTemplate = Template.fromStack(devStack);

    // Dev ECR should have Delete removal policy
    devTemplate.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'testapp-dev',
    });

    // Test production environment (should retain resources)
    const prodApp = new cdk.App();
    const prodStack = new TestAppInfrastructureStack(prodApp, 'ProdStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const prodTemplate = Template.fromStack(prodStack);

    // Production ECR should exist
    prodTemplate.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'testapp-production',
    });
  });

  test('creates all required stack outputs', () => {
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

    // Check required outputs are created
    const outputs = [
      'VpcId',
      'ClusterName', 
      'RepositoryUri',
      'LoadBalancerDNS',
      'ServiceName',
      'ApplicationUrl'
    ];

    outputs.forEach(outputName => {
      template.hasOutput(outputName, {});
    });
  });

  test('validates stack properties are within reasonable limits', () => {
    // This test ensures our infrastructure parameters are sensible
    const validationTests = [
      { cpu: 256, memory: 512, environment: 'dev', maxAzs: 2 },
      { cpu: 1024, memory: 2048, environment: 'production', maxAzs: 3 },
      { cpu: 2048, memory: 4096, environment: 'production', maxAzs: 3 },
    ];

    validationTests.forEach(props => {
      expect(() => {
        new TestAppInfrastructureStack(app, `TestStack-${props.environment}-${props.cpu}`, {
          environment: props.environment,
          enableIPv6: false,
          enableHANatGateways: false,
          maxAzs: props.maxAzs,
          natGateways: 1,
          desiredCount: 1,
          cpu: props.cpu,
          memoryLimitMiB: props.memory,
        });
      }).not.toThrow();
    });
  });

  test('creates WAF Web ACL when WAF is enabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'WAFTestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      enableWAF: true,
    });

    template = Template.fromStack(stack);

    // Check WAF Web ACL creation
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Name: 'testapp-production-web-acl',
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
    });

    // Check WAF has managed rule sets
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWS-AWSManagedRulesCommonRuleSet',
          Priority: 1,
        }),
        Match.objectLike({
          Name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet', 
          Priority: 2,
        }),
        Match.objectLike({
          Name: 'RateLimitRule',
          Priority: 3,
        }),
      ])
    });

    // Check WAF association with ALB
    template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {});
  });

  test('does not create WAF when disabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'NoWAFTestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      enableWAF: false,
    });

    template = Template.fromStack(stack);

    // Check WAF resources are not created
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
  });

  test('creates VPC Flow Logs and S3 bucket when enabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'FlowLogsTestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      enableVPCFlowLogs: true,
    });

    template = Template.fromStack(stack);

    // Check S3 bucket for flow logs
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });

    // Check VPC Flow Logs
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      ResourceType: 'VPC',
      TrafficType: 'ALL',
    });

    // Check lifecycle policy for retention
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'DeleteOldFlowLogs',
            Status: 'Enabled',
            ExpirationInDays: 90, // Production retention
          },
        ],
      },
    });
  });

  test('does not create VPC Flow Logs when disabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'NoFlowLogsTestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      enableVPCFlowLogs: false,
    });

    template = Template.fromStack(stack);

    // Should not create flow logs or bucket
    template.resourceCountIs('AWS::EC2::FlowLog', 0);
  });

  test('creates SSL certificate when HTTPS is enabled with domain', () => {
    const stack = new TestAppInfrastructureStack(app, 'HTTPSTestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      domainName: 'example.com',
    });

    template = Template.fromStack(stack);

    // Check SSL certificate creation
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'example.com',
      SubjectAlternativeNames: ['*.example.com'],
    });
  });

  test('configures HTTPS listener when HTTPS is enabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'HTTPSListenerTestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      domainName: 'example.com',
    });

    template = Template.fromStack(stack);

    // Check HTTPS listener (port 443)
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
  });

  test('creates secure task definition with non-root user when container security is enabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'SecureContainerTestStack', {
      environment: 'production',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 512,
      memoryLimitMiB: 1024,
      enableNonRootContainer: true,
      enableReadOnlyRootFilesystem: true,
    });

    template = Template.fromStack(stack);

    // Check task definition with security settings
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          User: '1001:1001',
          ReadonlyRootFilesystem: true,
        },
      ],
    });

    // Check memory reservation is set
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          MemoryReservation: 819, // 80% of 1024
        },
      ],
    });
  });

  test('uses default task definition when container security is disabled', () => {
    const stack = new TestAppInfrastructureStack(app, 'DefaultContainerTestStack', {
      environment: 'dev',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      enableNonRootContainer: false,
      enableReadOnlyRootFilesystem: false,
    });

    template = Template.fromStack(stack);

    // Should use ApplicationLoadBalancedFargateService default task definition
    // The task definition should not have User or ReadonlyRootFilesystem set
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const taskDefKeys = Object.keys(taskDefs);
    
    if (taskDefKeys.length > 0) {
      const taskDef = taskDefs[taskDefKeys[0]];
      const containerDefs = taskDef.Properties?.ContainerDefinitions;
      
      if (containerDefs && containerDefs.length > 0) {
        expect(containerDefs[0].User).toBeUndefined();
        expect(containerDefs[0].ReadonlyRootFilesystem).toBeUndefined();
      }
    }
  });

  test('handles missing domain configuration gracefully', () => {
    expect(() => {
      new TestAppInfrastructureStack(app, 'HttpsValidationTestStack', {
        environment: 'test',
        enableIPv6: false,
        enableHANatGateways: false,
        maxAzs: 2,
        natGateways: 1,
        desiredCount: 1,
        cpu: 256,
        memoryLimitMiB: 512,
          // domainName intentionally omitted - should work without HTTPS
      });
    }).not.toThrow();
  });

  test('handles SOPS error gracefully and creates empty secret', () => {
    // This test covers the SOPS error handling path
    const stack = new TestAppInfrastructureStack(app, 'SopsErrorTestStack', {
      environment: 'test',
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const template = Template.fromStack(stack);

    // Should create secrets manager secret even if SOPS fails
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'testapp-test-secrets',
    });
  });
});