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
                CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
                DefaultCapacityProviderStrategy: [
                    {
                        CapacityProvider: 'FARGATE',
                        Weight: 1,
                    },
                    {
                        CapacityProvider: 'FARGATE_SPOT',
                        Weight: 0,
                    },
                ],
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
                            {
                                rulePriority: 2,
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
                IpAddressType: 'ipv4',
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
            template.hasResourceProperties('AWS::ECR::Repository', {
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
                domainName: 'example.com',
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
    describe('Route53 DNS Configuration', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                domainName: 'example.com',
                hostedZoneId: 'Z123456789',
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates A record for domain', () => {
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Type: 'A',
                Name: 'example.com',
                AliasTarget: {
                    DNSName: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'DNSName'] },
                    EvaluateTargetHealth: true,
                    HostedZoneId: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'CanonicalHostedZoneID'] },
                },
            });
        });
        test('creates AAAA record for IPv6', () => {
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Type: 'AAAA',
                Name: 'example.com',
                AliasTarget: {
                    DNSName: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'DNSName'] },
                    EvaluateTargetHealth: true,
                    HostedZoneId: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'CanonicalHostedZoneID'] },
                },
            });
        });
    });
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
                Rules: [
                    {
                        Name: 'AWS-AWSManagedRulesCommonRuleSet',
                        Priority: 1,
                        OverrideAction: { None: {} },
                        Statement: {
                            ManagedRuleGroupStatement: {
                                VendorName: 'AWS',
                                Name: 'AWSManagedRulesCommonRuleSet',
                            },
                        },
                    },
                    {
                        Name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
                        Priority: 2,
                        OverrideAction: { None: {} },
                        Statement: {
                            ManagedRuleGroupStatement: {
                                VendorName: 'AWS',
                                Name: 'AWSManagedRulesKnownBadInputsRuleSet',
                            },
                        },
                    },
                    {
                        Name: 'AWS-AWSManagedRulesSQLiRuleSet',
                        Priority: 3,
                        OverrideAction: { None: {} },
                        Statement: {
                            ManagedRuleGroupStatement: {
                                VendorName: 'AWS',
                                Name: 'AWSManagedRulesSQLiRuleSet',
                            },
                        },
                    },
                ],
            });
        });
        test('creates rate limiting rule', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: assertions_1.Match.arrayWith([
                    {
                        Name: 'RateLimitRule',
                        Priority: 10,
                        Action: { Block: {} },
                        Statement: {
                            RateBasedStatement: {
                                Limit: 1000,
                                AggregateKeyType: 'IP',
                            },
                        },
                    },
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
                    {
                        Name: 'RateLimitRule',
                        Priority: 10,
                        Action: { Block: {} },
                        Statement: {
                            RateBasedStatement: {
                                Limit: 2000,
                                AggregateKeyType: 'IP',
                            },
                        },
                    },
                ]),
            });
        });
        test('includes geographic restriction for production', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: assertions_1.Match.arrayWith([
                    {
                        Name: 'GeoRestrictionRule',
                        Priority: 15,
                        Action: { Block: {} },
                        Statement: {
                            GeoMatchStatement: {
                                CountryCodes: ['CN', 'RU', 'KP', 'IR'],
                            },
                        },
                    },
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
                domainName: 'example.com',
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
        test('creates application URL with custom domain', () => {
            template.hasOutput('ApplicationUrl', {
                Description: 'Application URL',
                Value: 'https://example.com',
            });
        });
    });
    describe('Application URL without Custom Domain', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
            template = assertions_1.Template.fromStack(stack);
        });
        test('creates application URL with ALB DNS name', () => {
            template.hasOutput('ApplicationUrl', {
                Description: 'Application URL',
                Value: {
                    'Fn::Sub': [
                        'http://${albDns}',
                        { albDns: { 'Fn::GetAtt': [assertions_1.Match.anyValue(), 'DNSName'] } },
                    ],
                },
            });
        });
    });
    describe('Resource Tagging', () => {
        beforeEach(() => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                environment: 'production',
                enableHTTPS: true,
                domainName: 'example.com',
                enableWAF: true,
            });
            template = assertions_1.Template.fromStack(stack);
        });
        test('ECS cluster has correct tags', () => {
            template.hasResourceProperties('AWS::ECS::Cluster', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                    { Key: 'Component', Value: 'ECS-Platform' },
                ],
            });
        });
        test('ECR repository has correct tags', () => {
            template.hasResourceProperties('AWS::ECR::Repository', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                    { Key: 'Component', Value: 'Container-Registry' },
                ],
            });
        });
        test('Load Balancer has correct tags', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                    { Key: 'Component', Value: 'Load-Balancer' },
                ],
            });
        });
        test('Certificate has correct tags', () => {
            template.hasResourceProperties('AWS::CertificateManager::Certificate', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                    { Key: 'Component', Value: 'SSL-Certificate' },
                ],
            });
        });
        test('WAF has correct tags', () => {
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Tags: [
                    { Key: 'Environment', Value: 'production' },
                    { Key: 'ManagedBy', Value: 'CDK' },
                    { Key: 'Component', Value: 'WAF' },
                    { Key: 'Purpose', Value: 'DDoS-Protection' },
                ],
            });
        });
    });
    describe('Error Handling and Edge Cases', () => {
        test('throws error when HTTPS enabled but no domain provided', () => {
            app = new cdk.App();
            expect(() => {
                new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                    ...defaultProps,
                    enableHTTPS: true,
                    // domainName not provided
                });
            }).toThrow('Domain name is required when HTTPS is enabled');
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
                domainName: 'example.com',
                // hostedZoneId not provided
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
        test('no DNS records without hosted zone', () => {
            app = new cdk.App();
            const stack = new ecs_platform_stack_1.EcsPlatformStack(app, 'TestEcsPlatformStack', {
                ...defaultProps,
                domainName: 'example.com',
                // hostedZoneId not provided
            });
            template = assertions_1.Template.fromStack(stack);
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
            template.hasResourceProperties('AWS::ECR::Repository', {
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
            template.hasResourceProperties('AWS::ECR::Repository', {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlY3MtcGxhdGZvcm0tc3RhY2sudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG1DQUFtQztBQUNuQyx1REFBeUQ7QUFDekQsa0VBQTZEO0FBRTdELFFBQVEsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7SUFDaEMsSUFBSSxHQUFZLENBQUM7SUFDakIsSUFBSSxRQUFrQixDQUFDO0lBRXZCLE1BQU0sWUFBWSxHQUFHO1FBQ25CLFdBQVcsRUFBRSxNQUFNO1FBQ25CLEtBQUssRUFBRSxjQUFjO1FBQ3JCLGVBQWUsRUFBRSxDQUFDLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixDQUFDO1FBQzFFLDJCQUEyQixFQUFFLGFBQWE7UUFDMUMsU0FBUyxFQUFFLHNCQUFzQjtRQUNqQyxHQUFHLEVBQUU7WUFDSCxPQUFPLEVBQUUsY0FBYztZQUN2QixNQUFNLEVBQUUsV0FBVztTQUNwQjtLQUNGLENBQUM7SUFFRixRQUFRLENBQUMsa0NBQWtDLEVBQUUsR0FBRyxFQUFFO1FBQ2hELFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDZCxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDcEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxxQ0FBZ0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDOUUsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLGdEQUFnRCxFQUFFLEdBQUcsRUFBRTtZQUMxRCxRQUFRLENBQUMscUJBQXFCLENBQUMsbUJBQW1CLEVBQUU7Z0JBQ2xELFdBQVcsRUFBRSxzQkFBc0I7Z0JBQ25DLGlCQUFpQixFQUFFLENBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQztnQkFDOUMsK0JB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QUM5RCxHQUFHLFlBQVk7Z0JBQ2YsV0FBVyxFQUFFLEtBQUs7YUFDbkIsQ0FBQyxDQUFDO1lBQ0gsUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBRXJDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQywyQ0FBMkMsRUFBRTtnQkFDMUUsc0JBQXNCLEVBQUUsa0JBQUssQ0FBQyxTQUFTLENBQUM7b0JBQ3RDO3dCQUNFLEdBQUcsRUFBRSw2QkFBNkI7d0JBQ2xDLEtBQUssRUFBRSxPQUFPO3FCQUNmO2lCQUNGLENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgVGVtcGxhdGUsIE1hdGNoIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBFY3NQbGF0Zm9ybVN0YWNrIH0gZnJvbSAnLi4vbGliL2Vjcy1wbGF0Zm9ybS1zdGFjayc7XG5cbmRlc2NyaWJlKCdFY3NQbGF0Zm9ybVN0YWNrJywgKCkgPT4ge1xuICBsZXQgYXBwOiBjZGsuQXBwO1xuICBsZXQgdGVtcGxhdGU6IFRlbXBsYXRlO1xuXG4gIGNvbnN0IGRlZmF1bHRQcm9wcyA9IHtcbiAgICBlbnZpcm9ubWVudDogJ3Rlc3QnLFxuICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICBwdWJsaWNTdWJuZXRJZHM6IFsnc3VibmV0LTExMTExMTExJywgJ3N1Ym5ldC0yMjIyMjIyMicsICdzdWJuZXQtMzMzMzMzMzMnXSxcbiAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgc3RhY2tOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLFxuICAgIGVudjoge1xuICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgIH0sXG4gIH07XG5cbiAgZGVzY3JpYmUoJ0Jhc2ljIEVDUyBQbGF0Zm9ybSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCBkZWZhdWx0UHJvcHMpO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1MgY2x1c3RlciB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1M6OkNsdXN0ZXInLCB7XG4gICAgICAgIENsdXN0ZXJOYW1lOiAndGVzdGFwcC1jbHVzdGVyLXRlc3QnLFxuICAgICAgICBDYXBhY2l0eVByb3ZpZGVyczogWydGQVJHQVRFJywgJ0ZBUkdBVEVfU1BPVCddLFxuICAgICAgICBEZWZhdWx0Q2FwYWNpdHlQcm92aWRlclN0cmF0ZWd5OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2FwYWNpdHlQcm92aWRlcjogJ0ZBUkdBVEUnLFxuICAgICAgICAgICAgV2VpZ2h0OiAxLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2FwYWNpdHlQcm92aWRlcjogJ0ZBUkdBVEVfU1BPVCcsXG4gICAgICAgICAgICBXZWlnaHQ6IDAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1IgcmVwb3NpdG9yeSB3aXRoIGNvcnJlY3QgY29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFQ1I6OlJlcG9zaXRvcnknLCB7XG4gICAgICAgIFJlcG9zaXRvcnlOYW1lOiAndGVzdGFwcC10ZXN0JyxcbiAgICAgICAgSW1hZ2VTY2FubmluZ0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBJbWFnZVRhZ011dGFiaWxpdHk6ICdNVVRBQkxFJyxcbiAgICAgICAgTGlmZWN5Y2xlUG9saWN5OiB7XG4gICAgICAgICAgTGlmZWN5Y2xlUG9saWN5VGV4dDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLFxuICAgICAgICAgICAgICAgIHNlbGVjdGlvbjoge1xuICAgICAgICAgICAgICAgICAgdGFnU3RhdHVzOiAnYW55JyxcbiAgICAgICAgICAgICAgICAgIGNvdW50VHlwZTogJ2ltYWdlQ291bnRNb3JlVGhhbicsXG4gICAgICAgICAgICAgICAgICBjb3VudE51bWJlcjogMTAsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBhY3Rpb246IHtcbiAgICAgICAgICAgICAgICAgIHR5cGU6ICdleHBpcmUnLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBydWxlUHJpb3JpdHk6IDIsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdEZWxldGUgdW50YWdnZWQgaW1hZ2VzIGFmdGVyIDEgZGF5JyxcbiAgICAgICAgICAgICAgICBzZWxlY3Rpb246IHtcbiAgICAgICAgICAgICAgICAgIHRhZ1N0YXR1czogJ3VudGFnZ2VkJyxcbiAgICAgICAgICAgICAgICAgIGNvdW50VHlwZTogJ3NpbmNlSW1hZ2VQdXNoZWQnLFxuICAgICAgICAgICAgICAgICAgY291bnROdW1iZXI6IDEsXG4gICAgICAgICAgICAgICAgICBjb3VudFVuaXQ6ICdkYXlzJyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGFjdGlvbjoge1xuICAgICAgICAgICAgICAgICAgdHlwZTogJ2V4cGlyZScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlcicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLWFsYi10ZXN0JyxcbiAgICAgICAgU2NoZW1lOiAnaW50ZXJuZXQtZmFjaW5nJyxcbiAgICAgICAgVHlwZTogJ2FwcGxpY2F0aW9uJyxcbiAgICAgICAgSXBBZGRyZXNzVHlwZTogJ2lwdjQnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEhUVFAgbGlzdGVuZXIgd2l0aCBkZWZhdWx0IGFjdGlvbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogODAsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICAgIERlZmF1bHRBY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgVHlwZTogJ2ZpeGVkLXJlc3BvbnNlJyxcbiAgICAgICAgICAgIEZpeGVkUmVzcG9uc2VDb25maWc6IHtcbiAgICAgICAgICAgICAgU3RhdHVzQ29kZTogJzUwMycsXG4gICAgICAgICAgICAgIENvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgICAgICAgIE1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRXYXRjaCBsb2cgZ3JvdXAnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6TG9nczo6TG9nR3JvdXAnLCB7XG4gICAgICAgIExvZ0dyb3VwTmFtZTogJy9hd3MvZWNzL3Rlc3RhcHAtdGVzdCcsXG4gICAgICAgIFJldGVudGlvbkluRGF5czogNywgLy8gT25lIHdlZWsgZm9yIHRlc3QgZW52aXJvbm1lbnRcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ3VzdG9tIENvbmZpZ3VyYXRpb24nLCAoKSA9PiB7XG4gICAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgICBjbHVzdGVyTmFtZTogJ2N1c3RvbS1jbHVzdGVyJyxcbiAgICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjdXN0b20tcmVwbycsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgY2x1c3RlciB3aXRoIGN1c3RvbSBuYW1lJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUzo6Q2x1c3RlcicsIHtcbiAgICAgICAgQ2x1c3Rlck5hbWU6ICdjdXN0b20tY2x1c3RlcicsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcmVwb3NpdG9yeSB3aXRoIGN1c3RvbSBuYW1lJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgICAgUmVwb3NpdG9yeU5hbWU6ICdjdXN0b20tcmVwbycsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZXMgcHJvZHVjdGlvbiBsb2cgcmV0ZW50aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxvZ3M6OkxvZ0dyb3VwJywge1xuICAgICAgICBSZXRlbnRpb25JbkRheXM6IDMwLCAvLyBPbmUgbW9udGggZm9yIHByb2R1Y3Rpb25cbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnUHJvZHVjdGlvbiBFbnZpcm9ubWVudCBGZWF0dXJlcycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQ2xvdWRNYXAgbmFtZXNwYWNlIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OlNlcnZpY2VEaXNjb3Zlcnk6OlByaXZhdGVEbnNOYW1lc3BhY2UnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXByb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdlbmFibGVzIGRlbGV0aW9uIHByb3RlY3Rpb24gZm9yIEFMQiBpbiBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVsYXN0aWNMb2FkQmFsYW5jaW5nVjI6OkxvYWRCYWxhbmNlcicsIHtcbiAgICAgICAgTG9hZEJhbGFuY2VyQXR0cmlidXRlczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBLZXk6ICdkZWxldGlvbl9wcm90ZWN0aW9uLmVuYWJsZWQnLFxuICAgICAgICAgICAgVmFsdWU6ICd0cnVlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFzIHJldGFpbiByZW1vdmFsIHBvbGljeSBmb3IgRUNSIGluIHByb2R1Y3Rpb24nLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgICBEZWxldGlvblBvbGljeTogJ1JldGFpbicsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0hUVFBTIGFuZCBDZXJ0aWZpY2F0ZSBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW5hYmxlSFRUUFM6IHRydWUsXG4gICAgICAgIGRvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgU1NMIGNlcnRpZmljYXRlJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNlcnRpZmljYXRlTWFuYWdlcjo6Q2VydGlmaWNhdGUnLCB7XG4gICAgICAgIERvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIFN1YmplY3RBbHRlcm5hdGl2ZU5hbWVzOiBbJyouZXhhbXBsZS5jb20nXSxcbiAgICAgICAgVmFsaWRhdGlvbk1ldGhvZDogJ0ROUycsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgSFRUUFMgbGlzdGVuZXInLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TGlzdGVuZXInLCB7XG4gICAgICAgIFBvcnQ6IDQ0MyxcbiAgICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgIENlcnRpZmljYXRlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIENlcnRpZmljYXRlQXJuOiB7IFJlZjogTWF0Y2guYW55VmFsdWUoKSB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgSFRUUCB0byBIVFRQUyByZWRpcmVjdCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIEFjdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBUeXBlOiAncmVkaXJlY3QnLFxuICAgICAgICAgICAgUmVkaXJlY3RDb25maWc6IHtcbiAgICAgICAgICAgICAgUHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgICAgICAgIFBvcnQ6ICc0NDMnLFxuICAgICAgICAgICAgICBTdGF0dXNDb2RlOiAnSFRUUF8zMDEnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdSb3V0ZTUzIEROUyBDb25maWd1cmF0aW9uJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIGNvbnN0IHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgaG9zdGVkWm9uZUlkOiAnWjEyMzQ1Njc4OScsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQSByZWNvcmQgZm9yIGRvbWFpbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpSb3V0ZTUzOjpSZWNvcmRTZXQnLCB7XG4gICAgICAgIFR5cGU6ICdBJyxcbiAgICAgICAgTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgQWxpYXNUYXJnZXQ6IHtcbiAgICAgICAgICBETlNOYW1lOiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdETlNOYW1lJ10gfSxcbiAgICAgICAgICBFdmFsdWF0ZVRhcmdldEhlYWx0aDogdHJ1ZSxcbiAgICAgICAgICBIb3N0ZWRab25lSWQ6IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ0Nhbm9uaWNhbEhvc3RlZFpvbmVJRCddIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgQUFBQSByZWNvcmQgZm9yIElQdjYnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Um91dGU1Mzo6UmVjb3JkU2V0Jywge1xuICAgICAgICBUeXBlOiAnQUFBQScsXG4gICAgICAgIE5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIEFsaWFzVGFyZ2V0OiB7XG4gICAgICAgICAgRE5TTmFtZTogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnRE5TTmFtZSddIH0sXG4gICAgICAgICAgRXZhbHVhdGVUYXJnZXRIZWFsdGg6IHRydWUsXG4gICAgICAgICAgSG9zdGVkWm9uZUlkOiB7ICdGbjo6R2V0QXR0JzogW01hdGNoLmFueVZhbHVlKCksICdDYW5vbmljYWxIb3N0ZWRab25lSUQnXSB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdXQUYgQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgV0FGIFdlYiBBQ0wgd2l0aCBjb3JlIHJ1bGUgc2V0cycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBOYW1lOiAndGVzdGFwcC10ZXN0LXdlYi1hY2wnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ1dBRiBmb3IgVGVzdEFwcCB0ZXN0IGVudmlyb25tZW50JyxcbiAgICAgICAgU2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICAgIERlZmF1bHRBY3Rpb246IHsgQWxsb3c6IHt9IH0sXG4gICAgICAgIFJ1bGVzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAyLFxuICAgICAgICAgICAgT3ZlcnJpZGVBY3Rpb246IHsgTm9uZToge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBNYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgVmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgICAgTmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgTmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICBQcmlvcml0eTogMyxcbiAgICAgICAgICAgIE92ZXJyaWRlQWN0aW9uOiB7IE5vbmU6IHt9IH0sXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgTWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICAgIFZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICAgIE5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgcmF0ZSBsaW1pdGluZyBydWxlJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCB7XG4gICAgICAgIFJ1bGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICdSYXRlTGltaXRSdWxlJyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxMCxcbiAgICAgICAgICAgIEFjdGlvbjogeyBCbG9jazoge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBSYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICBMaW1pdDogMTAwMCwgLy8gVGVzdCBlbnZpcm9ubWVudCBsaW1pdFxuICAgICAgICAgICAgICAgIEFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIElQIHNldCBmb3IgYWxsb3cgbGlzdCcsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6SVBTZXQnLCB7XG4gICAgICAgIE5hbWU6ICd0ZXN0YXBwLXRlc3QtYWxsb3ctbGlzdCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQWxsb3dlZCBJUCBhZGRyZXNzZXMgZm9yIGhpZ2hlciByYXRlIGxpbWl0cycsXG4gICAgICAgIElQQWRkcmVzc1ZlcnNpb246ICdJUFY0JyxcbiAgICAgICAgQWRkcmVzc2VzOiBbXSxcbiAgICAgICAgU2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2Fzc29jaWF0ZXMgV0FGIHdpdGggQUxCJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0xBc3NvY2lhdGlvbicsIHtcbiAgICAgICAgUmVzb3VyY2VBcm46IHsgUmVmOiBNYXRjaC5hbnlWYWx1ZSgpIH0sXG4gICAgICAgIFdlYkFDTEFybjogeyAnRm46OkdldEF0dCc6IFtNYXRjaC5hbnlWYWx1ZSgpLCAnQXJuJ10gfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnV0FGIFByb2R1Y3Rpb24gQ29uZmlndXJhdGlvbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBwcm9kdWN0aW9uIHJhdGUgbGltaXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCB7XG4gICAgICAgIFJ1bGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICdSYXRlTGltaXRSdWxlJyxcbiAgICAgICAgICAgIFByaW9yaXR5OiAxMCxcbiAgICAgICAgICAgIEFjdGlvbjogeyBCbG9jazoge30gfSxcbiAgICAgICAgICAgIFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBSYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICBMaW1pdDogMjAwMCwgLy8gUHJvZHVjdGlvbiBlbnZpcm9ubWVudCBsaW1pdFxuICAgICAgICAgICAgICAgIEFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdpbmNsdWRlcyBnZW9ncmFwaGljIHJlc3RyaWN0aW9uIGZvciBwcm9kdWN0aW9uJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCB7XG4gICAgICAgIFJ1bGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICdHZW9SZXN0cmljdGlvblJ1bGUnLFxuICAgICAgICAgICAgUHJpb3JpdHk6IDE1LFxuICAgICAgICAgICAgQWN0aW9uOiB7IEJsb2NrOiB7fSB9LFxuICAgICAgICAgICAgU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIEdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgQ291bnRyeUNvZGVzOiBbJ0NOJywgJ1JVJywgJ0tQJywgJ0lSJ10sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0pLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdTdGFjayBPdXRwdXRzJywgKCkgPT4ge1xuICAgIGxldCBzdGFjazogRWNzUGxhdGZvcm1TdGFjaztcblxuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgYXBwID0gbmV3IGNkay5BcHAoKTtcbiAgICAgIHN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCAnVGVzdEVjc1BsYXRmb3JtU3RhY2snLCB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgZW5hYmxlSFRUUFM6IHRydWUsXG4gICAgICAgIGRvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBFQ1MgY2x1c3RlciBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdDbHVzdGVyQXJuJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stQ2x1c3RlckFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0NsdXN0ZXJOYW1lJywge1xuICAgICAgICBEZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUNsdXN0ZXJOYW1lJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIEVDUiByZXBvc2l0b3J5IG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ1JlcG9zaXRvcnlVcmknLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1SZXBvc2l0b3J5VXJpJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnUmVwb3NpdG9yeUFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLVJlcG9zaXRvcnlBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgTG9hZCBCYWxhbmNlciBvdXRwdXRzJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2FkQmFsYW5jZXJBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvYWRCYWxhbmNlckFybicgfSxcbiAgICAgIH0pO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2FkQmFsYW5jZXJETlMnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2FkQmFsYW5jZXJab25lSWQnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBIb3N0ZWQgWm9uZSBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stTG9hZEJhbGFuY2VyWm9uZUlkJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGxpc3RlbmVyIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0h0dHBMaXN0ZW5lckFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdIVFRQIExpc3RlbmVyIEFSTicsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stSHR0cExpc3RlbmVyQXJuJyB9LFxuICAgICAgfSk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnSHR0cHNMaXN0ZW5lckFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdIVFRQUyBMaXN0ZW5lciBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUh0dHBzTGlzdGVuZXJBcm4nIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgbG9nIGdyb3VwIG91dHB1dHMnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNPdXRwdXQoJ0xvZ0dyb3VwTmFtZScsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBOYW1lJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1Mb2dHcm91cE5hbWUnIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdMb2dHcm91cEFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBBUk4nLFxuICAgICAgICBFeHBvcnQ6IHsgTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrLUxvZ0dyb3VwQXJuJyB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjcmVhdGVzIGNlcnRpZmljYXRlIG91dHB1dHMgd2hlbiBIVFRQUyBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdDZXJ0aWZpY2F0ZUFybicsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1DZXJ0aWZpY2F0ZUFybicgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY3JlYXRlcyBXQUYgb3V0cHV0cyB3aGVuIFdBRiBlbmFibGVkJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdXQUZXZWJBQ0xBcm4nLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgQVJOJyxcbiAgICAgICAgRXhwb3J0OiB7IE5hbWU6ICdUZXN0RWNzUGxhdGZvcm1TdGFjay1XQUZXZWJBQ0xBcm4nIH0sXG4gICAgICB9KTtcblxuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdXQUZXZWJBQ0xJZCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBJRCcsXG4gICAgICAgIEV4cG9ydDogeyBOYW1lOiAnVGVzdEVjc1BsYXRmb3JtU3RhY2stV0FGV2ViQUNMSWQnIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYXBwbGljYXRpb24gVVJMIHdpdGggY3VzdG9tIGRvbWFpbicsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc091dHB1dCgnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICAgIERlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMJyxcbiAgICAgICAgVmFsdWU6ICdodHRwczovL2V4YW1wbGUuY29tJyxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQXBwbGljYXRpb24gVVJMIHdpdGhvdXQgQ3VzdG9tIERvbWFpbicsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NyZWF0ZXMgYXBwbGljYXRpb24gVVJMIHdpdGggQUxCIEROUyBuYW1lJywgKCkgPT4ge1xuICAgICAgdGVtcGxhdGUuaGFzT3V0cHV0KCdBcHBsaWNhdGlvblVybCcsIHtcbiAgICAgICAgRGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBVUkwnLFxuICAgICAgICBWYWx1ZToge1xuICAgICAgICAgICdGbjo6U3ViJzogW1xuICAgICAgICAgICAgJ2h0dHA6Ly8ke2FsYkRuc30nLFxuICAgICAgICAgICAgeyBhbGJEbnM6IHsgJ0ZuOjpHZXRBdHQnOiBbTWF0Y2guYW55VmFsdWUoKSwgJ0ROU05hbWUnXSB9IH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnUmVzb3VyY2UgVGFnZ2luZycsICgpID0+IHtcbiAgICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICAgIGVuYWJsZUhUVFBTOiB0cnVlLFxuICAgICAgICBkb21haW5OYW1lOiAnZXhhbXBsZS5jb20nLFxuICAgICAgICBlbmFibGVXQUY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0VDUyBjbHVzdGVyIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNTOjpDbHVzdGVyJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ01hbmFnZWRCeScsIFZhbHVlOiAnQ0RLJyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdFQ1MtUGxhdGZvcm0nIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0VDUiByZXBvc2l0b3J5IGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ01hbmFnZWRCeScsIFZhbHVlOiAnQ0RLJyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdDb250YWluZXItUmVnaXN0cnknIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0xvYWQgQmFsYW5jZXIgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIFRhZ3M6IFtcbiAgICAgICAgICB7IEtleTogJ0Vudmlyb25tZW50JywgVmFsdWU6ICdwcm9kdWN0aW9uJyB9LFxuICAgICAgICAgIHsgS2V5OiAnTWFuYWdlZEJ5JywgVmFsdWU6ICdDREsnIH0sXG4gICAgICAgICAgeyBLZXk6ICdDb21wb25lbnQnLCBWYWx1ZTogJ0xvYWQtQmFsYW5jZXInIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0NlcnRpZmljYXRlIGhhcyBjb3JyZWN0IHRhZ3MnLCAoKSA9PiB7XG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6Q2VydGlmaWNhdGVNYW5hZ2VyOjpDZXJ0aWZpY2F0ZScsIHtcbiAgICAgICAgVGFnczogW1xuICAgICAgICAgIHsgS2V5OiAnRW52aXJvbm1lbnQnLCBWYWx1ZTogJ3Byb2R1Y3Rpb24nIH0sXG4gICAgICAgICAgeyBLZXk6ICdNYW5hZ2VkQnknLCBWYWx1ZTogJ0NESycgfSxcbiAgICAgICAgICB7IEtleTogJ0NvbXBvbmVudCcsIFZhbHVlOiAnU1NMLUNlcnRpZmljYXRlJyB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdXQUYgaGFzIGNvcnJlY3QgdGFncycsICgpID0+IHtcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpXQUZ2Mjo6V2ViQUNMJywge1xuICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgeyBLZXk6ICdFbnZpcm9ubWVudCcsIFZhbHVlOiAncHJvZHVjdGlvbicgfSxcbiAgICAgICAgICB7IEtleTogJ01hbmFnZWRCeScsIFZhbHVlOiAnQ0RLJyB9LFxuICAgICAgICAgIHsgS2V5OiAnQ29tcG9uZW50JywgVmFsdWU6ICdXQUYnIH0sXG4gICAgICAgICAgeyBLZXk6ICdQdXJwb3NlJywgVmFsdWU6ICdERG9TLVByb3RlY3Rpb24nIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0Vycm9yIEhhbmRsaW5nIGFuZCBFZGdlIENhc2VzJywgKCkgPT4ge1xuICAgIHRlc3QoJ3Rocm93cyBlcnJvciB3aGVuIEhUVFBTIGVuYWJsZWQgYnV0IG5vIGRvbWFpbiBwcm92aWRlZCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgICAgICAvLyBkb21haW5OYW1lIG5vdCBwcm92aWRlZFxuICAgICAgICB9KTtcbiAgICAgIH0pLnRvVGhyb3coJ0RvbWFpbiBuYW1lIGlzIHJlcXVpcmVkIHdoZW4gSFRUUFMgaXMgZW5hYmxlZCcpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnaGFuZGxlcyBtaXNzaW5nIG9wdGlvbmFsIHBhcmFtZXRlcnMgZ3JhY2VmdWxseScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBtaW5pbWFsUHJvcHMgPSB7XG4gICAgICAgIGVudmlyb25tZW50OiAndGVzdCcsXG4gICAgICAgIHZwY0lkOiAndnBjLTEyMzQ1Njc4JyxcbiAgICAgICAgcHVibGljU3VibmV0SWRzOiBbJ3N1Ym5ldC0xMTExMTExMSddLFxuICAgICAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6ICdzZy0xMjM0NTY3OCcsXG4gICAgICAgIHN0YWNrTmFtZTogJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJyxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgYWNjb3VudDogJzEyMzQ1Njc4OTAxMicsXG4gICAgICAgICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgICBcbiAgICAgIGV4cGVjdCgoKSA9PiB7XG4gICAgICAgIG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgbWluaW1hbFByb3BzKTtcbiAgICAgIH0pLm5vdC50b1Rocm93KCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdoYW5kbGVzIEhUVFBTIHdpdGhvdXQgaG9zdGVkIHpvbmUnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbmFibGVIVFRQUzogdHJ1ZSxcbiAgICAgICAgZG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICAgICAgLy8gaG9zdGVkWm9uZUlkIG5vdCBwcm92aWRlZFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIC8vIFNob3VsZCBzdGlsbCBjcmVhdGUgY2VydGlmaWNhdGUgd2l0aCBETlMgdmFsaWRhdGlvblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkNlcnRpZmljYXRlTWFuYWdlcjo6Q2VydGlmaWNhdGUnLCB7XG4gICAgICAgIERvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIFZhbGlkYXRpb25NZXRob2Q6ICdETlMnLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdXQUYgZGlzYWJsZWQgYnkgZGVmYXVsdCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywgZGVmYXVsdFByb3BzKTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OldBRnYyOjpXZWJBQ0wnLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6V2ViQUNMQXNzb2NpYXRpb24nLCAwKTtcbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpXQUZ2Mjo6SVBTZXQnLCAwKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ0hUVFBTIGRpc2FibGVkIGJ5IGRlZmF1bHQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIGRlZmF1bHRQcm9wcyk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLnJlc291cmNlQ291bnRJcygnQVdTOjpDZXJ0aWZpY2F0ZU1hbmFnZXI6OkNlcnRpZmljYXRlJywgMCk7XG4gICAgICBcbiAgICAgIC8vIFNob3VsZCBvbmx5IGhhdmUgSFRUUCBsaXN0ZW5lclxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogODAsXG4gICAgICAgIFByb3RvY29sOiAnSFRUUCcsXG4gICAgICB9LCAxKTtcbiAgICAgIFxuICAgICAgdGVtcGxhdGUucmVzb3VyY2VQcm9wZXJ0aWVzQ291bnRJcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMaXN0ZW5lcicsIHtcbiAgICAgICAgUG9ydDogNDQzLFxuICAgICAgICBQcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgIH0sIDApO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnbm8gRE5TIHJlY29yZHMgd2l0aG91dCBob3N0ZWQgem9uZScsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGRvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgICAgIC8vIGhvc3RlZFpvbmVJZCBub3QgcHJvdmlkZWRcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6Um91dGU1Mzo6UmVjb3JkU2V0JywgMCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFbnZpcm9ubWVudC1zcGVjaWZpYyBSZW1vdmFsIFBvbGljaWVzJywgKCkgPT4ge1xuICAgIHRlc3QoJ3Byb2R1Y3Rpb24gZW52aXJvbm1lbnQgaGFzIHJldGFpbiBwb2xpY3kgZm9yIEVDUicsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgICB9KTtcbiAgICAgIHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcblxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkVDUjo6UmVwb3NpdG9yeScsIHtcbiAgICAgICAgRGVsZXRpb25Qb2xpY3k6ICdSZXRhaW4nLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdub24tcHJvZHVjdGlvbiBlbnZpcm9ubWVudCBoYXMgZGVzdHJveSBwb2xpY3kgZm9yIEVDUicsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RUNSOjpSZXBvc2l0b3J5Jywge1xuICAgICAgICBEZWxldGlvblBvbGljeTogJ0RlbGV0ZScsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3Byb2R1Y3Rpb24gQUxCIGhhcyBkZWxldGlvbiBwcm90ZWN0aW9uIGVuYWJsZWQnLCAoKSA9PiB7XG4gICAgICBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgICAgY29uc3Qgc3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsICdUZXN0RWNzUGxhdGZvcm1TdGFjaycsIHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICBlbnZpcm9ubWVudDogJ3Byb2R1Y3Rpb24nLFxuICAgICAgfSk7XG4gICAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG5cbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpFbGFzdGljTG9hZEJhbGFuY2luZ1YyOjpMb2FkQmFsYW5jZXInLCB7XG4gICAgICAgIExvYWRCYWxhbmNlckF0dHJpYnV0ZXM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAge1xuICAgICAgICAgICAgS2V5OiAnZGVsZXRpb25fcHJvdGVjdGlvbi5lbmFibGVkJyxcbiAgICAgICAgICAgIFZhbHVlOiAndHJ1ZScsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ25vbi1wcm9kdWN0aW9uIEFMQiBoYXMgZGVsZXRpb24gcHJvdGVjdGlvbiBkaXNhYmxlZCcsICgpID0+IHtcbiAgICAgIGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gICAgICBjb25zdCBzdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgJ1Rlc3RFY3NQbGF0Zm9ybVN0YWNrJywge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIGVudmlyb25tZW50OiAnZGV2JyxcbiAgICAgIH0pO1xuICAgICAgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6RWxhc3RpY0xvYWRCYWxhbmNpbmdWMjo6TG9hZEJhbGFuY2VyJywge1xuICAgICAgICBMb2FkQmFsYW5jZXJBdHRyaWJ1dGVzOiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEtleTogJ2RlbGV0aW9uX3Byb3RlY3Rpb24uZW5hYmxlZCcsXG4gICAgICAgICAgICBWYWx1ZTogJ2ZhbHNlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcbn0pOyJdfQ==