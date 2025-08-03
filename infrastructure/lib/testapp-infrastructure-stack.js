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
const secrets_loader_1 = require("./secrets-loader");
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
        // Create SSL certificate (if HTTPS enabled)
        if (props.enableHTTPS && props.domainName) {
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
            listenerPort: props.enableHTTPS ? 443 : 80,
            protocol: props.enableHTTPS
                ? elasticloadbalancingv2.ApplicationProtocol.HTTPS
                : elasticloadbalancingv2.ApplicationProtocol.HTTP,
            certificate: this.certificate,
            domainZone: undefined,
            domainName: undefined,
            redirectHTTP: props.enableHTTPS,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkRBQTZEO0FBQzdELDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsMkNBQTJDO0FBQzNDLGlGQUFpRjtBQUNqRixpRUFBaUU7QUFDakUsK0NBQStDO0FBQy9DLHlDQUF5QztBQUN6Qyx5RUFBeUU7QUFFekUscURBQWlEO0FBMkJqRCxNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBV3ZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0M7UUFDOUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNEJBQTRCO1FBQzVCLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUxRCw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFekQsMkNBQTJDO1FBQzNDLElBQUksS0FBSyxDQUFDLGlCQUFpQixFQUFFO1lBQzNCLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQzNEO1FBRUQsNERBQTREO1FBQzVELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVqQyxvQ0FBb0M7UUFDcEMsSUFBSSxLQUFLLENBQUMsaUJBQWlCLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRTtZQUNsRCxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDL0I7UUFF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QUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxpQkFBaUI7YUFDL0MsQ0FBQyxDQUFDO1NBQ0o7SUFDSCxDQUFDO0NBQ0Y7QUF4cEJELGdFQXdwQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNzX3BhdHRlcm5zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MtcGF0dGVybnMnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlcic7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtd2FmdjInO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGNlcnRpZmljYXRlbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgU2VjcmV0c0xvYWRlciB9IGZyb20gJy4vc2VjcmV0cy1sb2FkZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGVudmlyb25tZW50OiBzdHJpbmc7XG4gIGVuYWJsZUlQdjY6IGJvb2xlYW47XG4gIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGJvb2xlYW47XG4gIG1heEF6czogbnVtYmVyO1xuICBuYXRHYXRld2F5czogbnVtYmVyO1xuICBkZXNpcmVkQ291bnQ6IG51bWJlcjtcbiAgY3B1OiBudW1iZXI7XG4gIG1lbW9yeUxpbWl0TWlCOiBudW1iZXI7XG4gIC8vIE5ldHdvcmsgY29uZmlndXJhdGlvblxuICB2cGNDaWRyPzogc3RyaW5nO1xuICBwdWJsaWNTdWJuZXRDaWRyTWFzaz86IG51bWJlcjtcbiAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrPzogbnVtYmVyO1xuICAvLyBJUHY2IGNvbmZpZ3VyYXRpb25cbiAgaXB2NkNpZHJCbG9jaz86IHN0cmluZzsgLy8gSWYgbm90IHByb3ZpZGVkLCBBV1Mgd2lsbCBhc3NpZ24gb25lIGF1dG9tYXRpY2FsbHlcbiAgLy8gU2VjdXJpdHkgZW5oYW5jZW1lbnRzIChkaXNhYmxlZCBieSBkZWZhdWx0KVxuICBlbmFibGVXQUY/OiBib29sZWFuO1xuICBlbmFibGVWUENGbG93TG9ncz86IGJvb2xlYW47XG4gIGVuYWJsZUhUVFBTPzogYm9vbGVhbjtcbiAgZG9tYWluTmFtZT86IHN0cmluZztcbiAgLy8gQ29udGFpbmVyIHNlY3VyaXR5XG4gIGVuYWJsZU5vblJvb3RDb250YWluZXI/OiBib29sZWFuO1xuICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGNsYXNzIFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHZwYzogZWMyLlZwYztcbiAgcHVibGljIHJlYWRvbmx5IGNsdXN0ZXI6IGVjcy5DbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnk7XG4gIHB1YmxpYyByZWFkb25seSBmYXJnYXRlU2VydmljZTogZWNzX3BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2U7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjcmV0c0xvYWRlcjogU2VjcmV0c0xvYWRlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBhcHBTZWNyZXRzOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmxvd0xvZ3NCdWNrZXQ/OiBzMy5CdWNrZXQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgd2ViQUNMPzogd2FmdjIuQ2ZuV2ViQUNMO1xuICBwcml2YXRlIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzZWNyZXRzIGxvYWRlclxuICAgIHRoaXMuc2VjcmV0c0xvYWRlciA9IG5ldyBTZWNyZXRzTG9hZGVyKHByb3BzLmVudmlyb25tZW50KTtcbiAgICBcbiAgICAvLyBDcmVhdGUgQVdTIFNlY3JldHMgTWFuYWdlciBzZWNyZXQgZnJvbSBTT1BTXG4gICAgdGhpcy5hcHBTZWNyZXRzID0gdGhpcy5jcmVhdGVTZWNyZXRzTWFuYWdlclNlY3JldChwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgVlBDIEZsb3cgTG9ncyBidWNrZXQgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVZQQ0Zsb3dMb2dzKSB7XG4gICAgICB0aGlzLmZsb3dMb2dzQnVja2V0ID0gdGhpcy5jcmVhdGVWUENGbG93TG9nc0J1Y2tldChwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFZQQyB3aXRoIGNvbmZpZ3VyYWJsZSBJUHY2IGFuZCBOQVQgR2F0ZXdheSBvcHRpb25zXG4gICAgdGhpcy52cGMgPSB0aGlzLmNyZWF0ZVZwYyhwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgVlBDIEZsb3cgTG9ncyAoaWYgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlVlBDRmxvd0xvZ3MgJiYgdGhpcy5mbG93TG9nc0J1Y2tldCkge1xuICAgICAgdGhpcy5jcmVhdGVWUENGbG93TG9ncyhwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFNTTCBjZXJ0aWZpY2F0ZSAoaWYgSFRUUFMgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlSFRUUFMgJiYgcHJvcHMuZG9tYWluTmFtZSkge1xuICAgICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IHRoaXMuY3JlYXRlQ2VydGlmaWNhdGUocHJvcHMpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBFQ1IgUmVwb3NpdG9yeVxuICAgIHRoaXMucmVwb3NpdG9yeSA9IHRoaXMuY3JlYXRlRWNyUmVwb3NpdG9yeShwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgRUNTIENsdXN0ZXJcbiAgICB0aGlzLmNsdXN0ZXIgPSB0aGlzLmNyZWF0ZUVjc0NsdXN0ZXIocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIEZhcmdhdGUgU2VydmljZSB3aXRoIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICB0aGlzLmZhcmdhdGVTZXJ2aWNlID0gdGhpcy5jcmVhdGVGYXJnYXRlU2VydmljZShwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgV0FGIChpZiBlbmFibGVkKVxuICAgIGlmIChwcm9wcy5lbmFibGVXQUYpIHtcbiAgICAgIHRoaXMud2ViQUNMID0gdGhpcy5jcmVhdGVXQUYocHJvcHMpO1xuICAgICAgdGhpcy5hc3NvY2lhdGVXQUZXaXRoQUxCKCk7XG4gICAgfVxuXG4gICAgLy8gT3V0cHV0IGltcG9ydGFudCByZXNvdXJjZXNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMoKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBzZWNyZXRzbWFuYWdlci5TZWNyZXQge1xuICAgIHRyeSB7XG4gICAgICAvLyBMb2FkIHNlY3JldHMgZnJvbSBTT1BTXG4gICAgICBjb25zdCBzZWNyZXRzID0gdGhpcy5zZWNyZXRzTG9hZGVyLmxvYWRTZWNyZXRzV2l0aEZhbGxiYWNrKCk7XG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0XG4gICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsICdBcHBTZWNyZXRzJywge1xuICAgICAgICBzZWNyZXROYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1zZWNyZXRzYCxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBcHBsaWNhdGlvbiBzZWNyZXRzIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgICBzZWNyZXRTdHJpbmdUZW1wbGF0ZTogSlNPTi5zdHJpbmdpZnkoc2VjcmV0cyksXG4gICAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6ICdnZW5lcmF0ZWRfYXQnLFxuICAgICAgICAgIGluY2x1ZGVTcGFjZTogZmFsc2UsXG4gICAgICAgICAgZXhjbHVkZUNoYXJhY3RlcnM6ICdcIkAvXFxcXCdcbiAgICAgICAgfSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcblxuICAgICAgLy8gVGFnIHRoZSBzZWNyZXRcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICAgIGNkay5UYWdzLm9mKHNlY3JldCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLLVNPUFMnKTtcbiAgICAgIFxuICAgICAgcmV0dXJuIHNlY3JldDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS53YXJuKGBGYWlsZWQgdG8gbG9hZCBTT1BTIHNlY3JldHMsIGNyZWF0aW5nIGVtcHR5IHNlY3JldDogJHtlcnJvcn1gKTtcbiAgICAgIFxuICAgICAgLy8gRmFsbGJhY2s6IGNyZWF0ZSBlbXB0eSBzZWNyZXQgdGhhdCBjYW4gYmUgcG9wdWxhdGVkIGxhdGVyXG4gICAgICByZXR1cm4gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudCAoZW1wdHkgLSBwb3B1bGF0ZSBtYW51YWxseSlgLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVnBjKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWMyLlZwYyB7XG4gICAgY29uc3Qgc3VibmV0Q29uZmlndXJhdGlvbjogZWMyLlN1Ym5ldENvbmZpZ3VyYXRpb25bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ1B1YmxpYycsXG4gICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQyxcbiAgICAgICAgY2lkck1hc2s6IHByb3BzLnB1YmxpY1N1Ym5ldENpZHJNYXNrIHx8IDI0LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxuICAgICAgICBjaWRyTWFzazogcHJvcHMucHJpdmF0ZVN1Ym5ldENpZHJNYXNrIHx8IDI0LFxuICAgICAgfVxuICAgIF07XG5cbiAgICBjb25zdCB2cGNQcm9wczogZWMyLlZwY1Byb3BzID0ge1xuICAgICAgbWF4QXpzOiBwcm9wcy5tYXhBenMsXG4gICAgICBuYXRHYXRld2F5czogcHJvcHMuZW5hYmxlSEFOYXRHYXRld2F5cyA/IHByb3BzLm1heEF6cyA6IE1hdGgubWluKHByb3BzLm5hdEdhdGV3YXlzLCBwcm9wcy5tYXhBenMpLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbixcbiAgICAgIGVuYWJsZURuc0hvc3RuYW1lczogdHJ1ZSxcbiAgICAgIGVuYWJsZURuc1N1cHBvcnQ6IHRydWUsXG4gICAgICAvLyBDdXN0b20gSVB2NCBDSURSIGJsb2NrICh1c2luZyBuZXcgaXBBZGRyZXNzZXMgQVBJKVxuICAgICAgaXBBZGRyZXNzZXM6IGVjMi5JcEFkZHJlc3Nlcy5jaWRyKHByb3BzLnZwY0NpZHIgfHwgJzEwLjAuMC4wLzE2JyksXG4gICAgfTtcblxuICAgIC8vIEFkZCBJUHY2IHN1cHBvcnQgaWYgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVJUHY2KSB7XG4gICAgICAvLyBJUHY2IGNvbmZpZ3VyYXRpb25cbiAgICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdUZXN0QXBwVnBjJywge1xuICAgICAgICAuLi52cGNQcm9wcyxcbiAgICAgICAgLy8gSVB2NiB3aWxsIGJlIGFkZGVkIHZpYSBzZXBhcmF0ZSBjb25maWd1cmF0aW9uXG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIElQdjYgQ0lEUiBibG9jayB0byBWUENcbiAgICAgIGNvbnN0IGlwdjZDaWRyQmxvY2sgPSBuZXcgZWMyLkNmblZQQ0NpZHJCbG9jayh0aGlzLCAnSXB2NkNpZHJCbG9jaycsIHtcbiAgICAgICAgdnBjSWQ6IHZwYy52cGNJZCxcbiAgICAgICAgLy8gVXNlIGN1c3RvbSBJUHY2IENJRFIgaWYgcHJvdmlkZWQsIG90aGVyd2lzZSB1c2UgQW1hem9uLXByb3ZpZGVkXG4gICAgICAgIC4uLihwcm9wcy5pcHY2Q2lkckJsb2NrIFxuICAgICAgICAgID8geyBpcHY2Q2lkckJsb2NrOiBwcm9wcy5pcHY2Q2lkckJsb2NrIH1cbiAgICAgICAgICA6IHsgYW1hem9uUHJvdmlkZWRJcHY2Q2lkckJsb2NrOiB0cnVlIH1cbiAgICAgICAgKSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBDb25maWd1cmUgSVB2NiBmb3IgcHVibGljIHN1Ym5ldHNcbiAgICAgIHZwYy5wdWJsaWNTdWJuZXRzLmZvckVhY2goKHN1Ym5ldCwgaW5kZXgpID0+IHtcbiAgICAgICAgY29uc3QgY2ZuU3VibmV0ID0gc3VibmV0Lm5vZGUuZGVmYXVsdENoaWxkIGFzIGVjMi5DZm5TdWJuZXQ7XG4gICAgICAgIGNmblN1Ym5ldC5pcHY2Q2lkckJsb2NrID0gY2RrLkZuLnNlbGVjdChpbmRleCwgY2RrLkZuLmNpZHIoXG4gICAgICAgICAgY2RrLkZuLnNlbGVjdCgwLCB2cGMudnBjSXB2NkNpZHJCbG9ja3MpLFxuICAgICAgICAgIDI1NixcbiAgICAgICAgICAnNjQnXG4gICAgICAgICkpO1xuICAgICAgICBjZm5TdWJuZXQuYXNzaWduSXB2NkFkZHJlc3NPbkNyZWF0aW9uID0gdHJ1ZTtcbiAgICAgICAgY2ZuU3VibmV0LmFkZERlcGVuZGVuY3koaXB2NkNpZHJCbG9jayk7XG4gICAgICB9KTtcblxuICAgICAgLy8gQWRkIElQdjYgcm91dGUgZm9yIHB1YmxpYyBzdWJuZXRzXG4gICAgICB2cGMucHVibGljU3VibmV0cy5mb3JFYWNoKChzdWJuZXQsIGluZGV4KSA9PiB7XG4gICAgICAgIG5ldyBlYzIuQ2ZuUm91dGUodGhpcywgYElwdjZSb3V0ZS0ke2luZGV4fWAsIHtcbiAgICAgICAgICByb3V0ZVRhYmxlSWQ6IHN1Ym5ldC5yb3V0ZVRhYmxlLnJvdXRlVGFibGVJZCxcbiAgICAgICAgICBkZXN0aW5hdGlvbklwdjZDaWRyQmxvY2s6ICc6Oi8wJyxcbiAgICAgICAgICBnYXRld2F5SWQ6IHZwYy5pbnRlcm5ldEdhdGV3YXlJZCxcbiAgICAgICAgfSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHZwYztcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IGVjMi5WcGModGhpcywgJ1Rlc3RBcHBWcGMnLCB2cGNQcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjclJlcG9zaXRvcnkocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBlY3IuUmVwb3NpdG9yeSB7XG4gICAgY29uc3QgcmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnVGVzdEFwcFJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLFxuICAgICAgICAgIHRhZ1N0YXR1czogZWNyLlRhZ1N0YXR1cy5BTlksXG4gICAgICAgICAgbWF4SW1hZ2VDb3VudDogMTAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIHJldHVybiByZXBvc2l0b3J5O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3NDbHVzdGVyKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWNzLkNsdXN0ZXIge1xuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ1Rlc3RBcHBDbHVzdGVyJywge1xuICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgIGNsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIC8vIE5vdGU6IGNvbnRhaW5lckluc2lnaHRzIGlzIGRlcHJlY2F0ZWQgYnV0IHN0aWxsIGZ1bmN0aW9uYWxcbiAgICAgIC8vIEluIG5ld2VyIENESyB2ZXJzaW9ucywgdXNlIGNvbnRhaW5lckluc2lnaHRzOiBlY3MuQ29udGFpbmVySW5zaWdodHMuRU5IQU5DRURcbiAgICB9KTtcblxuICAgIHJldHVybiBjbHVzdGVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWN1cmVUYXNrRGVmaW5pdGlvbihwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcywgZXhlY3V0aW9uUm9sZTogaWFtLlJvbGUsIHRhc2tSb2xlOiBpYW0uUm9sZSwgbG9nR3JvdXA6IGxvZ3MuTG9nR3JvdXApOiBlY3MuVGFza0RlZmluaXRpb24gfCB1bmRlZmluZWQge1xuICAgIGlmICghcHJvcHMuZW5hYmxlTm9uUm9vdENvbnRhaW5lciAmJiAhcHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDsgLy8gVXNlIGRlZmF1bHQgdGFzayBkZWZpbml0aW9uXG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIGN1c3RvbSB0YXNrIGRlZmluaXRpb24gd2l0aCBzZWN1cml0eSBlbmhhbmNlbWVudHNcbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdTZWN1cmVUYXNrRGVmaW5pdGlvbicsIHtcbiAgICAgIGNwdTogcHJvcHMuY3B1LFxuICAgICAgbWVtb3J5TGltaXRNaUI6IHByb3BzLm1lbW9yeUxpbWl0TWlCLFxuICAgICAgZXhlY3V0aW9uUm9sZSxcbiAgICAgIHRhc2tSb2xlLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIGNvbnRhaW5lciB3aXRoIHNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcigndGVzdGFwcCcsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkodGhpcy5yZXBvc2l0b3J5LCAnbGF0ZXN0JyksXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAndGVzdGFwcCcsXG4gICAgICAgIGxvZ0dyb3VwLFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBSRVFVSVJFRF9TRVRUSU5HOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgRU5WSVJPTk1FTlQ6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgfSxcbiAgICAgIHNlY3JldHM6IHtcbiAgICAgICAgU0VDUkVUX0tFWTogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIodGhpcy5hcHBTZWNyZXRzLCAnYXBwbGljYXRpb24uc2VjcmV0X2tleScpLFxuICAgICAgfSxcbiAgICAgIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICAgICAgdXNlcjogcHJvcHMuZW5hYmxlTm9uUm9vdENvbnRhaW5lciA/ICcxMDAxOjEwMDEnIDogdW5kZWZpbmVkLCAvLyBOb24tcm9vdCB1c2VyXG4gICAgICByZWFkb25seVJvb3RGaWxlc3lzdGVtOiBwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtIHx8IGZhbHNlLFxuICAgICAgLy8gUmVzb3VyY2UgbGltaXRzIGZvciBzZWN1cml0eVxuICAgICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IE1hdGguZmxvb3IocHJvcHMubWVtb3J5TGltaXRNaUIgKiAwLjgpLCAvLyBSZXNlcnZlIDgwJSBvZiBtZW1vcnlcbiAgICB9KTtcblxuICAgIC8vIEFkZCBwb3J0IG1hcHBpbmdcbiAgICBjb250YWluZXIuYWRkUG9ydE1hcHBpbmdzKHtcbiAgICAgIGNvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0bXBmcyBtb3VudHMgaWYgcmVhZC1vbmx5IHJvb3QgZmlsZXN5c3RlbSBpcyBlbmFibGVkXG4gICAgaWYgKHByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICd0bXAtdm9sdW1lJyxcbiAgICAgICAgaG9zdDoge30sXG4gICAgICB9KTtcblxuICAgICAgY29udGFpbmVyLmFkZE1vdW50UG9pbnRzKHtcbiAgICAgICAgc291cmNlVm9sdW1lOiAndG1wLXZvbHVtZScsXG4gICAgICAgIGNvbnRhaW5lclBhdGg6ICcvdG1wJyxcbiAgICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIEFkZCBsb2dzIHZvbHVtZVxuICAgICAgdGFza0RlZmluaXRpb24uYWRkVm9sdW1lKHtcbiAgICAgICAgbmFtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgaG9zdDoge30sXG4gICAgICB9KTtcblxuICAgICAgY29udGFpbmVyLmFkZE1vdW50UG9pbnRzKHtcbiAgICAgICAgc291cmNlVm9sdW1lOiAnbG9ncy12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL2FwcC9sb2dzJyxcbiAgICAgICAgcmVhZE9ubHk6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRhc2tEZWZpbml0aW9uO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVGYXJnYXRlU2VydmljZShwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjc19wYXR0ZXJucy5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlZEZhcmdhdGVTZXJ2aWNlIHtcbiAgICAvLyBDcmVhdGUgQ2xvdWRXYXRjaCBMb2cgR3JvdXBcbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdUZXN0QXBwTG9nR3JvdXAnLCB7XG4gICAgICBsb2dHcm91cE5hbWU6IGAvYXdzL2Vjcy90ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIHJldGVudGlvbjogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgPyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAgICAgIDogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSB0YXNrIGV4ZWN1dGlvbiByb2xlXG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGVzdEFwcEV4ZWN1dGlvblJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BbWF6b25FQ1NUYXNrRXhlY3V0aW9uUm9sZVBvbGljeScpLFxuICAgICAgXSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIEVDUkFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLFxuICAgICAgICAgICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSB0YXNrIHJvbGUgd2l0aCBzZWNyZXRzIGFjY2Vzc1xuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUZXN0QXBwVGFza1JvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIENsb3VkV2F0Y2hMb2dzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgICAgICAgJ2xvZ3M6UHV0TG9nRXZlbnRzJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICAgIFNlY3JldHNNYW5hZ2VyQWNjZXNzOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5hcHBTZWNyZXRzLnNlY3JldEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgc2VjdXJlIHRhc2sgZGVmaW5pdGlvbiBpZiBzZWN1cml0eSBlbmhhbmNlbWVudHMgYXJlIGVuYWJsZWRcbiAgICBjb25zdCBzZWN1cmVUYXNrRGVmaW5pdGlvbiA9IHRoaXMuY3JlYXRlU2VjdXJlVGFza0RlZmluaXRpb24ocHJvcHMsIGV4ZWN1dGlvblJvbGUsIHRhc2tSb2xlLCBsb2dHcm91cCk7XG5cbiAgICBjb25zdCBmYXJnYXRlU2VydmljZVByb3BzOiBhbnkgPSB7XG4gICAgICBjbHVzdGVyOiB0aGlzLmNsdXN0ZXIsXG4gICAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICBkZXNpcmVkQ291bnQ6IHByb3BzLmRlc2lyZWRDb3VudCxcbiAgICAgIHB1YmxpY0xvYWRCYWxhbmNlcjogdHJ1ZSxcbiAgICAgIGxpc3RlbmVyUG9ydDogcHJvcHMuZW5hYmxlSFRUUFMgPyA0NDMgOiA4MCxcbiAgICAgIHByb3RvY29sOiBwcm9wcy5lbmFibGVIVFRQUyBcbiAgICAgICAgPyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUFMgXG4gICAgICAgIDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICBjZXJ0aWZpY2F0ZTogdGhpcy5jZXJ0aWZpY2F0ZSxcbiAgICAgIGRvbWFpblpvbmU6IHVuZGVmaW5lZCwgLy8gQ3VzdG9tIGRvbWFpbiB6b25lIHdvdWxkIGJlIGNvbmZpZ3VyZWQgc2VwYXJhdGVseVxuICAgICAgZG9tYWluTmFtZTogdW5kZWZpbmVkLCAvLyBEb21haW4gbmFtZSByZXF1aXJlcyBkb21haW5ab25lIGNvbmZpZ3VyYXRpb25cbiAgICAgIHJlZGlyZWN0SFRUUDogcHJvcHMuZW5hYmxlSFRUUFMsIC8vIFJlZGlyZWN0IEhUVFAgdG8gSFRUUFMgd2hlbiBIVFRQUyBpcyBlbmFibGVkXG4gICAgICBhc3NpZ25QdWJsaWNJcDogdHJ1ZSxcbiAgICB9O1xuXG4gICAgLy8gVXNlIHNlY3VyZSB0YXNrIGRlZmluaXRpb24gaWYgYXZhaWxhYmxlLCBvdGhlcndpc2UgdXNlIHN0YW5kYXJkIHRhc2tJbWFnZU9wdGlvbnNcbiAgICBpZiAoc2VjdXJlVGFza0RlZmluaXRpb24pIHtcbiAgICAgIGZhcmdhdGVTZXJ2aWNlUHJvcHMudGFza0RlZmluaXRpb24gPSBzZWN1cmVUYXNrRGVmaW5pdGlvbjtcbiAgICB9IGVsc2Uge1xuICAgICAgZmFyZ2F0ZVNlcnZpY2VQcm9wcy5jcHUgPSBwcm9wcy5jcHU7XG4gICAgICBmYXJnYXRlU2VydmljZVByb3BzLm1lbW9yeUxpbWl0TWlCID0gcHJvcHMubWVtb3J5TGltaXRNaUI7XG4gICAgICBmYXJnYXRlU2VydmljZVByb3BzLnRhc2tJbWFnZU9wdGlvbnMgPSB7XG4gICAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkodGhpcy5yZXBvc2l0b3J5LCAnbGF0ZXN0JyksXG4gICAgICAgIGNvbnRhaW5lck5hbWU6ICd0ZXN0YXBwJyxcbiAgICAgICAgY29udGFpbmVyUG9ydDogODAwMCxcbiAgICAgICAgZXhlY3V0aW9uUm9sZSxcbiAgICAgICAgdGFza1JvbGUsXG4gICAgICAgIGxvZ0RyaXZlcjogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgICAgc3RyZWFtUHJlZml4OiAndGVzdGFwcCcsXG4gICAgICAgICAgbG9nR3JvdXAsXG4gICAgICAgIH0pLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIFJFUVVJUkVEX1NFVFRJTkc6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICB9LFxuICAgICAgICBzZWNyZXRzOiB7XG4gICAgICAgICAgLy8gSW5kaXZpZHVhbCBzZWNyZXRzIGZyb20gQVdTIFNlY3JldHMgTWFuYWdlclxuICAgICAgICAgIFNFQ1JFVF9LRVk6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHRoaXMuYXBwU2VjcmV0cywgJ2FwcGxpY2F0aW9uLnNlY3JldF9rZXknKSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgZmFyZ2F0ZVNlcnZpY2UgPSBuZXcgZWNzX3BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ1Rlc3RBcHBTZXJ2aWNlJywgZmFyZ2F0ZVNlcnZpY2VQcm9wcyk7XG5cbiAgICAvLyBDb25maWd1cmUgaGVhbHRoIGNoZWNrXG4gICAgZmFyZ2F0ZVNlcnZpY2UudGFyZ2V0R3JvdXAuY29uZmlndXJlSGVhbHRoQ2hlY2soe1xuICAgICAgcGF0aDogJy9oZWFsdGgvJyxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlByb3RvY29sLkhUVFAsXG4gICAgICBwb3J0OiAnODAwMCcsXG4gICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJlIGF1dG8gc2NhbGluZ1xuICAgIGNvbnN0IHNjYWxhYmxlVGFyZ2V0ID0gZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHk6IHByb3BzLmRlc2lyZWRDb3VudCxcbiAgICAgIG1heENhcGFjaXR5OiBwcm9wcy5kZXNpcmVkQ291bnQgKiAzLFxuICAgIH0pO1xuXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbkNwdVV0aWxpemF0aW9uKCdDcHVTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiA3MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICB9KTtcblxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25NZW1vcnlVdGlsaXphdGlvbignTWVtb3J5U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogODAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgfSk7XG5cbiAgICAvLyBTZWN1cml0eSBncm91cCBmb3IgdGhlIHNlcnZpY2VcbiAgICBmYXJnYXRlU2VydmljZS5zZXJ2aWNlLmNvbm5lY3Rpb25zLnNlY3VyaXR5R3JvdXBzLmZvckVhY2goc2cgPT4ge1xuICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgICAgZWMyLlBvcnQudGNwKDgwMDApLFxuICAgICAgICAnQWxsb3cgSFRUUCB0cmFmZmljIGZyb20gQUxCJ1xuICAgICAgKTtcblxuICAgICAgaWYgKHByb3BzLmVuYWJsZUlQdjYpIHtcbiAgICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgICAgZWMyLlBlZXIuYW55SXB2NigpLFxuICAgICAgICAgIGVjMi5Qb3J0LnRjcCg4MDAwKSxcbiAgICAgICAgICAnQWxsb3cgSFRUUCB0cmFmZmljIGZyb20gQUxCIChJUHY2KSdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBmYXJnYXRlU2VydmljZTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVlBDRmxvd0xvZ3NCdWNrZXQocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBzMy5CdWNrZXQge1xuICAgIGNvbnN0IGJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ1ZQQ0Zsb3dMb2dzQnVja2V0Jywge1xuICAgICAgYnVja2V0TmFtZTogYHRlc3RhcHAtdnBjLWZsb3ctbG9ncy0ke3Byb3BzLmVudmlyb25tZW50fS0ke3RoaXMuYWNjb3VudH1gLFxuICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIHZlcnNpb25lZDogZmFsc2UsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdEZWxldGVPbGRGbG93TG9ncycsXG4gICAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICBleHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cyhwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gOTAgOiAzMCksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIFRhZyB0aGUgYnVja2V0XG4gICAgY2RrLlRhZ3Mub2YoYnVja2V0KS5hZGQoJ1B1cnBvc2UnLCAnVlBDLUZsb3ctTG9ncycpO1xuICAgIGNkay5UYWdzLm9mKGJ1Y2tldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBcbiAgICByZXR1cm4gYnVja2V0O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVWUENGbG93TG9ncyhwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5mbG93TG9nc0J1Y2tldCkgcmV0dXJuO1xuXG4gICAgLy8gQ3JlYXRlIFZQQyBGbG93IExvZ3NcbiAgICBuZXcgZWMyLkZsb3dMb2codGhpcywgJ1ZQQ0Zsb3dMb2cnLCB7XG4gICAgICByZXNvdXJjZVR5cGU6IGVjMi5GbG93TG9nUmVzb3VyY2VUeXBlLmZyb21WcGModGhpcy52cGMpLFxuICAgICAgZGVzdGluYXRpb246IGVjMi5GbG93TG9nRGVzdGluYXRpb24udG9TMyh0aGlzLmZsb3dMb2dzQnVja2V0LCAndnBjLWZsb3ctbG9ncy8nKSxcbiAgICAgIHRyYWZmaWNUeXBlOiBlYzIuRmxvd0xvZ1RyYWZmaWNUeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBGbG93IExvZyBmb3IgaW5kaXZpZHVhbCBzdWJuZXRzIChtb3JlIGdyYW51bGFyKVxuICAgIHRoaXMudnBjLnByaXZhdGVTdWJuZXRzLmZvckVhY2goKHN1Ym5ldCwgaW5kZXgpID0+IHtcbiAgICAgIG5ldyBlYzIuRmxvd0xvZyh0aGlzLCBgUHJpdmF0ZVN1Ym5ldEZsb3dMb2cke2luZGV4fWAsIHtcbiAgICAgICAgcmVzb3VyY2VUeXBlOiBlYzIuRmxvd0xvZ1Jlc291cmNlVHlwZS5mcm9tU3VibmV0KHN1Ym5ldCksXG4gICAgICAgIGRlc3RpbmF0aW9uOiBlYzIuRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvUzModGhpcy5mbG93TG9nc0J1Y2tldCEsIGBwcml2YXRlLXN1Ym5ldHMvc3VibmV0LSR7aW5kZXh9L2ApLFxuICAgICAgICB0cmFmZmljVHlwZTogZWMyLkZsb3dMb2dUcmFmZmljVHlwZS5BTEwsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ2VydGlmaWNhdGUocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBjZXJ0aWZpY2F0ZW1hbmFnZXIuSUNlcnRpZmljYXRlIHtcbiAgICBpZiAoIXByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRG9tYWluIG5hbWUgaXMgcmVxdWlyZWQgd2hlbiBIVFRQUyBpcyBlbmFibGVkJyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFNTTCBjZXJ0aWZpY2F0ZVxuICAgIHJldHVybiBuZXcgY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlKHRoaXMsICdTU0xDZXJ0aWZpY2F0ZScsIHtcbiAgICAgIGRvbWFpbk5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICBzdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogW2AqLiR7cHJvcHMuZG9tYWluTmFtZX1gXSxcbiAgICAgIHZhbGlkYXRpb246IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucygpLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVXQUYocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiB3YWZ2Mi5DZm5XZWJBQ0wge1xuICAgIC8vIENyZWF0ZSBJUCBzZXRzIGZvciByYXRlIGxpbWl0aW5nIGFuZCBibG9ja2luZ1xuICAgIGNvbnN0IGlwU2V0QWxsb3dMaXN0ID0gbmV3IHdhZnYyLkNmbklQU2V0KHRoaXMsICdJUFNldEFsbG93TGlzdCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFsbG93LWxpc3RgLFxuICAgICAgZGVzY3JpcHRpb246ICdBbGxvd2VkIElQIGFkZHJlc3NlcycsXG4gICAgICBpcEFkZHJlc3NWZXJzaW9uOiAnSVBWNCcsXG4gICAgICBhZGRyZXNzZXM6IFtdLCAvLyBBZGQgeW91ciBhbGxvd2VkIElQcyBoZXJlXG4gICAgICBzY29wZTogJ1JFR0lPTkFMJyxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBXQUYgV2ViIEFDTFxuICAgIGNvbnN0IHdlYkFDTCA9IG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcywgJ1dlYkFDTCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgZGVzY3JpcHRpb246IGBXQUYgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICBkZWZhdWx0QWN0aW9uOiB7IGFsbG93OiB7fSB9LFxuICAgICAgXG4gICAgICBydWxlczogW1xuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIENvcmUgUnVsZSBTZXRcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDEsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0NvbW1vblJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFxuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIEtub3duIEJhZCBJbnB1dHNcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMixcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnS25vd25CYWRJbnB1dHNSdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gUmF0ZSBsaW1pdGluZyBydWxlXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDMsXG4gICAgICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnUmF0ZUxpbWl0UnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIHJhdGVCYXNlZFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBsaW1pdDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDIwMDAgOiAxMDAwLFxuICAgICAgICAgICAgICBhZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIEdlb2dyYXBoaWMgcmVzdHJpY3Rpb24gKG9wdGlvbmFsIC0gY2FuIGJlIGNvbmZpZ3VyZWQgcGVyIGVudmlyb25tZW50KVxuICAgICAgICAuLi4ocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IFt7XG4gICAgICAgICAgbmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDQsXG4gICAgICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnR2VvUmVzdHJpY3Rpb25SdWxlTWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgZ2VvTWF0Y2hTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgY291bnRyeUNvZGVzOiBbJ0NOJywgJ1JVJywgJ0tQJ10sIC8vIEJsb2NrIHNwZWNpZmljIGNvdW50cmllc1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSA6IFtdKSxcbiAgICAgIF0sXG5cbiAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICBtZXRyaWNOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS13ZWItYWNsYCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBUYWcgdGhlIFdlYiBBQ0xcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ1B1cnBvc2UnLCAnRERvUy1Qcm90ZWN0aW9uJyk7XG5cbiAgICByZXR1cm4gd2ViQUNMO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3NvY2lhdGVXQUZXaXRoQUxCKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy53ZWJBQ0wpIHJldHVybjtcblxuICAgIC8vIEFzc29jaWF0ZSBXQUYgd2l0aCBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyXG4gICAgbmV3IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uKHRoaXMsICdXZWJBQ0xBc3NvY2lhdGlvbicsIHtcbiAgICAgIHJlc291cmNlQXJuOiB0aGlzLmZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICB3ZWJBY2xBcm46IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMoKTogdm9pZCB7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1ZwY0lkJywge1xuICAgICAgdmFsdWU6IHRoaXMudnBjLnZwY0lkLFxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVZwY0lkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsdXN0ZXJOYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJETlNgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlcnZpY2VOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5zZXJ2aWNlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VydmljZU5hbWVgLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcHJvdG9jb2wgPSB0aGlzLmNlcnRpZmljYXRlID8gJ2h0dHBzJyA6ICdodHRwJztcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICB2YWx1ZTogYCR7cHJvdG9jb2x9Oi8vJHt0aGlzLmZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFVSTCcsXG4gICAgfSk7XG5cbiAgICAvLyBTZWN1cml0eS1yZWxhdGVkIG91dHB1dHMgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMud2ViQUNMKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy53ZWJBQ0wuYXR0ckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmZsb3dMb2dzQnVja2V0KSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRmxvd0xvZ3NCdWNrZXROYW1lJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5mbG93TG9nc0J1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1ZQQyBGbG93IExvZ3MgUzMgQnVja2V0IE5hbWUnLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tRmxvd0xvZ3NCdWNrZXROYW1lYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2VydGlmaWNhdGVBcm4nLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLmNlcnRpZmljYXRlLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1NTTCBDZXJ0aWZpY2F0ZSBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2VydGlmaWNhdGVBcm5gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59Il19