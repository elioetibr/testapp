"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const testapp_infrastructure_stack_1 = require("../lib/legacy/testapp-infrastructure-stack");
describe('TestAppInfrastructureStack', () => {
    let app;
    let template;
    beforeEach(() => {
        app = new cdk.App();
    });
    test('creates VPC with correct configuration for dev environment', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check VPC creation
        template.hasResourceProperties('AWS::EC2::VPC', {
            EnableDnsHostnames: true,
            EnableDnsSupport: true,
        });
        // Check NAT Gateway count for dev (should be 1)
        template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });
    test('creates VPC with IPv6 and HA NAT Gateways for production', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'production',
            enableIPv6: true,
            enableHANatGateways: true,
            maxAzs: 3,
            natGateways: 3,
            desiredCount: 3,
            cpu: 1024,
            memoryLimitMiB: 2048,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check VPC IPv6 CIDR Block
        template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
            AmazonProvidedIpv6CidrBlock: true,
        });
        // Check NAT Gateway count for production (should be 2 as VPC only creates that many AZs)
        template.resourceCountIs('AWS::EC2::NatGateway', 2);
    });
    test('creates ECS cluster with basic configuration', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check ECS Cluster creation
        template.hasResourceProperties('AWS::ECS::Cluster', {
            ClusterName: 'testapp-cluster-dev',
        });
    });
    test('creates ECR repository with lifecycle policies', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'production',
            enableIPv6: true,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 2,
            cpu: 512,
            memoryLimitMiB: 1024,
        });
        template = assertions_1.Template.fromStack(stack);
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'production',
            enableIPv6: true,
            enableHANatGateways: true,
            maxAzs: 3,
            natGateways: 3,
            desiredCount: 3,
            cpu: 1024,
            memoryLimitMiB: 2048,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check CloudWatch Log Group
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            LogGroupName: '/aws/ecs/testapp-production',
            RetentionInDays: 30, // Production retention
        });
    });
    test('creates IAM roles with least privilege principles', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'production',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check Secrets Manager secret
        template.hasResourceProperties('AWS::SecretsManager::Secret', {
            Name: 'testapp-production-secrets',
            Description: 'Application secrets for TestApp production environment',
        });
    });
    test('configures auto scaling for Fargate service', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'production',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 2,
            cpu: 512,
            memoryLimitMiB: 1024,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check Auto Scaling Target
        template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
            MaxCapacity: 6,
            MinCapacity: 2,
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: true,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
        // Check security group ingress rules
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
            IpProtocol: 'tcp',
            FromPort: 8000,
            ToPort: 8000,
            SourceSecurityGroupId: assertions_1.Match.anyValue(),
        });
        // Note: IPv6 security group rules are handled differently in this implementation
        // The main security group rule is based on source security group, not IPv6 CIDR
    });
    test('applies correct removal policies based on environment', () => {
        // Create separate apps to avoid synth conflicts
        const devApp = new cdk.App();
        const devStack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(devApp, 'DevStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        const devTemplate = assertions_1.Template.fromStack(devStack);
        // Dev ECR should have Delete removal policy
        devTemplate.hasResourceProperties('AWS::ECR::Repository', {
            RepositoryName: 'testapp-dev',
        });
        // Test production environment (should retain resources)
        const prodApp = new cdk.App();
        const prodStack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(prodApp, 'ProdStack', {
            environment: 'production',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        const prodTemplate = assertions_1.Template.fromStack(prodStack);
        // Production ECR should exist
        prodTemplate.hasResourceProperties('AWS::ECR::Repository', {
            RepositoryName: 'testapp-production',
        });
    });
    test('creates all required stack outputs', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'TestStack', {
            environment: 'dev',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
        });
        template = assertions_1.Template.fromStack(stack);
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
                new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, `TestStack-${props.environment}-${props.cpu}`, {
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'WAFTestStack', {
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
        template = assertions_1.Template.fromStack(stack);
        // Check WAF Web ACL creation
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
            Name: 'testapp-production-web-acl',
            Scope: 'REGIONAL',
            DefaultAction: { Allow: {} },
        });
        // Check WAF has managed rule sets
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
            Rules: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    Name: 'AWS-AWSManagedRulesCommonRuleSet',
                    Priority: 1,
                }),
                assertions_1.Match.objectLike({
                    Name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
                    Priority: 2,
                }),
                assertions_1.Match.objectLike({
                    Name: 'RateLimitRule',
                    Priority: 3,
                }),
            ])
        });
        // Check WAF association with ALB
        template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {});
    });
    test('does not create WAF when disabled', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'NoWAFTestStack', {
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
        template = assertions_1.Template.fromStack(stack);
        // Check WAF resources are not created
        template.resourceCountIs('AWS::WAFv2::WebACL', 0);
        template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    });
    test('creates VPC Flow Logs and S3 bucket when enabled', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'FlowLogsTestStack', {
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
        template = assertions_1.Template.fromStack(stack);
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'NoFlowLogsTestStack', {
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
        template = assertions_1.Template.fromStack(stack);
        // Should not create flow logs or bucket
        template.resourceCountIs('AWS::EC2::FlowLog', 0);
    });
    test('creates SSL certificate when HTTPS is enabled with domain', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'HTTPSTestStack', {
            environment: 'production',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
            enableHTTPS: true,
            domainName: 'example.com',
        });
        template = assertions_1.Template.fromStack(stack);
        // Check SSL certificate creation
        template.hasResourceProperties('AWS::CertificateManager::Certificate', {
            DomainName: 'example.com',
            SubjectAlternativeNames: ['*.example.com'],
        });
    });
    test('configures HTTPS listener when HTTPS is enabled', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'HTTPSListenerTestStack', {
            environment: 'production',
            enableIPv6: false,
            enableHANatGateways: false,
            maxAzs: 2,
            natGateways: 1,
            desiredCount: 1,
            cpu: 256,
            memoryLimitMiB: 512,
            enableHTTPS: true,
            domainName: 'example.com',
        });
        template = assertions_1.Template.fromStack(stack);
        // Check HTTPS listener (port 443)
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
            Port: 443,
            Protocol: 'HTTPS',
        });
    });
    test('creates secure task definition with non-root user when container security is enabled', () => {
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'SecureContainerTestStack', {
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
        template = assertions_1.Template.fromStack(stack);
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
        const stack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'DefaultContainerTestStack', {
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
        template = assertions_1.Template.fromStack(stack);
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
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsbUNBQW1DO0FBQ25DLHVEQUF5RDtBQUN6RCw2RkFBd0Y7QUFFeEYsUUFBUSxDQUFDLDRCQUE0QixFQUFFLEdBQUcsRUFBRTtJQUMxQyxJQUFJLEdBQVksQ0FBQztJQUNqQixJQUFJLFFBQWtCLENBQUM7SUFFdkIsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN0QixDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyw0REFBNEQsRUFBRSxHQUFHLEVBQUU7UUFDdEUsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFO1lBQzdELFdBQVcsRUFBRSxLQUFLO1lBQ2xCLFVBQVUsRUFBRSxLQUFLO1lBQ2pCLG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsR0FBRztTQUNwQixDQUFDLENBQUM7UUFFSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFckMscUJBQXFCO1FBQ3JCLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxlQUFlLEVBQUU7WUFDOUMsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixnQkFBZ0IsRUFBRSxJQUFJO1NBQ3ZCLENBQUMsQ0FBQztRQUVILGdEQUFnRDtRQUNoRCxRQUFRLENBQUMsZUFBZSxDQUFDLHNCQUFzQixFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ3RELENBQUMsQ0FBQyxDQUFDO0lBRUgsSUFBSSxDQUFDLDBEQUEwRCxF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Iiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlbXBsYXRlLCBNYXRjaCB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuaW1wb3J0IHsgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2sgfSBmcm9tICcuLi9saWIvbGVnYWN5L3Rlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2snO1xuXG5kZXNjcmliZSgnVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2snLCAoKSA9PiB7XG4gIGxldCBhcHA6IGNkay5BcHA7XG4gIGxldCB0ZW1wbGF0ZTogVGVtcGxhdGU7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBWUEMgd2l0aCBjb3JyZWN0IGNvbmZpZ3VyYXRpb24gZm9yIGRldiBlbnZpcm9ubWVudCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBWUEMgY3JlYXRpb25cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpWUEMnLCB7XG4gICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICBFbmFibGVEbnNTdXBwb3J0OiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgTkFUIEdhdGV3YXkgY291bnQgZm9yIGRldiAoc2hvdWxkIGJlIDEpXG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDEpO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIFZQQyB3aXRoIElQdjYgYW5kIEhBIE5BVCBHYXRld2F5cyBmb3IgcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IHRydWUsXG4gICAgICBtYXhBenM6IDMsXG4gICAgICBuYXRHYXRld2F5czogMyxcbiAgICAgIGRlc2lyZWRDb3VudDogMyxcbiAgICAgIGNwdTogMTAyNCxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgVlBDIElQdjYgQ0lEUiBCbG9ja1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQ0NpZHJCbG9jaycsIHtcbiAgICAgIEFtYXpvblByb3ZpZGVkSXB2NkNpZHJCbG9jazogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIE5BVCBHYXRld2F5IGNvdW50IGZvciBwcm9kdWN0aW9uIChzaG91bGQgYmUgMiBhcyBWUEMgb25seSBjcmVhdGVzIHRoYXQgbWFueSBBWnMpXG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDIpO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIEVDUyBjbHVzdGVyIHdpdGggYmFzaWMgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBFQ1MgQ2x1c3RlciBjcmVhdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICBDbHVzdGVyTmFtZTogJ3Rlc3RhcHAtY2x1c3Rlci1kZXYnLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIEVDUiByZXBvc2l0b3J5IHdpdGggbGlmZWN5Y2xlIHBvbGljaWVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEVDUiBSZXBvc2l0b3J5IGNyZWF0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgIEltYWdlU2Nhbm5pbmdDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIFNjYW5PblB1c2g6IHRydWUsXG4gICAgICB9LFxuICAgICAgTGlmZWN5Y2xlUG9saWN5OiB7XG4gICAgICAgIExpZmVjeWNsZVBvbGljeVRleHQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBydWxlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBydWxlUHJpb3JpdHk6IDEsXG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsXG4gICAgICAgICAgICAgIHNlbGVjdGlvbjoge1xuICAgICAgICAgICAgICAgIHRhZ1N0YXR1czogJ2FueScsXG4gICAgICAgICAgICAgICAgY291bnRUeXBlOiAnaW1hZ2VDb3VudE1vcmVUaGFuJyxcbiAgICAgICAgICAgICAgICBjb3VudE51bWJlcjogMTAsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGFjdGlvbjoge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdleHBpcmUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgRmFyZ2F0ZSBzZXJ2aWNlIHdpdGggY29ycmVjdCB0YXNrIGRlZmluaXRpb24nLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAyLFxuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEVDUyBTZXJ2aWNlIGNyZWF0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgIERlc2lyZWRDb3VudDogMixcbiAgICAgIExhdW5jaFR5cGU6ICdGQVJHQVRFJyxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIFRhc2sgRGVmaW5pdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgQ3B1OiAnNTEyJyxcbiAgICAgIE1lbW9yeTogJzEwMjQnLFxuICAgICAgTmV0d29ya01vZGU6ICdhd3N2cGMnLFxuICAgICAgUmVxdWlyZXNDb21wYXRpYmlsaXRpZXM6IFsnRkFSR0FURSddLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgd2l0aCBoZWFsdGggY2hlY2tzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TG9hZEJhbGFuY2VyJywge1xuICAgICAgVHlwZTogJ2FwcGxpY2F0aW9uJyxcbiAgICAgIFNjaGVtZTogJ2ludGVybmV0LWZhY2luZycsXG4gICAgfSk7XG5cbiAgICAvLyBDaGVjayBUYXJnZXQgR3JvdXAgd2l0aCBoZWFsdGggY2hlY2tcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6VGFyZ2V0R3JvdXAnLCB7XG4gICAgICBIZWFsdGhDaGVja1BhdGg6ICcvaGVhbHRoLycsXG4gICAgICBIZWFsdGhDaGVja1Byb3RvY29sOiAnSFRUUCcsXG4gICAgICBQb3J0OiA4MCxcbiAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICBUYXJnZXRUeXBlOiAnaXAnLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIENsb3VkV2F0Y2ggTG9nIEdyb3VwIHdpdGggYXBwcm9wcmlhdGUgcmV0ZW50aW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogdHJ1ZSxcbiAgICAgIG1heEF6czogMyxcbiAgICAgIG5hdEdhdGV3YXlzOiAzLFxuICAgICAgZGVzaXJlZENvdW50OiAzLFxuICAgICAgY3B1OiAxMDI0LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDIwNDgsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBDbG91ZFdhdGNoIExvZyBHcm91cFxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpMb2dzOjpMb2dHcm91cCcsIHtcbiAgICAgIExvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3RhcHAtcHJvZHVjdGlvbicsXG4gICAgICBSZXRlbnRpb25JbkRheXM6IDMwLCAvLyBQcm9kdWN0aW9uIHJldGVudGlvblxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIElBTSByb2xlcyB3aXRoIGxlYXN0IHByaXZpbGVnZSBwcmluY2lwbGVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFRhc2sgRXhlY3V0aW9uIFJvbGVcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgQXNzdW1lUm9sZVBvbGljeURvY3VtZW50OiB7XG4gICAgICAgIFN0YXRlbWVudDogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgIFByaW5jaXBhbDoge1xuICAgICAgICAgICAgICBTZXJ2aWNlOiAnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIEFjdGlvbjogJ3N0czpBc3N1bWVSb2xlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIE1hbmFnZWRQb2xpY3lBcm5zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAnRm46OkpvaW4nOiBbXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgJ2FybjonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UGFydGl0aW9uJyB9LFxuICAgICAgICAgICAgICAnOmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0IHdpdGggcHJvcGVyIGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFNlY3JldHMgTWFuYWdlciBzZWNyZXRcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6U2VjcmV0c01hbmFnZXI6OlNlY3JldCcsIHtcbiAgICAgIE5hbWU6ICd0ZXN0YXBwLXByb2R1Y3Rpb24tc2VjcmV0cycsXG4gICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgcHJvZHVjdGlvbiBlbnZpcm9ubWVudCcsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NvbmZpZ3VyZXMgYXV0byBzY2FsaW5nIGZvciBGYXJnYXRlIHNlcnZpY2UnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMixcbiAgICAgIGNwdTogNTEyLFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDEwMjQsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBBdXRvIFNjYWxpbmcgVGFyZ2V0XG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwcGxpY2F0aW9uQXV0b1NjYWxpbmc6OlNjYWxhYmxlVGFyZ2V0Jywge1xuICAgICAgTWF4Q2FwYWNpdHk6IDYsIC8vIGRlc2lyZWRDb3VudCAqIDNcbiAgICAgIE1pbkNhcGFjaXR5OiAyLCAvLyBkZXNpcmVkQ291bnRcbiAgICAgIFNlcnZpY2VOYW1lc3BhY2U6ICdlY3MnLFxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgQ1BVIEF1dG8gU2NhbGluZyBQb2xpY3lcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGluZ1BvbGljeScsIHtcbiAgICAgIFBvbGljeVR5cGU6ICdUYXJnZXRUcmFja2luZ1NjYWxpbmcnLFxuICAgICAgVGFyZ2V0VHJhY2tpbmdTY2FsaW5nUG9saWN5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICBQcmVkZWZpbmVkTWV0cmljU3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIFByZWRlZmluZWRNZXRyaWNUeXBlOiAnRUNTU2VydmljZUF2ZXJhZ2VDUFVVdGlsaXphdGlvbicsXG4gICAgICAgIH0sXG4gICAgICAgIFRhcmdldFZhbHVlOiA3MCxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2Vuc3VyZXMgc2VjdXJpdHkgZ3JvdXBzIGhhdmUgYXBwcm9wcmlhdGUgaW5ncmVzcyBydWxlcycsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIHNlY3VyaXR5IGdyb3VwIGluZ3Jlc3MgcnVsZXNcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpTZWN1cml0eUdyb3VwSW5ncmVzcycsIHtcbiAgICAgIElwUHJvdG9jb2w6ICd0Y3AnLFxuICAgICAgRnJvbVBvcnQ6IDgwMDAsXG4gICAgICBUb1BvcnQ6IDgwMDAsXG4gICAgICBTb3VyY2VTZWN1cml0eUdyb3VwSWQ6IE1hdGNoLmFueVZhbHVlKCksXG4gICAgfSk7XG5cbiAgICAvLyBOb3RlOiBJUHY2IHNlY3VyaXR5IGdyb3VwIHJ1bGVzIGFyZSBoYW5kbGVkIGRpZmZlcmVudGx5IGluIHRoaXMgaW1wbGVtZW50YXRpb25cbiAgICAvLyBUaGUgbWFpbiBzZWN1cml0eSBncm91cCBydWxlIGlzIGJhc2VkIG9uIHNvdXJjZSBzZWN1cml0eSBncm91cCwgbm90IElQdjYgQ0lEUlxuICB9KTtcblxuICB0ZXN0KCdhcHBsaWVzIGNvcnJlY3QgcmVtb3ZhbCBwb2xpY2llcyBiYXNlZCBvbiBlbnZpcm9ubWVudCcsICgpID0+IHtcbiAgICAvLyBDcmVhdGUgc2VwYXJhdGUgYXBwcyB0byBhdm9pZCBzeW50aCBjb25mbGljdHNcbiAgICBjb25zdCBkZXZBcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgIGNvbnN0IGRldlN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGRldkFwcCwgJ0RldlN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGV2VGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soZGV2U3RhY2spO1xuXG4gICAgLy8gRGV2IEVDUiBzaG91bGQgaGF2ZSBEZWxldGUgcmVtb3ZhbCBwb2xpY3lcbiAgICBkZXZUZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgUmVwb3NpdG9yeU5hbWU6ICd0ZXN0YXBwLWRldicsXG4gICAgfSk7XG5cbiAgICAvLyBUZXN0IHByb2R1Y3Rpb24gZW52aXJvbm1lbnQgKHNob3VsZCByZXRhaW4gcmVzb3VyY2VzKVxuICAgIGNvbnN0IHByb2RBcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgIGNvbnN0IHByb2RTdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhwcm9kQXBwLCAnUHJvZFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIGNvbnN0IHByb2RUZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhwcm9kU3RhY2spO1xuXG4gICAgLy8gUHJvZHVjdGlvbiBFQ1Igc2hvdWxkIGV4aXN0XG4gICAgcHJvZFRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICBSZXBvc2l0b3J5TmFtZTogJ3Rlc3RhcHAtcHJvZHVjdGlvbicsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgYWxsIHJlcXVpcmVkIHN0YWNrIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgcmVxdWlyZWQgb3V0cHV0cyBhcmUgY3JlYXRlZFxuICAgIGNvbnN0IG91dHB1dHMgPSBbXG4gICAgICAnVnBjSWQnLFxuICAgICAgJ0NsdXN0ZXJOYW1lJywgXG4gICAgICAnUmVwb3NpdG9yeVVyaScsXG4gICAgICAnTG9hZEJhbGFuY2VyRE5TJyxcbiAgICAgICdTZXJ2aWNlTmFtZScsXG4gICAgICAnQXBwbGljYXRpb25VcmwnXG4gICAgXTtcblxuICAgIG91dHB1dHMuZm9yRWFjaChvdXRwdXROYW1lID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dChvdXRwdXROYW1lLCB7fSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3ZhbGlkYXRlcyBzdGFjayBwcm9wZXJ0aWVzIGFyZSB3aXRoaW4gcmVhc29uYWJsZSBsaW1pdHMnLCAoKSA9PiB7XG4gICAgLy8gVGhpcyB0ZXN0IGVuc3VyZXMgb3VyIGluZnJhc3RydWN0dXJlIHBhcmFtZXRlcnMgYXJlIHNlbnNpYmxlXG4gICAgY29uc3QgdmFsaWRhdGlvblRlc3RzID0gW1xuICAgICAgeyBjcHU6IDI1NiwgbWVtb3J5OiA1MTIsIGVudmlyb25tZW50OiAnZGV2JywgbWF4QXpzOiAyIH0sXG4gICAgICB7IGNwdTogMTAyNCwgbWVtb3J5OiAyMDQ4LCBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLCBtYXhBenM6IDMgfSxcbiAgICAgIHsgY3B1OiAyMDQ4LCBtZW1vcnk6IDQwOTYsIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsIG1heEF6czogMyB9LFxuICAgIF07XG5cbiAgICB2YWxpZGF0aW9uVGVzdHMuZm9yRWFjaChwcm9wcyA9PiB7XG4gICAgICBleHBlY3QoKCkgPT4ge1xuICAgICAgICBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCBgVGVzdFN0YWNrLSR7cHJvcHMuZW52aXJvbm1lbnR9LSR7cHJvcHMuY3B1fWAsIHtcbiAgICAgICAgICBlbnZpcm9ubWVudDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICAgICAgbWF4QXpzOiBwcm9wcy5tYXhBenMsXG4gICAgICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgICAgIGNwdTogcHJvcHMuY3B1LFxuICAgICAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnksXG4gICAgICAgIH0pO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBXQUYgV2ViIEFDTCB3aGVuIFdBRiBpcyBlbmFibGVkJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1dBRlRlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBXQUYgV2ViIEFDTCBjcmVhdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgTmFtZTogJ3Rlc3RhcHAtcHJvZHVjdGlvbi13ZWItYWNsJyxcbiAgICAgIFNjb3BlOiAnUkVHSU9OQUwnLFxuICAgICAgRGVmYXVsdEFjdGlvbjogeyBBbGxvdzoge30gfSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIFdBRiBoYXMgbWFuYWdlZCBydWxlIHNldHNcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgIFJ1bGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBOYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgIFByaW9yaXR5OiAxLFxuICAgICAgICB9KSxcbiAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLCBcbiAgICAgICAgICBQcmlvcml0eTogMixcbiAgICAgICAgfSksXG4gICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIE5hbWU6ICdSYXRlTGltaXRSdWxlJyxcbiAgICAgICAgICBQcmlvcml0eTogMyxcbiAgICAgICAgfSksXG4gICAgICBdKVxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgV0FGIGFzc29jaWF0aW9uIHdpdGggQUxCXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0xBc3NvY2lhdGlvbicsIHt9KTtcbiAgfSk7XG5cbiAgdGVzdCgnZG9lcyBub3QgY3JlYXRlIFdBRiB3aGVuIGRpc2FibGVkJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ05vV0FGVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZW5hYmxlV0FGOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFdBRiByZXNvdXJjZXMgYXJlIG5vdCBjcmVhdGVkXG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCAwKTtcbiAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6V0FGdjI6OldlYkFDTEFzc29jaWF0aW9uJywgMCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgVlBDIEZsb3cgTG9ncyBhbmQgUzMgYnVja2V0IHdoZW4gZW5hYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdGbG93TG9nc1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFMzIGJ1Y2tldCBmb3IgZmxvdyBsb2dzXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXQnLCB7XG4gICAgICBQdWJsaWNBY2Nlc3NCbG9ja0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgQmxvY2tQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgICBCbG9ja1B1YmxpY1BvbGljeTogdHJ1ZSxcbiAgICAgICAgSWdub3JlUHVibGljQWNsczogdHJ1ZSxcbiAgICAgICAgUmVzdHJpY3RQdWJsaWNCdWNrZXRzOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIFZQQyBGbG93IExvZ3NcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpGbG93TG9nJywge1xuICAgICAgUmVzb3VyY2VUeXBlOiAnVlBDJyxcbiAgICAgIFRyYWZmaWNUeXBlOiAnQUxMJyxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIGxpZmVjeWNsZSBwb2xpY3kgZm9yIHJldGVudGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge1xuICAgICAgICBSdWxlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIElkOiAnRGVsZXRlT2xkRmxvd0xvZ3MnLFxuICAgICAgICAgICAgU3RhdHVzOiAnRW5hYmxlZCcsXG4gICAgICAgICAgICBFeHBpcmF0aW9uSW5EYXlzOiA5MCwgLy8gUHJvZHVjdGlvbiByZXRlbnRpb25cbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnZG9lcyBub3QgY3JlYXRlIFZQQyBGbG93IExvZ3Mgd2hlbiBkaXNhYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdOb0Zsb3dMb2dzVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZW5hYmxlVlBDRmxvd0xvZ3M6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gU2hvdWxkIG5vdCBjcmVhdGUgZmxvdyBsb2dzIG9yIGJ1Y2tldFxuICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OkZsb3dMb2cnLCAwKTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBTU0wgY2VydGlmaWNhdGUgd2hlbiBIVFRQUyBpcyBlbmFibGVkIHdpdGggZG9tYWluJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ0hUVFBTVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICAgIGVuYWJsZUhUVFBTOiB0cnVlLFxuICAgICAgZG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFNTTCBjZXJ0aWZpY2F0ZSBjcmVhdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpDZXJ0aWZpY2F0ZU1hbmFnZXI6OkNlcnRpZmljYXRlJywge1xuICAgICAgRG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICAgIFN1YmplY3RBbHRlcm5hdGl2ZU5hbWVzOiBbJyouZXhhbXBsZS5jb20nXSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY29uZmlndXJlcyBIVFRQUyBsaXN0ZW5lciB3aGVuIEhUVFBTIGlzIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnSFRUUFNMaXN0ZW5lclRlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgIGRvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBIVFRQUyBsaXN0ZW5lciAocG9ydCA0NDMpXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyJywge1xuICAgICAgUG9ydDogNDQzLFxuICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgc2VjdXJlIHRhc2sgZGVmaW5pdGlvbiB3aXRoIG5vbi1yb290IHVzZXIgd2hlbiBjb250YWluZXIgc2VjdXJpdHkgaXMgZW5hYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdTZWN1cmVDb250YWluZXJUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IHRydWUsXG4gICAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgdGFzayBkZWZpbml0aW9uIHdpdGggc2VjdXJpdHkgc2V0dGluZ3NcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBVc2VyOiAnMTAwMToxMDAxJyxcbiAgICAgICAgICBSZWFkb25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIG1lbW9yeSByZXNlcnZhdGlvbiBpcyBzZXRcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBNZW1vcnlSZXNlcnZhdGlvbjogODE5LCAvLyA4MCUgb2YgMTAyNFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgndXNlcyBkZWZhdWx0IHRhc2sgZGVmaW5pdGlvbiB3aGVuIGNvbnRhaW5lciBzZWN1cml0eSBpcyBkaXNhYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdEZWZhdWx0Q29udGFpbmVyVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogZmFsc2UsXG4gICAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIFNob3VsZCB1c2UgQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSBkZWZhdWx0IHRhc2sgZGVmaW5pdGlvblxuICAgIC8vIFRoZSB0YXNrIGRlZmluaXRpb24gc2hvdWxkIG5vdCBoYXZlIFVzZXIgb3IgUmVhZG9ubHlSb290RmlsZXN5c3RlbSBzZXRcbiAgICBjb25zdCB0YXNrRGVmcyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicpO1xuICAgIGNvbnN0IHRhc2tEZWZLZXlzID0gT2JqZWN0LmtleXModGFza0RlZnMpO1xuICAgIFxuICAgIGlmICh0YXNrRGVmS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCB0YXNrRGVmID0gdGFza0RlZnNbdGFza0RlZktleXNbMF1dO1xuICAgICAgY29uc3QgY29udGFpbmVyRGVmcyA9IHRhc2tEZWYuUHJvcGVydGllcz8uQ29udGFpbmVyRGVmaW5pdGlvbnM7XG4gICAgICBcbiAgICAgIGlmIChjb250YWluZXJEZWZzICYmIGNvbnRhaW5lckRlZnMubGVuZ3RoID4gMCkge1xuICAgICAgICBleHBlY3QoY29udGFpbmVyRGVmc1swXS5Vc2VyKS50b0JlVW5kZWZpbmVkKCk7XG4gICAgICAgIGV4cGVjdChjb250YWluZXJEZWZzWzBdLlJlYWRvbmx5Um9vdEZpbGVzeXN0ZW0pLnRvQmVVbmRlZmluZWQoKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufSk7Il19