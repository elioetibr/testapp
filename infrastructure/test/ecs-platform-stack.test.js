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
                enableHTTPS: true,
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
                enableHTTPS: true,
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
                enableHTTPS: true,
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
        test('throws error when HTTPS enabled but no domain provided', () => {
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
                    enableHTTPS: true,
                    // baseDomain and appName intentionally omitted to test validation
                });
            }).toThrow('Base domain and app name are required when HTTPS is enabled');
        });
        test('throws error when HTTPS enabled but only baseDomain provided', () => {
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
                    enableHTTPS: true,
                    baseDomain: 'example.com',
                    // appName intentionally omitted to test validation
                });
            }).toThrow('Base domain and app name are required when HTTPS is enabled');
        });
        test('throws error when HTTPS enabled but only appName provided', () => {
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
                    enableHTTPS: true,
                    appName: 'testapp',
                    // baseDomain intentionally omitted to test validation
                });
            }).toThrow('Base domain and app name are required when HTTPS is enabled');
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
                enableHTTPS: true,
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
        test('HTTPS disabled by default', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlY3MtcGxhdGZvcm0tc3RhY2sudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG1DQUFtQztBQUNuQyx1REFBeUQ7QUFDekQsa0VBQTZEO0FBRTdELFFBQVEsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7SUFDaEMsSUFBSSxHQUFZLENBQUM7SUFDakIsSUFBSSxRQUFrQixDQUFDO0lBRXZCLE1BQU0sWUFBWSxHQUFHO1FBQ25CLFdBQVcsRUFBRSxNQUFNO1FBQ25CLEtBQUssRUFBRSxjQUFjO1FBQ3JCLGVBQWUsRUFBRSxDQUFDLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixDQUFDO1FBQzFFLDJCQUEyQixFQUFFLGFBQWE7UUFDMUMsVUFBVSxFQUFFLGFBQWE7UUFDekIsT0FBTyxFQUFFLFNBQVM7UUFDbEIsWUFBWSxFQUFFLFlBQVk7UUFDMUIsU0FBUyxFQUFFLHNCQUFzQjtRQUNqQyxHQUFHLEVBQUU7WUFDSCxPQUFPLEVBQUUsY0FBYztZQUN2QixNQUFNLEVBQUUsV0FBVztTQUNwQjtLQUNGLENBQUM7SUFFRixRQUFRLENBQUMsa0NBQWtDLEVBQUUsR0FBRyxFQUFFO1FBQ2hELFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxxQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUUsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGdEQUFnRCxFQUFFLEdBQUcsRUFBRTtZQUMxRCxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELFdBQVcsRUFB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Q0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBFY3NQbGF0Zm9ybVN0YWNrIH0gZnJvbSAnLi4vbGliL2Vjcy1wbGF0Zm9ybS1zdGFjayc7XG5cbmRlc2NyaWJlKCdFY3NQbGF0Zm9ybVN0YWNrJywgKCkgPT4ge1xuICBsZXQgYXBwOiBjZGsuQXBwO1xuICBsZXQgdGVtcGxhdGU6IFRlbXBsYXRlO1xuXG4gIGNvbnN0IGRlZmF1bHRQcm9wcyA9IHtcbiAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJywgJ3N1Ym5ldC0yMjIyMjIyMicsICdzdWJuZXQtMzMzMzMzMzMnXSxcbiAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICBhcHBOYW1lOiAndGVzdGFwcCcsXG4gICAgaG9zdGVkWm9uZUlkOiAnWjEyMzQ1Njc4OScsXG4gICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgIGVudjoge1xuICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgIH0sXG4gIH07XG5cbiAgZGVzY3JpYmUoJ0Jhc2ljIEVDUyBQbGF0Zm9ybSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1MgY2x1c3RlciB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICAgIENsdXN0ZXJOYW1lOiAndGVzdGFwcC1jbHVzdGVyLXRlc3QnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEVDUiByZXBvc2l0b3J5IHdpdGggY29ycmVjdCBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgICAgUmVwb3NpdG9yeU5hbWU6ICd0ZXN0YXBwLXRlc3QnLFxuICAgICAgICBJbWFnZVNjYW5uaW5nQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIFNjYW5PblB1c2g6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIEltYWdlVGFnTXV0YWJpbGl0eTogJ01VVEFCTEUnLFxuICAgICAgICBMaWZlY3ljbGVQb2xpY3k6IHtcbiAgICAgICAgICBMaWZlY3ljbGVQb2xpY3lUZXh0OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICBydWxlczogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgcnVsZVByaW9yaXR5OiAxLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnRGVsZXRlIHVudGFnZ2VkIGltYWdlcyBhZnRlciAxIGRheScsXG4gICAgICAgICAgICAgICAgc2VsZWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgICB0YWdTdGF0dXM6ICd1bnRhZ2dlZCcsXG4gICAgICAgICAgICAgICAgICBjb3VudFR5cGU6ICdzaW5jZUltYWdlUHVzaGVkJyxcbiAgICAgICAgICAgICAgICAgIGNvdW50TnVtYmVyOiAxLFxuICAgICAgICAgICAgICAgICAgY291bnRVbml0OiAnZGF5cycsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBhY3Rpb246IHtcbiAgICAgICAgICAgICAgICAgIHR5cGU6ICdleHBpcmUnLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBydWxlUHJpb3JpdHk6IDIsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICAgICAgICBzZWxlY3Rpb246IHtcbiAgICAgICAgICAgICAgICAgIHRhZ1N0YXR1czogJ2FueScsXG4gICAgICAgICAgICAgICAgICBjb3VudFR5cGU6ICdpbWFnZUNvdW50TW9yZVRoYW4nLFxuICAgICAgICAgICAgICAgICAgY291bnROdW1iZXI6IDEwLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgYWN0aW9uOiB7XG4gICAgICAgICAgICAgICAgICB0eXBlOiAnZXhwaXJlJyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtYWxiLXRlc3QnLFxuICAgICAgICBTY2hlbWU6ICdpbnRlcm5ldC1mYWNpbmcnLFxuICAgICAgICBUeXBlOiAnYXBwbGljYXRpb24nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEhUVFAgbGlzdGVuZXIgd2l0aCBkZWZhdWx0IGFjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogODAsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICAgIERlZmF1bHRBY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVHlwZTogJ2ZpeGVkLXJlc3BvbnNlJyxcbiAgICAgICAgICAgIEZpeGVkUmVzcG9uc2VDb25maWc6IHtcbiAgICAgICAgICAgICAgU3RhdHVzQ29kZTogJzUwMycsXG4gICAgICAgICAgICAgIENvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgICAgICAgIE1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRXYXRjaCBsb2cgZ3JvdXAnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6TG9nczo6TG9nR3JvdXAnLCB7XG4gICAgICAgIExvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3RhcHAtdGVzdCcsXG4gICAgICAgIFJldGVudGlvbkluRGF5czogNywgLy8gT25lIHdlZWsgZm9yIHRlc3QgZW52aXJvbm1lbnRcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ3VzdG9tIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBjbHVzdGVyTmFtZTogJ2N1c3RvbS1jbHVzdGVyJyxcbiAgICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjdXN0b20tcmVwbycsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY2x1c3RlciB3aXRoIGN1c3RvbSBuYW1lJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6Q2x1c3RlcicsIHtcbiAgICAgICAgQ2x1c3Rlck5hbWU6ICdjdXN0b20tY2x1c3RlcicsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcmVwb3NpdG9yeSB3aXRoIGN1c3RvbSBuYW1lJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgICAgUmVwb3NpdG9yeU5hbWU6ICdjdXN0b20tcmVwbycsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcHJvZHVjdGlvbiBsb2cgcmV0ZW50aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxvZ3M6OkxvZ0dyb3VwJywge1xuICAgICAgICBSZXRlbnRpb25JbkRheXM6IDMwLCAvLyBPbmUgbW9udGggZm9yIHByb2R1Y3Rpb25cbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnUHJvZHVjdGlvbiBFbnZpcm9ubWVudCBGZWF0dXJlcycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRNYXAgbmFtZXNwYWNlIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlNlcnZpY2VEaXNjb3Zlcnk6OlByaXZhdGVEbnNOYW1lc3BhY2UnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXByb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdlbmFibGVzIGRlbGV0aW9uIHByb3RlY3Rpb24gZm9yIEFMQiBpbiBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTG9hZEJhbGFuY2VyQXR0cmlidXRlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBLZXk6ICdkZWxldGlvbl9wcm90ZWN0aW9uLmVuYWJsZWQnLFxuICAgICAgICAgICAgVmFsdWU6ICd0cnVlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFzIHJldGFpbiByZW1vdmFsIHBvbGljeSBmb3IgRUNSIGluIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZSgnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIERlbGV0aW9uUG9saWN5OiAnUmV0YWluJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnSFRUUFMgYW5kIENlcnRpZmljYXRlIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBTU0wgY2VydGlmaWNhdGUnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIHtcbiAgICAgICAgRG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgU3ViamVjdEFsdGVybmF0aXZlTmFtZXM6IFsnKi5leGFtcGxlLmNvbSddLFxuICAgICAgICBWYWxpZGF0aW9uTWV0aG9kOiAnRE5TJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBIVFRQUyBsaXN0ZW5lcicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogNDQzLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgICAgQ2VydGlmaWNhdGVzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2VydGlmaWNhdGVBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBIVFRQIHRvIEhUVFBTIHJlZGlyZWN0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyJywge1xuICAgICAgICBEZWZhdWx0QWN0aW9uczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBUeXBlOiAncmVkaXJlY3QnLFxuICAgICAgICAgICAgUmVkaXJlY3RDb25maWc6IHtcbiAgICAgICAgICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgICAgICAgIFBvcnQ6ICc0NDMnLFxuICAgICAgICAgICAgICBTdGF0dXNDb2RlOiAnSFRUUF8zMDEnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBSb3V0ZTUzIEROUyBDb25maWd1cmF0aW9uIHRlc3RzIHJlbW92ZWQgLSBETlMgcmVjb3JkcyBhcmUgbm93IGhhbmRsZWQgYnkgQXBwbGljYXRpb25TdGFja1xuXG4gIGRlc2NyaWJlKCdXQUYgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgV0FGIFdlYiBBQ0wgd2l0aCBjb3JlIHJ1bGUgc2V0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LXdlYi1hY2wnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ1dBRiBmb3IgVGVzdEFwcCB0ZXN0IGVudmlyb25tZW50JyxcbiAgICAgICAgU2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICAgIERlZmF1bHRBY3Rpb246IHsgQWxsb3c6IHt9IH0sXG4gICAgICAgIFJ1bGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIE5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAyLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICBQcmlvcml0eTogMyxcbiAgICAgICAgICAgIE92ZXJyaWRlQWN0aW9uOiB7IE5vbmU6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgTWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICAgIFZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyByYXRlIGxpbWl0aW5nIHJ1bGUnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgICBQcmlvcml0eTogMTAsXG4gICAgICAgICAgICBBY3Rpb246IHsgQmxvY2s6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgUmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgTGltaXQ6IDEwMDAsIC8vIFRlc3QgZW52aXJvbm1lbnQgbGltaXRcbiAgICAgICAgICAgICAgICBBZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgSVAgc2V0IGZvciBhbGxvdyBsaXN0JywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpJUFNldCcsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtdGVzdC1hbGxvdy1saXN0JyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBbGxvd2VkIElQIGFkZHJlc3NlcyBmb3IgaGlnaGVyIHJhdGUgbGltaXRzJyxcbiAgICAgICAgSVBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgICBBZGRyZXNzZXM6IFtdLFxuICAgICAgICBTY29wZTogJ1JFR0lPTkFMJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnYXNzb2NpYXRlcyBXQUYgd2l0aCBBTEInLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTEFzc29jaWF0aW9uJywge1xuICAgICAgICBSZXNvdXJjZUFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgV2ViQUNMQXJuOiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdBcm4nXSB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdXQUYgUHJvZHVjdGlvbiBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd1c2VzIHByb2R1Y3Rpb24gcmF0ZSBsaW1pdHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgICBQcmlvcml0eTogMTAsXG4gICAgICAgICAgICBBY3Rpb246IHsgQmxvY2s6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgUmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgTGltaXQ6IDIwMDAsIC8vIFByb2R1Y3Rpb24gZW52aXJvbm1lbnQgbGltaXRcbiAgICAgICAgICAgICAgICBBZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2luY2x1ZGVzIGdlb2dyYXBoaWMgcmVzdHJpY3Rpb24gZm9yIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OldlYkFDTCcsIHtcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnR2VvUmVzdHJpY3Rpb25SdWxlJyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxNSxcbiAgICAgICAgICAgIEFjdGlvbjogeyBCbG9jazoge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBHZW9NYXRjaFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICAgIENvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCcsICdJUiddLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1N0YWNrIE91dHB1dHMnLCAoKSA9PiB7XG4gICAgbGV0IHN0YWNrOiBFY3NQbGF0Zm9ybVN0YWNrO1xuXG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICBob3N0ZWRab25lSWQ6ICdaMTIzNDU2Nzg5JyxcbiAgICAgICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEVDUyBjbHVzdGVyIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0NsdXN0ZXJBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1DbHVzdGVyQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQ2x1c3Rlck5hbWUnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgTmFtZScsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stQ2x1c3Rlck5hbWUnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgRUNSIHJlcG9zaXRvcnkgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLVJlcG9zaXRvcnlVcmknIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdSZXBvc2l0b3J5QXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUiBSZXBvc2l0b3J5IEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stUmVwb3NpdG9yeUFybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBMb2FkIEJhbGFuY2VyIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvYWRCYWxhbmNlckFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stTG9hZEJhbGFuY2VyQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnTG9hZEJhbGFuY2VyRE5TJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgRE5TIE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvYWRCYWxhbmNlckROUycgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvYWRCYWxhbmNlclpvbmVJZCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEhvc3RlZCBab25lIElEJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2FkQmFsYW5jZXJab25lSWQnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgbGlzdGVuZXIgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnSHR0cExpc3RlbmVyQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0hUVFAgTGlzdGVuZXIgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1IdHRwTGlzdGVuZXJBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdIdHRwc0xpc3RlbmVyQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0hUVFBTIExpc3RlbmVyIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stSHR0cHNMaXN0ZW5lckFybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBsb2cgZ3JvdXAgb3V0cHV0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnTG9nR3JvdXBOYW1lJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTG9nIEdyb3VwIE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvZ0dyb3VwTmFtZScgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvZ0dyb3VwQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTG9nIEdyb3VwIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stTG9nR3JvdXBBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY2VydGlmaWNhdGUgb3V0cHV0cyB3aGVuIEhUVFBTIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0NlcnRpZmljYXRlQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1NTTCBDZXJ0aWZpY2F0ZSBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUNlcnRpZmljYXRlQXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIFdBRiBvdXRwdXRzIHdoZW4gV0FGIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1dBRldlYkFDTEFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLVdBRldlYkFDTEFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1dBRldlYkFDTElkJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ1dBRiBXZWIgQUNMIElEJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1XQUZXZWJBQ0xJZCcgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgLy8gQXBwbGljYXRpb24gVVJMIHRlc3QgcmVtb3ZlZCAtIEFwcGxpY2F0aW9uIFVSTHMgYXJlIG5vdyBoYW5kbGVkIGJ5IEFwcGxpY2F0aW9uU3RhY2tcbiAgfSk7XG5cbiAgLy8gQXBwbGljYXRpb24gVVJMIHRlc3RzIHJlbW92ZWQgLSBBcHBsaWNhdGlvbiBVUkxzIGFyZSBub3cgaGFuZGxlZCBieSBBcHBsaWNhdGlvblN0YWNrXG5cbiAgZGVzY3JpYmUoJ1Jlc291cmNlIFRhZ2dpbmcnLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICBob3N0ZWRab25lSWQ6ICdaMTIzNDU2Nzg5JyxcbiAgICAgICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdFQ1MgY2x1c3RlciBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6Q2x1c3RlcicsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdFQ1IgcmVwb3NpdG9yeSBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdMb2FkIEJhbGFuY2VyIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TG9hZEJhbGFuY2VyJywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESycgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0NlcnRpZmljYXRlIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdXQUYgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESycgfSxcbiAgICAgICAgICB7IEtleTogJ1B1cnBvc2UnLCBWYWx1ZTogJ0REb1MtUHJvdGVjdGlvbicgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0Vycm9yIEhhbmRsaW5nIGFuZCBFZGdlIENhc2VzJywgKCkgPT4ge1xuICAgIHRlc3QoJ3Rocm93cyBlcnJvciB3aGVuIEhUVFBTIGVuYWJsZWQgYnV0IG5vIGRvbWFpbiBwcm92aWRlZCcsICgpID0+IHtcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RIdHRwc1ZhbGlkYXRpb24nLCB7XG4gICAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMSddLFxuICAgICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgICBzdGFja05hbWU6ICdUZXN0SHR0cHNWYWxpZGF0aW9uJyxcbiAgICAgICAgICBlbnY6IHtcbiAgICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGVuYWJsZUhUVFBTOiB0cnVlLFxuICAgICAgICAgIC8vIGJhc2VEb21haW4gYW5kIGFwcE5hbWUgaW50ZW50aW9uYWxseSBvbWl0dGVkIHRvIHRlc3QgdmFsaWRhdGlvblxuICAgICAgICB9KTtcbiAgICAgIH0pLnRvVGhyb3coJ0Jhc2UgZG9tYWluIGFuZCBhcHAgbmFtZSBhcmUgcmVxdWlyZWQgd2hlbiBIVFRQUyBpcyBlbmFibGVkJyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd0aHJvd3MgZXJyb3Igd2hlbiBIVFRQUyBlbmFibGVkIGJ1dCBvbmx5IGJhc2VEb21haW4gcHJvdmlkZWQnLCAoKSA9PiB7XG4gICAgICBleHBlY3QoKCkgPT4ge1xuICAgICAgICBjb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgICBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0SHR0cHNWYWxpZGF0aW9uMicsIHtcbiAgICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJ10sXG4gICAgICAgICAgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkOiAnc2ctMTIzNDU2NzgnLFxuICAgICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RIdHRwc1ZhbGlkYXRpb24yJyxcbiAgICAgICAgICBlbnY6IHtcbiAgICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGVuYWJsZUhUVFBTOiB0cnVlLFxuICAgICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgICAgLy8gYXBwTmFtZSBpbnRlbnRpb25hbGx5IG9taXR0ZWQgdG8gdGVzdCB2YWxpZGF0aW9uXG4gICAgICAgIH0pO1xuICAgICAgfSkudG9UaHJvdygnQmFzZSBkb21haW4gYW5kIGFwcCBuYW1lIGFyZSByZXF1aXJlZCB3aGVuIEhUVFBTIGlzIGVuYWJsZWQnKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Rocm93cyBlcnJvciB3aGVuIEhUVFBTIGVuYWJsZWQgYnV0IG9ubHkgYXBwTmFtZSBwcm92aWRlZCcsICgpID0+IHtcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RIdHRwc1ZhbGlkYXRpb24zJywge1xuICAgICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgICAgICAgIHB1YmxpY1N1Ym5ldElkczogWydzdWJuZXQtMTExMTExMTEnXSxcbiAgICAgICAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEh0dHBzVmFsaWRhdGlvbjMnLFxuICAgICAgICAgIGVudjoge1xuICAgICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgZW5hYmxlSFRUUFM6IHRydWUsXG4gICAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICAgIC8vIGJhc2VEb21haW4gaW50ZW50aW9uYWxseSBvbWl0dGVkIHRvIHRlc3QgdmFsaWRhdGlvblxuICAgICAgICB9KTtcbiAgICAgIH0pLnRvVGhyb3coJ0Jhc2UgZG9tYWluIGFuZCBhcHAgbmFtZSBhcmUgcmVxdWlyZWQgd2hlbiBIVFRQUyBpcyBlbmFibGVkJyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIG1pc3Npbmcgb3B0aW9uYWwgcGFyYW1ldGVycyBncmFjZWZ1bGx5JywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IG1pbmltYWxQcm9wcyA9IHtcbiAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgdnBjSWQ6ICd2cGMtMTIzNDU2NzgnLFxuICAgICAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJ10sXG4gICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIFxuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCBtaW5pbWFsUHJvcHMpO1xuICAgICAgfSkubm90LnRvVGhyb3coKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2hhbmRsZXMgSFRUUFMgd2l0aG91dCBob3N0ZWQgem9uZScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVuYWJsZUhUVFBTOiB0cnVlLFxuICAgICAgICBiYXNlRG9tYWluOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBhcHBOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgIC8vIGhvc3RlZFpvbmVJZCBub3QgcHJvdmlkZWQgLSBzaG91bGQgc3RpbGwgd29ya1xuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFNob3VsZCBzdGlsbCBjcmVhdGUgY2VydGlmaWNhdGUgd2l0aCBETlMgdmFsaWRhdGlvblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNlcnRpZmljYXRlTWFuYWdlcjo6Q2VydGlmaWNhdGUnLCB7XG4gICAgICAgIERvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIFZhbGlkYXRpb25NZXRob2Q6ICdETlMnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdXQUYgZGlzYWJsZWQgYnkgZGVmYXVsdCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6V2ViQUNMQXNzb2NpYXRpb24nLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6SVBTZXQnLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0hUVFBTIGRpc2FibGVkIGJ5IGRlZmF1bHQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpDZXJ0aWZpY2F0ZU1hbmFnZXI6OkNlcnRpZmljYXRlJywgMCk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBvbmx5IGhhdmUgSFRUUCBsaXN0ZW5lclxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogODAsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICB9LCAxKTtcbiAgICAgIFxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogNDQzLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgIH0sIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZG9lcyBub3QgY3JlYXRlIEROUyByZWNvcmRzIChoYW5kbGVkIGJ5IEFwcGxpY2F0aW9uU3RhY2spJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMScsICdzdWJuZXQtMjIyMjIyMjInLCAnc3VibmV0LTMzMzMzMzMzJ10sXG4gICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICBob3N0ZWRab25lSWQ6ICdaMTIzNDU2Nzg5JyxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFBsYXRmb3JtIHN0YWNrIHNob3VsZCBub3QgY3JlYXRlIEROUyByZWNvcmRzIC0gdGhhdCdzIGhhbmRsZWQgYnkgQXBwbGljYXRpb25TdGFja1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OlJvdXRlNTM6OlJlY29yZFNldCcsIDApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnRW52aXJvbm1lbnQtc3BlY2lmaWMgUmVtb3ZhbCBQb2xpY2llcycsICgpID0+IHtcbiAgICB0ZXN0KCdwcm9kdWN0aW9uIGVudmlyb25tZW50IGhhcyByZXRhaW4gcG9saWN5IGZvciBFQ1InLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdSZXRhaW4nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdub24tcHJvZHVjdGlvbiBlbnZpcm9ubWVudCBoYXMgZGVzdHJveSBwb2xpY3kgZm9yIEVDUicsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZSgnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIERlbGV0aW9uUG9saWN5OiAnRGVsZXRlJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncHJvZHVjdGlvbiBBTEIgaGFzIGRlbGV0aW9uIHByb3RlY3Rpb24gZW5hYmxlZCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTG9hZEJhbGFuY2VyQXR0cmlidXRlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBLZXk6ICdkZWxldGlvbl9wcm90ZWN0aW9uLmVuYWJsZWQnLFxuICAgICAgICAgICAgVmFsdWU6ICd0cnVlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm9uLXByb2R1Y3Rpb24gQUxCIGhhcyBkZWxldGlvbiBwcm90ZWN0aW9uIGRpc2FibGVkJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIExvYWRCYWxhbmNlckF0dHJpYnV0ZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAge1xuICAgICAgICAgICAgS2V5OiAnZGVsZXRpb25fcHJvdGVjdGlvbi5lbmFibGVkJyxcbiAgICAgICAgICAgIFZhbHVlOiAnZmFsc2UnLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xufSk7Il19