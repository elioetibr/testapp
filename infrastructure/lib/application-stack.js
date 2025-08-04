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
const secrets_loader_1 = require("./secrets-loader");
class ApplicationStack extends cdk.Stack {
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
    }
}
exports.ApplicationStack = ApplicationStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHBsaWNhdGlvbi1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLDJDQUEyQztBQUMzQyxpRkFBaUY7QUFDakYsaUVBQWlFO0FBSWpFLHFEQUFpRDtBQTRDakQsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQVM3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDRCQUE0QjtRQUM1QixJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksOEJBQWEsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7UUFFMUQsOENBQThDO1FBQzlDLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLDBCQUEwQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXpELHlCQUF5QjtRQUN6QixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDekQsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ2xCLGlCQUFpQixFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFO1lBQ2xDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7U0FDekMsQ0FBQyxDQUFDO1FBRUgsb0NBQW9DO1FBQ3BDLE1BQU0sd0JBQXdCLEdBQUcsR0FBRyxDQUFDLGFBQWEsQ0FBQyxtQkFBbUIsQ0FDcEUsSUFBSSxFQUFFLGtDQUFrQyxFQUN4QyxLQUFLLENBQUMsMEJBQTBCLENBQ2pDLENBQUM7UUFFRixxQkFBcUI7UUFDckIsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLE9BQU8sQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDekUsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLEdBQUc7WUFDSCxjQUFjLEVBQUUsQ0FBQyx3QkFBd0IsQ0FBQztTQUMzQyxDQUFDLENBQUM7UUFFSCx3QkFBd0I7UUFDeEIsTUFBTSxVQUFVLEdBQUcsR0FBRyxDQUFDLFVBQVUsQ0FBQyxrQkFBa0IsQ0FDbEQsSUFBSSxFQUFFLG9CQUFvQixFQUMxQixLQUFLLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUcsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQ3BELENBQUM7UUFFRixtQkFBbUI7UUFDbkIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FDN0MsSUFBSSxFQUFFLGtCQUFrQixFQUN4QixLQUFLLENBQUMsWUFBWSxDQUNuQixDQUFDO1FBRUYsZ0RBQWdEO1FBQ2hELE1BQU0sWUFBWSxHQUFHLHNCQUFzQixDQUFDLHVCQUF1QixDQUFDLHFDQUFxQyxDQUN2RyxJQUFJLEVBQUUsc0JBQXNCLEVBQzVCO1lBQ0UsZUFBZSxFQUFFLEtBQUssQ0FBQyxlQUFlO1lBQ3RDLGVBQWUsRUFBRSx3QkFBd0IsQ0FBQyxlQUFlO1NBQzFELENBQ0YsQ0FBQztRQUVGLE1BQU0sWUFBWSxHQUFHLHNCQUFzQixDQUFDLG1CQUFtQixDQUFDLGlDQUFpQyxDQUMvRixJQUFJLEVBQUUsc0JBQXNCLEVBQzVCO1lBQ0UsV0FBVyxFQUFFLEtBQUssQ0FBQyxlQUFlO1lBQ2xDLGFBQWEsRUFBRSx3QkFBd0I7U0FDeEMsQ0FDRixDQUFDO1FBRUYsSUFBSSxhQUFzRSxDQUFDO1FBQzNFLElBQUksS0FBSyxDQUFDLGdCQUFnQixFQUFFO1lBQzFCLGFBQWEsR0FBRyxzQkFBc0IsQ0FBQyxtQkFBbUIsQ0FBQyxpQ0FBaUMsQ0FDMUYsSUFBSSxFQUFFLHVCQUF1QixFQUM3QjtnQkFDRSxXQUFXLEVBQUUsS0FBSyxDQUFDLGdCQUFnQjtnQkFDbkMsYUFBYSxFQUFFLHdCQUF3QjthQUN4QyxDQUNGLENBQUM7U0FDSDtRQUVELG1CQUFtQjtRQUNuQixNQUFNLEVBQUUsYUFBYSxFQUFFLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBRXpFLHlCQUF5QjtRQUN6QixJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsYUFBYSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBRWhGLDhCQUE4QjtRQUM5QixJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyx5QkFBeUIsQ0FBQyxLQUFLLEVBQUUsVUFBVSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBRTdFLHNCQUFzQjtRQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBRXBFLHlCQUF5QjtRQUN6QixJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsT0FBTyxFQUFFLHdCQUF3QixDQUFDLENBQUM7UUFFbkYsMEJBQTBCO1FBQzFCLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVqQyxzQkFBc0I7UUFDdEIsSUFBSSxDQUFDLGNBQWMsR0FBRyxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFcEQscUJBQXFCO1FBQ3JCLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZLEVBQUUsYUFBYSxDQUFDLENBQUM7UUFFbkQsdUJBQXVCO1FBQ3ZCLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUIsQ0FBQztJQUVPLDBCQUEwQixDQUFDLEtBQTRCO1FBQzdELElBQUk7WUFDRixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLHVCQUF1QixFQUFFLENBQUM7WUFFN0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7Z0JBQzNELFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQyxXQUFXLGNBQWM7Z0JBQ3RELFdBQVcsRUFBRSxtQ0FBbUMsS0FBSyxDQUFDLFdBQVcsY0FBYztnQkFDL0Usb0JBQW9CLEVBQUU7b0JBQ3BCLG9CQUFvQixFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDO29CQUM3QyxpQkFBaUIsRUFBRSxjQUFjO29CQUNqQyxZQUFZLEVBQUUsS0FBSztvQkFDbkIsaUJBQWlCLEVBQUUsT0FBTztpQkFDM0I7Z0JBQ0QsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWTtvQkFDL0MsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsTUFBTTtvQkFDMUIsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTzthQUM5QixDQUFDLENBQUM7WUFFSCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUMxRCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLFVBQVUsQ0FBQyxDQUFDO1lBQ2pELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUscUJBQXFCLENBQUMsQ0FBQztZQUU1RCxPQUFPLE1BQU0sQ0FBQztTQUNmO1FBQUMsT0FBTyxLQUFLLEVBQUU7WUFDZCxPQUFPLENBQUMsSUFBSSxDQUFDLHVEQUF1RCxLQUFLLEVBQUUsQ0FBQyxDQUFDO1lBRTdFLE9BQU8sSUFBSSxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7Z0JBQ25ELFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQyxXQUFXLGNBQWM7Z0JBQ3RELFdBQVcsRUFBRSxtQ0FBbUMsS0FBSyxDQUFDLFdBQVcsMENBQTBDO2dCQUMzRyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZO29CQUMvQyxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxNQUFNO29CQUMxQixDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO2FBQzlCLENBQUMsQ0FBQztTQUNKO0lBQ0gsQ0FBQztJQUVPLGNBQWMsQ0FBQyxLQUE0QixFQUFFLFFBQXdCO1FBQzNFLHNCQUFzQjtRQUN0QixNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzVELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyx5QkFBeUIsQ0FBQztZQUM5RCxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUMsV0FBVyxpQkFBaUI7WUFDdkQsZUFBZSxFQUFFO2dCQUNmLEdBQUcsQ0FBQyxhQUFhLENBQUMsd0JBQXdCLENBQUMsK0NBQStDLENBQUM7YUFDNUY7WUFDRCxjQUFjLEVBQUU7Z0JBQ2QsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQztvQkFDaEMsVUFBVSxFQUFFO3dCQUNWLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLDJCQUEyQjtnQ0FDM0IsaUNBQWlDO2dDQUNqQyw0QkFBNEI7Z0NBQzVCLG1CQUFtQjs2QkFDcEI7NEJBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO3lCQUNqQixDQUFDO3FCQUNIO2lCQUNGLENBQUM7Z0JBQ0Ysb0JBQW9CLEVBQUUsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDO29CQUMzQyxVQUFVLEVBQUU7d0JBQ1YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDOzRCQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLOzRCQUN4QixPQUFPLEVBQUU7Z0NBQ1AsK0JBQStCO2dDQUMvQiwrQkFBK0I7NkJBQ2hDOzRCQUNELFNBQVMsRUFBRSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsU0FBUyxDQUFDO3lCQUN2QyxDQUFDO3FCQUNIO2lCQUNGLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUVILFlBQVk7UUFDWixNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUM5QyxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMseUJBQXlCLENBQUM7WUFDOUQsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDLFdBQVcsWUFBWTtZQUNsRCxjQUFjLEVBQUU7Z0JBQ2QsY0FBYyxFQUFFLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQztvQkFDckMsVUFBVSxFQUFFO3dCQUNWLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLHNCQUFzQjtnQ0FDdEIsbUJBQW1COzZCQUNwQjs0QkFDRCxTQUFTLEVBQUUsQ0FBQyxRQUFRLENBQUMsV0FBVyxHQUFHLEdBQUcsQ0FBQzt5QkFDeEMsQ0FBQztxQkFDSDtpQkFDRixDQUFDO2dCQUNGLG9CQUFvQixFQUFFLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQztvQkFDM0MsVUFBVSxFQUFFO3dCQUNWLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLCtCQUErQjtnQ0FDL0IsK0JBQStCOzZCQUNoQzs0QkFDRCxTQUFTLEVBQUUsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQzt5QkFDdkMsQ0FBQztxQkFDSDtpQkFDRixDQUFDO2FBQ0g7U0FDRixDQUFDLENBQUM7UUFFSCxXQUFXO1FBQ1gsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsYUFBYSxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsRUFBRSxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDakUsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsYUFBYSxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1FBQ2xFLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzVELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsZUFBZSxDQUFDLENBQUM7UUFFeEQsT0FBTyxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsQ0FBQztJQUNyQyxDQUFDO0lBRU8sb0JBQW9CLENBQzFCLEtBQTRCLEVBQzVCLGFBQXVCLEVBQ3ZCLFFBQWtCO1FBRWxCLE1BQU0sY0FBYyxHQUFHLElBQUksR0FBRyxDQUFDLHFCQUFxQixDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUMzRSxNQUFNLEVBQUUsV0FBVyxLQUFLLENBQUMsV0FBVyxFQUFFO1lBQ3RDLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRyxJQUFJLEdBQUc7WUFDckIsY0FBYyxFQUFFLEtBQUssQ0FBQyxjQUFjLElBQUksR0FBRztZQUMzQyxhQUFhO1lBQ2IsUUFBUTtTQUNULENBQUMsQ0FBQztRQUVILDREQUE0RDtRQUM1RCxJQUFJLEtBQUssQ0FBQyw0QkFBNEIsRUFBRTtZQUN0QyxjQUFjLENBQUMsU0FBUyxDQUFDO2dCQUN2QixJQUFJLEVBQUUsWUFBWTtnQkFDbEIsSUFBSSxFQUFFLEVBQUU7YUFDVCxDQUFDLENBQUM7WUFFSCxjQUFjLENBQUMsU0FBUyxDQUFDO2dCQUN2QixJQUFJLEVBQUUsYUFBYTtnQkFDbkIsSUFBSSxFQUFFLEVBQUU7YUFDVCxDQUFDLENBQUM7U0FDSjtRQUVELFdBQVc7UUFDWCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUNsRSxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLHFCQUFxQixDQUFDLENBQUM7UUFFcEUsT0FBTyxjQUFjLENBQUM7SUFDeEIsQ0FBQztJQUVPLHlCQUF5QixDQUMvQixLQUE0QixFQUM1QixVQUEyQixFQUMzQixRQUF3QjtRQUV4QixnQ0FBZ0M7UUFDaEMsTUFBTSxXQUFXLEdBQUc7WUFDbEIsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDbkMsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLGtCQUFrQixFQUFFLElBQUksQ0FBQyxNQUFNO1lBQy9CLEdBQUcsS0FBSyxDQUFDLG9CQUFvQjtTQUM5QixDQUFDO1FBRUYsbUJBQW1CO1FBQ25CLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsWUFBWSxDQUFDLG1CQUFtQixFQUFFO1lBQ3RFLEtBQUssRUFBRSxHQUFHLENBQUMsY0FBYyxDQUFDLGlCQUFpQixDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsWUFBWSxJQUFJLFFBQVEsQ0FBQztZQUN2RixPQUFPLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUM7Z0JBQzlCLFlBQVksRUFBRSxTQUFTO2dCQUN2QixRQUFRO2FBQ1QsQ0FBQztZQUNGLFdBQVc7WUFDWCxPQUFPLEVBQUU7Z0JBQ1AsVUFBVSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSx3QkFBd0IsQ0FBQzthQUNyRjtZQUNELDhCQUE4QjtZQUM5QixJQUFJLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFNBQVM7WUFDNUQsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLDRCQUE0QixJQUFJLEtBQUs7WUFDbkUsK0NBQStDO1lBQy9DLG9CQUFvQixFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUMsY0FBYyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQztTQUN0RSxDQUFDLENBQUM7UUFFSCxtQkFBbUI7UUFDbkIsU0FBUyxDQUFDLGVBQWUsQ0FBQztZQUN4QixhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWEsSUFBSSxJQUFJO1lBQzFDLFFBQVEsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLEdBQUc7WUFDMUIsSUFBSSxFQUFFLE1BQU07U0FDYixDQUFDLENBQUM7UUFFSCx3RUFBd0U7UUFDeEUsSUFBSSxLQUFLLENBQUMsNEJBQTRCLEVBQUU7WUFDdEMsU0FBUyxDQUFDLGNBQWMsQ0FBQztnQkFDdkIsWUFBWSxFQUFFLFlBQVk7Z0JBQzFCLGFBQWEsRUFBRSxNQUFNO2dCQUNyQixRQUFRLEVBQUUsS0FBSzthQUNoQixDQUFDLENBQUM7WUFFSCxTQUFTLENBQUMsY0FBYyxDQUFDO2dCQUN2QixZQUFZLEVBQUUsYUFBYTtnQkFDM0IsYUFBYSxFQUFFLFdBQVc7Z0JBQzFCLFFBQVEsRUFBRSxLQUFLO2FBQ2hCLENBQUMsQ0FBQztTQUNKO1FBRUQsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVPLGlCQUFpQixDQUFDLEtBQTRCLEVBQUUsR0FBYSxFQUFFLFlBQTZEO1FBQ2xJLE1BQU0sV0FBVyxHQUFHLElBQUksc0JBQXNCLENBQUMsc0JBQXNCLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUN6RixlQUFlLEVBQUUsV0FBVyxLQUFLLENBQUMsV0FBVyxLQUFLO1lBQ2xELElBQUksRUFBRSxLQUFLLENBQUMsYUFBYSxJQUFJLElBQUk7WUFDakMsUUFBUSxFQUFFLHNCQUFzQixDQUFDLG1CQUFtQixDQUFDLElBQUk7WUFDekQsR0FBRztZQUNILFVBQVUsRUFBRSxzQkFBc0IsQ0FBQyxVQUFVLENBQUMsRUFBRTtZQUNoRCxXQUFXLEVBQUU7Z0JBQ1gsT0FBTyxFQUFFLElBQUk7Z0JBQ2IsSUFBSSxFQUFFLEtBQUssQ0FBQyxlQUFlLElBQUksVUFBVTtnQkFDekMsUUFBUSxFQUFFLHNCQUFzQixDQUFDLFFBQVEsQ0FBQyxJQUFJO2dCQUM5QyxJQUFJLEVBQUUsY0FBYztnQkFDcEIsZ0JBQWdCLEVBQUUsS0FBSztnQkFDdkIsUUFBUSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxtQkFBbUIsSUFBSSxFQUFFLENBQUM7Z0JBQy9ELE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsa0JBQWtCLElBQUksQ0FBQyxDQUFDO2dCQUM1RCxxQkFBcUIsRUFBRSxLQUFLLENBQUMscUJBQXFCLElBQUksQ0FBQztnQkFDdkQsdUJBQXVCLEVBQUUsS0FBSyxDQUFDLHVCQUF1QixJQUFJLENBQUM7YUFDNUQ7U0FDRixDQUFDLENBQUM7UUFFSCxXQUFXO1FBQ1gsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsRUFBRSxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDL0QsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO1FBRXJFLE9BQU8sV0FBVyxDQUFDO0lBQ3JCLENBQUM7SUFFTyxvQkFBb0IsQ0FDMUIsS0FBNEIsRUFDNUIsT0FBcUIsRUFDckIsYUFBaUM7UUFFakMsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxtQkFBbUIsS0FBSyxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBRWhGLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDN0QsT0FBTztZQUNQLGNBQWMsRUFBRSxJQUFJLENBQUMsY0FBYztZQUNuQyxXQUFXO1lBQ1gsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZLElBQUksQ0FBQztZQUNyQyxjQUFjLEVBQUUsQ0FBQyxhQUFhLENBQUM7WUFDL0IsY0FBYyxFQUFFLEtBQUs7WUFDckIsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZO1lBQ3hELHVFQUF1RTtZQUN2RSxpQkFBaUIsRUFBRSxLQUFLLENBQUMsV0FBVyxLQUFLLFlBQVksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFO1lBQ2hFLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUc7U0FDbEUsQ0FBQyxDQUFDO1FBRUgsbUNBQW1DO1FBQ25DLE9BQU8sQ0FBQyw4QkFBOEIsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUM7UUFFekQsV0FBVztRQUNYLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzNELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsYUFBYSxDQUFDLENBQUM7UUFFckQsT0FBTyxPQUFPLENBQUM7SUFDakIsQ0FBQztJQUVPLG9CQUFvQixDQUFDLEtBQTRCO1FBQ3ZELHFFQUFxRTtRQUNyRSx5RUFBeUU7SUFDM0UsQ0FBQztJQUVPLGlCQUFpQixDQUFDLEtBQTRCO1FBQ3BELE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksS0FBSyxDQUFDLFlBQVksSUFBSSxDQUFDLENBQUM7UUFDakUsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxDQUFDLEtBQUssQ0FBQyxZQUFZLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBRXZFLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUM7WUFDckQsV0FBVztZQUNYLFdBQVc7U0FDWixDQUFDLENBQUM7UUFFSCx5QkFBeUI7UUFDekIsY0FBYyxDQUFDLHFCQUFxQixDQUFDLFlBQVksRUFBRTtZQUNqRCx3QkFBd0IsRUFBRSxLQUFLLENBQUMsb0JBQW9CLElBQUksRUFBRTtZQUMxRCxlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLHNCQUFzQixJQUFJLENBQUMsQ0FBQztZQUN4RSxnQkFBZ0IsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsdUJBQXVCLElBQUksQ0FBQyxDQUFDO1NBQzNFLENBQUMsQ0FBQztRQUVILDRCQUE0QjtRQUM1QixjQUFjLENBQUMsd0JBQXdCLENBQUMsZUFBZSxFQUFFO1lBQ3ZELHdCQUF3QixFQUFFLEtBQUssQ0FBQyx1QkFBdUIsSUFBSSxFQUFFO1lBQzdELGVBQWUsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLElBQUksQ0FBQyxDQUFDO1lBQ3hFLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyx1QkFBdUIsSUFBSSxDQUFDLENBQUM7U0FDM0UsQ0FBQyxDQUFDO1FBRUgsd0ZBQXdGO1FBQ3hGLHNGQUFzRjtRQUN0RixvRUFBb0U7UUFDcEUsa0ZBQWtGO1FBRWxGLE9BQU8sY0FBYyxDQUFDO0lBQ3hCLENBQUM7SUFFTyxnQkFBZ0IsQ0FDdEIsWUFBeUQsRUFDekQsYUFBMkQ7UUFFM0QsNEJBQTRCO1FBQzVCLElBQUksc0JBQXNCLENBQUMsdUJBQXVCLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzNFLFFBQVEsRUFBRSxZQUFZO1lBQ3RCLFFBQVEsRUFBRSxHQUFHO1lBQ2IsVUFBVSxFQUFFO2dCQUNWLHNCQUFzQixDQUFDLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2FBQzdEO1lBQ0QsTUFBTSxFQUFFLHNCQUFzQixDQUFDLGNBQWMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUM7U0FDMUUsQ0FBQyxDQUFDO1FBRUgsMENBQTBDO1FBQzFDLElBQUksYUFBYSxFQUFFO1lBQ2pCLElBQUksc0JBQXNCLENBQUMsdUJBQXVCLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO2dCQUM1RSxRQUFRLEVBQUUsYUFBYTtnQkFDdkIsUUFBUSxFQUFFLEdBQUc7Z0JBQ2IsVUFBVSxFQUFFO29CQUNWLHNCQUFzQixDQUFDLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2lCQUM3RDtnQkFDRCxNQUFNLEVBQUUsc0JBQXNCLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQzthQUMxRSxDQUFDLENBQUM7U0FDSjtJQUNILENBQUM7SUFFTyxhQUFhLENBQUMsS0FBNEI7UUFDaEQsa0JBQWtCO1FBQ2xCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVU7WUFDOUIsV0FBVyxFQUFFLGlCQUFpQjtZQUM5QixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxhQUFhO1NBQzNDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDL0IsV0FBVyxFQUFFLGtCQUFrQjtZQUMvQixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxjQUFjO1NBQzVDLENBQUMsQ0FBQztRQUVILDBCQUEwQjtRQUMxQixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzNDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLGlCQUFpQjtZQUM1QyxXQUFXLEVBQUUseUJBQXlCO1lBQ3RDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLG9CQUFvQjtTQUNsRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzlDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU07WUFDakMsV0FBVyxFQUFFLDRCQUE0QjtZQUN6QyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyx1QkFBdUI7U0FDckQsQ0FBQyxDQUFDO1FBRUgsdUJBQXVCO1FBQ3ZCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsY0FBYztZQUN0QyxXQUFXLEVBQUUsOEJBQThCO1lBQzNDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGlCQUFpQjtTQUMvQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3pDLEtBQUssRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDdkMsV0FBVyxFQUFFLCtCQUErQjtZQUM1QyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxrQkFBa0I7U0FDaEQsQ0FBQyxDQUFDO1FBRUgsa0JBQWtCO1FBQ2xCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLFNBQVM7WUFDaEMsV0FBVyxFQUFFLHlCQUF5QjtZQUN0QyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxhQUFhO1NBQzNDLENBQUMsQ0FBQztRQUVILHVCQUF1QjtRQUN2QixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSxXQUFXLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFdBQVcsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsRUFBRTtZQUNoRixXQUFXLEVBQUUsd0JBQXdCO1lBQ3JDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLHNCQUFzQjtTQUNwRCxDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDdEMsS0FBSyxFQUFFLENBQUMsS0FBSyxDQUFDLFlBQVksSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUU7WUFDM0MsV0FBVyxFQUFFLHVCQUF1QjtTQUNyQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUNqQyxLQUFLLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLFFBQVEsRUFBRTtZQUNwQyxXQUFXLEVBQUUsZ0JBQWdCO1NBQzlCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksR0FBRyxDQUFDLENBQUMsUUFBUSxFQUFFO1lBQy9DLFdBQVcsRUFBRSxtQkFBbUI7U0FDakMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBcGZELDRDQW9mQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gnO1xuaW1wb3J0ICogYXMgYXBwbGljYXRpb25hdXRvc2NhbGluZyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBwbGljYXRpb25hdXRvc2NhbGluZyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IFNlY3JldHNMb2FkZXIgfSBmcm9tICcuL3NlY3JldHMtbG9hZGVyJztcblxuZXhwb3J0IGludGVyZmFjZSBBcHBsaWNhdGlvblN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGVudmlyb25tZW50OiBzdHJpbmc7XG4gIC8vIFZQQyBjb25maWd1cmF0aW9uXG4gIHZwY0lkOiBzdHJpbmc7XG4gIHByaXZhdGVTdWJuZXRJZHM6IHN0cmluZ1tdO1xuICBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZDogc3RyaW5nO1xuICAvLyBFQ1MgUGxhdGZvcm0gY29uZmlndXJhdGlvblxuICBjbHVzdGVyQXJuOiBzdHJpbmc7XG4gIGNsdXN0ZXJOYW1lOiBzdHJpbmc7XG4gIHJlcG9zaXRvcnlVcmk6IHN0cmluZztcbiAgbG9hZEJhbGFuY2VyQXJuOiBzdHJpbmc7XG4gIGh0dHBMaXN0ZW5lckFybjogc3RyaW5nO1xuICBodHRwc0xpc3RlbmVyQXJuPzogc3RyaW5nO1xuICBsb2dHcm91cE5hbWU6IHN0cmluZztcbiAgbG9nR3JvdXBBcm46IHN0cmluZztcbiAgLy8gQXBwbGljYXRpb24gY29uZmlndXJhdGlvblxuICBzZXJ2aWNlTmFtZT86IHN0cmluZztcbiAgdGFza0ltYWdlVGFnPzogc3RyaW5nO1xuICBkZXNpcmVkQ291bnQ/OiBudW1iZXI7XG4gIGNwdT86IG51bWJlcjtcbiAgbWVtb3J5TGltaXRNaUI/OiBudW1iZXI7XG4gIGNvbnRhaW5lclBvcnQ/OiBudW1iZXI7XG4gIC8vIEF1dG8gc2NhbGluZyBjb25maWd1cmF0aW9uXG4gIG1pbkNhcGFjaXR5PzogbnVtYmVyO1xuICBtYXhDYXBhY2l0eT86IG51bWJlcjtcbiAgY3B1VGFyZ2V0VXRpbGl6YXRpb24/OiBudW1iZXI7XG4gIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uPzogbnVtYmVyO1xuICBzY2FsZUluQ29vbGRvd25NaW51dGVzPzogbnVtYmVyO1xuICBzY2FsZU91dENvb2xkb3duTWludXRlcz86IG51bWJlcjtcbiAgLy8gSGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb25cbiAgaGVhbHRoQ2hlY2tQYXRoPzogc3RyaW5nO1xuICBoZWFsdGhDaGVja0ludGVydmFsPzogbnVtYmVyO1xuICBoZWFsdGhDaGVja1RpbWVvdXQ/OiBudW1iZXI7XG4gIGhlYWx0aHlUaHJlc2hvbGRDb3VudD86IG51bWJlcjtcbiAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ/OiBudW1iZXI7XG4gIC8vIENvbnRhaW5lciBzZWN1cml0eVxuICBlbmFibGVOb25Sb290Q29udGFpbmVyPzogYm9vbGVhbjtcbiAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbT86IGJvb2xlYW47XG4gIC8vIEVudmlyb25tZW50IHZhcmlhYmxlc1xuICBlbnZpcm9ubWVudFZhcmlhYmxlcz86IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBsaWNhdGlvblN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHNlcnZpY2U6IGVjcy5GYXJnYXRlU2VydmljZTtcbiAgcHVibGljIHJlYWRvbmx5IHRhc2tEZWZpbml0aW9uOiBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgY29udGFpbmVyOiBlY3MuQ29udGFpbmVyRGVmaW5pdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IHRhcmdldEdyb3VwOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uVGFyZ2V0R3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBzY2FsYWJsZVRhcmdldDogZWNzLlNjYWxhYmxlVGFza0NvdW50O1xuICBwdWJsaWMgcmVhZG9ubHkgYXBwU2VjcmV0czogc2VjcmV0c21hbmFnZXIuU2VjcmV0O1xuICBwcml2YXRlIHJlYWRvbmx5IHNlY3JldHNMb2FkZXI6IFNlY3JldHNMb2FkZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzZWNyZXRzIGxvYWRlclxuICAgIHRoaXMuc2VjcmV0c0xvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKHByb3BzLmVudmlyb25tZW50KTtcbiAgICBcbiAgICAvLyBDcmVhdGUgQVdTIFNlY3JldHMgTWFuYWdlciBzZWNyZXQgZnJvbSBTT1BTXG4gICAgdGhpcy5hcHBTZWNyZXRzID0gdGhpcy5jcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wcyk7XG5cbiAgICAvLyBJbXBvcnQgVlBDIGFuZCBzdWJuZXRzXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tVnBjQXR0cmlidXRlcyh0aGlzLCAnSW1wb3J0ZWRWcGMnLCB7XG4gICAgICB2cGNJZDogcHJvcHMudnBjSWQsXG4gICAgICBhdmFpbGFiaWxpdHlab25lczogY2RrLkZuLmdldEF6cygpLFxuICAgICAgcHJpdmF0ZVN1Ym5ldElkczogcHJvcHMucHJpdmF0ZVN1Ym5ldElkcyxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBhcHBsaWNhdGlvbiBzZWN1cml0eSBncm91cFxuICAgIGNvbnN0IGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cCA9IGVjMi5TZWN1cml0eUdyb3VwLmZyb21TZWN1cml0eUdyb3VwSWQoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRBcHBsaWNhdGlvblNlY3VyaXR5R3JvdXAnLFxuICAgICAgcHJvcHMuYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWRcbiAgICApO1xuXG4gICAgLy8gSW1wb3J0IEVDUyBjbHVzdGVyXG4gICAgY29uc3QgY2x1c3RlciA9IGVjcy5DbHVzdGVyLmZyb21DbHVzdGVyQXR0cmlidXRlcyh0aGlzLCAnSW1wb3J0ZWRDbHVzdGVyJywge1xuICAgICAgY2x1c3Rlck5hbWU6IHByb3BzLmNsdXN0ZXJOYW1lLFxuICAgICAgdnBjLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFthcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBdLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IEVDUiByZXBvc2l0b3J5XG4gICAgY29uc3QgcmVwb3NpdG9yeSA9IGVjci5SZXBvc2l0b3J5LmZyb21SZXBvc2l0b3J5TmFtZShcbiAgICAgIHRoaXMsICdJbXBvcnRlZFJlcG9zaXRvcnknLCBcbiAgICAgIHByb3BzLnJlcG9zaXRvcnlVcmkuc3BsaXQoJy8nKS5wb3AoKSEuc3BsaXQoJzonKVswXVxuICAgICk7XG5cbiAgICAvLyBJbXBvcnQgbG9nIGdyb3VwXG4gICAgY29uc3QgbG9nR3JvdXAgPSBsb2dzLkxvZ0dyb3VwLmZyb21Mb2dHcm91cE5hbWUoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRMb2dHcm91cCcsXG4gICAgICBwcm9wcy5sb2dHcm91cE5hbWVcbiAgICApO1xuXG4gICAgLy8gSW1wb3J0IGxvYWQgYmFsYW5jZXIgYW5kIGxpc3RlbmVycyB1c2luZyBBUk5zXG4gICAgY29uc3QgbG9hZEJhbGFuY2VyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlci5mcm9tQXBwbGljYXRpb25Mb2FkQmFsYW5jZXJBdHRyaWJ1dGVzKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9hZEJhbGFuY2VyJyxcbiAgICAgIHsgXG4gICAgICAgIGxvYWRCYWxhbmNlckFybjogcHJvcHMubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgICBzZWN1cml0eUdyb3VwSWQ6IGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWRcbiAgICAgIH1cbiAgICApO1xuXG4gICAgY29uc3QgaHR0cExpc3RlbmVyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyLmZyb21BcHBsaWNhdGlvbkxpc3RlbmVyQXR0cmlidXRlcyhcbiAgICAgIHRoaXMsICdJbXBvcnRlZEh0dHBMaXN0ZW5lcicsXG4gICAgICB7IFxuICAgICAgICBsaXN0ZW5lckFybjogcHJvcHMuaHR0cExpc3RlbmVyQXJuLFxuICAgICAgICBzZWN1cml0eUdyb3VwOiBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBcbiAgICAgIH1cbiAgICApO1xuXG4gICAgbGV0IGh0dHBzTGlzdGVuZXI6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuSUFwcGxpY2F0aW9uTGlzdGVuZXIgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHByb3BzLmh0dHBzTGlzdGVuZXJBcm4pIHtcbiAgICAgIGh0dHBzTGlzdGVuZXIgPSBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIuZnJvbUFwcGxpY2F0aW9uTGlzdGVuZXJBdHRyaWJ1dGVzKFxuICAgICAgICB0aGlzLCAnSW1wb3J0ZWRIdHRwc0xpc3RlbmVyJyxcbiAgICAgICAgeyBcbiAgICAgICAgICBsaXN0ZW5lckFybjogcHJvcHMuaHR0cHNMaXN0ZW5lckFybixcbiAgICAgICAgICBzZWN1cml0eUdyb3VwOiBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBcbiAgICAgICAgfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgSUFNIHJvbGVzXG4gICAgY29uc3QgeyBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSB9ID0gdGhpcy5jcmVhdGVJYW1Sb2xlcyhwcm9wcywgbG9nR3JvdXApO1xuXG4gICAgLy8gQ3JlYXRlIHRhc2sgZGVmaW5pdGlvblxuICAgIHRoaXMudGFza0RlZmluaXRpb24gPSB0aGlzLmNyZWF0ZVRhc2tEZWZpbml0aW9uKHByb3BzLCBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSk7XG5cbiAgICAvLyBDcmVhdGUgY29udGFpbmVyIGRlZmluaXRpb25cbiAgICB0aGlzLmNvbnRhaW5lciA9IHRoaXMuY3JlYXRlQ29udGFpbmVyRGVmaW5pdGlvbihwcm9wcywgcmVwb3NpdG9yeSwgbG9nR3JvdXApO1xuXG4gICAgLy8gQ3JlYXRlIHRhcmdldCBncm91cFxuICAgIHRoaXMudGFyZ2V0R3JvdXAgPSB0aGlzLmNyZWF0ZVRhcmdldEdyb3VwKHByb3BzLCB2cGMsIGxvYWRCYWxhbmNlcik7XG5cbiAgICAvLyBDcmVhdGUgRmFyZ2F0ZSBzZXJ2aWNlXG4gICAgdGhpcy5zZXJ2aWNlID0gdGhpcy5jcmVhdGVGYXJnYXRlU2VydmljZShwcm9wcywgY2x1c3RlciwgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwKTtcblxuICAgIC8vIENvbmZpZ3VyZSBoZWFsdGggY2hlY2tzXG4gICAgdGhpcy5jb25maWd1cmVIZWFsdGhDaGVjayhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgYXV0byBzY2FsaW5nXG4gICAgdGhpcy5zY2FsYWJsZVRhcmdldCA9IHRoaXMuY3JlYXRlQXV0b1NjYWxpbmcocHJvcHMpO1xuXG4gICAgLy8gQWRkIGxpc3RlbmVyIHJ1bGVzXG4gICAgdGhpcy5hZGRMaXN0ZW5lclJ1bGVzKGh0dHBMaXN0ZW5lciwgaHR0cHNMaXN0ZW5lcik7XG5cbiAgICAvLyBDcmVhdGUgc3RhY2sgb3V0cHV0c1xuICAgIHRoaXMuY3JlYXRlT3V0cHV0cyhwcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3JldHNNYW5hZ2VyU2VjcmV0KHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzZWNyZXRzID0gdGhpcy5zZWNyZXRzTG9hZGVyLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG4gICAgICBcbiAgICAgIGNvbnN0IHNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0FwcFNlY3JldHMnLCB7XG4gICAgICAgIHNlY3JldE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFwcC1zZWNyZXRzYCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoc2VjcmV0cyksXG4gICAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICdnZW5lcmF0ZWRfYXQnLFxuICAgICAgICAgIGluY2x1ZGVTcGFjZTogZmFsc2UsXG4gICAgICAgICAgZXhjbHVkZUNoYXJhY3RlcnM6ICdcIkAvXFxcXCdcbiAgICAgICAgfSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcblxuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ01hbmFnZWRCeScsICdDREstU09QUycpO1xuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ0NvbXBvbmVudCcsICdBcHBsaWNhdGlvbi1TZWNyZXRzJyk7XG4gICAgICBcbiAgICAgIHJldHVybiBzZWNyZXQ7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUud2FybihgRmFpbGVkIHRvIGxvYWQgU09QUyBzZWNyZXRzLCBjcmVhdGluZyBlbXB0eSBzZWNyZXQ6ICR7ZXJyb3J9YCk7XG4gICAgICBcbiAgICAgIHJldHVybiBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hcHAtc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudCAoZW1wdHkgLSBwb3B1bGF0ZSBtYW51YWxseSlgLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlSWFtUm9sZXMocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcywgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwKSB7XG4gICAgLy8gVGFzayBleGVjdXRpb24gcm9sZVxuICAgIGNvbnN0IGV4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rhc2tFeGVjdXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICByb2xlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tZXhlY3V0aW9uLXJvbGVgLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5JyksXG4gICAgICBdLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgRUNSQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICAgIFNlY3JldHNNYW5hZ2VyQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBUYXNrIHJvbGVcbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGFza1JvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIHJvbGVOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS10YXNrLXJvbGVgLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgQ2xvdWRXYXRjaExvZ3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcbiAgICAgICAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cC5sb2dHcm91cEFybiArICcqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgU2VjcmV0c01hbmFnZXJBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLmFwcFNlY3JldHMuc2VjcmV0QXJuXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoZXhlY3V0aW9uUm9sZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihleGVjdXRpb25Sb2xlKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtRXhlY3V0aW9uLVJvbGUnKTtcbiAgICBjZGsuVGFncy5vZih0YXNrUm9sZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0YXNrUm9sZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLVRhc2stUm9sZScpO1xuXG4gICAgcmV0dXJuIHsgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUgfTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVGFza0RlZmluaXRpb24oXG4gICAgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyxcbiAgICBleGVjdXRpb25Sb2xlOiBpYW0uUm9sZSxcbiAgICB0YXNrUm9sZTogaWFtLlJvbGVcbiAgKTogZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbiB7XG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnVGFza0RlZmluaXRpb24nLCB7XG4gICAgICBmYW1pbHk6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGNwdTogcHJvcHMuY3B1IHx8IDI1NixcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIsXG4gICAgICBleGVjdXRpb25Sb2xlLFxuICAgICAgdGFza1JvbGUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdG1wZnMgdm9sdW1lcyBpZiByZWFkLW9ubHkgcm9vdCBmaWxlc3lzdGVtIGlzIGVuYWJsZWRcbiAgICBpZiAocHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSkge1xuICAgICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBob3N0OiB7fSxcbiAgICAgIH0pO1xuXG4gICAgICB0YXNrRGVmaW5pdGlvbi5hZGRWb2x1bWUoe1xuICAgICAgICBuYW1lOiAnbG9ncy12b2x1bWUnLFxuICAgICAgICBob3N0OiB7fSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YodGFza0RlZmluaXRpb24pLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodGFza0RlZmluaXRpb24pLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1UYXNrLURlZmluaXRpb24nKTtcblxuICAgIHJldHVybiB0YXNrRGVmaW5pdGlvbjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ29udGFpbmVyRGVmaW5pdGlvbihcbiAgICBwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLFxuICAgIHJlcG9zaXRvcnk6IGVjci5JUmVwb3NpdG9yeSxcbiAgICBsb2dHcm91cDogbG9ncy5JTG9nR3JvdXBcbiAgKTogZWNzLkNvbnRhaW5lckRlZmluaXRpb24ge1xuICAgIC8vIFByZXBhcmUgZW52aXJvbm1lbnQgdmFyaWFibGVzXG4gICAgY29uc3QgZW52aXJvbm1lbnQgPSB7XG4gICAgICBSRVFVSVJFRF9TRVRUSU5HOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAuLi5wcm9wcy5lbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICB9O1xuXG4gICAgLy8gQ3JlYXRlIGNvbnRhaW5lclxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRoaXMudGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCd0ZXN0YXBwLWNvbnRhaW5lcicsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkocmVwb3NpdG9yeSwgcHJvcHMudGFza0ltYWdlVGFnIHx8ICdsYXRlc3QnKSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6ICd0ZXN0YXBwJyxcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50LFxuICAgICAgc2VjcmV0czoge1xuICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdhcHBsaWNhdGlvbi5zZWNyZXRfa2V5JyksXG4gICAgICB9LFxuICAgICAgLy8gQ29udGFpbmVyIHNlY3VyaXR5IHNldHRpbmdzXG4gICAgICB1c2VyOiBwcm9wcy5lbmFibGVOb25Sb290Q29udGFpbmVyID8gJzEwMDE6MTAwMScgOiB1bmRlZmluZWQsXG4gICAgICByZWFkb25seVJvb3RGaWxlc3lzdGVtOiBwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtIHx8IGZhbHNlLFxuICAgICAgLy8gUmVzb3VyY2UgbGltaXRzIGZvciBzZWN1cml0eSBhbmQgcGVyZm9ybWFuY2VcbiAgICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiBNYXRoLmZsb29yKChwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIpICogMC44KSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBwb3J0IG1hcHBpbmdcbiAgICBjb250YWluZXIuYWRkUG9ydE1hcHBpbmdzKHtcbiAgICAgIGNvbnRhaW5lclBvcnQ6IHByb3BzLmNvbnRhaW5lclBvcnQgfHwgODAwMCxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgICAgbmFtZTogJ2h0dHAnLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIG1vdW50IHBvaW50cyBmb3IgdG1wZnMgdm9sdW1lcyBpZiByZWFkLW9ubHkgZmlsZXN5c3RlbSBpcyBlbmFibGVkXG4gICAgaWYgKHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL3RtcCcsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuXG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBzb3VyY2VWb2x1bWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgIGNvbnRhaW5lclBhdGg6ICcvYXBwL2xvZ3MnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gY29udGFpbmVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVUYXJnZXRHcm91cChwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzLCB2cGM6IGVjMi5JVnBjLCBsb2FkQmFsYW5jZXI6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuSUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwIHtcbiAgICBjb25zdCB0YXJnZXRHcm91cCA9IG5ldyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uVGFyZ2V0R3JvdXAodGhpcywgJ1RhcmdldEdyb3VwJywge1xuICAgICAgdGFyZ2V0R3JvdXBOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS10Z2AsXG4gICAgICBwb3J0OiBwcm9wcy5jb250YWluZXJQb3J0IHx8IDgwMDAsXG4gICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICB2cGMsXG4gICAgICB0YXJnZXRUeXBlOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlRhcmdldFR5cGUuSVAsXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBwYXRoOiBwcm9wcy5oZWFsdGhDaGVja1BhdGggfHwgJy9oZWFsdGgvJyxcbiAgICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuUHJvdG9jb2wuSFRUUCxcbiAgICAgICAgcG9ydDogJ3RyYWZmaWMtcG9ydCcsXG4gICAgICAgIGhlYWx0aHlIdHRwQ29kZXM6ICcyMDAnLFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMocHJvcHMuaGVhbHRoQ2hlY2tJbnRlcnZhbCB8fCAzMCksXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHByb3BzLmhlYWx0aENoZWNrVGltZW91dCB8fCA1KSxcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiBwcm9wcy5oZWFsdGh5VGhyZXNob2xkQ291bnQgfHwgMixcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IHByb3BzLnVuaGVhbHRoeVRocmVzaG9sZENvdW50IHx8IDMsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZih0YXJnZXRHcm91cCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0YXJnZXRHcm91cCkuYWRkKCdDb21wb25lbnQnLCAnQXBwbGljYXRpb24tVGFyZ2V0R3JvdXAnKTtcblxuICAgIHJldHVybiB0YXJnZXRHcm91cDtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRmFyZ2F0ZVNlcnZpY2UoXG4gICAgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyxcbiAgICBjbHVzdGVyOiBlY3MuSUNsdXN0ZXIsXG4gICAgc2VjdXJpdHlHcm91cDogZWMyLklTZWN1cml0eUdyb3VwXG4gICk6IGVjcy5GYXJnYXRlU2VydmljZSB7XG4gICAgY29uc3Qgc2VydmljZU5hbWUgPSBwcm9wcy5zZXJ2aWNlTmFtZSB8fCBgdGVzdGFwcC1zZXJ2aWNlLSR7cHJvcHMuZW52aXJvbm1lbnR9YDtcblxuICAgIGNvbnN0IHNlcnZpY2UgPSBuZXcgZWNzLkZhcmdhdGVTZXJ2aWNlKHRoaXMsICdGYXJnYXRlU2VydmljZScsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbjogdGhpcy50YXNrRGVmaW5pdGlvbixcbiAgICAgIHNlcnZpY2VOYW1lLFxuICAgICAgZGVzaXJlZENvdW50OiBwcm9wcy5kZXNpcmVkQ291bnQgfHwgMSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbc2VjdXJpdHlHcm91cF0sXG4gICAgICBhc3NpZ25QdWJsaWNJcDogZmFsc2UsIC8vIFJ1bm5pbmcgaW4gcHJpdmF0ZSBzdWJuZXRzXG4gICAgICBlbmFibGVFeGVjdXRlQ29tbWFuZDogcHJvcHMuZW52aXJvbm1lbnQgIT09ICdwcm9kdWN0aW9uJywgLy8gRW5hYmxlIEVDUyBFeGVjIGZvciBkZXYvc3RhZ2luZ1xuICAgICAgLy8gRGVwbG95bWVudCBjb25maWd1cmF0aW9uIGZvciB6ZXJvLWRvd250aW1lIGRlcGxveW1lbnRzIGluIHByb2R1Y3Rpb25cbiAgICAgIG1pbkhlYWx0aHlQZXJjZW50OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gMTAwIDogNTAsXG4gICAgICBtYXhIZWFsdGh5UGVyY2VudDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDIwMCA6IDE1MCxcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZ3VyZSBzZXJ2aWNlIGxvYWQgYmFsYW5jZXJzXG4gICAgc2VydmljZS5hdHRhY2hUb0FwcGxpY2F0aW9uVGFyZ2V0R3JvdXAodGhpcy50YXJnZXRHcm91cCk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHNlcnZpY2UpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yoc2VydmljZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLVNlcnZpY2UnKTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVIZWFsdGhDaGVjayhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gSGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb24gaXMgYWxyZWFkeSBzZXQgaW4gdGFyZ2V0IGdyb3VwIGNyZWF0aW9uXG4gICAgLy8gVGhpcyBtZXRob2QgY2FuIGJlIGV4dGVuZGVkIGZvciBhZGRpdGlvbmFsIGhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uc1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVBdXRvU2NhbGluZyhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogZWNzLlNjYWxhYmxlVGFza0NvdW50IHtcbiAgICBjb25zdCBtaW5DYXBhY2l0eSA9IHByb3BzLm1pbkNhcGFjaXR5IHx8IHByb3BzLmRlc2lyZWRDb3VudCB8fCAxO1xuICAgIGNvbnN0IG1heENhcGFjaXR5ID0gcHJvcHMubWF4Q2FwYWNpdHkgfHwgKHByb3BzLmRlc2lyZWRDb3VudCB8fCAxKSAqIDM7XG5cbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IHRoaXMuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHksXG4gICAgICBtYXhDYXBhY2l0eSxcbiAgICB9KTtcblxuICAgIC8vIENQVS1iYXNlZCBhdXRvIHNjYWxpbmdcbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oJ0NwdVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IHByb3BzLmNwdVRhcmdldFV0aWxpemF0aW9uIHx8IDcwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZUluQ29vbGRvd25NaW51dGVzIHx8IDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVPdXRDb29sZG93bk1pbnV0ZXMgfHwgMiksXG4gICAgfSk7XG5cbiAgICAvLyBNZW1vcnktYmFzZWQgYXV0byBzY2FsaW5nXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbk1lbW9yeVV0aWxpemF0aW9uKCdNZW1vcnlTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiBwcm9wcy5tZW1vcnlUYXJnZXRVdGlsaXphdGlvbiB8fCA4MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVJbkNvb2xkb3duTWludXRlcyB8fCA1KSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKHByb3BzLnNjYWxlT3V0Q29vbGRvd25NaW51dGVzIHx8IDIpLFxuICAgIH0pO1xuXG4gICAgLy8gTm90ZTogUmVxdWVzdC1iYXNlZCBhdXRvIHNjYWxpbmcgdXNpbmcgc2NhbGVPblJlcXVlc3RDb3VudCByZXF1aXJlcyB0aGUgdGFyZ2V0IGdyb3VwIFxuICAgIC8vIHRvIGJlIGF0dGFjaGVkIHRvIGEgbG9hZCBiYWxhbmNlciBmaXJzdC4gU2luY2Ugd2UncmUgY3JlYXRpbmcgbGlzdGVuZXIgcnVsZXMgYWZ0ZXIgXG4gICAgLy8gdGhlIGF1dG8gc2NhbGluZyBzZXR1cCwgd2UnbGwgc2tpcCByZXF1ZXN0LWJhc2VkIHNjYWxpbmcgZm9yIG5vdy5cbiAgICAvLyBUaGlzIGNhbiBiZSBhZGRlZCBhcyBhIHNlcGFyYXRlIGNvbnN0cnVjdCBhZnRlciB0aGUgbGlzdGVuZXIgcnVsZXMgYXJlIGNyZWF0ZWQuXG5cbiAgICByZXR1cm4gc2NhbGFibGVUYXJnZXQ7XG4gIH1cblxuICBwcml2YXRlIGFkZExpc3RlbmVyUnVsZXMoXG4gICAgaHR0cExpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyLFxuICAgIGh0dHBzTGlzdGVuZXI/OiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyXG4gICk6IHZvaWQge1xuICAgIC8vIEFkZCBydWxlIHRvIEhUVFAgbGlzdGVuZXJcbiAgICBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyUnVsZSh0aGlzLCAnSHR0cExpc3RlbmVyUnVsZScsIHtcbiAgICAgIGxpc3RlbmVyOiBodHRwTGlzdGVuZXIsXG4gICAgICBwcmlvcml0eTogMTAwLFxuICAgICAgY29uZGl0aW9uczogW1xuICAgICAgICBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQ29uZGl0aW9uLnBhdGhQYXR0ZXJucyhbJyonXSksXG4gICAgICBdLFxuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZvcndhcmQoW3RoaXMudGFyZ2V0R3JvdXBdKSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBydWxlIHRvIEhUVFBTIGxpc3RlbmVyIGlmIGl0IGV4aXN0c1xuICAgIGlmIChodHRwc0xpc3RlbmVyKSB7XG4gICAgICBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyUnVsZSh0aGlzLCAnSHR0cHNMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIGxpc3RlbmVyOiBodHRwc0xpc3RlbmVyLFxuICAgICAgICBwcmlvcml0eTogMTAwLFxuICAgICAgICBjb25kaXRpb25zOiBbXG4gICAgICAgICAgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckNvbmRpdGlvbi5wYXRoUGF0dGVybnMoWycqJ10pLFxuICAgICAgICBdLFxuICAgICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZm9yd2FyZChbdGhpcy50YXJnZXRHcm91cF0pLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBTZXJ2aWNlIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VydmljZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNlcnZpY2Uuc2VydmljZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZXJ2aWNlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlcnZpY2VOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIFRhc2sgRGVmaW5pdGlvbiBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tEZWZpbml0aW9uQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXNrRGVmaW5pdGlvbkFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza0RlZmluaXRpb25GYW1pbHknLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YXNrRGVmaW5pdGlvbi5mYW1pbHksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gRmFtaWx5JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXNrRGVmaW5pdGlvbkZhbWlseWAsXG4gICAgfSk7XG5cbiAgICAvLyBUYXJnZXQgR3JvdXAgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXJnZXRHcm91cEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhcmdldEdyb3VwLnRhcmdldEdyb3VwQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXJnZXRHcm91cEFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFyZ2V0R3JvdXBOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFyZ2V0R3JvdXAudGFyZ2V0R3JvdXBOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFyZ2V0R3JvdXBOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIFNlY3JldHMgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZWNyZXRzQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFNlY3JldHMgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZWNyZXRzQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIEF1dG8gU2NhbGluZyBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0F1dG9TY2FsaW5nVGFyZ2V0SWQnLCB7XG4gICAgICB2YWx1ZTogYHNlcnZpY2UvJHt0aGlzLnNlcnZpY2UuY2x1c3Rlci5jbHVzdGVyTmFtZX0vJHt0aGlzLnNlcnZpY2Uuc2VydmljZU5hbWV9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXV0byBTY2FsaW5nIFRhcmdldCBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQXV0b1NjYWxpbmdUYXJnZXRJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmF0aW9uIG91dHB1dHMgZm9yIHJlZmVyZW5jZVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEZXNpcmVkQ291bnQnLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLmRlc2lyZWRDb3VudCB8fCAxKS50b1N0cmluZygpLFxuICAgICAgZGVzY3JpcHRpb246ICdDdXJyZW50IERlc2lyZWQgQ291bnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tDcHUnLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLmNwdSB8fCAyNTYpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ1Rhc2sgQ1BVIFVuaXRzJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXNrTWVtb3J5Jywge1xuICAgICAgdmFsdWU6IChwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ1Rhc2sgTWVtb3J5IChNaUIpJyxcbiAgICB9KTtcbiAgfVxufSJdfQ==