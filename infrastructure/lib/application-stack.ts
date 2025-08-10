import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as applicationautoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { SecretsLoader } from './secrets-loader';

export interface ApplicationStackProps extends cdk.StackProps {
  environment: string;
  // VPC configuration
  vpcId: string;
  privateSubnetIds: string[];
  applicationSecurityGroupId: string;
  // ECS Platform configuration
  clusterArn: string;
  clusterName: string;
  repositoryUri: string;
  loadBalancerArn: string;
  httpListenerArn: string;
  httpsListenerArn?: string;
  logGroupName: string;
  logGroupArn: string;
  // Application configuration
  serviceName?: string;
  taskImageTag?: string;
  desiredCount?: number;
  cpu?: number;
  memoryLimitMiB?: number;
  containerPort?: number;
  // Auto scaling configuration
  minCapacity?: number;
  maxCapacity?: number;
  cpuTargetUtilization?: number;
  memoryTargetUtilization?: number;
  requestsPerTarget?: number;
  scaleInCooldownMinutes?: number;
  scaleOutCooldownMinutes?: number;
  // Health check configuration
  healthCheckPath?: string;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
  healthyThresholdCount?: number;
  unhealthyThresholdCount?: number;
  // Container security
  enableNonRootContainer?: boolean;
  enableReadOnlyRootFilesystem?: boolean;
  // Environment variables
  environmentVariables?: { [key: string]: string };
  // Domain configuration
  baseDomain?: string;
  appName?: string;
  prId?: string;
  hostedZoneId?: string;
}

export class ApplicationStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly container: ecs.ContainerDefinition;
  public readonly targetGroup: elasticloadbalancingv2.ApplicationTargetGroup;
  public readonly scalableTarget: ecs.ScalableTaskCount;
  public readonly appSecrets: secretsmanager.Secret;
  private readonly secretsLoader: SecretsLoader;
  private hostedZone?: route53.IHostedZone;

  /**
   * Constructs the domain name dynamically based on app, environment, and PR context
   */
  private getDomainName(props: ApplicationStackProps): string | undefined {
    if (!props.baseDomain || !props.appName) return undefined;

    if (props.prId) {
      // PR deployments: pr-123-testapp.assessment.elio.eti.br
      const sanitizedPrId = props.prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      return `pr-${sanitizedPrId}-${props.appName}.${props.baseDomain}`;
    } else {
      // Regular environments
      return props.environment === 'production'
        ? `${props.appName}.${props.baseDomain}`                    // testapp.assessment.elio.eti.br
        : `${props.environment}-${props.appName}.${props.baseDomain}`; // dev-testapp.assessment.elio.eti.br
    }
  }

  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    // Initialize secrets loader
    this.secretsLoader = new SecretsLoader(props.environment);
    
    // Create AWS Secrets Manager secret from SOPS
    this.appSecrets = this.createSecretsManagerSecret(props);

    // Import VPC and subnets
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.vpcId,
      availabilityZones: cdk.Fn.getAzs(),
      privateSubnetIds: props.privateSubnetIds,
    });

    // Import application security group
    const applicationSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'ImportedApplicationSecurityGroup',
      props.applicationSecurityGroupId
    );

    // Import ECS cluster
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterName: props.clusterName,
      vpc,
      securityGroups: [applicationSecurityGroup],
    });

    // Import ECR repository
    const repository = ecr.Repository.fromRepositoryName(
      this, 'ImportedRepository', 
      props.repositoryUri.split('/').pop()!.split(':')[0]
    );

    // Import log group
    const logGroup = logs.LogGroup.fromLogGroupName(
      this, 'ImportedLogGroup',
      props.logGroupName
    );

    // Import load balancer and listeners using ARNs
    const loadBalancer = elasticloadbalancingv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(
      this, 'ImportedLoadBalancer',
      { 
        loadBalancerArn: props.loadBalancerArn,
        securityGroupId: applicationSecurityGroup.securityGroupId
      }
    );

    const httpListener = elasticloadbalancingv2.ApplicationListener.fromApplicationListenerAttributes(
      this, 'ImportedHttpListener',
      { 
        listenerArn: props.httpListenerArn,
        securityGroup: applicationSecurityGroup
      }
    );

    let httpsListener: elasticloadbalancingv2.IApplicationListener | undefined;
    if (props.httpsListenerArn) {
      httpsListener = elasticloadbalancingv2.ApplicationListener.fromApplicationListenerAttributes(
        this, 'ImportedHttpsListener',
        { 
          listenerArn: props.httpsListenerArn,
          securityGroup: applicationSecurityGroup
        }
      );
    }

    // Create IAM roles
    const { executionRole, taskRole } = this.createIamRoles(props, logGroup);

    // Create task definition
    this.taskDefinition = this.createTaskDefinition(props, executionRole, taskRole);

    // Create container definition
    this.container = this.createContainerDefinition(props, repository, logGroup);

    // Create target group
    this.targetGroup = this.createTargetGroup(props, vpc, loadBalancer);

    // Run database migrations before starting the service
    this.runMigrations(props, cluster, applicationSecurityGroup);

    // Create Fargate service
    this.service = this.createFargateService(props, cluster, applicationSecurityGroup);

    // Configure health checks
    this.configureHealthCheck(props);

    // Create auto scaling (CPU and Memory)
    this.scalableTarget = this.createAutoScaling(props);

    // Add listener rules
    this.addListenerRules(httpListener, httpsListener);

    // Add request-based auto scaling after listener rules are created
    this.addRequestBasedScaling(props);

    // Setup Route53 DNS records (if domain configured)
    this.setupRoute53(props);

    // Create stack outputs
    this.createOutputs(props);
  }

  private createSecretsManagerSecret(props: ApplicationStackProps): secretsmanager.Secret {
    try {
      const secrets = this.secretsLoader.loadSecretsWithFallback();
      
      const secret = new secretsmanager.Secret(this, 'AppSecrets', {
        secretName: `testapp-${props.environment}-app-secrets`,
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

      cdk.Tags.of(secret).add('Environment', props.environment);
      cdk.Tags.of(secret).add('ManagedBy', 'CDK-SOPS');
      cdk.Tags.of(secret).add('Component', 'Application-Secrets');
      
      return secret;
    } catch (error) {
      console.warn(`Failed to load SOPS secrets, creating empty secret: ${error}`);
      
      return new secretsmanager.Secret(this, 'AppSecrets', {
        secretName: `testapp-${props.environment}-app-secrets`,
        description: `Application secrets for TestApp ${props.environment} environment (empty - populate manually)`,
        removalPolicy: props.environment === 'production' 
          ? cdk.RemovalPolicy.RETAIN 
          : cdk.RemovalPolicy.DESTROY,
      });
    }
  }

  private createIamRoles(props: ApplicationStackProps, logGroup: logs.ILogGroup) {
    // Task execution role
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: `testapp-${props.environment}-execution-role`,
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

    // Task role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: `testapp-${props.environment}-task-role`,
      inlinePolicies: {
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [logGroup.logGroupArn + '*'],
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

    // Add tags
    cdk.Tags.of(executionRole).add('Environment', props.environment);
    cdk.Tags.of(executionRole).add('Component', 'ECS-Execution-Role');
    cdk.Tags.of(taskRole).add('Environment', props.environment);
    cdk.Tags.of(taskRole).add('Component', 'ECS-Task-Role');

    return { executionRole, taskRole };
  }

  private createTaskDefinition(
    props: ApplicationStackProps,
    executionRole: iam.Role,
    taskRole: iam.Role
  ): ecs.FargateTaskDefinition {
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `testapp-${props.environment}`,
      cpu: props.cpu || 256,
      memoryLimitMiB: props.memoryLimitMiB || 512,
      executionRole,
      taskRole,
    });

    // Add tmpfs volumes if read-only root filesystem is enabled
    if (props.enableReadOnlyRootFilesystem) {
      taskDefinition.addVolume({
        name: 'tmp-volume',
        host: {},
      });

      taskDefinition.addVolume({
        name: 'logs-volume',
        host: {},
      });
    }

    // Add tags
    cdk.Tags.of(taskDefinition).add('Environment', props.environment);
    cdk.Tags.of(taskDefinition).add('Component', 'ECS-Task-Definition');

    return taskDefinition;
  }

  private createContainerDefinition(
    props: ApplicationStackProps,
    repository: ecr.IRepository,
    logGroup: logs.ILogGroup
  ): ecs.ContainerDefinition {
    // Prepare environment variables
    const environment = {
      // Core Django settings
      REQUIRED_SETTING: props.environment,
      ENVIRONMENT: props.environment,
      AWS_DEFAULT_REGION: this.region,
      DEBUG: 'false',
      
      // Database settings
      DATABASE_URL: 'sqlite:///db.sqlite3', // Default for development, should be RDS in production
      
      // Redis settings
      REDIS_URL: 'redis://localhost:6379/0', // Should be ElastiCache endpoint in production
      
      // Security settings
      ALLOWED_HOSTS: '*', // Should be specific domains in production
      CORS_ALLOWED_ORIGINS: '', // Should be configured for your frontend domains
      SECURE_SSL_REDIRECT: props.environment === 'production' ? 'true' : 'false',
      SECURE_HSTS_SECONDS: '31536000',
      SECURE_CONTENT_TYPE_NOSNIFF: 'true',
      SECURE_PROXY_SSL_HEADER: 'HTTP_X_FORWARDED_PROTO,https',
      SESSION_COOKIE_SECURE: props.environment === 'production' ? 'true' : 'false',
      CSRF_COOKIE_SECURE: props.environment === 'production' ? 'true' : 'false',
      
      // Email settings
      EMAIL_URL: 'console://', // Use console backend by default, configure SMTP for production
      DEFAULT_FROM_EMAIL: 'noreply@testapp.com',
      
      // Static files
      USE_WHITENOISE: 'true',
      STATIC_ROOT: '/app/staticfiles',
      
      // Monitoring (optional)
      SENTRY_DSN: '', // Configure in production
      
      // Override with any custom environment variables
      ...props.environmentVariables,
    };

    // Create container
    const container = this.taskDefinition.addContainer('testapp-container', {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.taskImageTag || 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'testapp',
        logGroup,
      }),
      environment,
      secrets: {
        SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecrets, 'secret_key'),
        // Add more secrets as needed
        // DATABASE_URL: ecs.Secret.fromSecretsManager(this.appSecrets, 'database_url'),
        // REDIS_URL: ecs.Secret.fromSecretsManager(this.appSecrets, 'redis_url'),
      },
      // Container security settings
      user: props.enableNonRootContainer ? '1001:1001' : undefined,
      readonlyRootFilesystem: props.enableReadOnlyRootFilesystem || false,
      // Resource limits for security and performance
      memoryReservationMiB: Math.floor((props.memoryLimitMiB || 512) * 0.8),
    });

    // Add port mapping
    container.addPortMappings({
      containerPort: props.containerPort || 8000,
      protocol: ecs.Protocol.TCP,
      name: 'http',
    });

    // Add mount points for tmpfs volumes if read-only filesystem is enabled
    if (props.enableReadOnlyRootFilesystem) {
      container.addMountPoints({
        sourceVolume: 'tmp-volume',
        containerPath: '/tmp',
        readOnly: false,
      });

      container.addMountPoints({
        sourceVolume: 'logs-volume',
        containerPath: '/app/logs',
        readOnly: false,
      });
    }

    return container;
  }

  private createTargetGroup(props: ApplicationStackProps, vpc: ec2.IVpc, loadBalancer: elasticloadbalancingv2.IApplicationLoadBalancer): elasticloadbalancingv2.ApplicationTargetGroup {
    const targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: `testapp-${props.environment}-tg`,
      port: props.containerPort || 8000,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      vpc,
      targetType: elasticloadbalancingv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        path: props.healthCheckPath || '/health/',
        protocol: elasticloadbalancingv2.Protocol.HTTP,
        port: 'traffic-port',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(props.healthCheckInterval || 30),
        timeout: cdk.Duration.seconds(props.healthCheckTimeout || 5),
        healthyThresholdCount: props.healthyThresholdCount || 2,
        unhealthyThresholdCount: props.unhealthyThresholdCount || 3,
      },
    });

    // Add tags
    cdk.Tags.of(targetGroup).add('Environment', props.environment);
    cdk.Tags.of(targetGroup).add('Component', 'Application-TargetGroup');

    return targetGroup;
  }

  private createFargateService(
    props: ApplicationStackProps,
    cluster: ecs.ICluster,
    securityGroup: ec2.ISecurityGroup
  ): ecs.FargateService {
    const serviceName = props.serviceName || `testapp-service-${props.environment}`;

    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition: this.taskDefinition,
      serviceName,
      desiredCount: props.desiredCount || 1,
      securityGroups: [securityGroup],
      assignPublicIp: false, // Running in private subnets
      enableExecuteCommand: props.environment !== 'production', // Enable ECS Exec for dev
      // Deployment configuration for zero-downtime deployments in production
      minHealthyPercent: props.environment === 'production' ? 100 : 50,
      maxHealthyPercent: props.environment === 'production' ? 200 : 150,
    });

    // Configure service load balancers
    service.attachToApplicationTargetGroup(this.targetGroup);

    // Add tags
    cdk.Tags.of(service).add('Environment', props.environment);
    cdk.Tags.of(service).add('Component', 'ECS-Service');

    return service;
  }

  private configureHealthCheck(props: ApplicationStackProps): void {
    // Health check configuration is already set in target group creation
    // This method can be extended for additional health check configurations
  }

  private createAutoScaling(props: ApplicationStackProps): ecs.ScalableTaskCount {
    const minCapacity = props.minCapacity || props.desiredCount || 1;
    const maxCapacity = props.maxCapacity || (props.desiredCount || 1) * 3;

    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity,
      maxCapacity,
    });

    // CPU-based auto scaling
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: props.cpuTargetUtilization || 70,
      scaleInCooldown: cdk.Duration.minutes(props.scaleInCooldownMinutes || 5),
      scaleOutCooldown: cdk.Duration.minutes(props.scaleOutCooldownMinutes || 2),
    });

    // Memory-based auto scaling
    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: props.memoryTargetUtilization || 80,
      scaleInCooldown: cdk.Duration.minutes(props.scaleInCooldownMinutes || 5),
      scaleOutCooldown: cdk.Duration.minutes(props.scaleOutCooldownMinutes || 2),
    });

    return scalableTarget;
  }

  private addRequestBasedScaling(props: ApplicationStackProps): void {
    if (!this.scalableTarget || !this.targetGroup) {
      console.warn('⚠️  Cannot configure request-based scaling: scalableTarget or targetGroup not available');
      return;
    }

    // Request-based auto scaling using ALB RequestCountPerTarget metric
    this.scalableTarget.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: props.requestsPerTarget || 1000,
      targetGroup: this.targetGroup,
      scaleInCooldown: cdk.Duration.minutes(props.scaleInCooldownMinutes || 5),
      scaleOutCooldown: cdk.Duration.minutes(props.scaleOutCooldownMinutes || 2),
    });

    console.log(`✅ Request-based auto scaling configured: ${props.requestsPerTarget || 1000} requests per target`);
  }

  private addListenerRules(
    httpListener: elasticloadbalancingv2.IApplicationListener,
    httpsListener?: elasticloadbalancingv2.IApplicationListener
  ): void {
    // Add rule to HTTP listener
    new elasticloadbalancingv2.ApplicationListenerRule(this, 'HttpListenerRule', {
      listener: httpListener,
      priority: 100,
      conditions: [
        elasticloadbalancingv2.ListenerCondition.pathPatterns(['*']),
      ],
      action: elasticloadbalancingv2.ListenerAction.forward([this.targetGroup]),
    });

    // Add rule to HTTPS listener if it exists
    if (httpsListener) {
      new elasticloadbalancingv2.ApplicationListenerRule(this, 'HttpsListenerRule', {
        listener: httpsListener,
        priority: 100,
        conditions: [
          elasticloadbalancingv2.ListenerCondition.pathPatterns(['*']),
        ],
        action: elasticloadbalancingv2.ListenerAction.forward([this.targetGroup]),
      });
    }
  }

  private setupRoute53(props: ApplicationStackProps): void {
    const domainName = this.getDomainName(props);
    if (!domainName || !props.baseDomain || !props.hostedZoneId) return;

    // Import hosted zone from Platform stack exports
    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: cdk.Fn.importValue(`TestApp-Platform-${props.environment}-HostedZoneId`),
      zoneName: cdk.Fn.importValue(`TestApp-Platform-${props.environment}-HostedZoneName`),
    });

    // Import load balancer for DNS target
    const loadBalancer = elasticloadbalancingv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(
      this, 'Route53LoadBalancer',
      {
        loadBalancerArn: props.loadBalancerArn,
        loadBalancerDnsName: cdk.Fn.importValue(`TestApp-Platform-${props.environment}-LoadBalancerDNS`),
        loadBalancerCanonicalHostedZoneId: cdk.Fn.importValue(`TestApp-Platform-${props.environment}-LoadBalancerZoneId`),
        securityGroupId: '', // Not needed for DNS record creation
      }
    );

    // Create A record for the domain
    new route53.ARecord(this, 'DnsARecord', {
      zone: this.hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(loadBalancer)
      ),
    });

    // Create AAAA record for IPv6 (if ALB supports it)
    new route53.AaaaRecord(this, 'DnsAaaaRecord', {
      zone: this.hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(loadBalancer)
      ),
    });
  }

  private runMigrations(
    props: ApplicationStackProps, 
    cluster: ecs.ICluster, 
    securityGroup: ec2.ISecurityGroup
  ): void {
    // Create a separate task definition for migrations
    const migrationTaskDefinition = new ecs.FargateTaskDefinition(this, 'MigrationTaskDefinition', {
      family: `testapp-migration-${props.environment}`,
      cpu: props.cpu || 256,
      memoryLimitMiB: props.memoryLimitMiB || 512,
      executionRole: this.taskDefinition.executionRole!,
      taskRole: this.taskDefinition.taskRole!,
    });

    // Import log group and repository (already created)
    const logGroup = logs.LogGroup.fromLogGroupName(this, 'ImportedMigrationLogGroup', props.logGroupName);
    const repository = ecr.Repository.fromRepositoryName(
      this, 'ImportedMigrationRepository', 
      props.repositoryUri.split('/').pop()!.split(':')[0]
    );

    // Create migration container with same environment as main app but different command
    const migrationContainer = migrationTaskDefinition.addContainer('MigrationContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.taskImageTag || 'latest'),
      environment: {
        // Core Django settings
        REQUIRED_SETTING: props.environment,
        ENVIRONMENT: props.environment,
        AWS_DEFAULT_REGION: this.region,
        DEBUG: 'false',
        
        // Database settings
        DATABASE_URL: 'sqlite:///db.sqlite3', // Default for development, should be RDS in production
        
        // Redis settings
        REDIS_URL: 'redis://localhost:6379/0', // Should be ElastiCache endpoint in production
        
        // Security settings
        ALLOWED_HOSTS: '*', // Should be specific domains in production
        CORS_ALLOWED_ORIGINS: '', // Should be configured for your frontend domains
        SECURE_SSL_REDIRECT: props.environment === 'production' ? 'true' : 'false',
        SECURE_HSTS_SECONDS: '31536000',
        SECURE_CONTENT_TYPE_NOSNIFF: 'true',
        SECURE_PROXY_SSL_HEADER: 'HTTP_X_FORWARDED_PROTO,https',
        SESSION_COOKIE_SECURE: props.environment === 'production' ? 'true' : 'false',
        CSRF_COOKIE_SECURE: props.environment === 'production' ? 'true' : 'false',
        
        // Email settings
        EMAIL_URL: 'console://', // Use console backend by default, configure SMTP for production
        DEFAULT_FROM_EMAIL: 'noreply@testapp.com',
        
        // Static files
        USE_WHITENOISE: 'true',
        STATIC_ROOT: '/app/staticfiles',
        
        // Monitoring (optional)
        SENTRY_DSN: '', // Configure in production
        
        // Override with any custom environment variables
        ...props.environmentVariables,
      },
      secrets: {
        SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecrets, 'secret_key'),
        JWT_SECRET: ecs.Secret.fromSecretsManager(this.appSecrets, 'jwt_secret'),
        // Add more secrets as needed for migrations
        // DATABASE_URL: ecs.Secret.fromSecretsManager(this.appSecrets, 'database_url'),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'migration',
      }),
      // Override the default command to run migrations
      command: ['/opt/venv/bin/python', 'manage.py', 'migrate'],
      essential: true,
    });

    // Add security configuration
    if (props.enableNonRootContainer) {
      migrationContainer.addToExecutionPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecs:RunTask'],
        resources: [migrationTaskDefinition.taskDefinitionArn],
      }));
    }

    // Add tags
    cdk.Tags.of(migrationTaskDefinition).add('Environment', props.environment);
    cdk.Tags.of(migrationTaskDefinition).add('Component', 'ECS-Migration-Task');
    cdk.Tags.of(migrationTaskDefinition).add('Purpose', 'Database-Migration');

    // Output migration task definition ARN for use in workflows
    new cdk.CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: migrationTaskDefinition.taskDefinitionArn,
      description: 'Migration Task Definition ARN for running database migrations',
      exportName: `${this.stackName}-MigrationTaskDefinitionArn`,
    });
  }

  private createOutputs(props: ApplicationStackProps): void {
    // Service outputs
    new cdk.CfnOutput(this, 'ServiceArn', {
      value: this.service.serviceArn,
      description: 'ECS Service ARN',
      exportName: `${this.stackName}-ServiceArn`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS Service Name',
      exportName: `${this.stackName}-ServiceName`,
    });

    // Task Definition outputs
    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: this.taskDefinition.taskDefinitionArn,
      description: 'ECS Task Definition ARN',
      exportName: `${this.stackName}-TaskDefinitionArn`,
    });

    new cdk.CfnOutput(this, 'TaskDefinitionFamily', {
      value: this.taskDefinition.family,
      description: 'ECS Task Definition Family',
      exportName: `${this.stackName}-TaskDefinitionFamily`,
    });

    // Target Group outputs
    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      description: 'Application Target Group ARN',
      exportName: `${this.stackName}-TargetGroupArn`,
    });

    new cdk.CfnOutput(this, 'TargetGroupName', {
      value: this.targetGroup.targetGroupName,
      description: 'Application Target Group Name',
      exportName: `${this.stackName}-TargetGroupName`,
    });

    // Secrets outputs
    new cdk.CfnOutput(this, 'SecretsArn', {
      value: this.appSecrets.secretArn,
      description: 'Application Secrets ARN',
      exportName: `${this.stackName}-SecretsArn`,
    });

    // Auto Scaling outputs
    new cdk.CfnOutput(this, 'AutoScalingTargetId', {
      value: `service/${this.service.cluster.clusterName}/${this.service.serviceName}`,
      description: 'Auto Scaling Target ID',
      exportName: `${this.stackName}-AutoScalingTargetId`,
    });

    // Configuration outputs for reference
    new cdk.CfnOutput(this, 'DesiredCount', {
      value: (props.desiredCount || 1).toString(),
      description: 'Current Desired Count',
    });

    new cdk.CfnOutput(this, 'TaskCpu', {
      value: (props.cpu || 256).toString(),
      description: 'Task CPU Units',
    });

    new cdk.CfnOutput(this, 'TaskMemory', {
      value: (props.memoryLimitMiB || 512).toString(),
      description: 'Task Memory (MiB)',
    });

    // Application URL output
    const domainName = this.getDomainName(props);
    if (domainName) {
      const protocol = props.httpsListenerArn ? 'https' : 'http';
      new cdk.CfnOutput(this, 'ApplicationUrl', {
        value: `${protocol}://${domainName}`,
        description: 'Application URL with custom domain',
        exportName: `${this.stackName}-ApplicationUrl`,
      });
    } else {
      // Fallback to ALB DNS name (imported from platform stack)
      const albDns = cdk.Fn.importValue(`${props.environment === 'production' ? 'TestApp-Platform-production' : `TestApp-Platform-${props.environment}`}-LoadBalancerDNS`);
      const protocol = props.httpsListenerArn ? 'https' : 'http';
      new cdk.CfnOutput(this, 'ApplicationUrl', {
        value: `${protocol}://${albDns}`,
        description: 'Application URL (ALB DNS)',
        exportName: `${this.stackName}-ApplicationUrl`,
      });
    }
  }
}