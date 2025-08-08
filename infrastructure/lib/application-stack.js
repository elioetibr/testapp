"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplicationStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecr = require("aws-cdk-lib/aws-ecr");
const logs = require("aws-cdk-lib/aws-logs");
const iam = require("aws-cdk-lib/aws-iam");
const elasticloadbalancingv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const route53 = require("aws-cdk-lib/aws-route53");
const route53targets = require("aws-cdk-lib/aws-route53-targets");
const secrets_loader_1 = require("./secrets-loader");
class ApplicationStack extends cdk.Stack {
    /**
     * Constructs the domain name dynamically based on app, environment, and PR context
     */
    getDomainName(props) {
        if (!props.baseDomain || !props.appName)
            return undefined;
        if (props.prId) {
            // PR deployments: pr-123-testapp.assessment.elio.eti.br
            const sanitizedPrId = props.prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
            return `pr-${sanitizedPrId}-${props.appName}.${props.baseDomain}`;
        }
        else {
            // Regular environments
            return props.environment === 'production'
                ? `${props.appName}.${props.baseDomain}` // testapp.assessment.elio.eti.br
                : `${props.environment}-${props.appName}.${props.baseDomain}`; // dev-testapp.assessment.elio.eti.br
        }
    }
    constructor(scope, id, props) {
        super(scope, id, props);
        // Initialize secrets loader
        this.secretsLoader = new secrets_loader_1.SecretsLoader(props.environment);
        // Create AWS Secrets Manager secret from SOPS
        this.appSecrets = this.createSecretsManagerSecret(props);
        // Import VPC and subnets
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
            vpcId: props.vpcId,
            availabilityZones: cdk.Fn.getAzs(),
            privateSubnetIds: props.privateSubnetIds,
        });
        // Import application security group
        const applicationSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'ImportedApplicationSecurityGroup', props.applicationSecurityGroupId);
        // Import ECS cluster
        const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
            clusterName: props.clusterName,
            vpc,
            securityGroups: [applicationSecurityGroup],
        });
        // Import ECR repository
        const repository = ecr.Repository.fromRepositoryName(this, 'ImportedRepository', props.repositoryUri.split('/').pop().split(':')[0]);
        // Import log group
        const logGroup = logs.LogGroup.fromLogGroupName(this, 'ImportedLogGroup', props.logGroupName);
        // Import load balancer and listeners using ARNs
        const loadBalancer = elasticloadbalancingv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, 'ImportedLoadBalancer', {
            loadBalancerArn: props.loadBalancerArn,
            securityGroupId: applicationSecurityGroup.securityGroupId
        });
        const httpListener = elasticloadbalancingv2.ApplicationListener.fromApplicationListenerAttributes(this, 'ImportedHttpListener', {
            listenerArn: props.httpListenerArn,
            securityGroup: applicationSecurityGroup
        });
        let httpsListener;
        if (props.httpsListenerArn) {
            httpsListener = elasticloadbalancingv2.ApplicationListener.fromApplicationListenerAttributes(this, 'ImportedHttpsListener', {
                listenerArn: props.httpsListenerArn,
                securityGroup: applicationSecurityGroup
            });
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
    createSecretsManagerSecret(props) {
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
        }
        catch (error) {
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
    createIamRoles(props, logGroup) {
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
    createTaskDefinition(props, executionRole, taskRole) {
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
    createContainerDefinition(props, repository, logGroup) {
        // Prepare environment variables
        const environment = {
            REQUIRED_SETTING: props.environment,
            ENVIRONMENT: props.environment,
            AWS_DEFAULT_REGION: this.region,
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
    createTargetGroup(props, vpc, loadBalancer) {
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
    createFargateService(props, cluster, securityGroup) {
        const serviceName = props.serviceName || `testapp-service-${props.environment}`;
        const service = new ecs.FargateService(this, 'FargateService', {
            cluster,
            taskDefinition: this.taskDefinition,
            serviceName,
            desiredCount: props.desiredCount || 1,
            securityGroups: [securityGroup],
            assignPublicIp: false,
            enableExecuteCommand: props.environment !== 'production',
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
    configureHealthCheck(props) {
        // Health check configuration is already set in target group creation
        // This method can be extended for additional health check configurations
    }
    createAutoScaling(props) {
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
    addRequestBasedScaling(props) {
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
    addListenerRules(httpListener, httpsListener) {
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
    setupRoute53(props) {
        const domainName = this.getDomainName(props);
        if (!domainName || !props.hostedZoneId || !props.baseDomain)
            return;
        // Import existing hosted zone
        this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.baseDomain,
        });
        // Import load balancer for DNS target
        const loadBalancer = elasticloadbalancingv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, 'ImportedLoadBalancer', {
            loadBalancerArn: props.loadBalancerArn,
            securityGroupId: '', // Not needed for DNS record creation
        });
        // Create A record for the domain
        new route53.ARecord(this, 'DnsARecord', {
            zone: this.hostedZone,
            recordName: domainName,
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(loadBalancer)),
        });
        // Create AAAA record for IPv6 (if ALB supports it)
        new route53.AaaaRecord(this, 'DnsAaaaRecord', {
            zone: this.hostedZone,
            recordName: domainName,
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(loadBalancer)),
        });
    }
    runMigrations(props, cluster, securityGroup) {
        // Create a separate task definition for migrations
        const migrationTaskDefinition = new ecs.FargateTaskDefinition(this, 'MigrationTaskDefinition', {
            family: `testapp-migration-${props.environment}`,
            cpu: props.cpu || 256,
            memoryLimitMiB: props.memoryLimitMiB || 512,
            executionRole: this.taskDefinition.executionRole,
            taskRole: this.taskDefinition.taskRole,
        });
        // Import log group and repository (already created)
        const logGroup = logs.LogGroup.fromLogGroupName(this, 'ImportedMigrationLogGroup', props.logGroupName);
        const repository = ecr.Repository.fromRepositoryName(this, 'ImportedMigrationRepository', props.repositoryUri.split('/').pop().split(':')[0]);
        // Create migration container with same environment as main app but different command
        const migrationContainer = migrationTaskDefinition.addContainer('MigrationContainer', {
            image: ecs.ContainerImage.fromEcrRepository(repository, props.taskImageTag || 'latest'),
            environment: {
                REQUIRED_SETTING: props.environment,
                ENVIRONMENT: props.environment,
                AWS_DEFAULT_REGION: this.region,
                ...props.environmentVariables,
            },
            secrets: {
                SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecrets, 'secret_key'),
                JWT_SECRET: ecs.Secret.fromSecretsManager(this.appSecrets, 'jwt_secret'),
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
    createOutputs(props) {
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
        }
        else {
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
exports.ApplicationStack = ApplicationStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHBsaWNhdGlvbi1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLDJDQUEyQztBQUMzQyxpRkFBaUY7QUFDakYsaUVBQWlFO0FBR2pFLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFFbEUscURBQWlEO0FBa0RqRCxNQUFhLGdCQUFpQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBVTdDOztPQUVHO0lBQ0ssYUFBYSxDQUFDLEtBQTRCO1FBQ2hELElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU87WUFBRSxPQUFPLFNBQVMsQ0FBQztRQUUxRCxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUU7WUFDZCx3REFBd0Q7WUFDeEQsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxPQUFPLENBQUMsY0FBYyxFQUFFLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZGLE9BQU8sTUFBTSxhQUFhLElBQUksS0FBSyxDQUFDLE9BQU8sSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7U0FDbkU7YUFBTTtZQUNMLHVCQUF1QjtZQUN2QixPQUFPLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWTtnQkFDdkMsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQW9CLGlDQUFpQztnQkFDN0YsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxLQUFLLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDLHFDQUFxQztTQUN2RztJQUNILENBQUM7SUFFRCxZQUFZLEtBQWdCLEVBQUUs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NkJBQTZCLENBQUMsQ0FBQyxDQUFDLG9CQUFvQixLQUFLLENBQUMsV0FBVyxFQUFFLGtCQUFrQixDQUFDLENBQUM7WUFDckssTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztZQUMzRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO2dCQUN4QyxLQUFLLEVBQUUsR0FBRyxRQUFRLE1BQU0sTUFBTSxFQUFFO2dCQUNoQyxXQUFXLEVBQUUsMkJBQTJCO2dCQUN4QyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxpQkFBaUI7YUFDL0MsQ0FBQyxDQUFDO1NBQ0o7SUFDSCxDQUFDO0NBQ0Y7QUF2cEJELDRDQXVwQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwcGxpY2F0aW9uYXV0b3NjYWxpbmcnO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1Myc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU2VjcmV0c0xvYWRlciB9IGZyb20gJy4vc2VjcmV0cy1sb2FkZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcGxpY2F0aW9uU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgLy8gVlBDIGNvbmZpZ3VyYXRpb25cbiAgdnBjSWQ6IHN0cmluZztcbiAgcHJpdmF0ZVN1Ym5ldElkczogc3RyaW5nW107XG4gIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkOiBzdHJpbmc7XG4gIC8vIEVDUyBQbGF0Zm9ybSBjb25maWd1cmF0aW9uXG4gIGNsdXN0ZXJBcm46IHN0cmluZztcbiAgY2x1c3Rlck5hbWU6IHN0cmluZztcbiAgcmVwb3NpdG9yeVVyaTogc3RyaW5nO1xuICBsb2FkQmFsYW5jZXJBcm46IHN0cmluZztcbiAgaHR0cExpc3RlbmVyQXJuOiBzdHJpbmc7XG4gIGh0dHBzTGlzdGVuZXJBcm4/OiBzdHJpbmc7XG4gIGxvZ0dyb3VwTmFtZTogc3RyaW5nO1xuICBsb2dHcm91cEFybjogc3RyaW5nO1xuICAvLyBBcHBsaWNhdGlvbiBjb25maWd1cmF0aW9uXG4gIHNlcnZpY2VOYW1lPzogc3RyaW5nO1xuICB0YXNrSW1hZ2VUYWc/OiBzdHJpbmc7XG4gIGRlc2lyZWRDb3VudD86IG51bWJlcjtcbiAgY3B1PzogbnVtYmVyO1xuICBtZW1vcnlMaW1pdE1pQj86IG51bWJlcjtcbiAgY29udGFpbmVyUG9ydD86IG51bWJlcjtcbiAgLy8gQXV0byBzY2FsaW5nIGNvbmZpZ3VyYXRpb25cbiAgbWluQ2FwYWNpdHk/OiBudW1iZXI7XG4gIG1heENhcGFjaXR5PzogbnVtYmVyO1xuICBjcHVUYXJnZXRVdGlsaXphdGlvbj86IG51bWJlcjtcbiAgbWVtb3J5VGFyZ2V0VXRpbGl6YXRpb24/OiBudW1iZXI7XG4gIHJlcXVlc3RzUGVyVGFyZ2V0PzogbnVtYmVyO1xuICBzY2FsZUluQ29vbGRvd25NaW51dGVzPzogbnVtYmVyO1xuICBzY2FsZU91dENvb2xkb3duTWludXRlcz86IG51bWJlcjtcbiAgLy8gSGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb25cbiAgaGVhbHRoQ2hlY2tQYXRoPzogc3RyaW5nO1xuICBoZWFsdGhDaGVja0ludGVydmFsPzogbnVtYmVyO1xuICBoZWFsdGhDaGVja1RpbWVvdXQ/OiBudW1iZXI7XG4gIGhlYWx0aHlUaHJlc2hvbGRDb3VudD86IG51bWJlcjtcbiAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ/OiBudW1iZXI7XG4gIC8vIENvbnRhaW5lciBzZWN1cml0eVxuICBlbmFibGVOb25Sb290Q29udGFpbmVyPzogYm9vbGVhbjtcbiAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbT86IGJvb2xlYW47XG4gIC8vIEVudmlyb25tZW50IHZhcmlhYmxlc1xuICBlbnZpcm9ubWVudFZhcmlhYmxlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG4gIC8vIERvbWFpbiBjb25maWd1cmF0aW9uXG4gIGJhc2VEb21haW4/OiBzdHJpbmc7XG4gIGFwcE5hbWU/OiBzdHJpbmc7XG4gIHBySWQ/OiBzdHJpbmc7XG4gIGhvc3RlZFpvbmVJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcGxpY2F0aW9uU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgc2VydmljZTogZWNzLkZhcmdhdGVTZXJ2aWNlO1xuICBwdWJsaWMgcmVhZG9ubHkgdGFza0RlZmluaXRpb246IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb247XG4gIHB1YmxpYyByZWFkb25seSBjb250YWluZXI6IGVjcy5Db250YWluZXJEZWZpbml0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgdGFyZ2V0R3JvdXA6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25UYXJnZXRHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IHNjYWxhYmxlVGFyZ2V0OiBlY3MuU2NhbGFibGVUYXNrQ291bnQ7XG4gIHB1YmxpYyByZWFkb25seSBhcHBTZWNyZXRzOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjcmV0c0xvYWRlcjogU2VjcmV0c0xvYWRlcjtcbiAgcHJpdmF0ZSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogQ29uc3RydWN0cyB0aGUgZG9tYWluIG5hbWUgZHluYW1pY2FsbHkgYmFzZWQgb24gYXBwLCBlbnZpcm9ubWVudCwgYW5kIFBSIGNvbnRleHRcbiAgICovXG4gIHByaXZhdGUgZ2V0RG9tYWluTmFtZShwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIXByb3BzLmJhc2VEb21haW4gfHwgIXByb3BzLmFwcE5hbWUpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICBpZiAocHJvcHMucHJJZCkge1xuICAgICAgLy8gUFIgZGVwbG95bWVudHM6IHByLTEyMy10ZXN0YXBwLmFzc2Vzc21lbnQuZWxpby5ldGkuYnJcbiAgICAgIGNvbnN0IHNhbml0aXplZFBySWQgPSBwcm9wcy5wcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgcmV0dXJuIGBwci0ke3Nhbml0aXplZFBySWR9LSR7cHJvcHMuYXBwTmFtZX0uJHtwcm9wcy5iYXNlRG9tYWlufWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFJlZ3VsYXIgZW52aXJvbm1lbnRzXG4gICAgICByZXR1cm4gcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJ1xuICAgICAgICA/IGAke3Byb3BzLmFwcE5hbWV9LiR7cHJvcHMuYmFzZURvbWFpbn1gICAgICAgICAgICAgICAgICAgICAvLyB0ZXN0YXBwLmFzc2Vzc21lbnQuZWxpby5ldGkuYnJcbiAgICAgICAgOiBgJHtwcm9wcy5lbnZpcm9ubWVudH0tJHtwcm9wcy5hcHBOYW1lfS4ke3Byb3BzLmJhc2VEb21haW59YDsgLy8gZGV2LXRlc3RhcHAuYXNzZXNzbWVudC5lbGlvLmV0aS5iclxuICAgIH1cbiAgfVxuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEluaXRpYWxpemUgc2VjcmV0cyBsb2FkZXJcbiAgICB0aGlzLnNlY3JldHNMb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcihwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIEFXUyBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0IGZyb20gU09QU1xuICAgIHRoaXMuYXBwU2VjcmV0cyA9IHRoaXMuY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHMpO1xuXG4gICAgLy8gSW1wb3J0IFZQQyBhbmQgc3VibmV0c1xuICAgIGNvbnN0IHZwYyA9IGVjMi5WcGMuZnJvbVZwY0F0dHJpYnV0ZXModGhpcywgJ0ltcG9ydGVkVnBjJywge1xuICAgICAgdnBjSWQ6IHByb3BzLnZwY0lkLFxuICAgICAgYXZhaWxhYmlsaXR5Wm9uZXM6IGNkay5Gbi5nZXRBenMoKSxcbiAgICAgIHByaXZhdGVTdWJuZXRJZHM6IHByb3BzLnByaXZhdGVTdWJuZXRJZHMsXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgYXBwbGljYXRpb24gc2VjdXJpdHkgZ3JvdXBcbiAgICBjb25zdCBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXAgPSBlYzIuU2VjdXJpdHlHcm91cC5mcm9tU2VjdXJpdHlHcm91cElkKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkQXBwbGljYXRpb25TZWN1cml0eUdyb3VwJyxcbiAgICAgIHByb3BzLmFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkXG4gICAgKTtcblxuICAgIC8vIEltcG9ydCBFQ1MgY2x1c3RlclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBlY3MuQ2x1c3Rlci5mcm9tQ2x1c3RlckF0dHJpYnV0ZXModGhpcywgJ0ltcG9ydGVkQ2x1c3RlcicsIHtcbiAgICAgIGNsdXN0ZXJOYW1lOiBwcm9wcy5jbHVzdGVyTmFtZSxcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbYXBwbGljYXRpb25TZWN1cml0eUdyb3VwXSxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBFQ1IgcmVwb3NpdG9yeVxuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRSZXBvc2l0b3J5JywgXG4gICAgICBwcm9wcy5yZXBvc2l0b3J5VXJpLnNwbGl0KCcvJykucG9wKCkhLnNwbGl0KCc6JylbMF1cbiAgICApO1xuXG4gICAgLy8gSW1wb3J0IGxvZyBncm91cFxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbG9ncy5Mb2dHcm91cC5mcm9tTG9nR3JvdXBOYW1lKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9nR3JvdXAnLFxuICAgICAgcHJvcHMubG9nR3JvdXBOYW1lXG4gICAgKTtcblxuICAgIC8vIEltcG9ydCBsb2FkIGJhbGFuY2VyIGFuZCBsaXN0ZW5lcnMgdXNpbmcgQVJOc1xuICAgIGNvbnN0IGxvYWRCYWxhbmNlciA9IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIuZnJvbUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyQXR0cmlidXRlcyhcbiAgICAgIHRoaXMsICdJbXBvcnRlZExvYWRCYWxhbmNlcicsXG4gICAgICB7IFxuICAgICAgICBsb2FkQmFsYW5jZXJBcm46IHByb3BzLmxvYWRCYWxhbmNlckFybixcbiAgICAgICAgc2VjdXJpdHlHcm91cElkOiBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXAuc2VjdXJpdHlHcm91cElkXG4gICAgICB9XG4gICAgKTtcblxuICAgIGNvbnN0IGh0dHBMaXN0ZW5lciA9IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lci5mcm9tQXBwbGljYXRpb25MaXN0ZW5lckF0dHJpYnV0ZXMoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRIdHRwTGlzdGVuZXInLFxuICAgICAgeyBcbiAgICAgICAgbGlzdGVuZXJBcm46IHByb3BzLmh0dHBMaXN0ZW5lckFybixcbiAgICAgICAgc2VjdXJpdHlHcm91cDogYXBwbGljYXRpb25TZWN1cml0eUdyb3VwXG4gICAgICB9XG4gICAgKTtcblxuICAgIGxldCBodHRwc0xpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyIHwgdW5kZWZpbmVkO1xuICAgIGlmIChwcm9wcy5odHRwc0xpc3RlbmVyQXJuKSB7XG4gICAgICBodHRwc0xpc3RlbmVyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyLmZyb21BcHBsaWNhdGlvbkxpc3RlbmVyQXR0cmlidXRlcyhcbiAgICAgICAgdGhpcywgJ0ltcG9ydGVkSHR0cHNMaXN0ZW5lcicsXG4gICAgICAgIHsgXG4gICAgICAgICAgbGlzdGVuZXJBcm46IHByb3BzLmh0dHBzTGlzdGVuZXJBcm4sXG4gICAgICAgICAgc2VjdXJpdHlHcm91cDogYXBwbGljYXRpb25TZWN1cml0eUdyb3VwXG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIElBTSByb2xlc1xuICAgIGNvbnN0IHsgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUgfSA9IHRoaXMuY3JlYXRlSWFtUm9sZXMocHJvcHMsIGxvZ0dyb3VwKTtcblxuICAgIC8vIENyZWF0ZSB0YXNrIGRlZmluaXRpb25cbiAgICB0aGlzLnRhc2tEZWZpbml0aW9uID0gdGhpcy5jcmVhdGVUYXNrRGVmaW5pdGlvbihwcm9wcywgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUpO1xuXG4gICAgLy8gQ3JlYXRlIGNvbnRhaW5lciBkZWZpbml0aW9uXG4gICAgdGhpcy5jb250YWluZXIgPSB0aGlzLmNyZWF0ZUNvbnRhaW5lckRlZmluaXRpb24ocHJvcHMsIHJlcG9zaXRvcnksIGxvZ0dyb3VwKTtcblxuICAgIC8vIENyZWF0ZSB0YXJnZXQgZ3JvdXBcbiAgICB0aGlzLnRhcmdldEdyb3VwID0gdGhpcy5jcmVhdGVUYXJnZXRHcm91cChwcm9wcywgdnBjLCBsb2FkQmFsYW5jZXIpO1xuXG4gICAgLy8gUnVuIGRhdGFiYXNlIG1pZ3JhdGlvbnMgYmVmb3JlIHN0YXJ0aW5nIHRoZSBzZXJ2aWNlXG4gICAgdGhpcy5ydW5NaWdyYXRpb25zKHByb3BzLCBjbHVzdGVyLCBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXApO1xuXG4gICAgLy8gQ3JlYXRlIEZhcmdhdGUgc2VydmljZVxuICAgIHRoaXMuc2VydmljZSA9IHRoaXMuY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHMsIGNsdXN0ZXIsIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cCk7XG5cbiAgICAvLyBDb25maWd1cmUgaGVhbHRoIGNoZWNrc1xuICAgIHRoaXMuY29uZmlndXJlSGVhbHRoQ2hlY2socHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIGF1dG8gc2NhbGluZyAoQ1BVIGFuZCBNZW1vcnkpXG4gICAgdGhpcy5zY2FsYWJsZVRhcmdldCA9IHRoaXMuY3JlYXRlQXV0b1NjYWxpbmcocHJvcHMpO1xuXG4gICAgLy8gQWRkIGxpc3RlbmVyIHJ1bGVzXG4gICAgdGhpcy5hZGRMaXN0ZW5lclJ1bGVzKGh0dHBMaXN0ZW5lciwgaHR0cHNMaXN0ZW5lcik7XG5cbiAgICAvLyBBZGQgcmVxdWVzdC1iYXNlZCBhdXRvIHNjYWxpbmcgYWZ0ZXIgbGlzdGVuZXIgcnVsZXMgYXJlIGNyZWF0ZWRcbiAgICB0aGlzLmFkZFJlcXVlc3RCYXNlZFNjYWxpbmcocHJvcHMpO1xuXG4gICAgLy8gU2V0dXAgUm91dGU1MyBETlMgcmVjb3JkcyAoaWYgZG9tYWluIGNvbmZpZ3VyZWQpXG4gICAgdGhpcy5zZXR1cFJvdXRlNTMocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIHN0YWNrIG91dHB1dHNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMocHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogc2VjcmV0c21hbmFnZXIuU2VjcmV0IHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IHRoaXMuc2VjcmV0c0xvYWRlci5sb2FkU2VjcmV0c1dpdGhGYWxsYmFjaygpO1xuICAgICAgXG4gICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hcHAtc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudGAsXG4gICAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHNlY3JldHMpLFxuICAgICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAnZ2VuZXJhdGVkX2F0JyxcbiAgICAgICAgICBpbmNsdWRlU3BhY2U6IGZhbHNlLFxuICAgICAgICAgIGV4Y2x1ZGVDaGFyYWN0ZXJzOiAnXCJAL1xcXFwnXG4gICAgICAgIH0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLLVNPUFMnKTtcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdDb21wb25lbnQnLCAnQXBwbGljYXRpb24tU2VjcmV0cycpO1xuICAgICAgXG4gICAgICByZXR1cm4gc2VjcmV0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBsb2FkIFNPUFMgc2VjcmV0cywgY3JlYXRpbmcgZW1wdHkgc2VjcmV0OiAke2Vycm9yfWApO1xuICAgICAgXG4gICAgICByZXR1cm4gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tYXBwLXNlY3JldHNgLFxuICAgICAgICBkZXNjcmlwdGlvbjogYEFwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnQgKGVtcHR5IC0gcG9wdWxhdGUgbWFudWFsbHkpYCxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUlhbVJvbGVzKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsIGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cCkge1xuICAgIC8vIFRhc2sgZXhlY3V0aW9uIHJvbGVcbiAgICBjb25zdCBleGVjdXRpb25Sb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUYXNrRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgcm9sZU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWV4ZWN1dGlvbi1yb2xlYCxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeScpLFxuICAgICAgXSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIEVDUkFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTZWNyZXRzTWFuYWdlckFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3RoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gVGFzayByb2xlXG4gICAgY29uc3QgdGFza1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICByb2xlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tdGFzay1yb2xlYCxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIENsb3VkV2F0Y2hMb2dzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm4gKyAnKiddLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICAgIFNlY3JldHNNYW5hZ2VyQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGV4ZWN1dGlvblJvbGUpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoZXhlY3V0aW9uUm9sZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLUV4ZWN1dGlvbi1Sb2xlJyk7XG4gICAgY2RrLlRhZ3Mub2YodGFza1JvbGUpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodGFza1JvbGUpLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1UYXNrLVJvbGUnKTtcblxuICAgIHJldHVybiB7IGV4ZWN1dGlvblJvbGUsIHRhc2tSb2xlIH07XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVRhc2tEZWZpbml0aW9uKFxuICAgIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsXG4gICAgZXhlY3V0aW9uUm9sZTogaWFtLlJvbGUsXG4gICAgdGFza1JvbGU6IGlhbS5Sb2xlXG4gICk6IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24ge1xuICAgIGNvbnN0IHRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ1Rhc2tEZWZpbml0aW9uJywge1xuICAgICAgZmFtaWx5OiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBjcHU6IHByb3BzLmNwdSB8fCAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogcHJvcHMubWVtb3J5TGltaXRNaUIgfHwgNTEyLFxuICAgICAgZXhlY3V0aW9uUm9sZSxcbiAgICAgIHRhc2tSb2xlLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRtcGZzIHZvbHVtZXMgaWYgcmVhZC1vbmx5IHJvb3QgZmlsZXN5c3RlbSBpcyBlbmFibGVkXG4gICAgaWYgKHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICd0bXAtdm9sdW1lJyxcbiAgICAgICAgaG9zdDoge30sXG4gICAgICB9KTtcblxuICAgICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgaG9zdDoge30sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHRhc2tEZWZpbml0aW9uKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHRhc2tEZWZpbml0aW9uKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtVGFzay1EZWZpbml0aW9uJyk7XG5cbiAgICByZXR1cm4gdGFza0RlZmluaXRpb247XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbnRhaW5lckRlZmluaXRpb24oXG4gICAgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyxcbiAgICByZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnksXG4gICAgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwXG4gICk6IGVjcy5Db250YWluZXJEZWZpbml0aW9uIHtcbiAgICAvLyBQcmVwYXJlIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgIGNvbnN0IGVudmlyb25tZW50ID0ge1xuICAgICAgUkVRVUlSRURfU0VUVElORzogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICBBV1NfREVGQVVMVF9SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgLi4ucHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgfTtcblxuICAgIC8vIENyZWF0ZSBjb250YWluZXJcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLnRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcigndGVzdGFwcC1jb250YWluZXInLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHJlcG9zaXRvcnksIHByb3BzLnRhc2tJbWFnZVRhZyB8fCAnbGF0ZXN0JyksXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAndGVzdGFwcCcsXG4gICAgICAgIGxvZ0dyb3VwLFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudCxcbiAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgU0VDUkVUX0tFWTogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIodGhpcy5hcHBTZWNyZXRzLCAnc2VjcmV0X2tleScpLFxuICAgICAgfSxcbiAgICAgIC8vIENvbnRhaW5lciBzZWN1cml0eSBzZXR0aW5nc1xuICAgICAgdXNlcjogcHJvcHMuZW5hYmxlTm9uUm9vdENvbnRhaW5lciA/ICcxMDAxOjEwMDEnIDogdW5kZWZpbmVkLFxuICAgICAgcmVhZG9ubHlSb290RmlsZXN5c3RlbTogcHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSB8fCBmYWxzZSxcbiAgICAgIC8vIFJlc291cmNlIGxpbWl0cyBmb3Igc2VjdXJpdHkgYW5kIHBlcmZvcm1hbmNlXG4gICAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogTWF0aC5mbG9vcigocHJvcHMubWVtb3J5TGltaXRNaUIgfHwgNTEyKSAqIDAuOCksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcG9ydCBtYXBwaW5nXG4gICAgY29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7XG4gICAgICBjb250YWluZXJQb3J0OiBwcm9wcy5jb250YWluZXJQb3J0IHx8IDgwMDAsXG4gICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICAgIG5hbWU6ICdodHRwJyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBtb3VudCBwb2ludHMgZm9yIHRtcGZzIHZvbHVtZXMgaWYgcmVhZC1vbmx5IGZpbGVzeXN0ZW0gaXMgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtKSB7XG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBzb3VyY2VWb2x1bWU6ICd0bXAtdm9sdW1lJyxcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy90bXAnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcblxuICAgICAgY29udGFpbmVyLmFkZE1vdW50UG9pbnRzKHtcbiAgICAgICAgc291cmNlVm9sdW1lOiAnbG9ncy12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL2FwcC9sb2dzJyxcbiAgICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbnRhaW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVGFyZ2V0R3JvdXAocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcywgdnBjOiBlYzIuSVZwYywgbG9hZEJhbGFuY2VyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcik6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25UYXJnZXRHcm91cCB7XG4gICAgY29uc3QgdGFyZ2V0R3JvdXAgPSBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwKHRoaXMsICdUYXJnZXRHcm91cCcsIHtcbiAgICAgIHRhcmdldEdyb3VwTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tdGdgLFxuICAgICAgcG9ydDogcHJvcHMuY29udGFpbmVyUG9ydCB8fCA4MDAwLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdnBjLFxuICAgICAgdGFyZ2V0VHlwZTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5UYXJnZXRUeXBlLklQLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgcGF0aDogcHJvcHMuaGVhbHRoQ2hlY2tQYXRoIHx8ICcvaGVhbHRoLycsXG4gICAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlByb3RvY29sLkhUVFAsXG4gICAgICAgIHBvcnQ6ICd0cmFmZmljLXBvcnQnLFxuICAgICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHByb3BzLmhlYWx0aENoZWNrSW50ZXJ2YWwgfHwgMzApLFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyhwcm9wcy5oZWFsdGhDaGVja1RpbWVvdXQgfHwgNSksXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogcHJvcHMuaGVhbHRoeVRocmVzaG9sZENvdW50IHx8IDIsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiBwcm9wcy51bmhlYWx0aHlUaHJlc2hvbGRDb3VudCB8fCAzLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YodGFyZ2V0R3JvdXApLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodGFyZ2V0R3JvdXApLmFkZCgnQ29tcG9uZW50JywgJ0FwcGxpY2F0aW9uLVRhcmdldEdyb3VwJyk7XG5cbiAgICByZXR1cm4gdGFyZ2V0R3JvdXA7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUZhcmdhdGVTZXJ2aWNlKFxuICAgIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsXG4gICAgY2x1c3RlcjogZWNzLklDbHVzdGVyLFxuICAgIHNlY3VyaXR5R3JvdXA6IGVjMi5JU2VjdXJpdHlHcm91cFxuICApOiBlY3MuRmFyZ2F0ZVNlcnZpY2Uge1xuICAgIGNvbnN0IHNlcnZpY2VOYW1lID0gcHJvcHMuc2VydmljZU5hbWUgfHwgYHRlc3RhcHAtc2VydmljZS0ke3Byb3BzLmVudmlyb25tZW50fWA7XG5cbiAgICBjb25zdCBzZXJ2aWNlID0gbmV3IGVjcy5GYXJnYXRlU2VydmljZSh0aGlzLCAnRmFyZ2F0ZVNlcnZpY2UnLCB7XG4gICAgICBjbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb246IHRoaXMudGFza0RlZmluaXRpb24sXG4gICAgICBzZXJ2aWNlTmFtZSxcbiAgICAgIGRlc2lyZWRDb3VudDogcHJvcHMuZGVzaXJlZENvdW50IHx8IDEsXG4gICAgICBzZWN1cml0eUdyb3VwczogW3NlY3VyaXR5R3JvdXBdLFxuICAgICAgYXNzaWduUHVibGljSXA6IGZhbHNlLCAvLyBSdW5uaW5nIGluIHByaXZhdGUgc3VibmV0c1xuICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHByb3BzLmVudmlyb25tZW50ICE9PSAncHJvZHVjdGlvbicsIC8vIEVuYWJsZSBFQ1MgRXhlYyBmb3IgZGV2L3N0YWdpbmdcbiAgICAgIC8vIERlcGxveW1lbnQgY29uZmlndXJhdGlvbiBmb3IgemVyby1kb3dudGltZSBkZXBsb3ltZW50cyBpbiBwcm9kdWN0aW9uXG4gICAgICBtaW5IZWFsdGh5UGVyY2VudDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDEwMCA6IDUwLFxuICAgICAgbWF4SGVhbHRoeVBlcmNlbnQ6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAyMDAgOiAxNTAsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmUgc2VydmljZSBsb2FkIGJhbGFuY2Vyc1xuICAgIHNlcnZpY2UuYXR0YWNoVG9BcHBsaWNhdGlvblRhcmdldEdyb3VwKHRoaXMudGFyZ2V0R3JvdXApO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihzZXJ2aWNlKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHNlcnZpY2UpLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1TZXJ2aWNlJyk7XG5cbiAgICByZXR1cm4gc2VydmljZTtcbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlSGVhbHRoQ2hlY2socHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIEhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uIGlzIGFscmVhZHkgc2V0IGluIHRhcmdldCBncm91cCBjcmVhdGlvblxuICAgIC8vIFRoaXMgbWV0aG9kIGNhbiBiZSBleHRlbmRlZCBmb3IgYWRkaXRpb25hbCBoZWFsdGggY2hlY2sgY29uZmlndXJhdGlvbnNcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQXV0b1NjYWxpbmcocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyk6IGVjcy5TY2FsYWJsZVRhc2tDb3VudCB7XG4gICAgY29uc3QgbWluQ2FwYWNpdHkgPSBwcm9wcy5taW5DYXBhY2l0eSB8fCBwcm9wcy5kZXNpcmVkQ291bnQgfHwgMTtcbiAgICBjb25zdCBtYXhDYXBhY2l0eSA9IHByb3BzLm1heENhcGFjaXR5IHx8IChwcm9wcy5kZXNpcmVkQ291bnQgfHwgMSkgKiAzO1xuXG4gICAgY29uc3Qgc2NhbGFibGVUYXJnZXQgPSB0aGlzLnNlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5LFxuICAgICAgbWF4Q2FwYWNpdHksXG4gICAgfSk7XG5cbiAgICAvLyBDUFUtYmFzZWQgYXV0byBzY2FsaW5nXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbkNwdVV0aWxpemF0aW9uKCdDcHVTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiBwcm9wcy5jcHVUYXJnZXRVdGlsaXphdGlvbiB8fCA3MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVJbkNvb2xkb3duTWludXRlcyB8fCA1KSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKHByb3BzLnNjYWxlT3V0Q29vbGRvd25NaW51dGVzIHx8IDIpLFxuICAgIH0pO1xuXG4gICAgLy8gTWVtb3J5LWJhc2VkIGF1dG8gc2NhbGluZ1xuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25NZW1vcnlVdGlsaXphdGlvbignTWVtb3J5U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogcHJvcHMubWVtb3J5VGFyZ2V0VXRpbGl6YXRpb24gfHwgODAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKHByb3BzLnNjYWxlSW5Db29sZG93bk1pbnV0ZXMgfHwgNSksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZU91dENvb2xkb3duTWludXRlcyB8fCAyKSxcbiAgICB9KTtcblxuICAgIHJldHVybiBzY2FsYWJsZVRhcmdldDtcbiAgfVxuXG4gIHByaXZhdGUgYWRkUmVxdWVzdEJhc2VkU2NhbGluZyhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnNjYWxhYmxlVGFyZ2V0IHx8ICF0aGlzLnRhcmdldEdyb3VwKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ+KaoO+4jyAgQ2Fubm90IGNvbmZpZ3VyZSByZXF1ZXN0LWJhc2VkIHNjYWxpbmc6IHNjYWxhYmxlVGFyZ2V0IG9yIHRhcmdldEdyb3VwIG5vdCBhdmFpbGFibGUnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBSZXF1ZXN0LWJhc2VkIGF1dG8gc2NhbGluZyB1c2luZyBBTEIgUmVxdWVzdENvdW50UGVyVGFyZ2V0IG1ldHJpY1xuICAgIHRoaXMuc2NhbGFibGVUYXJnZXQuc2NhbGVPblJlcXVlc3RDb3VudCgnUmVxdWVzdFNjYWxpbmcnLCB7XG4gICAgICByZXF1ZXN0c1BlclRhcmdldDogcHJvcHMucmVxdWVzdHNQZXJUYXJnZXQgfHwgMTAwMCxcbiAgICAgIHRhcmdldEdyb3VwOiB0aGlzLnRhcmdldEdyb3VwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZUluQ29vbGRvd25NaW51dGVzIHx8IDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVPdXRDb29sZG93bk1pbnV0ZXMgfHwgMiksXG4gICAgfSk7XG5cbiAgICBjb25zb2xlLmxvZyhg4pyFIFJlcXVlc3QtYmFzZWQgYXV0byBzY2FsaW5nIGNvbmZpZ3VyZWQ6ICR7cHJvcHMucmVxdWVzdHNQZXJUYXJnZXQgfHwgMTAwMH0gcmVxdWVzdHMgcGVyIHRhcmdldGApO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRMaXN0ZW5lclJ1bGVzKFxuICAgIGh0dHBMaXN0ZW5lcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5JQXBwbGljYXRpb25MaXN0ZW5lcixcbiAgICBodHRwc0xpc3RlbmVyPzogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5JQXBwbGljYXRpb25MaXN0ZW5lclxuICApOiB2b2lkIHtcbiAgICAvLyBBZGQgcnVsZSB0byBIVFRQIGxpc3RlbmVyXG4gICAgbmV3IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lclJ1bGUodGhpcywgJ0h0dHBMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICBsaXN0ZW5lcjogaHR0cExpc3RlbmVyLFxuICAgICAgcHJpb3JpdHk6IDEwMCxcbiAgICAgIGNvbmRpdGlvbnM6IFtcbiAgICAgICAgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckNvbmRpdGlvbi5wYXRoUGF0dGVybnMoWycqJ10pLFxuICAgICAgXSxcbiAgICAgIGFjdGlvbjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckFjdGlvbi5mb3J3YXJkKFt0aGlzLnRhcmdldEdyb3VwXSksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcnVsZSB0byBIVFRQUyBsaXN0ZW5lciBpZiBpdCBleGlzdHNcbiAgICBpZiAoaHR0cHNMaXN0ZW5lcikge1xuICAgICAgbmV3IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lclJ1bGUodGhpcywgJ0h0dHBzTGlzdGVuZXJSdWxlJywge1xuICAgICAgICBsaXN0ZW5lcjogaHR0cHNMaXN0ZW5lcixcbiAgICAgICAgcHJpb3JpdHk6IDEwMCxcbiAgICAgICAgY29uZGl0aW9uczogW1xuICAgICAgICAgIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJDb25kaXRpb24ucGF0aFBhdHRlcm5zKFsnKiddKSxcbiAgICAgICAgXSxcbiAgICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZvcndhcmQoW3RoaXMudGFyZ2V0R3JvdXBdKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgc2V0dXBSb3V0ZTUzKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICBjb25zdCBkb21haW5OYW1lID0gdGhpcy5nZXREb21haW5OYW1lKHByb3BzKTtcbiAgICBpZiAoIWRvbWFpbk5hbWUgfHwgIXByb3BzLmhvc3RlZFpvbmVJZCB8fCAhcHJvcHMuYmFzZURvbWFpbikgcmV0dXJuO1xuXG4gICAgLy8gSW1wb3J0IGV4aXN0aW5nIGhvc3RlZCB6b25lXG4gICAgdGhpcy5ob3N0ZWRab25lID0gcm91dGU1My5Ib3N0ZWRab25lLmZyb21Ib3N0ZWRab25lQXR0cmlidXRlcyh0aGlzLCAnSG9zdGVkWm9uZScsIHtcbiAgICAgIGhvc3RlZFpvbmVJZDogcHJvcHMuaG9zdGVkWm9uZUlkLFxuICAgICAgem9uZU5hbWU6IHByb3BzLmJhc2VEb21haW4sXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgbG9hZCBiYWxhbmNlciBmb3IgRE5TIHRhcmdldFxuICAgIGNvbnN0IGxvYWRCYWxhbmNlciA9IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIuZnJvbUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyQXR0cmlidXRlcyhcbiAgICAgIHRoaXMsICdJbXBvcnRlZExvYWRCYWxhbmNlcicsXG4gICAgICB7XG4gICAgICAgIGxvYWRCYWxhbmNlckFybjogcHJvcHMubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgICBzZWN1cml0eUdyb3VwSWQ6ICcnLCAvLyBOb3QgbmVlZGVkIGZvciBETlMgcmVjb3JkIGNyZWF0aW9uXG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBBIHJlY29yZCBmb3IgdGhlIGRvbWFpblxuICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgJ0Ruc0FSZWNvcmQnLCB7XG4gICAgICB6b25lOiB0aGlzLmhvc3RlZFpvbmUsXG4gICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMoXG4gICAgICAgIG5ldyByb3V0ZTUzdGFyZ2V0cy5Mb2FkQmFsYW5jZXJUYXJnZXQobG9hZEJhbGFuY2VyKVxuICAgICAgKSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBBQUFBIHJlY29yZCBmb3IgSVB2NiAoaWYgQUxCIHN1cHBvcnRzIGl0KVxuICAgIG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgJ0Ruc0FhYWFSZWNvcmQnLCB7XG4gICAgICB6b25lOiB0aGlzLmhvc3RlZFpvbmUsXG4gICAgICByZWNvcmROYW1lOiBkb21haW5OYW1lLFxuICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMoXG4gICAgICAgIG5ldyByb3V0ZTUzdGFyZ2V0cy5Mb2FkQmFsYW5jZXJUYXJnZXQobG9hZEJhbGFuY2VyKVxuICAgICAgKSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgcnVuTWlncmF0aW9ucyhcbiAgICBwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLCBcbiAgICBjbHVzdGVyOiBlY3MuSUNsdXN0ZXIsIFxuICAgIHNlY3VyaXR5R3JvdXA6IGVjMi5JU2VjdXJpdHlHcm91cFxuICApOiB2b2lkIHtcbiAgICAvLyBDcmVhdGUgYSBzZXBhcmF0ZSB0YXNrIGRlZmluaXRpb24gZm9yIG1pZ3JhdGlvbnNcbiAgICBjb25zdCBtaWdyYXRpb25UYXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdNaWdyYXRpb25UYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIGZhbWlseTogYHRlc3RhcHAtbWlncmF0aW9uLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGNwdTogcHJvcHMuY3B1IHx8IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIsXG4gICAgICBleGVjdXRpb25Sb2xlOiB0aGlzLnRhc2tEZWZpbml0aW9uLmV4ZWN1dGlvblJvbGUhLFxuICAgICAgdGFza1JvbGU6IHRoaXMudGFza0RlZmluaXRpb24udGFza1JvbGUhLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IGxvZyBncm91cCBhbmQgcmVwb3NpdG9yeSAoYWxyZWFkeSBjcmVhdGVkKVxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbG9ncy5Mb2dHcm91cC5mcm9tTG9nR3JvdXBOYW1lKHRoaXMsICdJbXBvcnRlZE1pZ3JhdGlvbkxvZ0dyb3VwJywgcHJvcHMubG9nR3JvdXBOYW1lKTtcbiAgICBjb25zdCByZXBvc2l0b3J5ID0gZWNyLlJlcG9zaXRvcnkuZnJvbVJlcG9zaXRvcnlOYW1lKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTWlncmF0aW9uUmVwb3NpdG9yeScsIFxuICAgICAgcHJvcHMucmVwb3NpdG9yeVVyaS5zcGxpdCgnLycpLnBvcCgpIS5zcGxpdCgnOicpWzBdXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBtaWdyYXRpb24gY29udGFpbmVyIHdpdGggc2FtZSBlbnZpcm9ubWVudCBhcyBtYWluIGFwcCBidXQgZGlmZmVyZW50IGNvbW1hbmRcbiAgICBjb25zdCBtaWdyYXRpb25Db250YWluZXIgPSBtaWdyYXRpb25UYXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ01pZ3JhdGlvbkNvbnRhaW5lcicsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocmVwb3NpdG9yeSwgcHJvcHMudGFza0ltYWdlVGFnIHx8ICdsYXRlc3QnKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFJFUVVJUkVEX1NFVFRJTkc6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgIC4uLnByb3BzLmVudmlyb25tZW50VmFyaWFibGVzLFxuICAgICAgfSxcbiAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgU0VDUkVUX0tFWTogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIodGhpcy5hcHBTZWNyZXRzLCAnc2VjcmV0X2tleScpLFxuICAgICAgICBKV1RfU0VDUkVUOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdqd3Rfc2VjcmV0JyksXG4gICAgICB9LFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIGxvZ0dyb3VwLFxuICAgICAgICBzdHJlYW1QcmVmaXg6ICdtaWdyYXRpb24nLFxuICAgICAgfSksXG4gICAgICAvLyBPdmVycmlkZSB0aGUgZGVmYXVsdCBjb21tYW5kIHRvIHJ1biBtaWdyYXRpb25zXG4gICAgICBjb21tYW5kOiBbJy9vcHQvdmVudi9iaW4vcHl0aG9uJywgJ21hbmFnZS5weScsICdtaWdyYXRlJ10sXG4gICAgICBlc3NlbnRpYWw6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgc2VjdXJpdHkgY29uZmlndXJhdGlvblxuICAgIGlmIChwcm9wcy5lbmFibGVOb25Sb290Q29udGFpbmVyKSB7XG4gICAgICBtaWdyYXRpb25Db250YWluZXIuYWRkVG9FeGVjdXRpb25Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnZWNzOlJ1blRhc2snXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbbWlncmF0aW9uVGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm5dLFxuICAgICAgfSkpO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YobWlncmF0aW9uVGFza0RlZmluaXRpb24pLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YobWlncmF0aW9uVGFza0RlZmluaXRpb24pLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1NaWdyYXRpb24tVGFzaycpO1xuICAgIGNkay5UYWdzLm9mKG1pZ3JhdGlvblRhc2tEZWZpbml0aW9uKS5hZGQoJ1B1cnBvc2UnLCAnRGF0YWJhc2UtTWlncmF0aW9uJyk7XG5cbiAgICAvLyBPdXRwdXQgbWlncmF0aW9uIHRhc2sgZGVmaW5pdGlvbiBBUk4gZm9yIHVzZSBpbiB3b3JrZmxvd3NcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTWlncmF0aW9uVGFza0RlZmluaXRpb25Bcm4nLCB7XG4gICAgICB2YWx1ZTogbWlncmF0aW9uVGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ01pZ3JhdGlvbiBUYXNrIERlZmluaXRpb24gQVJOIGZvciBydW5uaW5nIGRhdGFiYXNlIG1pZ3JhdGlvbnMnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1pZ3JhdGlvblRhc2tEZWZpbml0aW9uQXJuYCxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlT3V0cHV0cyhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gU2VydmljZSBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlcnZpY2VBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5zZXJ2aWNlLnNlcnZpY2VBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VydmljZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VydmljZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5zZXJ2aWNlLnNlcnZpY2VOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgU2VydmljZSBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZXJ2aWNlTmFtZWAsXG4gICAgfSk7XG5cbiAgICAvLyBUYXNrIERlZmluaXRpb24gb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXNrRGVmaW5pdGlvbkFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhc2tEZWZpbml0aW9uLnRhc2tEZWZpbml0aW9uQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgVGFzayBEZWZpbml0aW9uIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFza0RlZmluaXRpb25Bcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tEZWZpbml0aW9uRmFtaWx5Jywge1xuICAgICAgdmFsdWU6IHRoaXMudGFza0RlZmluaXRpb24uZmFtaWx5LFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgVGFzayBEZWZpbml0aW9uIEZhbWlseScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFza0RlZmluaXRpb25GYW1pbHlgLFxuICAgIH0pO1xuXG4gICAgLy8gVGFyZ2V0IEdyb3VwIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFyZ2V0R3JvdXBBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YXJnZXRHcm91cC50YXJnZXRHcm91cEFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVGFyZ2V0IEdyb3VwIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFyZ2V0R3JvdXBBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RhcmdldEdyb3VwTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhcmdldEdyb3VwLnRhcmdldEdyb3VwTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVGFyZ2V0IEdyb3VwIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVRhcmdldEdyb3VwTmFtZWAsXG4gICAgfSk7XG5cbiAgICAvLyBTZWNyZXRzIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VjcmV0c0FybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFwcFNlY3JldHMuc2VjcmV0QXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBTZWNyZXRzIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VjcmV0c0FybmAsXG4gICAgfSk7XG5cbiAgICAvLyBBdXRvIFNjYWxpbmcgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBdXRvU2NhbGluZ1RhcmdldElkJywge1xuICAgICAgdmFsdWU6IGBzZXJ2aWNlLyR7dGhpcy5zZXJ2aWNlLmNsdXN0ZXIuY2x1c3Rlck5hbWV9LyR7dGhpcy5zZXJ2aWNlLnNlcnZpY2VOYW1lfWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0F1dG8gU2NhbGluZyBUYXJnZXQgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUF1dG9TY2FsaW5nVGFyZ2V0SWRgLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJhdGlvbiBvdXRwdXRzIGZvciByZWZlcmVuY2VcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRGVzaXJlZENvdW50Jywge1xuICAgICAgdmFsdWU6IChwcm9wcy5kZXNpcmVkQ291bnQgfHwgMSkudG9TdHJpbmcoKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ3VycmVudCBEZXNpcmVkIENvdW50JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXNrQ3B1Jywge1xuICAgICAgdmFsdWU6IChwcm9wcy5jcHUgfHwgMjU2KS50b1N0cmluZygpLFxuICAgICAgZGVzY3JpcHRpb246ICdUYXNrIENQVSBVbml0cycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza01lbW9yeScsIHtcbiAgICAgIHZhbHVlOiAocHJvcHMubWVtb3J5TGltaXRNaUIgfHwgNTEyKS50b1N0cmluZygpLFxuICAgICAgZGVzY3JpcHRpb246ICdUYXNrIE1lbW9yeSAoTWlCKScsXG4gICAgfSk7XG5cbiAgICAvLyBBcHBsaWNhdGlvbiBVUkwgb3V0cHV0XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IHRoaXMuZ2V0RG9tYWluTmFtZShwcm9wcyk7XG4gICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgIGNvbnN0IHByb3RvY29sID0gcHJvcHMuaHR0cHNMaXN0ZW5lckFybiA/ICdodHRwcycgOiAnaHR0cCc7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICAgIHZhbHVlOiBgJHtwcm90b2NvbH06Ly8ke2RvbWFpbk5hbWV9YCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBVUkwgd2l0aCBjdXN0b20gZG9tYWluJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUFwcGxpY2F0aW9uVXJsYCxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBGYWxsYmFjayB0byBBTEIgRE5TIG5hbWUgKGltcG9ydGVkIGZyb20gcGxhdGZvcm0gc3RhY2spXG4gICAgICBjb25zdCBhbGJEbnMgPSBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7cHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/ICdUZXN0QXBwLVBsYXRmb3JtLXByb2R1Y3Rpb24nIDogYFRlc3RBcHAtUGxhdGZvcm0tJHtwcm9wcy5lbnZpcm9ubWVudH1gfS1Mb2FkQmFsYW5jZXJETlNgKTtcbiAgICAgIGNvbnN0IHByb3RvY29sID0gcHJvcHMuaHR0cHNMaXN0ZW5lckFybiA/ICdodHRwcycgOiAnaHR0cCc7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICAgIHZhbHVlOiBgJHtwcm90b2NvbH06Ly8ke2FsYkRuc31gLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFVSTCAoQUxCIEROUyknLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQXBwbGljYXRpb25VcmxgLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59Il19