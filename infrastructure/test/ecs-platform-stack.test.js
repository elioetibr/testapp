"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const assertions_1 = require("aws-cdk-lib/assertions");
const ecs_platform_stack_1 = require("../lib/ecs-platform-stack");
describe('EcsPlatformStack', () => {
    let app;
    let template;
    const defaultProps = {
        environment: 'test',
        vpcId: 'vpc-12345678',
        publicSubnetIds: ['subnet-11111111', 'subnet-22222222', 'subnet-33333333'],
        loadBalancerSecurityGroupId: 'sg-12345678',
        baseDomain: 'example.com',
        appName: 'testapp',
        hostedZoneId: 'Z123456789',
        stackName: 'TestEcsPlatformStack',
        env: {
            account: '123456789012',
            region: 'us-east-1',
        },
    };
    describe('Basic ECS Platform Configuration', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates ECS cluster with correct configuration', () => {
            template.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterName: 'testapp-cluster-test',
            });
        });
        test('creates ECR repository with correct configuration', () => {
            template.hasResourceProperties('AWS::ECR::Repository', {
                RepositoryName: 'testapp-test',
                ImageScanningConfiguration: {
                    ScanOnPush: true,
                },
                ImageTagMutability: 'MUTABLE',
                LifecyclePolicy: {
                    LifecyclePolicyText: JSON.stringify({
                        rules: [
                            {
                                rulePriority: 1,
                                description: 'Delete untagged images after 1 day',
                                selection: {
                                    tagStatus: 'untagged',
                                    countType: 'sinceImagePushed',
                                    countNumber: 1,
                                    countUnit: 'days',
                                },
                                action: {
                                    type: 'expire',
                                },
                            },
                            {
                                rulePriority: 2,
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
        test('creates Application Load Balancer', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Name: 'testapp-alb-test',
                Scheme: 'internet-facing',
                Type: 'application',
            });
        });
        test('creates HTTP listener with default action', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 80,
                Protocol: 'HTTP',
                DefaultActions: [
                    {
                        Type: 'fixed-response',
                        FixedResponseConfig: {
                            StatusCode: '503',
                            ContentType: 'text/plain',
                            MessageBody: 'Service temporarily unavailable',
                        },
                    },
                ],
            });
        });
        test('creates CloudWatch log group', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: '/aws/ecs/testapp-test',
                RetentionInDays: 7, // One week for test environment
            });
        });
    });
    describe('Custom Configuration', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
                clusterName: 'custom-cluster',
                repositoryName: 'custom-repo',
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates cluster with custom name', () => {
            template.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterName: 'custom-cluster',
            });
        });
        test('creates repository with custom name', () => {
            template.hasResourceProperties('AWS::ECR::Repository', {
                RepositoryName: 'custom-repo',
            });
        });
        test('uses production log retention', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                RetentionInDays: 30, // One month for production
            });
        });
    });
    describe('Production Environment Features', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates CloudMap namespace for production', () => {
            template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
                Name: 'testapp-production',
            });
        });
        test('enables deletion protection for ALB in production', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                LoadBalancerAttributes: assertions_1.Match.arrayWith([
                    {
                        Key: 'deletion_protection.enabled',
                        Value: 'true',
                    },
                ]),
            });
        });
        test('has retain removal policy for ECR in production', () => {
            template.hasResource('AWS::ECR::Repository', {
                DeletionPolicy: 'Retain',
            });
        });
    });
    describe('HTTPS and Certificate Configuration', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates SSL certificate', () => {
            template.hasResourceProperties('AWS::CertificateManager::Certificate', {
                DomainName: 'example.com',
                SubjectAlternativeNames: ['*.example.com'],
                ValidationMethod: 'DNS',
            });
        });
        test('creates HTTPS listener', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 443,
                Protocol: 'HTTPS',
                Certificates: [
                    {
                        CertificateArn: { Ref: assertions_1.Match.anyValue() },
                    },
                ],
            });
        });
        test('creates HTTP to HTTPS redirect', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                DefaultActions: assertions_1.Match.arrayWith([
                    {
                        Type: 'redirect',
                        RedirectConfig: {
                            Protocol: 'HTTPS',
                            Port: '443',
                            StatusCode: 'HTTP_301',
                        },
                    },
                ]),
            });
        });
    });
    // Route53 DNS Configuration tests removed - DNS records are now handled by ApplicationStack
    describe('WAF Configuration', () => {
        beforeEach(() => {
            app = new cdk.App;
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                enableWAF: true,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates WAF Web ACL with core rule sets', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Name: 'testapp-test-web-acl',
                Description: 'WAF for TestApp test environment',
                Scope: 'REGIONAL',
                DefaultAction: { Allow: {} },
                Rules: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        Name: 'AWS-AWSManagedRulesCommonRuleSet',
                        Priority: 1,
                        OverrideAction: { None: {} },
                        Statement: {
                            ManagedRuleGroupStatement: {
                                VendorName: 'AWS',
                                Name: 'AWSManagedRulesCommonRuleSet',
                            },
                        },
                    }),
                    assertions_1.Match.objectLike({
                        Name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
                        Priority: 2,
                        OverrideAction: { None: {} },
                        Statement: {
                            ManagedRuleGroupStatement: {
                                VendorName: 'AWS',
                                Name: 'AWSManagedRulesKnownBadInputsRuleSet',
                            },
                        },
                    }),
                    assertions_1.Match.objectLike({
                        Name: 'AWS-AWSManagedRulesSQLiRuleSet',
                        Priority: 3,
                        OverrideAction: { None: {} },
                        Statement: {
                            ManagedRuleGroupStatement: {
                                VendorName: 'AWS',
                                Name: 'AWSManagedRulesSQLiRuleSet',
                            },
                        },
                    }),
                ]),
            });
        });
        test('creates rate limiting rule', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        Name: 'RateLimitRule',
                        Priority: 10,
                        Action: { Block: {} },
                        Statement: {
                            RateBasedStatement: {
                                Limit: 1000,
                                AggregateKeyType: 'IP',
                            },
                        },
                    }),
                ]),
            });
        });
        test('creates IP set for allow list', () => {
            template.hasResourceProperties('AWS::WAFv2::IPSet', {
                Name: 'testapp-test-allow-list',
                Description: 'Allowed IP addresses for higher rate limits',
                IPAddressVersion: 'IPV4',
                Addresses: [],
                Scope: 'REGIONAL',
            });
        });
        test('associates WAF with ALB', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
                ResourceArn: { Ref: assertions_1.Match.anyValue() },
                WebACLArn: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'Arn'] },
            });
        });
    });
    describe('WAF Production Configuration', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
                enableWAF: true,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('uses production rate limits', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        Name: 'RateLimitRule',
                        Priority: 10,
                        Action: { Block: {} },
                        Statement: {
                            RateBasedStatement: {
                                Limit: 2000,
                                AggregateKeyType: 'IP',
                            },
                        },
                    }),
                ]),
            });
        });
        test('includes geographic restriction for production', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: assertions_1.Match.arrayWith([
                    assertions_1.Match.objectLike({
                        Name: 'GeoRestrictionRule',
                        Priority: 15,
                        Action: { Block: {} },
                        Statement: {
                            GeoMatchStatement: {
                                CountryCodes: ['CN', 'RU', 'KP', 'IR'],
                            },
                        },
                    }),
                ]),
            });
        });
    });
    describe('Stack Outputs', () => {
        let stack;
        beforeEach(() => {
            app = new cdk.App();
            stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                baseDomain: 'example.com',
                appName: 'testapp',
                hostedZoneId: 'Z123456789',
                enableWAF: true,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates ECS cluster outputs', () => {
            template.hasOutput('ClusterArn', {
                Description: 'ECS Cluster ARN',
                Export: { Name: 'TestEcsPlatformStack-ClusterArn' },
            });
            template.hasOutput('ClusterName', {
                Description: 'ECS Cluster Name',
                Export: { Name: 'TestEcsPlatformStack-ClusterName' },
            });
        });
        test('creates ECR repository outputs', () => {
            template.hasOutput('RepositoryUri', {
                Description: 'ECR Repository URI',
                Export: { Name: 'TestEcsPlatformStack-RepositoryUri' },
            });
            template.hasOutput('RepositoryArn', {
                Description: 'ECR Repository ARN',
                Export: { Name: 'TestEcsPlatformStack-RepositoryArn' },
            });
        });
        test('creates Load Balancer outputs', () => {
            template.hasOutput('LoadBalancerArn', {
                Description: 'Application Load Balancer ARN',
                Export: { Name: 'TestEcsPlatformStack-LoadBalancerArn' },
            });
            template.hasOutput('LoadBalancerDNS', {
                Description: 'Application Load Balancer DNS Name',
                Export: { Name: 'TestEcsPlatformStack-LoadBalancerDNS' },
            });
            template.hasOutput('LoadBalancerZoneId', {
                Description: 'Application Load Balancer Hosted Zone ID',
                Export: { Name: 'TestEcsPlatformStack-LoadBalancerZoneId' },
            });
        });
        test('creates listener outputs', () => {
            template.hasOutput('HttpListenerArn', {
                Description: 'HTTP Listener ARN',
                Export: { Name: 'TestEcsPlatformStack-HttpListenerArn' },
            });
            template.hasOutput('HttpsListenerArn', {
                Description: 'HTTPS Listener ARN',
                Export: { Name: 'TestEcsPlatformStack-HttpsListenerArn' },
            });
        });
        test('creates log group outputs', () => {
            template.hasOutput('LogGroupName', {
                Description: 'CloudWatch Log Group Name',
                Export: { Name: 'TestEcsPlatformStack-LogGroupName' },
            });
            template.hasOutput('LogGroupArn', {
                Description: 'CloudWatch Log Group ARN',
                Export: { Name: 'TestEcsPlatformStack-LogGroupArn' },
            });
        });
        test('creates certificate outputs when HTTPS enabled', () => {
            template.hasOutput('CertificateArn', {
                Description: 'SSL Certificate ARN',
                Export: { Name: 'TestEcsPlatformStack-CertificateArn' },
            });
        });
        test('creates WAF outputs when WAF enabled', () => {
            template.hasOutput('WAFWebACLArn', {
                Description: 'WAF Web ACL ARN',
                Export: { Name: 'TestEcsPlatformStack-WAFWebACLArn' },
            });
            template.hasOutput('WAFWebACLId', {
                Description: 'WAF Web ACL ID',
                Export: { Name: 'TestEcsPlatformStack-WAFWebACLId' },
            });
        });
        // Application URL test removed - Application URLs are now handled by ApplicationStack
    });
    // Application URL tests removed - Application URLs are now handled by ApplicationStack
    describe('Resource Tagging', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
                baseDomain: 'example.com',
                appName: 'testapp',
                hostedZoneId: 'Z123456789',
                enableWAF: true,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('ECS cluster has correct tags', () => {
            template.hasResourceProperties('AWS::ECS::Cluster', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                ]),
            });
        });
        test('ECR repository has correct tags', () => {
            template.hasResourceProperties('AWS::ECR::Repository', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                ]),
            });
        });
        test('Load Balancer has correct tags', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                ]),
            });
        });
        test('Certificate has correct tags', () => {
            template.hasResourceProperties('AWS::CertificateManager::Certificate', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                ]),
            });
        });
        test('WAF has correct tags', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Tags: assertions_1.Match.arrayWith([
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                    { Key: 'Purpose', Value: 'DDoS-Protection' },
                ]),
            });
        });
    });
    describe('Error Handling and Edge Cases', () => {
        test('handles missing domain configuration gracefully', () => {
            expect(() => {
                const app = new cdk.App();
                new ecs_platform_stack_1.EcsPlatformStack(app, 'TestHttpsValidation', {
                    environment: 'test',
                    vpcId: 'vpc-12345678',
                    publicSubnetIds: ['subnet-11111111'],
                    loadBalancerSecurityGroupId: 'sg-12345678',
                    stackName: 'TestHttpsValidation',
                    env: {
                        account: '123456789012',
                        region: 'us-east-1',
                    },
                    // baseDomain and appName intentionally omitted - should work without HTTPS
                });
            }).not.toThrow();
        });
        test('throws error when baseDomain provided but appName missing', () => {
            expect(() => {
                const app = new cdk.App();
                new ecs_platform_stack_1.EcsPlatformStack(app, 'TestHttpsValidation2', {
                    environment: 'test',
                    vpcId: 'vpc-12345678',
                    publicSubnetIds: ['subnet-11111111'],
                    loadBalancerSecurityGroupId: 'sg-12345678',
                    stackName: 'TestHttpsValidation2',
                    env: {
                        account: '123456789012',
                        region: 'us-east-1',
                    },
                    baseDomain: 'example.com',
                    // appName intentionally omitted to test validation
                });
            }).toThrow('App name is required when base domain is provided');
        });
        test('handles appName without baseDomain gracefully', () => {
            expect(() => {
                const app = new cdk.App();
                new ecs_platform_stack_1.EcsPlatformStack(app, 'TestHttpsValidation3', {
                    environment: 'test',
                    vpcId: 'vpc-12345678',
                    publicSubnetIds: ['subnet-11111111'],
                    loadBalancerSecurityGroupId: 'sg-12345678',
                    stackName: 'TestHttpsValidation3',
                    env: {
                        account: '123456789012',
                        region: 'us-east-1',
                    },
                    appName: 'testapp',
                    // baseDomain intentionally omitted - should work without HTTPS
                });
            }).not.toThrow();
        });
        test('handles missing optional parameters gracefully', () => {
            app = new cdk.App();
            const minimalProps = {
                environment: 'test',
                vpcId: 'vpc-12345678',
                publicSubnetIds: ['subnet-11111111'],
                loadBalancerSecurityGroupId: 'sg-12345678',
                stackName: 'TestEcsPlatformStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            };
            expect(() => {
                new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', minimalProps);
            }).not.toThrow();
        });
        test('handles HTTPS without hosted zone', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                baseDomain: 'example.com',
                appName: 'testapp',
                // hostedZoneId not provided - should still work
            });
            template = assertions_1.Template.fromStack(stack);
            // Should still create certificate with DNS validation
            template.hasResourceProperties('AWS::CertificateManager::Certificate', {
                DomainName: 'example.com',
                ValidationMethod: 'DNS',
            });
        });
        test('WAF disabled by default', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs('AWS::WAFv2::WebACL', 0);
            template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
            template.resourceCountIs('AWS::WAFv2::IPSet', 0);
        });
        test('HTTPS disabled when no domain configuration', () => {
            app = new cdk.App();
            const propsWithoutDomain = {
                environment: 'test',
                vpcId: 'vpc-12345678',
                publicSubnetIds: ['subnet-11111111'],
                loadBalancerSecurityGroupId: 'sg-12345678',
                stackName: 'TestEcsPlatformStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            };
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', propsWithoutDomain);
            template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
            // Should only have HTTP listener
            template.resourcePropertiesCountIs('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 80,
                Protocol: 'HTTP',
            }, 1);
            template.resourcePropertiesCountIs('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 443,
                Protocol: 'HTTPS',
            }, 0);
        });
        test('does not create DNS records (handled by ApplicationStack)', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                environment: 'test',
                vpcId: 'vpc-12345678',
                publicSubnetIds: ['subnet-11111111', 'subnet-22222222', 'subnet-33333333'],
                loadBalancerSecurityGroupId: 'sg-12345678',
                baseDomain: 'example.com',
                appName: 'testapp',
                hostedZoneId: 'Z123456789',
                stackName: 'TestEcsPlatformStack',
                env: {
                    account: '123456789012',
                    region: 'us-east-1',
                },
            });
            template = assertions_1.Template.fromStack(stack);
            // Platform stack should not create DNS records - that's handled by ApplicationStack
            template.resourceCountIs('AWS::Route53::RecordSet', 0);
        });
    });
    describe('Environment-specific Removal Policies', () => {
        test('production environment has retain policy for ECR', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResource('AWS::ECR::Repository', {
                DeletionPolicy: 'Retain',
            });
        });
        test('non-production environment has destroy policy for ECR', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'dev',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResource('AWS::ECR::Repository', {
                DeletionPolicy: 'Delete',
            });
        });
        test('production ALB has deletion protection enabled', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                LoadBalancerAttributes: assertions_1.Match.arrayWith([
                    {
                        Key: 'deletion_protection.enabled',
                        Value: 'true',
                    },
                ]),
            });
        });
        test('non-production ALB has deletion protection disabled', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'dev',
            });
            template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                LoadBalancerAttributes: assertions_1.Match.arrayWith([
                    {
                        Key: 'deletion_protection.enabled',
                        Value: 'false',
                    },
                ]),
            });
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlY3MtcGxhdGZvcm0tc3RhY2sudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG1DQUFtQztBQUNuQyx1REFBeUQ7QUFDekQsa0VBQTZEO0FBRTdELFFBQVEsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7SUFDaEMsSUFBSSxHQUFZLENBQUM7SUFDakIsSUFBSSxRQUFrQixDQUFDO0lBRXZCLE1BQU0sWUFBWSxHQUFHO1FBQ25CLFdBQVcsRUFBRSxNQUFNO1FBQ25CLEtBQUssRUFBRSxjQUFjO1FBQ3JCLGVBQWUsRUFBRSxDQUFDLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixDQUFDO1FBQzFFLDJCQUEyQixFQUFFLGFBQWE7UUFDMUMsVUFBVSxFQUFFLGFBQWE7UUFDekIsT0FBTyxFQUFFLFNBQVM7UUFDbEIsWUFBWSxFQUFFLFlBQVk7UUFDMUIsU0FBUyxFQUFFLHNCQUFzQjtRQUNqQyxHQUFHLEVBQUU7WUFDSCxPQUFPLEVBQUUsY0FBYztZQUN2QixNQUFNLEVBQUUsV0FBVztTQUNwQjtLQUNGLENBQUM7SUFFRixRQUFRLENBQUMsa0NBQWtDLEVBQUUsR0FBRyxFQUFFO1FBQ2hELFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxxQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUUsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGdEQUFnRCxFQUFFLEdBQUcsRUFBRTtZQUMxRCxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELFdBQVcsRUFB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QUUsT0FBTztxQkFDZjtpQkFDRixDQUFDO2FBQ0gsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFRlbXBsYXRlLCBNYXRjaCB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuaW1wb3J0IHsgRWNzUGxhdGZvcm1TdGFjayB9IGZyb20gJy4uL2xpYi9lY3MtcGxhdGZvcm0tc3RhY2snO1xuXG5kZXNjcmliZSgnRWNzUGxhdGZvcm1TdGFjaycsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcDtcbiAgbGV0IHRlbXBsYXRlOiBUZW1wbGF0ZTtcblxuICBjb25zdCBkZWZhdWx0UHJvcHMgPSB7XG4gICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMScsICdzdWJuZXQtMjIyMjIyMjInLCAnc3VibmV0LTMzMzMzMzMzJ10sXG4gICAgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkOiAnc2ctMTIzNDU2NzgnLFxuICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgIGhvc3RlZFpvbmVJZDogJ1oxMjM0NTY3ODknLFxuICAgIHN0YWNrTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJyxcbiAgICBlbnY6IHtcbiAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICB9LFxuICB9O1xuXG4gIGRlc2NyaWJlKCdCYXNpYyBFQ1MgUGxhdGZvcm0gQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgRUNTIGNsdXN0ZXIgd2l0aCBjb3JyZWN0IGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpDbHVzdGVyJywge1xuICAgICAgICBDbHVzdGVyTmFtZTogJ3Rlc3RhcHAtY2x1c3Rlci10ZXN0JyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1IgcmVwb3NpdG9yeSB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIFJlcG9zaXRvcnlOYW1lOiAndGVzdGFwcC10ZXN0JyxcbiAgICAgICAgSW1hZ2VTY2FubmluZ0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBJbWFnZVRhZ011dGFiaWxpdHk6ICdNVVRBQkxFJyxcbiAgICAgICAgTGlmZWN5Y2xlUG9saWN5OiB7XG4gICAgICAgICAgTGlmZWN5Y2xlUG9saWN5VGV4dDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ0RlbGV0ZSB1bnRhZ2dlZCBpbWFnZXMgYWZ0ZXIgMSBkYXknLFxuICAgICAgICAgICAgICAgIHNlbGVjdGlvbjoge1xuICAgICAgICAgICAgICAgICAgdGFnU3RhdHVzOiAndW50YWdnZWQnLFxuICAgICAgICAgICAgICAgICAgY291bnRUeXBlOiAnc2luY2VJbWFnZVB1c2hlZCcsXG4gICAgICAgICAgICAgICAgICBjb3VudE51bWJlcjogMSxcbiAgICAgICAgICAgICAgICAgIGNvdW50VW5pdDogJ2RheXMnLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgYWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgICB0eXBlOiAnZXhwaXJlJyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgcnVsZVByaW9yaXR5OiAyLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsXG4gICAgICAgICAgICAgICAgc2VsZWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgICB0YWdTdGF0dXM6ICdhbnknLFxuICAgICAgICAgICAgICAgICAgY291bnRUeXBlOiAnaW1hZ2VDb3VudE1vcmVUaGFuJyxcbiAgICAgICAgICAgICAgICAgIGNvdW50TnVtYmVyOiAxMCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGFjdGlvbjoge1xuICAgICAgICAgICAgICAgICAgdHlwZTogJ2V4cGlyZScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlcicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLWFsYi10ZXN0JyxcbiAgICAgICAgU2NoZW1lOiAnaW50ZXJuZXQtZmFjaW5nJyxcbiAgICAgICAgVHlwZTogJ2FwcGxpY2F0aW9uJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBIVFRQIGxpc3RlbmVyIHdpdGggZGVmYXVsdCBhY3Rpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXInLCB7XG4gICAgICAgIFBvcnQ6IDgwLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFAnLFxuICAgICAgICBEZWZhdWx0QWN0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIFR5cGU6ICdmaXhlZC1yZXNwb25zZScsXG4gICAgICAgICAgICBGaXhlZFJlc3BvbnNlQ29uZmlnOiB7XG4gICAgICAgICAgICAgIFN0YXR1c0NvZGU6ICc1MDMnLFxuICAgICAgICAgICAgICBDb250ZW50VHlwZTogJ3RleHQvcGxhaW4nLFxuICAgICAgICAgICAgICBNZXNzYWdlQm9keTogJ1NlcnZpY2UgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIENsb3VkV2F0Y2ggbG9nIGdyb3VwJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxvZ3M6OkxvZ0dyb3VwJywge1xuICAgICAgICBMb2dHcm91cE5hbWU6ICcvYXdzL2Vjcy90ZXN0YXBwLXRlc3QnLFxuICAgICAgICBSZXRlbnRpb25JbkRheXM6IDcsIC8vIE9uZSB3ZWVrIGZvciB0ZXN0IGVudmlyb25tZW50XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0N1c3RvbSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgY2x1c3Rlck5hbWU6ICdjdXN0b20tY2x1c3RlcicsXG4gICAgICAgIHJlcG9zaXRvcnlOYW1lOiAnY3VzdG9tLXJlcG8nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNsdXN0ZXIgd2l0aCBjdXN0b20gbmFtZScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICAgIENsdXN0ZXJOYW1lOiAnY3VzdG9tLWNsdXN0ZXInLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHJlcG9zaXRvcnkgd2l0aCBjdXN0b20gbmFtZScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIFJlcG9zaXRvcnlOYW1lOiAnY3VzdG9tLXJlcG8nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIHByb2R1Y3Rpb24gbG9nIHJldGVudGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpMb2dzOjpMb2dHcm91cCcsIHtcbiAgICAgICAgUmV0ZW50aW9uSW5EYXlzOiAzMCwgLy8gT25lIG1vbnRoIGZvciBwcm9kdWN0aW9uXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1Byb2R1Y3Rpb24gRW52aXJvbm1lbnQgRmVhdHVyZXMnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIENsb3VkTWFwIG5hbWVzcGFjZSBmb3IgcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpTZXJ2aWNlRGlzY292ZXJ5OjpQcml2YXRlRG5zTmFtZXNwYWNlJywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC1wcm9kdWN0aW9uJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZW5hYmxlcyBkZWxldGlvbiBwcm90ZWN0aW9uIGZvciBBTEIgaW4gcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIExvYWRCYWxhbmNlckF0dHJpYnV0ZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAge1xuICAgICAgICAgICAgS2V5OiAnZGVsZXRpb25fcHJvdGVjdGlvbi5lbmFibGVkJyxcbiAgICAgICAgICAgIFZhbHVlOiAndHJ1ZScsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhcyByZXRhaW4gcmVtb3ZhbCBwb2xpY3kgZm9yIEVDUiBpbiBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2UoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgICBEZWxldGlvblBvbGljeTogJ1JldGFpbicsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0hUVFBTIGFuZCBDZXJ0aWZpY2F0ZSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBTU0wgY2VydGlmaWNhdGUnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIHtcbiAgICAgICAgRG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgU3ViamVjdEFsdGVybmF0aXZlTmFtZXM6IFsnKi5leGFtcGxlLmNvbSddLFxuICAgICAgICBWYWxpZGF0aW9uTWV0aG9kOiAnRE5TJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBIVFRQUyBsaXN0ZW5lcicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogNDQzLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgICAgQ2VydGlmaWNhdGVzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2VydGlmaWNhdGVBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBIVFRQIHRvIEhUVFBTIHJlZGlyZWN0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyJywge1xuICAgICAgICBEZWZhdWx0QWN0aW9uczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBUeXBlOiAncmVkaXJlY3QnLFxuICAgICAgICAgICAgUmVkaXJlY3RDb25maWc6IHtcbiAgICAgICAgICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgICAgICAgIFBvcnQ6ICc0NDMnLFxuICAgICAgICAgICAgICBTdGF0dXNDb2RlOiAnSFRUUF8zMDEnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBSb3V0ZTUzIEROUyBDb25maWd1cmF0aW9uIHRlc3RzIHJlbW92ZWQgLSBETlMgcmVjb3JkcyBhcmUgbm93IGhhbmRsZWQgYnkgQXBwbGljYXRpb25TdGFja1xuXG4gIGRlc2NyaWJlKCdXQUYgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgV0FGIFdlYiBBQ0wgd2l0aCBjb3JlIHJ1bGUgc2V0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LXdlYi1hY2wnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ1dBRiBmb3IgVGVzdEFwcCB0ZXN0IGVudmlyb25tZW50JyxcbiAgICAgICAgU2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICAgIERlZmF1bHRBY3Rpb246IHsgQWxsb3c6IHt9IH0sXG4gICAgICAgIFJ1bGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIE5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAyLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICBQcmlvcml0eTogMyxcbiAgICAgICAgICAgIE92ZXJyaWRlQWN0aW9uOiB7IE5vbmU6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgTWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICAgIFZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyByYXRlIGxpbWl0aW5nIHJ1bGUnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgICBQcmlvcml0eTogMTAsXG4gICAgICAgICAgICBBY3Rpb246IHsgQmxvY2s6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgUmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgTGltaXQ6IDEwMDAsIC8vIFRlc3QgZW52aXJvbm1lbnQgbGltaXRcbiAgICAgICAgICAgICAgICBBZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgSVAgc2V0IGZvciBhbGxvdyBsaXN0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpJUFNldCcsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtdGVzdC1hbGxvdy1saXN0JyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvd2VkIElQIGFkZHJlc3NlcyBmb3IgaGlnaGVyIHJhdGUgbGltaXRzJyxcbiAgICAgICAgSVBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgICBBZGRyZXNzZXM6IFtdLFxuICAgICAgICBTY29wZTogJ1JFR0lPTkFMJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnYXNzb2NpYXRlcyBXQUYgd2l0aCBBTEInLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTEFzc29jaWF0aW9uJywge1xuICAgICAgICBSZXNvdXJjZUFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgV2ViQUNMQXJuOiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdXQUYgUHJvZHVjdGlvbiBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIHByb2R1Y3Rpb24gcmF0ZSBsaW1pdHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgICBQcmlvcml0eTogMTAsXG4gICAgICAgICAgICBBY3Rpb246IHsgQmxvY2s6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgUmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgTGltaXQ6IDIwMDAsIC8vIFByb2R1Y3Rpb24gZW52aXJvbm1lbnQgbGltaXRcbiAgICAgICAgICAgICAgICBBZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2luY2x1ZGVzIGdlb2dyYXBoaWMgcmVzdHJpY3Rpb24gZm9yIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnR2VvUmVzdHJpY3Rpb25SdWxlJyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxNSxcbiAgICAgICAgICAgIEFjdGlvbjogeyBCbG9jazoge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBHZW9NYXRjaFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICAgIENvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCcsICdJUiddLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1N0YWNrIE91dHB1dHMnLCAoKSA9PiB7XG4gICAgbGV0IHN0YWNrOiBFY3NQbGF0Zm9ybVN0YWNrO1xuXG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBiYXNlRG9tYWluOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBhcHBOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgIGhvc3RlZFpvbmVJZDogJ1oxMjM0NTY3ODknLFxuICAgICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgRUNTIGNsdXN0ZXIgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQ2x1c3RlckFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUNsdXN0ZXJBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdDbHVzdGVyTmFtZScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1DbHVzdGVyTmFtZScgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1IgcmVwb3NpdG9yeSBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdSZXBvc2l0b3J5VXJpJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stUmVwb3NpdG9yeVVyaScgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1JlcG9zaXRvcnlBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1SZXBvc2l0b3J5QXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIExvYWQgQmFsYW5jZXIgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnTG9hZEJhbGFuY2VyQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2FkQmFsYW5jZXJBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2FkQmFsYW5jZXJETlMnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBETlMgTmFtZScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stTG9hZEJhbGFuY2VyRE5TJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnTG9hZEJhbGFuY2VyWm9uZUlkJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgSG9zdGVkIFpvbmUgSUQnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvYWRCYWxhbmNlclpvbmVJZCcgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBsaXN0ZW5lciBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdIdHRwTGlzdGVuZXJBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnSFRUUCBMaXN0ZW5lciBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUh0dHBMaXN0ZW5lckFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0h0dHBzTGlzdGVuZXJBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnSFRUUFMgTGlzdGVuZXIgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1IdHRwc0xpc3RlbmVyQXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGxvZyBncm91cCBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2dHcm91cE5hbWUnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBMb2cgR3JvdXAgTmFtZScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stTG9nR3JvdXBOYW1lJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnTG9nR3JvdXBBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBMb2cgR3JvdXAgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2dHcm91cEFybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBjZXJ0aWZpY2F0ZSBvdXRwdXRzIHdoZW4gSFRUUFMgZW5hYmxlZCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQ2VydGlmaWNhdGVBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnU1NMIENlcnRpZmljYXRlIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stQ2VydGlmaWNhdGVBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgV0FGIG91dHB1dHMgd2hlbiBXQUYgZW5hYmxlZCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnV0FGV2ViQUNMQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1dBRiBXZWIgQUNMIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stV0FGV2ViQUNMQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnV0FGV2ViQUNMSWQnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgSUQnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLVdBRldlYkFDTElkJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBBcHBsaWNhdGlvbiBVUkwgdGVzdCByZW1vdmVkIC0gQXBwbGljYXRpb24gVVJMcyBhcmUgbm93IGhhbmRsZWQgYnkgQXBwbGljYXRpb25TdGFja1xuICB9KTtcblxuICAvLyBBcHBsaWNhdGlvbiBVUkwgdGVzdHMgcmVtb3ZlZCAtIEFwcGxpY2F0aW9uIFVSTHMgYXJlIG5vdyBoYW5kbGVkIGJ5IEFwcGxpY2F0aW9uU3RhY2tcblxuICBkZXNjcmliZSgnUmVzb3VyY2UgVGFnZ2luZycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgIGFwcE5hbWU6ICd0ZXN0YXBwJyxcbiAgICAgICAgaG9zdGVkWm9uZUlkOiAnWjEyMzQ1Njc4OScsXG4gICAgICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnRUNTIGNsdXN0ZXIgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ01hbmFnZWRCeScsIFZhbHVlOiAnQ0RLJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnRUNSIHJlcG9zaXRvcnkgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ01hbmFnZWRCeScsIFZhbHVlOiAnQ0RLJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnTG9hZCBCYWxhbmNlciBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdDZXJ0aWZpY2F0ZSBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNlcnRpZmljYXRlTWFuYWdlcjo6Q2VydGlmaWNhdGUnLCB7XG4gICAgICAgIFRhZ3M6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ01hbmFnZWRCeScsIFZhbHVlOiAnQ0RLJyB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnV0FGIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgICAgeyBLZXk6ICdQdXJwb3NlJywgVmFsdWU6ICdERG9TLVByb3RlY3Rpb24nIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFcnJvciBIYW5kbGluZyBhbmQgRWRnZSBDYXNlcycsICgpID0+IHtcbiAgICB0ZXN0KCdoYW5kbGVzIG1pc3NpbmcgZG9tYWluIGNvbmZpZ3VyYXRpb24gZ3JhY2VmdWxseScsICgpID0+IHtcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RIdHRwc1ZhbGlkYXRpb24nLCB7XG4gICAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMSddLFxuICAgICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgICBzdGFja05hbWU6ICdUZXN0SHR0cHNWYWxpZGF0aW9uJyxcbiAgICAgICAgICBlbnY6IHtcbiAgICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgICAgLy8gYmFzZURvbWFpbiBhbmQgYXBwTmFtZSBpbnRlbnRpb25hbGx5IG9taXR0ZWQgLSBzaG91bGQgd29yayB3aXRob3V0IEhUVFBTXG4gICAgICAgIH0pO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rocm93cyBlcnJvciB3aGVuIGJhc2VEb21haW4gcHJvdmlkZWQgYnV0IGFwcE5hbWUgbWlzc2luZycsICgpID0+IHtcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RIdHRwc1ZhbGlkYXRpb24yJywge1xuICAgICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgICAgICAgIHB1YmxpY1N1Ym5ldElkczogWydzdWJuZXQtMTExMTExMTEnXSxcbiAgICAgICAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEh0dHBzVmFsaWRhdGlvbjInLFxuICAgICAgICAgIGVudjoge1xuICAgICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgICBiYXNlRG9tYWluOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICAgIC8vIGFwcE5hbWUgaW50ZW50aW9uYWxseSBvbWl0dGVkIHRvIHRlc3QgdmFsaWRhdGlvblxuICAgICAgICB9KTtcbiAgICAgIH0pLnRvVGhyb3coJ0FwcCBuYW1lIGlzIHJlcXVpcmVkIHdoZW4gYmFzZSBkb21haW4gaXMgcHJvdmlkZWQnKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgYXBwTmFtZSB3aXRob3V0IGJhc2VEb21haW4gZ3JhY2VmdWxseScsICgpID0+IHtcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RIdHRwc1ZhbGlkYXRpb24zJywge1xuICAgICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgICAgICAgIHB1YmxpY1N1Ym5ldElkczogWydzdWJuZXQtMTExMTExMTEnXSxcbiAgICAgICAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEh0dHBzVmFsaWRhdGlvbjMnLFxuICAgICAgICAgIGVudjoge1xuICAgICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgICBhcHBOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgICAgLy8gYmFzZURvbWFpbiBpbnRlbnRpb25hbGx5IG9taXR0ZWQgLSBzaG91bGQgd29yayB3aXRob3V0IEhUVFBTXG4gICAgICAgIH0pO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgbWlzc2luZyBvcHRpb25hbCBwYXJhbWV0ZXJzIGdyYWNlZnVsbHknLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3QgbWluaW1hbFByb3BzID0ge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgIHB1YmxpY1N1Ym5ldElkczogWydzdWJuZXQtMTExMTExMTEnXSxcbiAgICAgICAgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkOiAnc2ctMTIzNDU2NzgnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgICAgXG4gICAgICBleHBlY3QoKCkgPT4ge1xuICAgICAgICBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIG1pbmltYWxQcm9wcyk7XG4gICAgICB9KS5ub3QudG9UaHJvdygpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBIVFRQUyB3aXRob3V0IGhvc3RlZCB6b25lJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICAvLyBob3N0ZWRab25lSWQgbm90IHByb3ZpZGVkIC0gc2hvdWxkIHN0aWxsIHdvcmtcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBTaG91bGQgc3RpbGwgY3JlYXRlIGNlcnRpZmljYXRlIHdpdGggRE5TIHZhbGlkYXRpb25cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpDZXJ0aWZpY2F0ZU1hbmFnZXI6OkNlcnRpZmljYXRlJywge1xuICAgICAgICBEb21haW5OYW1lOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBWYWxpZGF0aW9uTWV0aG9kOiAnRE5TJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnV0FGIGRpc2FibGVkIGJ5IGRlZmF1bHQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywgMCk7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6V0FGdjI6OldlYkFDTEFzc29jaWF0aW9uJywgMCk7XG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6V0FGdjI6OklQU2V0JywgMCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdIVFRQUyBkaXNhYmxlZCB3aGVuIG5vIGRvbWFpbiBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHByb3BzV2l0aG91dERvbWFpbiA9IHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgICAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJ10sXG4gICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCBwcm9wc1dpdGhvdXREb21haW4pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIDApO1xuICAgICAgXG4gICAgICAvLyBTaG91bGQgb25seSBoYXZlIEhUVFAgbGlzdGVuZXJcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlUHJvcGVydGllc0NvdW50SXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXInLCB7XG4gICAgICAgIFBvcnQ6IDgwLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFAnLFxuICAgICAgfSwgMSk7XG4gICAgICBcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlUHJvcGVydGllc0NvdW50SXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXInLCB7XG4gICAgICAgIFBvcnQ6IDQ0MyxcbiAgICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICB9LCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2RvZXMgbm90IGNyZWF0ZSBETlMgcmVjb3JkcyAoaGFuZGxlZCBieSBBcHBsaWNhdGlvblN0YWNrKScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgIHB1YmxpY1N1Ym5ldElkczogWydzdWJuZXQtMTExMTExMTEnLCAnc3VibmV0LTIyMjIyMjIyJywgJ3N1Ym5ldC0zMzMzMzMzMyddLFxuICAgICAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgIGFwcE5hbWU6ICd0ZXN0YXBwJyxcbiAgICAgICAgaG9zdGVkWm9uZUlkOiAnWjEyMzQ1Njc4OScsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICAvLyBQbGF0Zm9ybSBzdGFjayBzaG91bGQgbm90IGNyZWF0ZSBETlMgcmVjb3JkcyAtIHRoYXQncyBoYW5kbGVkIGJ5IEFwcGxpY2F0aW9uU3RhY2tcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpSb3V0ZTUzOjpSZWNvcmRTZXQnLCAwKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0Vudmlyb25tZW50LXNwZWNpZmljIFJlbW92YWwgUG9saWNpZXMnLCAoKSA9PiB7XG4gICAgdGVzdCgncHJvZHVjdGlvbiBlbnZpcm9ubWVudCBoYXMgcmV0YWluIHBvbGljeSBmb3IgRUNSJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZSgnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIERlbGV0aW9uUG9saWN5OiAnUmV0YWluJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm9uLXByb2R1Y3Rpb24gZW52aXJvbm1lbnQgaGFzIGRlc3Ryb3kgcG9saWN5IGZvciBFQ1InLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2UoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgICBEZWxldGlvblBvbGljeTogJ0RlbGV0ZScsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Byb2R1Y3Rpb24gQUxCIGhhcyBkZWxldGlvbiBwcm90ZWN0aW9uIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIExvYWRCYWxhbmNlckF0dHJpYnV0ZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAge1xuICAgICAgICAgICAgS2V5OiAnZGVsZXRpb25fcHJvdGVjdGlvbi5lbmFibGVkJyxcbiAgICAgICAgICAgIFZhbHVlOiAndHJ1ZScsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ25vbi1wcm9kdWN0aW9uIEFMQiBoYXMgZGVsZXRpb24gcHJvdGVjdGlvbiBkaXNhYmxlZCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TG9hZEJhbGFuY2VyJywge1xuICAgICAgICBMb2FkQmFsYW5jZXJBdHRyaWJ1dGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEtleTogJ2RlbGV0aW9uX3Byb3RlY3Rpb24uZW5hYmxlZCcsXG4gICAgICAgICAgICBWYWx1ZTogJ2ZhbHNlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcbn0pOyJdfQ==