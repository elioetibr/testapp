"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestAppInfrastructureStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecs_patterns = require("aws-cdk-lib/aws-ecs-patterns");
const ecr = require("aws-cdk-lib/aws-ecr");
const logs = require("aws-cdk-lib/aws-logs");
const iam = require("aws-cdk-lib/aws-iam");
const elasticloadbalancingv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const secrets_loader_1 = require("./secrets-loader");
class TestAppInfrastructureStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Initialize secrets loader
        this.secretsLoader = new secrets_loader_1.SecretsLoader(props.environment);
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
    createSecretsManagerSecret(props) {
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
        }
        catch (error) {
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
    createVpc(props) {
        const subnetConfiguration = [
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
        const vpcProps = {
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
                    : { amazonProvidedIpv6CidrBlock: true }),
            });
            // Configure IPv6 for public subnets
            vpc.publicSubnets.forEach((subnet, index) => {
                const cfnSubnet = subnet.node.defaultChild;
                cfnSubnet.ipv6CidrBlock = cdk.Fn.select(index, cdk.Fn.cidr(cdk.Fn.select(0, vpc.vpcIpv6CidrBlocks), 256, '64'));
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
    createEcrRepository(props) {
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
    createEcsCluster(props) {
        const cluster = new ecs.Cluster(this, 'TestAppCluster', {
            vpc: this.vpc,
            clusterName: `testapp-cluster-${props.environment}`,
            // Note: containerInsights is deprecated but still functional
            // In newer CDK versions, use containerInsights: ecs.ContainerInsights.ENHANCED
        });
        return cluster;
    }
    createFargateService(props) {
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
            domainZone: undefined,
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
            sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8000), 'Allow HTTP traffic from ALB');
            if (props.enableIPv6) {
                sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8000), 'Allow HTTP traffic from ALB (IPv6)');
            }
        });
        return fargateService;
    }
    createOutputs() {
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
exports.TestAppInfrastructureStack = TestAppInfrastructureStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkRBQTZEO0FBQzdELDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsMkNBQTJDO0FBQzNDLGlGQUFpRjtBQUNqRixpRUFBaUU7QUFFakUscURBQWlEO0FBbUJqRCxNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBUXZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0M7UUFDOUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNEJBQTRCO1FBQzVCLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUxRCw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFekQsNERBQTREO1FBQzVELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVqQyx3QkFBd0I7UUFDeEIsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFbEQscUJBQXFCO1FBQ3JCLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRTVDLHdEQUF3RDtRQUN4RCxJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUV2RCw2QkFBNkI7UUFDN0IsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFD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SSxDQUFDLGNBQWMsQ0FBQyxZQUFZLENBQUMsbUJBQW1CO1lBQzNELFdBQVcsRUFBRSxvQ0FBb0M7WUFDakQsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsa0JBQWtCO1NBQ2hELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQzlDLFdBQVcsRUFBRSxrQkFBa0I7WUFDL0IsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsY0FBYztTQUM1QyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxVQUFVLElBQUksQ0FBQyxjQUFjLENBQUMsWUFBWSxDQUFDLG1CQUFtQixFQUFFO1lBQ3ZFLFdBQVcsRUFBRSxpQkFBaUI7U0FDL0IsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBdFdELGdFQXNXQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3NfcGF0dGVybnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcy1wYXR0ZXJucyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU2VjcmV0c0xvYWRlciB9IGZyb20gJy4vc2VjcmV0cy1sb2FkZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGVudmlyb25tZW50OiBzdHJpbmc7XG4gIGVuYWJsZUlQdjY6IGJvb2xlYW47XG4gIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGJvb2xlYW47XG4gIG1heEF6czogbnVtYmVyO1xuICBuYXRHYXRld2F5czogbnVtYmVyO1xuICBkZXNpcmVkQ291bnQ6IG51bWJlcjtcbiAgY3B1OiBudW1iZXI7XG4gIG1lbW9yeUxpbWl0TWlCOiBudW1iZXI7XG4gIC8vIE5ldHdvcmsgY29uZmlndXJhdGlvblxuICB2cGNDaWRyPzogc3RyaW5nO1xuICBwdWJsaWNTdWJuZXRDaWRyTWFzaz86IG51bWJlcjtcbiAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrPzogbnVtYmVyO1xuICAvLyBJUHY2IGNvbmZpZ3VyYXRpb25cbiAgaXB2NkNpZHJCbG9jaz86IHN0cmluZzsgLy8gSWYgbm90IHByb3ZpZGVkLCBBV1Mgd2lsbCBhc3NpZ24gb25lIGF1dG9tYXRpY2FsbHlcbn1cblxuZXhwb3J0IGNsYXNzIFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHZwYzogZWMyLlZwYztcbiAgcHVibGljIHJlYWRvbmx5IGNsdXN0ZXI6IGVjcy5DbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnk7XG4gIHB1YmxpYyByZWFkb25seSBmYXJnYXRlU2VydmljZTogZWNzX3BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2U7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjcmV0c0xvYWRlcjogU2VjcmV0c0xvYWRlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBhcHBTZWNyZXRzOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEluaXRpYWxpemUgc2VjcmV0cyBsb2FkZXJcbiAgICB0aGlzLnNlY3JldHNMb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcihwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIEFXUyBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0IGZyb20gU09QU1xuICAgIHRoaXMuYXBwU2VjcmV0cyA9IHRoaXMuY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFZQQyB3aXRoIGNvbmZpZ3VyYWJsZSBJUHY2IGFuZCBOQVQgR2F0ZXdheSBvcHRpb25zXG4gICAgdGhpcy52cGMgPSB0aGlzLmNyZWF0ZVZwYyhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgRUNSIFJlcG9zaXRvcnlcbiAgICB0aGlzLnJlcG9zaXRvcnkgPSB0aGlzLmNyZWF0ZUVjclJlcG9zaXRvcnkocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUyBDbHVzdGVyXG4gICAgdGhpcy5jbHVzdGVyID0gdGhpcy5jcmVhdGVFY3NDbHVzdGVyKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBGYXJnYXRlIFNlcnZpY2Ugd2l0aCBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyXG4gICAgdGhpcy5mYXJnYXRlU2VydmljZSA9IHRoaXMuY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHMpO1xuXG4gICAgLy8gT3V0cHV0IGltcG9ydGFudCByZXNvdXJjZXNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMoKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQge1xuICAgIHRyeSB7XG4gICAgICAvLyBMb2FkIHNlY3JldHMgZnJvbSBTT1BTXG4gICAgICBjb25zdCBzZWNyZXRzID0gdGhpcy5zZWNyZXRzTG9hZGVyLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0XG4gICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1zZWNyZXRzYCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoc2VjcmV0cyksXG4gICAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICdnZW5lcmF0ZWRfYXQnLFxuICAgICAgICAgIGluY2x1ZGVTcGFjZTogZmFsc2UsXG4gICAgICAgICAgZXhjbHVkZUNoYXJhY3RlcnM6ICdcIkAvXFxcXCdcbiAgICAgICAgfSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcblxuICAgICAgLy8gVGFnIHRoZSBzZWNyZXRcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLLVNPUFMnKTtcbiAgICAgIFxuICAgICAgcmV0dXJuIHNlY3JldDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS53YXJuKGBGYWlsZWQgdG8gbG9hZCBTT1BTIHNlY3JldHMsIGNyZWF0aW5nIGVtcHR5IHNlY3JldDogJHtlcnJvcn1gKTtcbiAgICAgIFxuICAgICAgLy8gRmFsbGJhY2s6IGNyZWF0ZSBlbXB0eSBzZWNyZXQgdGhhdCBjYW4gYmUgcG9wdWxhdGVkIGxhdGVyXG4gICAgICByZXR1cm4gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudCAoZW1wdHkgLSBwb3B1bGF0ZSBtYW51YWxseSlgLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVnBjKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWMyLlZwYyB7XG4gICAgY29uc3Qgc3VibmV0Q29uZmlndXJhdGlvbjogZWMyLlN1Ym5ldENvbmZpZ3VyYXRpb25bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ1B1YmxpYycsXG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgY2lkck1hc2s6IHByb3BzLnB1YmxpY1N1Ym5ldENpZHJNYXNrIHx8IDI0LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxuICAgICAgICBjaWRyTWFzazogcHJvcHMucHJpdmF0ZVN1Ym5ldENpZHJNYXNrIHx8IDI0LFxuICAgICAgfVxuICAgIF07XG5cbiAgICBjb25zdCB2cGNQcm9wczogZWMyLlZwY1Byb3BzID0ge1xuICAgICAgbWF4QXpzOiBwcm9wcy5tYXhBenMsXG4gICAgICBuYXRHYXRld2F5czogcHJvcHMuZW5hYmxlSEFOYXRHYXRld2F5cyA/IHByb3BzLm1heEF6cyA6IE1hdGgubWluKHByb3BzLm5hdEdhdGV3YXlzLCBwcm9wcy5tYXhBenMpLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbixcbiAgICAgIGVuYWJsZURuc0hvc3RuYW1lczogdHJ1ZSxcbiAgICAgIGVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgICAvLyBDdXN0b20gSVB2NCBDSURSIGJsb2NrICh1c2luZyBuZXcgaXBBZGRyZXNzZXMgQVBJKVxuICAgICAgaXBBZGRyZXNzZXM6IGVjMi5JcEFkZHJlc3Nlcy5jaWRyKHByb3BzLnZwY0NpZHIgfHwgJzEwLjAuMC4wLzE2JyksXG4gICAgfTtcblxuICAgIC8vIEFkZCBJUHY2IHN1cHBvcnQgaWYgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVJUHY2KSB7XG4gICAgICAvLyBJUHY2IGNvbmZpZ3VyYXRpb25cbiAgICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdUZXN0QXBwVnBjJywge1xuICAgICAgICAuLi52cGNQcm9wcyxcbiAgICAgICAgLy8gSVB2NiB3aWxsIGJlIGFkZGVkIHZpYSBzZXBhcmF0ZSBjb25maWd1cmF0aW9uXG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIElQdjYgQ0lEUiBibG9jayB0byBWUENcbiAgICAgIGNvbnN0IGlwdjZDaWRyQmxvY2sgPSBuZXcgZWMyLkNmblZQQ0NpZHJCbG9jayh0aGlzLCAnSXB2NkNpZHJCbG9jaycsIHtcbiAgICAgICAgdnBjSWQ6IHZwYy52cGNJZCxcbiAgICAgICAgLy8gVXNlIGN1c3RvbSBJUHY2IENJRFIgaWYgcHJvdmlkZWQsIG90aGVyd2lzZSB1c2UgQW1hem9uLXByb3ZpZGVkXG4gICAgICAgIC4uLihwcm9wcy5pcHY2Q2lkckJsb2NrIFxuICAgICAgICAgID8geyBpcHY2Q2lkckJsb2NrOiBwcm9wcy5pcHY2Q2lkckJsb2NrIH1cbiAgICAgICAgICA6IHsgYW1hem9uUHJvdmlkZWRJcHY2Q2lkckJsb2NrOiB0cnVlIH1cbiAgICAgICAgKSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBDb25maWd1cmUgSVB2NiBmb3IgcHVibGljIHN1Ym5ldHNcbiAgICAgIHZwYy5wdWJsaWNTdWJuZXRzLmZvckVhY2goKHN1Ym5ldCwgaW5kZXgpID0+IHtcbiAgICAgICAgY29uc3QgY2ZuU3VibmV0ID0gc3VibmV0Lm5vZGUuZGVmYXVsdENoaWxkIGFzIGVjMi5DZm5TdWJuZXQ7XG4gICAgICAgIGNmblN1Ym5ldC5pcHY2Q2lkckJsb2NrID0gY2RrLkZuLnNlbGVjdChpbmRleCwgY2RrLkZuLmNpZHIoXG4gICAgICAgICAgY2RrLkZuLnNlbGVjdCgwLCB2cGMudnBjSXB2NkNpZHJCbG9ja3MpLFxuICAgICAgICAgIDI1NixcbiAgICAgICAgICAnNjQnXG4gICAgICAgICkpO1xuICAgICAgICBjZm5TdWJuZXQuYXNzaWduSXB2NkFkZHJlc3NPbkNyZWF0aW9uID0gdHJ1ZTtcbiAgICAgICAgY2ZuU3VibmV0LmFkZERlcGVuZGVuY3koaXB2NkNpZHJCbG9jayk7XG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIElQdjYgcm91dGUgZm9yIHB1YmxpYyBzdWJuZXRzXG4gICAgICB2cGMucHVibGljU3VibmV0cy5mb3JFYWNoKChzdWJuZXQsIGluZGV4KSA9PiB7XG4gICAgICAgIG5ldyBlYzIuQ2ZuUm91dGUodGhpcywgYElwdjZSb3V0ZS0ke2luZGV4fWAsIHtcbiAgICAgICAgICByb3V0ZVRhYmxlSWQ6IHN1Ym5ldC5yb3V0ZVRhYmxlLnJvdXRlVGFibGVJZCxcbiAgICAgICAgICBkZXN0aW5hdGlvbklwdjZDaWRyQmxvY2s6ICc6Oi8wJyxcbiAgICAgICAgICBnYXRld2F5SWQ6IHZwYy5pbnRlcm5ldEdhdGV3YXlJZCxcbiAgICAgICAgfSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHZwYztcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IGVjMi5WcGModGhpcywgJ1Rlc3RBcHBWcGMnLCB2cGNQcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjclJlcG9zaXRvcnkocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBlY3IuUmVwb3NpdG9yeSB7XG4gICAgY29uc3QgcmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnVGVzdEFwcFJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLFxuICAgICAgICAgIHRhZ1N0YXR1czogZWNyLlRhZ1N0YXR1cy5BTlksXG4gICAgICAgICAgbWF4SW1hZ2VDb3VudDogMTAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIHJldHVybiByZXBvc2l0b3J5O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3NDbHVzdGVyKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWNzLkNsdXN0ZXIge1xuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ1Rlc3RBcHBDbHVzdGVyJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIGNsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIC8vIE5vdGU6IGNvbnRhaW5lckluc2lnaHRzIGlzIGRlcHJlY2F0ZWQgYnV0IHN0aWxsIGZ1bmN0aW9uYWxcbiAgICAgIC8vIEluIG5ld2VyIENESyB2ZXJzaW9ucywgdXNlIGNvbnRhaW5lckluc2lnaHRzOiBlY3MuQ29udGFpbmVySW5zaWdodHMuRU5IQU5DRURcbiAgICB9KTtcblxuICAgIHJldHVybiBjbHVzdGVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVGYXJnYXRlU2VydmljZShwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjc19wYXR0ZXJucy5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlZEZhcmdhdGVTZXJ2aWNlIHtcbiAgICAvLyBDcmVhdGUgQ2xvdWRXYXRjaCBMb2cgR3JvdXBcbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdUZXN0QXBwTG9nR3JvdXAnLCB7XG4gICAgICBsb2dHcm91cE5hbWU6IGAvYXdzL2Vjcy90ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIHJldGVudGlvbjogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgPyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAgICAgIDogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSB0YXNrIGV4ZWN1dGlvbiByb2xlXG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGVzdEFwcEV4ZWN1dGlvblJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeScpLFxuICAgICAgXSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIEVDUkFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSB0YXNrIHJvbGUgd2l0aCBzZWNyZXRzIGFjY2Vzc1xuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUZXN0QXBwVGFza1JvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIENsb3VkV2F0Y2hMb2dzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICAgIFNlY3JldHNNYW5hZ2VyQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBmYXJnYXRlU2VydmljZSA9IG5ldyBlY3NfcGF0dGVybnMuQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSh0aGlzLCAnVGVzdEFwcFNlcnZpY2UnLCB7XG4gICAgICBjbHVzdGVyOiB0aGlzLmNsdXN0ZXIsXG4gICAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBjcHU6IHByb3BzLmNwdSxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlMaW1pdE1pQixcbiAgICAgIGRlc2lyZWRDb3VudDogcHJvcHMuZGVzaXJlZENvdW50LFxuICAgICAgdGFza0ltYWdlT3B0aW9uczoge1xuICAgICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHRoaXMucmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgICBjb250YWluZXJOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgIGNvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICAgIHRhc2tSb2xlLFxuICAgICAgICBsb2dEcml2ZXI6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICAgIHN0cmVhbVByZWZpeDogJ3Rlc3RhcHAnLFxuICAgICAgICAgIGxvZ0dyb3VwLFxuICAgICAgICB9KSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBSRVFVSVJFRF9TRVRUSU5HOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgfSxcbiAgICAgICAgc2VjcmV0czoge1xuICAgICAgICAgIC8vIEluZGl2aWR1YWwgc2VjcmV0cyBmcm9tIEFXUyBTZWNyZXRzIE1hbmFnZXJcbiAgICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdhcHBsaWNhdGlvbi5zZWNyZXRfa2V5JyksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcHVibGljTG9hZEJhbGFuY2VyOiB0cnVlLFxuICAgICAgbGlzdGVuZXJQb3J0OiA4MCxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIGRvbWFpblpvbmU6IHVuZGVmaW5lZCwgLy8gTm8gY3VzdG9tIGRvbWFpbiBmb3IgdGhpcyBhc3Nlc3NtZW50XG4gICAgICBkb21haW5OYW1lOiB1bmRlZmluZWQsXG4gICAgICByZWRpcmVjdEhUVFA6IGZhbHNlLFxuICAgICAgYXNzaWduUHVibGljSXA6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBDb25maWd1cmUgaGVhbHRoIGNoZWNrXG4gICAgZmFyZ2F0ZVNlcnZpY2UudGFyZ2V0R3JvdXAuY29uZmlndXJlSGVhbHRoQ2hlY2soe1xuICAgICAgcGF0aDogJy9oZWFsdGgvJyxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlByb3RvY29sLkhUVFAsXG4gICAgICBwb3J0OiAnODAwMCcsXG4gICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJlIGF1dG8gc2NhbGluZ1xuICAgIGNvbnN0IHNjYWxhYmxlVGFyZ2V0ID0gZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHk6IHByb3BzLmRlc2lyZWRDb3VudCxcbiAgICAgIG1heENhcGFjaXR5OiBwcm9wcy5kZXNpcmVkQ291bnQgKiAzLFxuICAgIH0pO1xuXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbkNwdVV0aWxpemF0aW9uKCdDcHVTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiA3MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICB9KTtcblxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25NZW1vcnlVdGlsaXphdGlvbignTWVtb3J5U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogODAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgfSk7XG5cbiAgICAvLyBTZWN1cml0eSBncm91cCBmb3IgdGhlIHNlcnZpY2VcbiAgICBmYXJnYXRlU2VydmljZS5zZXJ2aWNlLmNvbm5lY3Rpb25zLnNlY3VyaXR5R3JvdXBzLmZvckVhY2goc2cgPT4ge1xuICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgICAgZWMyLlBvcnQudGNwKDgwMDApLFxuICAgICAgICAnQWxsb3cgSFRUUCB0cmFmZmljIGZyb20gQUxCJ1xuICAgICAgKTtcblxuICAgICAgaWYgKHByb3BzLmVuYWJsZUlQdjYpIHtcbiAgICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgICAgZWMyLlBlZXIuYW55SXB2NigpLFxuICAgICAgICAgIGVjMi5Qb3J0LnRjcCg4MDAwKSxcbiAgICAgICAgICAnQWxsb3cgSFRUUCB0cmFmZmljIGZyb20gQUxCIChJUHY2KSdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBmYXJnYXRlU2VydmljZTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlT3V0cHV0cygpOiB2b2lkIHtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVnBjSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy52cGMudnBjSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ1ZQQyBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVnBjSWRgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NsdXN0ZXJOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2x1c3Rlci5jbHVzdGVyTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2x1c3Rlck5hbWVgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1JlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5yZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9hZEJhbGFuY2VyRE5TJywge1xuICAgICAgdmFsdWU6IHRoaXMuZmFyZ2F0ZVNlcnZpY2UubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgRE5TIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvYWRCYWxhbmNlckROU2AsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU2VydmljZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5mYXJnYXRlU2VydmljZS5zZXJ2aWNlLnNlcnZpY2VOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgU2VydmljZSBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1TZXJ2aWNlTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICB2YWx1ZTogYGh0dHA6Ly8ke3RoaXMuZmFyZ2F0ZVNlcnZpY2UubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWV9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMJyxcbiAgICB9KTtcbiAgfVxufSJdfQ==