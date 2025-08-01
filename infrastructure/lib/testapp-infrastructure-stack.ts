import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { SecretsLoader } from './secrets-loader';

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
}

export class TestAppInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly repository: ecr.Repository;
  public readonly fargateService: ecs_patterns.ApplicationLoadBalancedFargateService;
  private readonly secretsLoader: SecretsLoader;
  private readonly appSecrets: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: TestAppInfrastructureStackProps) {
    super(scope, id, props);

    // Initialize secrets loader
    this.secretsLoader = new SecretsLoader(props.environment);
    
    // Create AWS Secrets Manager secret from SOPS
    this.appSecrets = this.createSecretsManagerSecret(props);

    // Create VPC with configurable IPv6 and NAT Gateway options
    this.vpc = this.createVpc(props);

    // Create ECR Repository
    this.repository = this.createEcrRepository(props);

    // Create ECS Cluster
    this.cluster = this.createEcsCluster(props);

    // Create Fargate Service with Application Load Balancer
    this.fargateService = this.createFargateService(props);

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

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'TestAppService', {
      cluster: this.cluster,
      serviceName: `testapp-service-${props.environment}`,
      cpu: props.cpu,
      memoryLimitMiB: props.memoryLimitMiB,
      desiredCount: props.desiredCount,
      taskImageOptions: {
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
      },
      publicLoadBalancer: true,
      listenerPort: 80,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      domainZone: undefined, // No custom domain for this assessment
      domainName: undefined,
      redirectHTTP: false,
      assignPublicIp: true,
    });

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

    new cdk.CfnOutput(this, 'ApplicationUrl', {
      value: `http://${this.fargateService.loadBalancer.loadBalancerDnsName}`,
      description: 'Application URL',
    });
  }
}