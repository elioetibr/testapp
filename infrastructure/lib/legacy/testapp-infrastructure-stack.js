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
const wafv2 = require("aws-cdk-lib/aws-wafv2");
const s3 = require("aws-cdk-lib/aws-s3");
const certificatemanager = require("aws-cdk-lib/aws-certificatemanager");
const secrets_loader_1 = require("../secrets-loader");
class TestAppInfrastructureStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Initialize secrets loader
        this.secretsLoader = new secrets_loader_1.SecretsLoader(props.environment);
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
    createSecureTaskDefinition(props, executionRole, taskRole, logGroup) {
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
            user: props.enableNonRootContainer ? '1001:1001' : undefined,
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
        // Create secure task definition if security enhancements are enabled
        const secureTaskDefinition = this.createSecureTaskDefinition(props, executionRole, taskRole, logGroup);
        const fargateServiceProps = {
            cluster: this.cluster,
            serviceName: `testapp-service-${props.environment}`,
            desiredCount: props.desiredCount,
            publicLoadBalancer: true,
            listenerPort: this.certificate ? 443 : 80,
            protocol: this.certificate
                ? elasticloadbalancingv2.ApplicationProtocol.HTTPS
                : elasticloadbalancingv2.ApplicationProtocol.HTTP,
            certificate: this.certificate,
            domainZone: undefined,
            domainName: undefined,
            redirectHTTP: this.certificate ? true : false,
            assignPublicIp: true,
        };
        // Use secure task definition if available, otherwise use standard taskImageOptions
        if (secureTaskDefinition) {
            fargateServiceProps.taskDefinition = secureTaskDefinition;
        }
        else {
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
        // Security group for the service
        fargateService.service.connections.securityGroups.forEach(sg => {
            sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8000), 'Allow HTTP traffic from ALB');
            if (props.enableIPv6) {
                sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8000), 'Allow HTTP traffic from ALB (IPv6)');
            }
        });
        return fargateService;
    }
    createVPCFlowLogsBucket(props) {
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
    createVPCFlowLogs(props) {
        if (!this.flowLogsBucket)
            return;
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
                destination: ec2.FlowLogDestination.toS3(this.flowLogsBucket, `private-subnets/subnet-${index}/`),
                trafficType: ec2.FlowLogTrafficType.ALL,
            });
        });
    }
    createCertificate(props) {
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
    createWAF(props) {
        // Create IP sets for rate limiting and blocking
        const ipSetAllowList = new wafv2.CfnIPSet(this, 'IPSetAllowList', {
            name: `testapp-${props.environment}-allow-list`,
            description: 'Allowed IP addresses',
            ipAddressVersion: 'IPV4',
            addresses: [],
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
    associateWAFWithALB() {
        if (!this.webACL)
            return;
        // Associate WAF with Application Load Balancer
        new wafv2.CfnWebACLAssociation(this, 'WebACLAssociation', {
            resourceArn: this.fargateService.loadBalancer.loadBalancerArn,
            webAclArn: this.webACL.attrArn,
        });
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
exports.TestAppInfrastructureStack = TestAppInfrastructureStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkRBQTZEO0FBQzdELDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsMkNBQTJDO0FBQzNDLGlGQUFpRjtBQUNqRixpRUFBaUU7QUFDakUsK0NBQStDO0FBQy9DLHlDQUF5QztBQUN6Qyx5RUFBeUU7QUFFekUsc0RBQWtEO0FBMkJsRCxNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBV3ZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0M7UUFDOUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNEJBQTRCO1FBQzVCLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUxRCw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFekQsMkNBQTJDO1FBQzNDLElBQUksS0FBSyxDQUFDLGlCQUFpQixFQUFFO1lBQzNCLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQzNEO1FBRUQsNERBQTREO1FBQzVELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVqQyxvQ0FBb0M7UUFDcEMsSUFBSSxLQUFLLENBQUMsaUJBQWlCLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRTtZQUNsRCxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDL0I7UUFF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RUFBRSxxQkFBcUI7Z0JBQ2xDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGlCQUFpQjthQUMvQyxDQUFDLENBQUM7U0FDSjtJQUNILENBQUM7Q0FDRjtBQXhwQkQsZ0VBd3BCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3NfcGF0dGVybnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcy1wYXR0ZXJucyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHdhZnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy13YWZ2Mic7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgY2VydGlmaWNhdGVtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBTZWNyZXRzTG9hZGVyIH0gZnJvbSAnLi4vc2VjcmV0cy1sb2FkZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGVudmlyb25tZW50OiBzdHJpbmc7XG4gIGVuYWJsZUlQdjY6IGJvb2xlYW47XG4gIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGJvb2xlYW47XG4gIG1heEF6czogbnVtYmVyO1xuICBuYXRHYXRld2F5czogbnVtYmVyO1xuICBkZXNpcmVkQ291bnQ6IG51bWJlcjtcbiAgY3B1OiBudW1iZXI7XG4gIG1lbW9yeUxpbWl0TWlCOiBudW1iZXI7XG4gIC8vIE5ldHdvcmsgY29uZmlndXJhdGlvblxuICB2cGNDaWRyPzogc3RyaW5nO1xuICBwdWJsaWNTdWJuZXRDaWRyTWFzaz86IG51bWJlcjtcbiAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrPzogbnVtYmVyO1xuICAvLyBJUHY2IGNvbmZpZ3VyYXRpb25cbiAgaXB2NkNpZHJCbG9jaz86IHN0cmluZzsgLy8gSWYgbm90IHByb3ZpZGVkLCBBV1Mgd2lsbCBhc3NpZ24gb25lIGF1dG9tYXRpY2FsbHlcbiAgLy8gU2VjdXJpdHkgZW5oYW5jZW1lbnRzIChkaXNhYmxlZCBieSBkZWZhdWx0KVxuICBlbmFibGVXQUY/OiBib29sZWFuO1xuICBlbmFibGVWUENGbG93TG9ncz86IGJvb2xlYW47XG4gIGVuYWJsZUhUVFBTPzogYm9vbGVhbjtcbiAgZG9tYWluTmFtZT86IHN0cmluZztcbiAgLy8gQ29udGFpbmVyIHNlY3VyaXR5XG4gIGVuYWJsZU5vblJvb3RDb250YWluZXI/OiBib29sZWFuO1xuICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGNsYXNzIFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHZwYzogZWMyLlZwYztcbiAgcHVibGljIHJlYWRvbmx5IGNsdXN0ZXI6IGVjcy5DbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnk7XG4gIHB1YmxpYyByZWFkb25seSBmYXJnYXRlU2VydmljZTogZWNzX3BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2U7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjcmV0c0xvYWRlcjogU2VjcmV0c0xvYWRlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBhcHBTZWNyZXRzOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmxvd0xvZ3NCdWNrZXQ/OiBzMy5CdWNrZXQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgd2ViQUNMPzogd2FmdjIuQ2ZuV2ViQUNMO1xuICBwcml2YXRlIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzZWNyZXRzIGxvYWRlclxuICAgIHRoaXMuc2VjcmV0c0xvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKHByb3BzLmVudmlyb25tZW50KTtcbiAgICBcbiAgICAvLyBDcmVhdGUgQVdTIFNlY3JldHMgTWFuYWdlciBzZWNyZXQgZnJvbSBTT1BTXG4gICAgdGhpcy5hcHBTZWNyZXRzID0gdGhpcy5jcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgVlBDIEZsb3cgTG9ncyBidWNrZXQgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVZQQ0Zsb3dMb2dzKSB7XG4gICAgICB0aGlzLmZsb3dMb2dzQnVja2V0ID0gdGhpcy5jcmVhdGVWUENGbG93TG9nc0J1Y2tldChwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFZQQyB3aXRoIGNvbmZpZ3VyYWJsZSBJUHY2IGFuZCBOQVQgR2F0ZXdheSBvcHRpb25zXG4gICAgdGhpcy52cGMgPSB0aGlzLmNyZWF0ZVZwYyhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgVlBDIEZsb3cgTG9ncyAoaWYgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlVlBDRmxvd0xvZ3MgJiYgdGhpcy5mbG93TG9nc0J1Y2tldCkge1xuICAgICAgdGhpcy5jcmVhdGVWUENGbG93TG9ncyhwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFNTTCBjZXJ0aWZpY2F0ZSAoSFRUUFMgaXMgbWFuZGF0b3J5IHdoZW4gZG9tYWluIGlzIHByb3ZpZGVkKVxuICAgIGlmIChwcm9wcy5kb21haW5OYW1lKSB7XG4gICAgICB0aGlzLmNlcnRpZmljYXRlID0gdGhpcy5jcmVhdGVDZXJ0aWZpY2F0ZShwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIEVDUiBSZXBvc2l0b3J5XG4gICAgdGhpcy5yZXBvc2l0b3J5ID0gdGhpcy5jcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBFQ1MgQ2x1c3RlclxuICAgIHRoaXMuY2x1c3RlciA9IHRoaXMuY3JlYXRlRWNzQ2x1c3Rlcihwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgRmFyZ2F0ZSBTZXJ2aWNlIHdpdGggQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIHRoaXMuZmFyZ2F0ZVNlcnZpY2UgPSB0aGlzLmNyZWF0ZUZhcmdhdGVTZXJ2aWNlKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBXQUYgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVdBRikge1xuICAgICAgdGhpcy53ZWJBQ0wgPSB0aGlzLmNyZWF0ZVdBRihwcm9wcyk7XG4gICAgICB0aGlzLmFzc29jaWF0ZVdBRldpdGhBTEIoKTtcbiAgICB9XG5cbiAgICAvLyBPdXRwdXQgaW1wb3J0YW50IHJlc291cmNlc1xuICAgIHRoaXMuY3JlYXRlT3V0cHV0cygpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IHNlY3JldHNtYW5hZ2VyLlNlY3JldCB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIExvYWQgc2VjcmV0cyBmcm9tIFNPUFNcbiAgICAgIGNvbnN0IHNlY3JldHMgPSB0aGlzLnNlY3JldHNMb2FkZXIubG9hZFNlY3JldHNXaXRoRmFsbGJhY2soKTtcbiAgICAgIFxuICAgICAgLy8gQ3JlYXRlIFNlY3JldHMgTWFuYWdlciBzZWNyZXRcbiAgICAgIGNvbnN0IHNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0FwcFNlY3JldHMnLCB7XG4gICAgICAgIHNlY3JldE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXNlY3JldHNgLFxuICAgICAgICBkZXNjcmlwdGlvbjogYEFwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICAgIHNlY3JldFN0cmluZ1RlbXBsYXRlOiBKU09OLnN0cmluZ2lmeShzZWNyZXRzKSxcbiAgICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ2dlbmVyYXRlZF9hdCcsXG4gICAgICAgICAgaW5jbHVkZVNwYWNlOiBmYWxzZSxcbiAgICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogJ1wiQC9cXFxcJ1xuICAgICAgICB9LFxuICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBUYWcgdGhlIHNlY3JldFxuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgICAgY2RrLlRhZ3Mub2Yoc2VjcmV0KS5hZGQoJ01hbmFnZWRCeScsICdDREstU09QUycpO1xuICAgICAgXG4gICAgICByZXR1cm4gc2VjcmV0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBsb2FkIFNPUFMgc2VjcmV0cywgY3JlYXRpbmcgZW1wdHkgc2VjcmV0OiAke2Vycm9yfWApO1xuICAgICAgXG4gICAgICAvLyBGYWxsYmFjazogY3JlYXRlIGVtcHR5IHNlY3JldCB0aGF0IGNhbiBiZSBwb3B1bGF0ZWQgbGF0ZXJcbiAgICAgIHJldHVybiBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1zZWNyZXRzYCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50IChlbXB0eSAtIHBvcHVsYXRlIG1hbnVhbGx5KWAsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVWcGMocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBlYzIuVnBjIHtcbiAgICBjb25zdCBzdWJuZXRDb25maWd1cmF0aW9uOiBlYzIuU3VibmV0Q29uZmlndXJhdGlvbltdID0gW1xuICAgICAge1xuICAgICAgICBuYW1lOiAnUHVibGljJyxcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLFxuICAgICAgICBjaWRyTWFzazogcHJvcHMucHVibGljU3VibmV0Q2lkck1hc2sgfHwgMjQsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnUHJpdmF0ZScsXG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgIGNpZHJNYXNrOiBwcm9wcy5wcml2YXRlU3VibmV0Q2lkck1hc2sgfHwgMjQsXG4gICAgICB9XG4gICAgXTtcblxuICAgIGNvbnN0IHZwY1Byb3BzOiBlYzIuVnBjUHJvcHMgPSB7XG4gICAgICBtYXhBenM6IHByb3BzLm1heEF6cyxcbiAgICAgIG5hdEdhdGV3YXlzOiBwcm9wcy5lbmFibGVIQU5hdEdhdGV3YXlzID8gcHJvcHMubWF4QXpzIDogTWF0aC5taW4ocHJvcHMubmF0R2F0ZXdheXMsIHByb3BzLm1heEF6cyksXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uLFxuICAgICAgZW5hYmxlRG5zSG9zdG5hbWVzOiB0cnVlLFxuICAgICAgZW5hYmxlRG5zU3VwcG9ydDogdHJ1ZSxcbiAgICAgIC8vIEN1c3RvbSBJUHY0IENJRFIgYmxvY2sgKHVzaW5nIG5ldyBpcEFkZHJlc3NlcyBBUEkpXG4gICAgICBpcEFkZHJlc3NlczogZWMyLklwQWRkcmVzc2VzLmNpZHIocHJvcHMudnBjQ2lkciB8fCAnMTAuMC4wLjAvMTYnKSxcbiAgICB9O1xuXG4gICAgLy8gQWRkIElQdjYgc3VwcG9ydCBpZiBlbmFibGVkXG4gICAgaWYgKHByb3BzLmVuYWJsZUlQdjYpIHtcbiAgICAgIC8vIElQdjYgY29uZmlndXJhdGlvblxuICAgICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1Rlc3RBcHBWcGMnLCB7XG4gICAgICAgIC4uLnZwY1Byb3BzLFxuICAgICAgICAvLyBJUHY2IHdpbGwgYmUgYWRkZWQgdmlhIHNlcGFyYXRlIGNvbmZpZ3VyYXRpb25cbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgSVB2NiBDSURSIGJsb2NrIHRvIFZQQ1xuICAgICAgY29uc3QgaXB2NkNpZHJCbG9jayA9IG5ldyBlYzIuQ2ZuVlBDQ2lkckJsb2NrKHRoaXMsICdJcHY2Q2lkckJsb2NrJywge1xuICAgICAgICB2cGNJZDogdnBjLnZwY0lkLFxuICAgICAgICAvLyBVc2UgY3VzdG9tIElQdjYgQ0lEUiBpZiBwcm92aWRlZCwgb3RoZXJ3aXNlIHVzZSBBbWF6b24tcHJvdmlkZWRcbiAgICAgICAgLi4uKHByb3BzLmlwdjZDaWRyQmxvY2sgXG4gICAgICAgICAgPyB7IGlwdjZDaWRyQmxvY2s6IHByb3BzLmlwdjZDaWRyQmxvY2sgfVxuICAgICAgICAgIDogeyBhbWF6b25Qcm92aWRlZElwdjZDaWRyQmxvY2s6IHRydWUgfVxuICAgICAgICApLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIENvbmZpZ3VyZSBJUHY2IGZvciBwdWJsaWMgc3VibmV0c1xuICAgICAgdnBjLnB1YmxpY1N1Ym5ldHMuZm9yRWFjaCgoc3VibmV0LCBpbmRleCkgPT4ge1xuICAgICAgICBjb25zdCBjZm5TdWJuZXQgPSBzdWJuZXQubm9kZS5kZWZhdWx0Q2hpbGQgYXMgZWMyLkNmblN1Ym5ldDtcbiAgICAgICAgY2ZuU3VibmV0LmlwdjZDaWRyQmxvY2sgPSBjZGsuRm4uc2VsZWN0KGluZGV4LCBjZGsuRm4uY2lkcihcbiAgICAgICAgICBjZGsuRm4uc2VsZWN0KDAsIHZwYy52cGNJcHY2Q2lkckJsb2NrcyksXG4gICAgICAgICAgMjU2LFxuICAgICAgICAgICc2NCdcbiAgICAgICAgKSk7XG4gICAgICAgIGNmblN1Ym5ldC5hc3NpZ25JcHY2QWRkcmVzc09uQ3JlYXRpb24gPSB0cnVlO1xuICAgICAgICBjZm5TdWJuZXQuYWRkRGVwZW5kZW5jeShpcHY2Q2lkckJsb2NrKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgSVB2NiByb3V0ZSBmb3IgcHVibGljIHN1Ym5ldHNcbiAgICAgIHZwYy5wdWJsaWNTdWJuZXRzLmZvckVhY2goKHN1Ym5ldCwgaW5kZXgpID0+IHtcbiAgICAgICAgbmV3IGVjMi5DZm5Sb3V0ZSh0aGlzLCBgSXB2NlJvdXRlLSR7aW5kZXh9YCwge1xuICAgICAgICAgIHJvdXRlVGFibGVJZDogc3VibmV0LnJvdXRlVGFibGUucm91dGVUYWJsZUlkLFxuICAgICAgICAgIGRlc3RpbmF0aW9uSXB2NkNpZHJCbG9jazogJzo6LzAnLFxuICAgICAgICAgIGdhdGV3YXlJZDogdnBjLmludGVybmV0R2F0ZXdheUlkLFxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gdnBjO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgZWMyLlZwYyh0aGlzLCAnVGVzdEFwcFZwYycsIHZwY1Byb3BzKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRWNyUmVwb3NpdG9yeShwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjci5SZXBvc2l0b3J5IHtcbiAgICBjb25zdCByZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdUZXN0QXBwUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgcnVsZVByaW9yaXR5OiAxLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsXG4gICAgICAgICAgdGFnU3RhdHVzOiBlY3IuVGFnU3RhdHVzLkFOWSxcbiAgICAgICAgICBtYXhJbWFnZUNvdW50OiAxMCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlcG9zaXRvcnk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjc0NsdXN0ZXIocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBlY3MuQ2x1c3RlciB7XG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCAnVGVzdEFwcENsdXN0ZXInLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgY2x1c3Rlck5hbWU6IGB0ZXN0YXBwLWNsdXN0ZXItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgLy8gTm90ZTogY29udGFpbmVySW5zaWdodHMgaXMgZGVwcmVjYXRlZCBidXQgc3RpbGwgZnVuY3Rpb25hbFxuICAgICAgLy8gSW4gbmV3ZXIgQ0RLIHZlcnNpb25zLCB1c2UgY29udGFpbmVySW5zaWdodHM6IGVjcy5Db250YWluZXJJbnNpZ2h0cy5FTkhBTkNFRFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNsdXN0ZXI7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3VyZVRhc2tEZWZpbml0aW9uKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzLCBleGVjdXRpb25Sb2xlOiBpYW0uUm9sZSwgdGFza1JvbGU6IGlhbS5Sb2xlLCBsb2dHcm91cDogbG9ncy5Mb2dHcm91cCk6IGVjcy5UYXNrRGVmaW5pdGlvbiB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFwcm9wcy5lbmFibGVOb25Sb290Q29udGFpbmVyICYmICFwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkOyAvLyBVc2UgZGVmYXVsdCB0YXNrIGRlZmluaXRpb25cbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgY3VzdG9tIHRhc2sgZGVmaW5pdGlvbiB3aXRoIHNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICAgIGNvbnN0IHRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24odGhpcywgJ1NlY3VyZVRhc2tEZWZpbml0aW9uJywge1xuICAgICAgY3B1OiBwcm9wcy5jcHUsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogcHJvcHMubWVtb3J5TGltaXRNaUIsXG4gICAgICBleGVjdXRpb25Sb2xlLFxuICAgICAgdGFza1JvbGUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29udGFpbmVyIHdpdGggc2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gICAgY29uc3QgY29udGFpbmVyID0gdGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCd0ZXN0YXBwJywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRWNyUmVwb3NpdG9yeSh0aGlzLnJlcG9zaXRvcnksICdsYXRlc3QnKSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6ICd0ZXN0YXBwJyxcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFJFUVVJUkVEX1NFVFRJTkc6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICB9LFxuICAgICAgc2VjcmV0czoge1xuICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdhcHBsaWNhdGlvbi5zZWNyZXRfa2V5JyksXG4gICAgICB9LFxuICAgICAgLy8gU2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gICAgICB1c2VyOiBwcm9wcy5lbmFibGVOb25Sb290Q29udGFpbmVyID8gJzEwMDE6MTAwMScgOiB1bmRlZmluZWQsIC8vIE5vbi1yb290IHVzZXJcbiAgICAgIHJlYWRvbmx5Um9vdEZpbGVzeXN0ZW06IHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0gfHwgZmFsc2UsXG4gICAgICAvLyBSZXNvdXJjZSBsaW1pdHMgZm9yIHNlY3VyaXR5XG4gICAgICBtZW1vcnlSZXNlcnZhdGlvbk1pQjogTWF0aC5mbG9vcihwcm9wcy5tZW1vcnlMaW1pdE1pQiAqIDAuOCksIC8vIFJlc2VydmUgODAlIG9mIG1lbW9yeVxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHBvcnQgbWFwcGluZ1xuICAgIGNvbnRhaW5lci5hZGRQb3J0TWFwcGluZ3Moe1xuICAgICAgY29udGFpbmVyUG9ydDogODAwMCxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRtcGZzIG1vdW50cyBpZiByZWFkLW9ubHkgcm9vdCBmaWxlc3lzdGVtIGlzIGVuYWJsZWRcbiAgICBpZiAocHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSkge1xuICAgICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBob3N0OiB7fSxcbiAgICAgIH0pO1xuXG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBzb3VyY2VWb2x1bWU6ICd0bXAtdm9sdW1lJyxcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy90bXAnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIGxvZ3Mgdm9sdW1lXG4gICAgICB0YXNrRGVmaW5pdGlvbi5hZGRWb2x1bWUoe1xuICAgICAgICBuYW1lOiAnbG9ncy12b2x1bWUnLFxuICAgICAgICBob3N0OiB7fSxcbiAgICAgIH0pO1xuXG4gICAgICBjb250YWluZXIuYWRkTW91bnRQb2ludHMoe1xuICAgICAgICBzb3VyY2VWb2x1bWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgIGNvbnRhaW5lclBhdGg6ICcvYXBwL2xvZ3MnLFxuICAgICAgICByZWFkT25seTogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGFza0RlZmluaXRpb247XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUZhcmdhdGVTZXJ2aWNlKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWNzX3BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2Uge1xuICAgIC8vIENyZWF0ZSBDbG91ZFdhdGNoIExvZyBHcm91cFxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ1Rlc3RBcHBMb2dHcm91cCcsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9hd3MvZWNzL3Rlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgcmV0ZW50aW9uOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICA/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgICAgOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIHRhc2sgZXhlY3V0aW9uIHJvbGVcbiAgICBjb25zdCBleGVjdXRpb25Sb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUZXN0QXBwRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5JyksXG4gICAgICBdLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgRUNSQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJyxcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIHRhc2sgcm9sZSB3aXRoIHNlY3JldHMgYWNjZXNzXG4gICAgY29uc3QgdGFza1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rlc3RBcHBUYXNrUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgQ2xvdWRXYXRjaExvZ3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcbiAgICAgICAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cC5sb2dHcm91cEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgU2VjcmV0c01hbmFnZXJBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLmFwcFNlY3JldHMuc2VjcmV0QXJuXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBzZWN1cmUgdGFzayBkZWZpbml0aW9uIGlmIHNlY3VyaXR5IGVuaGFuY2VtZW50cyBhcmUgZW5hYmxlZFxuICAgIGNvbnN0IHNlY3VyZVRhc2tEZWZpbml0aW9uID0gdGhpcy5jcmVhdGVTZWN1cmVUYXNrRGVmaW5pdGlvbihwcm9wcywgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUsIGxvZ0dyb3VwKTtcblxuICAgIGNvbnN0IGZhcmdhdGVTZXJ2aWNlUHJvcHM6IGFueSA9IHtcbiAgICAgIGNsdXN0ZXI6IHRoaXMuY2x1c3RlcixcbiAgICAgIHNlcnZpY2VOYW1lOiBgdGVzdGFwcC1zZXJ2aWNlLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGRlc2lyZWRDb3VudDogcHJvcHMuZGVzaXJlZENvdW50LFxuICAgICAgcHVibGljTG9hZEJhbGFuY2VyOiB0cnVlLFxuICAgICAgbGlzdGVuZXJQb3J0OiB0aGlzLmNlcnRpZmljYXRlID8gNDQzIDogODAsXG4gICAgICBwcm90b2NvbDogdGhpcy5jZXJ0aWZpY2F0ZSBcbiAgICAgICAgPyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUFMgXG4gICAgICAgIDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICBjZXJ0aWZpY2F0ZTogdGhpcy5jZXJ0aWZpY2F0ZSxcbiAgICAgIGRvbWFpblpvbmU6IHVuZGVmaW5lZCwgLy8gQ3VzdG9tIGRvbWFpbiB6b25lIHdvdWxkIGJlIGNvbmZpZ3VyZWQgc2VwYXJhdGVseVxuICAgICAgZG9tYWluTmFtZTogdW5kZWZpbmVkLCAvLyBEb21haW4gbmFtZSByZXF1aXJlcyBkb21haW5ab25lIGNvbmZpZ3VyYXRpb25cbiAgICAgIHJlZGlyZWN0SFRUUDogdGhpcy5jZXJ0aWZpY2F0ZSA/IHRydWUgOiBmYWxzZSwgLy8gUmVkaXJlY3QgSFRUUCB0byBIVFRQUyB3aGVuIGNlcnRpZmljYXRlIGlzIGF2YWlsYWJsZVxuICAgICAgYXNzaWduUHVibGljSXA6IHRydWUsXG4gICAgfTtcblxuICAgIC8vIFVzZSBzZWN1cmUgdGFzayBkZWZpbml0aW9uIGlmIGF2YWlsYWJsZSwgb3RoZXJ3aXNlIHVzZSBzdGFuZGFyZCB0YXNrSW1hZ2VPcHRpb25zXG4gICAgaWYgKHNlY3VyZVRhc2tEZWZpbml0aW9uKSB7XG4gICAgICBmYXJnYXRlU2VydmljZVByb3BzLnRhc2tEZWZpbml0aW9uID0gc2VjdXJlVGFza0RlZmluaXRpb247XG4gICAgfSBlbHNlIHtcbiAgICAgIGZhcmdhdGVTZXJ2aWNlUHJvcHMuY3B1ID0gcHJvcHMuY3B1O1xuICAgICAgZmFyZ2F0ZVNlcnZpY2VQcm9wcy5tZW1vcnlMaW1pdE1pQiA9IHByb3BzLm1lbW9yeUxpbWl0TWlCO1xuICAgICAgZmFyZ2F0ZVNlcnZpY2VQcm9wcy50YXNrSW1hZ2VPcHRpb25zID0ge1xuICAgICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHRoaXMucmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgICBjb250YWluZXJOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgIGNvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICAgIHRhc2tSb2xlLFxuICAgICAgICBsb2dEcml2ZXI6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICAgIHN0cmVhbVByZWZpeDogJ3Rlc3RhcHAnLFxuICAgICAgICAgIGxvZ0dyb3VwLFxuICAgICAgICB9KSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBSRVFVSVJFRF9TRVRUSU5HOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgfSxcbiAgICAgICAgc2VjcmV0czoge1xuICAgICAgICAgIC8vIEluZGl2aWR1YWwgc2VjcmV0cyBmcm9tIEFXUyBTZWNyZXRzIE1hbmFnZXJcbiAgICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdhcHBsaWNhdGlvbi5zZWNyZXRfa2V5JyksXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGZhcmdhdGVTZXJ2aWNlID0gbmV3IGVjc19wYXR0ZXJucy5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlZEZhcmdhdGVTZXJ2aWNlKHRoaXMsICdUZXN0QXBwU2VydmljZScsIGZhcmdhdGVTZXJ2aWNlUHJvcHMpO1xuXG4gICAgLy8gQ29uZmlndXJlIGhlYWx0aCBjaGVja1xuICAgIGZhcmdhdGVTZXJ2aWNlLnRhcmdldEdyb3VwLmNvbmZpZ3VyZUhlYWx0aENoZWNrKHtcbiAgICAgIHBhdGg6ICcvaGVhbHRoLycsXG4gICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5Qcm90b2NvbC5IVFRQLFxuICAgICAgcG9ydDogJzgwMDAnLFxuICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZ3VyZSBhdXRvIHNjYWxpbmdcbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IGZhcmdhdGVTZXJ2aWNlLnNlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5OiBwcm9wcy5kZXNpcmVkQ291bnQsXG4gICAgICBtYXhDYXBhY2l0eTogcHJvcHMuZGVzaXJlZENvdW50ICogMyxcbiAgICB9KTtcblxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25DcHVVdGlsaXphdGlvbignQ3B1U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogNzAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgfSk7XG5cbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uTWVtb3J5VXRpbGl6YXRpb24oJ01lbW9yeVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDgwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDIpLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIHRoZSBzZXJ2aWNlXG4gICAgZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5jb25uZWN0aW9ucy5zZWN1cml0eUdyb3Vwcy5mb3JFYWNoKHNnID0+IHtcbiAgICAgIHNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgICBlYzIuUGVlci5hbnlJcHY0KCksXG4gICAgICAgIGVjMi5Qb3J0LnRjcCg4MDAwKSxcbiAgICAgICAgJ0FsbG93IEhUVFAgdHJhZmZpYyBmcm9tIEFMQidcbiAgICAgICk7XG5cbiAgICAgIGlmIChwcm9wcy5lbmFibGVJUHY2KSB7XG4gICAgICAgIHNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgICAgIGVjMi5QZWVyLmFueUlwdjYoKSxcbiAgICAgICAgICBlYzIuUG9ydC50Y3AoODAwMCksXG4gICAgICAgICAgJ0FsbG93IEhUVFAgdHJhZmZpYyBmcm9tIEFMQiAoSVB2NiknXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gZmFyZ2F0ZVNlcnZpY2U7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVZQQ0Zsb3dMb2dzQnVja2V0KHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogczMuQnVja2V0IHtcbiAgICBjb25zdCBidWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdWUENGbG93TG9nc0J1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGB0ZXN0YXBwLXZwYy1mbG93LWxvZ3MtJHtwcm9wcy5lbnZpcm9ubWVudH0tJHt0aGlzLmFjY291bnR9YCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICB2ZXJzaW9uZWQ6IGZhbHNlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnRGVsZXRlT2xkRmxvd0xvZ3MnLFxuICAgICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgZXhwaXJhdGlvbjogY2RrLkR1cmF0aW9uLmRheXMocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDkwIDogMzApLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBUYWcgdGhlIGJ1Y2tldFxuICAgIGNkay5UYWdzLm9mKGJ1Y2tldCkuYWRkKCdQdXJwb3NlJywgJ1ZQQy1GbG93LUxvZ3MnKTtcbiAgICBjZGsuVGFncy5vZihidWNrZXQpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgXG4gICAgcmV0dXJuIGJ1Y2tldDtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVlBDRmxvd0xvZ3MocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuZmxvd0xvZ3NCdWNrZXQpIHJldHVybjtcblxuICAgIC8vIENyZWF0ZSBWUEMgRmxvdyBMb2dzXG4gICAgbmV3IGVjMi5GbG93TG9nKHRoaXMsICdWUENGbG93TG9nJywge1xuICAgICAgcmVzb3VyY2VUeXBlOiBlYzIuRmxvd0xvZ1Jlc291cmNlVHlwZS5mcm9tVnBjKHRoaXMudnBjKSxcbiAgICAgIGRlc3RpbmF0aW9uOiBlYzIuRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvUzModGhpcy5mbG93TG9nc0J1Y2tldCwgJ3ZwYy1mbG93LWxvZ3MvJyksXG4gICAgICB0cmFmZmljVHlwZTogZWMyLkZsb3dMb2dUcmFmZmljVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgRmxvdyBMb2cgZm9yIGluZGl2aWR1YWwgc3VibmV0cyAobW9yZSBncmFudWxhcilcbiAgICB0aGlzLnZwYy5wcml2YXRlU3VibmV0cy5mb3JFYWNoKChzdWJuZXQsIGluZGV4KSA9PiB7XG4gICAgICBuZXcgZWMyLkZsb3dMb2codGhpcywgYFByaXZhdGVTdWJuZXRGbG93TG9nJHtpbmRleH1gLCB7XG4gICAgICAgIHJlc291cmNlVHlwZTogZWMyLkZsb3dMb2dSZXNvdXJjZVR5cGUuZnJvbVN1Ym5ldChzdWJuZXQpLFxuICAgICAgICBkZXN0aW5hdGlvbjogZWMyLkZsb3dMb2dEZXN0aW5hdGlvbi50b1MzKHRoaXMuZmxvd0xvZ3NCdWNrZXQhLCBgcHJpdmF0ZS1zdWJuZXRzL3N1Ym5ldC0ke2luZGV4fS9gKSxcbiAgICAgICAgdHJhZmZpY1R5cGU6IGVjMi5GbG93TG9nVHJhZmZpY1R5cGUuQUxMLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNlcnRpZmljYXRlKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZSB7XG4gICAgaWYgKCFwcm9wcy5kb21haW5OYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0RvbWFpbiBuYW1lIGlzIHJlcXVpcmVkIHdoZW4gSFRUUFMgaXMgZW5hYmxlZCcpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBTU0wgY2VydGlmaWNhdGVcbiAgICByZXR1cm4gbmV3IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZSh0aGlzLCAnU1NMQ2VydGlmaWNhdGUnLCB7XG4gICAgICBkb21haW5OYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgICAgc3ViamVjdEFsdGVybmF0aXZlTmFtZXM6IFtgKi4ke3Byb3BzLmRvbWFpbk5hbWV9YF0sXG4gICAgICB2YWxpZGF0aW9uOiBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMoKSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlV0FGKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogd2FmdjIuQ2ZuV2ViQUNMIHtcbiAgICAvLyBDcmVhdGUgSVAgc2V0cyBmb3IgcmF0ZSBsaW1pdGluZyBhbmQgYmxvY2tpbmdcbiAgICBjb25zdCBpcFNldEFsbG93TGlzdCA9IG5ldyB3YWZ2Mi5DZm5JUFNldCh0aGlzLCAnSVBTZXRBbGxvd0xpc3QnLCB7XG4gICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hbGxvdy1saXN0YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWxsb3dlZCBJUCBhZGRyZXNzZXMnLFxuICAgICAgaXBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgYWRkcmVzc2VzOiBbXSwgLy8gQWRkIHlvdXIgYWxsb3dlZCBJUHMgaGVyZVxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgV0FGIFdlYiBBQ0xcbiAgICBjb25zdCB3ZWJBQ0wgPSBuZXcgd2FmdjIuQ2ZuV2ViQUNMKHRoaXMsICdXZWJBQ0wnLCB7XG4gICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS13ZWItYWNsYCxcbiAgICAgIGRlc2NyaXB0aW9uOiBgV0FGIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgIHNjb3BlOiAnUkVHSU9OQUwnLFxuICAgICAgZGVmYXVsdEFjdGlvbjogeyBhbGxvdzoge30gfSxcbiAgICAgIFxuICAgICAgcnVsZXM6IFtcbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBDb3JlIFJ1bGUgU2V0XG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgIHByaW9yaXR5OiAxLFxuICAgICAgICAgIG92ZXJyaWRlQWN0aW9uOiB7IG5vbmU6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdDb21tb25SdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBcbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBLbm93biBCYWQgSW5wdXRzXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDIsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0tub3duQmFkSW5wdXRzUnVsZVNldE1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgdmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFJhdGUgbGltaXRpbmcgcnVsZVxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1JhdGVMaW1pdFJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiAzLFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1JhdGVMaW1pdFJ1bGVNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICByYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgbGltaXQ6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAyMDAwIDogMTAwMCxcbiAgICAgICAgICAgICAgYWdncmVnYXRlS2V5VHlwZTogJ0lQJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBHZW9ncmFwaGljIHJlc3RyaWN0aW9uIChvcHRpb25hbCAtIGNhbiBiZSBjb25maWd1cmVkIHBlciBlbnZpcm9ubWVudClcbiAgICAgICAgLi4uKHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBbe1xuICAgICAgICAgIG5hbWU6ICdHZW9SZXN0cmljdGlvblJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiA0LFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIGdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGNvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCddLCAvLyBCbG9jayBzcGVjaWZpYyBjb3VudHJpZXNcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0gOiBbXSksXG4gICAgICBdLFxuXG4gICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgbWV0cmljTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0td2ViLWFjbGAsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gVGFnIHRoZSBXZWIgQUNMXG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdQdXJwb3NlJywgJ0REb1MtUHJvdGVjdGlvbicpO1xuXG4gICAgcmV0dXJuIHdlYkFDTDtcbiAgfVxuXG4gIHByaXZhdGUgYXNzb2NpYXRlV0FGV2l0aEFMQigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMud2ViQUNMKSByZXR1cm47XG5cbiAgICAvLyBBc3NvY2lhdGUgV0FGIHdpdGggQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIG5ldyB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbih0aGlzLCAnV2ViQUNMQXNzb2NpYXRpb24nLCB7XG4gICAgICByZXNvdXJjZUFybjogdGhpcy5mYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgd2ViQWNsQXJuOiB0aGlzLndlYkFDTC5hdHRyQXJuLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKCk6IHZvaWQge1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdWcGNJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnZwYy52cGNJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVlBDIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1WcGNJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3Rlck5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbHVzdGVyLmNsdXN0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbHVzdGVyTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2FkQmFsYW5jZXJETlMnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5mYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBETlMgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9hZEJhbGFuY2VyRE5TYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmZhcmdhdGVTZXJ2aWNlLnNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlcnZpY2VOYW1lYCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHByb3RvY29sID0gdGhpcy5jZXJ0aWZpY2F0ZSA/ICdodHRwcycgOiAnaHR0cCc7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcGxpY2F0aW9uVXJsJywge1xuICAgICAgdmFsdWU6IGAke3Byb3RvY29sfTovLyR7dGhpcy5mYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZX1gLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBVUkwnLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHktcmVsYXRlZCBvdXRwdXRzIChpZiBlbmFibGVkKVxuICAgIGlmICh0aGlzLndlYkFDTCkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1dBRldlYkFDTEFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVdBRldlYkFDTEFybmAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5mbG93TG9nc0J1Y2tldCkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Zsb3dMb2dzQnVja2V0TmFtZScsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuZmxvd0xvZ3NCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgICAgZGVzY3JpcHRpb246ICdWUEMgRmxvdyBMb2dzIFMzIEJ1Y2tldCBOYW1lJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUZsb3dMb2dzQnVja2V0TmFtZWAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NlcnRpZmljYXRlQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5jZXJ0aWZpY2F0ZS5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNlcnRpZmljYXRlQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufSJdfQ==