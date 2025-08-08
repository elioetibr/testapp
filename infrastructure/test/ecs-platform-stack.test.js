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
        test('imports ECR repository with correct configuration', () => {
            // Since we import an existing repository, no AWS::ECR::Repository resource is created
            // Instead, we verify that the repository outputs are available
            template.resourceCountIs('AWS::ECR::Repository', 0);
            // Verify repository outputs are created for imported repository
            template.hasOutput('RepositoryUri', {
                Description: 'ECR Repository URI',
            });
            template.hasOutput('RepositoryArn', {
                Description: 'ECR Repository ARN',
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
        test('imports repository with custom name', () => {
            // Repository is imported, not created, so no AWS::ECR::Repository resource
            template.resourceCountIs('AWS::ECR::Repository', 0);
            // Verify repository outputs are available
            template.hasOutput('RepositoryUri', {
                Description: 'ECR Repository URI',
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
        test('imports ECR repository for production (no creation)', () => {
            // ECR repository is imported, not created, so no AWS::ECR::Repository resource
            // and no deletion policy is set since we don't manage the repository lifecycle
            template.resourceCountIs('AWS::ECR::Repository', 0);
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
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
                Priority: 1,
                Conditions: [
                    {
                        Field: 'path-pattern',
                        PathPatternConfig: {
                            Values: ['*'],
                        },
                    },
                ],
                Actions: [
                    {
                        Type: 'redirect',
                        RedirectConfig: {
                            Protocol: 'HTTPS',
                            Port: '443',
                            StatusCode: 'HTTP_301',
                        },
                    },
                ],
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
        test('ECR repository is imported (no tags management)', () => {
            // ECR repository is imported, not created, so no AWS::ECR::Repository resource
            // Tags are not managed by CDK for imported resources
            template.resourceCountIs('AWS::ECR::Repository', 0);
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
        test('production environment imports ECR repository (no deletion policy)', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
            });
            template = assertions_1.Template.fromStack(stack);
            // ECR repository is imported, not created, so no deletion policy is managed
            template.resourceCountIs('AWS::ECR::Repository', 0);
        });
        test('non-production environment imports ECR repository (no deletion policy)', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'dev',
            });
            template = assertions_1.Template.fromStack(stack);
            // ECR repository is imported, not created, so no deletion policy is managed
            template.resourceCountIs('AWS::ECR::Repository', 0);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlY3MtcGxhdGZvcm0tc3RhY2sudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG1DQUFtQztBQUNuQyx1REFBeUQ7QUFDekQsa0VBQTZEO0FBRTdELFFBQVEsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7SUFDaEMsSUFBSSxHQUFZLENBQUM7SUFDakIsSUFBSSxRQUFrQixDQUFDO0lBRXZCLE1BQU0sWUFBWSxHQUFHO1FBQ25CLFdBQVcsRUFBRSxNQUFNO1FBQ25CLEtBQUssRUFBRSxjQUFjO1FBQ3JCLGVBQWUsRUFBRSxDQUFDLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixDQUFDO1FBQzFFLDJCQUEyQixFQUFFLGFBQWE7UUFDMUMsVUFBVSxFQUFFLGFBQWE7UUFDekIsT0FBTyxFQUFFLFNBQVM7UUFDbEIsWUFBWSxFQUFFLFlBQVk7UUFDMUIsU0FBUyxFQUFFLHNCQUFzQjtRQUNqQyxHQUFHLEVBQUU7WUFDSCxPQUFPLEVBQUUsY0FBYztZQUN2QixNQUFNLEVBQUUsV0FBVztTQUNwQjtLQUNGLENBQUM7SUFFRixRQUFRLENBQUMsa0NBQWtDLEVBQUUsR0FBRyxFQUFFO1FBQ2hELFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxxQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUUsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGdEQUFnRCxFQUFFLEdBQUcsRUFBRTtZQUMxRCxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELFdBQVcsRUFB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QkFBcUIsQ0FBQywyQ0FBMkMsRUFBRTtnQkFDMUUsc0JBQXNCLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7b0JBQ3RDO3dCQUNFLEdBQUcsRUFBRSw2QkFBNkI7d0JBQ2xDLEtBQUssRUFBRSxNQUFNO3FCQUNkO2lCQUNGLENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxxREFBcUQsRUFBRSxHQUFHLEVBQUU7WUFDL0QsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sS0FBSyxHQUFHLElBQUkscUNBQWdCLENBQUMsR0FBRyxFQUFFLHNCQUFzQixFQUFFO2dCQUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLEtBQUs7YUFDbkIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywyQ0FBMkMsRUFBRTtnQkFDMUUsc0JBQXNCLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7b0JBQ3RDO3dCQUNFLEdBQUcsRUFBRSw2QkFBNkI7d0JBQ2xDLEtBQUssRUFBRSxPQUFPO3FCQUNmO2lCQUNGLENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBFY3NQbGF0Zm9ybVN0YWNrIH0gZnJvbSAnLi4vbGliL2Vjcy1wbGF0Zm9ybS1zdGFjayc7XG5cbmRlc2NyaWJlKCdFY3NQbGF0Zm9ybVN0YWNrJywgKCkgPT4ge1xuICBsZXQgYXBwOiBjZGsuQXBwO1xuICBsZXQgdGVtcGxhdGU6IFRlbXBsYXRlO1xuXG4gIGNvbnN0IGRlZmF1bHRQcm9wcyA9IHtcbiAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJywgJ3N1Ym5ldC0yMjIyMjIyMicsICdzdWJuZXQtMzMzMzMzMzMnXSxcbiAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICBhcHBOYW1lOiAndGVzdGFwcCcsXG4gICAgaG9zdGVkWm9uZUlkOiAnWjEyMzQ1Njc4OScsXG4gICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgIGVudjoge1xuICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgIH0sXG4gIH07XG5cbiAgZGVzY3JpYmUoJ0Jhc2ljIEVDUyBQbGF0Zm9ybSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1MgY2x1c3RlciB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICAgIENsdXN0ZXJOYW1lOiAndGVzdGFwcC1jbHVzdGVyLXRlc3QnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdpbXBvcnRzIEVDUiByZXBvc2l0b3J5IHdpdGggY29ycmVjdCBjb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgICAgLy8gU2luY2Ugd2UgaW1wb3J0IGFuIGV4aXN0aW5nIHJlcG9zaXRvcnksIG5vIEFXUzo6RUNSOjpSZXBvc2l0b3J5IHJlc291cmNlIGlzIGNyZWF0ZWRcbiAgICAgIC8vIEluc3RlYWQsIHdlIHZlcmlmeSB0aGF0IHRoZSByZXBvc2l0b3J5IG91dHB1dHMgYXJlIGF2YWlsYWJsZVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIDApO1xuICAgICAgXG4gICAgICAvLyBWZXJpZnkgcmVwb3NpdG9yeSBvdXRwdXRzIGFyZSBjcmVhdGVkIGZvciBpbXBvcnRlZCByZXBvc2l0b3J5XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1JlcG9zaXRvcnlVcmknLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIH0pO1xuICAgICAgXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1JlcG9zaXRvcnlBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgQVJOJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTmFtZTogJ3Rlc3RhcHAtYWxiLXRlc3QnLFxuICAgICAgICBTY2hlbWU6ICdpbnRlcm5ldC1mYWNpbmcnLFxuICAgICAgICBUeXBlOiAnYXBwbGljYXRpb24nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEhUVFAgbGlzdGVuZXIgd2l0aCBkZWZhdWx0IGFjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogODAsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICAgIERlZmF1bHRBY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVHlwZTogJ2ZpeGVkLXJlc3BvbnNlJyxcbiAgICAgICAgICAgIEZpeGVkUmVzcG9uc2VDb25maWc6IHtcbiAgICAgICAgICAgICAgU3RhdHVzQ29kZTogJzUwMycsXG4gICAgICAgICAgICAgIENvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgICAgICAgIE1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRXYXRjaCBsb2cgZ3JvdXAnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6TG9nczo6TG9nR3JvdXAnLCB7XG4gICAgICAgIExvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3RhcHAtdGVzdCcsXG4gICAgICAgIFJldGVudGlvbkluRGF5czogNywgLy8gT25lIHdlZWsgZm9yIHRlc3QgZW52aXJvbm1lbnRcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ3VzdG9tIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBjbHVzdGVyTmFtZTogJ2N1c3RvbS1jbHVzdGVyJyxcbiAgICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjdXN0b20tcmVwbycsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY2x1c3RlciB3aXRoIGN1c3RvbSBuYW1lJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6Q2x1c3RlcicsIHtcbiAgICAgICAgQ2x1c3Rlck5hbWU6ICdjdXN0b20tY2x1c3RlcicsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2ltcG9ydHMgcmVwb3NpdG9yeSB3aXRoIGN1c3RvbSBuYW1lJywgKCkgPT4ge1xuICAgICAgLy8gUmVwb3NpdG9yeSBpcyBpbXBvcnRlZCwgbm90IGNyZWF0ZWQsIHNvIG5vIEFXUzo6RUNSOjpSZXBvc2l0b3J5IHJlc291cmNlXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5JywgMCk7XG4gICAgICBcbiAgICAgIC8vIFZlcmlmeSByZXBvc2l0b3J5IG91dHB1dHMgYXJlIGF2YWlsYWJsZVxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdSZXBvc2l0b3J5VXJpJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcHJvZHVjdGlvbiBsb2cgcmV0ZW50aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxvZ3M6OkxvZ0dyb3VwJywge1xuICAgICAgICBSZXRlbnRpb25JbkRheXM6IDMwLCAvLyBPbmUgbW9udGggZm9yIHByb2R1Y3Rpb25cbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnUHJvZHVjdGlvbiBFbnZpcm9ubWVudCBGZWF0dXJlcycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRNYXAgbmFtZXNwYWNlIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlNlcnZpY2VEaXNjb3Zlcnk6OlByaXZhdGVEbnNOYW1lc3BhY2UnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXByb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdlbmFibGVzIGRlbGV0aW9uIHByb3RlY3Rpb24gZm9yIEFMQiBpbiBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTG9hZEJhbGFuY2VyQXR0cmlidXRlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBLZXk6ICdkZWxldGlvbl9wcm90ZWN0aW9uLmVuYWJsZWQnLFxuICAgICAgICAgICAgVmFsdWU6ICd0cnVlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaW1wb3J0cyBFQ1IgcmVwb3NpdG9yeSBmb3IgcHJvZHVjdGlvbiAobm8gY3JlYXRpb24pJywgKCkgPT4ge1xuICAgICAgLy8gRUNSIHJlcG9zaXRvcnkgaXMgaW1wb3J0ZWQsIG5vdCBjcmVhdGVkLCBzbyBubyBBV1M6OkVDUjo6UmVwb3NpdG9yeSByZXNvdXJjZVxuICAgICAgLy8gYW5kIG5vIGRlbGV0aW9uIHBvbGljeSBpcyBzZXQgc2luY2Ugd2UgZG9uJ3QgbWFuYWdlIHRoZSByZXBvc2l0b3J5IGxpZmVjeWNsZVxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIDApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnSFRUUFMgYW5kIENlcnRpZmljYXRlIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIFNTTCBjZXJ0aWZpY2F0ZScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpDZXJ0aWZpY2F0ZU1hbmFnZXI6OkNlcnRpZmljYXRlJywge1xuICAgICAgICBEb21haW5OYW1lOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBTdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogWycqLmV4YW1wbGUuY29tJ10sXG4gICAgICAgIFZhbGlkYXRpb25NZXRob2Q6ICdETlMnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEhUVFBTIGxpc3RlbmVyJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6Okxpc3RlbmVyJywge1xuICAgICAgICBQb3J0OiA0NDMsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUFMnLFxuICAgICAgICBDZXJ0aWZpY2F0ZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBDZXJ0aWZpY2F0ZUFybjogeyBSZWY6IE1hdGNoLmFueVZhbHVlKCkgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEhUVFAgdG8gSFRUUFMgcmVkaXJlY3QnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXJSdWxlJywge1xuICAgICAgICBQcmlvcml0eTogMSxcbiAgICAgICAgQ29uZGl0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEZpZWxkOiAncGF0aC1wYXR0ZXJuJyxcbiAgICAgICAgICAgIFBhdGhQYXR0ZXJuQ29uZmlnOiB7XG4gICAgICAgICAgICAgIFZhbHVlczogWycqJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIEFjdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBUeXBlOiAncmVkaXJlY3QnLFxuICAgICAgICAgICAgUmVkaXJlY3RDb25maWc6IHtcbiAgICAgICAgICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgICAgICAgIFBvcnQ6ICc0NDMnLFxuICAgICAgICAgICAgICBTdGF0dXNDb2RlOiAnSFRUUF8zMDEnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFJvdXRlNTMgRE5TIENvbmZpZ3VyYXRpb24gdGVzdHMgcmVtb3ZlZCAtIEROUyByZWNvcmRzIGFyZSBub3cgaGFuZGxlZCBieSBBcHBsaWNhdGlvblN0YWNrXG5cbiAgZGVzY3JpYmUoJ1dBRiBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHA7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBXQUYgV2ViIEFDTCB3aXRoIGNvcmUgcnVsZSBzZXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXRlc3Qtd2ViLWFjbCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnV0FGIGZvciBUZXN0QXBwIHRlc3QgZW52aXJvbm1lbnQnLFxuICAgICAgICBTY29wZTogJ1JFR0lPTkFMJyxcbiAgICAgICAgRGVmYXVsdEFjdGlvbjogeyBBbGxvdzoge30gfSxcbiAgICAgICAgUnVsZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgUHJpb3JpdHk6IDEsXG4gICAgICAgICAgICBPdmVycmlkZUFjdGlvbjogeyBOb25lOiB7fSB9LFxuICAgICAgICAgICAgU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIE1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICBWZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgICBOYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLFxuICAgICAgICAgICAgUHJpb3JpdHk6IDIsXG4gICAgICAgICAgICBPdmVycmlkZUFjdGlvbjogeyBOb25lOiB7fSB9LFxuICAgICAgICAgICAgU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIE1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICBWZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgICBOYW1lOiAnQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAzLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0JyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSksXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIHJhdGUgbGltaXRpbmcgcnVsZScsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBSdWxlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIE5hbWU6ICdSYXRlTGltaXRSdWxlJyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxMCxcbiAgICAgICAgICAgIEFjdGlvbjogeyBCbG9jazoge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBSYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICBMaW1pdDogMTAwMCwgLy8gVGVzdCBlbnZpcm9ubWVudCBsaW1pdFxuICAgICAgICAgICAgICAgIEFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBJUCBzZXQgZm9yIGFsbG93IGxpc3QnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6V0FGdjI6OklQU2V0Jywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LWFsbG93LWxpc3QnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FsbG93ZWQgSVAgYWRkcmVzc2VzIGZvciBoaWdoZXIgcmF0ZSBsaW1pdHMnLFxuICAgICAgICBJUEFkZHJlc3NWZXJzaW9uOiAnSVBWNCcsXG4gICAgICAgIEFkZHJlc3NlczogW10sXG4gICAgICAgIFNjb3BlOiAnUkVHSU9OQUwnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdhc3NvY2lhdGVzIFdBRiB3aXRoIEFMQicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMQXNzb2NpYXRpb24nLCB7XG4gICAgICAgIFJlc291cmNlQXJuOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICBXZWJBQ0xBcm46IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ0FybiddIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ1dBRiBQcm9kdWN0aW9uIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcHJvZHVjdGlvbiByYXRlIGxpbWl0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBSdWxlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIE5hbWU6ICdSYXRlTGltaXRSdWxlJyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxMCxcbiAgICAgICAgICAgIEFjdGlvbjogeyBCbG9jazoge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBSYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICBMaW1pdDogMjAwMCwgLy8gUHJvZHVjdGlvbiBlbnZpcm9ubWVudCBsaW1pdFxuICAgICAgICAgICAgICAgIEFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaW5jbHVkZXMgZ2VvZ3JhcGhpYyByZXN0cmljdGlvbiBmb3IgcHJvZHVjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBSdWxlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIE5hbWU6ICdHZW9SZXN0cmljdGlvblJ1bGUnLFxuICAgICAgICAgICAgUHJpb3JpdHk6IDE1LFxuICAgICAgICAgICAgQWN0aW9uOiB7IEJsb2NrOiB7fSB9LFxuICAgICAgICAgICAgU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIEdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgQ291bnRyeUNvZGVzOiBbJ0NOJywgJ1JVJywgJ0tQJywgJ0lSJ10sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnU3RhY2sgT3V0cHV0cycsICgpID0+IHtcbiAgICBsZXQgc3RhY2s6IEVjc1BsYXRmb3JtU3RhY2s7XG5cbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgIGFwcE5hbWU6ICd0ZXN0YXBwJyxcbiAgICAgICAgaG9zdGVkWm9uZUlkOiAnWjEyMzQ1Njc4OScsXG4gICAgICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1MgY2x1c3RlciBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdDbHVzdGVyQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stQ2x1c3RlckFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0NsdXN0ZXJOYW1lJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUNsdXN0ZXJOYW1lJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEVDUiByZXBvc2l0b3J5IG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1JlcG9zaXRvcnlVcmknLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1SZXBvc2l0b3J5VXJpJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnUmVwb3NpdG9yeUFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLVJlcG9zaXRvcnlBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgTG9hZCBCYWxhbmNlciBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2FkQmFsYW5jZXJBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvYWRCYWxhbmNlckFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2FkQmFsYW5jZXJETlMnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2FkQmFsYW5jZXJab25lSWQnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBIb3N0ZWQgWm9uZSBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stTG9hZEJhbGFuY2VyWm9uZUlkJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGxpc3RlbmVyIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0h0dHBMaXN0ZW5lckFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdIVFRQIExpc3RlbmVyIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stSHR0cExpc3RlbmVyQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnSHR0cHNMaXN0ZW5lckFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdIVFRQUyBMaXN0ZW5lciBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUh0dHBzTGlzdGVuZXJBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgbG9nIGdyb3VwIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvZ0dyb3VwTmFtZScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2dHcm91cE5hbWUnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2dHcm91cEFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvZ0dyb3VwQXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNlcnRpZmljYXRlIG91dHB1dHMgd2hlbiBIVFRQUyBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdDZXJ0aWZpY2F0ZUFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1DZXJ0aWZpY2F0ZUFybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBXQUYgb3V0cHV0cyB3aGVuIFdBRiBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdXQUZXZWJBQ0xBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1XQUZXZWJBQ0xBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdXQUZXZWJBQ0xJZCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stV0FGV2ViQUNMSWQnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIC8vIEFwcGxpY2F0aW9uIFVSTCB0ZXN0IHJlbW92ZWQgLSBBcHBsaWNhdGlvbiBVUkxzIGFyZSBub3cgaGFuZGxlZCBieSBBcHBsaWNhdGlvblN0YWNrXG4gIH0pO1xuXG4gIC8vIEFwcGxpY2F0aW9uIFVSTCB0ZXN0cyByZW1vdmVkIC0gQXBwbGljYXRpb24gVVJMcyBhcmUgbm93IGhhbmRsZWQgYnkgQXBwbGljYXRpb25TdGFja1xuXG4gIGRlc2NyaWJlKCdSZXNvdXJjZSBUYWdnaW5nJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICBob3N0ZWRab25lSWQ6ICdaMTIzNDU2Nzg5JyxcbiAgICAgICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdFQ1MgY2x1c3RlciBoYXMgY29ycmVjdCB0YWdzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6Q2x1c3RlcicsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdFQ1IgcmVwb3NpdG9yeSBpcyBpbXBvcnRlZCAobm8gdGFncyBtYW5hZ2VtZW50KScsICgpID0+IHtcbiAgICAgIC8vIEVDUiByZXBvc2l0b3J5IGlzIGltcG9ydGVkLCBub3QgY3JlYXRlZCwgc28gbm8gQVdTOjpFQ1I6OlJlcG9zaXRvcnkgcmVzb3VyY2VcbiAgICAgIC8vIFRhZ3MgYXJlIG5vdCBtYW5hZ2VkIGJ5IENESyBmb3IgaW1wb3J0ZWQgcmVzb3VyY2VzXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5JywgMCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdMb2FkIEJhbGFuY2VyIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TG9hZEJhbGFuY2VyJywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESycgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0NlcnRpZmljYXRlIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdXQUYgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBUYWdzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESycgfSxcbiAgICAgICAgICB7IEtleTogJ1B1cnBvc2UnLCBWYWx1ZTogJ0REb1MtUHJvdGVjdGlvbicgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0Vycm9yIEhhbmRsaW5nIGFuZCBFZGdlIENhc2VzJywgKCkgPT4ge1xuICAgIHRlc3QoJ2hhbmRsZXMgbWlzc2luZyBkb21haW4gY29uZmlndXJhdGlvbiBncmFjZWZ1bGx5JywgKCkgPT4ge1xuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgICAgbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEh0dHBzVmFsaWRhdGlvbicsIHtcbiAgICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJ10sXG4gICAgICAgICAgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkOiAnc2ctMTIzNDU2NzgnLFxuICAgICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RIdHRwc1ZhbGlkYXRpb24nLFxuICAgICAgICAgIGVudjoge1xuICAgICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgICAvLyBiYXNlRG9tYWluIGFuZCBhcHBOYW1lIGludGVudGlvbmFsbHkgb21pdHRlZCAtIHNob3VsZCB3b3JrIHdpdGhvdXQgSFRUUFNcbiAgICAgICAgfSk7XG4gICAgICB9KS5ub3QudG9UaHJvdygpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndGhyb3dzIGVycm9yIHdoZW4gYmFzZURvbWFpbiBwcm92aWRlZCBidXQgYXBwTmFtZSBtaXNzaW5nJywgKCkgPT4ge1xuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgICAgbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEh0dHBzVmFsaWRhdGlvbjInLCB7XG4gICAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMSddLFxuICAgICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgICBzdGFja05hbWU6ICdUZXN0SHR0cHNWYWxpZGF0aW9uMicsXG4gICAgICAgICAgZW52OiB7XG4gICAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICAgIGJhc2VEb21haW46ICdleGFtcGxlLmNvbScsXG4gICAgICAgICAgLy8gYXBwTmFtZSBpbnRlbnRpb25hbGx5IG9taXR0ZWQgdG8gdGVzdCB2YWxpZGF0aW9uXG4gICAgICAgIH0pO1xuICAgICAgfSkudG9UaHJvdygnQXBwIG5hbWUgaXMgcmVxdWlyZWQgd2hlbiBiYXNlIGRvbWFpbiBpcyBwcm92aWRlZCcpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBhcHBOYW1lIHdpdGhvdXQgYmFzZURvbWFpbiBncmFjZWZ1bGx5JywgKCkgPT4ge1xuICAgICAgZXhwZWN0KCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgICAgbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEh0dHBzVmFsaWRhdGlvbjMnLCB7XG4gICAgICAgICAgZW52aXJvbm1lbnQ6ICd0ZXN0JyxcbiAgICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMSddLFxuICAgICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgICBzdGFja05hbWU6ICdUZXN0SHR0cHNWYWxpZGF0aW9uMycsXG4gICAgICAgICAgZW52OiB7XG4gICAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgICAgfSxcbiAgICAgICAgICAgIGFwcE5hbWU6ICd0ZXN0YXBwJyxcbiAgICAgICAgICAvLyBiYXNlRG9tYWluIGludGVudGlvbmFsbHkgb21pdHRlZCAtIHNob3VsZCB3b3JrIHdpdGhvdXQgSFRUUFNcbiAgICAgICAgfSk7XG4gICAgICB9KS5ub3QudG9UaHJvdygpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBtaXNzaW5nIG9wdGlvbmFsIHBhcmFtZXRlcnMgZ3JhY2VmdWxseScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBtaW5pbWFsUHJvcHMgPSB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMSddLFxuICAgICAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgbWluaW1hbFByb3BzKTtcbiAgICAgIH0pLm5vdC50b1Rocm93KCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIEhUVFBTIHdpdGhvdXQgaG9zdGVkIHpvbmUnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBiYXNlRG9tYWluOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBhcHBOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgIC8vIGhvc3RlZFpvbmVJZCBub3QgcHJvdmlkZWQgLSBzaG91bGQgc3RpbGwgd29ya1xuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFNob3VsZCBzdGlsbCBjcmVhdGUgY2VydGlmaWNhdGUgd2l0aCBETlMgdmFsaWRhdGlvblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNlcnRpZmljYXRlTWFuYWdlcjo6Q2VydGlmaWNhdGUnLCB7XG4gICAgICAgIERvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIFZhbGlkYXRpb25NZXRob2Q6ICdETlMnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdXQUYgZGlzYWJsZWQgYnkgZGVmYXVsdCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6V2ViQUNMQXNzb2NpYXRpb24nLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6SVBTZXQnLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0hUVFBTIGRpc2FibGVkIHdoZW4gbm8gZG9tYWluIGNvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3QgcHJvcHNXaXRob3V0RG9tYWluID0ge1xuICAgICAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgICAgICB2cGNJZDogJ3ZwYy0xMjM0NTY3OCcsXG4gICAgICAgIHB1YmxpY1N1Ym5ldElkczogWydzdWJuZXQtMTExMTExMTEnXSxcbiAgICAgICAgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkOiAnc2ctMTIzNDU2NzgnLFxuICAgICAgICBzdGFja05hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLFxuICAgICAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHByb3BzV2l0aG91dERvbWFpbik7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpDZXJ0aWZpY2F0ZU1hbmFnZXI6OkNlcnRpZmljYXRlJywgMCk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBvbmx5IGhhdmUgSFRUUCBsaXN0ZW5lclxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogODAsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICB9LCAxKTtcbiAgICAgIFxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogNDQzLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgIH0sIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZG9lcyBub3QgY3JlYXRlIEROUyByZWNvcmRzIChoYW5kbGVkIGJ5IEFwcGxpY2F0aW9uU3RhY2spJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMScsICdzdWJuZXQtMjIyMjIyMjInLCAnc3VibmV0LTMzMzMzMzMzJ10sXG4gICAgICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogJ3NnLTEyMzQ1Njc4JyxcbiAgICAgICAgYmFzZURvbWFpbjogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgYXBwTmFtZTogJ3Rlc3RhcHAnLFxuICAgICAgICBob3N0ZWRab25lSWQ6ICdaMTIzNDU2Nzg5JyxcbiAgICAgICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICBhY2NvdW50OiAnMTIzNDU2Nzg5MDEyJyxcbiAgICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFBsYXRmb3JtIHN0YWNrIHNob3VsZCBub3QgY3JlYXRlIEROUyByZWNvcmRzIC0gdGhhdCdzIGhhbmRsZWQgYnkgQXBwbGljYXRpb25TdGFja1xuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OlJvdXRlNTM6OlJlY29yZFNldCcsIDApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnRW52aXJvbm1lbnQtc3BlY2lmaWMgUmVtb3ZhbCBQb2xpY2llcycsICgpID0+IHtcbiAgICB0ZXN0KCdwcm9kdWN0aW9uIGVudmlyb25tZW50IGltcG9ydHMgRUNSIHJlcG9zaXRvcnkgKG5vIGRlbGV0aW9uIHBvbGljeSknLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIEVDUiByZXBvc2l0b3J5IGlzIGltcG9ydGVkLCBub3QgY3JlYXRlZCwgc28gbm8gZGVsZXRpb24gcG9saWN5IGlzIG1hbmFnZWRcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ25vbi1wcm9kdWN0aW9uIGVudmlyb25tZW50IGltcG9ydHMgRUNSIHJlcG9zaXRvcnkgKG5vIGRlbGV0aW9uIHBvbGljeSknLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ2RldicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgLy8gRUNSIHJlcG9zaXRvcnkgaXMgaW1wb3J0ZWQsIG5vdCBjcmVhdGVkLCBzbyBubyBkZWxldGlvbiBwb2xpY3kgaXMgbWFuYWdlZFxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncHJvZHVjdGlvbiBBTEIgaGFzIGRlbGV0aW9uIHByb3RlY3Rpb24gZW5hYmxlZCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTG9hZEJhbGFuY2VyQXR0cmlidXRlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBLZXk6ICdkZWxldGlvbl9wcm90ZWN0aW9uLmVuYWJsZWQnLFxuICAgICAgICAgICAgVmFsdWU6ICd0cnVlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm9uLXByb2R1Y3Rpb24gQUxCIGhhcyBkZWxldGlvbiBwcm90ZWN0aW9uIGRpc2FibGVkJywgKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdkZXYnLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIExvYWRCYWxhbmNlckF0dHJpYnV0ZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAge1xuICAgICAgICAgICAgS2V5OiAnZGVsZXRpb25fcHJvdGVjdGlvbi5lbmFibGVkJyxcbiAgICAgICAgICAgIFZhbHVlOiAnZmFsc2UnLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xufSk7Il19