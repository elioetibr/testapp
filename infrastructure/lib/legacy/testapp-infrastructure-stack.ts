import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { SecretsLoader } from '../secrets-loader';

export interface TestAppInfrastructureStackProps extends cdk.StackProps {
  environment: string;
  enableIPv6: boolean;
  enableHANatGateways: boolean;
  maxAzs: number;
  natGateways: number;
  desiredCount: number;
  cpu: number;
  memoryLimitMiB: number;
  // Network configuration
  vpcCidr?: string;
  publicSubnetCidrMask?: number;
  privateSubnetCidrMask?: number;
  // IPv6 configuration
  ipv6CidrBlock?: string; // If not provided, AWS will assign one automatically
  // Security enhancements (disabled by default)
  enableWAF?: boolean;
  enableVPCFlowLogs?: boolean;
  enableHTTPS?: boolean;
  domainName?: string;
  // Container security
  enableNonRootContainer?: boolean;
  enableReadOnlyRootFilesystem?: boolean;
}

export class TestAppInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly repository: ecr.Repository;
  public readonly fargateService: ecs_patterns.ApplicationLoadBalancedFargateService;
  private readonly secretsLoader: SecretsLoader;
  private readonly appSecrets: secretsmanager.Secret;
  private readonly flowLogsBucket?: s3.Bucket;
  private readonly webACL?: wafv2.CfnWebACL;
  private readonly certificate?: certificatemanager.ICertificate;

  constructor(scope: Construct, id: string, props: TestAppInfrastructureStackProps) {
    super(scope, id, props);

    // Initialize secrets loader
    this.secretsLoader = new SecretsLoader(props.environment);
    
    // Create AWS Secrets Manager secret from SOPS
    this.appSecrets = this.createSecretsManagerSecret(props);

    // Create VPC Flow Logs bucket (if enabled)
    if (props.enableVPCFlowLogs) {
      this.flowLogsBucket = this.createVPCFlowLogsBucket(props);
    }

    // Create VPC with configurable IPv6 and NAT Gateway options
    this.vpc = this.createVpc(props);

    // Create VPC Flow Logs (if enabled)
    if (props.enableVPCFlowLogs && this.flowLogsBucket) {
      this.createVPCFlowLogs(props);
    }

    // Create SSL certificate (HTTPS is mandatory when domain is provided)
    if (props.domainName) {
      this.certificate = this.createCertificate(props);
    }

    // Create ECR Repository
    this.repository = this.createEcrRepository(props);

    // Create ECS Cluster
    this.cluster = this.createEcsCluster(props);

    // Create Fargate Service with Application Load Balancer
    this.fargateService = this.createFargateService(props);

    // Create WAF (if enabled)
    if (props.enableWAF) {
      this.webACL = this.createWAF(props);
      this.associateWAFWithALB();
    }

    // Output important resources
    this.createOutputs();
  }

  private createSecretsManagerSecret(props: TestAppInfrastructureStackProps): secretsmanager.Secret {
    try {
      // Load secrets from SOPS
      const secrets = this.secretsLoader.loadSecretsWithFallback();
      
      // Create Secrets Manager secret
      const secret = new secretsmanager.Secret(this, 'AppSecrets', {
        secretName: `testapp-${props.environment}-secrets`,
        description: `Application secrets for TestApp ${props.environment} environment`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify(secrets),
          generateStringKey: 'generated_at',
          includeSpace: false,
          excludeCharacters: '"@/\\'
        },
        removalPolicy: props.environment === 'production' 
          ? cdk.RemovalPolicy.RETAIN 
          : cdk.RemovalPolicy.DESTROY,
      });

      // Tag the secret
      cdk.Tags.of(secret).add('Environment', props.environment);
      cdk.Tags.of(secret).add('ManagedBy', 'CDK-SOPS');
      
      return secret;
    } catch (error) {
      console.warn(`Failed to load SOPS secrets, creating empty secret: ${error}`);
      
      // Fallback: create empty secret that can be populated later
      return new secretsmanager.Secret(this, 'AppSecrets', {
        secretName: `testapp-${props.environment}-secrets`,
        description: `Application secrets for TestApp ${props.environment} environment (empty - populate manually)`,
        removalPolicy: props.environment === 'production' 
          ? cdk.RemovalPolicy.RETAIN 
          : cdk.RemovalPolicy.DESTROY,
      });
    }
  }

  private createVpc(props: TestAppInfrastructureStackProps): ec2.Vpc {
    const subnetConfiguration: ec2.SubnetConfiguration[] = [
      {
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: props.publicSubnetCidrMask || 24,
      },
      {
        name: 'Private',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: props.privateSubnetCidrMask || 24,
      }
    ];

    const vpcProps: ec2.VpcProps = {
      maxAzs: props.maxAzs,
      natGateways: props.enableHANatGateways ? props.maxAzs : Math.min(props.natGateways, props.maxAzs),
      subnetConfiguration,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      // Custom IPv4 CIDR block (using new ipAddresses API)
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr || '10.0.0.0/16'),
    };

    // Add IPv6 support if enabled
    if (props.enableIPv6) {
      // IPv6 configuration
      const vpc = new ec2.Vpc(this, 'TestAppVpc', {
        ...vpcProps,
        // IPv6 will be added via separate configuration
      });

      // Add IPv6 CIDR block to VPC
      const ipv6CidrBlock = new ec2.CfnVPCCidrBlock(this, 'Ipv6CidrBlock', {
        vpcId: vpc.vpcId,
        // Use custom IPv6 CIDR if provided, otherwise use Amazon-provided
        ...(props.ipv6CidrBlock 
          ? { ipv6CidrBlock: props.ipv6CidrBlock }
          : { amazonProvidedIpv6CidrBlock: true }
        ),
      });

      // Configure IPv6 for public subnets
      vpc.publicSubnets.forEach((subnet, index) => {
        const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
        cfnSubnet.ipv6CidrBlock = cdk.Fn.select(index, cdk.Fn.cidr(
          cdk.Fn.select(0, vpc.vpcIpv6CidrBlocks),
          256,
          '64'
        ));
        cfnSubnet.assignIpv6AddressOnCreation = true;
        cfnSubnet.addDependency(ipv6CidrBlock);
      });

      // Add IPv6 route for public subnets
      vpc.publicSubnets.forEach((subnet, index) => {
        new ec2.CfnRoute(this, `Ipv6Route-${index}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationIpv6CidrBlock: '::/0',
          gatewayId: vpc.internetGatewayId,
        });
      });

      return vpc;
    }

    return new ec2.Vpc(this, 'TestAppVpc', vpcProps);
  }

  private createEcrRepository(props: TestAppInfrastructureStackProps): ecr.Repository {
    const repository = new ecr.Repository(this, 'TestAppRepository', {
      repositoryName: `testapp-${props.environment}`,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          rulePriority: 1,
          description: 'Keep last 10 images',
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 10,
        },
      ],
      removalPolicy: props.environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    return repository;
  }

  private createEcsCluster(props: TestAppInfrastructureStackProps): ecs.Cluster {
    const cluster = new ecs.Cluster(this, 'TestAppCluster', {
      vpc: this.vpc,
      clusterName: `testapp-cluster-${props.environment}`,
      // Note: containerInsights is deprecated but still functional
      // In newer CDK versions, use containerInsights: ecs.ContainerInsights.ENHANCED
    });

    return cluster;
  }

  private createSecureTaskDefinition(props: TestAppInfrastructureStackProps, executionRole: iam.Role, taskRole: iam.Role, logGroup: logs.LogGroup): ecs.TaskDefinition | undefined {
    if (!props.enableNonRootContainer && !props.enableReadOnlyRootFilesystem) {
      return undefined; // Use default task definition
    }

    // Create custom task definition with security enhancements
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'SecureTaskDefinition', {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryLimitMiB,
      executionRole,
      taskRole,
    });

    // Add container with security enhancements
    const container = taskDefinition.addContainer('testapp', {
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'testapp',
        logGroup,
      }),
      environment: {
        REQUIRED_SETTING: props.environment,
        ENVIRONMENT: props.environment,
        AWS_DEFAULT_REGION: this.region,
      },
      secrets: {
        SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecrets, 'application.secret_key'),
      },
      // Security enhancements
      user: props.enableNonRootContainer ? '1001:1001' : undefined, // Non-root user
      readonlyRootFilesystem: props.enableReadOnlyRootFilesystem || false,
      // Resource limits for security
      memoryReservationMiB: Math.floor(props.memoryLimitMiB * 0.8), // Reserve 80% of memory
    });

    // Add port mapping
    container.addPortMappings({
      containerPort: 8000,
      protocol: ecs.Protocol.TCP,
    });

    // Add tmpfs mounts if read-only root filesystem is enabled
    if (props.enableReadOnlyRootFilesystem) {
      taskDefinition.addVolume({
        name: 'tmp-volume',
        host: {},
      });

      container.addMountPoints({
        sourceVolume: 'tmp-volume',
        containerPath: '/tmp',
        readOnly: false,
      });

      // Add logs volume
      taskDefinition.addVolume({
        name: 'logs-volume',
        host: {},
      });

      container.addMountPoints({
        sourceVolume: 'logs-volume',
        containerPath: '/app/logs',
        readOnly: false,
      });
    }

    return taskDefinition;
  }

  private createFargateService(props: TestAppInfrastructureStackProps): ecs_patterns.ApplicationLoadBalancedFargateService {
    // Create CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'TestAppLogGroup', {
      logGroupName: `/aws/ecs/testapp-${props.environment}`,
      retention: props.environment === 'production' 
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create task execution role
    const executionRole = new iam.Role(this, 'TestAppExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
      inlinePolicies: {
        ECRAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Create task role with secrets access
    const taskRole = new iam.Role(this, 'TestAppTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [logGroup.logGroupArn],
            }),
          ],
        }),
        SecretsManagerAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              resources: [this.appSecrets.secretArn],
            }),
          ],
        }),
      },
    });

    // Create secure task definition if security enhancements are enabled
    const secureTaskDefinition = this.createSecureTaskDefinition(props, executionRole, taskRole, logGroup);

    const fargateServiceProps: any = {
      cluster: this.cluster,
      serviceName: `testapp-service-${props.environment}`,
      desiredCount: props.desiredCount,
      publicLoadBalancer: true,
      listenerPort: this.certificate ? 443 : 80,
      protocol: this.certificate 
        ? elasticloadbalancingv2.ApplicationProtocol.HTTPS 
        : elasticloadbalancingv2.ApplicationProtocol.HTTP,
      certificate: this.certificate,
      domainZone: undefined, // Custom domain zone would be configured separately
      domainName: undefined, // Domain name requires domainZone configuration
      redirectHTTP: this.certificate ? true : false, // Redirect HTTP to HTTPS when certificate is available
      assignPublicIp: true,
    };

    // Use secure task definition if available, otherwise use standard taskImageOptions
    if (secureTaskDefinition) {
      fargateServiceProps.taskDefinition = secureTaskDefinition;
    } else {
      fargateServiceProps.cpu = props.cpu;
      fargateServiceProps.memoryLimitMiB = props.memoryLimitMiB;
      fargateServiceProps.taskImageOptions = {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
        containerName: 'testapp',
        containerPort: 8000,
        executionRole,
        taskRole,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'testapp',
          logGroup,
        }),
        environment: {
          REQUIRED_SETTING: props.environment,
          ENVIRONMENT: props.environment,
          AWS_DEFAULT_REGION: this.region,
        },
        secrets: {
          // Individual secrets from AWS Secrets Manager
          SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecrets, 'application.secret_key'),
        },
      };
    }

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'TestAppService', fargateServiceProps);

    // Configure health check
    fargateService.targetGroup.configureHealthCheck({
      path: '/health/',
      protocol: elasticloadbalancingv2.Protocol.HTTP,
      port: '8000',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // Configure auto scaling
    const scalableTarget = fargateService.service.autoScaleTaskCount({
      minCapacity: props.desiredCount,
      maxCapacity: props.desiredCount * 3,
    });

    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // Request-based auto scaling
    scalableTarget.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 1000,
      targetGroup: fargateService.targetGroup,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // Security group for the service
    fargateService.service.connections.securityGroups.forEach(sg => {
      sg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(8000),
        'Allow HTTP traffic from ALB'
      );

      if (props.enableIPv6) {
        sg.addIngressRule(
          ec2.Peer.anyIpv6(),
          ec2.Port.tcp(8000),
          'Allow HTTP traffic from ALB (IPv6)'
        );
      }
    });

    return fargateService;
  }

  private createVPCFlowLogsBucket(props: TestAppInfrastructureStackProps): s3.Bucket {
    const bucket = new s3.Bucket(this, 'VPCFlowLogsBucket', {
      bucketName: `testapp-vpc-flow-logs-${props.environment}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'DeleteOldFlowLogs',
          enabled: true,
          expiration: cdk.Duration.days(props.environment === 'production' ? 90 : 30),
        },
      ],
      removalPolicy: props.environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Tag the bucket
    cdk.Tags.of(bucket).add('Purpose', 'VPC-Flow-Logs');
    cdk.Tags.of(bucket).add('Environment', props.environment);
    
    return bucket;
  }

  private createVPCFlowLogs(props: TestAppInfrastructureStackProps): void {
    if (!this.flowLogsBucket) return;

    // Create VPC Flow Logs
    new ec2.FlowLog(this, 'VPCFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toS3(this.flowLogsBucket, 'vpc-flow-logs/'),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Create Flow Log for individual subnets (more granular)
    this.vpc.privateSubnets.forEach((subnet, index) => {
      new ec2.FlowLog(this, `PrivateSubnetFlowLog${index}`, {
        resourceType: ec2.FlowLogResourceType.fromSubnet(subnet),
        destination: ec2.FlowLogDestination.toS3(this.flowLogsBucket!, `private-subnets/subnet-${index}/`),
        trafficType: ec2.FlowLogTrafficType.ALL,
      });
    });
  }

  private createCertificate(props: TestAppInfrastructureStackProps): certificatemanager.ICertificate {
    if (!props.domainName) {
      throw new Error('Domain name is required when HTTPS is enabled');
    }

    // Create SSL certificate
    return new certificatemanager.Certificate(this, 'SSLCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
      validation: certificatemanager.CertificateValidation.fromDns(),
    });
  }

  private createWAF(props: TestAppInfrastructureStackProps): wafv2.CfnWebACL {
    // Create IP sets for rate limiting and blocking
    const ipSetAllowList = new wafv2.CfnIPSet(this, 'IPSetAllowList', {
      name: `testapp-${props.environment}-allow-list`,
      description: 'Allowed IP addresses',
      ipAddressVersion: 'IPV4',
      addresses: [], // Add your allowed IPs here
      scope: 'REGIONAL',
    });

    // Create WAF Web ACL
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

        // Rate limiting rule
        {
          name: 'RateLimitRule',
          priority: 3,
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

        // Geographic restriction (optional - can be configured per environment)
        ...(props.environment === 'production' ? [{
          name: 'GeoRestrictionRule',
          priority: 4,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'GeoRestrictionRuleMetric',
          },
          statement: {
            geoMatchStatement: {
              countryCodes: ['CN', 'RU', 'KP'], // Block specific countries
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

    // Tag the Web ACL
    cdk.Tags.of(webACL).add('Environment', props.environment);
    cdk.Tags.of(webACL).add('Purpose', 'DDoS-Protection');

    return webACL;
  }

  private associateWAFWithALB(): void {
    if (!this.webACL) return;

    // Associate WAF with Application Load Balancer
    new wafv2.CfnWebACLAssociation(this, 'WebACLAssociation', {
      resourceArn: this.fargateService.loadBalancer.loadBalancerArn,
      webAclArn: this.webACL.attrArn,
    });
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${this.stackName}-VpcId`,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster Name',
      exportName: `${this.stackName}-ClusterName`,
    });

    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: `${this.stackName}-RepositoryUri`,
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: this.fargateService.loadBalancer.loadBalancerDnsName,
      description: 'Application Load Balancer DNS Name',
      exportName: `${this.stackName}-LoadBalancerDNS`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.fargateService.service.serviceName,
      description: 'ECS Service Name',
      exportName: `${this.stackName}-ServiceName`,
    });

    const protocol = this.certificate ? 'https' : 'http';
    new cdk.CfnOutput(this, 'ApplicationUrl', {
      value: `${protocol}://${this.fargateService.loadBalancer.loadBalancerDnsName}`,
      description: 'Application URL',
    });

    // Security-related outputs (if enabled)
    if (this.webACL) {
      new cdk.CfnOutput(this, 'WAFWebACLArn', {
        value: this.webACL.attrArn,
        description: 'WAF Web ACL ARN',
        exportName: `${this.stackName}-WAFWebACLArn`,
      });
    }

    if (this.flowLogsBucket) {
      new cdk.CfnOutput(this, 'FlowLogsBucketName', {
        value: this.flowLogsBucket.bucketName,
        description: 'VPC Flow Logs S3 Bucket Name',
        exportName: `${this.stackName}-FlowLogsBucketName`,
      });
    }

    if (this.certificate) {
      new cdk.CfnOutput(this, 'CertificateArn', {
        value: this.certificate.certificateArn,
        description: 'SSL Certificate ARN',
        exportName: `${this.stackName}-CertificateArn`,
      });
    }
  }
}