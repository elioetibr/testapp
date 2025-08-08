"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const application_stack_1 = require("../lib/application-stack");
describe('ApplicationStack', () => {
    let app;
    let template;
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates task definition with correct configuration', () => {
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                Family: 'testapp-test',
                NetworkMode: 'awsvpc',
                RequiresCompatibilities: ['FARGATE'],
                Cpu: '256',
                Memory: '512',
                ExecutionRoleArn: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'Arn'] },
                TaskRoleArn: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'Arn'] },
            });
        });
        test('creates container definition with correct configuration', () => {
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: [
                    {
                        Name: 'testapp-container',
                        Image: {
                            'Fn::Join': assertions_1.Match.anyValue(),
                        },
                        PortMappings: [
                            {
                                ContainerPort: 8000,
                                Protocol: 'tcp',
                                Name: 'http',
                            },
                        ],
                        Environment: [
                            { Name: 'REQUIRED_SETTING', Value: 'test' },
                            { Name: 'ENVIRONMENT', Value: 'test' },
                            { Name: 'AWS_DEFAULT_REGION', Value: 'us-east-1' },
                        ],
                        Secrets: [
                            {
                                Name: 'SECRET_KEY',
                                ValueFrom: {
                                    'Fn::Join': assertions_1.Match.anyValue(),
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
                TaskDefinition: { Ref: assertions_1.Match.anyValue() },
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
                        TargetGroupArn: { Ref: assertions_1.Match.anyValue() },
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
                    'Fn::Join': assertions_1.Match.anyValue(),
                },
                ScalableDimension: 'ecs:service:DesiredCount',
                MinCapacity: 1,
                MaxCapacity: 3,
            });
        });
        test('creates CPU-based auto scaling policy', () => {
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
                PolicyName: assertions_1.Match.stringLikeRegexp('.*CpuScaling.*'),
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
                PolicyName: assertions_1.Match.stringLikeRegexp('.*MemoryScaling.*'),
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
                PolicyName: assertions_1.Match.stringLikeRegexp('.*RequestScaling.*'),
                PolicyType: 'TargetTrackingScaling',
                TargetTrackingScalingPolicyConfiguration: {
                    TargetValue: 1000,
                    PredefinedMetricSpecification: {
                        PredefinedMetricType: 'ALBRequestCountPerTarget',
                        ResourceLabel: {
                            'Fn::Join': assertions_1.Match.anyValue(), // CDK generates complex Fn::Join for ALB/TargetGroup resource labels
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
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
                    DEBUG: 'false',
                },
            });
            template = assertions_1.Template.fromStack(stack);
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
                ContainerDefinitions: [
                    {
                        Name: 'testapp-container',
                        Image: {
                            'Fn::Join': assertions_1.Match.anyValue(),
                        },
                        PortMappings: [
                            {
                                ContainerPort: 9000,
                                Protocol: 'tcp',
                                Name: 'http',
                            },
                        ],
                        Environment: assertions_1.Match.arrayWith([
                            { Name: 'CUSTOM_ENV', Value: 'custom_value' },
                            { Name: 'DEBUG', Value: 'false' },
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
                PolicyName: assertions_1.Match.stringLikeRegexp('.*RequestScaling.*'),
                TargetTrackingScalingPolicyConfiguration: {
                    TargetValue: 1000, // Default value
                },
            });
        });
    });
    describe('Container Security Features', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                enableNonRootContainer: true,
                enableReadOnlyRootFilesystem: true,
            });
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                minCapacity: 2,
                maxCapacity: 10,
                cpuTargetUtilization: 60,
                memoryTargetUtilization: 75,
                scaleInCooldownMinutes: 10,
                scaleOutCooldownMinutes: 3,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('uses custom capacity limits', () => {
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
                MinCapacity: 2,
                MaxCapacity: 10,
            });
        });
        test('uses custom CPU scaling target', () => {
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
                PolicyName: assertions_1.Match.stringLikeRegexp('.*CpuScaling.*'),
                TargetTrackingScalingPolicyConfiguration: {
                    TargetValue: 60,
                    ScaleInCooldown: 600,
                    ScaleOutCooldown: 180, // 3 minutes
                },
            });
        });
        test('uses custom memory scaling target', () => {
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
                PolicyName: assertions_1.Match.stringLikeRegexp('.*MemoryScaling.*'),
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                httpsListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/testapp-alb-test/1234567890123456/9876543210987654',
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test.skip('creates listener rules for both HTTP and HTTPS', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
                ListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/testapp-alb-test/1234567890123456/1234567890123456',
                Priority: 100,
                Actions: [
                    {
                        Type: 'forward',
                        TargetGroupArn: { Ref: assertions_1.Match.anyValue() },
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
                        TargetGroupArn: { Ref: assertions_1.Match.anyValue() },
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
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
                Policies: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        PolicyDocument: {
                            Statement: assertions_1.Match.arrayWith([
                                assertions_1.Match.objectLike({
                                    Effect: 'Allow',
                                    Action: assertions_1.Match.arrayWith([
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
                Policies: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        PolicyDocument: {
                            Statement: assertions_1.Match.arrayWith([
                                assertions_1.Match.objectLike({
                                    Effect: 'Allow',
                                    Action: assertions_1.Match.arrayWith([
                                        'secretsmanager:GetSecretValue',
                                        'secretsmanager:DescribeSecret',
                                    ]),
                                    Resource: assertions_1.Match.anyValue(),
                                }),
                            ]),
                        },
                    }),
                ]),
            });
        });
        test('task role has CloudWatch logs permissions', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                Policies: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        PolicyDocument: {
                            Statement: assertions_1.Match.arrayWith([
                                assertions_1.Match.objectLike({
                                    Effect: 'Allow',
                                    Action: assertions_1.Match.arrayWith([
                                        'logs:CreateLogStream',
                                        'logs:PutLogEvents',
                                    ]),
                                    Resource: assertions_1.Match.anyValue(),
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates secrets manager secret', () => {
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Name: 'testapp-test-app-secrets',
                Description: 'Application secrets for TestApp test environment',
            });
        });
        test('production secrets have retain removal policy', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                environment: 'dev',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ECS::Service', {
                EnableExecuteCommand: true,
            });
        });
        test('disables ECS Exec for production', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ECS::Service', {
                EnableExecuteCommand: false,
            });
        });
        test('uses different deployment configuration for production', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ECS::Service', {
                DeploymentConfiguration: {
                    MaximumPercent: 200,
                    MinimumHealthyPercent: 100, // Zero-downtime deployments for production
                },
            });
        });
        test('uses relaxed deployment configuration for non-production', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                environment: 'dev', // Non-production environment
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ECS::Service', {
                DeploymentConfiguration: {
                    MaximumPercent: 150,
                    MinimumHealthyPercent: 50,
                },
            });
        });
    });
    describe('Stack Outputs', () => {
        let stack;
        beforeEach(() => {
            app = new cdk.App();
            stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                desiredCount: 2,
                cpu: 512,
                memoryLimitMiB: 1024,
            });
            template = assertions_1.Template.fromStack(stack);
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('task definition has correct tags', () => {
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                ]),
            });
        });
        test('target group has correct tags', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                ]),
            });
        });
        test('ECS service has correct tags', () => {
            template.hasResourceProperties('AWS::ECS::Service', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                ]),
            });
        });
        test('secrets have correct tags', () => {
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK-SOPS' },
                ]),
            });
        });
        test('IAM roles have correct tags', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                Tags: assertions_1.Match.arrayWith([
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
                new application_stack_1.ApplicationStack(app, 'TestApplicationStack', minimalProps);
            }).not.toThrow();
        });
        test('uses default values for optional parameters', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
            // Should use defaults
            template.hasResourceProperties('AWS::ECS::Service', {
                DesiredCount: 1, // default
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                Cpu: '256',
                Memory: '512', // default
            });
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Port: 8000,
                HealthCheckPath: '/health/', // default
            });
        });
        test('handles zero desired count', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                desiredCount: 0,
            });
            template = assertions_1.Template.fromStack(stack);
            // Zero desired count gets adjusted to minimum of 1 for safety
            template.hasResourceProperties('AWS::ECS::Service', {
                DesiredCount: 1,
            });
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
                MinCapacity: 1,
                MaxCapacity: 3, // Uses Math.max(1, desiredCount) * 3
            });
        });
        test('handles custom auto scaling limits', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                desiredCount: 2,
                minCapacity: 1,
                maxCapacity: 20,
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
                MinCapacity: 1,
                MaxCapacity: 20,
            });
        });
        test('container security features disabled by default', () => {
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: [
                    assertions_1.Match.objectLike({
                        User: assertions_1.Match.absent(),
                        ReadonlyRootFilesystem: false, // Explicitly set to false by default
                    }),
                ],
                Volumes: assertions_1.Match.absent(),
            });
        });
        test('no tmpfs volumes when read-only filesystem disabled', () => {
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: [
                    assertions_1.Match.objectLike({
                        MountPoints: assertions_1.Match.absent(),
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
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                baseDomain: 'example.com',
                appName: 'myapp',
                prId: '123',
                // hostedZoneId intentionally omitted to avoid DNS record creation
            });
            template = assertions_1.Template.fromStack(stack);
            // Should not create DNS records but should handle PR domain logic
            template.resourceCountIs('AWS::Route53::RecordSet', 0);
        });
        test('handles production domain generation', () => {
            app = new cdk.App();
            // Create stack with production configuration but no hostedZoneId so no DNS records are created
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                baseDomain: 'example.com',
                appName: 'myapp',
                environment: 'production',
                // hostedZoneId intentionally omitted to avoid DNS record creation
            });
            template = assertions_1.Template.fromStack(stack);
            // Should not create DNS records but should handle production domain logic
            template.resourceCountIs('AWS::Route53::RecordSet', 0);
        });
    });
    describe('Route53 DNS Configuration', () => {
        test('does not create DNS records when domain configuration missing', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                // No domain configuration provided
            });
            template = assertions_1.Template.fromStack(stack);
            // Should not create any Route53 records
            template.resourceCountIs('AWS::Route53::RecordSet', 0);
        });
        test('does not create DNS records when hostedZoneId missing', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                baseDomain: 'example.com',
                appName: 'myapp',
                // hostedZoneId not provided
            });
            template = assertions_1.Template.fromStack(stack);
            // Should not create any Route53 records
            template.resourceCountIs('AWS::Route53::RecordSet', 0);
        });
    });
    describe('Application URL Output Configuration', () => {
        test('creates application URL outputs correctly', () => {
            app = new cdk.App();
            const stack = new application_stack_1.ApplicationStack(app, 'TestApplicationStack', {
                ...defaultProps,
                // Use default configuration to test URL output generation
            });
            template = assertions_1.Template.fromStack(stack);
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
                new application_stack_1.ApplicationStack(app, 'TestApplicationStack', defaultProps);
            }).not.toThrow();
            template = assertions_1.Template.fromStack(new application_stack_1.ApplicationStack(app, 'TestApplicationStack2', defaultProps));
            // Should still create a secret even if SOPS fails
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Name: 'testapp-test-app-secrets',
            });
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2sudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFwcGxpY2F0aW9uLXN0YWNrLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtQ0FBbUM7QUFDbkMsdURBQXlEO0FBQ3pELGdFQUE0RDtBQUU1RCxRQUFRLENBQUMsa0JBQWtCLEVBQUUsR0FBRyxFQUFFO0lBQ2hDLElBQUksR0FBWSxDQUFDO0lBQ2pCLElBQUksUUFBa0IsQ0FBQztJQUV2QixrREFBa0Q7SUFDbEQsU0FBUyxDQUFDLEdBQUcsRUFBRTtRQUNiLG1EQUFtRDtRQUNuRCxPQUFPLENBQUMsR0FBRyxDQUFDLHNCQUFzQixHQUFHLDZCQUE2QixDQUFDO1FBQ25FLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxHQUFHLDZCQUE2QixDQUFDO1FBQ3ZELE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLEdBQUcsdUJBQXVCLENBQUM7UUFDdkQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsR0FBRyxjQUFjLENBQUM7UUFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLEdBQUcscUJBQXFCLENBQUM7UUFDbkQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFlLEdBQUcsa0JBQWtCLENBQUM7UUFDakQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLEdBQUcsaUJBQWlCLENBQUM7SUFDN0MsQ0FBQyxDQUFDLENBQUM7SUFFSCxRQUFRLENBQUMsR0FBRyxFQUFFO1FBQ1osc0NBQXNDO1FBQ3RDLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsQ0FBQztRQUMxQyxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDO1FBQzlCLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQztRQUNwQyxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUM7UUFDcEMsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLGNB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QzlELEdBQUcsWUFBWTtnQkFDZiwwREFBMEQ7YUFDM0QsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLHdEQUF3RDtZQUN4RCxRQUFRLENBQUMsU0FBUyxDQUFDLGdCQUFnQixFQUFFO2dCQUNuQyxXQUFXLEVBQUUsMkJBQTJCO2FBQ3pDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxRQUFRLENBQUMsaUNBQWlDLEVBQUUsR0FBRyxFQUFFO1FBQy9DLElBQUksQ0FBQyx5Q0FBeUMsRUFBRSxHQUFHLEVBQUU7WUFDbkQsNEVBQTRFO1lBQzVFLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUVwQixNQUFNLENBQUMsR0FBRyxFQUFFO2dCQUNWLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQ2xFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUVqQixRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsSUFBSSxvQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsdUJBQXVCLEVBQUUsWUFBWSxDQUFDLENBQUMsQ0FBQztZQUVoRyxrREFBa0Q7WUFDbEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDZCQUE2QixFQUFFO2dCQUM1RCxJQUFJLEVBQUUsMEJBQTBCO2FBQ2pDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSwgTWF0Y2ggfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IEFwcGxpY2F0aW9uU3RhY2sgfSBmcm9tICcuLi9saWIvYXBwbGljYXRpb24tc3RhY2snO1xuXG5kZXNjcmliZSgnQXBwbGljYXRpb25TdGFjaycsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcDtcbiAgbGV0IHRlbXBsYXRlOiBUZW1wbGF0ZTtcblxuICAvLyBTZXQgdXAgdGVzdCBlbnZpcm9ubWVudCB0byBza2lwIFNPUFMgZGVjcnlwdGlvblxuICBiZWZvcmVBbGwoKCkgPT4ge1xuICAgIC8vIFNldCB0ZXN0IGVudmlyb25tZW50IHZhcmlhYmxlcyBmb3IgU09QUyBmYWxsYmFja1xuICAgIHByb2Nlc3MuZW52LkFQUExJQ0FUSU9OX1NFQ1JFVF9LRVkgPSAndGVzdC1zZWNyZXQta2V5LWZvci10ZXN0aW5nJztcbiAgICBwcm9jZXNzLmVudi5KV1RfU0VDUkVUID0gJ3Rlc3Qtand0LXNlY3JldC1mb3ItdGVzdGluZyc7XG4gICAgcHJvY2Vzcy5lbnYuUkVRVUlSRURfU0VUVElORyA9ICd0ZXN0LXJlcXVpcmVkLXNldHRpbmcnO1xuICAgIHByb2Nlc3MuZW52LkVYVEVSTkFMX0FQSV9LRVkgPSAndGVzdC1hcGkta2V5JztcbiAgICBwcm9jZXNzLmVudi5XRUJIT09LX1NFQ1JFVCA9ICd0ZXN0LXdlYmhvb2stc2VjcmV0JztcbiAgICBwcm9jZXNzLmVudi5EQVRBRE9HX0FQSV9LRVkgPSAndGVzdC1kYXRhZG9nLWtleSc7XG4gICAgcHJvY2Vzcy5lbnYuU0VOVFJZX0RTTiA9ICd0ZXN0LXNlbnRyeS1kc24nO1xuICB9KTtcblxuICBhZnRlckFsbCgoKSA9PiB7XG4gICAgLy8gQ2xlYW4gdXAgdGVzdCBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuQVBQTElDQVRJT05fU0VDUkVUX0tFWTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuSldUX1NFQ1JFVDtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuUkVRVUlSRURfU0VUVElORztcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuRVhURVJOQUxfQVBJX0tFWTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuV0VCSE9PS19TRUNSRVQ7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkRBVEFET0dfQVBJX0tFWTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuU0VOVFJZX0RTTjtcbiAgfSk7XG5cbiAgY29uc3QgZGVmYXVsdFByb3BzID0ge1xuICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgIHByaXZhdGVTdWJuZXRJZHM6IFsnc3VibmV0LTQ0NDQ0NDQ0JywgJ3N1Ym5ldC01NTU1NTU1NScsICdzdWJuZXQtNjY2NjY2NjYnXSxcbiAgICBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZDogJ3NnLTg3NjU0MzIxJyxcbiAgICBjbHVzdGVyQXJuOiAnYXJuOmF3czplY3M6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpjbHVzdGVyL3Rlc3RhcHAtY2x1c3Rlci10ZXN0JyxcbiAgICBjbHVzdGVyTmFtZTogJ3Rlc3RhcHAtY2x1c3Rlci10ZXN0JyxcbiAgICByZXBvc2l0b3J5VXJpOiAnMTIzNDU2Nzg5MDEyLmRrci5lY3IudXMtZWFzdC0xLmFtYXpvbmF3cy5jb20vdGVzdGFwcC10ZXN0JyxcbiAgICBsb2FkQmFsYW5jZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bG9hZGJhbGFuY2VyL2FwcC90ZXN0YXBwLWFsYi10ZXN0LzEyMzQ1Njc4OTAxMjM0NTYnLFxuICAgIGh0dHBMaXN0ZW5lckFybjogJ2Fybjphd3M6ZWxhc3RpY2xvYWRiYWxhbmNpbmc6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsaXN0ZW5lci9hcHAvdGVzdGFwcC1hbGItdGVzdC8xMjM0NTY3ODkwMTIzNDU2LzEyMzQ1Njc4OTAxMjM0NTYnLFxuICAgIGxvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3RhcHAtdGVzdCcsXG4gICAgbG9nR3JvdXBBcm46ICdhcm46YXdzOmxvZ3M6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsb2ctZ3JvdXA6L2F3cy9lY3MvdGVzdGFwcC10ZXN0JyxcbiAgICBzdGFja05hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjaycsXG4gICAgZW52OiB7XG4gICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgfSxcbiAgfTtcblxuICBkZXNjcmliZSgnQmFzaWMgQXBwbGljYXRpb24gQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgdGFzayBkZWZpbml0aW9uIHdpdGggY29ycmVjdCBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIEZhbWlseTogJ3Rlc3RhcHAtdGVzdCcsXG4gICAgICAgIE5ldHdvcmtNb2RlOiAnYXdzdnBjJyxcbiAgICAgICAgUmVxdWlyZXNDb21wYXRpYmlsaXRpZXM6IFsnRkFSR0FURSddLFxuICAgICAgICBDcHU6ICcyNTYnLFxuICAgICAgICBNZW1vcnk6ICc1MTInLFxuICAgICAgICBFeGVjdXRpb25Sb2xlQXJuOiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9LFxuICAgICAgICBUYXNrUm9sZUFybjogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnQXJuJ10gfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBjb250YWluZXIgZGVmaW5pdGlvbiB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgICBDb250YWluZXJEZWZpbml0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICd0ZXN0YXBwLWNvbnRhaW5lcicsXG4gICAgICAgICAgICBJbWFnZToge1xuICAgICAgICAgICAgICAnRm46OkpvaW4nOiBNYXRjaC5hbnlWYWx1ZSgpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIFBvcnRNYXBwaW5nczogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgQ29udGFpbmVyUG9ydDogODAwMCxcbiAgICAgICAgICAgICAgICBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgICAgICAgICAgTmFtZTogJ2h0dHAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIEVudmlyb25tZW50OiBbXG4gICAgICAgICAgICAgIHsgTmFtZTogJ1JFUVVJUkVEX1NFVFRJTkcnLCBWYWx1ZTogJ3Rlc3QnIH0sXG4gICAgICAgICAgICAgIHsgTmFtZTogJ0VOVklST05NRU5UJywgVmFsdWU6ICd0ZXN0JyB9LFxuICAgICAgICAgICAgICB7IE5hbWU6ICdBV1NfREVGQVVMVF9SRUdJT04nLCBWYWx1ZTogJ3VzLWVhc3QtMScgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBTZWNyZXRzOiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBOYW1lOiAnU0VDUkVUX0tFWScsXG4gICAgICAgICAgICAgICAgVmFsdWVGcm9tOiB7XG4gICAgICAgICAgICAgICAgICAnRm46OkpvaW4nOiBNYXRjaC5hbnlWYWx1ZSgpLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgTG9nQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgICBMb2dEcml2ZXI6ICdhd3Nsb2dzJyxcbiAgICAgICAgICAgICAgT3B0aW9uczoge1xuICAgICAgICAgICAgICAgICdhd3Nsb2dzLWdyb3VwJzogJy9hd3MvZWNzL3Rlc3RhcHAtdGVzdCcsXG4gICAgICAgICAgICAgICAgJ2F3c2xvZ3MtcmVnaW9uJzogJ3VzLWVhc3QtMScsXG4gICAgICAgICAgICAgICAgJ2F3c2xvZ3Mtc3RyZWFtLXByZWZpeCc6ICd0ZXN0YXBwJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBNZW1vcnlSZXNlcnZhdGlvbjogNDA5LCAvLyA4MCUgb2YgNTEyXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBGYXJnYXRlIHNlcnZpY2UnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBTZXJ2aWNlTmFtZTogJ3Rlc3RhcHAtc2VydmljZS10ZXN0JyxcbiAgICAgICAgQ2x1c3RlcjogJ3Rlc3RhcHAtY2x1c3Rlci10ZXN0JyxcbiAgICAgICAgVGFza0RlZmluaXRpb246IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgIERlc2lyZWRDb3VudDogMSxcbiAgICAgICAgTGF1bmNoVHlwZTogJ0ZBUkdBVEUnLFxuICAgICAgICBOZXR3b3JrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEF3c3ZwY0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgIFNlY3VyaXR5R3JvdXBzOiBbJ3NnLTg3NjU0MzIxJ10sXG4gICAgICAgICAgICBTdWJuZXRzOiBbJ3N1Ym5ldC00NDQ0NDQ0NCcsICdzdWJuZXQtNTU1NTU1NTUnLCAnc3VibmV0LTY2NjY2NjY2J10sXG4gICAgICAgICAgICBBc3NpZ25QdWJsaWNJcDogJ0RJU0FCTEVEJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBMb2FkQmFsYW5jZXJzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ29udGFpbmVyTmFtZTogJ3Rlc3RhcHAtY29udGFpbmVyJyxcbiAgICAgICAgICAgIENvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgICAgICAgICBUYXJnZXRHcm91cEFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRhcmdldCBncm91cCB3aXRoIGhlYWx0aCBjaGVja3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6VGFyZ2V0R3JvdXAnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXRlc3QtdGcnLFxuICAgICAgICBQb3J0OiA4MDAwLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFAnLFxuICAgICAgICBUYXJnZXRUeXBlOiAnaXAnLFxuICAgICAgICBIZWFsdGhDaGVja1BhdGg6ICcvaGVhbHRoLycsXG4gICAgICAgIEhlYWx0aENoZWNrUHJvdG9jb2w6ICdIVFRQJyxcbiAgICAgICAgSGVhbHRoQ2hlY2tJbnRlcnZhbFNlY29uZHM6IDMwLFxuICAgICAgICBIZWFsdGhDaGVja1RpbWVvdXRTZWNvbmRzOiA1LFxuICAgICAgICBIZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgIFVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgICAgICBNYXRjaGVyOiB7IEh0dHBDb2RlOiAnMjAwJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGFwcGxpY2F0aW9uIGF1dG8gc2NhbGluZyB0YXJnZXQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGFibGVUYXJnZXQnLCB7XG4gICAgICAgIFNlcnZpY2VOYW1lc3BhY2U6ICdlY3MnLFxuICAgICAgICBSZXNvdXJjZUlkOiB7XG4gICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgfSxcbiAgICAgICAgU2NhbGFibGVEaW1lbnNpb246ICdlY3M6c2VydmljZTpEZXNpcmVkQ291bnQnLFxuICAgICAgICBNaW5DYXBhY2l0eTogMSxcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDMsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ1BVLWJhc2VkIGF1dG8gc2NhbGluZyBwb2xpY3knLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipDcHVTY2FsaW5nLionKSxcbiAgICAgICAgUG9saWN5VHlwZTogJ1RhcmdldFRyYWNraW5nU2NhbGluZycsXG4gICAgICAgIFRhcmdldFRyYWNraW5nU2NhbGluZ1BvbGljeUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBUYXJnZXRWYWx1ZTogNzAsXG4gICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1NwZWNpZmljYXRpb246IHtcbiAgICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNUeXBlOiAnRUNTU2VydmljZUF2ZXJhZ2VDUFVVdGlsaXphdGlvbicsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBTY2FsZUluQ29vbGRvd246IDMwMCxcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxMjAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgbWVtb3J5LWJhc2VkIGF1dG8gc2NhbGluZyBwb2xpY3knLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipNZW1vcnlTY2FsaW5nLionKSxcbiAgICAgICAgUG9saWN5VHlwZTogJ1RhcmdldFRyYWNraW5nU2NhbGluZycsXG4gICAgICAgIFRhcmdldFRyYWNraW5nU2NhbGluZ1BvbGljeUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBUYXJnZXRWYWx1ZTogODAsXG4gICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1NwZWNpZmljYXRpb246IHtcbiAgICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNUeXBlOiAnRUNTU2VydmljZUF2ZXJhZ2VNZW1vcnlVdGlsaXphdGlvbicsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBTY2FsZUluQ29vbGRvd246IDMwMCxcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxMjAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcmVxdWVzdC1iYXNlZCBhdXRvIHNjYWxpbmcgcG9saWN5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qUmVxdWVzdFNjYWxpbmcuKicpLFxuICAgICAgICBQb2xpY3lUeXBlOiAnVGFyZ2V0VHJhY2tpbmdTY2FsaW5nJyxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiAxMDAwLCAvLyBEZWZhdWx0IHZhbHVlXG4gICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1NwZWNpZmljYXRpb246IHtcbiAgICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNUeXBlOiAnQUxCUmVxdWVzdENvdW50UGVyVGFyZ2V0JyxcbiAgICAgICAgICAgIFJlc291cmNlTGFiZWw6IHtcbiAgICAgICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYW55VmFsdWUoKSwgLy8gQ0RLIGdlbmVyYXRlcyBjb21wbGV4IEZuOjpKb2luIGZvciBBTEIvVGFyZ2V0R3JvdXAgcmVzb3VyY2UgbGFiZWxzXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgU2NhbGVJbkNvb2xkb3duOiAzMDAsXG4gICAgICAgICAgU2NhbGVPdXRDb29sZG93bjogMTIwLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdDdXN0b20gQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICAgIHNlcnZpY2VOYW1lOiAnY3VzdG9tLXNlcnZpY2UnLFxuICAgICAgICB0YXNrSW1hZ2VUYWc6ICd2MS4yLjMnLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDMsXG4gICAgICAgIGNwdTogMTAyNCxcbiAgICAgICAgbWVtb3J5TGltaXRNaUI6IDIwNDgsXG4gICAgICAgIGNvbnRhaW5lclBvcnQ6IDkwMDAsXG4gICAgICAgIGhlYWx0aENoZWNrUGF0aDogJy9jdXN0b20taGVhbHRoJyxcbiAgICAgICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogNjAsXG4gICAgICAgIGhlYWx0aENoZWNrVGltZW91dDogMTAsXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDUsXG4gICAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQ1VTVE9NX0VOVjogJ2N1c3RvbV92YWx1ZScsXG4gICAgICAgICAgREVCVUc6ICdmYWxzZScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIHNlcnZpY2UgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIFNlcnZpY2VOYW1lOiAnY3VzdG9tLXNlcnZpY2UnLFxuICAgICAgICBEZXNpcmVkQ291bnQ6IDMsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIHRhc2sgZGVmaW5pdGlvbiBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIEZhbWlseTogJ3Rlc3RhcHAtcHJvZHVjdGlvbicsXG4gICAgICAgIENwdTogJzEwMjQnLFxuICAgICAgICBNZW1vcnk6ICcyMDQ4JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gY29udGFpbmVyIGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBOYW1lOiAndGVzdGFwcC1jb250YWluZXInLFxuICAgICAgICAgICAgSW1hZ2U6IHtcbiAgICAgICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBQb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIENvbnRhaW5lclBvcnQ6IDkwMDAsXG4gICAgICAgICAgICAgICAgUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdodHRwJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBFbnZpcm9ubWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgeyBOYW1lOiAnQ1VTVE9NX0VOVicsIFZhbHVlOiAnY3VzdG9tX3ZhbHVlJyB9LFxuICAgICAgICAgICAgICB7IE5hbWU6ICdERUJVRycsIFZhbHVlOiAnZmFsc2UnIH0sXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIE1lbW9yeVJlc2VydmF0aW9uOiAxNjM4LCAvLyA4MCUgb2YgMjA0OFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBQb3J0OiA5MDAwLFxuICAgICAgICBIZWFsdGhDaGVja1BhdGg6ICcvY3VzdG9tLWhlYWx0aCcsXG4gICAgICAgIEhlYWx0aENoZWNrSW50ZXJ2YWxTZWNvbmRzOiA2MCxcbiAgICAgICAgSGVhbHRoQ2hlY2tUaW1lb3V0U2Vjb25kczogMTAsXG4gICAgICAgIEhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgVW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGF1dG8gc2NhbGluZyBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBNaW5DYXBhY2l0eTogMyxcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDksIC8vIDMgKiAzXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcHJvZHVjdGlvbiByZXF1ZXN0IGNvdW50IGZvciBzY2FsaW5nJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qUmVxdWVzdFNjYWxpbmcuKicpLFxuICAgICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVGFyZ2V0VmFsdWU6IDEwMDAsIC8vIERlZmF1bHQgdmFsdWVcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ29udGFpbmVyIFNlY3VyaXR5IEZlYXR1cmVzJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogdHJ1ZSxcbiAgICAgICAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbTogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY29uZmlndXJlcyBub24tcm9vdCB1c2VyJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVXNlcjogJzEwMDE6MTAwMScsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZW5hYmxlcyByZWFkLW9ubHkgcm9vdCBmaWxlc3lzdGVtJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgUmVhZG9ubHlSb290RmlsZXN5c3RlbTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRtcGZzIHZvbHVtZXMgZm9yIHJlYWQtb25seSBmaWxlc3lzdGVtJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIFZvbHVtZXM6IFtcbiAgICAgICAgICB7IE5hbWU6ICd0bXAtdm9sdW1lJywgSG9zdDoge30gfSxcbiAgICAgICAgICB7IE5hbWU6ICdsb2dzLXZvbHVtZScsIEhvc3Q6IHt9IH0sXG4gICAgICAgIF0sXG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgTW91bnRQb2ludHM6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFNvdXJjZVZvbHVtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICAgICAgICAgIENvbnRhaW5lclBhdGg6ICcvdG1wJyxcbiAgICAgICAgICAgICAgICBSZWFkT25seTogZmFsc2UsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBTb3VyY2VWb2x1bWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgICAgICAgICAgQ29udGFpbmVyUGF0aDogJy9hcHAvbG9ncycsXG4gICAgICAgICAgICAgICAgUmVhZE9ubHk6IGZhbHNlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdBdXRvIFNjYWxpbmcgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIG1pbkNhcGFjaXR5OiAyLFxuICAgICAgICBtYXhDYXBhY2l0eTogMTAsXG4gICAgICAgIGNwdVRhcmdldFV0aWxpemF0aW9uOiA2MCxcbiAgICAgICAgbWVtb3J5VGFyZ2V0VXRpbGl6YXRpb246IDc1LFxuICAgICAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiAxMCxcbiAgICAgICAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM6IDMsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGNhcGFjaXR5IGxpbWl0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsYWJsZVRhcmdldCcsIHtcbiAgICAgICAgTWluQ2FwYWNpdHk6IDIsXG4gICAgICAgIE1heENhcGFjaXR5OiAxMCxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gQ1BVIHNjYWxpbmcgdGFyZ2V0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qQ3B1U2NhbGluZy4qJyksXG4gICAgICAgIFRhcmdldFRyYWNraW5nU2NhbGluZ1BvbGljeUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBUYXJnZXRWYWx1ZTogNjAsXG4gICAgICAgICAgU2NhbGVJbkNvb2xkb3duOiA2MDAsIC8vIDEwIG1pbnV0ZXNcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxODAsIC8vIDMgbWludXRlc1xuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIGN1c3RvbSBtZW1vcnkgc2NhbGluZyB0YXJnZXQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipNZW1vcnlTY2FsaW5nLionKSxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiA3NSxcbiAgICAgICAgICBTY2FsZUluQ29vbGRvd246IDYwMCxcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxODAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0hUVFBTIExpc3RlbmVyIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBodHRwc0xpc3RlbmVyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxpc3RlbmVyL2FwcC90ZXN0YXBwLWFsYi10ZXN0LzEyMzQ1Njc4OTAxMjM0NTYvOTg3NjU0MzIxMDk4NzY1NCcsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3Quc2tpcCgnY3JlYXRlcyBsaXN0ZW5lciBydWxlcyBmb3IgYm90aCBIVFRQIGFuZCBIVFRQUycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIExpc3RlbmVyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxpc3RlbmVyL2FwcC90ZXN0YXBwLWFsYi10ZXN0LzEyMzQ1Njc4OTAxMjM0NTYvMTIzNDU2Nzg5MDEyMzQ1NicsXG4gICAgICAgIFByaW9yaXR5OiAxMDAsXG4gICAgICAgIEFjdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBUeXBlOiAnZm9yd2FyZCcsXG4gICAgICAgICAgICBUYXJnZXRHcm91cEFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICBDb25kaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgRmllbGQ6ICdwYXRoLXBhdHRlcm4nLFxuICAgICAgICAgICAgVmFsdWVzOiBbJyonXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIExpc3RlbmVyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxpc3RlbmVyL2FwcC90ZXN0YXBwLWFsYi10ZXN0LzEyMzQ1Njc4OTAxMjM0NTYvOTg3NjU0MzIxMDk4NzY1NCcsXG4gICAgICAgIFByaW9yaXR5OiAxMDAsXG4gICAgICAgIEFjdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBUeXBlOiAnZm9yd2FyZCcsXG4gICAgICAgICAgICBUYXJnZXRHcm91cEFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICBDb25kaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgRmllbGQ6ICdwYXRoLXBhdHRlcm4nLFxuICAgICAgICAgICAgVmFsdWVzOiBbJyonXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdJQU0gUm9sZXMgYW5kIFBlcm1pc3Npb25zJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBleGVjdXRpb24gcm9sZSB3aXRoIGNvcnJlY3QgcG9saWNpZXMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgICBSb2xlTmFtZTogJ3Rlc3RhcHAtdGVzdC1leGVjdXRpb24tcm9sZScsXG4gICAgICAgIEFzc3VtZVJvbGVQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgIFN0YXRlbWVudDogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIFByaW5jaXBhbDogeyBTZXJ2aWNlOiAnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgICAgICAgIEFjdGlvbjogJ3N0czpBc3N1bWVSb2xlJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgTWFuYWdlZFBvbGljeUFybnM6IFtcbiAgICAgICAgICB7ICdGbjo6Sm9pbic6IFsnJywgWydhcm46JywgeyBSZWY6ICdBV1M6OlBhcnRpdGlvbicgfSwgJzppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5J11dIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgdGFzayByb2xlIHdpdGggY29ycmVjdCBwb2xpY2llcycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgICAgIFJvbGVOYW1lOiAndGVzdGFwcC10ZXN0LXRhc2stcm9sZScsXG4gICAgICAgIEFzc3VtZVJvbGVQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgIFN0YXRlbWVudDogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIFByaW5jaXBhbDogeyBTZXJ2aWNlOiAnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgICAgICAgIEFjdGlvbjogJ3N0czpBc3N1bWVSb2xlJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZXhlY3V0aW9uIHJvbGUgaGFzIEVDUiBhY2Nlc3MgcG9saWN5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6Um9sZScsIHtcbiAgICAgICAgUG9saWNpZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgICAgICBTdGF0ZW1lbnQ6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgICAgICBBY3Rpb246IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICAgICAgICAgICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJyxcbiAgICAgICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICAgICAgICAgICAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLFxuICAgICAgICAgICAgICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAgICAgICAgICAgXSksXG4gICAgICAgICAgICAgICAgICBSZXNvdXJjZTogJyonLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSksXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdyb2xlcyBoYXZlIHNlY3JldHMgbWFuYWdlciBhY2Nlc3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgICBQb2xpY2llczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgICAgIFN0YXRlbWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgICAgIEFjdGlvbjogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgICAgUmVzb3VyY2U6IE1hdGNoLmFueVZhbHVlKCksXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rhc2sgcm9sZSBoYXMgQ2xvdWRXYXRjaCBsb2dzIHBlcm1pc3Npb25zJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6Um9sZScsIHtcbiAgICAgICAgUG9saWNpZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgICAgICBTdGF0ZW1lbnQ6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgICAgICBBY3Rpb246IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgICAgICAgIFJlc291cmNlOiBNYXRjaC5hbnlWYWx1ZSgpLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSksXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdTZWNyZXRzIE1hbmFnZXIgSW50ZWdyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHNlY3JldHMgbWFuYWdlciBzZWNyZXQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtdGVzdC1hcHAtc2VjcmV0cycsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCB0ZXN0IGVudmlyb25tZW50JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncHJvZHVjdGlvbiBzZWNyZXRzIGhhdmUgcmV0YWluIHJlbW92YWwgcG9saWN5JywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZSgnQVdTOjpTZWNyZXRzTWFuYWdlcjo6U2VjcmV0Jywge1xuICAgICAgICBEZWxldGlvblBvbGljeTogJ1JldGFpbicsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ25vbi1wcm9kdWN0aW9uIHNlY3JldHMgaGF2ZSBkZXN0cm95IHJlbW92YWwgcG9saWN5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2UoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdEZWxldGUnLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFQ1MgU2VydmljZSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIHRlc3QoJ2VuYWJsZXMgRUNTIEV4ZWMgZm9yIG5vbi1wcm9kdWN0aW9uIGVudmlyb25tZW50cycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBFbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZGlzYWJsZXMgRUNTIEV4ZWMgZm9yIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIEVuYWJsZUV4ZWN1dGVDb21tYW5kOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBkaWZmZXJlbnQgZGVwbG95bWVudCBjb25maWd1cmF0aW9uIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBEZXBsb3ltZW50Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1heGltdW1QZXJjZW50OiAyMDAsXG4gICAgICAgICAgTWluaW11bUhlYWx0aHlQZXJjZW50OiAxMDAsIC8vIFplcm8tZG93bnRpbWUgZGVwbG95bWVudHMgZm9yIHByb2R1Y3Rpb25cbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyByZWxheGVkIGRlcGxveW1lbnQgY29uZmlndXJhdGlvbiBmb3Igbm9uLXByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ2RldicsIC8vIE5vbi1wcm9kdWN0aW9uIGVudmlyb25tZW50XG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgRGVwbG95bWVudENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNYXhpbXVtUGVyY2VudDogMTUwLCAvLyBDb3N0LWVmZmVjdGl2ZSBmb3IgZGV2L3N0YWdpbmdcbiAgICAgICAgICBNaW5pbXVtSGVhbHRoeVBlcmNlbnQ6IDUwLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdTdGFjayBPdXRwdXRzJywgKCkgPT4ge1xuICAgIGxldCBzdGFjazogQXBwbGljYXRpb25TdGFjaztcblxuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZGVzaXJlZENvdW50OiAyLFxuICAgICAgICBjcHU6IDUxMixcbiAgICAgICAgbWVtb3J5TGltaXRNaUI6IDEwMjQsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgc2VydmljZSBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdTZXJ2aWNlQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stU2VydmljZUFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1NlcnZpY2VOYW1lJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVNlcnZpY2VOYW1lJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRhc2sgZGVmaW5pdGlvbiBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdUYXNrRGVmaW5pdGlvbkFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1MgVGFzayBEZWZpbml0aW9uIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stVGFza0RlZmluaXRpb25Bcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdUYXNrRGVmaW5pdGlvbkZhbWlseScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1MgVGFzayBEZWZpbml0aW9uIEZhbWlseScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stVGFza0RlZmluaXRpb25GYW1pbHknIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgdGFyZ2V0IGdyb3VwIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1RhcmdldEdyb3VwQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFRhcmdldCBHcm91cCBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVRhcmdldEdyb3VwQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVGFyZ2V0R3JvdXBOYW1lJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFRhcmdldCBHcm91cCBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1UYXJnZXRHcm91cE5hbWUnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgc2VjcmV0cyBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdTZWNyZXRzQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFNlY3JldHMgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1TZWNyZXRzQXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGF1dG8gc2NhbGluZyBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdBdXRvU2NhbGluZ1RhcmdldElkJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0F1dG8gU2NhbGluZyBUYXJnZXQgSUQnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLUF1dG9TY2FsaW5nVGFyZ2V0SWQnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY29uZmlndXJhdGlvbiBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdEZXNpcmVkQ291bnQnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ3VycmVudCBEZXNpcmVkIENvdW50JyxcbiAgICAgICAgVmFsdWU6ICcyJyxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1Rhc2tDcHUnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnVGFzayBDUFUgVW5pdHMnLFxuICAgICAgICBWYWx1ZTogJzUxMicsXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdUYXNrTWVtb3J5Jywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1Rhc2sgTWVtb3J5IChNaUIpJyxcbiAgICAgICAgVmFsdWU6ICcxMDI0JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnUmVzb3VyY2UgVGFnZ2luZycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rhc2sgZGVmaW5pdGlvbiBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3RhcmdldCBncm91cCBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdFQ1Mgc2VydmljZSBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnc2VjcmV0cyBoYXZlIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTZWNyZXRzTWFuYWdlcjo6U2VjcmV0Jywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESy1TT1BTJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnSUFNIHJvbGVzIGhhdmUgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6Um9sZScsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnRXJyb3IgSGFuZGxpbmcgYW5kIEVkZ2UgQ2FzZXMnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBtaW5pbWFsIGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3QgbWluaW1hbFByb3BzID0ge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgIHByaXZhdGVTdWJuZXRJZHM6IFsnc3VibmV0LTQ0NDQ0NDQ0J10sXG4gICAgICAgIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkOiAnc2ctODc2NTQzMjEnLFxuICAgICAgICBjbHVzdGVyQXJuOiAnYXJuOmF3czplY3M6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpjbHVzdGVyL3Rlc3QtY2x1c3RlcicsXG4gICAgICAgIGNsdXN0ZXJOYW1lOiAndGVzdC1jbHVzdGVyJyxcbiAgICAgICAgcmVwb3NpdG9yeVVyaTogJzEyMzQ1Njc4OTAxMi5ka3IuZWNyLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tL3Rlc3QtcmVwbycsXG4gICAgICAgIGxvYWRCYWxhbmNlckFybjogJ2Fybjphd3M6ZWxhc3RpY2xvYWRiYWxhbmNpbmc6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsb2FkYmFsYW5jZXIvYXBwL3Rlc3QtYWxiLzEyMycsXG4gICAgICAgIGh0dHBMaXN0ZW5lckFybjogJ2Fybjphd3M6ZWxhc3RpY2xvYWRiYWxhbmNpbmc6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsaXN0ZW5lci9hcHAvdGVzdC1hbGIvMTIzLzQ1NicsXG4gICAgICAgIGxvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3QnLFxuICAgICAgICBsb2dHcm91cEFybjogJ2Fybjphd3M6bG9nczp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxvZy1ncm91cDovYXdzL2Vjcy90ZXN0JyxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfTtcblxuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBtaW5pbWFsUHJvcHMpO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgZGVmYXVsdCB2YWx1ZXMgZm9yIG9wdGlvbmFsIHBhcmFtZXRlcnMnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFNob3VsZCB1c2UgZGVmYXVsdHNcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIERlc2lyZWRDb3VudDogMSwgLy8gZGVmYXVsdFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgICBDcHU6ICcyNTYnLCAvLyBkZWZhdWx0XG4gICAgICAgIE1lbW9yeTogJzUxMicsIC8vIGRlZmF1bHRcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6VGFyZ2V0R3JvdXAnLCB7XG4gICAgICAgIFBvcnQ6IDgwMDAsIC8vIGRlZmF1bHRcbiAgICAgICAgSGVhbHRoQ2hlY2tQYXRoOiAnL2hlYWx0aC8nLCAvLyBkZWZhdWx0XG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgemVybyBkZXNpcmVkIGNvdW50JywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZGVzaXJlZENvdW50OiAwLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFplcm8gZGVzaXJlZCBjb3VudCBnZXRzIGFkanVzdGVkIHRvIG1pbmltdW0gb2YgMSBmb3Igc2FmZXR5XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBEZXNpcmVkQ291bnQ6IDEsXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBNaW5DYXBhY2l0eTogMSwgLy8gTWluaW11bSBlbmZvcmNlZCB0byAxIGZvciBzYWZldHlcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDMsIC8vIFVzZXMgTWF0aC5tYXgoMSwgZGVzaXJlZENvdW50KSAqIDNcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBjdXN0b20gYXV0byBzY2FsaW5nIGxpbWl0cycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGRlc2lyZWRDb3VudDogMixcbiAgICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICAgIG1heENhcGFjaXR5OiAyMCxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGFibGVUYXJnZXQnLCB7XG4gICAgICAgIE1pbkNhcGFjaXR5OiAxLCAvLyBDdXN0b20gbWluQ2FwYWNpdHkgb3ZlcnJpZGVzIGRlc2lyZWRDb3VudFxuICAgICAgICBNYXhDYXBhY2l0eTogMjAsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NvbnRhaW5lciBzZWN1cml0eSBmZWF0dXJlcyBkaXNhYmxlZCBieSBkZWZhdWx0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBVc2VyOiBNYXRjaC5hYnNlbnQoKSxcbiAgICAgICAgICAgIFJlYWRvbmx5Um9vdEZpbGVzeXN0ZW06IGZhbHNlLCAvLyBFeHBsaWNpdGx5IHNldCB0byBmYWxzZSBieSBkZWZhdWx0XG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIFZvbHVtZXM6IE1hdGNoLmFic2VudCgpLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdubyB0bXBmcyB2b2x1bWVzIHdoZW4gcmVhZC1vbmx5IGZpbGVzeXN0ZW0gZGlzYWJsZWQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIE1vdW50UG9pbnRzOiBNYXRjaC5hYnNlbnQoKSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBIVFRQUyBsaXN0ZW5lciBub3QgcHJvdmlkZWQnLCAoKSA9PiB7XG4gICAgICAvLyBTaG91bGQgb25seSBjcmVhdGUgb25lIGxpc3RlbmVyIHJ1bGUgKEhUVFApXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZVByb3BlcnRpZXNDb3VudElzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyUnVsZScsIHtcbiAgICAgICAgTGlzdGVuZXJBcm46IGRlZmF1bHRQcm9wcy5odHRwTGlzdGVuZXJBcm4sXG4gICAgICB9LCAxKTtcblxuICAgICAgLy8gU2hvdWxkIG5vdCBjcmVhdGUgSFRUUFMgbGlzdGVuZXIgcnVsZVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyUnVsZScsIDEpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnRG9tYWluIE5hbWUgR2VuZXJhdGlvbicsICgpID0+IHtcbiAgICB0ZXN0KCdoYW5kbGVzIFBSIGRlcGxveW1lbnQgZG9tYWluIGdlbmVyYXRpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgLy8gQ3JlYXRlIHN0YWNrIHdpdGggUFIgY29uZmlndXJhdGlvbiBidXQgbm8gaG9zdGVkWm9uZUlkIHNvIG5vIEROUyByZWNvcmRzIGFyZSBjcmVhdGVkXG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgIGFwcE5hbWU6ICdteWFwcCcsXG4gICAgICAgIHBySWQ6ICcxMjMnLFxuICAgICAgICAvLyBob3N0ZWRab25lSWQgaW50ZW50aW9uYWxseSBvbWl0dGVkIHRvIGF2b2lkIEROUyByZWNvcmQgY3JlYXRpb25cbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBTaG91bGQgbm90IGNyZWF0ZSBETlMgcmVjb3JkcyBidXQgc2hvdWxkIGhhbmRsZSBQUiBkb21haW4gbG9naWNcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpSb3V0ZTUzOjpSZWNvcmRTZXQnLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgcHJvZHVjdGlvbiBkb21haW4gZ2VuZXJhdGlvbicsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICAvLyBDcmVhdGUgc3RhY2sgd2l0aCBwcm9kdWN0aW9uIGNvbmZpZ3VyYXRpb24gYnV0IG5vIGhvc3RlZFpvbmVJZCBzbyBubyBETlMgcmVjb3JkcyBhcmUgY3JlYXRlZFxuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBiYXNlRG9tYWluOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBhcHBOYW1lOiAnbXlhcHAnLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICAvLyBob3N0ZWRab25lSWQgaW50ZW50aW9uYWxseSBvbWl0dGVkIHRvIGF2b2lkIEROUyByZWNvcmQgY3JlYXRpb25cbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBTaG91bGQgbm90IGNyZWF0ZSBETlMgcmVjb3JkcyBidXQgc2hvdWxkIGhhbmRsZSBwcm9kdWN0aW9uIGRvbWFpbiBsb2dpY1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OlJvdXRlNTM6OlJlY29yZFNldCcsIDApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnUm91dGU1MyBETlMgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICB0ZXN0KCdkb2VzIG5vdCBjcmVhdGUgRE5TIHJlY29yZHMgd2hlbiBkb21haW4gY29uZmlndXJhdGlvbiBtaXNzaW5nJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgLy8gTm8gZG9tYWluIGNvbmZpZ3VyYXRpb24gcHJvdmlkZWRcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBTaG91bGQgbm90IGNyZWF0ZSBhbnkgUm91dGU1MyByZWNvcmRzXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6Um91dGU1Mzo6UmVjb3JkU2V0JywgMCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdkb2VzIG5vdCBjcmVhdGUgRE5TIHJlY29yZHMgd2hlbiBob3N0ZWRab25lSWQgbWlzc2luZycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgIGFwcE5hbWU6ICdteWFwcCcsXG4gICAgICAgIC8vIGhvc3RlZFpvbmVJZCBub3QgcHJvdmlkZWRcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBTaG91bGQgbm90IGNyZWF0ZSBhbnkgUm91dGU1MyByZWNvcmRzXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6Um91dGU1Mzo6UmVjb3JkU2V0JywgMCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdBcHBsaWNhdGlvbiBVUkwgT3V0cHV0IENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgdGVzdCgnY3JlYXRlcyBhcHBsaWNhdGlvbiBVUkwgb3V0cHV0cyBjb3JyZWN0bHknLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICAvLyBVc2UgZGVmYXVsdCBjb25maWd1cmF0aW9uIHRvIHRlc3QgVVJMIG91dHB1dCBnZW5lcmF0aW9uXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgLy8gU2hvdWxkIGNyZWF0ZSBBcHBsaWNhdGlvblVybCBvdXRwdXQgd2l0aCBBTEIgRE5TIG5hbWVcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMIChBTEIgRE5TKScsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1NPUFMgSW50ZWdyYXRpb24gRXJyb3IgSGFuZGxpbmcnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBTT1BTIGxvYWRpbmcgZmFpbHVyZSBncmFjZWZ1bGx5JywgKCkgPT4ge1xuICAgICAgLy8gVGhpcyB0ZXN0IHNpbXVsYXRlcyB0aGUgZXJyb3IgaGFuZGxpbmcgcGF0aCBpbiBjcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldFxuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIFxuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcblxuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2sobmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2syJywgZGVmYXVsdFByb3BzKSk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBzdGlsbCBjcmVhdGUgYSBzZWNyZXQgZXZlbiBpZiBTT1BTIGZhaWxzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtdGVzdC1hcHAtc2VjcmV0cycsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59KTsiXX0=