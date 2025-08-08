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
        // Create auto scaling
        this.scalableTarget = this.createAutoScaling(props);
        // Add listener rules
        this.addListenerRules(httpListener, httpsListener);
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
        // Note: Request-based auto scaling using scaleOnRequestCount requires the target group 
        // to be attached to a load balancer first. Since we're creating listener rules after 
        // the auto scaling setup, we'll skip request-based scaling for now.
        // This can be added as a separate construct after the listener rules are created.
        return scalableTarget;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHBsaWNhdGlvbi1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLDJDQUEyQztBQUMzQyxpRkFBaUY7QUFDakYsaUVBQWlFO0FBR2pFLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFFbEUscURBQWlEO0FBaURqRCxNQUFhLGdCQUFpQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBVTdDOztPQUVHO0lBQ0ssYUFBYSxDQUFDLEtBQTRCO1FBQ2hELElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU87WUFBRSxPQUFPLFNBQVMsQ0FBQztRQUUxRCxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUU7WUFDZCx3REFBd0Q7WUFDeEQsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxPQUFPLENBQUMsY0FBYyxFQUFFLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZGLE9BQU8sTUFBTSxhQUFhLElBQUksS0FBSyxDQUFDLE9BQU8sSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7U0FDbkU7YUFBTTtZQUNMLHVCQUF1QjtZQUN2QixPQUFPLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWTtnQkFDdkMsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQW9CLGlDQUFpQztnQkFDN0YsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxLQUFLLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDLHFDQUFxQztTQUN2RztJQUNILENBQUM7SUFFRCxZQUFZLEtBQWdCLEVBQUUs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Q0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7WUFDM0QsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtnQkFDeEMsS0FBSyxFQUFFLEdBQUcsUUFBUSxNQUFNLFVBQVUsRUFBRTtnQkFDcEMsV0FBVyxFQUFFLG9DQUFvQztnQkFDakQsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsaUJBQWlCO2FBQy9DLENBQUMsQ0FBQztTQUNKO2FBQU07WUFDTCwwREFBMEQ7WUFDMUQsTUFBTSxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsR0FBRyxLQUFLLENBQUMsV0FBVyxLQUFLLFlBQVksQ0FBQyxDQUFDLENBQUMsNkJBQTZCLENBQUMsQ0FBQyxDQUFDLG9CQUFvQixLQUFLLENBQUMsV0FBVyxFQUFFLGtCQUFrQixDQUFDLENBQUM7WUFDckssTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztZQUMzRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO2dCQUN4QyxLQUFLLEVBQUUsR0FBRyxRQUFRLE1BQU0sTUFBTSxFQUFFO2dCQUNoQyxXQUFXLEVBQUUsMkJBQTJCO2dCQUN4QyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxpQkFBaUI7YUFDL0MsQ0FBQyxDQUFDO1NBQ0o7SUFDSCxDQUFDO0NBQ0Y7QUF4b0JELDRDQXdvQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwcGxpY2F0aW9uYXV0b3NjYWxpbmcnO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1Myc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU2VjcmV0c0xvYWRlciB9IGZyb20gJy4vc2VjcmV0cy1sb2FkZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcGxpY2F0aW9uU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgLy8gVlBDIGNvbmZpZ3VyYXRpb25cbiAgdnBjSWQ6IHN0cmluZztcbiAgcHJpdmF0ZVN1Ym5ldElkczogc3RyaW5nW107XG4gIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkOiBzdHJpbmc7XG4gIC8vIEVDUyBQbGF0Zm9ybSBjb25maWd1cmF0aW9uXG4gIGNsdXN0ZXJBcm46IHN0cmluZztcbiAgY2x1c3Rlck5hbWU6IHN0cmluZztcbiAgcmVwb3NpdG9yeVVyaTogc3RyaW5nO1xuICBsb2FkQmFsYW5jZXJBcm46IHN0cmluZztcbiAgaHR0cExpc3RlbmVyQXJuOiBzdHJpbmc7XG4gIGh0dHBzTGlzdGVuZXJBcm4/OiBzdHJpbmc7XG4gIGxvZ0dyb3VwTmFtZTogc3RyaW5nO1xuICBsb2dHcm91cEFybjogc3RyaW5nO1xuICAvLyBBcHBsaWNhdGlvbiBjb25maWd1cmF0aW9uXG4gIHNlcnZpY2VOYW1lPzogc3RyaW5nO1xuICB0YXNrSW1hZ2VUYWc/OiBzdHJpbmc7XG4gIGRlc2lyZWRDb3VudD86IG51bWJlcjtcbiAgY3B1PzogbnVtYmVyO1xuICBtZW1vcnlMaW1pdE1pQj86IG51bWJlcjtcbiAgY29udGFpbmVyUG9ydD86IG51bWJlcjtcbiAgLy8gQXV0byBzY2FsaW5nIGNvbmZpZ3VyYXRpb25cbiAgbWluQ2FwYWNpdHk/OiBudW1iZXI7XG4gIG1heENhcGFjaXR5PzogbnVtYmVyO1xuICBjcHVUYXJnZXRVdGlsaXphdGlvbj86IG51bWJlcjtcbiAgbWVtb3J5VGFyZ2V0VXRpbGl6YXRpb24/OiBudW1iZXI7XG4gIHNjYWxlSW5Db29sZG93bk1pbnV0ZXM/OiBudW1iZXI7XG4gIHNjYWxlT3V0Q29vbGRvd25NaW51dGVzPzogbnVtYmVyO1xuICAvLyBIZWFsdGggY2hlY2sgY29uZmlndXJhdGlvblxuICBoZWFsdGhDaGVja1BhdGg/OiBzdHJpbmc7XG4gIGhlYWx0aENoZWNrSW50ZXJ2YWw/OiBudW1iZXI7XG4gIGhlYWx0aENoZWNrVGltZW91dD86IG51bWJlcjtcbiAgaGVhbHRoeVRocmVzaG9sZENvdW50PzogbnVtYmVyO1xuICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudD86IG51bWJlcjtcbiAgLy8gQ29udGFpbmVyIHNlY3VyaXR5XG4gIGVuYWJsZU5vblJvb3RDb250YWluZXI/OiBib29sZWFuO1xuICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtPzogYm9vbGVhbjtcbiAgLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG4gIGVudmlyb25tZW50VmFyaWFibGVzPzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcbiAgLy8gRG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgYmFzZURvbWFpbj86IHN0cmluZztcbiAgYXBwTmFtZT86IHN0cmluZztcbiAgcHJJZD86IHN0cmluZztcbiAgaG9zdGVkWm9uZUlkPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwbGljYXRpb25TdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBzZXJ2aWNlOiBlY3MuRmFyZ2F0ZVNlcnZpY2U7XG4gIHB1YmxpYyByZWFkb25seSB0YXNrRGVmaW5pdGlvbjogZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNvbnRhaW5lcjogZWNzLkNvbnRhaW5lckRlZmluaXRpb247XG4gIHB1YmxpYyByZWFkb25seSB0YXJnZXRHcm91cDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgc2NhbGFibGVUYXJnZXQ6IGVjcy5TY2FsYWJsZVRhc2tDb3VudDtcbiAgcHVibGljIHJlYWRvbmx5IGFwcFNlY3JldHM6IHNlY3JldHNtYW5hZ2VyLlNlY3JldDtcbiAgcHJpdmF0ZSByZWFkb25seSBzZWNyZXRzTG9hZGVyOiBTZWNyZXRzTG9hZGVyO1xuICBwcml2YXRlIGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBDb25zdHJ1Y3RzIHRoZSBkb21haW4gbmFtZSBkeW5hbWljYWxseSBiYXNlZCBvbiBhcHAsIGVudmlyb25tZW50LCBhbmQgUFIgY29udGV4dFxuICAgKi9cbiAgcHJpdmF0ZSBnZXREb21haW5OYW1lKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIGlmICghcHJvcHMuYmFzZURvbWFpbiB8fCAhcHJvcHMuYXBwTmFtZSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgIGlmIChwcm9wcy5wcklkKSB7XG4gICAgICAvLyBQUiBkZXBsb3ltZW50czogcHItMTIzLXRlc3RhcHAuYXNzZXNzbWVudC5lbGlvLmV0aS5iclxuICAgICAgY29uc3Qgc2FuaXRpemVkUHJJZCA9IHByb3BzLnBySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCk7XG4gICAgICByZXR1cm4gYHByLSR7c2FuaXRpemVkUHJJZH0tJHtwcm9wcy5hcHBOYW1lfS4ke3Byb3BzLmJhc2VEb21haW59YDtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUmVndWxhciBlbnZpcm9ubWVudHNcbiAgICAgIHJldHVybiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nXG4gICAgICAgID8gYCR7cHJvcHMuYXBwTmFtZX0uJHtwcm9wcy5iYXNlRG9tYWlufWAgICAgICAgICAgICAgICAgICAgIC8vIHRlc3RhcHAuYXNzZXNzbWVudC5lbGlvLmV0aS5iclxuICAgICAgICA6IGAke3Byb3BzLmVudmlyb25tZW50fS0ke3Byb3BzLmFwcE5hbWV9LiR7cHJvcHMuYmFzZURvbWFpbn1gOyAvLyBkZXYtdGVzdGFwcC5hc3Nlc3NtZW50LmVsaW8uZXRpLmJyXG4gICAgfVxuICB9XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzZWNyZXRzIGxvYWRlclxuICAgIHRoaXMuc2VjcmV0c0xvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKHByb3BzLmVudmlyb25tZW50KTtcbiAgICBcbiAgICAvLyBDcmVhdGUgQVdTIFNlY3JldHMgTWFuYWdlciBzZWNyZXQgZnJvbSBTT1BTXG4gICAgdGhpcy5hcHBTZWNyZXRzID0gdGhpcy5jcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wcyk7XG5cbiAgICAvLyBJbXBvcnQgVlBDIGFuZCBzdWJuZXRzXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tVnBjQXR0cmlidXRlcyh0aGlzLCAnSW1wb3J0ZWRWcGMnLCB7XG4gICAgICB2cGNJZDogcHJvcHMudnBjSWQsXG4gICAgICBhdmFpbGFiaWxpdHlab25lczogY2RrLkZuLmdldEF6cygpLFxuICAgICAgcHJpdmF0ZVN1Ym5ldElkczogcHJvcHMucHJpdmF0ZVN1Ym5ldElkcyxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBhcHBsaWNhdGlvbiBzZWN1cml0eSBncm91cFxuICAgIGNvbnN0IGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cCA9IGVjMi5TZWN1cml0eUdyb3VwLmZyb21TZWN1cml0eUdyb3VwSWQoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRBcHBsaWNhdGlvblNlY3VyaXR5R3JvdXAnLFxuICAgICAgcHJvcHMuYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWRcbiAgICApO1xuXG4gICAgLy8gSW1wb3J0IEVDUyBjbHVzdGVyXG4gICAgY29uc3QgY2x1c3RlciA9IGVjcy5DbHVzdGVyLmZyb21DbHVzdGVyQXR0cmlidXRlcyh0aGlzLCAnSW1wb3J0ZWRDbHVzdGVyJywge1xuICAgICAgY2x1c3Rlck5hbWU6IHByb3BzLmNsdXN0ZXJOYW1lLFxuICAgICAgdnBjLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFthcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBdLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IEVDUiByZXBvc2l0b3J5XG4gICAgY29uc3QgcmVwb3NpdG9yeSA9IGVjci5SZXBvc2l0b3J5LmZyb21SZXBvc2l0b3J5TmFtZShcbiAgICAgIHRoaXMsICdJbXBvcnRlZFJlcG9zaXRvcnknLCBcbiAgICAgIHByb3BzLnJlcG9zaXRvcnlVcmkuc3BsaXQoJy8nKS5wb3AoKSEuc3BsaXQoJzonKVswXVxuICAgICk7XG5cbiAgICAvLyBJbXBvcnQgbG9nIGdyb3VwXG4gICAgY29uc3QgbG9nR3JvdXAgPSBsb2dzLkxvZ0dyb3VwLmZyb21Mb2dHcm91cE5hbWUoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRMb2dHcm91cCcsXG4gICAgICBwcm9wcy5sb2dHcm91cE5hbWVcbiAgICApO1xuXG4gICAgLy8gSW1wb3J0IGxvYWQgYmFsYW5jZXIgYW5kIGxpc3RlbmVycyB1c2luZyBBUk5zXG4gICAgY29uc3QgbG9hZEJhbGFuY2VyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlci5mcm9tQXBwbGljYXRpb25Mb2FkQmFsYW5jZXJBdHRyaWJ1dGVzKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9hZEJhbGFuY2VyJyxcbiAgICAgIHsgXG4gICAgICAgIGxvYWRCYWxhbmNlckFybjogcHJvcHMubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgICBzZWN1cml0eUdyb3VwSWQ6IGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWRcbiAgICAgIH1cbiAgICApO1xuXG4gICAgY29uc3QgaHR0cExpc3RlbmVyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyLmZyb21BcHBsaWNhdGlvbkxpc3RlbmVyQXR0cmlidXRlcyhcbiAgICAgIHRoaXMsICdJbXBvcnRlZEh0dHBMaXN0ZW5lcicsXG4gICAgICB7IFxuICAgICAgICBsaXN0ZW5lckFybjogcHJvcHMuaHR0cExpc3RlbmVyQXJuLFxuICAgICAgICBzZWN1cml0eUdyb3VwOiBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBcbiAgICAgIH1cbiAgICApO1xuXG4gICAgbGV0IGh0dHBzTGlzdGVuZXI6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuSUFwcGxpY2F0aW9uTGlzdGVuZXIgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHByb3BzLmh0dHBzTGlzdGVuZXJBcm4pIHtcbiAgICAgIGh0dHBzTGlzdGVuZXIgPSBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIuZnJvbUFwcGxpY2F0aW9uTGlzdGVuZXJBdHRyaWJ1dGVzKFxuICAgICAgICB0aGlzLCAnSW1wb3J0ZWRIdHRwc0xpc3RlbmVyJyxcbiAgICAgICAgeyBcbiAgICAgICAgICBsaXN0ZW5lckFybjogcHJvcHMuaHR0cHNMaXN0ZW5lckFybixcbiAgICAgICAgICBzZWN1cml0eUdyb3VwOiBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBcbiAgICAgICAgfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgSUFNIHJvbGVzXG4gICAgY29uc3QgeyBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSB9ID0gdGhpcy5jcmVhdGVJYW1Sb2xlcyhwcm9wcywgbG9nR3JvdXApO1xuXG4gICAgLy8gQ3JlYXRlIHRhc2sgZGVmaW5pdGlvblxuICAgIHRoaXMudGFza0RlZmluaXRpb24gPSB0aGlzLmNyZWF0ZVRhc2tEZWZpbml0aW9uKHByb3BzLCBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSk7XG5cbiAgICAvLyBDcmVhdGUgY29udGFpbmVyIGRlZmluaXRpb25cbiAgICB0aGlzLmNvbnRhaW5lciA9IHRoaXMuY3JlYXRlQ29udGFpbmVyRGVmaW5pdGlvbihwcm9wcywgcmVwb3NpdG9yeSwgbG9nR3JvdXApO1xuXG4gICAgLy8gQ3JlYXRlIHRhcmdldCBncm91cFxuICAgIHRoaXMudGFyZ2V0R3JvdXAgPSB0aGlzLmNyZWF0ZVRhcmdldEdyb3VwKHByb3BzLCB2cGMsIGxvYWRCYWxhbmNlcik7XG5cbiAgICAvLyBSdW4gZGF0YWJhc2UgbWlncmF0aW9ucyBiZWZvcmUgc3RhcnRpbmcgdGhlIHNlcnZpY2VcbiAgICB0aGlzLnJ1bk1pZ3JhdGlvbnMocHJvcHMsIGNsdXN0ZXIsIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cCk7XG5cbiAgICAvLyBDcmVhdGUgRmFyZ2F0ZSBzZXJ2aWNlXG4gICAgdGhpcy5zZXJ2aWNlID0gdGhpcy5jcmVhdGVGYXJnYXRlU2VydmljZShwcm9wcywgY2x1c3RlciwgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwKTtcblxuICAgIC8vIENvbmZpZ3VyZSBoZWFsdGggY2hlY2tzXG4gICAgdGhpcy5jb25maWd1cmVIZWFsdGhDaGVjayhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgYXV0byBzY2FsaW5nXG4gICAgdGhpcy5zY2FsYWJsZVRhcmdldCA9IHRoaXMuY3JlYXRlQXV0b1NjYWxpbmcocHJvcHMpO1xuXG4gICAgLy8gQWRkIGxpc3RlbmVyIHJ1bGVzXG4gICAgdGhpcy5hZGRMaXN0ZW5lclJ1bGVzKGh0dHBMaXN0ZW5lciwgaHR0cHNMaXN0ZW5lcik7XG5cbiAgICAvLyBTZXR1cCBSb3V0ZTUzIEROUyByZWNvcmRzIChpZiBkb21haW4gY29uZmlndXJlZClcbiAgICB0aGlzLnNldHVwUm91dGU1Myhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgc3RhY2sgb3V0cHV0c1xuICAgIHRoaXMuY3JlYXRlT3V0cHV0cyhwcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3JldHNNYW5hZ2VyU2VjcmV0KHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZWNyZXRzID0gdGhpcy5zZWNyZXRzTG9hZGVyLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG4gICAgICBcbiAgICAgIGNvbnN0IHNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0FwcFNlY3JldHMnLCB7XG4gICAgICAgIHNlY3JldE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFwcC1zZWNyZXRzYCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoc2VjcmV0cyksXG4gICAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICdnZW5lcmF0ZWRfYXQnLFxuICAgICAgICAgIGluY2x1ZGVTcGFjZTogZmFsc2UsXG4gICAgICAgICAgZXhjbHVkZUNoYXJhY3RlcnM6ICdcIkAvXFxcXCdcbiAgICAgICAgfSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcblxuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ01hbmFnZWRCeScsICdDREstU09QUycpO1xuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ0NvbXBvbmVudCcsICdBcHBsaWNhdGlvbi1TZWNyZXRzJyk7XG4gICAgICBcbiAgICAgIHJldHVybiBzZWNyZXQ7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUud2FybihgRmFpbGVkIHRvIGxvYWQgU09QUyBzZWNyZXRzLCBjcmVhdGluZyBlbXB0eSBzZWNyZXQ6ICR7ZXJyb3J9YCk7XG4gICAgICBcbiAgICAgIHJldHVybiBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hcHAtc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudCAoZW1wdHkgLSBwb3B1bGF0ZSBtYW51YWxseSlgLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlSWFtUm9sZXMocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcywgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwKSB7XG4gICAgLy8gVGFzayBleGVjdXRpb24gcm9sZVxuICAgIGNvbnN0IGV4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rhc2tFeGVjdXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICByb2xlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tZXhlY3V0aW9uLXJvbGVgLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5JyksXG4gICAgICBdLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgRUNSQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICAgIFNlY3JldHNNYW5hZ2VyQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBUYXNrIHJvbGVcbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGFza1JvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIHJvbGVOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS10YXNrLXJvbGVgLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgQ2xvdWRXYXRjaExvZ3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcbiAgICAgICAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cC5sb2dHcm91cEFybiArICcqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgU2VjcmV0c01hbmFnZXJBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLmFwcFNlY3JldHMuc2VjcmV0QXJuXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoZXhlY3V0aW9uUm9sZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihleGVjdXRpb25Sb2xlKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtRXhlY3V0aW9uLVJvbGUnKTtcbiAgICBjZGsuVGFncy5vZih0YXNrUm9sZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0YXNrUm9sZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLVRhc2stUm9sZScpO1xuXG4gICAgcmV0dXJuIHsgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUgfTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVGFza0RlZmluaXRpb24oXG4gICAgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyxcbiAgICBleGVjdXRpb25Sb2xlOiBpYW0uUm9sZSxcbiAgICB0YXNrUm9sZTogaWFtLlJvbGVcbiAgKTogZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbiB7XG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnVGFza0RlZmluaXRpb24nLCB7XG4gICAgICBmYW1pbHk6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGNwdTogcHJvcHMuY3B1IHx8IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIsXG4gICAgICBleGVjdXRpb25Sb2xlLFxuICAgICAgdGFza1JvbGUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdG1wZnMgdm9sdW1lcyBpZiByZWFkLW9ubHkgcm9vdCBmaWxlc3lzdGVtIGlzIGVuYWJsZWRcbiAgICBpZiAocHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSkge1xuICAgICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBob3N0OiB7fSxcbiAgICAgIH0pO1xuXG4gICAgICB0YXNrRGVmaW5pdGlvbi5hZGRWb2x1bWUoe1xuICAgICAgICBuYW1lOiAnbG9ncy12b2x1bWUnLFxuICAgICAgICBob3N0OiB7fSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YodGFza0RlZmluaXRpb24pLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodGFza0RlZmluaXRpb24pLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1UYXNrLURlZmluaXRpb24nKTtcblxuICAgIHJldHVybiB0YXNrRGVmaW5pdGlvbjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ29udGFpbmVyRGVmaW5pdGlvbihcbiAgICBwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLFxuICAgIHJlcG9zaXRvcnk6IGVjci5JUmVwb3NpdG9yeSxcbiAgICBsb2dHcm91cDogbG9ncy5JTG9nR3JvdXBcbiAgKTogZWNzLkNvbnRhaW5lckRlZmluaXRpb24ge1xuICAgIC8vIFByZXBhcmUgZW52aXJvbm1lbnQgdmFyaWFibGVzXG4gICAgY29uc3QgZW52aXJvbm1lbnQgPSB7XG4gICAgICBSRVFVSVJFRF9TRVRUSU5HOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAuLi5wcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICB9O1xuXG4gICAgLy8gQ3JlYXRlIGNvbnRhaW5lclxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMudGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCd0ZXN0YXBwLWNvbnRhaW5lcicsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocmVwb3NpdG9yeSwgcHJvcHMudGFza0ltYWdlVGFnIHx8ICdsYXRlc3QnKSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6ICd0ZXN0YXBwJyxcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50LFxuICAgICAgc2VjcmV0czoge1xuICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdzZWNyZXRfa2V5JyksXG4gICAgICB9LFxuICAgICAgLy8gQ29udGFpbmVyIHNlY3VyaXR5IHNldHRpbmdzXG4gICAgICB1c2VyOiBwcm9wcy5lbmFibGVOb25Sb290Q29udGFpbmVyID8gJzEwMDE6MTAwMScgOiB1bmRlZmluZWQsXG4gICAgICByZWFkb25seVJvb3RGaWxlc3lzdGVtOiBwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtIHx8IGZhbHNlLFxuICAgICAgLy8gUmVzb3VyY2UgbGltaXRzIGZvciBzZWN1cml0eSBhbmQgcGVyZm9ybWFuY2VcbiAgICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiBNYXRoLmZsb29yKChwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIpICogMC44KSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBwb3J0IG1hcHBpbmdcbiAgICBjb250YWluZXIuYWRkUG9ydE1hcHBpbmdzKHtcbiAgICAgIGNvbnRhaW5lclBvcnQ6IHByb3BzLmNvbnRhaW5lclBvcnQgfHwgODAwMCxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgICAgbmFtZTogJ2h0dHAnLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIG1vdW50IHBvaW50cyBmb3IgdG1wZnMgdm9sdW1lcyBpZiByZWFkLW9ubHkgZmlsZXN5c3RlbSBpcyBlbmFibGVkXG4gICAgaWYgKHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL3RtcCcsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuXG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBzb3VyY2VWb2x1bWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgIGNvbnRhaW5lclBhdGg6ICcvYXBwL2xvZ3MnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gY29udGFpbmVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVUYXJnZXRHcm91cChwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLCB2cGM6IGVjMi5JVnBjLCBsb2FkQmFsYW5jZXI6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuSUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwIHtcbiAgICBjb25zdCB0YXJnZXRHcm91cCA9IG5ldyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uVGFyZ2V0R3JvdXAodGhpcywgJ1RhcmdldEdyb3VwJywge1xuICAgICAgdGFyZ2V0R3JvdXBOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS10Z2AsXG4gICAgICBwb3J0OiBwcm9wcy5jb250YWluZXJQb3J0IHx8IDgwMDAsXG4gICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICB2cGMsXG4gICAgICB0YXJnZXRUeXBlOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlRhcmdldFR5cGUuSVAsXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBwYXRoOiBwcm9wcy5oZWFsdGhDaGVja1BhdGggfHwgJy9oZWFsdGgvJyxcbiAgICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgcG9ydDogJ3RyYWZmaWMtcG9ydCcsXG4gICAgICAgIGhlYWx0aHlIdHRwQ29kZXM6ICcyMDAnLFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMocHJvcHMuaGVhbHRoQ2hlY2tJbnRlcnZhbCB8fCAzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHByb3BzLmhlYWx0aENoZWNrVGltZW91dCB8fCA1KSxcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiBwcm9wcy5oZWFsdGh5VGhyZXNob2xkQ291bnQgfHwgMixcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IHByb3BzLnVuaGVhbHRoeVRocmVzaG9sZENvdW50IHx8IDMsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZih0YXJnZXRHcm91cCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0YXJnZXRHcm91cCkuYWRkKCdDb21wb25lbnQnLCAnQXBwbGljYXRpb24tVGFyZ2V0R3JvdXAnKTtcblxuICAgIHJldHVybiB0YXJnZXRHcm91cDtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRmFyZ2F0ZVNlcnZpY2UoXG4gICAgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyxcbiAgICBjbHVzdGVyOiBlY3MuSUNsdXN0ZXIsXG4gICAgc2VjdXJpdHlHcm91cDogZWMyLklTZWN1cml0eUdyb3VwXG4gICk6IGVjcy5GYXJnYXRlU2VydmljZSB7XG4gICAgY29uc3Qgc2VydmljZU5hbWUgPSBwcm9wcy5zZXJ2aWNlTmFtZSB8fCBgdGVzdGFwcC1zZXJ2aWNlLSR7cHJvcHMuZW52aXJvbm1lbnR9YDtcblxuICAgIGNvbnN0IHNlcnZpY2UgPSBuZXcgZWNzLkZhcmdhdGVTZXJ2aWNlKHRoaXMsICdGYXJnYXRlU2VydmljZScsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbjogdGhpcy50YXNrRGVmaW5pdGlvbixcbiAgICAgIHNlcnZpY2VOYW1lLFxuICAgICAgZGVzaXJlZENvdW50OiBwcm9wcy5kZXNpcmVkQ291bnQgfHwgMSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbc2VjdXJpdHlHcm91cF0sXG4gICAgICBhc3NpZ25QdWJsaWNJcDogZmFsc2UsIC8vIFJ1bm5pbmcgaW4gcHJpdmF0ZSBzdWJuZXRzXG4gICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogcHJvcHMuZW52aXJvbm1lbnQgIT09ICdwcm9kdWN0aW9uJywgLy8gRW5hYmxlIEVDUyBFeGVjIGZvciBkZXYvc3RhZ2luZ1xuICAgICAgLy8gRGVwbG95bWVudCBjb25maWd1cmF0aW9uIGZvciB6ZXJvLWRvd250aW1lIGRlcGxveW1lbnRzIGluIHByb2R1Y3Rpb25cbiAgICAgIG1pbkhlYWx0aHlQZXJjZW50OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gMTAwIDogNTAsXG4gICAgICBtYXhIZWFsdGh5UGVyY2VudDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDIwMCA6IDE1MCxcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZ3VyZSBzZXJ2aWNlIGxvYWQgYmFsYW5jZXJzXG4gICAgc2VydmljZS5hdHRhY2hUb0FwcGxpY2F0aW9uVGFyZ2V0R3JvdXAodGhpcy50YXJnZXRHcm91cCk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHNlcnZpY2UpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yoc2VydmljZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLVNlcnZpY2UnKTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVIZWFsdGhDaGVjayhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gSGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb24gaXMgYWxyZWFkeSBzZXQgaW4gdGFyZ2V0IGdyb3VwIGNyZWF0aW9uXG4gICAgLy8gVGhpcyBtZXRob2QgY2FuIGJlIGV4dGVuZGVkIGZvciBhZGRpdGlvbmFsIGhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uc1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVBdXRvU2NhbGluZyhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogZWNzLlNjYWxhYmxlVGFza0NvdW50IHtcbiAgICBjb25zdCBtaW5DYXBhY2l0eSA9IHByb3BzLm1pbkNhcGFjaXR5IHx8IHByb3BzLmRlc2lyZWRDb3VudCB8fCAxO1xuICAgIGNvbnN0IG1heENhcGFjaXR5ID0gcHJvcHMubWF4Q2FwYWNpdHkgfHwgKHByb3BzLmRlc2lyZWRDb3VudCB8fCAxKSAqIDM7XG5cbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IHRoaXMuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHksXG4gICAgICBtYXhDYXBhY2l0eSxcbiAgICB9KTtcblxuICAgIC8vIENQVS1iYXNlZCBhdXRvIHNjYWxpbmdcbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oJ0NwdVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IHByb3BzLmNwdVRhcmdldFV0aWxpemF0aW9uIHx8IDcwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZUluQ29vbGRvd25NaW51dGVzIHx8IDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVPdXRDb29sZG93bk1pbnV0ZXMgfHwgMiksXG4gICAgfSk7XG5cbiAgICAvLyBNZW1vcnktYmFzZWQgYXV0byBzY2FsaW5nXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbk1lbW9yeVV0aWxpemF0aW9uKCdNZW1vcnlTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiBwcm9wcy5tZW1vcnlUYXJnZXRVdGlsaXphdGlvbiB8fCA4MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVJbkNvb2xkb3duTWludXRlcyB8fCA1KSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKHByb3BzLnNjYWxlT3V0Q29vbGRvd25NaW51dGVzIHx8IDIpLFxuICAgIH0pO1xuXG4gICAgLy8gTm90ZTogUmVxdWVzdC1iYXNlZCBhdXRvIHNjYWxpbmcgdXNpbmcgc2NhbGVPblJlcXVlc3RDb3VudCByZXF1aXJlcyB0aGUgdGFyZ2V0IGdyb3VwIFxuICAgIC8vIHRvIGJlIGF0dGFjaGVkIHRvIGEgbG9hZCBiYWxhbmNlciBmaXJzdC4gU2luY2Ugd2UncmUgY3JlYXRpbmcgbGlzdGVuZXIgcnVsZXMgYWZ0ZXIgXG4gICAgLy8gdGhlIGF1dG8gc2NhbGluZyBzZXR1cCwgd2UnbGwgc2tpcCByZXF1ZXN0LWJhc2VkIHNjYWxpbmcgZm9yIG5vdy5cbiAgICAvLyBUaGlzIGNhbiBiZSBhZGRlZCBhcyBhIHNlcGFyYXRlIGNvbnN0cnVjdCBhZnRlciB0aGUgbGlzdGVuZXIgcnVsZXMgYXJlIGNyZWF0ZWQuXG5cbiAgICByZXR1cm4gc2NhbGFibGVUYXJnZXQ7XG4gIH1cblxuICBwcml2YXRlIGFkZExpc3RlbmVyUnVsZXMoXG4gICAgaHR0cExpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyLFxuICAgIGh0dHBzTGlzdGVuZXI/OiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyXG4gICk6IHZvaWQge1xuICAgIC8vIEFkZCBydWxlIHRvIEhUVFAgbGlzdGVuZXJcbiAgICBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyUnVsZSh0aGlzLCAnSHR0cExpc3RlbmVyUnVsZScsIHtcbiAgICAgIGxpc3RlbmVyOiBodHRwTGlzdGVuZXIsXG4gICAgICBwcmlvcml0eTogMTAwLFxuICAgICAgY29uZGl0aW9uczogW1xuICAgICAgICBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQ29uZGl0aW9uLnBhdGhQYXR0ZXJucyhbJyonXSksXG4gICAgICBdLFxuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZvcndhcmQoW3RoaXMudGFyZ2V0R3JvdXBdKSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBydWxlIHRvIEhUVFBTIGxpc3RlbmVyIGlmIGl0IGV4aXN0c1xuICAgIGlmIChodHRwc0xpc3RlbmVyKSB7XG4gICAgICBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyUnVsZSh0aGlzLCAnSHR0cHNMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIGxpc3RlbmVyOiBodHRwc0xpc3RlbmVyLFxuICAgICAgICBwcmlvcml0eTogMTAwLFxuICAgICAgICBjb25kaXRpb25zOiBbXG4gICAgICAgICAgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckNvbmRpdGlvbi5wYXRoUGF0dGVybnMoWycqJ10pLFxuICAgICAgICBdLFxuICAgICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZm9yd2FyZChbdGhpcy50YXJnZXRHcm91cF0pLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cFJvdXRlNTMocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSB0aGlzLmdldERvbWFpbk5hbWUocHJvcHMpO1xuICAgIGlmICghZG9tYWluTmFtZSB8fCAhcHJvcHMuaG9zdGVkWm9uZUlkIHx8ICFwcm9wcy5iYXNlRG9tYWluKSByZXR1cm47XG5cbiAgICAvLyBJbXBvcnQgZXhpc3RpbmcgaG9zdGVkIHpvbmVcbiAgICB0aGlzLmhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUhvc3RlZFpvbmVBdHRyaWJ1dGVzKHRoaXMsICdIb3N0ZWRab25lJywge1xuICAgICAgaG9zdGVkWm9uZUlkOiBwcm9wcy5ob3N0ZWRab25lSWQsXG4gICAgICB6b25lTmFtZTogcHJvcHMuYmFzZURvbWFpbixcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBsb2FkIGJhbGFuY2VyIGZvciBETlMgdGFyZ2V0XG4gICAgY29uc3QgbG9hZEJhbGFuY2VyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlci5mcm9tQXBwbGljYXRpb25Mb2FkQmFsYW5jZXJBdHRyaWJ1dGVzKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9hZEJhbGFuY2VyJyxcbiAgICAgIHtcbiAgICAgICAgbG9hZEJhbGFuY2VyQXJuOiBwcm9wcy5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICAgIHNlY3VyaXR5R3JvdXBJZDogJycsIC8vIE5vdCBuZWVkZWQgZm9yIEROUyByZWNvcmQgY3JlYXRpb25cbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIEEgcmVjb3JkIGZvciB0aGUgZG9tYWluXG4gICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCAnRG5zQVJlY29yZCcsIHtcbiAgICAgIHpvbmU6IHRoaXMuaG9zdGVkWm9uZSxcbiAgICAgIHJlY29yZE5hbWU6IGRvbWFpbk5hbWUsXG4gICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgbmV3IHJvdXRlNTN0YXJnZXRzLkxvYWRCYWxhbmNlclRhcmdldChsb2FkQmFsYW5jZXIpXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIEFBQUEgcmVjb3JkIGZvciBJUHY2IChpZiBBTEIgc3VwcG9ydHMgaXQpXG4gICAgbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCAnRG5zQWFhYVJlY29yZCcsIHtcbiAgICAgIHpvbmU6IHRoaXMuaG9zdGVkWm9uZSxcbiAgICAgIHJlY29yZE5hbWU6IGRvbWFpbk5hbWUsXG4gICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgbmV3IHJvdXRlNTN0YXJnZXRzLkxvYWRCYWxhbmNlclRhcmdldChsb2FkQmFsYW5jZXIpXG4gICAgICApLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBydW5NaWdyYXRpb25zKFxuICAgIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsIFxuICAgIGNsdXN0ZXI6IGVjcy5JQ2x1c3RlciwgXG4gICAgc2VjdXJpdHlHcm91cDogZWMyLklTZWN1cml0eUdyb3VwXG4gICk6IHZvaWQge1xuICAgIC8vIENyZWF0ZSBhIHNlcGFyYXRlIHRhc2sgZGVmaW5pdGlvbiBmb3IgbWlncmF0aW9uc1xuICAgIGNvbnN0IG1pZ3JhdGlvblRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ01pZ3JhdGlvblRhc2tEZWZpbml0aW9uJywge1xuICAgICAgZmFtaWx5OiBgdGVzdGFwcC1taWdyYXRpb24tJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgY3B1OiBwcm9wcy5jcHUgfHwgMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IHByb3BzLm1lbW9yeUxpbWl0TWlCIHx8IDUxMixcbiAgICAgIGV4ZWN1dGlvblJvbGU6IHRoaXMudGFza0RlZmluaXRpb24uZXhlY3V0aW9uUm9sZSEsXG4gICAgICB0YXNrUm9sZTogdGhpcy50YXNrRGVmaW5pdGlvbi50YXNrUm9sZSEsXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgbG9nIGdyb3VwIGFuZCByZXBvc2l0b3J5IChhbHJlYWR5IGNyZWF0ZWQpXG4gICAgY29uc3QgbG9nR3JvdXAgPSBsb2dzLkxvZ0dyb3VwLmZyb21Mb2dHcm91cE5hbWUodGhpcywgJ0ltcG9ydGVkTWlncmF0aW9uTG9nR3JvdXAnLCBwcm9wcy5sb2dHcm91cE5hbWUpO1xuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRNaWdyYXRpb25SZXBvc2l0b3J5JywgXG4gICAgICBwcm9wcy5yZXBvc2l0b3J5VXJpLnNwbGl0KCcvJykucG9wKCkhLnNwbGl0KCc6JylbMF1cbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIG1pZ3JhdGlvbiBjb250YWluZXIgd2l0aCBzYW1lIGVudmlyb25tZW50IGFzIG1haW4gYXBwIGJ1dCBkaWZmZXJlbnQgY29tbWFuZFxuICAgIGNvbnN0IG1pZ3JhdGlvbkNvbnRhaW5lciA9IG1pZ3JhdGlvblRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignTWlncmF0aW9uQ29udGFpbmVyJywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRWNyUmVwb3NpdG9yeShyZXBvc2l0b3J5LCBwcm9wcy50YXNrSW1hZ2VUYWcgfHwgJ2xhdGVzdCcpLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUkVRVUlSRURfU0VUVElORzogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgLi4ucHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgICB9LFxuICAgICAgc2VjcmV0czoge1xuICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdzZWNyZXRfa2V5JyksXG4gICAgICAgIEpXVF9TRUNSRVQ6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHRoaXMuYXBwU2VjcmV0cywgJ2p3dF9zZWNyZXQnKSxcbiAgICAgIH0sXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICAgIHN0cmVhbVByZWZpeDogJ21pZ3JhdGlvbicsXG4gICAgICB9KSxcbiAgICAgIC8vIE92ZXJyaWRlIHRoZSBkZWZhdWx0IGNvbW1hbmQgdG8gcnVuIG1pZ3JhdGlvbnNcbiAgICAgIGNvbW1hbmQ6IFsnL29wdC92ZW52L2Jpbi9weXRob24nLCAnbWFuYWdlLnB5JywgJ21pZ3JhdGUnXSxcbiAgICAgIGVzc2VudGlhbDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBzZWN1cml0eSBjb25maWd1cmF0aW9uXG4gICAgaWYgKHByb3BzLmVuYWJsZU5vblJvb3RDb250YWluZXIpIHtcbiAgICAgIG1pZ3JhdGlvbkNvbnRhaW5lci5hZGRUb0V4ZWN1dGlvblBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydlY3M6UnVuVGFzayddLFxuICAgICAgICByZXNvdXJjZXM6IFttaWdyYXRpb25UYXNrRGVmaW5pdGlvbi50YXNrRGVmaW5pdGlvbkFybl0sXG4gICAgICB9KSk7XG4gICAgfVxuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihtaWdyYXRpb25UYXNrRGVmaW5pdGlvbikuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihtaWdyYXRpb25UYXNrRGVmaW5pdGlvbikuYWRkKCdDb21wb25lbnQnLCAnRUNTLU1pZ3JhdGlvbi1UYXNrJyk7XG4gICAgY2RrLlRhZ3Mub2YobWlncmF0aW9uVGFza0RlZmluaXRpb24pLmFkZCgnUHVycG9zZScsICdEYXRhYmFzZS1NaWdyYXRpb24nKTtcblxuICAgIC8vIE91dHB1dCBtaWdyYXRpb24gdGFzayBkZWZpbml0aW9uIEFSTiBmb3IgdXNlIGluIHdvcmtmbG93c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNaWdyYXRpb25UYXNrRGVmaW5pdGlvbkFybicsIHtcbiAgICAgIHZhbHVlOiBtaWdyYXRpb25UYXNrRGVmaW5pdGlvbi50YXNrRGVmaW5pdGlvbkFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnTWlncmF0aW9uIFRhc2sgRGVmaW5pdGlvbiBBUk4gZm9yIHJ1bm5pbmcgZGF0YWJhc2UgbWlncmF0aW9ucycsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTWlncmF0aW9uVGFza0RlZmluaXRpb25Bcm5gLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBTZXJ2aWNlIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VydmljZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNlcnZpY2Uuc2VydmljZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZXJ2aWNlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlcnZpY2VOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIFRhc2sgRGVmaW5pdGlvbiBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tEZWZpbml0aW9uQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXNrRGVmaW5pdGlvbkFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza0RlZmluaXRpb25GYW1pbHknLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YXNrRGVmaW5pdGlvbi5mYW1pbHksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gRmFtaWx5JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXNrRGVmaW5pdGlvbkZhbWlseWAsXG4gICAgfSk7XG5cbiAgICAvLyBUYXJnZXQgR3JvdXAgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXJnZXRHcm91cEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhcmdldEdyb3VwLnRhcmdldEdyb3VwQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXJnZXRHcm91cEFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFyZ2V0R3JvdXBOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFyZ2V0R3JvdXAudGFyZ2V0R3JvdXBOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFyZ2V0R3JvdXBOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIFNlY3JldHMgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZWNyZXRzQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFNlY3JldHMgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZWNyZXRzQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIEF1dG8gU2NhbGluZyBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0F1dG9TY2FsaW5nVGFyZ2V0SWQnLCB7XG4gICAgICB2YWx1ZTogYHNlcnZpY2UvJHt0aGlzLnNlcnZpY2UuY2x1c3Rlci5jbHVzdGVyTmFtZX0vJHt0aGlzLnNlcnZpY2Uuc2VydmljZU5hbWV9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXV0byBTY2FsaW5nIFRhcmdldCBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQXV0b1NjYWxpbmdUYXJnZXRJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmF0aW9uIG91dHB1dHMgZm9yIHJlZmVyZW5jZVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEZXNpcmVkQ291bnQnLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLmRlc2lyZWRDb3VudCB8fCAxKS50b1N0cmluZygpLFxuICAgICAgZGVzY3JpcHRpb246ICdDdXJyZW50IERlc2lyZWQgQ291bnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tDcHUnLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLmNwdSB8fCAyNTYpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ1Rhc2sgQ1BVIFVuaXRzJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXNrTWVtb3J5Jywge1xuICAgICAgdmFsdWU6IChwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ1Rhc2sgTWVtb3J5IChNaUIpJyxcbiAgICB9KTtcblxuICAgIC8vIEFwcGxpY2F0aW9uIFVSTCBvdXRwdXRcbiAgICBjb25zdCBkb21haW5OYW1lID0gdGhpcy5nZXREb21haW5OYW1lKHByb3BzKTtcbiAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgY29uc3QgcHJvdG9jb2wgPSBwcm9wcy5odHRwc0xpc3RlbmVyQXJuID8gJ2h0dHBzJyA6ICdodHRwJztcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcHBsaWNhdGlvblVybCcsIHtcbiAgICAgICAgdmFsdWU6IGAke3Byb3RvY29sfTovLyR7ZG9tYWluTmFtZX1gLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFVSTCB3aXRoIGN1c3RvbSBkb21haW4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQXBwbGljYXRpb25VcmxgLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEZhbGxiYWNrIHRvIEFMQiBETlMgbmFtZSAoaW1wb3J0ZWQgZnJvbSBwbGF0Zm9ybSBzdGFjaylcbiAgICAgIGNvbnN0IGFsYkRucyA9IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gJ1Rlc3RBcHAtUGxhdGZvcm0tcHJvZHVjdGlvbicgOiBgVGVzdEFwcC1QbGF0Zm9ybS0ke3Byb3BzLmVudmlyb25tZW50fWB9LUxvYWRCYWxhbmNlckROU2ApO1xuICAgICAgY29uc3QgcHJvdG9jb2wgPSBwcm9wcy5odHRwc0xpc3RlbmVyQXJuID8gJ2h0dHBzJyA6ICdodHRwJztcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcHBsaWNhdGlvblVybCcsIHtcbiAgICAgICAgdmFsdWU6IGAke3Byb3RvY29sfTovLyR7YWxiRG5zfWAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMIChBTEIgRE5TKScsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1BcHBsaWNhdGlvblVybGAsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn0iXX0=