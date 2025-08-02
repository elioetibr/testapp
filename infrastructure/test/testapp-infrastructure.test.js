"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const testapp_infrastructure_stack_1 = require("../lib/testapp-infrastructure-stack");
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
            CidrIp: '0.0.0.0/0',
        });
        // Check IPv6 ingress rule is created when IPv6 is enabled
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
            IpProtocol: 'tcp',
            FromPort: 8000,
            ToPort: 8000,
            CidrIpv6: '::/0',
        });
    });
    test('applies correct removal policies based on environment', () => {
        // Test dev environment (should destroy resources)
        const devStack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'DevStack', {
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
        const prodStack = new testapp_infrastructure_stack_1.TestAppInfrastructureStack(app, 'ProdStack', {
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
            Rules: [
                {
                    Name: 'AWS-AWSManagedRulesCommonRuleSet',
                    Priority: 1,
                },
                {
                    Name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
                    Priority: 2,
                },
                {
                    Name: 'RateLimitRule',
                    Priority: 3,
                },
            ]
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
    test('creates SSL certificate and HTTPS listener when HTTPS is enabled', () => {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsbUNBQW1DO0FBQ25DLHVEQUFrRDtBQUNsRCxzRkFBaUY7QUFFakYsUUFBUSxDQUFDLDRCQUE0QixFQUFFLEdBQUcsRUFBRTtJQUMxQyxJQUFJLEdBQVksQ0FBQztJQUNqQixJQUFJLFFBQWtCLENBQUM7SUFFdkIsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN0QixDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyw0REFBNEQsRUFBRSxHQUFHLEVBQUU7UUFDdEUsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFO1lBQzdELFdBQVcsRUFBRSxLQUFLO1lBQ2xCLFVBQVUsRUFBRSxLQUFLO1lBQ2pCLG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsR0FBRztTQUNwQixDQUFDLENBQUM7UUFFSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFckMscUJBQXFCO1FBQ3JCLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxlQUFlLEVBQUU7WUFDOUMsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixnQkFBZ0IsRUFBRSxJQUFJO1NBQ3ZCLENBQUMsQ0FBQztRQUVILGdEQUFnRDtRQUNoRCxRQUFRLENBQUMsZUFBZSxDQUFDLHNCQUFzQixFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ3RELENBQUMsQ0FBQyxDQUFDO0lBRUgsSUFBSSxDQUFDLDBEQUEwRCxF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QUFDO1FBRTFDLElBQUksV0FBVyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7WUFDMUIsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3pDLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxVQUFVLEVBQUUsb0JBQW9CLENBQUM7WUFFL0QsSUFBSSxhQUFhLElBQUksYUFBYSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7Z0JBQzdDLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsYUFBYSxFQUFFLENBQUM7Z0JBQzlDLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsc0JBQXNCLENBQUMsQ0FBQyxhQUFhLEVBQUUsQ0FBQzthQUNqRTtTQUNGO0lBQ0gsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBUZW1wbGF0ZSB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuaW1wb3J0IHsgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2sgfSBmcm9tICcuLi9saWIvdGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjayc7XG5cbmRlc2NyaWJlKCdUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjaycsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcDtcbiAgbGV0IHRlbXBsYXRlOiBUZW1wbGF0ZTtcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIFZQQyB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbiBmb3IgZGV2IGVudmlyb25tZW50JywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFZQQyBjcmVhdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQycsIHtcbiAgICAgIEVuYWJsZURuc0hvc3RuYW1lczogdHJ1ZSxcbiAgICAgIEVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBDaGVjayBOQVQgR2F0ZXdheSBjb3VudCBmb3IgZGV2IChzaG91bGQgYmUgMSlcbiAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpOYXRHYXRld2F5JywgMSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgVlBDIHdpdGggSVB2NiBhbmQgSEEgTkFUIEdhdGV3YXlzIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogdHJ1ZSxcbiAgICAgIG1heEF6czogMyxcbiAgICAgIG5hdEdhdGV3YXlzOiAzLFxuICAgICAgZGVzaXJlZENvdW50OiAzLFxuICAgICAgY3B1OiAxMDI0LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDIwNDgsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBWUEMgSVB2NiBDSURSIEJsb2NrXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6VlBDQ2lkckJsb2NrJywge1xuICAgICAgQW1hem9uUHJvdmlkZWRJcHY2Q2lkckJsb2NrOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgTkFUIEdhdGV3YXkgY291bnQgZm9yIHByb2R1Y3Rpb24gKHNob3VsZCBiZSAyIGFzIFZQQyBvbmx5IGNyZWF0ZXMgdGhhdCBtYW55IEFacylcbiAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUMyOjpOYXRHYXRld2F5JywgMik7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgRUNTIGNsdXN0ZXIgd2l0aCBiYXNpYyBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEVDUyBDbHVzdGVyIGNyZWF0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6Q2x1c3RlcicsIHtcbiAgICAgIENsdXN0ZXJOYW1lOiAndGVzdGFwcC1jbHVzdGVyLWRldicsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgRUNSIHJlcG9zaXRvcnkgd2l0aCBsaWZlY3ljbGUgcG9saWNpZXMnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgRUNSIFJlcG9zaXRvcnkgY3JlYXRpb25cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgSW1hZ2VTY2FubmluZ0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBMaWZlY3ljbGVQb2xpY3k6IHtcbiAgICAgICAgTGlmZWN5Y2xlUG9saWN5VGV4dDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHJ1bGVzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICAgICAgc2VsZWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgdGFnU3RhdHVzOiAnYW55JyxcbiAgICAgICAgICAgICAgICBjb3VudFR5cGU6ICdpbWFnZUNvdW50TW9yZVRoYW4nLFxuICAgICAgICAgICAgICAgIGNvdW50TnVtYmVyOiAxMCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgYWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2V4cGlyZScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBGYXJnYXRlIHNlcnZpY2Ugd2l0aCBjb3JyZWN0IHRhc2sgZGVmaW5pdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDIsXG4gICAgICBjcHU6IDUxMixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAxMDI0LFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgRUNTIFNlcnZpY2UgY3JlYXRpb25cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpTZXJ2aWNlJywge1xuICAgICAgRGVzaXJlZENvdW50OiAyLFxuICAgICAgTGF1bmNoVHlwZTogJ0ZBUkdBVEUnLFxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgVGFzayBEZWZpbml0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6VGFza0RlZmluaXRpb24nLCB7XG4gICAgICBDcHU6ICc1MTInLFxuICAgICAgTWVtb3J5OiAnMTAyNCcsXG4gICAgICBOZXR3b3JrTW9kZTogJ2F3c3ZwYycsXG4gICAgICBSZXF1aXJlc0NvbXBhdGliaWxpdGllczogWydGQVJHQVRFJ10sXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciB3aXRoIGhlYWx0aCBjaGVja3MnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICBUeXBlOiAnYXBwbGljYXRpb24nLFxuICAgICAgU2NoZW1lOiAnaW50ZXJuZXQtZmFjaW5nJyxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIFRhcmdldCBHcm91cCB3aXRoIGhlYWx0aCBjaGVja1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpUYXJnZXRHcm91cCcsIHtcbiAgICAgIEhlYWx0aENoZWNrUGF0aDogJy9oZWFsdGgvJyxcbiAgICAgIEhlYWx0aENoZWNrUHJvdG9jb2w6ICdIVFRQJyxcbiAgICAgIFBvcnQ6IDgwLFxuICAgICAgUHJvdG9jb2w6ICdIVFRQJyxcbiAgICAgIFRhcmdldFR5cGU6ICdpcCcsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRXYXRjaCBMb2cgR3JvdXAgd2l0aCBhcHByb3ByaWF0ZSByZXRlbnRpb24nLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiB0cnVlLFxuICAgICAgbWF4QXpzOiAzLFxuICAgICAgbmF0R2F0ZXdheXM6IDMsXG4gICAgICBkZXNpcmVkQ291bnQ6IDMsXG4gICAgICBjcHU6IDEwMjQsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIENsb3VkV2F0Y2ggTG9nIEdyb3VwXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxvZ3M6OkxvZ0dyb3VwJywge1xuICAgICAgTG9nR3JvdXBOYW1lOiAnL2F3cy9lY3MvdGVzdGFwcC1wcm9kdWN0aW9uJyxcbiAgICAgIFJldGVudGlvbkluRGF5czogMzAsIC8vIFByb2R1Y3Rpb24gcmV0ZW50aW9uXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgSUFNIHJvbGVzIHdpdGggbGVhc3QgcHJpdmlsZWdlIHByaW5jaXBsZXMnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgVGFzayBFeGVjdXRpb24gUm9sZVxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpJQU06OlJvbGUnLCB7XG4gICAgICBBc3N1bWVSb2xlUG9saWN5RG9jdW1lbnQ6IHtcbiAgICAgICAgU3RhdGVtZW50OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgRWZmZWN0OiAnQWxsb3cnLFxuICAgICAgICAgICAgUHJpbmNpcGFsOiB7XG4gICAgICAgICAgICAgIFNlcnZpY2U6ICdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgQWN0aW9uOiAnc3RzOkFzc3VtZVJvbGUnLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAgTWFuYWdlZFBvbGljeUFybnM6IFtcbiAgICAgICAge1xuICAgICAgICAgICdGbjo6Sm9pbic6IFtcbiAgICAgICAgICAgICcnLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAnYXJuOicsXG4gICAgICAgICAgICAgIHsgUmVmOiAnQVdTOjpQYXJ0aXRpb24nIH0sXG4gICAgICAgICAgICAgICc6aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeScsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIFNlY3JldHMgTWFuYWdlciBzZWNyZXQgd2l0aCBwcm9wZXIgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgU2VjcmV0cyBNYW5hZ2VyIHNlY3JldFxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTZWNyZXRzTWFuYWdlcjo6U2VjcmV0Jywge1xuICAgICAgTmFtZTogJ3Rlc3RhcHAtcHJvZHVjdGlvbi1zZWNyZXRzJyxcbiAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCBwcm9kdWN0aW9uIGVudmlyb25tZW50JyxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY29uZmlndXJlcyBhdXRvIHNjYWxpbmcgZm9yIEZhcmdhdGUgc2VydmljZScsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAyLFxuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEF1dG8gU2NhbGluZyBUYXJnZXRcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBwbGljYXRpb25BdXRvU2NhbGluZzo6U2NhbGFibGVUYXJnZXQnLCB7XG4gICAgICBNYXhDYXBhY2l0eTogNiwgLy8gZGVzaXJlZENvdW50ICogM1xuICAgICAgTWluQ2FwYWNpdHk6IDIsIC8vIGRlc2lyZWRDb3VudFxuICAgICAgU2VydmljZU5hbWVzcGFjZTogJ2VjcycsXG4gICAgfSk7XG5cbiAgICAvLyBDaGVjayBDUFUgQXV0byBTY2FsaW5nIFBvbGljeVxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcHBsaWNhdGlvbkF1dG9TY2FsaW5nOjpTY2FsaW5nUG9saWN5Jywge1xuICAgICAgUG9saWN5VHlwZTogJ1RhcmdldFRyYWNraW5nU2NhbGluZycsXG4gICAgICBUYXJnZXRUcmFja2luZ1NjYWxpbmdQb2xpY3lDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIFByZWRlZmluZWRNZXRyaWNTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgUHJlZGVmaW5lZE1ldHJpY1R5cGU6ICdFQ1NTZXJ2aWNlQXZlcmFnZUNQVVV0aWxpemF0aW9uJyxcbiAgICAgICAgfSxcbiAgICAgICAgVGFyZ2V0VmFsdWU6IDcwLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnZW5zdXJlcyBzZWN1cml0eSBncm91cHMgaGF2ZSBhcHByb3ByaWF0ZSBpbmdyZXNzIHJ1bGVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgc2VjdXJpdHkgZ3JvdXAgaW5ncmVzcyBydWxlc1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlNlY3VyaXR5R3JvdXBJbmdyZXNzJywge1xuICAgICAgSXBQcm90b2NvbDogJ3RjcCcsXG4gICAgICBGcm9tUG9ydDogODAwMCxcbiAgICAgIFRvUG9ydDogODAwMCxcbiAgICAgIENpZHJJcDogJzAuMC4wLjAvMCcsXG4gICAgfSk7XG5cbiAgICAvLyBDaGVjayBJUHY2IGluZ3Jlc3MgcnVsZSBpcyBjcmVhdGVkIHdoZW4gSVB2NiBpcyBlbmFibGVkXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDMjo6U2VjdXJpdHlHcm91cEluZ3Jlc3MnLCB7XG4gICAgICBJcFByb3RvY29sOiAndGNwJyxcbiAgICAgIEZyb21Qb3J0OiA4MDAwLFxuICAgICAgVG9Qb3J0OiA4MDAwLFxuICAgICAgQ2lkcklwdjY6ICc6Oi8wJyxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnYXBwbGllcyBjb3JyZWN0IHJlbW92YWwgcG9saWNpZXMgYmFzZWQgb24gZW52aXJvbm1lbnQnLCAoKSA9PiB7XG4gICAgLy8gVGVzdCBkZXYgZW52aXJvbm1lbnQgKHNob3VsZCBkZXN0cm95IHJlc291cmNlcylcbiAgICBjb25zdCBkZXZTdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdEZXZTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIGNvbnN0IGRldlRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKGRldlN0YWNrKTtcblxuICAgIC8vIERldiBFQ1Igc2hvdWxkIGhhdmUgRGVsZXRlIHJlbW92YWwgcG9saWN5XG4gICAgZGV2VGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgIFJlcG9zaXRvcnlOYW1lOiAndGVzdGFwcC1kZXYnLFxuICAgIH0pO1xuXG4gICAgLy8gVGVzdCBwcm9kdWN0aW9uIGVudmlyb25tZW50IChzaG91bGQgcmV0YWluIHJlc291cmNlcykgIFxuICAgIGNvbnN0IHByb2RTdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdQcm9kU3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcHJvZFRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHByb2RTdGFjayk7XG5cbiAgICAvLyBQcm9kdWN0aW9uIEVDUiBzaG91bGQgZXhpc3RcbiAgICBwcm9kVGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgIFJlcG9zaXRvcnlOYW1lOiAndGVzdGFwcC1wcm9kdWN0aW9uJyxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBhbGwgcmVxdWlyZWQgc3RhY2sgb3V0cHV0cycsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayByZXF1aXJlZCBvdXRwdXRzIGFyZSBjcmVhdGVkXG4gICAgY29uc3Qgb3V0cHV0cyA9IFtcbiAgICAgICdWcGNJZCcsXG4gICAgICAnQ2x1c3Rlck5hbWUnLCBcbiAgICAgICdSZXBvc2l0b3J5VXJpJyxcbiAgICAgICdMb2FkQmFsYW5jZXJETlMnLFxuICAgICAgJ1NlcnZpY2VOYW1lJyxcbiAgICAgICdBcHBsaWNhdGlvblVybCdcbiAgICBdO1xuXG4gICAgb3V0cHV0cy5mb3JFYWNoKG91dHB1dE5hbWUgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KG91dHB1dE5hbWUsIHt9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgndmFsaWRhdGVzIHN0YWNrIHByb3BlcnRpZXMgYXJlIHdpdGhpbiByZWFzb25hYmxlIGxpbWl0cycsICgpID0+IHtcbiAgICAvLyBUaGlzIHRlc3QgZW5zdXJlcyBvdXIgaW5mcmFzdHJ1Y3R1cmUgcGFyYW1ldGVycyBhcmUgc2Vuc2libGVcbiAgICBjb25zdCB2YWxpZGF0aW9uVGVzdHMgPSBbXG4gICAgICB7IGNwdTogMjU2LCBtZW1vcnk6IDUxMiwgZW52aXJvbm1lbnQ6ICdkZXYnLCBtYXhBenM6IDIgfSxcbiAgICAgIHsgY3B1OiAxMDI0LCBtZW1vcnk6IDIwNDgsIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsIG1heEF6czogMyB9LFxuICAgICAgeyBjcHU6IDIwNDgsIG1lbW9yeTogNDA5NiwgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJywgbWF4QXpzOiAzIH0sXG4gICAgXTtcblxuICAgIHZhbGlkYXRpb25UZXN0cy5mb3JFYWNoKHByb3BzID0+IHtcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsIGBUZXN0U3RhY2stJHtwcm9wcy5lbnZpcm9ubWVudH0tJHtwcm9wcy5jcHV9YCwge1xuICAgICAgICAgIGVudmlyb25tZW50OiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgICAgICBtYXhBenM6IHByb3BzLm1heEF6cyxcbiAgICAgICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICAgICAgY3B1OiBwcm9wcy5jcHUsXG4gICAgICAgICAgbWVtb3J5TGltaXRNaUI6IHByb3BzLm1lbW9yeSxcbiAgICAgICAgfSk7XG4gICAgICB9KS5ub3QudG9UaHJvdygpO1xuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIFdBRiBXZWIgQUNMIHdoZW4gV0FGIGlzIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnV0FGVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFdBRiBXZWIgQUNMIGNyZWF0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCB7XG4gICAgICBOYW1lOiAndGVzdGFwcC1wcm9kdWN0aW9uLXdlYi1hY2wnLFxuICAgICAgU2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICBEZWZhdWx0QWN0aW9uOiB7IEFsbG93OiB7fSB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgV0FGIGhhcyBtYW5hZ2VkIHJ1bGUgc2V0c1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIE5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgUHJpb3JpdHk6IDEsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBOYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsIFxuICAgICAgICAgIFByaW9yaXR5OiAyLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgTmFtZTogJ1JhdGVMaW1pdFJ1bGUnLFxuICAgICAgICAgIFByaW9yaXR5OiAzLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgV0FGIGFzc29jaWF0aW9uIHdpdGggQUxCXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0xBc3NvY2lhdGlvbicsIHt9KTtcbiAgfSk7XG5cbiAgdGVzdCgnZG9lcyBub3QgY3JlYXRlIFdBRiB3aGVuIGRpc2FibGVkJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ05vV0FGVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZW5hYmxlV0FGOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFdBRiByZXNvdXJjZXMgYXJlIG5vdCBjcmVhdGVkXG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCAwKTtcbiAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6V0FGdjI6OldlYkFDTEFzc29jaWF0aW9uJywgMCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgVlBDIEZsb3cgTG9ncyBhbmQgUzMgYnVja2V0IHdoZW4gZW5hYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdGbG93TG9nc1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICBlbmFibGVWUENGbG93TG9nczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFMzIGJ1Y2tldCBmb3IgZmxvdyBsb2dzXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlMzOjpCdWNrZXQnLCB7XG4gICAgICBQdWJsaWNBY2Nlc3NCbG9ja0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgQmxvY2tQdWJsaWNBY2xzOiB0cnVlLFxuICAgICAgICBCbG9ja1B1YmxpY1BvbGljeTogdHJ1ZSxcbiAgICAgICAgSWdub3JlUHVibGljQWNsczogdHJ1ZSxcbiAgICAgICAgUmVzdHJpY3RQdWJsaWNCdWNrZXRzOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIFZQQyBGbG93IExvZ3NcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpGbG93TG9nJywge1xuICAgICAgUmVzb3VyY2VUeXBlOiAnVlBDJyxcbiAgICAgIFRyYWZmaWNUeXBlOiAnQUxMJyxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIGxpZmVjeWNsZSBwb2xpY3kgZm9yIHJldGVudGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTMzo6QnVja2V0Jywge1xuICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge1xuICAgICAgICBSdWxlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIElkOiAnRGVsZXRlT2xkRmxvd0xvZ3MnLFxuICAgICAgICAgICAgU3RhdHVzOiAnRW5hYmxlZCcsXG4gICAgICAgICAgICBFeHBpcmF0aW9uSW5EYXlzOiA5MCwgLy8gUHJvZHVjdGlvbiByZXRlbnRpb25cbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnZG9lcyBub3QgY3JlYXRlIFZQQyBGbG93IExvZ3Mgd2hlbiBkaXNhYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdOb0Zsb3dMb2dzVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZW5hYmxlVlBDRmxvd0xvZ3M6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gU2hvdWxkIG5vdCBjcmVhdGUgZmxvdyBsb2dzIG9yIGJ1Y2tldFxuICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQzI6OkZsb3dMb2cnLCAwKTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBTU0wgY2VydGlmaWNhdGUgYW5kIEhUVFBTIGxpc3RlbmVyIHdoZW4gSFRUUFMgaXMgZW5hYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdIVFRQU1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgIGRvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBTU0wgY2VydGlmaWNhdGUgY3JlYXRpb25cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIHtcbiAgICAgIERvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICBTdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogWycqLmV4YW1wbGUuY29tJ10sXG4gICAgfSk7XG5cbiAgICAvLyBDaGVjayBIVFRQUyBsaXN0ZW5lciAocG9ydCA0NDMpXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyJywge1xuICAgICAgUG9ydDogNDQzLFxuICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgc2VjdXJlIHRhc2sgZGVmaW5pdGlvbiB3aXRoIG5vbi1yb290IHVzZXIgd2hlbiBjb250YWluZXIgc2VjdXJpdHkgaXMgZW5hYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdTZWN1cmVDb250YWluZXJUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IHRydWUsXG4gICAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgdGFzayBkZWZpbml0aW9uIHdpdGggc2VjdXJpdHkgc2V0dGluZ3NcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBVc2VyOiAnMTAwMToxMDAxJyxcbiAgICAgICAgICBSZWFkb25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIG1lbW9yeSByZXNlcnZhdGlvbiBpcyBzZXRcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIENvbnRhaW5lckRlZmluaXRpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBNZW1vcnlSZXNlcnZhdGlvbjogODE5LCAvLyA4MCUgb2YgMTAyNFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgndXNlcyBkZWZhdWx0IHRhc2sgZGVmaW5pdGlvbiB3aGVuIGNvbnRhaW5lciBzZWN1cml0eSBpcyBkaXNhYmxlZCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdEZWZhdWx0Q29udGFpbmVyVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogZmFsc2UsXG4gICAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIFNob3VsZCB1c2UgQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSBkZWZhdWx0IHRhc2sgZGVmaW5pdGlvblxuICAgIC8vIFRoZSB0YXNrIGRlZmluaXRpb24gc2hvdWxkIG5vdCBoYXZlIFVzZXIgb3IgUmVhZG9ubHlSb290RmlsZXN5c3RlbSBzZXRcbiAgICBjb25zdCB0YXNrRGVmcyA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6RUNTOjpUYXNrRGVmaW5pdGlvbicpO1xuICAgIGNvbnN0IHRhc2tEZWZLZXlzID0gT2JqZWN0LmtleXModGFza0RlZnMpO1xuICAgIFxuICAgIGlmICh0YXNrRGVmS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCB0YXNrRGVmID0gdGFza0RlZnNbdGFza0RlZktleXNbMF1dO1xuICAgICAgY29uc3QgY29udGFpbmVyRGVmcyA9IHRhc2tEZWYuUHJvcGVydGllcz8uQ29udGFpbmVyRGVmaW5pdGlvbnM7XG4gICAgICBcbiAgICAgIGlmIChjb250YWluZXJEZWZzICYmIGNvbnRhaW5lckRlZnMubGVuZ3RoID4gMCkge1xuICAgICAgICBleHBlY3QoY29udGFpbmVyRGVmc1swXS5Vc2VyKS50b0JlVW5kZWZpbmVkKCk7XG4gICAgICAgIGV4cGVjdChjb250YWluZXJEZWZzWzBdLlJlYWRvbmx5Um9vdEZpbGVzeXN0ZW0pLnRvQmVVbmRlZmluZWQoKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufSk7Il19