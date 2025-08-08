import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface EcsPlatformStackProps extends cdk.StackProps {
  environment: string;
  // VPC configuration
  vpcId: string;
  publicSubnetIds: string[];
  loadBalancerSecurityGroupId: string;
  // Platform configuration
  clusterName?: string;
  repositoryName?: string;
  // Security enhancements
  enableWAF?: boolean;
  certificateArn?: string;
  hostedZoneId?: string;
  baseDomain?: string;
  appName?: string;
}

export class EcsPlatformStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly repository: ecr.IRepository;
  public readonly loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;
  public readonly httpListener: elasticloadbalancingv2.ApplicationListener;
  public readonly httpsListener?: elasticloadbalancingv2.ApplicationListener;
  public readonly certificate?: certificatemanager.ICertificate;
  public readonly webACL?: wafv2.CfnWebACL;
  public readonly logGroup: logs.LogGroup;
  public readonly hostedZone?: route53.IHostedZone;


  constructor(scope: Construct, id: string, props: EcsPlatformStackProps) {
    super(scope, id, props);

    // Validate configuration for domain-based HTTPS
    if (props.baseDomain && !props.appName) {
      throw new Error('App name is required when base domain is provided');
    }

    // Import VPC and subnets
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.vpcId,
      availabilityZones: cdk.Fn.getAzs(),
      publicSubnetIds: props.publicSubnetIds,
    });

    // Import Load Balancer Security Group
    const loadBalancerSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'ImportedLoadBalancerSecurityGroup',
      props.loadBalancerSecurityGroupId
    );

    // Create CloudWatch Log Group for the cluster
    this.logGroup = this.createLogGroup(props);

    // Create ECS Cluster
    this.cluster = this.createEcsCluster(props, vpc);

    // Create ECR Repository
    this.repository = this.createEcrRepository(props);

    // Create Route53 Hosted Zone (if domain provided)
    if (props.baseDomain && props.hostedZoneId) {
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.baseDomain, // Use base domain for hosted zone
      });
    }

    // Create SSL certificate (if domain provided)
    if (props.baseDomain) {
      this.certificate = this.createCertificate(props);
    }

    // Create Application Load Balancer
    this.loadBalancer = this.createApplicationLoadBalancer(props, vpc, loadBalancerSecurityGroup);

    // Create listeners - HTTPS is mandatory, HTTP redirects to HTTPS
    this.httpListener = this.createHttpListener();
    
    // Always try to create HTTPS listener
    if (this.certificate) {
      // Use custom certificate for production with domain
      this.httpsListener = this.createHttpsListener();
      this.addHttpToHttpsRedirect();
    } else {
      // Try to create HTTPS listener with imported certificate
      try {
        this.httpsListener = this.createHttpsListenerWithImportedCert(props);
        this.addHttpToHttpsRedirect();
      } catch (error) {
        console.warn(`⚠️  HTTPS listener not created: ${error}`);
        console.warn(`   Application will be available on HTTP only temporarily.`);
        console.warn(`   For production-ready deployment, provide a certificate ARN via context or configure baseDomain.`);
      }
    }

    // Note: Route53 DNS records are now managed by ApplicationStack

    // Create WAF (if enabled)
    if (props.enableWAF) {
      this.webACL = this.createWAF(props);
      this.associateWAFWithALB();
    }

    // Create stack outputs
    this.createOutputs(props);
  }

  private createLogGroup(props: EcsPlatformStackProps): logs.LogGroup {
    return new logs.LogGroup(this, 'EcsLogGroup', {
      logGroupName: `/aws/ecs/testapp-${props.environment}`,
      retention: props.environment === 'production' 
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createEcsCluster(props: EcsPlatformStackProps, vpc: ec2.IVpc): ecs.Cluster {
    const clusterName = props.clusterName || `testapp-cluster-${props.environment}`;
    
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName,
      enableFargateCapacityProviders: true,
    });

    // Add container insights if production
    if (props.environment === 'production') {
      cluster.addDefaultCloudMapNamespace({
        name: `testapp-${props.environment}`,
      });
    }

    // Add tags
    cdk.Tags.of(cluster).add('Environment', props.environment);
    cdk.Tags.of(cluster).add('ManagedBy', 'CDK');
    cdk.Tags.of(cluster).add('Component', 'ECS-Platform');

    return cluster;
  }

  private createEcrRepository(props: EcsPlatformStackProps): ecr.IRepository {
    const repositoryName = props.repositoryName || 'testapp';
    
    // Import existing ECR repository instead of creating a new one
    const repository = ecr.Repository.fromRepositoryName(
      this, 'EcrRepository',
      repositoryName
    );
    
    // Note: Lifecycle rules and other settings must be configured manually
    // for imported repositories or through a separate stack
    return repository;
  }

  private createCertificate(props: EcsPlatformStackProps): certificatemanager.ICertificate {
    // baseDomain is guaranteed to exist due to constructor validation
    if (!props.baseDomain) {
      throw new Error('Base domain is required for certificate creation');
    }
    
    const certificate = new certificatemanager.Certificate(this, 'SSLCertificate', {
      domainName: props.baseDomain,
      subjectAlternativeNames: [`*.${props.baseDomain}`],
      validation: this.hostedZone 
        ? certificatemanager.CertificateValidation.fromDns(this.hostedZone)
        : certificatemanager.CertificateValidation.fromDns(),
    });

    // Add tags
    cdk.Tags.of(certificate).add('Environment', props.environment);
    cdk.Tags.of(certificate).add('ManagedBy', 'CDK');
    cdk.Tags.of(certificate).add('Component', 'SSL-Certificate');

    return certificate;
  }

  private createApplicationLoadBalancer(
    props: EcsPlatformStackProps, 
    vpc: ec2.IVpc, 
    securityGroup: ec2.ISecurityGroup
  ): elasticloadbalancingv2.ApplicationLoadBalancer {
    const alb = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup,
      loadBalancerName: `testapp-alb-${props.environment}`,
      deletionProtection: props.environment === 'production',
    });

    // Add tags
    cdk.Tags.of(alb).add('Environment', props.environment);
    cdk.Tags.of(alb).add('ManagedBy', 'CDK');
    cdk.Tags.of(alb).add('Component', 'Load-Balancer');

    return alb;
  }

  private createHttpListener(): elasticloadbalancingv2.ApplicationListener {
    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
    });

    // Note: Redirect logic will be added after HTTPS listener is created (if successful)
    // Default action - will be overridden by application stack or redirect
    listener.addAction('DefaultAction', {
      action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'Service temporarily unavailable',
      }),
    });

    return listener;
  }

  private addHttpToHttpsRedirect(): void {
    // Remove default action and add redirect
    // Note: This is a simplified approach. In production, you might want more sophisticated rule management.
    console.log('✅ HTTPS listener created successfully. Adding HTTP to HTTPS redirect.');
    
    // Add redirect action (this will override the default action)
    this.httpListener.addAction('RedirectToHttps', {
      action: elasticloadbalancingv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
      priority: 1, // Higher priority than default action
    });
  }

  private createHttpsListener(): elasticloadbalancingv2.ApplicationListener {
    // certificate is guaranteed to exist when this method is called
    if (!this.certificate) {
      throw new Error('Certificate is required for HTTPS listener creation');
    }
    
    const listener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      certificates: [this.certificate],
    });

    // Default action - will be overridden by application stack
    listener.addAction('DefaultAction', {
      action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'Service temporarily unavailable',
      }),
    });

    return listener;
  }

  private createHttpsListenerWithImportedCert(props: EcsPlatformStackProps): elasticloadbalancingv2.ApplicationListener {
    // For development environments without custom domain, try to import an existing certificate
    // or provide instructions for manual certificate creation
    const certificateArn = props.certificateArn || this.node.tryGetContext('certificateArn');
    
    if (!certificateArn) {
      // Log instructions for manual certificate setup
      console.warn(`⚠️  HTTPS enabled for ${props.environment} but no certificate ARN provided.`);
      console.warn(`   To enable HTTPS, create a certificate in ACM manually and provide the ARN via:`);
      console.warn(`   - Context: --context certificateArn=arn:aws:acm:region:account:certificate/xxx`);
      console.warn(`   - Or add certificateArn to EcsPlatformStackProps`);
      console.warn(`   For now, falling back to HTTP-only configuration.`);
      
      throw new Error(`Certificate ARN required for HTTPS in ${props.environment} environment. See console warnings for setup instructions.`);
    }

    // Import existing certificate
    const certificate = certificatemanager.Certificate.fromCertificateArn(
      this, 'ImportedCertificate', 
      certificateArn
    );

    const listener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
    });

    // Default action - will be overridden by application stack
    listener.addAction('DefaultAction', {
      action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'Service temporarily unavailable',
      }),
    });

    return listener;
  }

  private createWAF(props: EcsPlatformStackProps): wafv2.CfnWebACL {
    // Create IP sets for rate limiting
    const ipSetAllowList = new wafv2.CfnIPSet(this, 'IPSetAllowList', {
      name: `testapp-${props.environment}-allow-list`,
      description: 'Allowed IP addresses for higher rate limits',
      ipAddressVersion: 'IPV4',
      addresses: [], // Can be populated with trusted IPs
      scope: 'REGIONAL',
    });

    const webACL = new wafv2.CfnWebACL(this, 'WebACL', {
      name: `testapp-${props.environment}-web-acl`,
      description: `WAF for TestApp ${props.environment} environment`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      
      rules: [
        // AWS Managed Rule Set - Core Rule Set
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSetMetric',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
        
        // AWS Managed Rule Set - Known Bad Inputs
        {
          name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputsRuleSetMetric',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        },

        // AWS Managed Rule Set - SQL Injection
        {
          name: 'AWS-AWSManagedRulesSQLiRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'SQLiRuleSetMetric',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
        },

        // Rate limiting rule
        {
          name: 'RateLimitRule',
          priority: 10,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRuleMetric',
          },
          statement: {
            rateBasedStatement: {
              limit: props.environment === 'production' ? 2000 : 1000,
              aggregateKeyType: 'IP',
            },
          },
        },

        // Geographic restriction for production
        ...(props.environment === 'production' ? [{
          name: 'GeoRestrictionRule',
          priority: 15,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'GeoRestrictionRuleMetric',
          },
          statement: {
            geoMatchStatement: {
              countryCodes: ['CN', 'RU', 'KP', 'IR'], // Block specific high-risk countries
            },
          },
        }] : []),
      ],

      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `testapp-${props.environment}-web-acl`,
      },
    });

    // Add tags
    cdk.Tags.of(webACL).add('Environment', props.environment);
    cdk.Tags.of(webACL).add('ManagedBy', 'CDK');
    cdk.Tags.of(webACL).add('Component', 'WAF');
    cdk.Tags.of(webACL).add('Purpose', 'DDoS-Protection');

    return webACL;
  }

  private associateWAFWithALB(): void {
    if (!this.webACL) return;

    new wafv2.CfnWebACLAssociation(this, 'WebACLAssociation', {
      resourceArn: this.loadBalancer.loadBalancerArn,
      webAclArn: this.webACL.attrArn,
    });
  }

  private createOutputs(props: EcsPlatformStackProps): void {
    // ECS Cluster outputs
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      description: 'ECS Cluster ARN',
      exportName: `${this.stackName}-ClusterArn`,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster Name',
      exportName: `${this.stackName}-ClusterName`,
    });

    // ECR Repository outputs
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: `${this.stackName}-RepositoryUri`,
    });

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: this.repository.repositoryArn,
      description: 'ECR Repository ARN',
      exportName: `${this.stackName}-RepositoryArn`,
    });

    // Load Balancer outputs
    new cdk.CfnOutput(this, 'LoadBalancerArn', {
      value: this.loadBalancer.loadBalancerArn,
      description: 'Application Load Balancer ARN',
      exportName: `${this.stackName}-LoadBalancerArn`,
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Application Load Balancer DNS Name',
      exportName: `${this.stackName}-LoadBalancerDNS`,
    });

    new cdk.CfnOutput(this, 'LoadBalancerZoneId', {
      value: this.loadBalancer.loadBalancerCanonicalHostedZoneId,
      description: 'Application Load Balancer Hosted Zone ID',
      exportName: `${this.stackName}-LoadBalancerZoneId`,
    });

    // Listener outputs
    new cdk.CfnOutput(this, 'HttpListenerArn', {
      value: this.httpListener.listenerArn,
      description: 'HTTP Listener ARN',
      exportName: `${this.stackName}-HttpListenerArn`,
    });

    if (this.httpsListener) {
      new cdk.CfnOutput(this, 'HttpsListenerArn', {
        value: this.httpsListener.listenerArn,
        description: 'HTTPS Listener ARN',
        exportName: `${this.stackName}-HttpsListenerArn`,
      });
    }

    // Log Group output
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'CloudWatch Log Group Name',
      exportName: `${this.stackName}-LogGroupName`,
    });

    new cdk.CfnOutput(this, 'LogGroupArn', {
      value: this.logGroup.logGroupArn,
      description: 'CloudWatch Log Group ARN',
      exportName: `${this.stackName}-LogGroupArn`,
    });

    // Certificate output (if enabled)
    if (this.certificate) {
      new cdk.CfnOutput(this, 'CertificateArn', {
        value: this.certificate.certificateArn,
        description: 'SSL Certificate ARN',
        exportName: `${this.stackName}-CertificateArn`,
      });
    }

    // WAF output (if enabled)
    if (this.webACL) {
      new cdk.CfnOutput(this, 'WAFWebACLArn', {
        value: this.webACL.attrArn,
        description: 'WAF Web ACL ARN',
        exportName: `${this.stackName}-WAFWebACLArn`,
      });

      new cdk.CfnOutput(this, 'WAFWebACLId', {
        value: this.webACL.attrId,
        description: 'WAF Web ACL ID',
        exportName: `${this.stackName}-WAFWebACLId`,
      });
    }

    // ALB DNS output already created above - removing duplicate
  }
}