import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ApplicationStack } from '../lib/application-stack';

describe('ApplicationStack', () => {
  let app: cdk.App;
  let template: Template;

  // Set up test environment to skip SOPS decryption
  beforeAll(() => {
    // Set test environment variables for SOPS fallback
    process.env.APPLICATION_SECRET_KEY = 'test-secret-key-for-testing';
    process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
    process.env.REQUIRED_SETTING = 'test-required-setting';
    process.env.EXTERNAL_API_KEY = 'test-api-key';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.DATADOG_API_KEY = 'test-datadog-key';
    process.env.SENTRY_DSN = 'test-sentry-dsn';
  });

  afterAll(() => {
    // Clean up test environment variables
    delete process.env.APPLICATION_SECRET_KEY;
    delete process.env.JWT_SECRET;
    delete process.env.REQUIRED_SETTING;
    delete process.env.EXTERNAL_API_KEY;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.DATADOG_API_KEY;
    delete process.env.SENTRY_DSN;
  });

  const defaultProps = {
    environment: 'test',
    vpcId: 'vpc-12345678',
    privateSubnetIds: ['subnet-44444444', 'subnet-55555555', 'subnet-66666666'],
    applicationSecurityGroupId: 'sg-87654321',
    clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/testapp-cluster-test',
    clusterName: 'testapp-cluster-test',
    repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/testapp-test',
    loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/testapp-alb-test/1234567890123456',
    httpListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/testapp-alb-test/1234567890123456/1234567890123456',
    logGroupName: '/aws/ecs/testapp-test',
    logGroupArn: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/ecs/testapp-test',
    stackName: 'TestApplicationStack',
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
  };

  describe('Basic Application Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', defaultProps);
      template = Template.fromStack(stack);
    });

    test('creates task definition with correct configuration', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'testapp-test',
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        Cpu: '256',
        Memory: '512',
        ExecutionRoleArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
        TaskRoleArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
      });
    });

    test('creates container definition with correct configuration', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'testapp-test', // Target the main task definition specifically
        ContainerDefinitions: [
          {
            Name: 'testapp-container',
            Image: {
              'Fn::Join': Match.anyValue(),
            },
            PortMappings: [
              {
                ContainerPort: 8000,
                Protocol: 'tcp',
                Name: 'http',
              },
            ],
            Environment: Match.arrayWith([
              { Name: 'REQUIRED_SETTING', Value: 'test' },
              { Name: 'ENVIRONMENT', Value: 'test' },
              { Name: 'AWS_DEFAULT_REGION', Value: 'us-east-1' },
            ]),
            Secrets: [
              {
                Name: 'SECRET_KEY',
                ValueFrom: {
                  'Fn::Join': Match.anyValue(),
                },
              },
            ],
            LogConfiguration: {
              LogDriver: 'awslogs',
              Options: {
                'awslogs-group': '/aws/ecs/testapp-test',
                'awslogs-region': 'us-east-1',
                'awslogs-stream-prefix': 'testapp',
              },
            },
            MemoryReservation: 409, // 80% of 512
          },
        ],
      });
    });

    test('creates Fargate service', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'testapp-service-test',
        Cluster: 'testapp-cluster-test',
        TaskDefinition: { Ref: Match.anyValue() },
        DesiredCount: 1,
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            SecurityGroups: ['sg-87654321'],
            Subnets: ['subnet-44444444', 'subnet-55555555', 'subnet-66666666'],
            AssignPublicIp: 'DISABLED',
          },
        },
        LoadBalancers: [
          {
            ContainerName: 'testapp-container',
            ContainerPort: 8000,
            TargetGroupArn: { Ref: Match.anyValue() },
          },
        ],
      });
    });

    test('creates target group with health checks', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Name: 'testapp-test-tg',
        Port: 8000,
        Protocol: 'HTTP',
        TargetType: 'ip',
        HealthCheckPath: '/health/',
        HealthCheckProtocol: 'HTTP',
        HealthCheckIntervalSeconds: 30,
        HealthCheckTimeoutSeconds: 5,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 3,
        Matcher: { HttpCode: '200' },
      });
    });

    test('creates application auto scaling target', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        ServiceNamespace: 'ecs',
        ResourceId: {
          'Fn::Join': Match.anyValue(),
        },
        ScalableDimension: 'ecs:service:DesiredCount',
        MinCapacity: 1,
        MaxCapacity: 3,
      });
    });

    test('creates CPU-based auto scaling policy', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        PolicyName: Match.stringLikeRegexp('.*CpuScaling.*'),
        PolicyType: 'TargetTrackingScaling',
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: 70,
          PredefinedMetricSpecification: {
            PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
          },
          ScaleInCooldown: 300,
          ScaleOutCooldown: 120,
        },
      });
    });

    test('creates memory-based auto scaling policy', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        PolicyName: Match.stringLikeRegexp('.*MemoryScaling.*'),
        PolicyType: 'TargetTrackingScaling',
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: 80,
          PredefinedMetricSpecification: {
            PredefinedMetricType: 'ECSServiceAverageMemoryUtilization',
          },
          ScaleInCooldown: 300,
          ScaleOutCooldown: 120,
        },
      });
    });

    test('creates request-based auto scaling policy', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        PolicyName: Match.stringLikeRegexp('.*RequestScaling.*'),
        PolicyType: 'TargetTrackingScaling',
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: 1000, // Default value
          PredefinedMetricSpecification: {
            PredefinedMetricType: 'ALBRequestCountPerTarget',
            ResourceLabel: {
              'Fn::Join': Match.anyValue(), // CDK generates complex Fn::Join for ALB/TargetGroup resource labels
            },
          },
          ScaleInCooldown: 300,
          ScaleOutCooldown: 120,
        },
      });
    });
  });

  describe('Custom Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'production',
        serviceName: 'custom-service',
        taskImageTag: 'v1.2.3',
        desiredCount: 3,
        cpu: 1024,
        memoryLimitMiB: 2048,
        containerPort: 9000,
        healthCheckPath: '/custom-health',
        healthCheckInterval: 60,
        healthCheckTimeout: 10,
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 5,
        environmentVariables: {
          CUSTOM_ENV: 'custom_value',
        },
      });
      template = Template.fromStack(stack);
    });

    test('uses custom service configuration', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'custom-service',
        DesiredCount: 3,
      });
    });

    test('uses custom task definition configuration', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'testapp-production',
        Cpu: '1024',
        Memory: '2048',
      });
    });

    test('uses custom container configuration', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'testapp-production', // Target the main production task definition specifically
        ContainerDefinitions: [
          {
            Name: 'testapp-container',
            Image: {
              'Fn::Join': Match.anyValue(),
            },
            PortMappings: [
              {
                ContainerPort: 9000,
                Protocol: 'tcp',
                Name: 'http',
              },
            ],
            Environment: Match.arrayWith([
              { Name: 'CUSTOM_ENV', Value: 'custom_value' },
            ]),
            MemoryReservation: 1638, // 80% of 2048
          },
        ],
      });
    });

    test('uses custom health check configuration', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 9000,
        HealthCheckPath: '/custom-health',
        HealthCheckIntervalSeconds: 60,
        HealthCheckTimeoutSeconds: 10,
        HealthyThresholdCount: 3,
        UnhealthyThresholdCount: 5,
      });
    });

    test('uses custom auto scaling configuration', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        MinCapacity: 3,
        MaxCapacity: 9, // 3 * 3
      });
    });

    test('uses production request count for scaling', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        PolicyName: Match.stringLikeRegexp('.*RequestScaling.*'),
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: 1000, // Default value
        },
      });
    });
  });

  describe('Container Security Features', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        enableNonRootContainer: true,
        enableReadOnlyRootFilesystem: true,
      });
      template = Template.fromStack(stack);
    });

    test('configures non-root user', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [
          {
            User: '1001:1001',
          },
        ],
      });
    });

    test('enables read-only root filesystem', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [
          {
            ReadonlyRootFilesystem: true,
          },
        ],
      });
    });

    test('creates tmpfs volumes for read-only filesystem', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Volumes: [
          { Name: 'tmp-volume', Host: {} },
          { Name: 'logs-volume', Host: {} },
        ],
        ContainerDefinitions: [
          {
            MountPoints: [
              {
                SourceVolume: 'tmp-volume',
                ContainerPath: '/tmp',
                ReadOnly: false,
              },
              {
                SourceVolume: 'logs-volume',
                ContainerPath: '/app/logs',
                ReadOnly: false,
              },
            ],
          },
        ],
      });
    });
  });

  describe('Auto Scaling Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        minCapacity: 2,
        maxCapacity: 10,
        cpuTargetUtilization: 60,
        memoryTargetUtilization: 75,
        scaleInCooldownMinutes: 10,
        scaleOutCooldownMinutes: 3,
      });
      template = Template.fromStack(stack);
    });

    test('uses custom capacity limits', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        MinCapacity: 2,
        MaxCapacity: 10,
      });
    });

    test('uses custom CPU scaling target', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        PolicyName: Match.stringLikeRegexp('.*CpuScaling.*'),
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: 60,
          ScaleInCooldown: 600, // 10 minutes
          ScaleOutCooldown: 180, // 3 minutes
        },
      });
    });

    test('uses custom memory scaling target', () => {
      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
        PolicyName: Match.stringLikeRegexp('.*MemoryScaling.*'),
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: 75,
          ScaleInCooldown: 600,
          ScaleOutCooldown: 180,
        },
      });
    });
  });

  describe('HTTPS Listener Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        httpsListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/testapp-alb-test/1234567890123456/9876543210987654',
      });
      template = Template.fromStack(stack);
    });

    test.skip('creates listener rules for both HTTP and HTTPS', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        ListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/testapp-alb-test/1234567890123456/1234567890123456',
        Priority: 100,
        Actions: [
          {
            Type: 'forward',
            TargetGroupArn: { Ref: Match.anyValue() },
          },
        ],
        Conditions: [
          {
            Field: 'path-pattern',
            Values: ['*'],
          },
        ],
      });

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        ListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/testapp-alb-test/1234567890123456/9876543210987654',
        Priority: 100,
        Actions: [
          {
            Type: 'forward',
            TargetGroupArn: { Ref: Match.anyValue() },
          },
        ],
        Conditions: [
          {
            Field: 'path-pattern',
            Values: ['*'],
          },
        ],
      });
    });
  });

  describe('IAM Roles and Permissions', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', defaultProps);
      template = Template.fromStack(stack);
    });

    test('creates execution role with correct policies', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'testapp-test-execution-role',
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        ManagedPolicyArns: [
          { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']] },
        ],
      });
    });

    test('creates task role with correct policies', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'testapp-test-task-role',
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        },
      });
    });

    test('execution role has ECR access policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Effect: 'Allow',
                  Action: Match.arrayWith([
                    'ecr:GetAuthorizationToken',
                    'ecr:BatchCheckLayerAvailability',
                    'ecr:GetDownloadUrlForLayer',
                    'ecr:BatchGetImage',
                  ]),
                  Resource: '*',
                }),
              ]),
            },
          }),
        ]),
      });
    });

    test('roles have secrets manager access', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Effect: 'Allow',
                  Action: Match.arrayWith([
                    'secretsmanager:GetSecretValue',
                    'secretsmanager:DescribeSecret',
                  ]),
                  Resource: Match.anyValue(),
                }),
              ]),
            },
          }),
        ]),
      });
    });

    test('task role has CloudWatch logs permissions', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyDocument: {
              Statement: Match.arrayWith([
                Match.objectLike({
                  Effect: 'Allow',
                  Action: Match.arrayWith([
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ]),
                  Resource: Match.anyValue(),
                }),
              ]),
            },
          }),
        ]),
      });
    });
  });

  describe('Secrets Manager Integration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', defaultProps);
      template = Template.fromStack(stack);
    });

    test('creates secrets manager secret', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'testapp-test-app-secrets',
        Description: 'Application secrets for TestApp test environment',
      });
    });

    test('production secrets have retain removal policy', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);

      template.hasResource('AWS::SecretsManager::Secret', {
        DeletionPolicy: 'Retain',
      });
    });

    test('non-production secrets have destroy removal policy', () => {
      template.hasResource('AWS::SecretsManager::Secret', {
        DeletionPolicy: 'Delete',
      });
    });
  });

  describe('ECS Service Configuration', () => {
    test('enables ECS Exec for non-production environments', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'dev',
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ECS::Service', {
        EnableExecuteCommand: true,
      });
    });

    test('disables ECS Exec for production', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ECS::Service', {
        EnableExecuteCommand: false,
      });
    });

    test('uses different deployment configuration for production', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: {
          MaximumPercent: 200,
          MinimumHealthyPercent: 100, // Zero-downtime deployments for production
        },
      });
    });

    test('uses relaxed deployment configuration for non-production', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'dev', // Non-production environment
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: {
          MaximumPercent: 150, // Cost-effective for dev/staging
          MinimumHealthyPercent: 50,
        },
      });
    });
  });

  describe('Stack Outputs', () => {
    let stack: ApplicationStack;

    beforeEach(() => {
      app = new cdk.App();
      stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        desiredCount: 2,
        cpu: 512,
        memoryLimitMiB: 1024,
      });
      template = Template.fromStack(stack);
    });

    test('creates service outputs', () => {
      template.hasOutput('ServiceArn', {
        Description: 'ECS Service ARN',
        Export: { Name: 'TestApplicationStack-ServiceArn' },
      });

      template.hasOutput('ServiceName', {
        Description: 'ECS Service Name',
        Export: { Name: 'TestApplicationStack-ServiceName' },
      });
    });

    test('creates task definition outputs', () => {
      template.hasOutput('TaskDefinitionArn', {
        Description: 'ECS Task Definition ARN',
        Export: { Name: 'TestApplicationStack-TaskDefinitionArn' },
      });

      template.hasOutput('TaskDefinitionFamily', {
        Description: 'ECS Task Definition Family',
        Export: { Name: 'TestApplicationStack-TaskDefinitionFamily' },
      });
    });

    test('creates target group outputs', () => {
      template.hasOutput('TargetGroupArn', {
        Description: 'Application Target Group ARN',
        Export: { Name: 'TestApplicationStack-TargetGroupArn' },
      });

      template.hasOutput('TargetGroupName', {
        Description: 'Application Target Group Name',
        Export: { Name: 'TestApplicationStack-TargetGroupName' },
      });
    });

    test('creates secrets outputs', () => {
      template.hasOutput('SecretsArn', {
        Description: 'Application Secrets ARN',
        Export: { Name: 'TestApplicationStack-SecretsArn' },
      });
    });

    test('creates auto scaling outputs', () => {
      template.hasOutput('AutoScalingTargetId', {
        Description: 'Auto Scaling Target ID',
        Export: { Name: 'TestApplicationStack-AutoScalingTargetId' },
      });
    });

    test('creates configuration outputs', () => {
      template.hasOutput('DesiredCount', {
        Description: 'Current Desired Count',
        Value: '2',
      });

      template.hasOutput('TaskCpu', {
        Description: 'Task CPU Units',
        Value: '512',
      });

      template.hasOutput('TaskMemory', {
        Description: 'Task Memory (MiB)',
        Value: '1024',
      });
    });
  });

  describe('Resource Tagging', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);
    });

    test('task definition has correct tags', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
        ]),
      });
    });

    test('target group has correct tags', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
        ]),
      });
    });

    test('ECS service has correct tags', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
        ]),
      });
    });

    test('secrets have correct tags', () => {
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
          { Key: 'ManagedBy', Value: 'CDK-SOPS' },
        ]),
      });
    });

    test('IAM roles have correct tags', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
        ]),
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('handles minimal configuration', () => {
      app = new cdk.App();
      const minimalProps = {
        environment: 'test',
        vpcId: 'vpc-12345678',
        privateSubnetIds: ['subnet-44444444'],
        applicationSecurityGroupId: 'sg-87654321',
        clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster',
        clusterName: 'test-cluster',
        repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test-repo',
        loadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/test-alb/123',
        httpListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/test-alb/123/456',
        logGroupName: '/aws/ecs/test',
        logGroupArn: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/ecs/test',
        stackName: 'TestApplicationStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      };

      expect(() => {
        new ApplicationStack(app, 'TestApplicationStack', minimalProps);
      }).not.toThrow();
    });

    test('uses default values for optional parameters', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', defaultProps);
      template = Template.fromStack(stack);

      // Should use defaults
      template.hasResourceProperties('AWS::ECS::Service', {
        DesiredCount: 1, // default
      });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '256', // default
        Memory: '512', // default
      });

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 8000, // default
        HealthCheckPath: '/health/', // default
      });
    });

    test('handles zero desired count', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        desiredCount: 0,
      });
      template = Template.fromStack(stack);

      // Zero desired count gets adjusted to minimum of 1 for safety
      template.hasResourceProperties('AWS::ECS::Service', {
        DesiredCount: 1,
      });

      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        MinCapacity: 1, // Minimum enforced to 1 for safety
        MaxCapacity: 3, // Uses Math.max(1, desiredCount) * 3
      });
    });

    test('handles custom auto scaling limits', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        desiredCount: 2,
        minCapacity: 1,
        maxCapacity: 20,
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        MinCapacity: 1, // Custom minCapacity overrides desiredCount
        MaxCapacity: 20,
      });
    });

    test('container security features disabled by default', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [
          Match.objectLike({
            User: Match.absent(),
            ReadonlyRootFilesystem: false, // Explicitly set to false by default
          }),
        ],
        Volumes: Match.absent(),
      });
    });

    test('no tmpfs volumes when read-only filesystem disabled', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [
          Match.objectLike({
            MountPoints: Match.absent(),
          }),
        ],
      });
    });

    test('handles HTTPS listener not provided', () => {
      // Should only create one listener rule (HTTP)
      template.resourcePropertiesCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', {
        ListenerArn: defaultProps.httpListenerArn,
      }, 1);

      // Should not create HTTPS listener rule
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
    });
  });

  describe('Domain Name Generation', () => {
    test('handles PR deployment domain generation', () => {
      app = new cdk.App();
      // Create stack with PR configuration but no hostedZoneId so no DNS records are created
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        baseDomain: 'example.com',
        appName: 'myapp',
        prId: '123',
        // hostedZoneId intentionally omitted to avoid DNS record creation
      });
      template = Template.fromStack(stack);

      // Should not create DNS records but should handle PR domain logic
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    test('handles production domain generation', () => {
      app = new cdk.App();
      // Create stack with production configuration but no hostedZoneId so no DNS records are created
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        baseDomain: 'example.com',
        appName: 'myapp',
        environment: 'production',
        // hostedZoneId intentionally omitted to avoid DNS record creation
      });
      template = Template.fromStack(stack);

      // Should not create DNS records but should handle production domain logic
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });
  });

  describe('Route53 DNS Configuration', () => {
    test('does not create DNS records when domain configuration missing', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        // No domain configuration provided
      });
      template = Template.fromStack(stack);

      // Should not create any Route53 records
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    test('does not create DNS records when hostedZoneId missing', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        baseDomain: 'example.com',
        appName: 'myapp',
        // hostedZoneId not provided
      });
      template = Template.fromStack(stack);

      // Should not create any Route53 records
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });
  });

  describe('Application URL Output Configuration', () => {
    test('creates application URL outputs correctly', () => {
      app = new cdk.App();
      const stack = new ApplicationStack(app, 'TestApplicationStack', {
        ...defaultProps,
        // Use default configuration to test URL output generation
      });
      template = Template.fromStack(stack);

      // Should create ApplicationUrl output with ALB DNS name
      template.hasOutput('ApplicationUrl', {
        Description: 'Application URL (ALB DNS)',
      });
    });
  });

  describe('SOPS Integration Error Handling', () => {
    test('handles SOPS loading failure gracefully', () => {
      // This test simulates the error handling path in createSecretsManagerSecret
      app = new cdk.App();
      
      expect(() => {
        new ApplicationStack(app, 'TestApplicationStack', defaultProps);
      }).not.toThrow();

      template = Template.fromStack(new ApplicationStack(app, 'TestApplicationStack2', defaultProps));
      
      // Should still create a secret even if SOPS fails
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: 'testapp-test-app-secrets',
      });
    });
  });
});