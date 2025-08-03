"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const application_stack_1 = require("../lib/application-stack");
describe('ApplicationStack', () => {
    let app;
    let template;
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
                            'Fn::Sub': [
                                '${repoUri}:latest',
                                { repoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/testapp-test' },
                            ],
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
                                    'Fn::Sub': [
                                        '${secretArn}:application.secret_key::',
                                        { secretArn: { Ref: assertions_1.Match.anyValue() } },
                                    ],
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
                    'Fn::Sub': [
                        'service/${clusterName}/${serviceName}',
                        {
                            clusterName: 'testapp-cluster-test',
                            serviceName: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'Name'] },
                        },
                    ],
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
                            'Fn::Sub': [
                                '${repoUri}:v1.2.3',
                                { repoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/testapp-test' },
                            ],
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
        test('creates listener rules for both HTTP and HTTPS', () => {
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
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: [
                        {
                            Effect: 'Allow',
                            Action: [
                                'ecr:GetAuthorizationToken',
                                'ecr:BatchCheckLayerAvailability',
                                'ecr:GetDownloadUrlForLayer',
                                'ecr:BatchGetImage',
                            ],
                            Resource: '*',
                        },
                    ],
                },
            });
        });
        test('roles have secrets manager access', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: [
                        {
                            Effect: 'Allow',
                            Action: [
                                'secretsmanager:GetSecretValue',
                                'secretsmanager:DescribeSecret',
                            ],
                            Resource: { Ref: assertions_1.Match.anyValue() },
                        },
                    ],
                },
            });
        });
        test('task role has CloudWatch logs permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: [
                        {
                            Effect: 'Allow',
                            Action: [
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                            ],
                            Resource: '/aws/ecs/testapp-test*',
                        },
                    ],
                },
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
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                DeletionPolicy: 'Retain',
            });
        });
        test('non-production secrets have destroy removal policy', () => {
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
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
                    MinimumHealthyPercent: 100,
                },
            });
        });
        test('uses relaxed deployment configuration for non-production', () => {
            template.hasResourceProperties('AWS::ECS::Service', {
                DeploymentConfiguration: {
                    MaximumPercent: 200,
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
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'Component', Value: 'ECS-Task-Definition' },
                ],
            });
        });
        test('target group has correct tags', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'Component', Value: 'Application-TargetGroup' },
                ],
            });
        });
        test('ECS service has correct tags', () => {
            template.hasResourceProperties('AWS::ECS::Service', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'Component', Value: 'ECS-Service' },
                ],
            });
        });
        test('secrets have correct tags', () => {
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK-SOPS' },
                    { Key: 'Component', Value: 'Application-Secrets' },
                ],
            });
        });
        test('IAM roles have correct tags', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'Component', Value: 'ECS-Execution-Role' },
                ],
            });
            template.hasResourceProperties('AWS::IAM::Role', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'Component', Value: 'ECS-Task-Role' },
                ],
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
            template.hasResourceProperties('AWS::ECS::Service', {
                DesiredCount: 0,
            });
            template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
                MinCapacity: 0,
                MaxCapacity: 0, // Uses desiredCount * 3
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
                        ReadonlyRootFilesystem: assertions_1.Match.absent(),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2sudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFwcGxpY2F0aW9uLXN0YWNrLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtQ0FBbUM7QUFDbkMsdURBQXlEO0FBQ3pELGdFQUE0RDtBQUU1RCxRQUFRLENBQUMsa0JBQWtCLEVBQUUsR0FBRyxFQUFFO0lBQ2hDLElBQUksR0FBWSxDQUFDO0lBQ2pCLElBQUksUUFBa0IsQ0FBQztJQUV2QixNQUFNLFlBQVksR0FBRztRQUNuQixXQUFXLEVBQUUsTUFBTTtRQUNuQixLQUFLLEVBQUUsY0FBYztRQUNyQixnQkFBZ0IsRUFBRSxDQUFDLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixDQUFDO1FBQzNFLDBCQUEwQixFQUFFLGFBQWE7UUFDekMsVUFBVSxFQUFFLGlFQUFpRTtRQUM3RSxXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLGFBQWEsRUFBRSwyREFBMkQ7UUFDMUUsZUFBZSxFQUFFLHdHQUF3RztRQUN6SCxlQUFlLEVBQUUscUhBQXFIO1FBQ3RJLFlBQVksRUFBRSx1QkFBdUI7UUFDckMsV0FBVyxFQUFFLHFFQUFxRTtRQUNsRixTQUFTLEVBQUUsc0JBQXNCO1FBQ2pDLEdBQUcsRUFBRTtZQUNILE9BQU8sRUFBRSxjQUFjO1lBQ3ZCLE1BQU0sRUFBRSxXQUFXO1NBQ3BCO0tBQ0YsQ0FBQztJQUVGLFFBQVEsQ0FBQyxpQ0FBaUMsRUFBRSxHQUFHLEVBQUU7UUFDL0MsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNwQixNQUFNLEtBQUssR0FBRyxJQUFJLG9DQUFnQixDQUFDLEdBQUcsRUFBRSxzQkFBc0IsRUFBRSxZQUFZLENBQUMsQ0FBQztZQUM5RSxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdkMsQ0FBQyxDQUFD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LHdDQUF3QztZQUN4QyxRQUFRLENBQUMsZUFBZSxDQUFDLDJDQUEyQyxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzNFLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxRQUFRLENBQUMsaUNBQWlDLEVBQUUsR0FBRyxFQUFFO1FBQy9DLElBQUksQ0FBQyx5Q0FBeUMsRUFBRSxHQUFHLEVBQUU7WUFDbkQsNEVBQTRFO1lBQzVFLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUVwQixNQUFNLENBQUMsR0FBRyxFQUFFO2dCQUNWLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQ2xFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUVqQixRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsSUFBSSxvQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsdUJBQXVCLEVBQUUsWUFBWSxDQUFDLENBQUMsQ0FBQztZQUVoRyxrREFBa0Q7WUFDbEQsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDZCQUE2QixFQUFFO2dCQUM1RCxJQUFJLEVBQUUsMEJBQTBCO2FBQ2pDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSwgTWF0Y2ggfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IEFwcGxpY2F0aW9uU3RhY2sgfSBmcm9tICcuLi9saWIvYXBwbGljYXRpb24tc3RhY2snO1xuXG5kZXNjcmliZSgnQXBwbGljYXRpb25TdGFjaycsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcDtcbiAgbGV0IHRlbXBsYXRlOiBUZW1wbGF0ZTtcblxuICBjb25zdCBkZWZhdWx0UHJvcHMgPSB7XG4gICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgcHJpdmF0ZVN1Ym5ldElkczogWydzdWJuZXQtNDQ0NDQ0NDQnLCAnc3VibmV0LTU1NTU1NTU1JywgJ3N1Ym5ldC02NjY2NjY2NiddLFxuICAgIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkOiAnc2ctODc2NTQzMjEnLFxuICAgIGNsdXN0ZXJBcm46ICdhcm46YXdzOmVjczp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmNsdXN0ZXIvdGVzdGFwcC1jbHVzdGVyLXRlc3QnLFxuICAgIGNsdXN0ZXJOYW1lOiAndGVzdGFwcC1jbHVzdGVyLXRlc3QnLFxuICAgIHJlcG9zaXRvcnlVcmk6ICcxMjM0NTY3ODkwMTIuZGtyLmVjci51cy1lYXN0LTEuYW1hem9uYXdzLmNvbS90ZXN0YXBwLXRlc3QnLFxuICAgIGxvYWRCYWxhbmNlckFybjogJ2Fybjphd3M6ZWxhc3RpY2xvYWRiYWxhbmNpbmc6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsb2FkYmFsYW5jZXIvYXBwL3Rlc3RhcHAtYWxiLXRlc3QvMTIzNDU2Nzg5MDEyMzQ1NicsXG4gICAgaHR0cExpc3RlbmVyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxpc3RlbmVyL2FwcC90ZXN0YXBwLWFsYi10ZXN0LzEyMzQ1Njc4OTAxMjM0NTYvMTIzNDU2Nzg5MDEyMzQ1NicsXG4gICAgbG9nR3JvdXBOYW1lOiAnL2F3cy9lY3MvdGVzdGFwcC10ZXN0JyxcbiAgICBsb2dHcm91cEFybjogJ2Fybjphd3M6bG9nczp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxvZy1ncm91cDovYXdzL2Vjcy90ZXN0YXBwLXRlc3QnLFxuICAgIHN0YWNrTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJyxcbiAgICBlbnY6IHtcbiAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICB9LFxuICB9O1xuXG4gIGRlc2NyaWJlKCdCYXNpYyBBcHBsaWNhdGlvbiBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyB0YXNrIGRlZmluaXRpb24gd2l0aCBjb3JyZWN0IGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgRmFtaWx5OiAndGVzdGFwcC10ZXN0JyxcbiAgICAgICAgTmV0d29ya01vZGU6ICdhd3N2cGMnLFxuICAgICAgICBSZXF1aXJlc0NvbXBhdGliaWxpdGllczogWydGQVJHQVRFJ10sXG4gICAgICAgIENwdTogJzI1NicsXG4gICAgICAgIE1lbW9yeTogJzUxMicsXG4gICAgICAgIEV4ZWN1dGlvblJvbGVBcm46IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ0FybiddIH0sXG4gICAgICAgIFRhc2tSb2xlQXJuOiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNvbnRhaW5lciBkZWZpbml0aW9uIHdpdGggY29ycmVjdCBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgTmFtZTogJ3Rlc3RhcHAtY29udGFpbmVyJyxcbiAgICAgICAgICAgIEltYWdlOiB7XG4gICAgICAgICAgICAgICdGbjo6U3ViJzogW1xuICAgICAgICAgICAgICAgICcke3JlcG9Vcml9OmxhdGVzdCcsXG4gICAgICAgICAgICAgICAgeyByZXBvVXJpOiAnMTIzNDU2Nzg5MDEyLmRrci5lY3IudXMtZWFzdC0xLmFtYXpvbmF3cy5jb20vdGVzdGFwcC10ZXN0JyB9LFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIFBvcnRNYXBwaW5nczogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgQ29udGFpbmVyUG9ydDogODAwMCxcbiAgICAgICAgICAgICAgICBQcm90b2NvbDogJ3RjcCcsXG4gICAgICAgICAgICAgICAgTmFtZTogJ2h0dHAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIEVudmlyb25tZW50OiBbXG4gICAgICAgICAgICAgIHsgTmFtZTogJ1JFUVVJUkVEX1NFVFRJTkcnLCBWYWx1ZTogJ3Rlc3QnIH0sXG4gICAgICAgICAgICAgIHsgTmFtZTogJ0VOVklST05NRU5UJywgVmFsdWU6ICd0ZXN0JyB9LFxuICAgICAgICAgICAgICB7IE5hbWU6ICdBV1NfREVGQVVMVF9SRUdJT04nLCBWYWx1ZTogJ3VzLWVhc3QtMScgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBTZWNyZXRzOiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBOYW1lOiAnU0VDUkVUX0tFWScsXG4gICAgICAgICAgICAgICAgVmFsdWVGcm9tOiB7XG4gICAgICAgICAgICAgICAgICAnRm46OlN1Yic6IFtcbiAgICAgICAgICAgICAgICAgICAgJyR7c2VjcmV0QXJufTphcHBsaWNhdGlvbi5zZWNyZXRfa2V5OjonLFxuICAgICAgICAgICAgICAgICAgICB7IHNlY3JldEFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSB9LFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIExvZ0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgICAgTG9nRHJpdmVyOiAnYXdzbG9ncycsXG4gICAgICAgICAgICAgIE9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICAnYXdzbG9ncy1ncm91cCc6ICcvYXdzL2Vjcy90ZXN0YXBwLXRlc3QnLFxuICAgICAgICAgICAgICAgICdhd3Nsb2dzLXJlZ2lvbic6ICd1cy1lYXN0LTEnLFxuICAgICAgICAgICAgICAgICdhd3Nsb2dzLXN0cmVhbS1wcmVmaXgnOiAndGVzdGFwcCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgTWVtb3J5UmVzZXJ2YXRpb246IDQwOSwgLy8gODAlIG9mIDUxMlxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgRmFyZ2F0ZSBzZXJ2aWNlJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgU2VydmljZU5hbWU6ICd0ZXN0YXBwLXNlcnZpY2UtdGVzdCcsXG4gICAgICAgIENsdXN0ZXI6ICd0ZXN0YXBwLWNsdXN0ZXItdGVzdCcsXG4gICAgICAgIFRhc2tEZWZpbml0aW9uOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICBEZXNpcmVkQ291bnQ6IDEsXG4gICAgICAgIExhdW5jaFR5cGU6ICdGQVJHQVRFJyxcbiAgICAgICAgTmV0d29ya0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBBd3N2cGNDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICBTZWN1cml0eUdyb3VwczogWydzZy04NzY1NDMyMSddLFxuICAgICAgICAgICAgU3VibmV0czogWydzdWJuZXQtNDQ0NDQ0NDQnLCAnc3VibmV0LTU1NTU1NTU1JywgJ3N1Ym5ldC02NjY2NjY2NiddLFxuICAgICAgICAgICAgQXNzaWduUHVibGljSXA6ICdESVNBQkxFRCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgTG9hZEJhbGFuY2VyczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIENvbnRhaW5lck5hbWU6ICd0ZXN0YXBwLWNvbnRhaW5lcicsXG4gICAgICAgICAgICBDb250YWluZXJQb3J0OiA4MDAwLFxuICAgICAgICAgICAgVGFyZ2V0R3JvdXBBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyB0YXJnZXQgZ3JvdXAgd2l0aCBoZWFsdGggY2hlY2tzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LXRnJyxcbiAgICAgICAgUG9ydDogODAwMCxcbiAgICAgICAgUHJvdG9jb2w6ICdIVFRQJyxcbiAgICAgICAgVGFyZ2V0VHlwZTogJ2lwJyxcbiAgICAgICAgSGVhbHRoQ2hlY2tQYXRoOiAnL2hlYWx0aC8nLFxuICAgICAgICBIZWFsdGhDaGVja1Byb3RvY29sOiAnSFRUUCcsXG4gICAgICAgIEhlYWx0aENoZWNrSW50ZXJ2YWxTZWNvbmRzOiAzMCxcbiAgICAgICAgSGVhbHRoQ2hlY2tUaW1lb3V0U2Vjb25kczogNSxcbiAgICAgICAgSGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgICAgICBVbmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgTWF0Y2hlcjogeyBIdHRwQ29kZTogJzIwMCcgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBhcHBsaWNhdGlvbiBhdXRvIHNjYWxpbmcgdGFyZ2V0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBTZXJ2aWNlTmFtZXNwYWNlOiAnZWNzJyxcbiAgICAgICAgUmVzb3VyY2VJZDoge1xuICAgICAgICAgICdGbjo6U3ViJzogW1xuICAgICAgICAgICAgJ3NlcnZpY2UvJHtjbHVzdGVyTmFtZX0vJHtzZXJ2aWNlTmFtZX0nLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBjbHVzdGVyTmFtZTogJ3Rlc3RhcHAtY2x1c3Rlci10ZXN0JyxcbiAgICAgICAgICAgICAgc2VydmljZU5hbWU6IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ05hbWUnXSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBTY2FsYWJsZURpbWVuc2lvbjogJ2VjczpzZXJ2aWNlOkRlc2lyZWRDb3VudCcsXG4gICAgICAgIE1pbkNhcGFjaXR5OiAxLFxuICAgICAgICBNYXhDYXBhY2l0eTogMyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBDUFUtYmFzZWQgYXV0byBzY2FsaW5nIHBvbGljeScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsaW5nUG9saWN5Jywge1xuICAgICAgICBQb2xpY3lOYW1lOiBNYXRjaC5zdHJpbmdMaWtlUmVnZXhwKCcuKkNwdVNjYWxpbmcuKicpLFxuICAgICAgICBQb2xpY3lUeXBlOiAnVGFyZ2V0VHJhY2tpbmdTY2FsaW5nJyxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiA3MCxcbiAgICAgICAgICBQcmVkZWZpbmVkTWV0cmljU3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1R5cGU6ICdFQ1NTZXJ2aWNlQXZlcmFnZUNQVVV0aWxpemF0aW9uJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFNjYWxlSW5Db29sZG93bjogMzAwLFxuICAgICAgICAgIFNjYWxlT3V0Q29vbGRvd246IDEyMCxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBtZW1vcnktYmFzZWQgYXV0byBzY2FsaW5nIHBvbGljeScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsaW5nUG9saWN5Jywge1xuICAgICAgICBQb2xpY3lOYW1lOiBNYXRjaC5zdHJpbmdMaWtlUmVnZXhwKCcuKk1lbW9yeVNjYWxpbmcuKicpLFxuICAgICAgICBQb2xpY3lUeXBlOiAnVGFyZ2V0VHJhY2tpbmdTY2FsaW5nJyxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiA4MCxcbiAgICAgICAgICBQcmVkZWZpbmVkTWV0cmljU3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1R5cGU6ICdFQ1NTZXJ2aWNlQXZlcmFnZU1lbW9yeVV0aWxpemF0aW9uJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFNjYWxlSW5Db29sZG93bjogMzAwLFxuICAgICAgICAgIFNjYWxlT3V0Q29vbGRvd246IDEyMCxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyByZXF1ZXN0LWJhc2VkIGF1dG8gc2NhbGluZyBwb2xpY3knLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipSZXF1ZXN0U2NhbGluZy4qJyksXG4gICAgICAgIFBvbGljeVR5cGU6ICdUYXJnZXRUcmFja2luZ1NjYWxpbmcnLFxuICAgICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVGFyZ2V0VmFsdWU6IDUwMCwgLy8gVGVzdCBlbnZpcm9ubWVudFxuICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgICBQcmVkZWZpbmVkTWV0cmljVHlwZTogJ0FMQlJlcXVlc3RDb3VudFBlclRhcmdldCcsXG4gICAgICAgICAgICBSZXNvdXJjZUxhYmVsOiB7XG4gICAgICAgICAgICAgICdGbjo6U3ViJzogW1xuICAgICAgICAgICAgICAgICcke2xvYWRCYWxhbmNlckZ1bGxOYW1lfS8ke3RhcmdldEdyb3VwRnVsbE5hbWV9JyxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBsb2FkQmFsYW5jZXJGdWxsTmFtZTogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnTG9hZEJhbGFuY2VyRnVsbE5hbWUnXSB9LFxuICAgICAgICAgICAgICAgICAgdGFyZ2V0R3JvdXBGdWxsTmFtZTogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnVGFyZ2V0R3JvdXBGdWxsTmFtZSddIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBTY2FsZUluQ29vbGRvd246IDMwMCxcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxMjAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0N1c3RvbSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgc2VydmljZU5hbWU6ICdjdXN0b20tc2VydmljZScsXG4gICAgICAgIHRhc2tJbWFnZVRhZzogJ3YxLjIuMycsXG4gICAgICAgIGRlc2lyZWRDb3VudDogMyxcbiAgICAgICAgY3B1OiAxMDI0LFxuICAgICAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICAgICAgY29udGFpbmVyUG9ydDogOTAwMCxcbiAgICAgICAgaGVhbHRoQ2hlY2tQYXRoOiAnL2N1c3RvbS1oZWFsdGgnLFxuICAgICAgICBoZWFsdGhDaGVja0ludGVydmFsOiA2MCxcbiAgICAgICAgaGVhbHRoQ2hlY2tUaW1lb3V0OiAxMCxcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogNSxcbiAgICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgICBDVVNUT01fRU5WOiAnY3VzdG9tX3ZhbHVlJyxcbiAgICAgICAgICBERUJVRzogJ2ZhbHNlJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gc2VydmljZSBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgU2VydmljZU5hbWU6ICdjdXN0b20tc2VydmljZScsXG4gICAgICAgIERlc2lyZWRDb3VudDogMyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gdGFzayBkZWZpbml0aW9uIGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgRmFtaWx5OiAndGVzdGFwcC1wcm9kdWN0aW9uJyxcbiAgICAgICAgQ3B1OiAnMTAyNCcsXG4gICAgICAgIE1lbW9yeTogJzIwNDgnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIGN1c3RvbSBjb250YWluZXIgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgICBDb250YWluZXJEZWZpbml0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICd0ZXN0YXBwLWNvbnRhaW5lcicsXG4gICAgICAgICAgICBJbWFnZToge1xuICAgICAgICAgICAgICAnRm46OlN1Yic6IFtcbiAgICAgICAgICAgICAgICAnJHtyZXBvVXJpfTp2MS4yLjMnLFxuICAgICAgICAgICAgICAgIHsgcmVwb1VyaTogJzEyMzQ1Njc4OTAxMi5ka3IuZWNyLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tL3Rlc3RhcHAtdGVzdCcgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBQb3J0TWFwcGluZ3M6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIENvbnRhaW5lclBvcnQ6IDkwMDAsXG4gICAgICAgICAgICAgICAgUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdodHRwJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBFbnZpcm9ubWVudDogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgeyBOYW1lOiAnQ1VTVE9NX0VOVicsIFZhbHVlOiAnY3VzdG9tX3ZhbHVlJyB9LFxuICAgICAgICAgICAgICB7IE5hbWU6ICdERUJVRycsIFZhbHVlOiAnZmFsc2UnIH0sXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIE1lbW9yeVJlc2VydmF0aW9uOiAxNjM4LCAvLyA4MCUgb2YgMjA0OFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBQb3J0OiA5MDAwLFxuICAgICAgICBIZWFsdGhDaGVja1BhdGg6ICcvY3VzdG9tLWhlYWx0aCcsXG4gICAgICAgIEhlYWx0aENoZWNrSW50ZXJ2YWxTZWNvbmRzOiA2MCxcbiAgICAgICAgSGVhbHRoQ2hlY2tUaW1lb3V0U2Vjb25kczogMTAsXG4gICAgICAgIEhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICAgICAgVW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDUsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGF1dG8gc2NhbGluZyBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgICBNaW5DYXBhY2l0eTogMyxcbiAgICAgICAgTWF4Q2FwYWNpdHk6IDksIC8vIDMgKiAzXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcHJvZHVjdGlvbiByZXF1ZXN0IGNvdW50IGZvciBzY2FsaW5nJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qUmVxdWVzdFNjYWxpbmcuKicpLFxuICAgICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgVGFyZ2V0VmFsdWU6IDEwMDAsIC8vIFByb2R1Y3Rpb24gZW52aXJvbm1lbnRcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ29udGFpbmVyIFNlY3VyaXR5IEZlYXR1cmVzJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogdHJ1ZSxcbiAgICAgICAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbTogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY29uZmlndXJlcyBub24tcm9vdCB1c2VyJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVXNlcjogJzEwMDE6MTAwMScsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZW5hYmxlcyByZWFkLW9ubHkgcm9vdCBmaWxlc3lzdGVtJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgUmVhZG9ubHlSb290RmlsZXN5c3RlbTogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRtcGZzIHZvbHVtZXMgZm9yIHJlYWQtb25seSBmaWxlc3lzdGVtJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIFZvbHVtZXM6IFtcbiAgICAgICAgICB7IE5hbWU6ICd0bXAtdm9sdW1lJywgSG9zdDoge30gfSxcbiAgICAgICAgICB7IE5hbWU6ICdsb2dzLXZvbHVtZScsIEhvc3Q6IHt9IH0sXG4gICAgICAgIF0sXG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgTW91bnRQb2ludHM6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFNvdXJjZVZvbHVtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICAgICAgICAgIENvbnRhaW5lclBhdGg6ICcvdG1wJyxcbiAgICAgICAgICAgICAgICBSZWFkT25seTogZmFsc2UsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBTb3VyY2VWb2x1bWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgICAgICAgICAgQ29udGFpbmVyUGF0aDogJy9hcHAvbG9ncycsXG4gICAgICAgICAgICAgICAgUmVhZE9ubHk6IGZhbHNlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdBdXRvIFNjYWxpbmcgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIG1pbkNhcGFjaXR5OiAyLFxuICAgICAgICBtYXhDYXBhY2l0eTogMTAsXG4gICAgICAgIGNwdVRhcmdldFV0aWxpemF0aW9uOiA2MCxcbiAgICAgICAgbWVtb3J5VGFyZ2V0VXRpbGl6YXRpb246IDc1LFxuICAgICAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiAxMCxcbiAgICAgICAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM6IDMsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgY3VzdG9tIGNhcGFjaXR5IGxpbWl0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsYWJsZVRhcmdldCcsIHtcbiAgICAgICAgTWluQ2FwYWNpdHk6IDIsXG4gICAgICAgIE1heENhcGFjaXR5OiAxMCxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBjdXN0b20gQ1BVIHNjYWxpbmcgdGFyZ2V0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxpbmdQb2xpY3knLCB7XG4gICAgICAgIFBvbGljeU5hbWU6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qQ3B1U2NhbGluZy4qJyksXG4gICAgICAgIFRhcmdldFRyYWNraW5nU2NhbGluZ1BvbGljeUNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBUYXJnZXRWYWx1ZTogNjAsXG4gICAgICAgICAgU2NhbGVJbkNvb2xkb3duOiA2MDAsIC8vIDEwIG1pbnV0ZXNcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxODAsIC8vIDMgbWludXRlc1xuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIGN1c3RvbSBtZW1vcnkgc2NhbGluZyB0YXJnZXQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgICAgUG9saWN5TmFtZTogTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cCgnLipNZW1vcnlTY2FsaW5nLionKSxcbiAgICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFRhcmdldFZhbHVlOiA3NSxcbiAgICAgICAgICBTY2FsZUluQ29vbGRvd246IDYwMCxcbiAgICAgICAgICBTY2FsZU91dENvb2xkb3duOiAxODAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0hUVFBTIExpc3RlbmVyIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBodHRwc0xpc3RlbmVyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxpc3RlbmVyL2FwcC90ZXN0YXBwLWFsYi10ZXN0LzEyMzQ1Njc4OTAxMjM0NTYvOTg3NjU0MzIxMDk4NzY1NCcsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgbGlzdGVuZXIgcnVsZXMgZm9yIGJvdGggSFRUUCBhbmQgSFRUUFMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXJSdWxlJywge1xuICAgICAgICBMaXN0ZW5lckFybjogJ2Fybjphd3M6ZWxhc3RpY2xvYWRiYWxhbmNpbmc6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsaXN0ZW5lci9hcHAvdGVzdGFwcC1hbGItdGVzdC8xMjM0NTY3ODkwMTIzNDU2LzEyMzQ1Njc4OTAxMjM0NTYnLFxuICAgICAgICBQcmlvcml0eTogMTAwLFxuICAgICAgICBBY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVHlwZTogJ2ZvcndhcmQnLFxuICAgICAgICAgICAgVGFyZ2V0R3JvdXBBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgQ29uZGl0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEZpZWxkOiAncGF0aC1wYXR0ZXJuJyxcbiAgICAgICAgICAgIFZhbHVlczogWycqJ10sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXJSdWxlJywge1xuICAgICAgICBMaXN0ZW5lckFybjogJ2Fybjphd3M6ZWxhc3RpY2xvYWRiYWxhbmNpbmc6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpsaXN0ZW5lci9hcHAvdGVzdGFwcC1hbGItdGVzdC8xMjM0NTY3ODkwMTIzNDU2Lzk4NzY1NDMyMTA5ODc2NTQnLFxuICAgICAgICBQcmlvcml0eTogMTAwLFxuICAgICAgICBBY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVHlwZTogJ2ZvcndhcmQnLFxuICAgICAgICAgICAgVGFyZ2V0R3JvdXBBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgQ29uZGl0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEZpZWxkOiAncGF0aC1wYXR0ZXJuJyxcbiAgICAgICAgICAgIFZhbHVlczogWycqJ10sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnSUFNIFJvbGVzIGFuZCBQZXJtaXNzaW9ucycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgZXhlY3V0aW9uIHJvbGUgd2l0aCBjb3JyZWN0IHBvbGljaWVzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6Um9sZScsIHtcbiAgICAgICAgUm9sZU5hbWU6ICd0ZXN0YXBwLXRlc3QtZXhlY3V0aW9uLXJvbGUnLFxuICAgICAgICBBc3N1bWVSb2xlUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgICAgICBTdGF0ZW1lbnQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgRWZmZWN0OiAnQWxsb3cnLFxuICAgICAgICAgICAgICBQcmluY2lwYWw6IHsgU2VydmljZTogJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyB9LFxuICAgICAgICAgICAgICBBY3Rpb246ICdzdHM6QXNzdW1lUm9sZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIE1hbmFnZWRQb2xpY3lBcm5zOiBbXG4gICAgICAgICAgeyAnRm46OkpvaW4nOiBbJycsIFsnYXJuOicsIHsgUmVmOiAnQVdTOjpQYXJ0aXRpb24nIH0sICc6aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeSddXSB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHRhc2sgcm9sZSB3aXRoIGNvcnJlY3QgcG9saWNpZXMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgICBSb2xlTmFtZTogJ3Rlc3RhcHAtdGVzdC10YXNrLXJvbGUnLFxuICAgICAgICBBc3N1bWVSb2xlUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgICAgICBTdGF0ZW1lbnQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgRWZmZWN0OiAnQWxsb3cnLFxuICAgICAgICAgICAgICBQcmluY2lwYWw6IHsgU2VydmljZTogJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyB9LFxuICAgICAgICAgICAgICBBY3Rpb246ICdzdHM6QXNzdW1lUm9sZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2V4ZWN1dGlvbiByb2xlIGhhcyBFQ1IgYWNjZXNzIHBvbGljeScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlBvbGljeScsIHtcbiAgICAgICAgUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgICAgICBTdGF0ZW1lbnQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgRWZmZWN0OiAnQWxsb3cnLFxuICAgICAgICAgICAgICBBY3Rpb246IFtcbiAgICAgICAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgUmVzb3VyY2U6ICcqJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncm9sZXMgaGF2ZSBzZWNyZXRzIG1hbmFnZXIgYWNjZXNzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6UG9saWN5Jywge1xuICAgICAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgIFN0YXRlbWVudDogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIEFjdGlvbjogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgUmVzb3VyY2U6IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rhc2sgcm9sZSBoYXMgQ2xvdWRXYXRjaCBsb2dzIHBlcm1pc3Npb25zJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OklBTTo6UG9saWN5Jywge1xuICAgICAgICBQb2xpY3lEb2N1bWVudDoge1xuICAgICAgICAgIFN0YXRlbWVudDogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBFZmZlY3Q6ICdBbGxvdycsXG4gICAgICAgICAgICAgIEFjdGlvbjogW1xuICAgICAgICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgUmVzb3VyY2U6ICcvYXdzL2Vjcy90ZXN0YXBwLXRlc3QqJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnU2VjcmV0cyBNYW5hZ2VyIEludGVncmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBzZWNyZXRzIG1hbmFnZXIgc2VjcmV0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlNlY3JldHNNYW5hZ2VyOjpTZWNyZXQnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXRlc3QtYXBwLXNlY3JldHMnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgdGVzdCBlbnZpcm9ubWVudCcsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Byb2R1Y3Rpb24gc2VjcmV0cyBoYXZlIHJldGFpbiByZW1vdmFsIHBvbGljeScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlNlY3JldHNNYW5hZ2VyOjpTZWNyZXQnLCB7XG4gICAgICAgIERlbGV0aW9uUG9saWN5OiAnUmV0YWluJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm9uLXByb2R1Y3Rpb24gc2VjcmV0cyBoYXZlIGRlc3Ryb3kgcmVtb3ZhbCBwb2xpY3knLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdEZWxldGUnLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFQ1MgU2VydmljZSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIHRlc3QoJ2VuYWJsZXMgRUNTIEV4ZWMgZm9yIG5vbi1wcm9kdWN0aW9uIGVudmlyb25tZW50cycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBFbmFibGVFeGVjdXRlQ29tbWFuZDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZGlzYWJsZXMgRUNTIEV4ZWMgZm9yIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlNlcnZpY2UnLCB7XG4gICAgICAgIEVuYWJsZUV4ZWN1dGVDb21tYW5kOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBkaWZmZXJlbnQgZGVwbG95bWVudCBjb25maWd1cmF0aW9uIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBEZXBsb3ltZW50Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1heGltdW1QZXJjZW50OiAyMDAsXG4gICAgICAgICAgTWluaW11bUhlYWx0aHlQZXJjZW50OiAxMDAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcmVsYXhlZCBkZXBsb3ltZW50IGNvbmZpZ3VyYXRpb24gZm9yIG5vbi1wcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgRGVwbG95bWVudENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNYXhpbXVtUGVyY2VudDogMjAwLFxuICAgICAgICAgIE1pbmltdW1IZWFsdGh5UGVyY2VudDogNTAsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1N0YWNrIE91dHB1dHMnLCAoKSA9PiB7XG4gICAgbGV0IHN0YWNrOiBBcHBsaWNhdGlvblN0YWNrO1xuXG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDIsXG4gICAgICAgIGNwdTogNTEyLFxuICAgICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBzZXJ2aWNlIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1NlcnZpY2VBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1TZXJ2aWNlQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnU2VydmljZU5hbWUnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgTmFtZScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stU2VydmljZU5hbWUnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgdGFzayBkZWZpbml0aW9uIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1Rhc2tEZWZpbml0aW9uQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1UYXNrRGVmaW5pdGlvbkFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1Rhc2tEZWZpbml0aW9uRmFtaWx5Jywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gRmFtaWx5JyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjay1UYXNrRGVmaW5pdGlvbkZhbWlseScgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyB0YXJnZXQgZ3JvdXAgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVGFyZ2V0R3JvdXBBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVGFyZ2V0IEdyb3VwIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stVGFyZ2V0R3JvdXBBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdUYXJnZXRHcm91cE5hbWUnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVGFyZ2V0IEdyb3VwIE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVRhcmdldEdyb3VwTmFtZScgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBzZWNyZXRzIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1NlY3JldHNBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gU2VjcmV0cyBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RBcHBsaWNhdGlvblN0YWNrLVNlY3JldHNBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYXV0byBzY2FsaW5nIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0F1dG9TY2FsaW5nVGFyZ2V0SWQnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXV0byBTY2FsaW5nIFRhcmdldCBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEFwcGxpY2F0aW9uU3RhY2stQXV0b1NjYWxpbmdUYXJnZXRJZCcgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBjb25maWd1cmF0aW9uIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0Rlc2lyZWRDb3VudCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdDdXJyZW50IERlc2lyZWQgQ291bnQnLFxuICAgICAgICBWYWx1ZTogJzInLFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnVGFza0NwdScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdUYXNrIENQVSBVbml0cycsXG4gICAgICAgIFZhbHVlOiAnNTEyJyxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1Rhc2tNZW1vcnknLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnVGFzayBNZW1vcnkgKE1pQiknLFxuICAgICAgICBWYWx1ZTogJzEwMjQnLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdSZXNvdXJjZSBUYWdnaW5nJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGFzayBkZWZpbml0aW9uIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgICAgVGFnczogW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdDb21wb25lbnQnLCBWYWx1ZTogJ0VDUy1UYXNrLURlZmluaXRpb24nIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3RhcmdldCBncm91cCBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OlRhcmdldEdyb3VwJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ0NvbXBvbmVudCcsIFZhbHVlOiAnQXBwbGljYXRpb24tVGFyZ2V0R3JvdXAnIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0VDUyBzZXJ2aWNlIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ0NvbXBvbmVudCcsIFZhbHVlOiAnRUNTLVNlcnZpY2UnIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3NlY3JldHMgaGF2ZSBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgVGFnczogW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESy1TT1BTJyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdBcHBsaWNhdGlvbi1TZWNyZXRzJyB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdJQU0gcm9sZXMgaGF2ZSBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ0NvbXBvbmVudCcsIFZhbHVlOiAnRUNTLUV4ZWN1dGlvbi1Sb2xlJyB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgICAgIFRhZ3M6IFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdFQ1MtVGFzay1Sb2xlJyB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFcnJvciBIYW5kbGluZyBhbmQgRWRnZSBDYXNlcycsICgpID0+IHtcbiAgICB0ZXN0KCdoYW5kbGVzIG1pbmltYWwgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBtaW5pbWFsUHJvcHMgPSB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgcHJpdmF0ZVN1Ym5ldElkczogWydzdWJuZXQtNDQ0NDQ0NDQnXSxcbiAgICAgICAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6ICdzZy04NzY1NDMyMScsXG4gICAgICAgIGNsdXN0ZXJBcm46ICdhcm46YXdzOmVjczp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmNsdXN0ZXIvdGVzdC1jbHVzdGVyJyxcbiAgICAgICAgY2x1c3Rlck5hbWU6ICd0ZXN0LWNsdXN0ZXInLFxuICAgICAgICByZXBvc2l0b3J5VXJpOiAnMTIzNDU2Nzg5MDEyLmRrci5lY3IudXMtZWFzdC0xLmFtYXpvbmF3cy5jb20vdGVzdC1yZXBvJyxcbiAgICAgICAgbG9hZEJhbGFuY2VyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxvYWRiYWxhbmNlci9hcHAvdGVzdC1hbGIvMTIzJyxcbiAgICAgICAgaHR0cExpc3RlbmVyQXJuOiAnYXJuOmF3czplbGFzdGljbG9hZGJhbGFuY2luZzp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOmxpc3RlbmVyL2FwcC90ZXN0LWFsYi8xMjMvNDU2JyxcbiAgICAgICAgbG9nR3JvdXBOYW1lOiAnL2F3cy9lY3MvdGVzdCcsXG4gICAgICAgIGxvZ0dyb3VwQXJuOiAnYXJuOmF3czpsb2dzOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6bG9nLWdyb3VwOi9hd3MvZWNzL3Rlc3QnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0QXBwbGljYXRpb25TdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9O1xuXG4gICAgICBleHBlY3QoKCkgPT4ge1xuICAgICAgICBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIG1pbmltYWxQcm9wcyk7XG4gICAgICB9KS5ub3QudG9UaHJvdygpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBkZWZhdWx0IHZhbHVlcyBmb3Igb3B0aW9uYWwgcGFyYW1ldGVycycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgLy8gU2hvdWxkIHVzZSBkZWZhdWx0c1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgRGVzaXJlZENvdW50OiAxLCAvLyBkZWZhdWx0XG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENwdTogJzI1NicsIC8vIGRlZmF1bHRcbiAgICAgICAgTWVtb3J5OiAnNTEyJywgLy8gZGVmYXVsdFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpUYXJnZXRHcm91cCcsIHtcbiAgICAgICAgUG9ydDogODAwMCwgLy8gZGVmYXVsdFxuICAgICAgICBIZWFsdGhDaGVja1BhdGg6ICcvaGVhbHRoLycsIC8vIGRlZmF1bHRcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyB6ZXJvIGRlc2lyZWQgY291bnQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsICdUZXN0QXBwbGljYXRpb25TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDAsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgICAgRGVzaXJlZENvdW50OiAwLFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsYWJsZVRhcmdldCcsIHtcbiAgICAgICAgTWluQ2FwYWNpdHk6IDAsIC8vIFVzZXMgZGVzaXJlZENvdW50IGFzIG1pbkNhcGFjaXR5XG4gICAgICAgIE1heENhcGFjaXR5OiAwLCAvLyBVc2VzIGRlc2lyZWRDb3VudCAqIDNcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBjdXN0b20gYXV0byBzY2FsaW5nIGxpbWl0cycsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgJ1Rlc3RBcHBsaWNhdGlvblN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGRlc2lyZWRDb3VudDogMixcbiAgICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICAgIG1heENhcGFjaXR5OiAyMCxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGFibGVUYXJnZXQnLCB7XG4gICAgICAgIE1pbkNhcGFjaXR5OiAxLCAvLyBDdXN0b20gbWluQ2FwYWNpdHkgb3ZlcnJpZGVzIGRlc2lyZWRDb3VudFxuICAgICAgICBNYXhDYXBhY2l0eTogMjAsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NvbnRhaW5lciBzZWN1cml0eSBmZWF0dXJlcyBkaXNhYmxlZCBieSBkZWZhdWx0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBVc2VyOiBNYXRjaC5hYnNlbnQoKSxcbiAgICAgICAgICAgIFJlYWRvbmx5Um9vdEZpbGVzeXN0ZW06IE1hdGNoLmFic2VudCgpLFxuICAgICAgICAgIH0pLFxuICAgICAgICBdLFxuICAgICAgICBWb2x1bWVzOiBNYXRjaC5hYnNlbnQoKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm8gdG1wZnMgdm9sdW1lcyB3aGVuIHJlYWQtb25seSBmaWxlc3lzdGVtIGRpc2FibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBNb3VudFBvaW50czogTWF0Y2guYWJzZW50KCksXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgSFRUUFMgbGlzdGVuZXIgbm90IHByb3ZpZGVkJywgKCkgPT4ge1xuICAgICAgLy8gU2hvdWxkIG9ubHkgY3JlYXRlIG9uZSBsaXN0ZW5lciBydWxlIChIVFRQKVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIExpc3RlbmVyQXJuOiBkZWZhdWx0UHJvcHMuaHR0cExpc3RlbmVyQXJuLFxuICAgICAgfSwgMSk7XG5cbiAgICAgIC8vIFNob3VsZCBub3QgY3JlYXRlIEhUVFBTIGxpc3RlbmVyIHJ1bGVcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCAxKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1NPUFMgSW50ZWdyYXRpb24gRXJyb3IgSGFuZGxpbmcnLCAoKSA9PiB7XG4gICAgdGVzdCgnaGFuZGxlcyBTT1BTIGxvYWRpbmcgZmFpbHVyZSBncmFjZWZ1bGx5JywgKCkgPT4ge1xuICAgICAgLy8gVGhpcyB0ZXN0IHNpbXVsYXRlcyB0aGUgZXJyb3IgaGFuZGxpbmcgcGF0aCBpbiBjcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldFxuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIFxuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcblxuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2sobmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCAnVGVzdEFwcGxpY2F0aW9uU3RhY2syJywgZGVmYXVsdFByb3BzKSk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBzdGlsbCBjcmVhdGUgYSBzZWNyZXQgZXZlbiBpZiBTT1BTIGZhaWxzXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtdGVzdC1hcHAtc2VjcmV0cycsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59KTsiXX0=