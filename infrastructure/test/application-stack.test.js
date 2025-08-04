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
        test.skip('creates request-based auto scaling policy', () => {
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
                PolicyName: assertions_1.Match.stringLikeRegexp('.*RequestScaling.*'),
                PolicyType: 'TargetTrackingScaling',
                TargetTrackingScalingPolicyConfiguration: {
                    TargetValue: 500,
                    PredefinedMetricSpecification: {
                        PredefinedMetricType: 'ALBRequestCountPerTarget',
                        ResourceLabel: {
                            'Fn::Sub': [
                                '${loadBalancerFullName}/${targetGroupFullName}',
                                {
                                    loadBalancerFullName: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'LoadBalancerFullName'] },
                                    targetGroupFullName: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'TargetGroupFullName'] },
                                },
                            ],
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
        test.skip('uses production request count for scaling', () => {
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
                PolicyName: assertions_1.Match.stringLikeRegexp('.*RequestScaling.*'),
                TargetTrackingScalingPolicyConfiguration: {
                    TargetValue: 1000, // Production environment
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2sudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFwcGxpY2F0aW9uLXN0YWNrLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtQ0FBbUM7QUFDbkMsdURBQXlEO0FBQ3pELGdFQUE0RDtBQUU1RCxRQUFRLENBQUMsa0JBQWtCLEVBQUUsR0FBRyxFQUFFO0lBQ2hDLElBQUksR0FBWSxDQUFDO0lBQ2pCLElBQUksUUFBa0IsQ0FBQztJQUV2QixrREFBa0Q7SUFDbEQsU0FBUyxDQUFDLEdBQUcsRUFBRTtRQUNiLG1EQUFtRDtRQUNuRCxPQUFPLENBQUMsR0FBRyxDQUFDLHNCQUFzQixHQUFHLDZCQUE2QixDQUFDO1FBQ25FLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxHQUFHLDZCQUE2QixDQUFDO1FBQ3ZELE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLEdBQUcsdUJBQXVCLENBQUM7UUFDdkQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsR0FBRyxjQUFjLENBQUM7UUFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLEdBQUcscUJBQXFCLENBQUM7UUFDbkQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFlLEdBQUcsa0JBQWtCLENBQUM7UUFDakQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLEdBQUcsaUJBQWlCLENBQUM7SUFDN0MsQ0FBQyxDQUFDLENBQUM7SUFFSCxRQUFRLENBQUMsR0FBRyxFQUFFO1FBQ1osc0NBQXNDO1FBQ3RDLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsQ0FBQztRQUMxQyxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDO1FBQzlCLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQztRQUNwQyxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUM7UUFDcEMsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBQztRQUNsQyxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZSxDQUFDO1FBQ25DLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUM7SUFDaEMsQ0FBQyxDQUFDLENBQUM7SUFFSCxNQUFNLFlBQVksR0FBRztRQUNuQixXQUFXLEVBQUUsTUFBTTtRQUNuQixLQUFLLEVBQUUsY0FBYztRQUNyQixnQkFBZ0IsRUFBRSxDQUFDLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixDQUFDO1FBQzNFLDBCQUEwQixFQUFFLGFBQWE7UUFDekMsVUFBVSxFQUFFLGlFQUFpRTtRQUM3RSxXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLGFBQWEsRUFBRSwyREFBMkQ7UUFDMUUsZUFBZSxFQUFFLHdHQUF3RztRQUN6SCxlQUFlLEVBQUUscUhBQXFIO1FBQ3RJLFlBQVksRUFBRSx1QkFBdUI7UUFDckMsV0FBVyxFQUFFLHFFQUFxRTtRQUNsRixTQUFTLEVBQUUsc0JBQXNCO1FBQ2pDLEdBQUcsRUFBRTtZQUNILE9BQU8sRUFBRSxjQUFjO1lBQ3ZCLE1BQU0sRUFBRSxXQUFXO1NBQ3BCO0tBQ0YsQ0FBQztJQUVGLFFBQVEsQ0FBQyxpQ0FBaUMsRUFBRSxHQUFHLEVBQUU7UUFDL0MsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNwQixNQUFNLEtBQUssR0FBRyxJQUFJLG9DQUFnQixDQUFDLEdBQUcsRUFBRSxzQkFBc0IsRUFBRSxZQUFZLENBQUMsQ0FBQztZQUM5RSxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsb0RBQW9ELEVBQUUsR0FBRyxFQUFFO1lBQzlELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQkFBMEIsRUFBRTtnQkFDekQsTUFBTSxFQUFFLGNBQWM7Z0JBQ3RCLFdBQVcsRUFBRSxRQUFRO2dCQUNyQix1QkFBdUIsRUFBRSxDQUFDLFNBQVMsQ0FBQztnQkFDcEMsR0FBRyxFQUFFLEtBQUs7Z0JBQ1YsTUFBTSxFQUFFLEtBQUs7Z0JBQ2IsZ0JBQWdCLEVBQUUsRUFBRSxZQUFZLEVBQUUsQ0FBQyxrQkFBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLEtBQUssQ0FBQyxFQUFFO2dCQUM3RCxXQUFXLEVBQUUsRUFBRSxZQUFZLEVBQUUsQ0FBQyxrQkFBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLEtBQUssQ0FBQyxFQUFFO2FBQ3pELENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLHlEQUF5RCxFQUFFLEdBQUcsRUFBRTtZQUNuRSxRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7Z0JBQ3pELG9CQUFvQixFQUFFO29CQUNwQjt3QkFDRSxJQUFJLEVBQUUsbUJBQW1CO3dCQUN6QixLQUFLLEVBQUU7NEJBQ0wsVUFBVSxFQUFFLGtCQUFLLENBQUMsUUFBUSxFQUFFO3lCQUM3Qjt3QkFDRCxZQUFZLEVBQUU7NEJBQ1o7Z0NBQ0UsYUFBYSxFQUFFLElBQUk7Z0NBQ25CLFFBQVEsRUFBRSxLQUFLO2dDQUNmLElBQUksRUFBRSxNQUFNOzZCQUNiO3lCQUNGO3dCQUNELFdBQVcsRUFBRTs0QkFDWCxFQUFFLElBQUksRUFBRSxrQkFBa0IsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFOzRCQUMzQyxFQUFFLElBQUksRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRTs0QkFDdEMsRUFBRSxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsS0FBSyxFQUFFLFdBQVcsRUFBRTt5QkFDbkQ7d0JBQ0QsT0FBTyxFQUFFOzRCQUNQO2dDQUNFLElBQUksRUFBRSxZQUFZO2dDQUNsQixTQUFTLEVBQUU7b0NBQ1QsVUFBVSxFQUFFLGtCQUFLLENBQUMsUUFBUSxFQUFFO2lDQUM3Qjs2QkFDRjt5QkFDRjt3QkFDRCxnQkFBZ0IsRUFBRTs0QkFDaEIsU0FBUyxFQUFFLFNBQVM7NEJBQ3BCLE9BQU8sRUFBRTtnQ0FDUCxlQUFlLEVBQUUsdUJBQXVCO2dDQUN4QyxnQkFBZ0IsRUFBRSxXQUFXO2dDQUM3Qix1QkFBdUIsRUFBRSxTQUFTOzZCQUNuQzt5QkFDRjt3QkFDRCxpQkFBaUIsRUFBRSxHQUFHLEVBQUUsYUFBYTtxQkFDdEM7aUJBQ0Y7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyx5QkFBeUIsRUFBRSxHQUFHLEVBQUU7WUFDbkMsUUFBUSxDQUFDLHFCQUFxQixDQUFDLG1CQUFtQixFQUFFO2dCQUNsRCxXQUFXLEVBQUUsc0JBQXNCO2dCQUNuQyxPQUFPLEVBQUUsc0JBQXNCO2dCQUMvQixjQUFjLEVBQUUsRUFBRSxHQUFHLEVBQUUsa0JBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRTtnQkFDekMsWUFBWSxFQUFFLENBQUM7Z0JBQ2YsVUFBVSxFQUFFLFNBQVM7Z0JBQ3JCLG9CQUFvQixFQUFFO29CQUNwQixtQkFBbUIsRUFBRTt3QkFDbkIsY0FBYyxFQUFFLENBQUMsYUFBYSxDQUFDO3dCQUMvQixPQUFPLEVBQUUsQ0FBQyxpQkFBaUIsRUFBRSxpQkFBaUIsRUFBRSxpQkFBaUIsQ0FBQzt3QkFDbEUsY0FBYyxFQUFFLFVBQVU7cUJBQzNCO2lCQUNGO2dCQUNELGFBQWEsRUFBRTtvQkFDYjt3QkFDRSxhQUFhLEVBQUUsbUJBQW1CO3dCQUNsQyxhQUFhLEVBQUUsSUFBSTt3QkFDbkIsY0FBYyxFQUFFLEVBQUUsR0FBRyxFQUFFLGtCQUFLLENBQUMsUUFBUSxFQUFFLEVBQUU7cUJBQzFDO2lCQUNGO2FBQ0YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMseUNBQXlDLEVBQUUsR0FBRyxFQUFFO1lBQ25ELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQ0FBMEMsRUFBRTtnQkFDekUsSUFBSSxFQUFFLGlCQUFpQjtnQkFDdkIsSUFBSSxFQUFFLElBQUk7Z0JBQ1YsUUFBUSxFQUFFLE1BQU07Z0JBQ2hCLFVBQVUsRUFBRSxJQUFJO2dCQUNoQixlQUFlLEVBQUUsVUFBVTtnQkFDM0IsbUJBQW1CLEVBQUUsTUFBTTtnQkFDM0IsMEJBQTBCLEVBQUUsRUFBRTtnQkFDOUIseUJBQXlCLEVBQUUsQ0FBQztnQkFDNUIscUJBQXFCLEVBQUUsQ0FBQztnQkFDeEIsdUJBQXVCLEVBQUUsQ0FBQztnQkFDMUIsT0FBTyxFQUFFLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRTthQUM3QixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyx5Q0FBeUMsRUFBRSxHQUFHLEVBQUU7WUFDbkQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDZDQUE2QyxFQUFFO2dCQUM1RSxnQkFBZ0IsRUFBRSxLQUFLO2dCQUN2QixVQUFVLEVBQUU7b0JBQ1YsVUFBVSxFQUFFLGtCQUFLLENBQUMsUUFBUSxFQUFFO2lCQUM3QjtnQkFDRCxpQkFBaUIsRUFBRSwwQkFBMEI7Z0JBQzdDLFdBQVcsRUFBRSxDQUFDO2dCQUNkLFdBQVcsRUFBRSxDQUFDO2FBQ2YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsdUNBQXVDLEVBQUUsR0FBRyxFQUFFO1lBQ2pELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0Q0FBNEMsRUFBRTtnQkFDM0UsVUFBVSxFQUFFLGtCQUFLLENBQUMsZ0JBQWdCLENBQUMsZ0JBQWdCLENBQUM7Z0JBQ3BELFVBQVUsRUFBRSx1QkFBdUI7Z0JBQ25DLHdDQUF3QyxFQUFFO29CQUN4QyxXQUFXLEVBQUUsRUFBRTtvQkFDZiw2QkFBNkIsRUFBRTt3QkFDN0Isb0JBQW9CLEVBQUUsaUNBQWlDO3FCQUN4RDtvQkFDRCxlQUFlLEVBQUUsR0FBRztvQkFDcEIsZ0JBQWdCLEVBQUUsR0FBRztpQkFDdEI7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQywwQ0FBMEMsRUFBRSxHQUFHLEVBQUU7WUFDcEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDRDQUE0QyxFQUFFO2dCQUMzRSxVQUFVLEVBQUUsa0JBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxtQkFBbUIsQ0FBQztnQkFDdkQsVUFBVSxFQUFFLHVCQUF1QjtnQkFDbkMsd0NBQXdDLEVBQUU7b0JBQ3hDLFdBQVcsRUFBRSxFQUFFO29CQUNmLDZCQUE2QixFQUFFO3dCQUM3QixvQkFBb0IsRUFBRSxvQ0FBb0M7cUJBQzNEO29CQUNELGVBQWUsRUFBRSxHQUFHO29CQUNwQixnQkFBZ0IsRUFBRSxHQUFHO2lCQUN0QjthQUNGLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLElBQUksQ0FBQywyQ0FBMkMsRUFBRSxHQUFHLEVBQUU7WUFDMUQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDRDQUE0QyxFQUFFO2dCQUMzRSxVQUFVLEVBQUUsa0JBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxvQkFBb0IsQ0FBQztnQkFDeEQsVUFBVSxFQUFFLHVCQUF1QjtnQkFDbkMsd0NBQXdDLEVBQUU7b0JBQ3hDLFdBQVcsRUFBRSxHQUFHO29CQUNoQiw2QkFBNkIsRUFBRTt3QkFDN0Isb0JBQW9CLEVBQUUsMEJBQTBCO3dCQUNoRCxhQUFhLEVBQUU7NEJBQ2IsU0FBUyxFQUFFO2dDQUNULGdEQUFnRDtnQ0FDaEQ7b0NBQ0Usb0JBQW9CLEVBQUUsRUFBRSxZQUFZLEVBQUUsQ0FBQyxrQkFBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLHNCQUFzQixDQUFDLEVBQUU7b0NBQ2xGLG1CQUFtQixFQUFFLEVBQUUsWUFBWSxFQUFFLENBQUMsa0JBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxxQkFBcUIsQ0FBQyxFQUFFO2lDQUNqRjs2QkFDRjt5QkFDRjtxQkFDRjtvQkFDRCxlQUFlLEVBQUUsR0FBRztvQkFDcEIsZ0JBQWdCLEVBQUUsR0FBRztpQkFDdEI7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLHNCQUFzQixFQUFFLEdBQUcsRUFBRTtRQUNwQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQ2QsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLFlBQVk7Z0JBQ3pCLFdBQVcsRUFBRSxnQkFBZ0I7Z0JBQzdCLFlBQVksRUFBRSxRQUFRO2dCQUN0QixZQUFZLEVBQUUsQ0FBQztnQkFDZixHQUFHLEVBQUUsSUFBSTtnQkFDVCxjQUFjLEVBQUUsSUFBSTtnQkFDcEIsYUFBYSxFQUFFLElBQUk7Z0JBQ25CLGVBQWUsRUFBRSxnQkFBZ0I7Z0JBQ2pDLG1CQUFtQixFQUFFLEVBQUU7Z0JBQ3ZCLGtCQUFrQixFQUFFLEVBQUU7Z0JBQ3RCLHFCQUFxQixFQUFFLENBQUM7Z0JBQ3hCLHVCQUF1QixFQUFFLENBQUM7Z0JBQzFCLG9CQUFvQixFQUFFO29CQUNwQixVQUFVLEVBQUUsY0FBYztvQkFDMUIsS0FBSyxFQUFFLE9BQU87aUJBQ2Y7YUFDRixDQUFDLENBQUM7WUFDSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsbUNBQW1DLEVBQUUsR0FBRyxFQUFFO1lBQzdDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRTtnQkFDbEQsV0FBVyxFQUFFLGdCQUFnQjtnQkFDN0IsWUFBWSxFQUFFLENBQUM7YUFDaEIsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsMkNBQTJDLEVBQUUsR0FBRyxFQUFFO1lBQ3JELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQkFBMEIsRUFBRTtnQkFDekQsTUFBTSxFQUFFLG9CQUFvQjtnQkFDNUIsR0FBRyxFQUFFLE1BQU07Z0JBQ1gsTUFBTSxFQUFFLE1BQU07YUFDZixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxxQ0FBcUMsRUFBRSxHQUFHLEVBQUU7WUFDL0MsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDBCQUEwQixFQUFFO2dCQUN6RCxvQkFBb0IsRUFBRTtvQkFDcEI7d0JBQ0UsSUFBSSxFQUFFLG1CQUFtQjt3QkFDekIsS0FBSyxFQUFFOzRCQUNMLFVBQVUsRUFBRSxrQkFBSyxDQUFDLFFBQVEsRUFBRTt5QkFDN0I7d0JBQ0QsWUFBWSxFQUFFOzRCQUNaO2dDQUNFLGFBQWEsRUFBRSxJQUFJO2dDQUNuQixRQUFRLEVBQUUsS0FBSztnQ0FDZixJQUFJLEVBQUUsTUFBTTs2QkFDYjt5QkFDRjt3QkFDRCxXQUFXLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7NEJBQzNCLEVBQUUsSUFBSSxFQUFFLFlBQVksRUFBRSxLQUFLLEVBQUUsY0FBYyxFQUFFOzRCQUM3QyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRTt5QkFDbEMsQ0FBQzt3QkFDRixpQkFBaUIsRUFBRSxJQUFJLEVBQUUsY0FBYztxQkFDeEM7aUJBQ0Y7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyx3Q0FBd0MsRUFBRSxHQUFHLEVBQUU7WUFDbEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDBDQUEwQyxFQUFFO2dCQUN6RSxJQUFJLEVBQUUsSUFBSTtnQkFDVixlQUFlLEVBQUUsZ0JBQWdCO2dCQUNqQywwQkFBMEIsRUFBRSxFQUFFO2dCQUM5Qix5QkFBeUIsRUFBRSxFQUFFO2dCQUM3QixxQkFBcUIsRUFBRSxDQUFDO2dCQUN4Qix1QkFBdUIsRUFBRSxDQUFDO2FBQzNCLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLHdDQUF3QyxFQUFFLEdBQUcsRUFBRTtZQUNsRCxRQUFRLENBQUMscUJBQXFCLENBQUMsNkNBQTZDLEVBQUU7Z0JBQzVFLFdBQVcsRUFBRSxDQUFDO2dCQUNkLFdBQVcsRUFBRSxDQUFDLEVBQUUsUUFBUTthQUN6QixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxJQUFJLENBQUMsMkNBQTJDLEVBQUUsR0FBRyxFQUFFO1lBQzFELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0Q0FBNEMsRUFBRTtnQkFDM0UsVUFBVSxFQUFFLGtCQUFLLENBQUMsZ0JBQWdCLENBQUMsb0JBQW9CLENBQUM7Z0JBQ3hELHdDQUF3QyxFQUFFO29CQUN4QyxXQUFXLEVBQUUsSUFBSSxFQUFFLHlCQUF5QjtpQkFDN0M7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLDZCQUE2QixFQUFFLEdBQUcsRUFBRTtRQUMzQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQ2QsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2Ysc0JBQXNCLEVBQUUsSUFBSTtnQkFDNUIsNEJBQTRCLEVBQUUsSUFBSTthQUNuQyxDQUFDLENBQUM7WUFDSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsMEJBQTBCLEVBQUUsR0FBRyxFQUFFO1lBQ3BDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQkFBMEIsRUFBRTtnQkFDekQsb0JBQW9CLEVBQUU7b0JBQ3BCO3dCQUNFLElBQUksRUFBRSxXQUFXO3FCQUNsQjtpQkFDRjthQUNGLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLG1DQUFtQyxFQUFFLEdBQUcsRUFBRTtZQUM3QyxRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7Z0JBQ3pELG9CQUFvQixFQUFFO29CQUNwQjt3QkFDRSxzQkFBc0IsRUFBRSxJQUFJO3FCQUM3QjtpQkFDRjthQUNGLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGdEQUFnRCxFQUFFLEdBQUcsRUFBRTtZQUMxRCxRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7Z0JBQ3pELE9BQU8sRUFBRTtvQkFDUCxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLEVBQUUsRUFBRTtvQkFDaEMsRUFBRSxJQUFJLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUU7aUJBQ2xDO2dCQUNELG9CQUFvQixFQUFFO29CQUNwQjt3QkFDRSxXQUFXLEVBQUU7NEJBQ1g7Z0NBQ0UsWUFBWSxFQUFFLFlBQVk7Z0NBQzFCLGFBQWEsRUFBRSxNQUFNO2dDQUNyQixRQUFRLEVBQUUsS0FBSzs2QkFDaEI7NEJBQ0Q7Z0NBQ0UsWUFBWSxFQUFFLGFBQWE7Z0NBQzNCLGFBQWEsRUFBRSxXQUFXO2dDQUMxQixRQUFRLEVBQUUsS0FBSzs2QkFDaEI7eUJBQ0Y7cUJBQ0Y7aUJBQ0Y7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLDRCQUE0QixFQUFFLEdBQUcsRUFBRTtRQUMxQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQ2QsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLENBQUM7Z0JBQ2QsV0FBVyxFQUFFLEVBQUU7Z0JBQ2Ysb0JBQW9CLEVBQUUsRUFBRTtnQkFDeEIsdUJBQXVCLEVBQUUsRUFBRTtnQkFDM0Isc0JBQXNCLEVBQUUsRUFBRTtnQkFDMUIsdUJBQXVCLEVBQUUsQ0FBQzthQUMzQixDQUFDLENBQUM7WUFDSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsNkJBQTZCLEVBQUUsR0FBRyxFQUFFO1lBQ3ZDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw2Q0FBNkMsRUFBRTtnQkFDNUUsV0FBVyxFQUFFLENBQUM7Z0JBQ2QsV0FBVyxFQUFFLEVBQUU7YUFDaEIsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsZ0NBQWdDLEVBQUUsR0FBRyxFQUFFO1lBQzFDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0Q0FBNEMsRUFBRTtnQkFDM0UsVUFBVSxFQUFFLGtCQUFLLENBQUMsZ0JBQWdCLENBQUMsZ0JBQWdCLENBQUM7Z0JBQ3BELHdDQUF3QyxFQUFFO29CQUN4QyxXQUFXLEVBQUUsRUFBRTtvQkFDZixlQUFlLEVBQUUsR0FBRztvQkFDcEIsZ0JBQWdCLEVBQUUsR0FBRyxFQUFFLFlBQVk7aUJBQ3BDO2FBQ0YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsbUNBQW1DLEVBQUUsR0FBRyxFQUFFO1lBQzdDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw0Q0FBNEMsRUFBRTtnQkFDM0UsVUFBVSxFQUFFLGtCQUFLLENBQUMsZ0JBQWdCLENBQUMsbUJBQW1CLENBQUM7Z0JBQ3ZELHdDQUF3QyxFQUFFO29CQUN4QyxXQUFXLEVBQUUsRUFBRTtvQkFDZixlQUFlLEVBQUUsR0FBRztvQkFDcEIsZ0JBQWdCLEVBQUUsR0FBRztpQkFDdEI7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLDhCQUE4QixFQUFFLEdBQUcsRUFBRTtRQUM1QyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQ2QsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsZ0JBQWdCLEVBQUUscUhBQXFIO2FBQ3hJLENBQUMsQ0FBQztZQUNILFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QyxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxJQUFJLENBQUMsZ0RBQWdELEVBQUUsR0FBRyxFQUFFO1lBQy9ELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywyQ0FBMkMsRUFBRTtnQkFDMUUsV0FBVyxFQUFFLHFIQUFxSDtnQkFDbEksUUFBUSxFQUFFLEdBQUc7Z0JBQ2IsT0FBTyxFQUFFO29CQUNQO3dCQUNFLElBQUksRUFBRSxTQUFTO3dCQUNmLGNBQWMsRUFBRSxFQUFFLEdBQUcsRUFBRSxrQkFBSyxDQUFDLFFBQVEsRUFBRSxFQUFFO3FCQUMxQztpQkFDRjtnQkFDRCxVQUFVLEVBQUU7b0JBQ1Y7d0JBQ0UsS0FBSyxFQUFFLGNBQWM7d0JBQ3JCLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQztxQkFDZDtpQkFDRjthQUNGLENBQUMsQ0FBQztZQUVILFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywyQ0FBMkMsRUFBRTtnQkFDMUUsV0FBVyxFQUFFLHFIQUFxSDtnQkFDbEksUUFBUSxFQUFFLEdBQUc7Z0JBQ2IsT0FBTyxFQUFFO29CQUNQO3dCQUNFLElBQUksRUFBRSxTQUFTO3dCQUNmLGNBQWMsRUFBRSxFQUFFLEdBQUcsRUFBRSxrQkFBSyxDQUFDLFFBQVEsRUFBRSxFQUFFO3FCQUMxQztpQkFDRjtnQkFDRCxVQUFVLEVBQUU7b0JBQ1Y7d0JBQ0UsS0FBSyxFQUFFLGNBQWM7d0JBQ3JCLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQztxQkFDZDtpQkFDRjthQUNGLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxRQUFRLENBQUMsMkJBQTJCLEVBQUUsR0FBRyxFQUFFO1FBQ3pDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUUsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLDhDQUE4QyxFQUFFLEdBQUcsRUFBRTtZQUN4RCxRQUFRLENBQUMscUJBQXFCLENBQUMsZ0JBQWdCLEVBQUU7Z0JBQy9DLFFBQVEsRUFBRSw2QkFBNkI7Z0JBQ3ZDLHdCQUF3QixFQUFFO29CQUN4QixTQUFTLEVBQUU7d0JBQ1Q7NEJBQ0UsTUFBTSxFQUFFLE9BQU87NEJBQ2YsU0FBUyxFQUFFLEVBQUUsT0FBTyxFQUFFLHlCQUF5QixFQUFFOzRCQUNqRCxNQUFNLEVBQUUsZ0JBQWdCO3lCQUN6QjtxQkFDRjtpQkFDRjtnQkFDRCxpQkFBaUIsRUFBRTtvQkFDakIsRUFBRSxVQUFVLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxNQUFNLEVBQUUsRUFBRSxHQUFHLEVBQUUsZ0JBQWdCLEVBQUUsRUFBRSxnRUFBZ0UsQ0FBQyxDQUFDLEVBQUU7aUJBQzVIO2FBQ0YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMseUNBQXlDLEVBQUUsR0FBRyxFQUFFO1lBQ25ELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsRUFBRTtnQkFDL0MsUUFBUSxFQUFFLHdCQUF3QjtnQkFDbEMsd0JBQXdCLEVBQUU7b0JBQ3hCLFNBQVMsRUFBRTt3QkFDVDs0QkFDRSxNQUFNLEVBQUUsT0FBTzs0QkFDZixTQUFTLEVBQUUsRUFBRSxPQUFPLEVBQUUseUJBQXlCLEVBQUU7NEJBQ2pELE1BQU0sRUFBRSxnQkFBZ0I7eUJBQ3pCO3FCQUNGO2lCQUNGO2FBQ0YsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsc0NBQXNDLEVBQUUsR0FBRyxFQUFFO1lBQ2hELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsRUFBRTtnQkFDL0MsUUFBUSxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO29CQUN4QixrQkFBSyxDQUFDLFVBQVUsQ0FBQzt3QkFDZixjQUFjLEVBQUU7NEJBQ2QsU0FBUyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO2dDQUN6QixrQkFBSyxDQUFDLFVBQVUsQ0FBQztvQ0FDZixNQUFNLEVBQUUsT0FBTztvQ0FDZixNQUFNLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7d0NBQ3RCLDJCQUEyQjt3Q0FDM0IsaUNBQWlDO3dDQUNqQyw0QkFBNEI7d0NBQzVCLG1CQUFtQjtxQ0FDcEIsQ0FBQztvQ0FDRixRQUFRLEVBQUUsR0FBRztpQ0FDZCxDQUFDOzZCQUNILENBQUM7eUJBQ0g7cUJBQ0YsQ0FBQztpQkFDSCxDQUFDO2FBQ0gsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsbUNBQW1DLEVBQUUsR0FBRyxFQUFFO1lBQzdDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsRUFBRTtnQkFDL0MsUUFBUSxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO29CQUN4QixrQkFBSyxDQUFDLFVBQVUsQ0FBQzt3QkFDZixjQUFjLEVBQUU7NEJBQ2QsU0FBUyxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO2dDQUN6QixrQkFBSyxDQUFDLFVBQVUsQ0FBQztvQ0FDZixNQUFNLEVBQUUsT0FBTztvQ0FDZixNQUFNLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7d0NBQ3RCLCtCQUErQjt3Q0FDL0IsK0JBQStCO3FDQUNoQyxDQUFDO29DQUNGLFFBQVEsRUFBRSxrQkFBSyxDQUFDLFFBQVEsRUFBRTtpQ0FDM0IsQ0FBQzs2QkFDSCxDQUFDO3lCQUNIO3FCQUNGLENBQUM7aUJBQ0gsQ0FBQzthQUNILENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLDJDQUEyQyxFQUFFLEdBQUcsRUFBRTtZQUNyRCxRQUFRLENBQUMscUJBQXFCLENBQUMsZ0JBQWdCLEVBQUU7Z0JBQy9DLFFBQVEsRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztvQkFDeEIsa0JBQUssQ0FBQyxVQUFVLENBQUM7d0JBQ2YsY0FBYyxFQUFFOzRCQUNkLFNBQVMsRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztnQ0FDekIsa0JBQUssQ0FBQyxVQUFVLENBQUM7b0NBQ2YsTUFBTSxFQUFFLE9BQU87b0NBQ2YsTUFBTSxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO3dDQUN0QixzQkFBc0I7d0NBQ3RCLG1CQUFtQjtxQ0FDcEIsQ0FBQztvQ0FDRixRQUFRLEVBQUUsa0JBQUssQ0FBQyxRQUFRLEVBQUU7aUNBQzNCLENBQUM7NkJBQ0gsQ0FBQzt5QkFDSDtxQkFDRixDQUFDO2lCQUNILENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLDZCQUE2QixFQUFFLEdBQUcsRUFBRTtRQUMzQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQ2QsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQzlFLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QyxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxnQ0FBZ0MsRUFBRSxHQUFHLEVBQUU7WUFDMUMsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDZCQUE2QixFQUFFO2dCQUM1RCxJQUFJLEVBQUUsMEJBQTBCO2dCQUNoQyxXQUFXLEVBQUUsa0RBQWtEO2FBQ2hFLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLCtDQUErQyxFQUFFLEdBQUcsRUFBRTtZQUN6RCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUU7Z0JBQzlELEdBQUcsWUFBWTtnQkFDZixXQUFXLEVBQUUsWUFBWTthQUMxQixDQUFDLENBQUM7WUFDSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7WUFFckMsUUFBUSxDQUFDLFdBQVcsQ0FBQyw2QkFBNkIsRUFBRTtnQkFDbEQsY0FBYyxFQUFFLFFBQVE7YUFDekIsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsb0RBQW9ELEVBQUUsR0FBRyxFQUFFO1lBQzlELFFBQVEsQ0FBQyxXQUFXLENBQUMsNkJBQTZCLEVBQUU7Z0JBQ2xELGNBQWMsRUFBRSxRQUFRO2FBQ3pCLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxRQUFRLENBQUMsMkJBQTJCLEVBQUUsR0FBRyxFQUFFO1FBQ3pDLElBQUksQ0FBQyxrREFBa0QsRUFBRSxHQUFHLEVBQUU7WUFDNUQsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLEtBQUs7YUFDbkIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRTtnQkFDbEQsb0JBQW9CLEVBQUUsSUFBSTthQUMzQixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxrQ0FBa0MsRUFBRSxHQUFHLEVBQUU7WUFDNUMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLFlBQVk7YUFDMUIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRTtnQkFDbEQsb0JBQW9CLEVBQUUsS0FBSzthQUM1QixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyx3REFBd0QsRUFBRSxHQUFHLEVBQUU7WUFDbEUsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLFlBQVk7YUFDMUIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRTtnQkFDbEQsdUJBQXVCLEVBQUU7b0JBQ3ZCLGNBQWMsRUFBRSxHQUFHO29CQUNuQixxQkFBcUIsRUFBRSxHQUFHLEVBQUUsMkNBQTJDO2lCQUN4RTthQUNGLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLDBEQUEwRCxFQUFFLEdBQUcsRUFBRTtZQUNwRSxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELHVCQUF1QixFQUFFO29CQUN2QixjQUFjLEVBQUUsR0FBRztvQkFDbkIscUJBQXFCLEVBQUUsRUFBRTtpQkFDMUI7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLGVBQWUsRUFBRSxHQUFHLEVBQUU7UUFDN0IsSUFBSSxLQUF1QixDQUFDO1FBRTVCLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUN4RCxHQUFHLFlBQVk7Z0JBQ2YsWUFBWSxFQUFFLENBQUM7Z0JBQ2YsR0FBRyxFQUFFLEdBQUc7Z0JBQ1IsY0FBYyxFQUFFLElBQUk7YUFDckIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLHlCQUF5QixFQUFFLEdBQUcsRUFBRTtZQUNuQyxRQUFRLENBQUMsU0FBUyxDQUFDLFlBQVksRUFBRTtnQkFDL0IsV0FBVyxFQUFFLGlCQUFpQjtnQkFDOUIsTUFBTSxFQUFFLEVBQUUsSUFBSSxFQUFFLGlDQUFpQyxFQUFFO2FBQ3BELENBQUMsQ0FBQztZQUVILFFBQVEsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFO2dCQUNoQyxXQUFXLEVBQUUsa0JBQWtCO2dCQUMvQixNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsa0NBQWtDLEVBQUU7YUFDckQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsaUNBQWlDLEVBQUUsR0FBRyxFQUFFO1lBQzNDLFFBQVEsQ0FBQyxTQUFTLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ3RDLFdBQVcsRUFBRSx5QkFBeUI7Z0JBQ3RDLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSx3Q0FBd0MsRUFBRTthQUMzRCxDQUFDLENBQUM7WUFFSCxRQUFRLENBQUMsU0FBUyxDQUFDLHNCQUFzQixFQUFFO2dCQUN6QyxXQUFXLEVBQUUsNEJBQTRCO2dCQUN6QyxNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsMkNBQTJDLEVBQUU7YUFDOUQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsOEJBQThCLEVBQUUsR0FBRyxFQUFFO1lBQ3hDLFFBQVEsQ0FBQyxTQUFTLENBQUMsZ0JBQWdCLEVBQUU7Z0JBQ25DLFdBQVcsRUFBRSw4QkFBOEI7Z0JBQzNDLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSxxQ0FBcUMsRUFBRTthQUN4RCxDQUFDLENBQUM7WUFFSCxRQUFRLENBQUMsU0FBUyxDQUFDLGlCQUFpQixFQUFFO2dCQUNwQyxXQUFXLEVBQUUsK0JBQStCO2dCQUM1QyxNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsc0NBQXNDLEVBQUU7YUFDekQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMseUJBQXlCLEVBQUUsR0FBRyxFQUFFO1lBQ25DLFFBQVEsQ0FBQyxTQUFTLENBQUMsWUFBWSxFQUFFO2dCQUMvQixXQUFXLEVBQUUseUJBQXlCO2dCQUN0QyxNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsaUNBQWlDLEVBQUU7YUFDcEQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsOEJBQThCLEVBQUUsR0FBRyxFQUFFO1lBQ3hDLFFBQVEsQ0FBQyxTQUFTLENBQUMscUJBQXFCLEVBQUU7Z0JBQ3hDLFdBQVcsRUFBRSx3QkFBd0I7Z0JBQ3JDLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSwwQ0FBMEMsRUFBRTthQUM3RCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQywrQkFBK0IsRUFBRSxHQUFHLEVBQUU7WUFDekMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxjQUFjLEVBQUU7Z0JBQ2pDLFdBQVcsRUFBRSx1QkFBdUI7Z0JBQ3BDLEtBQUssRUFBRSxHQUFHO2FBQ1gsQ0FBQyxDQUFDO1lBRUgsUUFBUSxDQUFDLFNBQVMsQ0FBQyxTQUFTLEVBQUU7Z0JBQzVCLFdBQVcsRUFBRSxnQkFBZ0I7Z0JBQzdCLEtBQUssRUFBRSxLQUFLO2FBQ2IsQ0FBQyxDQUFDO1lBRUgsUUFBUSxDQUFDLFNBQVMsQ0FBQyxZQUFZLEVBQUU7Z0JBQy9CLFdBQVcsRUFBRSxtQkFBbUI7Z0JBQ2hDLEtBQUssRUFBRSxNQUFNO2FBQ2QsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVILFFBQVEsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7UUFDaEMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNwQixNQUFNLEtBQUssR0FBRyxJQUFJLG9DQUFnQixDQUFDLEdBQUcsRUFBRSxzQkFBc0IsRUFBRTtnQkFDOUQsR0FBRyxZQUFZO2dCQUNmLFdBQVcsRUFBRSxZQUFZO2FBQzFCLENBQUMsQ0FBQztZQUNILFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2QyxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxrQ0FBa0MsRUFBRSxHQUFHLEVBQUU7WUFDNUMsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDBCQUEwQixFQUFFO2dCQUN6RCxJQUFJLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7b0JBQ3BCLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsWUFBWSxFQUFFO2lCQUM1QyxDQUFDO2FBQ0gsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsK0JBQStCLEVBQUUsR0FBRyxFQUFFO1lBQ3pDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQ0FBMEMsRUFBRTtnQkFDekUsSUFBSSxFQUFFLGtCQUFLLENBQUMsU0FBUyxDQUFDO29CQUNwQixFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRTtpQkFDNUMsQ0FBQzthQUNILENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLDhCQUE4QixFQUFFLEdBQUcsRUFBRTtZQUN4QyxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELElBQUksRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztvQkFDcEIsRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxZQUFZLEVBQUU7aUJBQzVDLENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQywyQkFBMkIsRUFBRSxHQUFHLEVBQUU7WUFDckMsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDZCQUE2QixFQUFFO2dCQUM1RCxJQUFJLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7b0JBQ3BCLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsWUFBWSxFQUFFO29CQUMzQyxFQUFFLEdBQUcsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRTtpQkFDeEMsQ0FBQzthQUNILENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLDZCQUE2QixFQUFFLEdBQUcsRUFBRTtZQUN2QyxRQUFRLENBQUMscUJBQXFCLENBQUMsZ0JBQWdCLEVBQUU7Z0JBQy9DLElBQUksRUFBRSxrQkFBSyxDQUFDLFNBQVMsQ0FBQztvQkFDcEIsRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxZQUFZLEVBQUU7aUJBQzVDLENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLCtCQUErQixFQUFFLEdBQUcsRUFBRTtRQUM3QyxJQUFJLENBQUMsK0JBQStCLEVBQUUsR0FBRyxFQUFFO1lBQ3pDLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNwQixNQUFNLFlBQVksR0FBRztnQkFDbkIsV0FBVyxFQUFFLE1BQU07Z0JBQ25CLEtBQUssRUFBRSxjQUFjO2dCQUNyQixnQkFBZ0IsRUFBRSxDQUFDLGlCQUFpQixDQUFDO2dCQUNyQywwQkFBMEIsRUFBRSxhQUFhO2dCQUN6QyxVQUFVLEVBQUUseURBQXlEO2dCQUNyRSxXQUFXLEVBQUUsY0FBYztnQkFDM0IsYUFBYSxFQUFFLHdEQUF3RDtnQkFDdkUsZUFBZSxFQUFFLG1GQUFtRjtnQkFDcEcsZUFBZSxFQUFFLG1GQUFtRjtnQkFDcEcsWUFBWSxFQUFFLGVBQWU7Z0JBQzdCLFdBQVcsRUFBRSw2REFBNkQ7Z0JBQzFFLFNBQVMsRUFBRSxzQkFBc0I7Z0JBQ2pDLEdBQUcsRUFBRTtvQkFDSCxPQUFPLEVBQUUsY0FBYztvQkFDdkIsTUFBTSxFQUFFLFdBQVc7aUJBQ3BCO2FBQ0YsQ0FBQztZQUVGLE1BQU0sQ0FBQyxHQUFHLEVBQUU7Z0JBQ1YsSUFBSSxvQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDbEUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ25CLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLDZDQUE2QyxFQUFFLEdBQUcsRUFBRTtZQUN2RCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxvQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUUsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLHNCQUFzQjtZQUN0QixRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELFlBQVksRUFBRSxDQUFDLEVBQUUsVUFBVTthQUM1QixDQUFDLENBQUM7WUFFSCxRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7Z0JBQ3pELEdBQUcsRUFBRSxLQUFLO2dCQUNWLE1BQU0sRUFBRSxLQUFLLEVBQUUsVUFBVTthQUMxQixDQUFDLENBQUM7WUFFSCxRQUFRLENBQUMscUJBQXFCLENBQUMsMENBQTBDLEVBQUU7Z0JBQ3pFLElBQUksRUFBRSxJQUFJO2dCQUNWLGVBQWUsRUFBRSxVQUFVLEVBQUUsVUFBVTthQUN4QyxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyw0QkFBNEIsRUFBRSxHQUFHLEVBQUU7WUFDdEMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsWUFBWSxFQUFFLENBQUM7YUFDaEIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLDhEQUE4RDtZQUM5RCxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELFlBQVksRUFBRSxDQUFDO2FBQ2hCLENBQUMsQ0FBQztZQUVILFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw2Q0FBNkMsRUFBRTtnQkFDNUUsV0FBVyxFQUFFLENBQUM7Z0JBQ2QsV0FBVyxFQUFFLENBQUMsRUFBRSxxQ0FBcUM7YUFDdEQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsb0NBQW9DLEVBQUUsR0FBRyxFQUFFO1lBQzlDLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNwQixNQUFNLEtBQUssR0FBRyxJQUFJLG9DQUFnQixDQUFDLEdBQUcsRUFBRSxzQkFBc0IsRUFBRTtnQkFDOUQsR0FBRyxZQUFZO2dCQUNmLFlBQVksRUFBRSxDQUFDO2dCQUNmLFdBQVcsRUFBRSxDQUFDO2dCQUNkLFdBQVcsRUFBRSxFQUFFO2FBQ2hCLENBQUMsQ0FBQztZQUNILFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUVyQyxRQUFRLENBQUMscUJBQXFCLENBQUMsNkNBQTZDLEVBQUU7Z0JBQzVFLFdBQVcsRUFBRSxDQUFDO2dCQUNkLFdBQVcsRUFBRSxFQUFFO2FBQ2hCLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGlEQUFpRCxFQUFFLEdBQUcsRUFBRTtZQUMzRCxRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7Z0JBQ3pELG9CQUFvQixFQUFFO29CQUNwQixrQkFBSyxDQUFDLFVBQVUsQ0FBQzt3QkFDZixJQUFJLEVBQUUsa0JBQUssQ0FBQyxNQUFNLEVBQUU7d0JBQ3BCLHNCQUFzQixFQUFFLEtBQUssRUFBRSxxQ0FBcUM7cUJBQ3JFLENBQUM7aUJBQ0g7Z0JBQ0QsT0FBTyxFQUFFLGtCQUFLLENBQUMsTUFBTSxFQUFFO2FBQ3hCLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLHFEQUFxRCxFQUFFLEdBQUcsRUFBRTtZQUMvRCxRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7Z0JBQ3pELG9CQUFvQixFQUFFO29CQUNwQixrQkFBSyxDQUFDLFVBQVUsQ0FBQzt3QkFDZixXQUFXLEVBQUUsa0JBQUssQ0FBQyxNQUFNLEVBQUU7cUJBQzVCLENBQUM7aUJBQ0g7YUFDRixDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxxQ0FBcUMsRUFBRSxHQUFHLEVBQUU7WUFDL0MsOENBQThDO1lBQzlDLFFBQVEsQ0FBQyx5QkFBeUIsQ0FBQywyQ0FBMkMsRUFBRTtnQkFDOUUsV0FBVyxFQUFFLFlBQVksQ0FBQyxlQUFlO2FBQzFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFFTix3Q0FBd0M7WUFDeEMsUUFBUSxDQUFDLGVBQWUsQ0FBQywyQ0FBMkMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUMzRSxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsUUFBUSxDQUFDLGlDQUFpQyxFQUFFLEdBQUcsRUFBRTtRQUMvQyxJQUFJLENBQUMseUNBQXlDLEVBQUUsR0FBRyxFQUFFO1lBQ25ELDRFQUE0RTtZQUM1RSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFFcEIsTUFBTSxDQUFDLEdBQUcsRUFBRTtnQkFDVixJQUFJLG9DQUFnQixDQUFDLEdBQUcsRUFBRSxzQkFBc0IsRUFBRSxZQUFZLENBQUMsQ0FBQztZQUNsRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFLENBQUM7WUFFakIsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHVCQUF1QixFQUFFLFlBQVksQ0FBQyxDQUFDLENBQUM7WUFFaEcsa0RBQWtEO1lBQ2xELFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyw2QkFBNkIsRUFBRTtnQkFDNUQsSUFBSSxFQUFFLDBCQUEwQjthQUNqQyxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBBcHBsaWNhdGlvblN0YWNrIH0gZnJvbSAnLi4vbGliL2FwcGxpY2F0aW9uLXN0YWNrJztcblxuZGVzY3JpYmUoJ0FwcGxpY2F0aW9uU3RhY2snLCAoKSA9PiB7XG4gIGxldCBhcHA6IGNkay5BcHA7XG4gIGxldCB0ZW1wbGF0ZTogVGVtcGxhdGU7XG5cbiAgLy8gU2V0IHVwIHRlc3QgZW52aXJvbm1lbnQgdG8gc2tpcCBTT1BTIGRlY3J5cHRpb25cbiAgYmVmb3JlQWxsKCgpID0+IHtcbiAgICAvLyBTZXQgdGVzdCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9yIFNPUFMgZmFsbGJhY2tcbiAgICBwcm9jZXNzLmVudi5BUFBMSUNBVElPTl9TRUNSRVRfS0VZID0gJ3Rlc3Qtc2VjcmV0LWtleS1mb3ItdGVzdGluZyc7XG4gICAgcHJvY2Vzcy5lbnYuSldUX1NFQ1JFVCA9ICd0ZXN0LWp3dC1zZWNyZXQtZm9yLXRlc3RpbmcnO1xuICAgIHByb2Nlc3MuZW52LlJFUVVJUkVEX1NFVFRJTkcgPSAndGVzdC1yZXF1aXJlZC1zZXR0aW5nJztcbiAgICBwcm9jZXNzLmVudi5FWFRFUk5BTF9BUElfS0VZID0gJ3Rlc3QtYXBpLWtleSc7XG4gICAgcHJvY2Vzcy5lbnYuV0VCSE9PS19TRUNSRVQgPSAndGVzdC13ZWJob29rLXNlY3JldCc7XG4gICAgcHJvY2Vzcy5lbnYuREFUQURPR19BUElfS0VZID0gJ3Rlc3QtZGF0YWRvZy1rZXknO1xuICAgIHByb2Nlc3MuZW52LlNFTlRSWV9EU04gPSAndGVzdC1zZW50cnktZHNuJztcbiAgfSk7XG5cbiAgYWZ0ZXJBbGwoKCkgPT4ge1xuICAgIC8vIENsZWFuIHVwIHRlc3QgZW52aXJvbm1lbnQgdmFyaWFibGVzXG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkFQUExJQ0FUSU9OX1NFQ1JFVF9LRVk7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkpXVF9TRUNSRVQ7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LlJFUVVJUkVEX1NFVFRJTkc7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LkVYVEVSTkFMX0FQSV9LRVk7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LldFQkhPT0tfU0VDUkVUO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5EQVRBRE9HX0FQSV9LRVk7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52LlNFTlRSWV9EU047XG4gIH0pO1xuXG4gIGNvbnN0IGRlZmF1bHRQcm9wcyA9IHtcbiAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICBwcml2YXRlU3VibmV0SWRzOiBbJ3N1Ym5ldC00NDQ0NDQ0NCcsICdzdWJuZXQtNTU1NTU1NTUnLCAnc3VibmV0LTY2NjY2NjY2J10sXG4gICAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6ICdzZy04NzY1NDMyMScsXG4gICAgY2x1c3RlckFybjogJ2Fybjphd3M6ZWNzOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6Y2x1c3Rlci90ZXN0YXBwLWNsdXN0ZXItdGVzdCcsXG4gICAgY2x1c3Rlck5hbWU6ICd0ZXN0YXBwLWNsdXN0ZXItdGVzdCcsXG4gICAgcmVwb3NpdG9yeVVyaTogJzEyMzQ1Njc4OTAxMi5ka3IuZWNyLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tL3Rlc3RhcHAtdGVzdCcsXG4gICAgbG9hZEJhbGFuY2VyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxvYWRiYWxhbmNlci9hcHAvdGVzdGFwcC1hbGItdGVzdC8xMjM0NTY3ODkwMTIzNDU2JyxcbiAgICBodHRwTGlzdGVuZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bGlzdGVuZXIvYXBwL3Rlc3RhcHAtYWxiLXRlc3QvMTIzNDU2Nzg5MDEyMzQ1Ni8xMjM0NTY3ODkwMTIzNDU2JyxcbiAgICBsb2dHcm91cE5hbWU6ICcvYXdzL2Vjcy90ZXN0YXBwLXRlc3QnLFxuICAgIGxvZ0dyb3VwQXJuOiAnYXJuOmF3czpsb2dzOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bG9nLWdyb3VwOi9hd3MvZWNzL3Rlc3RhcHAtdGVzdCcsXG4gICAgc3RhY2tOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLFxuICAgIGVudjoge1xuICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgIH0sXG4gIH07XG5cbiAgZGVzY3JpYmUoJ0Jhc2ljIEFwcGxpY2F0aW9uIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRhc2sgZGVmaW5pdGlvbiB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgICBGYW1pbHk6ICd0ZXN0YXBwLXRlc3QnLFxuICAgICAgICBOZXR3b3JrTW9kZTogJ2F3c3ZwYycsXG4gICAgICAgIFJlcXVpcmVzQ29tcGF0aWJpbGl0aWVzOiBbJ0ZBUkdBVEUnXSxcbiAgICAgICAgQ3B1OiAnMjU2JyxcbiAgICAgICAgTWVtb3J5OiAnNTEyJyxcbiAgICAgICAgRXhlY3V0aW9uUm9sZUFybjogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnQXJuJ10gfSxcbiAgICAgICAgVGFza1JvbGVBcm46IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ0FybiddIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY29udGFpbmVyIGRlZmluaXRpb24gd2l0aCBjb3JyZWN0IGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBOYW1lOiAndGVzdGFwcC1jb250YWluZXInLFxuICAgICAgICAgICAgSW1hZ2U6IHtcbiAgICAgICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBQb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIENvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgICAgICAgICAgICAgUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdodHRwJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBFbnZpcm9ubWVudDogW1xuICAgICAgICAgICAgICB7IE5hbWU6ICdSRVFVSVJFRF9TRVRUSU5HJywgVmFsdWU6ICd0ZXN0JyB9LFxuICAgICAgICAgICAgICB7IE5hbWU6ICdFTlZJUk9OTUVOVCcsIFZhbHVlOiAndGVzdCcgfSxcbiAgICAgICAgICAgICAgeyBOYW1lOiAnQVdTX0RFRkFVTFRfUkVHSU9OJywgVmFsdWU6ICd1cy1lYXN0LTEnIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgU2VjcmV0czogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgTmFtZTogJ1NFQ1JFVF9LRVknLFxuICAgICAgICAgICAgICAgIFZhbHVlRnJvbToge1xuICAgICAgICAgICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIExvZ0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgICAgTG9nRHJpdmVyOiAnYXdzbG9ncycsXG4gICAgICAgICAgICAgIE9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICAnYXdzbG9ncy1ncm91cCc6ICcvYXdzL2Vjcy90ZXN0YXBwLXRlc3QnLFxuICAgICAgICAgICAgICAgICdhd3Nsb2dzLXJlZ2lvbic6ICd1cy1lYXN0LTEnLFxuICAgICAgICAgICAgICAgICdhd3Nsb2dzLXN0cmVhbS1wcmVmaXgnOiAndGVzdGFwcCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgTWVtb3J5UmVzZXJ2YXRpb246IDQwOSwgLy8gODAlIG9mIDUxMlxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgRmFyZ2F0ZSBzZXJ2aWNlJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgU2VydmljZU5hbWU6ICd0ZXN0YXBwLXNlcnZpY2UtdGVzdCcsXG4gICAgICAgIENsdXN0ZXI6ICd0ZXN0YXBwLWNsdXN0ZXItdGVzdCcsXG4gICAgICAgIFRhc2tEZWZpbml0aW9uOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICBEZXNpcmVkQ291bnQ6IDEsXG4gICAgICAgIExhdW5jaFR5cGU6ICdGQVJHQVRFJyxcbiAgICAgICAgTmV0d29ya0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBBd3N2cGNDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICBTZWN1cml0eUdyb3VwczogWydzZy04NzY1NDMyMSddLFxuICAgICAgICAgICAgU3VibmV0czogWydzdWJuZXQtNDQ0NDQ0NDQnLCAnc3VibmV0LTU1NTU1NTU1JywgJ3N1Ym5ldC02NjY2NjY2NiddLFxuICAgICAgICAgICAgQXNzaWduUHVibGljSXA6ICdESVNBQkxFRCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgTG9hZEJhbGFuY2VyczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIENvbnRhaW5lck5hbWU6ICd0ZXN0YXBwLWNvbnRhaW5lcicsXG4gICAgICAgICAgICBDb250YWluZXJQb3J0OiA4MDAwLFxuICAgICAgICAgICAgVGFyZ2V0R3JvdXBBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyB0YXJnZXQgZ3JvdXAgd2l0aCBoZWFsdGggY2hlY2tzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LXRnJyxcbiAgICAgICAgUG9ydDogODAwMCxcbiAgICAgICAgUHJvdG9jb2w6ICdIVFRQJyxcbiAgICAgICAgVGFyZ2V0VHlwZTogJ2lwJyxcbiAgICAgICAgSGVhbHRoQ2hlY2tQYXRoOiAnL2hlYWx0aC8nLFxuICAgICAgICBIZWFsdGhDaGVja1Byb3RvY29sOiAnSFRUUCcsXG4gICAgICAgIEhlYWx0aENoZWNrSW50ZXJ2YWxTZWNvbmRzOiAzMCxcbiAgICAgICAgSGVhbHRoQ2hlY2tUaW1lb3V0U2Vjb25kczogNSxcbiAgICAgICAgSGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgICAgICBVbmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgTWF0Y2hlcjogeyBIdHRwQ29kZTogJzIwMCcgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBhcHBsaWNhdGlvbiBhdXRvIHNjYWxpbmcgdGFyZ2V0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBTZXJ2aWNlTmFtZXNwYWNlOiAnZWNzJyxcbiAgICAgICAgUmVzb3VyY2VJZDoge1xuICAgICAgICAgICdGbjo6Sm9pbic6IE1hdGNoLmFueVZhbHVlKCksXG4gICAgICAgIH0sXG4gICAgICAgIFNjYWxhYmxlRGltZW5zaW9uOiAnZWNzOnNlcnZpY2U6RGVzaXJlZENvdW50JyxcbiAgICAgICAgTWluQ2FwYWNpdHk6IDEsXG4gICAgICAgIE1heENhcGFjaXR5OiAzLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIENQVS1iYXNlZCBhdXRvIHNjYWxpbmcgcG9saWN5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qQ3B1U2NhbGluZy4qJyksXG4gICAgICAgIFBvbGljeVR5cGU6ICdUYXJnZXRUcmFja2luZ1NjYWxpbmcnLFxuICAgICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVGFyZ2V0VmFsdWU6IDcwLFxuICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgICBQcmVkZWZpbmVkTWV0cmljVHlwZTogJ0VDU1NlcnZpY2VBdmVyYWdlQ1BVVXRpbGl6YXRpb24nLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgU2NhbGVJbkNvb2xkb3duOiAzMDAsXG4gICAgICAgICAgU2NhbGVPdXRDb29sZG93bjogMTIwLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIG1lbW9yeS1iYXNlZCBhdXRvIHNjYWxpbmcgcG9saWN5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qTWVtb3J5U2NhbGluZy4qJyksXG4gICAgICAgIFBvbGljeVR5cGU6ICdUYXJnZXRUcmFja2luZ1NjYWxpbmcnLFxuICAgICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVGFyZ2V0VmFsdWU6IDgwLFxuICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgICBQcmVkZWZpbmVkTWV0cmljVHlwZTogJ0VDU1NlcnZpY2VBdmVyYWdlTWVtb3J5VXRpbGl6YXRpb24nLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgU2NhbGVJbkNvb2xkb3duOiAzMDAsXG4gICAgICAgICAgU2NhbGVPdXRDb29sZG93bjogMTIwLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0LnNraXAoJ2NyZWF0ZXMgcmVxdWVzdC1iYXNlZCBhdXRvIHNjYWxpbmcgcG9saWN5JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qUmVxdWVzdFNjYWxpbmcuKicpLFxuICAgICAgICBQb2xpY3lUeXBlOiAnVGFyZ2V0VHJhY2tpbmdTY2FsaW5nJyxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiA1MDAsIC8vIFRlc3QgZW52aXJvbm1lbnRcbiAgICAgICAgICBQcmVkZWZpbmVkTWV0cmljU3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1R5cGU6ICdBTEJSZXF1ZXN0Q291bnRQZXJUYXJnZXQnLFxuICAgICAgICAgICAgUmVzb3VyY2VMYWJlbDoge1xuICAgICAgICAgICAgICAnRm46OlN1Yic6IFtcbiAgICAgICAgICAgICAgICAnJHtsb2FkQmFsYW5jZXJGdWxsTmFtZX0vJHt0YXJnZXRHcm91cEZ1bGxOYW1lfScsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgbG9hZEJhbGFuY2VyRnVsbE5hbWU6IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ0xvYWRCYWxhbmNlckZ1bGxOYW1lJ10gfSxcbiAgICAgICAgICAgICAgICAgIHRhcmdldEdyb3VwRnVsbE5hbWU6IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ1RhcmdldEdyb3VwRnVsbE5hbWUnXSB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgU2NhbGVJbkNvb2xkb3duOiAzMDAsXG4gICAgICAgICAgU2NhbGVPdXRDb29sZG93bjogMTIwLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdDdXN0b20gQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICAgIHNlcnZpY2VOYW1lOiAnY3VzdG9tLXNlcnZpY2UnLFxuICAgICAgICB0YXNrSW1hZ2VUYWc6ICd2MS4yLjMnLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDMsXG4gICAgICAgIGNwdTogMTAyNCxcbiAgICAgICAgbWVtb3J5TGltaXRNaUI6IDIwNDgsXG4gICAgICAgIGNvbnRhaW5lclBvcnQ6IDkwMDAsXG4gICAgICAgIGhlYWx0aENoZWNrUGF0aDogJy9jdXN0b20taGVhbHRoJyxcbiAgICAgICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogNjAsXG4gICAgICAgIGhlYWx0aENoZWNrVGltZW91dDogMTAsXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDUsXG4gICAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQ1VTVE9NX0VOVjogJ2N1c3RvbV92YWx1ZScsXG4gICAgICAgICAgREVCVUc6ICdmYWxzZScsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIHNlcnZpY2UgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIFNlcnZpY2VOYW1lOiAnY3VzdG9tLXNlcnZpY2UnLFxuICAgICAgICBEZXNpcmVkQ291bnQ6IDMsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIHRhc2sgZGVmaW5pdGlvbiBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIEZhbWlseTogJ3Rlc3RhcHAtcHJvZHVjdGlvbicsXG4gICAgICAgIENwdTogJzEwMjQnLFxuICAgICAgICBNZW1vcnk6ICcyMDQ4JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gY29udGFpbmVyIGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBOYW1lOiAndGVzdGFwcC1jb250YWluZXInLFxuICAgICAgICAgICAgSW1hZ2U6IHtcbiAgICAgICAgICAgICAgJ0ZuOjpKb2luJzogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBQb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIENvbnRhaW5lclBvcnQ6IDkwMDAsXG4gICAgICAgICAgICAgICAgUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdodHRwJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBFbnZpcm9ubWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgeyBOYW1lOiAnQ1VTVE9NX0VOVicsIFZhbHVlOiAnY3VzdG9tX3ZhbHVlJyB9LFxuICAgICAgICAgICAgICB7IE5hbWU6ICdERUJVRycsIFZhbHVlOiAnZmFsc2UnIH0sXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIE1lbW9yeVJlc2VydmF0aW9uOiAxNjM4LCAvLyA4MCUgb2YgMjA0OFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBQb3J0OiA5MDAwLFxuICAgICAgICBIZWFsdGhDaGVja1BhdGg6ICcvY3VzdG9tLWhlYWx0aCcsXG4gICAgICAgIEhlYWx0aENoZWNrSW50ZXJ2YWxTZWNvbmRzOiA2MCxcbiAgICAgICAgSGVhbHRoQ2hlY2tUaW1lb3V0U2Vjb25kczogMTAsXG4gICAgICAgIEhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgVW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGF1dG8gc2NhbGluZyBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBNaW5DYXBhY2l0eTogMyxcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDksIC8vIDMgKiAzXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3Quc2tpcCgndXNlcyBwcm9kdWN0aW9uIHJlcXVlc3QgY291bnQgZm9yIHNjYWxpbmcnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipSZXF1ZXN0U2NhbGluZy4qJyksXG4gICAgICAgIFRhcmdldFRyYWNraW5nU2NhbGluZ1BvbGljeUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBUYXJnZXRWYWx1ZTogMTAwMCwgLy8gUHJvZHVjdGlvbiBlbnZpcm9ubWVudFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdDb250YWluZXIgU2VjdXJpdHkgRmVhdHVyZXMnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiB0cnVlLFxuICAgICAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjb25maWd1cmVzIG5vbi1yb290IHVzZXInLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBVc2VyOiAnMTAwMToxMDAxJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdlbmFibGVzIHJlYWQtb25seSByb290IGZpbGVzeXN0ZW0nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBSZWFkb25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgdG1wZnMgdm9sdW1lcyBmb3IgcmVhZC1vbmx5IGZpbGVzeXN0ZW0nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgVm9sdW1lczogW1xuICAgICAgICAgIHsgTmFtZTogJ3RtcC12b2x1bWUnLCBIb3N0OiB7fSB9LFxuICAgICAgICAgIHsgTmFtZTogJ2xvZ3Mtdm9sdW1lJywgSG9zdDoge30gfSxcbiAgICAgICAgXSxcbiAgICAgICAgQ29udGFpbmVyRGVmaW5pdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBNb3VudFBvaW50czogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgU291cmNlVm9sdW1lOiAndG1wLXZvbHVtZScsXG4gICAgICAgICAgICAgICAgQ29udGFpbmVyUGF0aDogJy90bXAnLFxuICAgICAgICAgICAgICAgIFJlYWRPbmx5OiBmYWxzZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFNvdXJjZVZvbHVtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgICAgICAgICBDb250YWluZXJQYXRoOiAnL2FwcC9sb2dzJyxcbiAgICAgICAgICAgICAgICBSZWFkT25seTogZmFsc2UsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0F1dG8gU2NhbGluZyBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgbWluQ2FwYWNpdHk6IDIsXG4gICAgICAgIG1heENhcGFjaXR5OiAxMCxcbiAgICAgICAgY3B1VGFyZ2V0VXRpbGl6YXRpb246IDYwLFxuICAgICAgICBtZW1vcnlUYXJnZXRVdGlsaXphdGlvbjogNzUsXG4gICAgICAgIHNjYWxlSW5Db29sZG93bk1pbnV0ZXM6IDEwLFxuICAgICAgICBzY2FsZU91dENvb2xkb3duTWludXRlczogMyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gY2FwYWNpdHkgbGltaXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBNaW5DYXBhY2l0eTogMixcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDEwLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIGN1c3RvbSBDUFUgc2NhbGluZyB0YXJnZXQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipDcHVTY2FsaW5nLionKSxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiA2MCxcbiAgICAgICAgICBTY2FsZUluQ29vbGRvd246IDYwMCwgLy8gMTAgbWludXRlc1xuICAgICAgICAgIFNjYWxlT3V0Q29vbGRvd246IDE4MCwgLy8gMyBtaW51dGVzXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIG1lbW9yeSBzY2FsaW5nIHRhcmdldCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsaW5nUG9saWN5Jywge1xuICAgICAgICBQb2xpY3lOYW1lOiBNYXRjaC5zdHJpbmdMaWtlUmVnZXhwKCcuKk1lbW9yeVNjYWxpbmcuKicpLFxuICAgICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVGFyZ2V0VmFsdWU6IDc1LFxuICAgICAgICAgIFNjYWxlSW5Db29sZG93bjogNjAwLFxuICAgICAgICAgIFNjYWxlT3V0Q29vbGRvd246IDE4MCxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnSFRUUFMgTGlzdGVuZXIgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGh0dHBzTGlzdGVuZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bGlzdGVuZXIvYXBwL3Rlc3RhcHAtYWxiLXRlc3QvMTIzNDU2Nzg5MDEyMzQ1Ni85ODc2NTQzMjEwOTg3NjU0JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdC5za2lwKCdjcmVhdGVzIGxpc3RlbmVyIHJ1bGVzIGZvciBib3RoIEhUVFAgYW5kIEhUVFBTJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyUnVsZScsIHtcbiAgICAgICAgTGlzdGVuZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bGlzdGVuZXIvYXBwL3Rlc3RhcHAtYWxiLXRlc3QvMTIzNDU2Nzg5MDEyMzQ1Ni8xMjM0NTY3ODkwMTIzNDU2JyxcbiAgICAgICAgUHJpb3JpdHk6IDEwMCxcbiAgICAgICAgQWN0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIFR5cGU6ICdmb3J3YXJkJyxcbiAgICAgICAgICAgIFRhcmdldEdyb3VwQXJuOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIENvbmRpdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBGaWVsZDogJ3BhdGgtcGF0dGVybicsXG4gICAgICAgICAgICBWYWx1ZXM6IFsnKiddLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyUnVsZScsIHtcbiAgICAgICAgTGlzdGVuZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bGlzdGVuZXIvYXBwL3Rlc3RhcHAtYWxiLXRlc3QvMTIzNDU2Nzg5MDEyMzQ1Ni85ODc2NTQzMjEwOTg3NjU0JyxcbiAgICAgICAgUHJpb3JpdHk6IDEwMCxcbiAgICAgICAgQWN0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIFR5cGU6ICdmb3J3YXJkJyxcbiAgICAgICAgICAgIFRhcmdldEdyb3VwQXJuOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIENvbmRpdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBGaWVsZDogJ3BhdGgtcGF0dGVybicsXG4gICAgICAgICAgICBWYWx1ZXM6IFsnKiddLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0lBTSBSb2xlcyBhbmQgUGVybWlzc2lvbnMnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGV4ZWN1dGlvbiByb2xlIHdpdGggY29ycmVjdCBwb2xpY2llcycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgICAgIFJvbGVOYW1lOiAndGVzdGFwcC10ZXN0LWV4ZWN1dGlvbi1yb2xlJyxcbiAgICAgICAgQXNzdW1lUm9sZVBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgUHJpbmNpcGFsOiB7IFNlcnZpY2U6ICdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScgfSxcbiAgICAgICAgICAgICAgQWN0aW9uOiAnc3RzOkFzc3VtZVJvbGUnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBNYW5hZ2VkUG9saWN5QXJuczogW1xuICAgICAgICAgIHsgJ0ZuOjpKb2luJzogWycnLCBbJ2FybjonLCB7IFJlZjogJ0FXUzo6UGFydGl0aW9uJyB9LCAnOmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knXV0gfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyB0YXNrIHJvbGUgd2l0aCBjb3JyZWN0IHBvbGljaWVzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6Um9sZScsIHtcbiAgICAgICAgUm9sZU5hbWU6ICd0ZXN0YXBwLXRlc3QtdGFzay1yb2xlJyxcbiAgICAgICAgQXNzdW1lUm9sZVBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgUHJpbmNpcGFsOiB7IFNlcnZpY2U6ICdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScgfSxcbiAgICAgICAgICAgICAgQWN0aW9uOiAnc3RzOkFzc3VtZVJvbGUnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdleGVjdXRpb24gcm9sZSBoYXMgRUNSIGFjY2VzcyBwb2xpY3knLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgICBQb2xpY2llczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgICAgIFN0YXRlbWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgICAgIEFjdGlvbjogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICAgICAgJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nLFxuICAgICAgICAgICAgICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsXG4gICAgICAgICAgICAgICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgICAgICAgIFJlc291cmNlOiAnKicsXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3JvbGVzIGhhdmUgc2VjcmV0cyBtYW5hZ2VyIGFjY2VzcycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgICAgIFBvbGljaWVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgICAgICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgICAgICAgRWZmZWN0OiAnQWxsb3cnLFxuICAgICAgICAgICAgICAgICAgQWN0aW9uOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgICAgICAgICAgICAgXSksXG4gICAgICAgICAgICAgICAgICBSZXNvdXJjZTogTWF0Y2guYW55VmFsdWUoKSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgXSksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGFzayByb2xlIGhhcyBDbG91ZFdhdGNoIGxvZ3MgcGVybWlzc2lvbnMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgICBQb2xpY2llczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgICAgIFN0YXRlbWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgICAgICAgIEFjdGlvbjogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcbiAgICAgICAgICAgICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgICAgUmVzb3VyY2U6IE1hdGNoLmFueVZhbHVlKCksXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1NlY3JldHMgTWFuYWdlciBJbnRlZ3JhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgc2VjcmV0cyBtYW5hZ2VyIHNlY3JldCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTZWNyZXRzTWFuYWdlcjo6U2VjcmV0Jywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LWFwcC1zZWNyZXRzJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwIHRlc3QgZW52aXJvbm1lbnQnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdwcm9kdWN0aW9uIHNlY3JldHMgaGF2ZSByZXRhaW4gcmVtb3ZhbCBwb2xpY3knLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlKCdBV1M6OlNlY3JldHNNYW5hZ2VyOjpTZWNyZXQnLCB7XG4gICAgICAgIERlbGV0aW9uUG9saWN5OiAnUmV0YWluJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm9uLXByb2R1Y3Rpb24gc2VjcmV0cyBoYXZlIGRlc3Ryb3kgcmVtb3ZhbCBwb2xpY3knLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZSgnQVdTOjpTZWNyZXRzTWFuYWdlcjo6U2VjcmV0Jywge1xuICAgICAgICBEZWxldGlvblBvbGljeTogJ0RlbGV0ZScsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0VDUyBTZXJ2aWNlIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgdGVzdCgnZW5hYmxlcyBFQ1MgRXhlYyBmb3Igbm9uLXByb2R1Y3Rpb24gZW52aXJvbm1lbnRzJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIEVuYWJsZUV4ZWN1dGVDb21tYW5kOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdkaXNhYmxlcyBFQ1MgRXhlYyBmb3IgcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgRW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIGRpZmZlcmVudCBkZXBsb3ltZW50IGNvbmZpZ3VyYXRpb24gZm9yIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIERlcGxveW1lbnRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWF4aW11bVBlcmNlbnQ6IDIwMCxcbiAgICAgICAgICBNaW5pbXVtSGVhbHRoeVBlcmNlbnQ6IDEwMCwgLy8gWmVyby1kb3dudGltZSBkZXBsb3ltZW50cyBmb3IgcHJvZHVjdGlvblxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIHJlbGF4ZWQgZGVwbG95bWVudCBjb25maWd1cmF0aW9uIGZvciBub24tcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIERlcGxveW1lbnRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWF4aW11bVBlcmNlbnQ6IDE1MCwgLy8gQ29zdC1lZmZlY3RpdmUgZm9yIGRldi9zdGFnaW5nXG4gICAgICAgICAgTWluaW11bUhlYWx0aHlQZXJjZW50OiA1MCxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnU3RhY2sgT3V0cHV0cycsICgpID0+IHtcbiAgICBsZXQgc3RhY2s6IEFwcGxpY2F0aW9uU3RhY2s7XG5cbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGRlc2lyZWRDb3VudDogMixcbiAgICAgICAgY3B1OiA1MTIsXG4gICAgICAgIG1lbW9yeUxpbWl0TWlCOiAxMDI0LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHNlcnZpY2Ugb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnU2VydmljZUFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1MgU2VydmljZSBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVNlcnZpY2VBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdTZXJ2aWNlTmFtZScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1MgU2VydmljZSBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1TZXJ2aWNlTmFtZScgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyB0YXNrIGRlZmluaXRpb24gb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVGFza0RlZmluaXRpb25Bcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNTIFRhc2sgRGVmaW5pdGlvbiBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVRhc2tEZWZpbml0aW9uQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVGFza0RlZmluaXRpb25GYW1pbHknLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNTIFRhc2sgRGVmaW5pdGlvbiBGYW1pbHknLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVRhc2tEZWZpbml0aW9uRmFtaWx5JyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRhcmdldCBncm91cCBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdUYXJnZXRHcm91cEFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1UYXJnZXRHcm91cEFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1RhcmdldEdyb3VwTmFtZScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgTmFtZScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stVGFyZ2V0R3JvdXBOYW1lJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHNlY3JldHMgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnU2VjcmV0c0FybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBTZWNyZXRzIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stU2VjcmV0c0FybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBhdXRvIHNjYWxpbmcgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQXV0b1NjYWxpbmdUYXJnZXRJZCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBdXRvIFNjYWxpbmcgVGFyZ2V0IElEJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1BdXRvU2NhbGluZ1RhcmdldElkJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNvbmZpZ3VyYXRpb24gb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnRGVzaXJlZENvdW50Jywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0N1cnJlbnQgRGVzaXJlZCBDb3VudCcsXG4gICAgICAgIFZhbHVlOiAnMicsXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdUYXNrQ3B1Jywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1Rhc2sgQ1BVIFVuaXRzJyxcbiAgICAgICAgVmFsdWU6ICc1MTInLFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVGFza01lbW9yeScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdUYXNrIE1lbW9yeSAoTWlCKScsXG4gICAgICAgIFZhbHVlOiAnMTAyNCcsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1Jlc291cmNlIFRhZ2dpbmcnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd0YXNrIGRlZmluaXRpb24gaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd0YXJnZXQgZ3JvdXAgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpUYXJnZXRHcm91cCcsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnRUNTIHNlcnZpY2UgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3NlY3JldHMgaGF2ZSBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREstU09QUycgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0lBTSByb2xlcyBoYXZlIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0Vycm9yIEhhbmRsaW5nIGFuZCBFZGdlIENhc2VzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2hhbmRsZXMgbWluaW1hbCBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IG1pbmltYWxQcm9wcyA9IHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgICAgICBwcml2YXRlU3VibmV0SWRzOiBbJ3N1Ym5ldC00NDQ0NDQ0NCddLFxuICAgICAgICBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZDogJ3NnLTg3NjU0MzIxJyxcbiAgICAgICAgY2x1c3RlckFybjogJ2Fybjphd3M6ZWNzOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6Y2x1c3Rlci90ZXN0LWNsdXN0ZXInLFxuICAgICAgICBjbHVzdGVyTmFtZTogJ3Rlc3QtY2x1c3RlcicsXG4gICAgICAgIHJlcG9zaXRvcnlVcmk6ICcxMjM0NTY3ODkwMTIuZGtyLmVjci51cy1lYXN0LTEuYW1hem9uYXdzLmNvbS90ZXN0LXJlcG8nLFxuICAgICAgICBsb2FkQmFsYW5jZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bG9hZGJhbGFuY2VyL2FwcC90ZXN0LWFsYi8xMjMnLFxuICAgICAgICBodHRwTGlzdGVuZXJBcm46ICdhcm46YXdzOmVsYXN0aWNsb2FkYmFsYW5jaW5nOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bGlzdGVuZXIvYXBwL3Rlc3QtYWxiLzEyMy80NTYnLFxuICAgICAgICBsb2dHcm91cE5hbWU6ICcvYXdzL2Vjcy90ZXN0JyxcbiAgICAgICAgbG9nR3JvdXBBcm46ICdhcm46YXdzOmxvZ3M6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsb2ctZ3JvdXA6L2F3cy9lY3MvdGVzdCcsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG5cbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywgbWluaW1hbFByb3BzKTtcbiAgICAgIH0pLm5vdC50b1Rocm93KCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIGRlZmF1bHQgdmFsdWVzIGZvciBvcHRpb25hbCBwYXJhbWV0ZXJzJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBTaG91bGQgdXNlIGRlZmF1bHRzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBEZXNpcmVkQ291bnQ6IDEsIC8vIGRlZmF1bHRcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgQ3B1OiAnMjU2JywgLy8gZGVmYXVsdFxuICAgICAgICBNZW1vcnk6ICc1MTInLCAvLyBkZWZhdWx0XG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBQb3J0OiA4MDAwLCAvLyBkZWZhdWx0XG4gICAgICAgIEhlYWx0aENoZWNrUGF0aDogJy9oZWFsdGgvJywgLy8gZGVmYXVsdFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIHplcm8gZGVzaXJlZCBjb3VudCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGRlc2lyZWRDb3VudDogMCxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBaZXJvIGRlc2lyZWQgY291bnQgZ2V0cyBhZGp1c3RlZCB0byBtaW5pbXVtIG9mIDEgZm9yIHNhZmV0eVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgRGVzaXJlZENvdW50OiAxLFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsYWJsZVRhcmdldCcsIHtcbiAgICAgICAgTWluQ2FwYWNpdHk6IDEsIC8vIE1pbmltdW0gZW5mb3JjZWQgdG8gMSBmb3Igc2FmZXR5XG4gICAgICAgIE1heENhcGFjaXR5OiAzLCAvLyBVc2VzIE1hdGgubWF4KDEsIGRlc2lyZWRDb3VudCkgKiAzXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgY3VzdG9tIGF1dG8gc2NhbGluZyBsaW1pdHMnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDIsXG4gICAgICAgIG1pbkNhcGFjaXR5OiAxLFxuICAgICAgICBtYXhDYXBhY2l0eTogMjAsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBNaW5DYXBhY2l0eTogMSwgLy8gQ3VzdG9tIG1pbkNhcGFjaXR5IG92ZXJyaWRlcyBkZXNpcmVkQ291bnRcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDIwLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjb250YWluZXIgc2VjdXJpdHkgZmVhdHVyZXMgZGlzYWJsZWQgYnkgZGVmYXVsdCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgICBDb250YWluZXJEZWZpbml0aW9uczogW1xuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgVXNlcjogTWF0Y2guYWJzZW50KCksXG4gICAgICAgICAgICBSZWFkb25seVJvb3RGaWxlc3lzdGVtOiBmYWxzZSwgLy8gRXhwbGljaXRseSBzZXQgdG8gZmFsc2UgYnkgZGVmYXVsdFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICBWb2x1bWVzOiBNYXRjaC5hYnNlbnQoKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm8gdG1wZnMgdm9sdW1lcyB3aGVuIHJlYWQtb25seSBmaWxlc3lzdGVtIGRpc2FibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBNb3VudFBvaW50czogTWF0Y2guYWJzZW50KCksXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgSFRUUFMgbGlzdGVuZXIgbm90IHByb3ZpZGVkJywgKCkgPT4ge1xuICAgICAgLy8gU2hvdWxkIG9ubHkgY3JlYXRlIG9uZSBsaXN0ZW5lciBydWxlIChIVFRQKVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIExpc3RlbmVyQXJuOiBkZWZhdWx0UHJvcHMuaHR0cExpc3RlbmVyQXJuLFxuICAgICAgfSwgMSk7XG5cbiAgICAgIC8vIFNob3VsZCBub3QgY3JlYXRlIEhUVFBTIGxpc3RlbmVyIHJ1bGVcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCAxKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1NPUFMgSW50ZWdyYXRpb24gRXJyb3IgSGFuZGxpbmcnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBTT1BTIGxvYWRpbmcgZmFpbHVyZSBncmFjZWZ1bGx5JywgKCkgPT4ge1xuICAgICAgLy8gVGhpcyB0ZXN0IHNpbXVsYXRlcyB0aGUgZXJyb3IgaGFuZGxpbmcgcGF0aCBpbiBjcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldFxuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIFxuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcblxuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2sobmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2syJywgZGVmYXVsdFByb3BzKSk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBzdGlsbCBjcmVhdGUgYSBzZWNyZXQgZXZlbiBpZiBTT1BTIGZhaWxzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtdGVzdC1hcHAtc2VjcmV0cycsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59KTsiXX0=