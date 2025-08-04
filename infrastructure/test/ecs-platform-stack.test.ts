import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EcsPlatformStack } from '../lib/ecs-platform-stack';

describe('EcsPlatformStack', () => {
  let app: cdk.App;
  let template: Template;

  const defaultProps = {
    environment: 'test',
    vpcId: 'vpc-12345678',
    publicSubnetIds: ['subnet-11111111', 'subnet-22222222', 'subnet-33333333'],
    loadBalancerSecurityGroupId: 'sg-12345678',
    domainName: 'example.com',
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
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
      template = Template.fromStack(stack);
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
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'production',
        clusterName: 'custom-cluster',
        repositoryName: 'custom-repo',
      });
      template = Template.fromStack(stack);
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
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);
    });

    test('creates CloudMap namespace for production', () => {
      template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
        Name: 'testapp-production',
      });
    });

    test('enables deletion protection for ALB in production', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
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
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        enableHTTPS: true,
        domainName: 'example.com',
      });
      template = Template.fromStack(stack);
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
            CertificateArn: { Ref: Match.anyValue() },
          },
        ],
      });
    });

    test('creates HTTP to HTTPS redirect', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        DefaultActions: Match.arrayWith([
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

  describe('Route53 DNS Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        domainName: 'example.com',
        hostedZoneId: 'Z123456789',
      });
      template = Template.fromStack(stack);
    });

    test('creates A record for domain', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'A',
        Name: 'example.com.',
        AliasTarget: {
          DNSName: { 'Fn::Join': Match.anyValue() },
          HostedZoneId: { 'Fn::GetAtt': [Match.anyValue(), 'CanonicalHostedZoneID'] },
        },
      });
    });

    test('creates AAAA record for IPv6', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'AAAA',
        Name: 'example.com.',
        AliasTarget: {
          DNSName: { 'Fn::Join': Match.anyValue() },
          HostedZoneId: { 'Fn::GetAtt': [Match.anyValue(), 'CanonicalHostedZoneID'] },
        },
      });
    });
  });

  describe('WAF Configuration', () => {
    beforeEach(() => {
      app = new cdk.App;
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        enableWAF: true,
      });
      template = Template.fromStack(stack);
    });

    test('creates WAF Web ACL with core rule sets', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Name: 'testapp-test-web-acl',
        Description: 'WAF for TestApp test environment',
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
        Rules: Match.arrayWith([
          Match.objectLike({
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
          Match.objectLike({
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
          Match.objectLike({
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
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitRule',
            Priority: 10,
            Action: { Block: {} },
            Statement: {
              RateBasedStatement: {
                Limit: 1000, // Test environment limit
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
        ResourceArn: { Ref: Match.anyValue() },
        WebACLArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
      });
    });
  });

  describe('WAF Production Configuration', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'production',
        enableWAF: true,
      });
      template = Template.fromStack(stack);
    });

    test('uses production rate limits', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitRule',
            Priority: 10,
            Action: { Block: {} },
            Statement: {
              RateBasedStatement: {
                Limit: 2000, // Production environment limit
                AggregateKeyType: 'IP',
              },
            },
          }),
        ]),
      });
    });

    test('includes geographic restriction for production', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
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
    let stack: EcsPlatformStack;

    beforeEach(() => {
      app = new cdk.App();
      stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        enableHTTPS: true,
        domainName: 'example.com',
        enableWAF: true,
      });
      template = Template.fromStack(stack);
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
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
      template = Template.fromStack(stack);
    });

    test('creates application URL with ALB DNS name', () => {
      template.hasOutput('ApplicationUrl', {
        Description: 'Application URL',
      });
    });
  });

  describe('Resource Tagging', () => {
    beforeEach(() => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'production',
        enableHTTPS: true,
        domainName: 'example.com',
        enableWAF: true,
      });
      template = Template.fromStack(stack);
    });

    test('ECS cluster has correct tags', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
          { Key: 'ManagedBy', Value: 'CDK' },
        ]),
      });
    });

    test('ECR repository has correct tags', () => {
      template.hasResourceProperties('AWS::ECR::Repository', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
          { Key: 'ManagedBy', Value: 'CDK' },
        ]),
      });
    });

    test('Load Balancer has correct tags', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
          { Key: 'ManagedBy', Value: 'CDK' },
        ]),
      });
    });

    test('Certificate has correct tags', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
          { Key: 'ManagedBy', Value: 'CDK' },
        ]),
      });
    });

    test('WAF has correct tags', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Tags: Match.arrayWith([
          { Key: 'Environment', Value: 'production' },
          { Key: 'ManagedBy', Value: 'CDK' },
          { Key: 'Purpose', Value: 'DDoS-Protection' },
        ]),
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test.skip('throws error when HTTPS enabled but no domain provided', () => {
      expect(() => {
        const app = new cdk.App();
        new EcsPlatformStack(app, 'TestHttpsValidation', {
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
          // domainName intentionally omitted to test validation
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
        new EcsPlatformStack(app, 'TestEcsPlatformStack', minimalProps);
      }).not.toThrow();
    });

    test('handles HTTPS without hosted zone', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        enableHTTPS: true,
        domainName: 'example.com',
        // hostedZoneId not provided
      });
      template = Template.fromStack(stack);

      // Should still create certificate with DNS validation
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
        ValidationMethod: 'DNS',
      });
    });

    test('WAF disabled by default', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
      template = Template.fromStack(stack);

      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
      template.resourceCountIs('AWS::WAFv2::IPSet', 0);
    });

    test('HTTPS disabled by default', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', defaultProps);
      template = Template.fromStack(stack);

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
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        environment: 'test',
        vpcId: 'vpc-12345678',
        publicSubnetIds: ['subnet-11111111', 'subnet-22222222', 'subnet-33333333'],
        loadBalancerSecurityGroupId: 'sg-12345678',
        domainName: 'example.com',
        // hostedZoneId not provided
        stackName: 'TestEcsPlatformStack',
        env: {
          account: '123456789012',
          region: 'us-east-1',
        },
      });
      template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });
  });

  describe('Environment-specific Removal Policies', () => {
    test('production environment has retain policy for ECR', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);

      template.hasResource('AWS::ECR::Repository', {
        DeletionPolicy: 'Retain',
      });
    });

    test('non-production environment has destroy policy for ECR', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'dev',
      });
      template = Template.fromStack(stack);

      template.hasResource('AWS::ECR::Repository', {
        DeletionPolicy: 'Delete',
      });
    });

    test('production ALB has deletion protection enabled', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'production',
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          {
            Key: 'deletion_protection.enabled',
            Value: 'true',
          },
        ]),
      });
    });

    test('non-production ALB has deletion protection disabled', () => {
      app = new cdk.App();
      const stack = new EcsPlatformStack(app, 'TestEcsPlatformStack', {
        ...defaultProps,
        environment: 'dev',
      });
      template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          {
            Key: 'deletion_protection.enabled',
            Value: 'false',
          },
        ]),
      });
    });
  });
});