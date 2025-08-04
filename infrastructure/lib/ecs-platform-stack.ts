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
  enableHTTPS?: boolean;
  domainName?: string;
  hostedZoneId?: string;
}

export class EcsPlatformStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly repository: ecr.Repository;
  public readonly loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;
  public readonly httpListener: elasticloadbalancingv2.ApplicationListener;
  public readonly httpsListener?: elasticloadbalancingv2.ApplicationListener;
  public readonly certificate?: certificatemanager.ICertificate;
  public readonly webACL?: wafv2.CfnWebACL;
  public readonly logGroup: logs.LogGroup;
  public readonly hostedZone?: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: EcsPlatformStackProps) {
    super(scope, id, props);

    // Validate configuration
    if (props.enableHTTPS && !props.domainName) {
      throw new Error('Domain name is required when HTTPS is enabled');
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
    if (props.domainName && props.hostedZoneId) {
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName,
      });
    }

    // Create SSL certificate (if HTTPS enabled)
    if (props.enableHTTPS && props.domainName) {
      this.certificate = this.createCertificate(props);
    }

    // Create Application Load Balancer
    this.loadBalancer = this.createApplicationLoadBalancer(props, vpc, loadBalancerSecurityGroup);

    // Create listeners
    this.httpListener = this.createHttpListener();
    if (props.enableHTTPS && this.certificate) {
      this.httpsListener = this.createHttpsListener();
    }

    // Create Route53 DNS record (if hosted zone exists)
    if (this.hostedZone && props.domainName) {
      this.createDnsRecord(props);
    }

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

  private createEcrRepository(props: EcsPlatformStackProps): ecr.Repository {
    const repositoryName = props.repositoryName || `testapp-${props.environment}`;
    
    const repository = new ecr.Repository(this, 'EcrRepository', {
      repositoryName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [
        {
          rulePriority: 1,
          description: 'Delete untagged images after 1 day',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(1),
        },
        {
          rulePriority: 2,
          description: 'Keep last 10 images',
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 10,
        },
      ],
      removalPolicy: props.environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add tags
    cdk.Tags.of(repository).add('Environment', props.environment);
    cdk.Tags.of(repository).add('ManagedBy', 'CDK');
    cdk.Tags.of(repository).add('Component', 'Container-Registry');

    return repository;
  }

  private createCertificate(props: EcsPlatformStackProps): certificatemanager.ICertificate {
    if (!props.domainName) {
      throw new Error('Domain name is required when HTTPS is enabled');
    }

    const certificate = new certificatemanager.Certificate(this, 'SSLCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
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

    // Default action - will be overridden by application stack
    listener.addAction('DefaultAction', {
      action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'Service temporarily unavailable',
      }),
    });

    return listener;
  }

  private createHttpsListener(): elasticloadbalancingv2.ApplicationListener {
    if (!this.certificate) {
      throw new Error('Certificate is required for HTTPS listener');
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

    // Add HTTP to HTTPS redirect
    this.httpListener.addAction('RedirectToHttps', {
      action: elasticloadbalancingv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    return listener;
  }

  private createDnsRecord(props: EcsPlatformStackProps): void {
    if (!this.hostedZone || !props.domainName) return;

    // Create A record for the domain
    new route53.ARecord(this, 'DnsARecord', {
      zone: this.hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(this.loadBalancer)
      ),
    });

    // Create AAAA record for IPv6 (if ALB supports it)
    new route53.AaaaRecord(this, 'DnsAaaaRecord', {
      zone: this.hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(this.loadBalancer)
      ),
    });
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

    // DNS outputs (if domain configured)
    if (props.domainName) {
      const protocol = this.certificate ? 'https' : 'http';
      new cdk.CfnOutput(this, 'ApplicationUrl', {
        value: `${protocol}://${props.domainName}`,
        description: 'Application URL',
      });
    } else {
      const protocol = this.certificate ? 'https' : 'http';
      new cdk.CfnOutput(this, 'ApplicationUrl', {
        value: `${protocol}://${this.loadBalancer.loadBalancerDnsName}`,
        description: 'Application URL',
      });
    }
  }
}