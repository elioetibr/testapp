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
                SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecrets, 'application.secret_key'),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHBsaWNhdGlvbi1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLDJDQUEyQztBQUMzQyxpRkFBaUY7QUFDakYsaUVBQWlFO0FBR2pFLG1EQUFtRDtBQUNuRCxrRUFBa0U7QUFFbEUscURBQWlEO0FBaURqRCxNQUFhLGdCQUFpQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBVTdDOztPQUVHO0lBQ0ssYUFBYSxDQUFDLEtBQTRCO1FBQ2hELElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU87WUFBRSxPQUFPLFNBQVMsQ0FBQztRQUUxRCxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUU7WUFDZCx3REFBd0Q7WUFDeEQsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxPQUFPLENBQUMsY0FBYyxFQUFFLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZGLE9BQU8sTUFBTSxhQUFhLElBQUksS0FBSyxDQUFDLE9BQU8sSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7U0FDbkU7YUFBTTtZQUNMLHVCQUF1QjtZQUN2QixPQUFPLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWTtnQkFDdkMsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQW9CLGlDQUFpQztnQkFDN0YsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxLQUFLLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDLHFDQUFxQztTQUN2RztJQUNILENBQUM7SUFFRCxZQUFZLEtBQWdCLEVBQUUs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QUFXLEtBQUssWUFBWSxDQUFDLENBQUMsQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDLENBQUMsb0JBQW9CLEtBQUssQ0FBQyxXQUFXLEVBQUUsa0JBQWtCLENBQUMsQ0FBQztZQUNySyxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO1lBQzNELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7Z0JBQ3hDLEtBQUssRUFBRSxHQUFHLFFBQVEsTUFBTSxNQUFNLEVBQUU7Z0JBQ2hDLFdBQVcsRUFBRSwyQkFBMkI7Z0JBQ3hDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGlCQUFpQjthQUMvQyxDQUFDLENBQUM7U0FDSjtJQUNILENBQUM7Q0FDRjtBQXBrQkQsNENBb2tCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gnO1xuaW1wb3J0ICogYXMgYXBwbGljYXRpb25hdXRvc2NhbGluZyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBwbGljYXRpb25hdXRvc2NhbGluZyc7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBTZWNyZXRzTG9hZGVyIH0gZnJvbSAnLi9zZWNyZXRzLWxvYWRlcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwbGljYXRpb25TdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICAvLyBWUEMgY29uZmlndXJhdGlvblxuICB2cGNJZDogc3RyaW5nO1xuICBwcml2YXRlU3VibmV0SWRzOiBzdHJpbmdbXTtcbiAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6IHN0cmluZztcbiAgLy8gRUNTIFBsYXRmb3JtIGNvbmZpZ3VyYXRpb25cbiAgY2x1c3RlckFybjogc3RyaW5nO1xuICBjbHVzdGVyTmFtZTogc3RyaW5nO1xuICByZXBvc2l0b3J5VXJpOiBzdHJpbmc7XG4gIGxvYWRCYWxhbmNlckFybjogc3RyaW5nO1xuICBodHRwTGlzdGVuZXJBcm46IHN0cmluZztcbiAgaHR0cHNMaXN0ZW5lckFybj86IHN0cmluZztcbiAgbG9nR3JvdXBOYW1lOiBzdHJpbmc7XG4gIGxvZ0dyb3VwQXJuOiBzdHJpbmc7XG4gIC8vIEFwcGxpY2F0aW9uIGNvbmZpZ3VyYXRpb25cbiAgc2VydmljZU5hbWU/OiBzdHJpbmc7XG4gIHRhc2tJbWFnZVRhZz86IHN0cmluZztcbiAgZGVzaXJlZENvdW50PzogbnVtYmVyO1xuICBjcHU/OiBudW1iZXI7XG4gIG1lbW9yeUxpbWl0TWlCPzogbnVtYmVyO1xuICBjb250YWluZXJQb3J0PzogbnVtYmVyO1xuICAvLyBBdXRvIHNjYWxpbmcgY29uZmlndXJhdGlvblxuICBtaW5DYXBhY2l0eT86IG51bWJlcjtcbiAgbWF4Q2FwYWNpdHk/OiBudW1iZXI7XG4gIGNwdVRhcmdldFV0aWxpemF0aW9uPzogbnVtYmVyO1xuICBtZW1vcnlUYXJnZXRVdGlsaXphdGlvbj86IG51bWJlcjtcbiAgc2NhbGVJbkNvb2xkb3duTWludXRlcz86IG51bWJlcjtcbiAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM/OiBudW1iZXI7XG4gIC8vIEhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uXG4gIGhlYWx0aENoZWNrUGF0aD86IHN0cmluZztcbiAgaGVhbHRoQ2hlY2tJbnRlcnZhbD86IG51bWJlcjtcbiAgaGVhbHRoQ2hlY2tUaW1lb3V0PzogbnVtYmVyO1xuICBoZWFsdGh5VGhyZXNob2xkQ291bnQ/OiBudW1iZXI7XG4gIHVuaGVhbHRoeVRocmVzaG9sZENvdW50PzogbnVtYmVyO1xuICAvLyBDb250YWluZXIgc2VjdXJpdHlcbiAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcj86IGJvb2xlYW47XG4gIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0/OiBib29sZWFuO1xuICAvLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgZW52aXJvbm1lbnRWYXJpYWJsZXM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xuICAvLyBEb21haW4gY29uZmlndXJhdGlvblxuICBiYXNlRG9tYWluPzogc3RyaW5nO1xuICBhcHBOYW1lPzogc3RyaW5nO1xuICBwcklkPzogc3RyaW5nO1xuICBob3N0ZWRab25lSWQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBsaWNhdGlvblN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHNlcnZpY2U6IGVjcy5GYXJnYXRlU2VydmljZTtcbiAgcHVibGljIHJlYWRvbmx5IHRhc2tEZWZpbml0aW9uOiBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY29udGFpbmVyOiBlY3MuQ29udGFpbmVyRGVmaW5pdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHRhcmdldEdyb3VwOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uVGFyZ2V0R3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBzY2FsYWJsZVRhcmdldDogZWNzLlNjYWxhYmxlVGFza0NvdW50O1xuICBwdWJsaWMgcmVhZG9ubHkgYXBwU2VjcmV0czogc2VjcmV0c21hbmFnZXIuU2VjcmV0O1xuICBwcml2YXRlIHJlYWRvbmx5IHNlY3JldHNMb2FkZXI6IFNlY3JldHNMb2FkZXI7XG4gIHByaXZhdGUgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgLyoqXG4gICAqIENvbnN0cnVjdHMgdGhlIGRvbWFpbiBuYW1lIGR5bmFtaWNhbGx5IGJhc2VkIG9uIGFwcCwgZW52aXJvbm1lbnQsIGFuZCBQUiBjb250ZXh0XG4gICAqL1xuICBwcml2YXRlIGdldERvbWFpbk5hbWUocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFwcm9wcy5iYXNlRG9tYWluIHx8ICFwcm9wcy5hcHBOYW1lKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgaWYgKHByb3BzLnBySWQpIHtcbiAgICAgIC8vIFBSIGRlcGxveW1lbnRzOiBwci0xMjMtdGVzdGFwcC5hc3Nlc3NtZW50LmVsaW8uZXRpLmJyXG4gICAgICBjb25zdCBzYW5pdGl6ZWRQcklkID0gcHJvcHMucHJJZC50b1N0cmluZygpLnJlcGxhY2UoL1teYS16MC05LV0vZ2ksICctJykudG9Mb3dlckNhc2UoKTtcbiAgICAgIHJldHVybiBgcHItJHtzYW5pdGl6ZWRQcklkfS0ke3Byb3BzLmFwcE5hbWV9LiR7cHJvcHMuYmFzZURvbWFpbn1gO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBSZWd1bGFyIGVudmlyb25tZW50c1xuICAgICAgcmV0dXJuIHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbidcbiAgICAgICAgPyBgJHtwcm9wcy5hcHBOYW1lfS4ke3Byb3BzLmJhc2VEb21haW59YCAgICAgICAgICAgICAgICAgICAgLy8gdGVzdGFwcC5hc3Nlc3NtZW50LmVsaW8uZXRpLmJyXG4gICAgICAgIDogYCR7cHJvcHMuZW52aXJvbm1lbnR9LSR7cHJvcHMuYXBwTmFtZX0uJHtwcm9wcy5iYXNlRG9tYWlufWA7IC8vIGRldi10ZXN0YXBwLmFzc2Vzc21lbnQuZWxpby5ldGkuYnJcbiAgICB9XG4gIH1cblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBJbml0aWFsaXplIHNlY3JldHMgbG9hZGVyXG4gICAgdGhpcy5zZWNyZXRzTG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIocHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIFxuICAgIC8vIENyZWF0ZSBBV1MgU2VjcmV0cyBNYW5hZ2VyIHNlY3JldCBmcm9tIFNPUFNcbiAgICB0aGlzLmFwcFNlY3JldHMgPSB0aGlzLmNyZWF0ZVNlY3JldHNNYW5hZ2VyU2VjcmV0KHByb3BzKTtcblxuICAgIC8vIEltcG9ydCBWUEMgYW5kIHN1Ym5ldHNcbiAgICBjb25zdCB2cGMgPSBlYzIuVnBjLmZyb21WcGNBdHRyaWJ1dGVzKHRoaXMsICdJbXBvcnRlZFZwYycsIHtcbiAgICAgIHZwY0lkOiBwcm9wcy52cGNJZCxcbiAgICAgIGF2YWlsYWJpbGl0eVpvbmVzOiBjZGsuRm4uZ2V0QXpzKCksXG4gICAgICBwcml2YXRlU3VibmV0SWRzOiBwcm9wcy5wcml2YXRlU3VibmV0SWRzLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IGFwcGxpY2F0aW9uIHNlY3VyaXR5IGdyb3VwXG4gICAgY29uc3QgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwID0gZWMyLlNlY3VyaXR5R3JvdXAuZnJvbVNlY3VyaXR5R3JvdXBJZChcbiAgICAgIHRoaXMsICdJbXBvcnRlZEFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cCcsXG4gICAgICBwcm9wcy5hcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZFxuICAgICk7XG5cbiAgICAvLyBJbXBvcnQgRUNTIGNsdXN0ZXJcbiAgICBjb25zdCBjbHVzdGVyID0gZWNzLkNsdXN0ZXIuZnJvbUNsdXN0ZXJBdHRyaWJ1dGVzKHRoaXMsICdJbXBvcnRlZENsdXN0ZXInLCB7XG4gICAgICBjbHVzdGVyTmFtZTogcHJvcHMuY2x1c3Rlck5hbWUsXG4gICAgICB2cGMsXG4gICAgICBzZWN1cml0eUdyb3VwczogW2FwcGxpY2F0aW9uU2VjdXJpdHlHcm91cF0sXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgRUNSIHJlcG9zaXRvcnlcbiAgICBjb25zdCByZXBvc2l0b3J5ID0gZWNyLlJlcG9zaXRvcnkuZnJvbVJlcG9zaXRvcnlOYW1lKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkUmVwb3NpdG9yeScsIFxuICAgICAgcHJvcHMucmVwb3NpdG9yeVVyaS5zcGxpdCgnLycpLnBvcCgpIS5zcGxpdCgnOicpWzBdXG4gICAgKTtcblxuICAgIC8vIEltcG9ydCBsb2cgZ3JvdXBcbiAgICBjb25zdCBsb2dHcm91cCA9IGxvZ3MuTG9nR3JvdXAuZnJvbUxvZ0dyb3VwTmFtZShcbiAgICAgIHRoaXMsICdJbXBvcnRlZExvZ0dyb3VwJyxcbiAgICAgIHByb3BzLmxvZ0dyb3VwTmFtZVxuICAgICk7XG5cbiAgICAvLyBJbXBvcnQgbG9hZCBiYWxhbmNlciBhbmQgbGlzdGVuZXJzIHVzaW5nIEFSTnNcbiAgICBjb25zdCBsb2FkQmFsYW5jZXIgPSBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyLmZyb21BcHBsaWNhdGlvbkxvYWRCYWxhbmNlckF0dHJpYnV0ZXMoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRMb2FkQmFsYW5jZXInLFxuICAgICAgeyBcbiAgICAgICAgbG9hZEJhbGFuY2VyQXJuOiBwcm9wcy5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICAgIHNlY3VyaXR5R3JvdXBJZDogYXBwbGljYXRpb25TZWN1cml0eUdyb3VwLnNlY3VyaXR5R3JvdXBJZFxuICAgICAgfVxuICAgICk7XG5cbiAgICBjb25zdCBodHRwTGlzdGVuZXIgPSBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIuZnJvbUFwcGxpY2F0aW9uTGlzdGVuZXJBdHRyaWJ1dGVzKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkSHR0cExpc3RlbmVyJyxcbiAgICAgIHsgXG4gICAgICAgIGxpc3RlbmVyQXJuOiBwcm9wcy5odHRwTGlzdGVuZXJBcm4sXG4gICAgICAgIHNlY3VyaXR5R3JvdXA6IGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cFxuICAgICAgfVxuICAgICk7XG5cbiAgICBsZXQgaHR0cHNMaXN0ZW5lcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5JQXBwbGljYXRpb25MaXN0ZW5lciB8IHVuZGVmaW5lZDtcbiAgICBpZiAocHJvcHMuaHR0cHNMaXN0ZW5lckFybikge1xuICAgICAgaHR0cHNMaXN0ZW5lciA9IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lci5mcm9tQXBwbGljYXRpb25MaXN0ZW5lckF0dHJpYnV0ZXMoXG4gICAgICAgIHRoaXMsICdJbXBvcnRlZEh0dHBzTGlzdGVuZXInLFxuICAgICAgICB7IFxuICAgICAgICAgIGxpc3RlbmVyQXJuOiBwcm9wcy5odHRwc0xpc3RlbmVyQXJuLFxuICAgICAgICAgIHNlY3VyaXR5R3JvdXA6IGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cFxuICAgICAgICB9XG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBJQU0gcm9sZXNcbiAgICBjb25zdCB7IGV4ZWN1dGlvblJvbGUsIHRhc2tSb2xlIH0gPSB0aGlzLmNyZWF0ZUlhbVJvbGVzKHByb3BzLCBsb2dHcm91cCk7XG5cbiAgICAvLyBDcmVhdGUgdGFzayBkZWZpbml0aW9uXG4gICAgdGhpcy50YXNrRGVmaW5pdGlvbiA9IHRoaXMuY3JlYXRlVGFza0RlZmluaXRpb24ocHJvcHMsIGV4ZWN1dGlvblJvbGUsIHRhc2tSb2xlKTtcblxuICAgIC8vIENyZWF0ZSBjb250YWluZXIgZGVmaW5pdGlvblxuICAgIHRoaXMuY29udGFpbmVyID0gdGhpcy5jcmVhdGVDb250YWluZXJEZWZpbml0aW9uKHByb3BzLCByZXBvc2l0b3J5LCBsb2dHcm91cCk7XG5cbiAgICAvLyBDcmVhdGUgdGFyZ2V0IGdyb3VwXG4gICAgdGhpcy50YXJnZXRHcm91cCA9IHRoaXMuY3JlYXRlVGFyZ2V0R3JvdXAocHJvcHMsIHZwYywgbG9hZEJhbGFuY2VyKTtcblxuICAgIC8vIENyZWF0ZSBGYXJnYXRlIHNlcnZpY2VcbiAgICB0aGlzLnNlcnZpY2UgPSB0aGlzLmNyZWF0ZUZhcmdhdGVTZXJ2aWNlKHByb3BzLCBjbHVzdGVyLCBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXApO1xuXG4gICAgLy8gQ29uZmlndXJlIGhlYWx0aCBjaGVja3NcbiAgICB0aGlzLmNvbmZpZ3VyZUhlYWx0aENoZWNrKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBhdXRvIHNjYWxpbmdcbiAgICB0aGlzLnNjYWxhYmxlVGFyZ2V0ID0gdGhpcy5jcmVhdGVBdXRvU2NhbGluZyhwcm9wcyk7XG5cbiAgICAvLyBBZGQgbGlzdGVuZXIgcnVsZXNcbiAgICB0aGlzLmFkZExpc3RlbmVyUnVsZXMoaHR0cExpc3RlbmVyLCBodHRwc0xpc3RlbmVyKTtcblxuICAgIC8vIFNldHVwIFJvdXRlNTMgRE5TIHJlY29yZHMgKGlmIGRvbWFpbiBjb25maWd1cmVkKVxuICAgIHRoaXMuc2V0dXBSb3V0ZTUzKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBzdGFjayBvdXRwdXRzXG4gICAgdGhpcy5jcmVhdGVPdXRwdXRzKHByb3BzKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyk6IHNlY3JldHNtYW5hZ2VyLlNlY3JldCB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNlY3JldHMgPSB0aGlzLnNlY3JldHNMb2FkZXIubG9hZFNlY3JldHNXaXRoRmFsbGJhY2soKTtcbiAgICAgIFxuICAgICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tYXBwLXNlY3JldHNgLFxuICAgICAgICBkZXNjcmlwdGlvbjogYEFwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICAgIHNlY3JldFN0cmluZ1RlbXBsYXRlOiBKU09OLnN0cmluZ2lmeShzZWNyZXRzKSxcbiAgICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ2dlbmVyYXRlZF9hdCcsXG4gICAgICAgICAgaW5jbHVkZVNwYWNlOiBmYWxzZSxcbiAgICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcJ1xuICAgICAgICB9LFxuICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0pO1xuXG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnTWFuYWdlZEJ5JywgJ0NESy1TT1BTJyk7XG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnQ29tcG9uZW50JywgJ0FwcGxpY2F0aW9uLVNlY3JldHMnKTtcbiAgICAgIFxuICAgICAgcmV0dXJuIHNlY3JldDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS53YXJuKGBGYWlsZWQgdG8gbG9hZCBTT1BTIHNlY3JldHMsIGNyZWF0aW5nIGVtcHR5IHNlY3JldDogJHtlcnJvcn1gKTtcbiAgICAgIFxuICAgICAgcmV0dXJuIG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0FwcFNlY3JldHMnLCB7XG4gICAgICAgIHNlY3JldE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFwcC1zZWNyZXRzYCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50IChlbXB0eSAtIHBvcHVsYXRlIG1hbnVhbGx5KWAsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVJYW1Sb2xlcyhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLCBsb2dHcm91cDogbG9ncy5JTG9nR3JvdXApIHtcbiAgICAvLyBUYXNrIGV4ZWN1dGlvbiByb2xlXG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGFza0V4ZWN1dGlvblJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIHJvbGVOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1leGVjdXRpb24tcm9sZWAsXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcbiAgICAgIF0sXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBFQ1JBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hDaGVja0xheWVyQXZhaWxhYmlsaXR5JyxcbiAgICAgICAgICAgICAgICAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgU2VjcmV0c01hbmFnZXJBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLmFwcFNlY3JldHMuc2VjcmV0QXJuXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFRhc2sgcm9sZVxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUYXNrUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgcm9sZU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXRhc2stcm9sZWAsXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBDbG91ZFdhdGNoTG9nczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxuICAgICAgICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuICsgJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTZWNyZXRzTWFuYWdlckFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3RoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihleGVjdXRpb25Sb2xlKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKGV4ZWN1dGlvblJvbGUpLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1FeGVjdXRpb24tUm9sZScpO1xuICAgIGNkay5UYWdzLm9mKHRhc2tSb2xlKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHRhc2tSb2xlKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtVGFzay1Sb2xlJyk7XG5cbiAgICByZXR1cm4geyBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSB9O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVUYXNrRGVmaW5pdGlvbihcbiAgICBwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLFxuICAgIGV4ZWN1dGlvblJvbGU6IGlhbS5Sb2xlLFxuICAgIHRhc2tSb2xlOiBpYW0uUm9sZVxuICApOiBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uIHtcbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIGZhbWlseTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgY3B1OiBwcm9wcy5jcHUgfHwgMjU2LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IHByb3BzLm1lbW9yeUxpbWl0TWlCIHx8IDUxMixcbiAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICB0YXNrUm9sZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0bXBmcyB2b2x1bWVzIGlmIHJlYWQtb25seSByb290IGZpbGVzeXN0ZW0gaXMgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtKSB7XG4gICAgICB0YXNrRGVmaW5pdGlvbi5hZGRWb2x1bWUoe1xuICAgICAgICBuYW1lOiAndG1wLXZvbHVtZScsXG4gICAgICAgIGhvc3Q6IHt9LFxuICAgICAgfSk7XG5cbiAgICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgIGhvc3Q6IHt9LFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZih0YXNrRGVmaW5pdGlvbikuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0YXNrRGVmaW5pdGlvbikuYWRkKCdDb21wb25lbnQnLCAnRUNTLVRhc2stRGVmaW5pdGlvbicpO1xuXG4gICAgcmV0dXJuIHRhc2tEZWZpbml0aW9uO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDb250YWluZXJEZWZpbml0aW9uKFxuICAgIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsXG4gICAgcmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5LFxuICAgIGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cFxuICApOiBlY3MuQ29udGFpbmVyRGVmaW5pdGlvbiB7XG4gICAgLy8gUHJlcGFyZSBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IHtcbiAgICAgIFJFUVVJUkVEX1NFVFRJTkc6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgRU5WSVJPTk1FTlQ6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgIC4uLnByb3BzLmVudmlyb25tZW50VmFyaWFibGVzLFxuICAgIH07XG5cbiAgICAvLyBDcmVhdGUgY29udGFpbmVyXG4gICAgY29uc3QgY29udGFpbmVyID0gdGhpcy50YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ3Rlc3RhcHAtY29udGFpbmVyJywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRWNyUmVwb3NpdG9yeShyZXBvc2l0b3J5LCBwcm9wcy50YXNrSW1hZ2VUYWcgfHwgJ2xhdGVzdCcpLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogJ3Rlc3RhcHAnLFxuICAgICAgICBsb2dHcm91cCxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIFNFQ1JFVF9LRVk6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHRoaXMuYXBwU2VjcmV0cywgJ2FwcGxpY2F0aW9uLnNlY3JldF9rZXknKSxcbiAgICAgIH0sXG4gICAgICAvLyBDb250YWluZXIgc2VjdXJpdHkgc2V0dGluZ3NcbiAgICAgIHVzZXI6IHByb3BzLmVuYWJsZU5vblJvb3RDb250YWluZXIgPyAnMTAwMToxMDAxJyA6IHVuZGVmaW5lZCxcbiAgICAgIHJlYWRvbmx5Um9vdEZpbGVzeXN0ZW06IHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0gfHwgZmFsc2UsXG4gICAgICAvLyBSZXNvdXJjZSBsaW1pdHMgZm9yIHNlY3VyaXR5IGFuZCBwZXJmb3JtYW5jZVxuICAgICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IE1hdGguZmxvb3IoKHByb3BzLm1lbW9yeUxpbWl0TWlCIHx8IDUxMikgKiAwLjgpLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHBvcnQgbWFwcGluZ1xuICAgIGNvbnRhaW5lci5hZGRQb3J0TWFwcGluZ3Moe1xuICAgICAgY29udGFpbmVyUG9ydDogcHJvcHMuY29udGFpbmVyUG9ydCB8fCA4MDAwLFxuICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgICBuYW1lOiAnaHR0cCcsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgbW91bnQgcG9pbnRzIGZvciB0bXBmcyB2b2x1bWVzIGlmIHJlYWQtb25seSBmaWxlc3lzdGVtIGlzIGVuYWJsZWRcbiAgICBpZiAocHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSkge1xuICAgICAgY29udGFpbmVyLmFkZE1vdW50UG9pbnRzKHtcbiAgICAgICAgc291cmNlVm9sdW1lOiAndG1wLXZvbHVtZScsXG4gICAgICAgIGNvbnRhaW5lclBhdGg6ICcvdG1wJyxcbiAgICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy9hcHAvbG9ncycsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBjb250YWluZXI7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVRhcmdldEdyb3VwKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsIHZwYzogZWMyLklWcGMsIGxvYWRCYWxhbmNlcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5JQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIpOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uVGFyZ2V0R3JvdXAge1xuICAgIGNvbnN0IHRhcmdldEdyb3VwID0gbmV3IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25UYXJnZXRHcm91cCh0aGlzLCAnVGFyZ2V0R3JvdXAnLCB7XG4gICAgICB0YXJnZXRHcm91cE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXRnYCxcbiAgICAgIHBvcnQ6IHByb3BzLmNvbnRhaW5lclBvcnQgfHwgODAwMCxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIHZwYyxcbiAgICAgIHRhcmdldFR5cGU6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuVGFyZ2V0VHlwZS5JUCxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgIHBhdGg6IHByb3BzLmhlYWx0aENoZWNrUGF0aCB8fCAnL2hlYWx0aC8nLFxuICAgICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5Qcm90b2NvbC5IVFRQLFxuICAgICAgICBwb3J0OiAndHJhZmZpYy1wb3J0JyxcbiAgICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcyhwcm9wcy5oZWFsdGhDaGVja0ludGVydmFsIHx8IDMwKSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMocHJvcHMuaGVhbHRoQ2hlY2tUaW1lb3V0IHx8IDUpLFxuICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IHByb3BzLmhlYWx0aHlUaHJlc2hvbGRDb3VudCB8fCAyLFxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogcHJvcHMudW5oZWFsdGh5VGhyZXNob2xkQ291bnQgfHwgMyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHRhcmdldEdyb3VwKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHRhcmdldEdyb3VwKS5hZGQoJ0NvbXBvbmVudCcsICdBcHBsaWNhdGlvbi1UYXJnZXRHcm91cCcpO1xuXG4gICAgcmV0dXJuIHRhcmdldEdyb3VwO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVGYXJnYXRlU2VydmljZShcbiAgICBwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLFxuICAgIGNsdXN0ZXI6IGVjcy5JQ2x1c3RlcixcbiAgICBzZWN1cml0eUdyb3VwOiBlYzIuSVNlY3VyaXR5R3JvdXBcbiAgKTogZWNzLkZhcmdhdGVTZXJ2aWNlIHtcbiAgICBjb25zdCBzZXJ2aWNlTmFtZSA9IHByb3BzLnNlcnZpY2VOYW1lIHx8IGB0ZXN0YXBwLXNlcnZpY2UtJHtwcm9wcy5lbnZpcm9ubWVudH1gO1xuXG4gICAgY29uc3Qgc2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ0ZhcmdhdGVTZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOiB0aGlzLnRhc2tEZWZpbml0aW9uLFxuICAgICAgc2VydmljZU5hbWUsXG4gICAgICBkZXNpcmVkQ291bnQ6IHByb3BzLmRlc2lyZWRDb3VudCB8fCAxLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtzZWN1cml0eUdyb3VwXSxcbiAgICAgIGFzc2lnblB1YmxpY0lwOiBmYWxzZSwgLy8gUnVubmluZyBpbiBwcml2YXRlIHN1Ym5ldHNcbiAgICAgIGVuYWJsZUV4ZWN1dGVDb21tYW5kOiBwcm9wcy5lbnZpcm9ubWVudCAhPT0gJ3Byb2R1Y3Rpb24nLCAvLyBFbmFibGUgRUNTIEV4ZWMgZm9yIGRldi9zdGFnaW5nXG4gICAgICAvLyBEZXBsb3ltZW50IGNvbmZpZ3VyYXRpb24gZm9yIHplcm8tZG93bnRpbWUgZGVwbG95bWVudHMgaW4gcHJvZHVjdGlvblxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAxMDAgOiA1MCxcbiAgICAgIG1heEhlYWx0aHlQZXJjZW50OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gMjAwIDogMTUwLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJlIHNlcnZpY2UgbG9hZCBiYWxhbmNlcnNcbiAgICBzZXJ2aWNlLmF0dGFjaFRvQXBwbGljYXRpb25UYXJnZXRHcm91cCh0aGlzLnRhcmdldEdyb3VwKTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2Yoc2VydmljZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihzZXJ2aWNlKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtU2VydmljZScpO1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUhlYWx0aENoZWNrKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBIZWFsdGggY2hlY2sgY29uZmlndXJhdGlvbiBpcyBhbHJlYWR5IHNldCBpbiB0YXJnZXQgZ3JvdXAgY3JlYXRpb25cbiAgICAvLyBUaGlzIG1ldGhvZCBjYW4gYmUgZXh0ZW5kZWQgZm9yIGFkZGl0aW9uYWwgaGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb25zXG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUF1dG9TY2FsaW5nKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiBlY3MuU2NhbGFibGVUYXNrQ291bnQge1xuICAgIGNvbnN0IG1pbkNhcGFjaXR5ID0gcHJvcHMubWluQ2FwYWNpdHkgfHwgcHJvcHMuZGVzaXJlZENvdW50IHx8IDE7XG4gICAgY29uc3QgbWF4Q2FwYWNpdHkgPSBwcm9wcy5tYXhDYXBhY2l0eSB8fCAocHJvcHMuZGVzaXJlZENvdW50IHx8IDEpICogMztcblxuICAgIGNvbnN0IHNjYWxhYmxlVGFyZ2V0ID0gdGhpcy5zZXJ2aWNlLmF1dG9TY2FsZVRhc2tDb3VudCh7XG4gICAgICBtaW5DYXBhY2l0eSxcbiAgICAgIG1heENhcGFjaXR5LFxuICAgIH0pO1xuXG4gICAgLy8gQ1BVLWJhc2VkIGF1dG8gc2NhbGluZ1xuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25DcHVVdGlsaXphdGlvbignQ3B1U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogcHJvcHMuY3B1VGFyZ2V0VXRpbGl6YXRpb24gfHwgNzAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKHByb3BzLnNjYWxlSW5Db29sZG93bk1pbnV0ZXMgfHwgNSksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZU91dENvb2xkb3duTWludXRlcyB8fCAyKSxcbiAgICB9KTtcblxuICAgIC8vIE1lbW9yeS1iYXNlZCBhdXRvIHNjYWxpbmdcbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uTWVtb3J5VXRpbGl6YXRpb24oJ01lbW9yeVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IHByb3BzLm1lbW9yeVRhcmdldFV0aWxpemF0aW9uIHx8IDgwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZUluQ29vbGRvd25NaW51dGVzIHx8IDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVPdXRDb29sZG93bk1pbnV0ZXMgfHwgMiksXG4gICAgfSk7XG5cbiAgICAvLyBOb3RlOiBSZXF1ZXN0LWJhc2VkIGF1dG8gc2NhbGluZyB1c2luZyBzY2FsZU9uUmVxdWVzdENvdW50IHJlcXVpcmVzIHRoZSB0YXJnZXQgZ3JvdXAgXG4gICAgLy8gdG8gYmUgYXR0YWNoZWQgdG8gYSBsb2FkIGJhbGFuY2VyIGZpcnN0LiBTaW5jZSB3ZSdyZSBjcmVhdGluZyBsaXN0ZW5lciBydWxlcyBhZnRlciBcbiAgICAvLyB0aGUgYXV0byBzY2FsaW5nIHNldHVwLCB3ZSdsbCBza2lwIHJlcXVlc3QtYmFzZWQgc2NhbGluZyBmb3Igbm93LlxuICAgIC8vIFRoaXMgY2FuIGJlIGFkZGVkIGFzIGEgc2VwYXJhdGUgY29uc3RydWN0IGFmdGVyIHRoZSBsaXN0ZW5lciBydWxlcyBhcmUgY3JlYXRlZC5cblxuICAgIHJldHVybiBzY2FsYWJsZVRhcmdldDtcbiAgfVxuXG4gIHByaXZhdGUgYWRkTGlzdGVuZXJSdWxlcyhcbiAgICBodHRwTGlzdGVuZXI6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuSUFwcGxpY2F0aW9uTGlzdGVuZXIsXG4gICAgaHR0cHNMaXN0ZW5lcj86IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuSUFwcGxpY2F0aW9uTGlzdGVuZXJcbiAgKTogdm9pZCB7XG4gICAgLy8gQWRkIHJ1bGUgdG8gSFRUUCBsaXN0ZW5lclxuICAgIG5ldyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXJSdWxlKHRoaXMsICdIdHRwTGlzdGVuZXJSdWxlJywge1xuICAgICAgbGlzdGVuZXI6IGh0dHBMaXN0ZW5lcixcbiAgICAgIHByaW9yaXR5OiAxMDAsXG4gICAgICBjb25kaXRpb25zOiBbXG4gICAgICAgIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJDb25kaXRpb24ucGF0aFBhdHRlcm5zKFsnKiddKSxcbiAgICAgIF0sXG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZm9yd2FyZChbdGhpcy50YXJnZXRHcm91cF0pLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHJ1bGUgdG8gSFRUUFMgbGlzdGVuZXIgaWYgaXQgZXhpc3RzXG4gICAgaWYgKGh0dHBzTGlzdGVuZXIpIHtcbiAgICAgIG5ldyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXJSdWxlKHRoaXMsICdIdHRwc0xpc3RlbmVyUnVsZScsIHtcbiAgICAgICAgbGlzdGVuZXI6IGh0dHBzTGlzdGVuZXIsXG4gICAgICAgIHByaW9yaXR5OiAxMDAsXG4gICAgICAgIGNvbmRpdGlvbnM6IFtcbiAgICAgICAgICBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQ29uZGl0aW9uLnBhdGhQYXR0ZXJucyhbJyonXSksXG4gICAgICAgIF0sXG4gICAgICAgIGFjdGlvbjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckFjdGlvbi5mb3J3YXJkKFt0aGlzLnRhcmdldEdyb3VwXSksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldHVwUm91dGU1Myhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgY29uc3QgZG9tYWluTmFtZSA9IHRoaXMuZ2V0RG9tYWluTmFtZShwcm9wcyk7XG4gICAgaWYgKCFkb21haW5OYW1lIHx8ICFwcm9wcy5ob3N0ZWRab25lSWQgfHwgIXByb3BzLmJhc2VEb21haW4pIHJldHVybjtcblxuICAgIC8vIEltcG9ydCBleGlzdGluZyBob3N0ZWQgem9uZVxuICAgIHRoaXMuaG9zdGVkWm9uZSA9IHJvdXRlNTMuSG9zdGVkWm9uZS5mcm9tSG9zdGVkWm9uZUF0dHJpYnV0ZXModGhpcywgJ0hvc3RlZFpvbmUnLCB7XG4gICAgICBob3N0ZWRab25lSWQ6IHByb3BzLmhvc3RlZFpvbmVJZCxcbiAgICAgIHpvbmVOYW1lOiBwcm9wcy5iYXNlRG9tYWluLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IGxvYWQgYmFsYW5jZXIgZm9yIEROUyB0YXJnZXRcbiAgICBjb25zdCBsb2FkQmFsYW5jZXIgPSBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyLmZyb21BcHBsaWNhdGlvbkxvYWRCYWxhbmNlckF0dHJpYnV0ZXMoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRMb2FkQmFsYW5jZXInLFxuICAgICAge1xuICAgICAgICBsb2FkQmFsYW5jZXJBcm46IHByb3BzLmxvYWRCYWxhbmNlckFybixcbiAgICAgICAgc2VjdXJpdHlHcm91cElkOiAnJywgLy8gTm90IG5lZWRlZCBmb3IgRE5TIHJlY29yZCBjcmVhdGlvblxuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBDcmVhdGUgQSByZWNvcmQgZm9yIHRoZSBkb21haW5cbiAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsICdEbnNBUmVjb3JkJywge1xuICAgICAgem9uZTogdGhpcy5ob3N0ZWRab25lLFxuICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICBuZXcgcm91dGU1M3RhcmdldHMuTG9hZEJhbGFuY2VyVGFyZ2V0KGxvYWRCYWxhbmNlcilcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgQUFBQSByZWNvcmQgZm9yIElQdjYgKGlmIEFMQiBzdXBwb3J0cyBpdClcbiAgICBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsICdEbnNBYWFhUmVjb3JkJywge1xuICAgICAgem9uZTogdGhpcy5ob3N0ZWRab25lLFxuICAgICAgcmVjb3JkTmFtZTogZG9tYWluTmFtZSxcbiAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICBuZXcgcm91dGU1M3RhcmdldHMuTG9hZEJhbGFuY2VyVGFyZ2V0KGxvYWRCYWxhbmNlcilcbiAgICAgICksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIFNlcnZpY2Ugb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuc2VydmljZS5zZXJ2aWNlQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgU2VydmljZSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlcnZpY2VBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlcnZpY2VOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuc2VydmljZS5zZXJ2aWNlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VydmljZU5hbWVgLFxuICAgIH0pO1xuXG4gICAgLy8gVGFzayBEZWZpbml0aW9uIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza0RlZmluaXRpb25Bcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YXNrRGVmaW5pdGlvbi50YXNrRGVmaW5pdGlvbkFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFRhc2sgRGVmaW5pdGlvbiBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVRhc2tEZWZpbml0aW9uQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXNrRGVmaW5pdGlvbkZhbWlseScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhc2tEZWZpbml0aW9uLmZhbWlseSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFRhc2sgRGVmaW5pdGlvbiBGYW1pbHknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVRhc2tEZWZpbml0aW9uRmFtaWx5YCxcbiAgICB9KTtcblxuICAgIC8vIFRhcmdldCBHcm91cCBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1RhcmdldEdyb3VwQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFyZ2V0R3JvdXAudGFyZ2V0R3JvdXBBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFRhcmdldCBHcm91cCBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVRhcmdldEdyb3VwQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXJnZXRHcm91cE5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YXJnZXRHcm91cC50YXJnZXRHcm91cE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFRhcmdldCBHcm91cCBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXJnZXRHcm91cE5hbWVgLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjcmV0cyBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlY3JldHNBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gU2VjcmV0cyBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlY3JldHNBcm5gLFxuICAgIH0pO1xuXG4gICAgLy8gQXV0byBTY2FsaW5nIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXV0b1NjYWxpbmdUYXJnZXRJZCcsIHtcbiAgICAgIHZhbHVlOiBgc2VydmljZS8ke3RoaXMuc2VydmljZS5jbHVzdGVyLmNsdXN0ZXJOYW1lfS8ke3RoaXMuc2VydmljZS5zZXJ2aWNlTmFtZX1gLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXRvIFNjYWxpbmcgVGFyZ2V0IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1BdXRvU2NhbGluZ1RhcmdldElkYCxcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZ3VyYXRpb24gb3V0cHV0cyBmb3IgcmVmZXJlbmNlXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Rlc2lyZWRDb3VudCcsIHtcbiAgICAgIHZhbHVlOiAocHJvcHMuZGVzaXJlZENvdW50IHx8IDEpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ0N1cnJlbnQgRGVzaXJlZCBDb3VudCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza0NwdScsIHtcbiAgICAgIHZhbHVlOiAocHJvcHMuY3B1IHx8IDI1NikudG9TdHJpbmcoKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVGFzayBDUFUgVW5pdHMnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tNZW1vcnknLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLm1lbW9yeUxpbWl0TWlCIHx8IDUxMikudG9TdHJpbmcoKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVGFzayBNZW1vcnkgKE1pQiknLFxuICAgIH0pO1xuXG4gICAgLy8gQXBwbGljYXRpb24gVVJMIG91dHB1dFxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSB0aGlzLmdldERvbWFpbk5hbWUocHJvcHMpO1xuICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICBjb25zdCBwcm90b2NvbCA9IHByb3BzLmh0dHBzTGlzdGVuZXJBcm4gPyAnaHR0cHMnIDogJ2h0dHAnO1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcGxpY2F0aW9uVXJsJywge1xuICAgICAgICB2YWx1ZTogYCR7cHJvdG9jb2x9Oi8vJHtkb21haW5OYW1lfWAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMIHdpdGggY3VzdG9tIGRvbWFpbicsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1BcHBsaWNhdGlvblVybGAsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRmFsbGJhY2sgdG8gQUxCIEROUyBuYW1lIChpbXBvcnRlZCBmcm9tIHBsYXRmb3JtIHN0YWNrKVxuICAgICAgY29uc3QgYWxiRG5zID0gY2RrLkZuLmltcG9ydFZhbHVlKGAke3Byb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAnVGVzdEFwcC1QbGF0Zm9ybS1wcm9kdWN0aW9uJyA6IGBUZXN0QXBwLVBsYXRmb3JtLSR7cHJvcHMuZW52aXJvbm1lbnR9YH0tTG9hZEJhbGFuY2VyRE5TYCk7XG4gICAgICBjb25zdCBwcm90b2NvbCA9IHByb3BzLmh0dHBzTGlzdGVuZXJBcm4gPyAnaHR0cHMnIDogJ2h0dHAnO1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcGxpY2F0aW9uVXJsJywge1xuICAgICAgICB2YWx1ZTogYCR7cHJvdG9jb2x9Oi8vJHthbGJEbnN9YCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBVUkwgKEFMQiBETlMpJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUFwcGxpY2F0aW9uVXJsYCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufSJdfQ==