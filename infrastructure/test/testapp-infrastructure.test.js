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
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsbUNBQW1DO0FBQ25DLHVEQUFrRDtBQUNsRCxzRkFBaUY7QUFFakYsUUFBUSxDQUFDLDRCQUE0QixFQUFFLEdBQUcsRUFBRTtJQUMxQyxJQUFJLEdBQVksQ0FBQztJQUNqQixJQUFJLFFBQWtCLENBQUM7SUFFdkIsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUN0QixDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyw0REFBNEQsRUFBRSxHQUFHLEVBQUU7UUFDdEUsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFO1lBQzdELFdBQVcsRUFBRSxLQUFLO1lBQ2xCLFVBQVUsRUFBRSxLQUFLO1lBQ2pCLG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsR0FBRztTQUNwQixDQUFDLENBQUM7UUFFSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFckMscUJBQXFCO1FBQ3JCLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxlQUFlLEVBQUU7WUFDOUMsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixnQkFBZ0IsRUFBRSxJQUFJO1NBQ3ZCLENBQUMsQ0FBQztRQUVILGdEQUFnRDtRQUNoRCxRQUFRLENBQUMsZUFBZSxDQUFDLHNCQUFzQixFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ3RELENBQUMsQ0FBQyxDQUFDO0lBRUgsSUFBSSxDQUFDLDBEQUEwRCxFQUFFLEdBQUcsRUFBRTtRQUNwRSxNQUFNLEtBQUssR0FBRyxJQUFJLHlEQUEwQixDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUU7WUFDN0QsV0FBVyxFQUFFLFlBQVk7WUFDekIsVUFBVSxFQUFFLElBQUk7WUFDaEIsbUJBQW1CLEVBQUUsSUFBSTtZQUN6QixNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsWUFBWSxFQUFFLENBQUM7WUFDZixHQUFHLEVBQUUsSUFBSTtZQUNULGNBQWMsRUFBRSxJQUFJO1NBQ3JCLENBQUMsQ0FBQztRQUVILFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVyQyw0QkFBNEI7UUFDNUIsUUFBUSxDQUFDLHFCQUFxQixDQUFDLHdCQUF3QixFQUFFO1lBQ3ZELDJCQUEyQixFQUFFLElBQUk7U0FDbEMsQ0FBQyxDQUFDO1FBRUgseUZBQXlGO1FBQ3pGLFFBQVEsQ0FBQyxlQUFlLENBQUMsc0JBQXNCLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDdEQsQ0FBQyxDQUFDLENBQUM7SUFFSCxJQUFJLENBQUMsOENBQThDLEVBQUUsR0FBRyxFQUFFO1FBQ3hELE1BQU0sS0FBSyxHQUFHLElBQUkseURBQTBCLENBQUMsR0FBRyxFQUFFLFdBQVcsRUFBRTtZQUM3RCxXQUFXLEVBQUUsS0FBSztZQUNsQixVQUFVLEVBQUUsS0FBSztZQUNqQixtQkFBbUIsRUFBRSxLQUFLO1lBQzFCLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxZQUFZLEVBQUUsQ0FBQztZQUNmLEdBQUcsRUFBRSxHQUFHO1lBQ1IsY0FBYyxFQUFFLEdBQUc7U0FDcEIsQ0FBQyxDQUFDO1FBRUgsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXJDLDZCQUE2QjtRQUM3QixRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7WUFDbEQsV0FBVyxFQUFFLHFCQUFxQjtTQUNuQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyxnREFBZ0QsRUFBRSxHQUFHLEVBQUU7UUFDMUQsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFO1lBQzdELFdBQVcsRUFBRSxLQUFLO1lBQ2xCLFVBQVUsRUFBRSxLQUFLO1lBQ2pCLG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsR0FBRztTQUNwQixDQUFDLENBQUM7UUFFSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFckMsZ0NBQWdDO1FBQ2hDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxzQkFBc0IsRUFBRTtZQUNyRCwwQkFBMEIsRUFBRTtnQkFDMUIsVUFBVSxFQUFFLElBQUk7YUFDakI7WUFDRCxlQUFlLEVBQUU7Z0JBQ2YsbUJBQW1CLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztvQkFDbEMsS0FBSyxFQUFFO3dCQUNMOzRCQUNFLFlBQVksRUFBRSxDQUFDOzRCQUNmLFdBQVcsRUFBRSxxQkFBcUI7NEJBQ2xDLFNBQVMsRUFBRTtnQ0FDVCxTQUFTLEVBQUUsS0FBSztnQ0FDaEIsU0FBUyxFQUFFLG9CQUFvQjtnQ0FDL0IsV0FBVyxFQUFFLEVBQUU7NkJBQ2hCOzRCQUNELE1BQU0sRUFBRTtnQ0FDTixJQUFJLEVBQUUsUUFBUTs2QkFDZjt5QkFDRjtxQkFDRjtpQkFDRixDQUFDO2FBQ0g7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyxzREFBc0QsRUFBRSxHQUFHLEVBQUU7UUFDaEUsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFO1lBQzdELFdBQVcsRUFBRSxZQUFZO1lBQ3pCLFVBQVUsRUFBRSxJQUFJO1lBQ2hCLG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsSUFBSTtTQUNyQixDQUFDLENBQUM7UUFFSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFckMsNkJBQTZCO1FBQzdCLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRTtZQUNsRCxZQUFZLEVBQUUsQ0FBQztZQUNmLFVBQVUsRUFBRSxTQUFTO1NBQ3RCLENBQUMsQ0FBQztRQUVILHdCQUF3QjtRQUN4QixRQUFRLENBQUMscUJBQXFCLENBQUMsMEJBQTBCLEVBQUU7WUFDekQsR0FBRyxFQUFFLEtBQUs7WUFDVixNQUFNLEVBQUUsTUFBTTtZQUNkLFdBQVcsRUFBRSxRQUFRO1lBQ3JCLHVCQUF1QixFQUFFLENBQUMsU0FBUyxDQUFDO1NBQ3JDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0lBRUgsSUFBSSxDQUFDLHNEQUFzRCxFQUFFLEdBQUcsRUFBRTtRQUNoRSxNQUFNLEtBQUssR0FBRyxJQUFJLHlEQUEwQixDQUFDLEdBQUcsRUFBRSxXQUFXLEVBQUU7WUFDN0QsV0FBVyxFQUFFLEtBQUs7WUFDbEIsVUFBVSxFQUFFLEtBQUs7WUFDakIsbUJBQW1CLEVBQUUsS0FBSztZQUMxQixNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsWUFBWSxFQUFFLENBQUM7WUFDZixHQUFHLEVBQUUsR0FBRztZQUNSLGNBQWMsRUFBRSxHQUFHO1NBQ3BCLENBQUMsQ0FBQztRQUVILFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVyQyxrQ0FBa0M7UUFDbEMsUUFBUSxDQUFDLHFCQUFxQixDQUFDLDJDQUEyQyxFQUFFO1lBQzFFLElBQUksRUFBRSxhQUFhO1lBQ25CLE1BQU0sRUFBRSxpQkFBaUI7U0FDMUIsQ0FBQyxDQUFDO1FBRUgsdUNBQXVDO1FBQ3ZDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywwQ0FBMEMsRUFBRTtZQUN6RSxlQUFlLEVBQUUsVUFBVTtZQUMzQixtQkFBbUIsRUFBRSxNQUFNO1lBQzNCLElBQUksRUFBRSxFQUFFO1lBQ1IsUUFBUSxFQUFFLE1BQU07WUFDaEIsVUFBVSxFQUFFLElBQUk7U0FDakIsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7SUFFSCxJQUFJLENBQUMseURBQXlELEVBQUUsR0FBRyxFQUFFO1FBQ25FLE1BQU0sS0FBSyxHQUFHLElBQUkseURBQTBCLENBQUMsR0FBRyxFQUFFLFdBQVcsRUFBRTtZQUM3RCxXQUFXLEVBQUUsWUFBWTtZQUN6QixVQUFVLEVBQUUsSUFBSTtZQUNoQixtQkFBbUIsRUFBRSxJQUFJO1lBQ3pCLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxZQUFZLEVBQUUsQ0FBQztZQUNmLEdBQUcsRUFBRSxJQUFJO1lBQ1QsY0FBYyxFQUFFLElBQUk7U0FDckIsQ0FBQyxDQUFDO1FBRUgsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXJDLDZCQUE2QjtRQUM3QixRQUFRLENBQUMscUJBQXFCLENBQUMscUJBQXFCLEVBQUU7WUFDcEQsWUFBWSxFQUFFLDZCQUE2QjtZQUMzQyxlQUFlLEVBQUUsRUFBRSxFQUFFLHVCQUF1QjtTQUM3QyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyxtREFBbUQsRUFBRSxHQUFHLEVBQUU7UUFDN0QsTUFBTSxLQUFLLEdBQUcsSUFBSSx5REFBMEIsQ0FBQyxHQUFHLEVBQUUsV0FBVyxFQUFFO1lBQzdELFdBQVcsRUFBRSxLQUFLO1lBQ2xCLFVBQVUsRUFBRSxLQUFLO1lBQ2pCLG1CQUFtQixFQUFFLEtBQUs7WUFDMUIsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQztZQUNkLFlBQVksRUFBRSxDQUFDO1lBQ2YsR0FBRyxFQUFFLEdBQUc7WUFDUixjQUFjLEVBQUUsR0FBRztTQUNwQixDQUFDLENBQUM7UUFFSCxRQUFRLEdBQUcscUJBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFckMsNEJBQTRCO1FBQzVCLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsRUFBRTtZQUMvQyx3QkFBd0IsRUFBRTtnQkFDeEIsU0FBUyxFQUFFO29CQUNUO3dCQUNFLE1BQU0sRUFBRSxPQUFPO3dCQUNmLFNBQVMsRUFBRTs0QkFDVCxPQUFPLEVBQUUseUJBQXlCO3lCQUNuQzt3QkFDRCxNQUFNLEVBQUUsZ0JBQWdCO3FCQUN6QjtpQkFDRjthQUNGO1lBQ0QsaUJBQWlCLEVBQUU7Z0JBQ2pCO29CQUNFLFVBQVUsRUFBRTt3QkFDVixFQUFFO3dCQUNGOzRCQUNFLE1BQU07NEJBQ04sRUFBRSxHQUFHLEVBQUUsZ0JBQWdCLEVBQUU7NEJBQ3pCLGdFQUFnRTt5QkFDakU7cUJBQ0Y7aUJBQ0Y7YUFDRjtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUgfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrIH0gZnJvbSAnLi4vbGliL3Rlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2snO1xuXG5kZXNjcmliZSgnVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2snLCAoKSA9PiB7XG4gIGxldCBhcHA6IGNkay5BcHA7XG4gIGxldCB0ZW1wbGF0ZTogVGVtcGxhdGU7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgfSk7XG5cbiAgdGVzdCgnY3JlYXRlcyBWUEMgd2l0aCBjb3JyZWN0IGNvbmZpZ3VyYXRpb24gZm9yIGRldiBlbnZpcm9ubWVudCcsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBWUEMgY3JlYXRpb25cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUMyOjpWUEMnLCB7XG4gICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICBFbmFibGVEbnNTdXBwb3J0OiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgTkFUIEdhdGV3YXkgY291bnQgZm9yIGRldiAoc2hvdWxkIGJlIDEpXG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDEpO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIFZQQyB3aXRoIElQdjYgYW5kIEhBIE5BVCBHYXRld2F5cyBmb3IgcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IHRydWUsXG4gICAgICBtYXhBenM6IDMsXG4gICAgICBuYXRHYXRld2F5czogMyxcbiAgICAgIGRlc2lyZWRDb3VudDogMyxcbiAgICAgIGNwdTogMTAyNCxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxuICAgIH0pO1xuXG4gICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgLy8gQ2hlY2sgVlBDIElQdjYgQ0lEUiBCbG9ja1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQzI6OlZQQ0NpZHJCbG9jaycsIHtcbiAgICAgIEFtYXpvblByb3ZpZGVkSXB2NkNpZHJCbG9jazogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIE5BVCBHYXRld2F5IGNvdW50IGZvciBwcm9kdWN0aW9uIChzaG91bGQgYmUgMiBhcyBWUEMgb25seSBjcmVhdGVzIHRoYXQgbWFueSBBWnMpXG4gICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDMjo6TmF0R2F0ZXdheScsIDIpO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIEVDUyBjbHVzdGVyIHdpdGggYmFzaWMgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBjb25zdCBzdGFjayA9IG5ldyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayhhcHAsICdUZXN0U3RhY2snLCB7XG4gICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGZhbHNlLFxuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICBjcHU6IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBFQ1MgQ2x1c3RlciBjcmVhdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICBDbHVzdGVyTmFtZTogJ3Rlc3RhcHAtY2x1c3Rlci1kZXYnLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIEVDUiByZXBvc2l0b3J5IHdpdGggbGlmZWN5Y2xlIHBvbGljaWVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEVDUiBSZXBvc2l0b3J5IGNyZWF0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgIEltYWdlU2Nhbm5pbmdDb25maWd1cmF0aW9uOiB7XG4gICAgICAgIFNjYW5PblB1c2g6IHRydWUsXG4gICAgICB9LFxuICAgICAgTGlmZWN5Y2xlUG9saWN5OiB7XG4gICAgICAgIExpZmVjeWNsZVBvbGljeVRleHQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBydWxlczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBydWxlUHJpb3JpdHk6IDEsXG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsXG4gICAgICAgICAgICAgIHNlbGVjdGlvbjoge1xuICAgICAgICAgICAgICAgIHRhZ1N0YXR1czogJ2FueScsXG4gICAgICAgICAgICAgICAgY291bnRUeXBlOiAnaW1hZ2VDb3VudE1vcmVUaGFuJyxcbiAgICAgICAgICAgICAgICBjb3VudE51bWJlcjogMTAsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGFjdGlvbjoge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdleHBpcmUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NyZWF0ZXMgRmFyZ2F0ZSBzZXJ2aWNlIHdpdGggY29ycmVjdCB0YXNrIGRlZmluaXRpb24nLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhY2sgPSBuZXcgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2soYXBwLCAnVGVzdFN0YWNrJywge1xuICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIGVuYWJsZUlQdjY6IHRydWUsXG4gICAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgZGVzaXJlZENvdW50OiAyLFxuICAgICAgY3B1OiA1MTIsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogMTAyNCxcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEVDUyBTZXJ2aWNlIGNyZWF0aW9uXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6U2VydmljZScsIHtcbiAgICAgIERlc2lyZWRDb3VudDogMixcbiAgICAgIExhdW5jaFR5cGU6ICdGQVJHQVRFJyxcbiAgICB9KTtcblxuICAgIC8vIENoZWNrIFRhc2sgRGVmaW5pdGlvblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OlRhc2tEZWZpbml0aW9uJywge1xuICAgICAgQ3B1OiAnNTEyJyxcbiAgICAgIE1lbW9yeTogJzEwMjQnLFxuICAgICAgTmV0d29ya01vZGU6ICdhd3N2cGMnLFxuICAgICAgUmVxdWlyZXNDb21wYXRpYmlsaXRpZXM6IFsnRkFSR0FURSddLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgd2l0aCBoZWFsdGggY2hlY2tzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TG9hZEJhbGFuY2VyJywge1xuICAgICAgVHlwZTogJ2FwcGxpY2F0aW9uJyxcbiAgICAgIFNjaGVtZTogJ2ludGVybmV0LWZhY2luZycsXG4gICAgfSk7XG5cbiAgICAvLyBDaGVjayBUYXJnZXQgR3JvdXAgd2l0aCBoZWFsdGggY2hlY2tcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6VGFyZ2V0R3JvdXAnLCB7XG4gICAgICBIZWFsdGhDaGVja1BhdGg6ICcvaGVhbHRoLycsXG4gICAgICBIZWFsdGhDaGVja1Byb3RvY29sOiAnSFRUUCcsXG4gICAgICBQb3J0OiA4MCxcbiAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICBUYXJnZXRUeXBlOiAnaXAnLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIENsb3VkV2F0Y2ggTG9nIEdyb3VwIHdpdGggYXBwcm9wcmlhdGUgcmV0ZW50aW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogdHJ1ZSxcbiAgICAgIG1heEF6czogMyxcbiAgICAgIG5hdEdhdGV3YXlzOiAzLFxuICAgICAgZGVzaXJlZENvdW50OiAzLFxuICAgICAgY3B1OiAxMDI0LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDIwNDgsXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAvLyBDaGVjayBDbG91ZFdhdGNoIExvZyBHcm91cFxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpMb2dzOjpMb2dHcm91cCcsIHtcbiAgICAgIExvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3RhcHAtcHJvZHVjdGlvbicsXG4gICAgICBSZXRlbnRpb25JbkRheXM6IDMwLCAvLyBQcm9kdWN0aW9uIHJldGVudGlvblxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KCdjcmVhdGVzIElBTSByb2xlcyB3aXRoIGxlYXN0IHByaXZpbGVnZSBwcmluY2lwbGVzJywgKCkgPT4ge1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrKGFwcCwgJ1Rlc3RTdGFjaycsIHtcbiAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIGVuYWJsZUlQdjY6IGZhbHNlLFxuICAgICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgICBtYXhBenM6IDIsXG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIGNwdTogMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICB9KTtcblxuICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgIC8vIENoZWNrIFRhc2sgRXhlY3V0aW9uIFJvbGVcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6SUFNOjpSb2xlJywge1xuICAgICAgQXNzdW1lUm9sZVBvbGljeURvY3VtZW50OiB7XG4gICAgICAgIFN0YXRlbWVudDogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEVmZmVjdDogJ0FsbG93JyxcbiAgICAgICAgICAgIFByaW5jaXBhbDoge1xuICAgICAgICAgICAgICBTZXJ2aWNlOiAnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIEFjdGlvbjogJ3N0czpBc3N1bWVSb2xlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIE1hbmFnZWRQb2xpY3lBcm5zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAnRm46OkpvaW4nOiBbXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgJ2FybjonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UGFydGl0aW9uJyB9LFxuICAgICAgICAgICAgICAnOmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgfSk7XG59KTsiXX0=