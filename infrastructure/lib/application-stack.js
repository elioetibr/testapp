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
            enableExecuteCommand: props.environment !== 'production', // Enable ECS Exec for dev/staging
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbGljYXRpb24tc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHBsaWNhdGlvbi1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLDJDQUEyQztBQUMzQyxpRkFBaUY7QUFDakYsaUVBQWlFO0FBSWpFLHFEQUFpRDtBQTRDakQsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQVM3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDRCQUE0QjtRQUM1QixJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksOEJBQWEsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7UUFFMUQsOENBQThDO1FBQzlDLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLDBCQUEwQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRXpELHlCQUF5QjtRQUN6QixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDekQsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ2xCLGlCQUFpQixFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFO1lBQ2xDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7U0FDekMsQ0FBQyxDQUFDO1FBRUgsb0NBQW9DO1FBQ3BDLE1BQU0sd0JBQXdCLEdBQUcsR0FBRyxDQUFDLGFBQWEsQ0FBQyxtQkFBbUIsQ0FDcEUsSUFBSSxFQUFFLGtDQUFrQyxFQUN4QyxLQUFLLENBQUMsMEJBQTBCLENBQ2pDLENBQUM7UUFFRixxQkFBcUI7UUFDckIsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLE9B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Q0FBQyxDQUFDO1FBRUgsc0NBQXNDO1FBQ3RDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ3RDLEtBQUssRUFBRSxDQUFDLEtBQUssQ0FBQyxZQUFZLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxFQUFFO1lBQzNDLFdBQVcsRUFBRSx1QkFBdUI7U0FDckMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDakMsS0FBSyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxRQUFRLEVBQUU7WUFDcEMsV0FBVyxFQUFFLGdCQUFnQjtTQUM5QixDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsQ0FBQyxLQUFLLENBQUMsY0FBYyxJQUFJLEdBQUcsQ0FBQyxDQUFDLFFBQVEsRUFBRTtZQUMvQyxXQUFXLEVBQUUsbUJBQW1CO1NBQ2pDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWpmRCw0Q0FpZkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwcGxpY2F0aW9uYXV0b3NjYWxpbmcnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBTZWNyZXRzTG9hZGVyIH0gZnJvbSAnLi9zZWNyZXRzLWxvYWRlcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwbGljYXRpb25TdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICAvLyBWUEMgY29uZmlndXJhdGlvblxuICB2cGNJZDogc3RyaW5nO1xuICBwcml2YXRlU3VibmV0SWRzOiBzdHJpbmdbXTtcbiAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6IHN0cmluZztcbiAgLy8gRUNTIFBsYXRmb3JtIGNvbmZpZ3VyYXRpb25cbiAgY2x1c3RlckFybjogc3RyaW5nO1xuICBjbHVzdGVyTmFtZTogc3RyaW5nO1xuICByZXBvc2l0b3J5VXJpOiBzdHJpbmc7XG4gIGxvYWRCYWxhbmNlckFybjogc3RyaW5nO1xuICBodHRwTGlzdGVuZXJBcm46IHN0cmluZztcbiAgaHR0cHNMaXN0ZW5lckFybj86IHN0cmluZztcbiAgbG9nR3JvdXBOYW1lOiBzdHJpbmc7XG4gIGxvZ0dyb3VwQXJuOiBzdHJpbmc7XG4gIC8vIEFwcGxpY2F0aW9uIGNvbmZpZ3VyYXRpb25cbiAgc2VydmljZU5hbWU/OiBzdHJpbmc7XG4gIHRhc2tJbWFnZVRhZz86IHN0cmluZztcbiAgZGVzaXJlZENvdW50PzogbnVtYmVyO1xuICBjcHU/OiBudW1iZXI7XG4gIG1lbW9yeUxpbWl0TWlCPzogbnVtYmVyO1xuICBjb250YWluZXJQb3J0PzogbnVtYmVyO1xuICAvLyBBdXRvIHNjYWxpbmcgY29uZmlndXJhdGlvblxuICBtaW5DYXBhY2l0eT86IG51bWJlcjtcbiAgbWF4Q2FwYWNpdHk/OiBudW1iZXI7XG4gIGNwdVRhcmdldFV0aWxpemF0aW9uPzogbnVtYmVyO1xuICBtZW1vcnlUYXJnZXRVdGlsaXphdGlvbj86IG51bWJlcjtcbiAgc2NhbGVJbkNvb2xkb3duTWludXRlcz86IG51bWJlcjtcbiAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM/OiBudW1iZXI7XG4gIC8vIEhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uXG4gIGhlYWx0aENoZWNrUGF0aD86IHN0cmluZztcbiAgaGVhbHRoQ2hlY2tJbnRlcnZhbD86IG51bWJlcjtcbiAgaGVhbHRoQ2hlY2tUaW1lb3V0PzogbnVtYmVyO1xuICBoZWFsdGh5VGhyZXNob2xkQ291bnQ/OiBudW1iZXI7XG4gIHVuaGVhbHRoeVRocmVzaG9sZENvdW50PzogbnVtYmVyO1xuICAvLyBDb250YWluZXIgc2VjdXJpdHlcbiAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcj86IGJvb2xlYW47XG4gIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0/OiBib29sZWFuO1xuICAvLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgZW52aXJvbm1lbnRWYXJpYWJsZXM/OiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9O1xufVxuXG5leHBvcnQgY2xhc3MgQXBwbGljYXRpb25TdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBzZXJ2aWNlOiBlY3MuRmFyZ2F0ZVNlcnZpY2U7XG4gIHB1YmxpYyByZWFkb25seSB0YXNrRGVmaW5pdGlvbjogZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGNvbnRhaW5lcjogZWNzLkNvbnRhaW5lckRlZmluaXRpb247XG4gIHB1YmxpYyByZWFkb25seSB0YXJnZXRHcm91cDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgc2NhbGFibGVUYXJnZXQ6IGVjcy5TY2FsYWJsZVRhc2tDb3VudDtcbiAgcHVibGljIHJlYWRvbmx5IGFwcFNlY3JldHM6IHNlY3JldHNtYW5hZ2VyLlNlY3JldDtcbiAgcHJpdmF0ZSByZWFkb25seSBzZWNyZXRzTG9hZGVyOiBTZWNyZXRzTG9hZGVyO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEluaXRpYWxpemUgc2VjcmV0cyBsb2FkZXJcbiAgICB0aGlzLnNlY3JldHNMb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcihwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIEFXUyBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0IGZyb20gU09QU1xuICAgIHRoaXMuYXBwU2VjcmV0cyA9IHRoaXMuY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHMpO1xuXG4gICAgLy8gSW1wb3J0IFZQQyBhbmQgc3VibmV0c1xuICAgIGNvbnN0IHZwYyA9IGVjMi5WcGMuZnJvbVZwY0F0dHJpYnV0ZXModGhpcywgJ0ltcG9ydGVkVnBjJywge1xuICAgICAgdnBjSWQ6IHByb3BzLnZwY0lkLFxuICAgICAgYXZhaWxhYmlsaXR5Wm9uZXM6IGNkay5Gbi5nZXRBenMoKSxcbiAgICAgIHByaXZhdGVTdWJuZXRJZHM6IHByb3BzLnByaXZhdGVTdWJuZXRJZHMsXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgYXBwbGljYXRpb24gc2VjdXJpdHkgZ3JvdXBcbiAgICBjb25zdCBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXAgPSBlYzIuU2VjdXJpdHlHcm91cC5mcm9tU2VjdXJpdHlHcm91cElkKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkQXBwbGljYXRpb25TZWN1cml0eUdyb3VwJyxcbiAgICAgIHByb3BzLmFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkXG4gICAgKTtcblxuICAgIC8vIEltcG9ydCBFQ1MgY2x1c3RlclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBlY3MuQ2x1c3Rlci5mcm9tQ2x1c3RlckF0dHJpYnV0ZXModGhpcywgJ0ltcG9ydGVkQ2x1c3RlcicsIHtcbiAgICAgIGNsdXN0ZXJOYW1lOiBwcm9wcy5jbHVzdGVyTmFtZSxcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbYXBwbGljYXRpb25TZWN1cml0eUdyb3VwXSxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBFQ1IgcmVwb3NpdG9yeVxuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRSZXBvc2l0b3J5JywgXG4gICAgICBwcm9wcy5yZXBvc2l0b3J5VXJpLnNwbGl0KCcvJykucG9wKCkhLnNwbGl0KCc6JylbMF1cbiAgICApO1xuXG4gICAgLy8gSW1wb3J0IGxvZyBncm91cFxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbG9ncy5Mb2dHcm91cC5mcm9tTG9nR3JvdXBOYW1lKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9nR3JvdXAnLFxuICAgICAgcHJvcHMubG9nR3JvdXBOYW1lXG4gICAgKTtcblxuICAgIC8vIEltcG9ydCBsb2FkIGJhbGFuY2VyIGFuZCBsaXN0ZW5lcnMgdXNpbmcgQVJOc1xuICAgIGNvbnN0IGxvYWRCYWxhbmNlciA9IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIuZnJvbUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyQXR0cmlidXRlcyhcbiAgICAgIHRoaXMsICdJbXBvcnRlZExvYWRCYWxhbmNlcicsXG4gICAgICB7IFxuICAgICAgICBsb2FkQmFsYW5jZXJBcm46IHByb3BzLmxvYWRCYWxhbmNlckFybixcbiAgICAgICAgc2VjdXJpdHlHcm91cElkOiBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXAuc2VjdXJpdHlHcm91cElkXG4gICAgICB9XG4gICAgKTtcblxuICAgIGNvbnN0IGh0dHBMaXN0ZW5lciA9IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lci5mcm9tQXBwbGljYXRpb25MaXN0ZW5lckF0dHJpYnV0ZXMoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRIdHRwTGlzdGVuZXInLFxuICAgICAgeyBcbiAgICAgICAgbGlzdGVuZXJBcm46IHByb3BzLmh0dHBMaXN0ZW5lckFybixcbiAgICAgICAgc2VjdXJpdHlHcm91cDogYXBwbGljYXRpb25TZWN1cml0eUdyb3VwXG4gICAgICB9XG4gICAgKTtcblxuICAgIGxldCBodHRwc0xpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyIHwgdW5kZWZpbmVkO1xuICAgIGlmIChwcm9wcy5odHRwc0xpc3RlbmVyQXJuKSB7XG4gICAgICBodHRwc0xpc3RlbmVyID0gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyLmZyb21BcHBsaWNhdGlvbkxpc3RlbmVyQXR0cmlidXRlcyhcbiAgICAgICAgdGhpcywgJ0ltcG9ydGVkSHR0cHNMaXN0ZW5lcicsXG4gICAgICAgIHsgXG4gICAgICAgICAgbGlzdGVuZXJBcm46IHByb3BzLmh0dHBzTGlzdGVuZXJBcm4sXG4gICAgICAgICAgc2VjdXJpdHlHcm91cDogYXBwbGljYXRpb25TZWN1cml0eUdyb3VwXG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIElBTSByb2xlc1xuICAgIGNvbnN0IHsgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUgfSA9IHRoaXMuY3JlYXRlSWFtUm9sZXMocHJvcHMsIGxvZ0dyb3VwKTtcblxuICAgIC8vIENyZWF0ZSB0YXNrIGRlZmluaXRpb25cbiAgICB0aGlzLnRhc2tEZWZpbml0aW9uID0gdGhpcy5jcmVhdGVUYXNrRGVmaW5pdGlvbihwcm9wcywgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUpO1xuXG4gICAgLy8gQ3JlYXRlIGNvbnRhaW5lciBkZWZpbml0aW9uXG4gICAgdGhpcy5jb250YWluZXIgPSB0aGlzLmNyZWF0ZUNvbnRhaW5lckRlZmluaXRpb24ocHJvcHMsIHJlcG9zaXRvcnksIGxvZ0dyb3VwKTtcblxuICAgIC8vIENyZWF0ZSB0YXJnZXQgZ3JvdXBcbiAgICB0aGlzLnRhcmdldEdyb3VwID0gdGhpcy5jcmVhdGVUYXJnZXRHcm91cChwcm9wcywgdnBjLCBsb2FkQmFsYW5jZXIpO1xuXG4gICAgLy8gQ3JlYXRlIEZhcmdhdGUgc2VydmljZVxuICAgIHRoaXMuc2VydmljZSA9IHRoaXMuY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHMsIGNsdXN0ZXIsIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cCk7XG5cbiAgICAvLyBDb25maWd1cmUgaGVhbHRoIGNoZWNrc1xuICAgIHRoaXMuY29uZmlndXJlSGVhbHRoQ2hlY2socHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIGF1dG8gc2NhbGluZ1xuICAgIHRoaXMuc2NhbGFibGVUYXJnZXQgPSB0aGlzLmNyZWF0ZUF1dG9TY2FsaW5nKHByb3BzKTtcblxuICAgIC8vIEFkZCBsaXN0ZW5lciBydWxlc1xuICAgIHRoaXMuYWRkTGlzdGVuZXJSdWxlcyhodHRwTGlzdGVuZXIsIGh0dHBzTGlzdGVuZXIpO1xuXG4gICAgLy8gQ3JlYXRlIHN0YWNrIG91dHB1dHNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMocHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogc2VjcmV0c21hbmFnZXIuU2VjcmV0IHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IHRoaXMuc2VjcmV0c0xvYWRlci5sb2FkU2VjcmV0c1dpdGhGYWxsYmFjaygpO1xuICAgICAgXG4gICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hcHAtc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudGAsXG4gICAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHNlY3JldHMpLFxuICAgICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAnZ2VuZXJhdGVkX2F0JyxcbiAgICAgICAgICBpbmNsdWRlU3BhY2U6IGZhbHNlLFxuICAgICAgICAgIGV4Y2x1ZGVDaGFyYWN0ZXJzOiAnXCJAL1xcXFwnXG4gICAgICAgIH0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLLVNPUFMnKTtcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdDb21wb25lbnQnLCAnQXBwbGljYXRpb24tU2VjcmV0cycpO1xuICAgICAgXG4gICAgICByZXR1cm4gc2VjcmV0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBsb2FkIFNPUFMgc2VjcmV0cywgY3JlYXRpbmcgZW1wdHkgc2VjcmV0OiAke2Vycm9yfWApO1xuICAgICAgXG4gICAgICByZXR1cm4gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tYXBwLXNlY3JldHNgLFxuICAgICAgICBkZXNjcmlwdGlvbjogYEFwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnQgKGVtcHR5IC0gcG9wdWxhdGUgbWFudWFsbHkpYCxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUlhbVJvbGVzKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsIGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cCkge1xuICAgIC8vIFRhc2sgZXhlY3V0aW9uIHJvbGVcbiAgICBjb25zdCBleGVjdXRpb25Sb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUYXNrRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgcm9sZU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWV4ZWN1dGlvbi1yb2xlYCxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeScpLFxuICAgICAgXSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIEVDUkFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTZWNyZXRzTWFuYWdlckFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3RoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gVGFzayByb2xlXG4gICAgY29uc3QgdGFza1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICByb2xlTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tdGFzay1yb2xlYCxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIENsb3VkV2F0Y2hMb2dzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm4gKyAnKiddLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICAgIFNlY3JldHNNYW5hZ2VyQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGV4ZWN1dGlvblJvbGUpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoZXhlY3V0aW9uUm9sZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLUV4ZWN1dGlvbi1Sb2xlJyk7XG4gICAgY2RrLlRhZ3Mub2YodGFza1JvbGUpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodGFza1JvbGUpLmFkZCgnQ29tcG9uZW50JywgJ0VDUy1UYXNrLVJvbGUnKTtcblxuICAgIHJldHVybiB7IGV4ZWN1dGlvblJvbGUsIHRhc2tSb2xlIH07XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVRhc2tEZWZpbml0aW9uKFxuICAgIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsXG4gICAgZXhlY3V0aW9uUm9sZTogaWFtLlJvbGUsXG4gICAgdGFza1JvbGU6IGlhbS5Sb2xlXG4gICk6IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24ge1xuICAgIGNvbnN0IHRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ1Rhc2tEZWZpbml0aW9uJywge1xuICAgICAgZmFtaWx5OiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBjcHU6IHByb3BzLmNwdSB8fCAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogcHJvcHMubWVtb3J5TGltaXRNaUIgfHwgNTEyLFxuICAgICAgZXhlY3V0aW9uUm9sZSxcbiAgICAgIHRhc2tSb2xlLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRtcGZzIHZvbHVtZXMgaWYgcmVhZC1vbmx5IHJvb3QgZmlsZXN5c3RlbSBpcyBlbmFibGVkXG4gICAgaWYgKHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICd0bXAtdm9sdW1lJyxcbiAgICAgICAgaG9zdDoge30sXG4gICAgICB9KTtcblxuICAgICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgaG9zdDoge30sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHRhc2tEZWZpbml0aW9uKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHRhc2tEZWZpbml0aW9uKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtVGFzay1EZWZpbml0aW9uJyk7XG5cbiAgICByZXR1cm4gdGFza0RlZmluaXRpb247XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbnRhaW5lckRlZmluaXRpb24oXG4gICAgcHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcyxcbiAgICByZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnksXG4gICAgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwXG4gICk6IGVjcy5Db250YWluZXJEZWZpbml0aW9uIHtcbiAgICAvLyBQcmVwYXJlIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgIGNvbnN0IGVudmlyb25tZW50ID0ge1xuICAgICAgUkVRVUlSRURfU0VUVElORzogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICBBV1NfREVGQVVMVF9SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgLi4ucHJvcHMuZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgfTtcblxuICAgIC8vIENyZWF0ZSBjb250YWluZXJcbiAgICBjb25zdCBjb250YWluZXIgPSB0aGlzLnRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcigndGVzdGFwcC1jb250YWluZXInLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHJlcG9zaXRvcnksIHByb3BzLnRhc2tJbWFnZVRhZyB8fCAnbGF0ZXN0JyksXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAndGVzdGFwcCcsXG4gICAgICAgIGxvZ0dyb3VwLFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudCxcbiAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgU0VDUkVUX0tFWTogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIodGhpcy5hcHBTZWNyZXRzLCAnYXBwbGljYXRpb24uc2VjcmV0X2tleScpLFxuICAgICAgfSxcbiAgICAgIC8vIENvbnRhaW5lciBzZWN1cml0eSBzZXR0aW5nc1xuICAgICAgdXNlcjogcHJvcHMuZW5hYmxlTm9uUm9vdENvbnRhaW5lciA/ICcxMDAxOjEwMDEnIDogdW5kZWZpbmVkLFxuICAgICAgcmVhZG9ubHlSb290RmlsZXN5c3RlbTogcHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSB8fCBmYWxzZSxcbiAgICAgIC8vIFJlc291cmNlIGxpbWl0cyBmb3Igc2VjdXJpdHkgYW5kIHBlcmZvcm1hbmNlXG4gICAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogTWF0aC5mbG9vcigocHJvcHMubWVtb3J5TGltaXRNaUIgfHwgNTEyKSAqIDAuOCksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcG9ydCBtYXBwaW5nXG4gICAgY29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7XG4gICAgICBjb250YWluZXJQb3J0OiBwcm9wcy5jb250YWluZXJQb3J0IHx8IDgwMDAsXG4gICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICAgIG5hbWU6ICdodHRwJyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBtb3VudCBwb2ludHMgZm9yIHRtcGZzIHZvbHVtZXMgaWYgcmVhZC1vbmx5IGZpbGVzeXN0ZW0gaXMgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtKSB7XG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBzb3VyY2VWb2x1bWU6ICd0bXAtdm9sdW1lJyxcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy90bXAnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcblxuICAgICAgY29udGFpbmVyLmFkZE1vdW50UG9pbnRzKHtcbiAgICAgICAgc291cmNlVm9sdW1lOiAnbG9ncy12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL2FwcC9sb2dzJyxcbiAgICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbnRhaW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVGFyZ2V0R3JvdXAocHJvcHM6IEFwcGxpY2F0aW9uU3RhY2tQcm9wcywgdnBjOiBlYzIuSVZwYywgbG9hZEJhbGFuY2VyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcik6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25UYXJnZXRHcm91cCB7XG4gICAgY29uc3QgdGFyZ2V0R3JvdXAgPSBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblRhcmdldEdyb3VwKHRoaXMsICdUYXJnZXRHcm91cCcsIHtcbiAgICAgIHRhcmdldEdyb3VwTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tdGdgLFxuICAgICAgcG9ydDogcHJvcHMuY29udGFpbmVyUG9ydCB8fCA4MDAwLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgdnBjLFxuICAgICAgdGFyZ2V0VHlwZTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5UYXJnZXRUeXBlLklQLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgcGF0aDogcHJvcHMuaGVhbHRoQ2hlY2tQYXRoIHx8ICcvaGVhbHRoLycsXG4gICAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlByb3RvY29sLkhUVFAsXG4gICAgICAgIHBvcnQ6ICd0cmFmZmljLXBvcnQnLFxuICAgICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKHByb3BzLmhlYWx0aENoZWNrSW50ZXJ2YWwgfHwgMzApLFxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyhwcm9wcy5oZWFsdGhDaGVja1RpbWVvdXQgfHwgNSksXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogcHJvcHMuaGVhbHRoeVRocmVzaG9sZENvdW50IHx8IDIsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiBwcm9wcy51bmhlYWx0aHlUaHJlc2hvbGRDb3VudCB8fCAzLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YodGFyZ2V0R3JvdXApLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YodGFyZ2V0R3JvdXApLmFkZCgnQ29tcG9uZW50JywgJ0FwcGxpY2F0aW9uLVRhcmdldEdyb3VwJyk7XG5cbiAgICByZXR1cm4gdGFyZ2V0R3JvdXA7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUZhcmdhdGVTZXJ2aWNlKFxuICAgIHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMsXG4gICAgY2x1c3RlcjogZWNzLklDbHVzdGVyLFxuICAgIHNlY3VyaXR5R3JvdXA6IGVjMi5JU2VjdXJpdHlHcm91cFxuICApOiBlY3MuRmFyZ2F0ZVNlcnZpY2Uge1xuICAgIGNvbnN0IHNlcnZpY2VOYW1lID0gcHJvcHMuc2VydmljZU5hbWUgfHwgYHRlc3RhcHAtc2VydmljZS0ke3Byb3BzLmVudmlyb25tZW50fWA7XG5cbiAgICBjb25zdCBzZXJ2aWNlID0gbmV3IGVjcy5GYXJnYXRlU2VydmljZSh0aGlzLCAnRmFyZ2F0ZVNlcnZpY2UnLCB7XG4gICAgICBjbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb246IHRoaXMudGFza0RlZmluaXRpb24sXG4gICAgICBzZXJ2aWNlTmFtZSxcbiAgICAgIGRlc2lyZWRDb3VudDogcHJvcHMuZGVzaXJlZENvdW50IHx8IDEsXG4gICAgICBzZWN1cml0eUdyb3VwczogW3NlY3VyaXR5R3JvdXBdLFxuICAgICAgYXNzaWduUHVibGljSXA6IGZhbHNlLCAvLyBSdW5uaW5nIGluIHByaXZhdGUgc3VibmV0c1xuICAgICAgZW5hYmxlRXhlY3V0ZUNvbW1hbmQ6IHByb3BzLmVudmlyb25tZW50ICE9PSAncHJvZHVjdGlvbicsIC8vIEVuYWJsZSBFQ1MgRXhlYyBmb3IgZGV2L3N0YWdpbmdcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZ3VyZSBzZXJ2aWNlIGxvYWQgYmFsYW5jZXJzXG4gICAgc2VydmljZS5hdHRhY2hUb0FwcGxpY2F0aW9uVGFyZ2V0R3JvdXAodGhpcy50YXJnZXRHcm91cCk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHNlcnZpY2UpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yoc2VydmljZSkuYWRkKCdDb21wb25lbnQnLCAnRUNTLVNlcnZpY2UnKTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVIZWFsdGhDaGVjayhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gSGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb24gaXMgYWxyZWFkeSBzZXQgaW4gdGFyZ2V0IGdyb3VwIGNyZWF0aW9uXG4gICAgLy8gVGhpcyBtZXRob2QgY2FuIGJlIGV4dGVuZGVkIGZvciBhZGRpdGlvbmFsIGhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uc1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVBdXRvU2NhbGluZyhwcm9wczogQXBwbGljYXRpb25TdGFja1Byb3BzKTogZWNzLlNjYWxhYmxlVGFza0NvdW50IHtcbiAgICBjb25zdCBtaW5DYXBhY2l0eSA9IHByb3BzLm1pbkNhcGFjaXR5IHx8IHByb3BzLmRlc2lyZWRDb3VudCB8fCAxO1xuICAgIGNvbnN0IG1heENhcGFjaXR5ID0gcHJvcHMubWF4Q2FwYWNpdHkgfHwgKHByb3BzLmRlc2lyZWRDb3VudCB8fCAxKSAqIDM7XG5cbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IHRoaXMuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHksXG4gICAgICBtYXhDYXBhY2l0eSxcbiAgICB9KTtcblxuICAgIC8vIENQVS1iYXNlZCBhdXRvIHNjYWxpbmdcbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uQ3B1VXRpbGl6YXRpb24oJ0NwdVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IHByb3BzLmNwdVRhcmdldFV0aWxpemF0aW9uIHx8IDcwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyhwcm9wcy5zY2FsZUluQ29vbGRvd25NaW51dGVzIHx8IDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVPdXRDb29sZG93bk1pbnV0ZXMgfHwgMiksXG4gICAgfSk7XG5cbiAgICAvLyBNZW1vcnktYmFzZWQgYXV0byBzY2FsaW5nXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbk1lbW9yeVV0aWxpemF0aW9uKCdNZW1vcnlTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiBwcm9wcy5tZW1vcnlUYXJnZXRVdGlsaXphdGlvbiB8fCA4MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMocHJvcHMuc2NhbGVJbkNvb2xkb3duTWludXRlcyB8fCA1KSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKHByb3BzLnNjYWxlT3V0Q29vbGRvd25NaW51dGVzIHx8IDIpLFxuICAgIH0pO1xuXG4gICAgLy8gTm90ZTogUmVxdWVzdC1iYXNlZCBhdXRvIHNjYWxpbmcgdXNpbmcgc2NhbGVPblJlcXVlc3RDb3VudCByZXF1aXJlcyB0aGUgdGFyZ2V0IGdyb3VwIFxuICAgIC8vIHRvIGJlIGF0dGFjaGVkIHRvIGEgbG9hZCBiYWxhbmNlciBmaXJzdC4gU2luY2Ugd2UncmUgY3JlYXRpbmcgbGlzdGVuZXIgcnVsZXMgYWZ0ZXIgXG4gICAgLy8gdGhlIGF1dG8gc2NhbGluZyBzZXR1cCwgd2UnbGwgc2tpcCByZXF1ZXN0LWJhc2VkIHNjYWxpbmcgZm9yIG5vdy5cbiAgICAvLyBUaGlzIGNhbiBiZSBhZGRlZCBhcyBhIHNlcGFyYXRlIGNvbnN0cnVjdCBhZnRlciB0aGUgbGlzdGVuZXIgcnVsZXMgYXJlIGNyZWF0ZWQuXG5cbiAgICByZXR1cm4gc2NhbGFibGVUYXJnZXQ7XG4gIH1cblxuICBwcml2YXRlIGFkZExpc3RlbmVyUnVsZXMoXG4gICAgaHR0cExpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyLFxuICAgIGh0dHBzTGlzdGVuZXI/OiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLklBcHBsaWNhdGlvbkxpc3RlbmVyXG4gICk6IHZvaWQge1xuICAgIC8vIEFkZCBydWxlIHRvIEhUVFAgbGlzdGVuZXJcbiAgICBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyUnVsZSh0aGlzLCAnSHR0cExpc3RlbmVyUnVsZScsIHtcbiAgICAgIGxpc3RlbmVyOiBodHRwTGlzdGVuZXIsXG4gICAgICBwcmlvcml0eTogMTAwLFxuICAgICAgY29uZGl0aW9uczogW1xuICAgICAgICBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQ29uZGl0aW9uLnBhdGhQYXR0ZXJucyhbJyonXSksXG4gICAgICBdLFxuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZvcndhcmQoW3RoaXMudGFyZ2V0R3JvdXBdKSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBydWxlIHRvIEhUVFBTIGxpc3RlbmVyIGlmIGl0IGV4aXN0c1xuICAgIGlmIChodHRwc0xpc3RlbmVyKSB7XG4gICAgICBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyUnVsZSh0aGlzLCAnSHR0cHNMaXN0ZW5lclJ1bGUnLCB7XG4gICAgICAgIGxpc3RlbmVyOiBodHRwc0xpc3RlbmVyLFxuICAgICAgICBwcmlvcml0eTogMTAwLFxuICAgICAgICBjb25kaXRpb25zOiBbXG4gICAgICAgICAgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckNvbmRpdGlvbi5wYXRoUGF0dGVybnMoWycqJ10pLFxuICAgICAgICBdLFxuICAgICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZm9yd2FyZChbdGhpcy50YXJnZXRHcm91cF0pLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKHByb3BzOiBBcHBsaWNhdGlvblN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBTZXJ2aWNlIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VydmljZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNlcnZpY2Uuc2VydmljZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZXJ2aWNlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlcnZpY2VOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIFRhc2sgRGVmaW5pdGlvbiBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tEZWZpbml0aW9uQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFza0RlZmluaXRpb24udGFza0RlZmluaXRpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXNrRGVmaW5pdGlvbkFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFza0RlZmluaXRpb25GYW1pbHknLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YXNrRGVmaW5pdGlvbi5mYW1pbHksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIERlZmluaXRpb24gRmFtaWx5JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXNrRGVmaW5pdGlvbkZhbWlseWAsXG4gICAgfSk7XG5cbiAgICAvLyBUYXJnZXQgR3JvdXAgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXJnZXRHcm91cEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhcmdldEdyb3VwLnRhcmdldEdyb3VwQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYXJnZXRHcm91cEFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVGFyZ2V0R3JvdXBOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFyZ2V0R3JvdXAudGFyZ2V0R3JvdXBOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBUYXJnZXQgR3JvdXAgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFyZ2V0R3JvdXBOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIFNlY3JldHMgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZWNyZXRzQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFNlY3JldHMgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZWNyZXRzQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIEF1dG8gU2NhbGluZyBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0F1dG9TY2FsaW5nVGFyZ2V0SWQnLCB7XG4gICAgICB2YWx1ZTogYHNlcnZpY2UvJHt0aGlzLnNlcnZpY2UuY2x1c3Rlci5jbHVzdGVyTmFtZX0vJHt0aGlzLnNlcnZpY2Uuc2VydmljZU5hbWV9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXV0byBTY2FsaW5nIFRhcmdldCBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQXV0b1NjYWxpbmdUYXJnZXRJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmF0aW9uIG91dHB1dHMgZm9yIHJlZmVyZW5jZVxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEZXNpcmVkQ291bnQnLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLmRlc2lyZWRDb3VudCB8fCAxKS50b1N0cmluZygpLFxuICAgICAgZGVzY3JpcHRpb246ICdDdXJyZW50IERlc2lyZWQgQ291bnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Rhc2tDcHUnLCB7XG4gICAgICB2YWx1ZTogKHByb3BzLmNwdSB8fCAyNTYpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ1Rhc2sgQ1BVIFVuaXRzJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYXNrTWVtb3J5Jywge1xuICAgICAgdmFsdWU6IChwcm9wcy5tZW1vcnlMaW1pdE1pQiB8fCA1MTIpLnRvU3RyaW5nKCksXG4gICAgICBkZXNjcmlwdGlvbjogJ1Rhc2sgTWVtb3J5IChNaUIpJyxcbiAgICB9KTtcbiAgfVxufSJdfQ==