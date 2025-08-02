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
            domainName: props.domainName,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkRBQTZEO0FBQzdELDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsMkNBQTJDO0FBQzNDLGlGQUFpRjtBQUNqRixpRUFBaUU7QUFDakUsK0NBQStDO0FBQy9DLHlDQUF5QztBQUN6Qyx5RUFBeUU7QUFFekUscURBQWlEO0FBMkJqRCxNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBV3ZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0M7UUFDOUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNEJBQTRCO1FBQzVCLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUxRCw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFekQsMkNBQTJDO1FBQzNDLElBQUksS0FBSyxDQUFDLGlCQUFpQixFQUFFO1lBQzNCLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQzNEO1FBRUQsNERBQTREO1FBQzVELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVqQyxvQ0FBb0M7UUFDcEMsSUFBSSxLQUFLLENBQUMsaUJBQWlCLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRTtZQUNsRCxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDL0I7UUFFRCw0Q0FBNEM7UUFDNUMsSUFBSSxLQUFLLENBQUMsV0FBVyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUU7WUFDekMsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDbEQ7UUFFRCx3QkFBd0I7UUFDeEIsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsbUJBQW1CLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFbEQscUJBQXFCO1FBQ3JCLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRTVDLHdEQUF3RDtRQUN4RCxJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUV2RCwwQkFBMEI7UUFDMUIsSUFBSSxLQUFLLENBQUMsU0FBUyxFQUFFO1lBQ25CLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsQ0FBQztTQUM1QjtRQUVELDZCQUE2QjtRQUM3QixJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7SUFDdkIsQ0FBQztJQUVPLDBCQUEwQixDQUFDLEtBQXNDO1FBQ3ZFLElBQUk7WUFDRix5QkFBeUI7WUFDekIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyx1QkFBdUIsRUFBRSxDQUFDO1lBRTdELGdDQUFnQztZQUNoQyxNQUFNLE1BQU0sR0FBRyxJQUFJLGNBQWMsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDM0QsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDLFdBQVcsVUFBVTtnQkFDbEQsV0FBVyxFQUFFLG1DQUFtQyxLQUFLLENBQUMsV0FBVyxjQUFjO2dCQUMvRSxvQkFBb0IsRUFBRTtvQkFDcEIsb0JBQW9CLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUM7b0JBQzdDLGlCQUFpQixFQUFFLGNBQWM7b0JBQ2pDLFlBQVksRUFBRSxLQUFLO29CQUNuQixpQkFBaUIsRUFBRSxPQUFPO2lCQUMzQjtnQkFDRCxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZO29CQUMvQyxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxNQUFNO29CQUMxQixDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO2FBQzlCLENBQUMsQ0FBQztZQUVILGlCQUFpQjtZQUNqQixHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUMxRCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLFVBQVUsQ0FBQyxDQUFDO1lBRWpELE9BQU8sTUFBTSxDQUFDO1NBQ2Y7UUFBQyxPQUFPLEtBQUssRUFBRTtZQUNkLE9BQU8sQ0FBQyxJQUFJLENBQUMsdURBQXVELEtBQUssRUFBRSxDQUFDLENBQUM7WUFFN0UsNERBQTREO1lBQzVELE9BQU8sSUFBSSxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7Z0JBQ25ELFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQyxXQUFXLFVBQVU7Z0JBQ2xELFdBQVcsRUFBRSxtQ0FBbUMsS0FBSyxDQUFDLFdBQVcsMENBQTBDO2dCQUMzRyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZO29CQUMvQyxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxNQUFNO29CQUMxQixDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO2FBQzlCLENBQUMsQ0FBQztTQUNKO0lBQ0gsQ0FBQztJQUVPLFNBQVMsQ0FBQyxLQUFzQztRQUN0RCxNQUFNLG1CQUFtQixHQUE4QjtZQUNyRDtnQkFDRSxJQUFJLEVBQUUsUUFBUTtnQkFDZCxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNO2dCQUNqQyxRQUFRLEVBQUUsS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUU7YUFDM0M7WUFDRDtnQkFDRSxJQUFJLEVBQUUsU0FBUztnQkFDZixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7Z0JBQzlDLFFBQVEsRUFBRSxLQUFLLENBQUMscUJBQXFCLElBQUksRUFBRTthQUM1QztTQUNGLENBQUM7UUFFRixNQUFNLFFBQVEsR0FBaUI7WUFDN0IsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNO1lBQ3BCLFdBQVcsRUFBRSxLQUFLLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLFdBQVcsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDO1lBQ2pHLG1CQUFtQjtZQUNuQixrQkFBa0IsRUFBRSxJQUFJO1lBQ3hCLGdCQUFnQixFQUFFLElBQUk7WUFDdEIscURBQXFEO1lBQ3JELFdBQVcsRUFBRSxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxJQUFJLGFBQWEsQ0FBQztTQUNsRSxDQUFDO1FBRUYsOEJBQThCO1FBQzlCLElBQUksS0FBSyxDQUFDLFVBQVUsRUFBRTtZQUNwQixxQkFBcUI7WUFDckIsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7Z0JBQzFDLEdBQUcsUUFBUTtnQkFDWCxnREFBZ0Q7YUFDakQsQ0FBQyxDQUFDO1lBRUgsNkJBQTZCO1lBQzdCLE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO2dCQUNuRSxLQUFLLEVBQUUsR0FBRyxDQUFDLEtBQUs7Z0JBQ2hCLGtFQUFrRTtnQkFDbEUsR0FBRyxDQUFDLEtBQUssQ0FBQyxhQUFhO29CQUNyQixDQUFDLENBQUMsRUFBRSxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWEsRUFBRTtvQkFDeEMsQ0FBQyxDQUFDLEVBQUUsMkJBQTJCLEVBQUUsSUFBSSxFQUFFLENBQ3hDO2FBQ0YsQ0FBQyxDQUFDO1lBRUgsb0NBQW9DO1lBQ3BDLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxFQUFFO2dCQUMxQyxNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFlBQTZCLENBQUM7Z0JBQzVELFNBQVMsQ0FBQyxhQUFhLEdBQUcsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUN4RCxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLGlCQUFpQixDQUFDLEVBQ3ZDLEdBQUcsRUFDSCxJQUFJLENBQ0wsQ0FBQyxDQUFDO2dCQUNILFNBQVMsQ0FBQywyQkFBMkIsR0FBRyxJQUFJLENBQUM7Z0JBQzdDLFNBQVMsQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLENBQUM7WUFDekMsQ0FBQyxDQUFDLENBQUM7WUFFSCxvQ0FBb0M7WUFDcEMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEVBQUU7Z0JBQzFDLElBQUksR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsYUFBYSxLQUFLLEVBQUUsRUFBRTtvQkFDM0MsWUFBWSxFQUFFLE1BQU0sQ0FBQyxVQUFVLENBQUMsWUFBWTtvQkFDNUMsd0JBQXdCLEVBQUUsTUFBTTtvQkFDaEMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxpQkFBaUI7aUJBQ2pDLENBQUMsQ0FBQztZQUNMLENBQUMsQ0FBQyxDQUFDO1lBRUgsT0FBTyxHQUFHLENBQUM7U0FDWjtRQUVELE9BQU8sSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDbkQsQ0FBQztJQUVPLG1CQUFtQixDQUFDLEtBQXNDO1FBQ2hFLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDL0QsY0FBYyxFQUFFLFdBQVcsS0FBSyxDQUFDLFdBQVcsRUFBRTtZQUM5QyxlQUFlLEVBQUUsSUFBSTtZQUNyQixjQUFjLEVBQUU7Z0JBQ2Q7b0JBQ0UsWUFBWSxFQUFFLENBQUM7b0JBQ2YsV0FBVyxFQUFFLHFCQUFxQjtvQkFDbEMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxTQUFTLENBQUMsR0FBRztvQkFDNUIsYUFBYSxFQUFFLEVBQUU7aUJBQ2xCO2FBQ0Y7WUFDRCxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZO2dCQUMvQyxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxNQUFNO2dCQUMxQixDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1NBQzlCLENBQUMsQ0FBQztRQUVILE9BQU8sVUFBVSxDQUFDO0lBQ3BCLENBQUM7SUFFTyxnQkFBZ0IsQ0FBQyxLQUFzQztRQUM3RCxNQUFNLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3RELEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLFdBQVcsRUFBRSxtQkFBbUIsS0FBSyxDQUFDLFdBQVcsRUFBRTtZQUNuRCw2REFBNkQ7WUFDN0QsK0VBQStFO1NBQ2hGLENBQUMsQ0FBQztRQUVILE9BQU8sT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFFTywwQkFBMEIsQ0FBQyxLQUFzQyxFQUFFLGFBQXVCLEVBQUUsUUFBa0IsRUFBRSxRQUF1QjtRQUM3SSxJQUFJLENBQUMsS0FBSyxDQUFDLHNCQUFzQixJQUFJLENBQUMsS0FBSyxDQUFDLDRCQUE0QixFQUFFO1lBQ3hFLE9BQU8sU0FBUyxDQUFDLENBQUMsOEJBQThCO1NBQ2pEO1FBRUQsMkRBQTJEO1FBQzNELE1BQU0sY0FBYyxHQUFHLElBQUksR0FBRyxDQUFDLHFCQUFxQixDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUNqRixHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxjQUFjLEVBQUUsS0FBSyxDQUFDLGNBQWM7WUFDcEMsYUFBYTtZQUNiLFFBQVE7U0FDVCxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsTUFBTSxTQUFTLEdBQUcsY0FBYyxDQUFDLFlBQVksQ0FBQyxTQUFTLEVBQUU7WUFDdkQsS0FBSyxFQUFFLEdBQUcsQ0FBQyxjQUFjLENBQUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxRQUFRLENBQUM7WUFDdEUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDO2dCQUM5QixZQUFZLEVBQUUsU0FBUztnQkFDdkIsUUFBUTthQUNULENBQUM7WUFDRixXQUFXLEVBQUU7Z0JBQ1gsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLFdBQVc7Z0JBQ25DLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztnQkFDOUIsa0JBQWtCLEVBQUUsSUFBSSxDQUFDLE1BQU07YUFDaEM7WUFDRCxPQUFPLEVBQUU7Z0JBQ1AsVUFBVSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSx3QkFBd0IsQ0FBQzthQUNyRjtZQUNELHdCQUF3QjtZQUN4QixJQUFJLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFNBQVM7WUFDNUQsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLDRCQUE0QixJQUFJLEtBQUs7WUFDbkUsK0JBQStCO1lBQy9CLG9CQUFvQixFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLGNBQWMsR0FBRyxHQUFHLENBQUMsRUFBRSx3QkFBd0I7U0FDdkYsQ0FBQyxDQUFDO1FBRUgsbUJBQW1CO1FBQ25CLFNBQVMsQ0FBQyxlQUFlLENBQUM7WUFDeEIsYUFBYSxFQUFFLElBQUk7WUFDbkIsUUFBUSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsR0FBRztTQUMzQixDQUFDLENBQUM7UUFFSCwyREFBMkQ7UUFDM0QsSUFBSSxLQUFLLENBQUMsNEJBQTRCLEVBQUU7WUFDdEMsY0FBYyxDQUFDLFNBQVMsQ0FBQztnQkFDdkIsSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLElBQUksRUFBRSxFQUFFO2FBQ1QsQ0FBQyxDQUFDO1lBRUgsU0FBUyxDQUFDLGNBQWMsQ0FBQztnQkFDdkIsWUFBWSxFQUFFLFlBQVk7Z0JBQzFCLGFBQWEsRUFBRSxNQUFNO2dCQUNyQixRQUFRLEVBQUUsS0FBSzthQUNoQixDQUFDLENBQUM7WUFFSCxrQkFBa0I7WUFDbEIsY0FBYyxDQUFDLFNBQVMsQ0FBQztnQkFDdkIsSUFBSSxFQUFFLGFBQWE7Z0JBQ25CLElBQUksRUFBRSxFQUFFO2FBQ1QsQ0FBQyxDQUFDO1lBRUgsU0FBUyxDQUFDLGNBQWMsQ0FBQztnQkFDdkIsWUFBWSxFQUFFLGFBQWE7Z0JBQzNCLGFBQWEsRUFBRSxXQUFXO2dCQUMxQixRQUFRLEVBQUUsS0FBSzthQUNoQixDQUFDLENBQUM7U0FDSjtRQUVELE9BQU8sY0FBYyxDQUFDO0lBQ3hCLENBQUM7SUFFTyxvQkFBb0IsQ0FBQyxLQUFzQztRQUNqRSw4QkFBOEI7UUFDOUIsTUFBTSxRQUFRLEdBQUcsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUMxRCxZQUFZLEVBQUUsb0JBQW9CLEtBQUssQ0FBQyxXQUFXLEVBQUU7WUFDckQsU0FBUyxFQUFFLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWTtnQkFDM0MsQ0FBQyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUztnQkFDOUIsQ0FBQyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUTtZQUMvQixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1NBQ3pDLENBQUMsQ0FBQztRQUVILDZCQUE2QjtRQUM3QixNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQy9ELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyx5QkFBeUIsQ0FBQztZQUM5RCxlQUFlLEVBQUU7Z0JBQ2YsR0FBRyxDQUFDLGFBQWEsQ0FBQyx3QkFBd0IsQ0FBQywrQ0FBK0MsQ0FBQzthQUM1RjtZQUNELGNBQWMsRUFBRTtnQkFDZCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDO29CQUNoQyxVQUFVLEVBQUU7d0JBQ1YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDOzRCQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLOzRCQUN4QixPQUFPLEVBQUU7Z0NBQ1AsMkJBQTJCO2dDQUMzQixpQ0FBaUM7Z0NBQ2pDLDRCQUE0QjtnQ0FDNUIsbUJBQW1COzZCQUNwQjs0QkFDRCxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7eUJBQ2pCLENBQUM7cUJBQ0g7aUJBQ0YsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsdUNBQXVDO1FBQ3ZDLE1BQU0sUUFBUSxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDckQsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHlCQUF5QixDQUFDO1lBQzlELGNBQWMsRUFBRTtnQkFDZCxjQUFjLEVBQUUsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDO29CQUNyQyxVQUFVLEVBQUU7d0JBQ1YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDOzRCQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLOzRCQUN4QixPQUFPLEVBQUU7Z0NBQ1Asc0JBQXNCO2dDQUN0QixtQkFBbUI7NkJBQ3BCOzRCQUNELFNBQVMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUM7eUJBQ2xDLENBQUM7cUJBQ0g7aUJBQ0YsQ0FBQztnQkFDRixvQkFBb0IsRUFBRSxJQUFJLEdBQUcsQ0FBQyxjQUFjLENBQUM7b0JBQzNDLFVBQVUsRUFBRTt3QkFDVixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7NEJBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7NEJBQ3hCLE9BQU8sRUFBRTtnQ0FDUCwrQkFBK0I7Z0NBQy9CLCtCQUErQjs2QkFDaEM7NEJBQ0QsU0FBUyxFQUFFLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUM7eUJBQ3ZDLENBQUM7cUJBQ0g7aUJBQ0YsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDO1FBRUgscUVBQXFFO1FBQ3JFLE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxDQUFDLDBCQUEwQixDQUFDLEtBQUssRUFBRSxhQUFhLEVBQUUsUUFBUSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBRXZHLE1BQU0sbUJBQW1CLEdBQVE7WUFDL0IsT0FBTyxFQUFFLElBQUksQ0FBQyxPQUFPO1lBQ3JCLFdBQVcsRUFBRSxtQkFBbUIsS0FBSyxDQUFDLFdBQVcsRUFBRTtZQUNuRCxZQUFZLEVBQUUsS0FBSyxDQUFDLFlBQVk7WUFDaEMsa0JBQWtCLEVBQUUsSUFBSTtZQUN4QixZQUFZLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFO1lBQzFDLFFBQVEsRUFBRSxLQUFLLENBQUMsV0FBVztnQkFDekIsQ0FBQyxDQUFDLHNCQUFzQixDQUFDLG1CQUFtQixDQUFDLEtBQUs7Z0JBQ2xELENBQUMsQ0FBQyxzQkFBc0IsQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJO1lBQ25ELFdBQVcsRUFBRSxJQUFJLENBQUMsV0FBVztZQUM3QixVQUFVLEVBQUUsU0FBUztZQUNyQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsWUFBWSxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQy9CLGNBQWMsRUFBRSxJQUFJO1NBQ3JCLENBQUM7UUFFRixtRkFBbUY7UUFDbkYsSUFBSSxvQkFBb0IsRUFBRTtZQUN4QixtQkFBbUIsQ0FBQyxjQUFjLEdBQUcsb0JBQW9CLENBQUM7U0FDM0Q7YUFBTTtZQUNMLG1CQUFtQixDQUFDLEdBQUcsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDO1lBQ3BDLG1CQUFtQixDQUFDLGNBQWMsR0FBRyxLQUFLLENBQUMsY0FBYyxDQUFDO1lBQzFELG1CQUFtQixDQUFDLGdCQUFnQixHQUFHO2dCQUNyQyxLQUFLLEVBQUUsR0FBRyxDQUFDLGNBQWMsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLFFBQVEsQ0FBQztnQkFDdEUsYUFBYSxFQUFFLFNBQVM7Z0JBQ3hCLGFBQWEsRUFBRSxJQUFJO2dCQUNuQixhQUFhO2dCQUNiLFFBQVE7Z0JBQ1IsU0FBUyxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDO29CQUNoQyxZQUFZLEVBQUUsU0FBUztvQkFDdkIsUUFBUTtpQkFDVCxDQUFDO2dCQUNGLFdBQVcsRUFBRTtvQkFDWCxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsV0FBVztvQkFDbkMsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO29CQUM5QixrQkFBa0IsRUFBRSxJQUFJLENBQUMsTUFBTTtpQkFDaEM7Z0JBQ0QsT0FBTyxFQUFFO29CQUNQLDhDQUE4QztvQkFDOUMsVUFBVSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSx3QkFBd0IsQ0FBQztpQkFDckY7YUFDRixDQUFDO1NBQ0g7UUFFRCxNQUFNLGNBQWMsR0FBRyxJQUFJLFlBQVksQ0FBQyxxQ0FBcUMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsbUJBQW1CLENBQUMsQ0FBQztRQUUzSCx5QkFBeUI7UUFDekIsY0FBYyxDQUFDLFdBQVcsQ0FBQyxvQkFBb0IsQ0FBQztZQUM5QyxJQUFJLEVBQUUsVUFBVTtZQUNoQixRQUFRLEVBQUUsc0JBQXNCLENBQUMsUUFBUSxDQUFDLElBQUk7WUFDOUMsSUFBSSxFQUFFLE1BQU07WUFDWixnQkFBZ0IsRUFBRSxLQUFLO1lBQ3ZCLFFBQVEsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDbEMsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztZQUNoQyxxQkFBcUIsRUFBRSxDQUFDO1lBQ3hCLHVCQUF1QixFQUFFLENBQUM7U0FDM0IsQ0FBQyxDQUFDO1FBRUgseUJBQXlCO1FBQ3pCLE1BQU0sY0FBYyxHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUM7WUFDL0QsV0FBVyxFQUFFLEtBQUssQ0FBQyxZQUFZO1lBQy9CLFdBQVcsRUFBRSxLQUFLLENBQUMsWUFBWSxHQUFHLENBQUM7U0FDcEMsQ0FBQyxDQUFDO1FBRUgsY0FBYyxDQUFDLHFCQUFxQixDQUFDLFlBQVksRUFBRTtZQUNqRCx3QkFBd0IsRUFBRSxFQUFFO1lBQzVCLGVBQWUsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDeEMsZ0JBQWdCLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1NBQzFDLENBQUMsQ0FBQztRQUVILGNBQWMsQ0FBQyx3QkFBd0IsQ0FBQyxlQUFlLEVBQUU7WUFDdkQsd0JBQXdCLEVBQUUsRUFBRTtZQUM1QixlQUFlLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1lBQ3hDLGdCQUFnQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztTQUMxQyxDQUFDLENBQUM7UUFFSCxpQ0FBaUM7UUFDakMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsRUFBRTtZQUM3RCxFQUFFLENBQUMsY0FBYyxDQUNmLEdBQUcsQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQ2xCLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUNsQiw2QkFBNkIsQ0FDOUIsQ0FBQztZQUVGLElBQUksS0FBSyxDQUFDLFVBQVUsRUFBRTtnQkFDcEIsRUFBRSxDQUFDLGNBQWMsQ0FDZixHQUFHLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUNsQixHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFDbEIsb0NBQW9DLENBQ3JDLENBQUM7YUFDSDtRQUNILENBQUMsQ0FBQyxDQUFDO1FBRUgsT0FBTyxjQUFjLENBQUM7SUFDeEIsQ0FBQztJQUVPLHVCQUF1QixDQUFDLEtBQXNDO1FBQ3BFLE1BQU0sTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDdEQsVUFBVSxFQUFFLHlCQUF5QixLQUFLLENBQUMsV0FBVyxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUU7WUFDeEUsVUFBVSxFQUFFLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVO1lBQzFDLGlCQUFpQixFQUFFLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxTQUFTO1lBQ2pELFNBQVMsRUFBRSxLQUFLO1lBQ2hCLGNBQWMsRUFBRTtnQkFDZDtvQkFDRSxFQUFFLEVBQUUsbUJBQW1CO29CQUN2QixPQUFPLEVBQUUsSUFBSTtvQkFDYixVQUFVLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2lCQUM1RTthQUNGO1lBQ0QsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWTtnQkFDL0MsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsTUFBTTtnQkFDMUIsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUM5QixDQUFDLENBQUM7UUFFSCxpQkFBaUI7UUFDakIsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxlQUFlLENBQUMsQ0FBQztRQUNwRCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUxRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBRU8saUJBQWlCLENBQUMsS0FBc0M7UUFDOUQsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjO1lBQUUsT0FBTztRQUVqQyx1QkFBdUI7UUFDdkIsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDbEMsWUFBWSxFQUFFLEdBQUcsQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQztZQUN2RCxXQUFXLEVBQUUsR0FBRyxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsY0FBYyxFQUFFLGdCQUFnQixDQUFDO1lBQy9FLFdBQVcsRUFBRSxHQUFHLENBQUMsa0JBQWtCLENBQUMsR0FBRztTQUN4QyxDQUFDLENBQUM7UUFFSCx5REFBeUQ7UUFDekQsSUFBSSxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsT0FBTyxDQUFDLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxFQUFFO1lBQ2hELElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEtBQUssRUFBRSxFQUFFO2dCQUNwRCxZQUFZLEVBQUUsR0FBRyxDQUFDLG1CQUFtQixDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUM7Z0JBQ3hELFdBQVcsRUFBRSxHQUFHLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFlLEVBQUUsMEJBQTBCLEtBQUssR0FBRyxDQUFDO2dCQUNsRyxXQUFXLEVBQUUsR0FBRyxDQUFDLGtCQUFrQixDQUFDLEdBQUc7YUFDeEMsQ0FBQyxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRU8saUJBQWlCLENBQUMsS0FBc0M7UUFDOUQsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLEVBQUU7WUFDckIsTUFBTSxJQUFJLEtBQUssQ0FBQywrQ0FBK0MsQ0FBQyxDQUFDO1NBQ2xFO1FBRUQseUJBQXlCO1FBQ3pCLE9BQU8sSUFBSSxrQkFBa0IsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ2hFLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtZQUM1Qix1QkFBdUIsRUFBRSxDQUFDLEtBQUssS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2xELFVBQVUsRUFBRSxrQkFBa0IsQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLEVBQUU7U0FDL0QsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVPLFNBQVMsQ0FBQyxLQUFzQztRQUN0RCxnREFBZ0Q7UUFDaEQsTUFBTSxjQUFjLEdBQUcsSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUNoRSxJQUFJLEVBQUUsV0FBVyxLQUFLLENBQUMsV0FBVyxhQUFhO1lBQy9DLFdBQVcsRUFBRSxzQkFBc0I7WUFDbkMsZ0JBQWdCLEVBQUUsTUFBTTtZQUN4QixTQUFTLEVBQUUsRUFBRTtZQUNiLEtBQUssRUFBRSxVQUFVO1NBQ2xCLENBQUMsQ0FBQztRQUVILHFCQUFxQjtRQUNyQixNQUFNLE1BQU0sR0FBRyxJQUFJLEtBQUssQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRTtZQUNqRCxJQUFJLEVBQUUsV0FBVyxLQUFLLENBQUMsV0FBVyxVQUFVO1lBQzVDLFdBQVcsRUFBRSxtQkFBbUIsS0FBSyxDQUFDLFdBQVcsY0FBYztZQUMvRCxLQUFLLEVBQUUsVUFBVTtZQUNqQixhQUFhLEVBQUUsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFO1lBRTVCLEtBQUssRUFBRTtnQkFDTCx1Q0FBdUM7Z0JBQ3ZDO29CQUNFLElBQUksRUFBRSxrQ0FBa0M7b0JBQ3hDLFFBQVEsRUFBRSxDQUFDO29CQUNYLGNBQWMsRUFBRSxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUU7b0JBQzVCLGdCQUFnQixFQUFFO3dCQUNoQixzQkFBc0IsRUFBRSxJQUFJO3dCQUM1Qix3QkFBd0IsRUFBRSxJQUFJO3dCQUM5QixVQUFVLEVBQUUscUJBQXFCO3FCQUNsQztvQkFDRCxTQUFTLEVBQUU7d0JBQ1QseUJBQXlCLEVBQUU7NEJBQ3pCLFVBQVUsRUFBRSxLQUFLOzRCQUNqQixJQUFJLEVBQUUsOEJBQThCO3lCQUNyQztxQkFDRjtpQkFDRjtnQkFFRCwwQ0FBMEM7Z0JBQzFDO29CQUNFLElBQUksRUFBRSwwQ0FBMEM7b0JBQ2hELFFBQVEsRUFBRSxDQUFDO29CQUNYLGNBQWMsRUFBRSxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUU7b0JBQzVCLGdCQUFnQixFQUFFO3dCQUNoQixzQkFBc0IsRUFBRSxJQUFJO3dCQUM1Qix3QkFBd0IsRUFBRSxJQUFJO3dCQUM5QixVQUFVLEVBQUUsNkJBQTZCO3FCQUMxQztvQkFDRCxTQUFTLEVBQUU7d0JBQ1QseUJBQXlCLEVBQUU7NEJBQ3pCLFVBQVUsRUFBRSxLQUFLOzRCQUNqQixJQUFJLEVBQUUsc0NBQXNDO3lCQUM3QztxQkFDRjtpQkFDRjtnQkFFRCxxQkFBcUI7Z0JBQ3JCO29CQUNFLElBQUksRUFBRSxlQUFlO29CQUNyQixRQUFRLEVBQUUsQ0FBQztvQkFDWCxNQUFNLEVBQUUsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFO29CQUNyQixnQkFBZ0IsRUFBRTt3QkFDaEIsc0JBQXNCLEVBQUUsSUFBSTt3QkFDNUIsd0JBQXdCLEVBQUUsSUFBSTt3QkFDOUIsVUFBVSxFQUFFLHFCQUFxQjtxQkFDbEM7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULGtCQUFrQixFQUFFOzRCQUNsQixLQUFLLEVBQUUsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSTs0QkFDdkQsZ0JBQWdCLEVBQUUsSUFBSTt5QkFDdkI7cUJBQ0Y7aUJBQ0Y7Z0JBRUQsd0VBQXdFO2dCQUN4RSxHQUFHLENBQUMsS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUM7d0JBQ3hDLElBQUksRUFBRSxvQkFBb0I7d0JBQzFCLFFBQVEsRUFBRSxDQUFDO3dCQUNYLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUU7d0JBQ3JCLGdCQUFnQixFQUFFOzRCQUNoQixzQkFBc0IsRUFBRSxJQUFJOzRCQUM1Qix3QkFBd0IsRUFBRSxJQUFJOzRCQUM5QixVQUFVLEVBQUUsMEJBQTBCO3lCQUN2Qzt3QkFDRCxTQUFTLEVBQUU7NEJBQ1QsaUJBQWlCLEVBQUU7Z0NBQ2pCLFlBQVksRUFBRSxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLEVBQUUsMkJBQTJCOzZCQUM5RDt5QkFDRjtxQkFDRixDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQzthQUNUO1lBRUQsZ0JBQWdCLEVBQUU7Z0JBQ2hCLHNCQUFzQixFQUFFLElBQUk7Z0JBQzVCLHdCQUF3QixFQUFFLElBQUk7Z0JBQzlCLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQyxXQUFXLFVBQVU7YUFDbkQ7U0FDRixDQUFDLENBQUM7UUFFSCxrQkFBa0I7UUFDbEIsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsRUFBRSxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDMUQsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO1FBRXRELE9BQU8sTUFBTSxDQUFDO0lBQ2hCLENBQUM7SUFFTyxtQkFBbUI7UUFDekIsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNO1lBQUUsT0FBTztRQUV6QiwrQ0FBK0M7UUFDL0MsSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQ3hELFdBQVcsRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLFlBQVksQ0FBQyxlQUFlO1lBQzdELFNBQVMsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU87U0FDL0IsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVPLGFBQWE7UUFDbkIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7WUFDL0IsS0FBSyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSztZQUNyQixXQUFXLEVBQUUsUUFBUTtZQUNyQixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxRQUFRO1NBQ3RDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDL0IsV0FBVyxFQUFFLGtCQUFrQjtZQUMvQixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxjQUFjO1NBQzVDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO1lBQ3ZDLEtBQUssRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLGFBQWE7WUFDcEMsV0FBVyxFQUFFLG9CQUFvQjtZQUNqQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxnQkFBZ0I7U0FDOUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsSUFBSSxDQUFDLGNBQWMsQ0FBQyxZQUFZLENBQUMsbUJBQW1CO1lBQzNELFdBQVcsRUFBRSxvQ0FBb0M7WUFDakQsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsa0JBQWtCO1NBQ2hELENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQzlDLFdBQVcsRUFBRSxrQkFBa0I7WUFDL0IsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsY0FBYztTQUM1QyxDQUFDLENBQUM7UUFFSCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztRQUNyRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxHQUFHLFFBQVEsTUFBTSxJQUFJLENBQUMsY0FBYyxDQUFDLFlBQVksQ0FBQyxtQkFBbUIsRUFBRTtZQUM5RSxXQUFXLEVBQUUsaUJBQWlCO1NBQy9CLENBQUMsQ0FBQztRQUVILHdDQUF3QztRQUN4QyxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUU7WUFDZixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtnQkFDdEMsS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTztnQkFDMUIsV0FBVyxFQUFFLGlCQUFpQjtnQkFDOUIsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsZUFBZTthQUM3QyxDQUFDLENBQUM7U0FDSjtRQUVELElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRTtZQUN2QixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO2dCQUM1QyxLQUFLLEVBQUUsSUFBSSxDQUFDLGNBQWMsQ0FBQyxVQUFVO2dCQUNyQyxXQUFXLEVBQUUsOEJBQThCO2dCQUMzQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxxQkFBcUI7YUFDbkQsQ0FBQyxDQUFDO1NBQ0o7UUFFRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUU7WUFDcEIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtnQkFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsY0FBYztnQkFDdEMsV0FBVyxFQUFFLHFCQUFxQjtnQkFDbEMsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsaUJBQWlCO2FBQy9DLENBQUMsQ0FBQztTQUNKO0lBQ0gsQ0FBQztDQUNGO0FBeHBCRCxnRUF3cEJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVjc19wYXR0ZXJucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzLXBhdHRlcm5zJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZWxhc3RpY2xvYWRiYWxhbmNpbmd2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXdhZnYyJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBjZXJ0aWZpY2F0ZW1hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlcic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IFNlY3JldHNMb2FkZXIgfSBmcm9tICcuL3NlY3JldHMtbG9hZGVyJztcblxuZXhwb3J0IGludGVyZmFjZSBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICBlbmFibGVJUHY2OiBib29sZWFuO1xuICBlbmFibGVIQU5hdEdhdGV3YXlzOiBib29sZWFuO1xuICBtYXhBenM6IG51bWJlcjtcbiAgbmF0R2F0ZXdheXM6IG51bWJlcjtcbiAgZGVzaXJlZENvdW50OiBudW1iZXI7XG4gIGNwdTogbnVtYmVyO1xuICBtZW1vcnlMaW1pdE1pQjogbnVtYmVyO1xuICAvLyBOZXR3b3JrIGNvbmZpZ3VyYXRpb25cbiAgdnBjQ2lkcj86IHN0cmluZztcbiAgcHVibGljU3VibmV0Q2lkck1hc2s/OiBudW1iZXI7XG4gIHByaXZhdGVTdWJuZXRDaWRyTWFzaz86IG51bWJlcjtcbiAgLy8gSVB2NiBjb25maWd1cmF0aW9uXG4gIGlwdjZDaWRyQmxvY2s/OiBzdHJpbmc7IC8vIElmIG5vdCBwcm92aWRlZCwgQVdTIHdpbGwgYXNzaWduIG9uZSBhdXRvbWF0aWNhbGx5XG4gIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50cyAoZGlzYWJsZWQgYnkgZGVmYXVsdClcbiAgZW5hYmxlV0FGPzogYm9vbGVhbjtcbiAgZW5hYmxlVlBDRmxvd0xvZ3M/OiBib29sZWFuO1xuICBlbmFibGVIVFRQUz86IGJvb2xlYW47XG4gIGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIC8vIENvbnRhaW5lciBzZWN1cml0eVxuICBlbmFibGVOb25Sb290Q29udGFpbmVyPzogYm9vbGVhbjtcbiAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBjbGFzcyBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSB2cGM6IGVjMi5WcGM7XG4gIHB1YmxpYyByZWFkb25seSBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcbiAgcHVibGljIHJlYWRvbmx5IHJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgZmFyZ2F0ZVNlcnZpY2U6IGVjc19wYXR0ZXJucy5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlZEZhcmdhdGVTZXJ2aWNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHNlY3JldHNMb2FkZXI6IFNlY3JldHNMb2FkZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgYXBwU2VjcmV0czogc2VjcmV0c21hbmFnZXIuU2VjcmV0O1xuICBwcml2YXRlIHJlYWRvbmx5IGZsb3dMb2dzQnVja2V0PzogczMuQnVja2V0O1xuICBwcml2YXRlIHJlYWRvbmx5IHdlYkFDTD86IHdhZnYyLkNmbldlYkFDTDtcbiAgcHJpdmF0ZSByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGNlcnRpZmljYXRlbWFuYWdlci5JQ2VydGlmaWNhdGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEluaXRpYWxpemUgc2VjcmV0cyBsb2FkZXJcbiAgICB0aGlzLnNlY3JldHNMb2FkZXIgPSBuZXcgU2VjcmV0c0xvYWRlcihwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIEFXUyBTZWNyZXRzIE1hbmFnZXIgc2VjcmV0IGZyb20gU09QU1xuICAgIHRoaXMuYXBwU2VjcmV0cyA9IHRoaXMuY3JlYXRlU2VjcmV0c01hbmFnZXJTZWNyZXQocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFZQQyBGbG93IExvZ3MgYnVja2V0IChpZiBlbmFibGVkKVxuICAgIGlmIChwcm9wcy5lbmFibGVWUENGbG93TG9ncykge1xuICAgICAgdGhpcy5mbG93TG9nc0J1Y2tldCA9IHRoaXMuY3JlYXRlVlBDRmxvd0xvZ3NCdWNrZXQocHJvcHMpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBWUEMgd2l0aCBjb25maWd1cmFibGUgSVB2NiBhbmQgTkFUIEdhdGV3YXkgb3B0aW9uc1xuICAgIHRoaXMudnBjID0gdGhpcy5jcmVhdGVWcGMocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFZQQyBGbG93IExvZ3MgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVZQQ0Zsb3dMb2dzICYmIHRoaXMuZmxvd0xvZ3NCdWNrZXQpIHtcbiAgICAgIHRoaXMuY3JlYXRlVlBDRmxvd0xvZ3MocHJvcHMpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBTU0wgY2VydGlmaWNhdGUgKGlmIEhUVFBTIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZUhUVFBTICYmIHByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSB0aGlzLmNyZWF0ZUNlcnRpZmljYXRlKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgRUNSIFJlcG9zaXRvcnlcbiAgICB0aGlzLnJlcG9zaXRvcnkgPSB0aGlzLmNyZWF0ZUVjclJlcG9zaXRvcnkocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUyBDbHVzdGVyXG4gICAgdGhpcy5jbHVzdGVyID0gdGhpcy5jcmVhdGVFY3NDbHVzdGVyKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBGYXJnYXRlIFNlcnZpY2Ugd2l0aCBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyXG4gICAgdGhpcy5mYXJnYXRlU2VydmljZSA9IHRoaXMuY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFdBRiAoaWYgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlV0FGKSB7XG4gICAgICB0aGlzLndlYkFDTCA9IHRoaXMuY3JlYXRlV0FGKHByb3BzKTtcbiAgICAgIHRoaXMuYXNzb2NpYXRlV0FGV2l0aEFMQigpO1xuICAgIH1cblxuICAgIC8vIE91dHB1dCBpbXBvcnRhbnQgcmVzb3VyY2VzXG4gICAgdGhpcy5jcmVhdGVPdXRwdXRzKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3JldHNNYW5hZ2VyU2VjcmV0KHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogc2VjcmV0c21hbmFnZXIuU2VjcmV0IHtcbiAgICB0cnkge1xuICAgICAgLy8gTG9hZCBzZWNyZXRzIGZyb20gU09QU1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IHRoaXMuc2VjcmV0c0xvYWRlci5sb2FkU2VjcmV0c1dpdGhGYWxsYmFjaygpO1xuICAgICAgXG4gICAgICAvLyBDcmVhdGUgU2VjcmV0cyBNYW5hZ2VyIHNlY3JldFxuICAgICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudGAsXG4gICAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHNlY3JldHMpLFxuICAgICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAnZ2VuZXJhdGVkX2F0JyxcbiAgICAgICAgICBpbmNsdWRlU3BhY2U6IGZhbHNlLFxuICAgICAgICAgIGV4Y2x1ZGVDaGFyYWN0ZXJzOiAnXCJAL1xcXFwnXG4gICAgICAgIH0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFRhZyB0aGUgc2VjcmV0XG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnTWFuYWdlZEJ5JywgJ0NESy1TT1BTJyk7XG4gICAgICBcbiAgICAgIHJldHVybiBzZWNyZXQ7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUud2FybihgRmFpbGVkIHRvIGxvYWQgU09QUyBzZWNyZXRzLCBjcmVhdGluZyBlbXB0eSBzZWNyZXQ6ICR7ZXJyb3J9YCk7XG4gICAgICBcbiAgICAgIC8vIEZhbGxiYWNrOiBjcmVhdGUgZW1wdHkgc2VjcmV0IHRoYXQgY2FuIGJlIHBvcHVsYXRlZCBsYXRlclxuICAgICAgcmV0dXJuIG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0FwcFNlY3JldHMnLCB7XG4gICAgICAgIHNlY3JldE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXNlY3JldHNgLFxuICAgICAgICBkZXNjcmlwdGlvbjogYEFwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnQgKGVtcHR5IC0gcG9wdWxhdGUgbWFudWFsbHkpYCxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVZwYyhwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjMi5WcGMge1xuICAgIGNvbnN0IHN1Ym5ldENvbmZpZ3VyYXRpb246IGVjMi5TdWJuZXRDb25maWd1cmF0aW9uW10gPSBbXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQdWJsaWMnLFxuICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgIGNpZHJNYXNrOiBwcm9wcy5wdWJsaWNTdWJuZXRDaWRyTWFzayB8fCAyNCxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQcml2YXRlJyxcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgY2lkck1hc2s6IHByb3BzLnByaXZhdGVTdWJuZXRDaWRyTWFzayB8fCAyNCxcbiAgICAgIH1cbiAgICBdO1xuXG4gICAgY29uc3QgdnBjUHJvcHM6IGVjMi5WcGNQcm9wcyA9IHtcbiAgICAgIG1heEF6czogcHJvcHMubWF4QXpzLFxuICAgICAgbmF0R2F0ZXdheXM6IHByb3BzLmVuYWJsZUhBTmF0R2F0ZXdheXMgPyBwcm9wcy5tYXhBenMgOiBNYXRoLm1pbihwcm9wcy5uYXRHYXRld2F5cywgcHJvcHMubWF4QXpzKSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb24sXG4gICAgICBlbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICBlbmFibGVEbnNTdXBwb3J0OiB0cnVlLFxuICAgICAgLy8gQ3VzdG9tIElQdjQgQ0lEUiBibG9jayAodXNpbmcgbmV3IGlwQWRkcmVzc2VzIEFQSSlcbiAgICAgIGlwQWRkcmVzc2VzOiBlYzIuSXBBZGRyZXNzZXMuY2lkcihwcm9wcy52cGNDaWRyIHx8ICcxMC4wLjAuMC8xNicpLFxuICAgIH07XG5cbiAgICAvLyBBZGQgSVB2NiBzdXBwb3J0IGlmIGVuYWJsZWRcbiAgICBpZiAocHJvcHMuZW5hYmxlSVB2Nikge1xuICAgICAgLy8gSVB2NiBjb25maWd1cmF0aW9uXG4gICAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnVGVzdEFwcFZwYycsIHtcbiAgICAgICAgLi4udnBjUHJvcHMsXG4gICAgICAgIC8vIElQdjYgd2lsbCBiZSBhZGRlZCB2aWEgc2VwYXJhdGUgY29uZmlndXJhdGlvblxuICAgICAgfSk7XG5cbiAgICAgIC8vIEFkZCBJUHY2IENJRFIgYmxvY2sgdG8gVlBDXG4gICAgICBjb25zdCBpcHY2Q2lkckJsb2NrID0gbmV3IGVjMi5DZm5WUENDaWRyQmxvY2sodGhpcywgJ0lwdjZDaWRyQmxvY2snLCB7XG4gICAgICAgIHZwY0lkOiB2cGMudnBjSWQsXG4gICAgICAgIC8vIFVzZSBjdXN0b20gSVB2NiBDSURSIGlmIHByb3ZpZGVkLCBvdGhlcndpc2UgdXNlIEFtYXpvbi1wcm92aWRlZFxuICAgICAgICAuLi4ocHJvcHMuaXB2NkNpZHJCbG9jayBcbiAgICAgICAgICA/IHsgaXB2NkNpZHJCbG9jazogcHJvcHMuaXB2NkNpZHJCbG9jayB9XG4gICAgICAgICAgOiB7IGFtYXpvblByb3ZpZGVkSXB2NkNpZHJCbG9jazogdHJ1ZSB9XG4gICAgICAgICksXG4gICAgICB9KTtcblxuICAgICAgLy8gQ29uZmlndXJlIElQdjYgZm9yIHB1YmxpYyBzdWJuZXRzXG4gICAgICB2cGMucHVibGljU3VibmV0cy5mb3JFYWNoKChzdWJuZXQsIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IGNmblN1Ym5ldCA9IHN1Ym5ldC5ub2RlLmRlZmF1bHRDaGlsZCBhcyBlYzIuQ2ZuU3VibmV0O1xuICAgICAgICBjZm5TdWJuZXQuaXB2NkNpZHJCbG9jayA9IGNkay5Gbi5zZWxlY3QoaW5kZXgsIGNkay5Gbi5jaWRyKFxuICAgICAgICAgIGNkay5Gbi5zZWxlY3QoMCwgdnBjLnZwY0lwdjZDaWRyQmxvY2tzKSxcbiAgICAgICAgICAyNTYsXG4gICAgICAgICAgJzY0J1xuICAgICAgICApKTtcbiAgICAgICAgY2ZuU3VibmV0LmFzc2lnbklwdjZBZGRyZXNzT25DcmVhdGlvbiA9IHRydWU7XG4gICAgICAgIGNmblN1Ym5ldC5hZGREZXBlbmRlbmN5KGlwdjZDaWRyQmxvY2spO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIEFkZCBJUHY2IHJvdXRlIGZvciBwdWJsaWMgc3VibmV0c1xuICAgICAgdnBjLnB1YmxpY1N1Ym5ldHMuZm9yRWFjaCgoc3VibmV0LCBpbmRleCkgPT4ge1xuICAgICAgICBuZXcgZWMyLkNmblJvdXRlKHRoaXMsIGBJcHY2Um91dGUtJHtpbmRleH1gLCB7XG4gICAgICAgICAgcm91dGVUYWJsZUlkOiBzdWJuZXQucm91dGVUYWJsZS5yb3V0ZVRhYmxlSWQsXG4gICAgICAgICAgZGVzdGluYXRpb25JcHY2Q2lkckJsb2NrOiAnOjovMCcsXG4gICAgICAgICAgZ2F0ZXdheUlkOiB2cGMuaW50ZXJuZXRHYXRld2F5SWQsXG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiB2cGM7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBlYzIuVnBjKHRoaXMsICdUZXN0QXBwVnBjJywgdnBjUHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWNyLlJlcG9zaXRvcnkge1xuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ1Rlc3RBcHBSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBydWxlUHJpb3JpdHk6IDEsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICB0YWdTdGF0dXM6IGVjci5UYWdTdGF0dXMuQU5ZLFxuICAgICAgICAgIG1heEltYWdlQ291bnQ6IDEwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVwb3NpdG9yeTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRWNzQ2x1c3Rlcihwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjcy5DbHVzdGVyIHtcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdUZXN0QXBwQ2x1c3RlcicsIHtcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBjbHVzdGVyTmFtZTogYHRlc3RhcHAtY2x1c3Rlci0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICAvLyBOb3RlOiBjb250YWluZXJJbnNpZ2h0cyBpcyBkZXByZWNhdGVkIGJ1dCBzdGlsbCBmdW5jdGlvbmFsXG4gICAgICAvLyBJbiBuZXdlciBDREsgdmVyc2lvbnMsIHVzZSBjb250YWluZXJJbnNpZ2h0czogZWNzLkNvbnRhaW5lckluc2lnaHRzLkVOSEFOQ0VEXG4gICAgfSk7XG5cbiAgICByZXR1cm4gY2x1c3RlcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjdXJlVGFza0RlZmluaXRpb24ocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMsIGV4ZWN1dGlvblJvbGU6IGlhbS5Sb2xlLCB0YXNrUm9sZTogaWFtLlJvbGUsIGxvZ0dyb3VwOiBsb2dzLkxvZ0dyb3VwKTogZWNzLlRhc2tEZWZpbml0aW9uIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIXByb3BzLmVuYWJsZU5vblJvb3RDb250YWluZXIgJiYgIXByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7IC8vIFVzZSBkZWZhdWx0IHRhc2sgZGVmaW5pdGlvblxuICAgIH1cblxuICAgIC8vIENyZWF0ZSBjdXN0b20gdGFzayBkZWZpbml0aW9uIHdpdGggc2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnU2VjdXJlVGFza0RlZmluaXRpb24nLCB7XG4gICAgICBjcHU6IHByb3BzLmNwdSxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlMaW1pdE1pQixcbiAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICB0YXNrUm9sZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBjb250YWluZXIgd2l0aCBzZWN1cml0eSBlbmhhbmNlbWVudHNcbiAgICBjb25zdCBjb250YWluZXIgPSB0YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ3Rlc3RhcHAnLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHRoaXMucmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogJ3Rlc3RhcHAnLFxuICAgICAgICBsb2dHcm91cCxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUkVRVUlSRURfU0VUVElORzogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIFNFQ1JFVF9LRVk6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHRoaXMuYXBwU2VjcmV0cywgJ2FwcGxpY2F0aW9uLnNlY3JldF9rZXknKSxcbiAgICAgIH0sXG4gICAgICAvLyBTZWN1cml0eSBlbmhhbmNlbWVudHNcbiAgICAgIHVzZXI6IHByb3BzLmVuYWJsZU5vblJvb3RDb250YWluZXIgPyAnMTAwMToxMDAxJyA6IHVuZGVmaW5lZCwgLy8gTm9uLXJvb3QgdXNlclxuICAgICAgcmVhZG9ubHlSb290RmlsZXN5c3RlbTogcHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSB8fCBmYWxzZSxcbiAgICAgIC8vIFJlc291cmNlIGxpbWl0cyBmb3Igc2VjdXJpdHlcbiAgICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiBNYXRoLmZsb29yKHByb3BzLm1lbW9yeUxpbWl0TWlCICogMC44KSwgLy8gUmVzZXJ2ZSA4MCUgb2YgbWVtb3J5XG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcG9ydCBtYXBwaW5nXG4gICAgY29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7XG4gICAgICBjb250YWluZXJQb3J0OiA4MDAwLFxuICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdG1wZnMgbW91bnRzIGlmIHJlYWQtb25seSByb290IGZpbGVzeXN0ZW0gaXMgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtKSB7XG4gICAgICB0YXNrRGVmaW5pdGlvbi5hZGRWb2x1bWUoe1xuICAgICAgICBuYW1lOiAndG1wLXZvbHVtZScsXG4gICAgICAgIGhvc3Q6IHt9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL3RtcCcsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgbG9ncyB2b2x1bWVcbiAgICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgIGhvc3Q6IHt9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy9hcHAvbG9ncycsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0YXNrRGVmaW5pdGlvbjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBlY3NfcGF0dGVybnMuQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSB7XG4gICAgLy8gQ3JlYXRlIENsb3VkV2F0Y2ggTG9nIEdyb3VwXG4gICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnVGVzdEFwcExvZ0dyb3VwJywge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9lY3MvdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICByZXRlbnRpb246IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAgICA6IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdGFzayBleGVjdXRpb24gcm9sZVxuICAgIGNvbnN0IGV4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rlc3RBcHBFeGVjdXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcbiAgICAgIF0sXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBFQ1JBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hDaGVja0xheWVyQXZhaWxhYmlsaXR5JyxcbiAgICAgICAgICAgICAgICAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdGFzayByb2xlIHdpdGggc2VjcmV0cyBhY2Nlc3NcbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGVzdEFwcFRhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBDbG91ZFdhdGNoTG9nczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxuICAgICAgICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTZWNyZXRzTWFuYWdlckFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3RoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIHNlY3VyZSB0YXNrIGRlZmluaXRpb24gaWYgc2VjdXJpdHkgZW5oYW5jZW1lbnRzIGFyZSBlbmFibGVkXG4gICAgY29uc3Qgc2VjdXJlVGFza0RlZmluaXRpb24gPSB0aGlzLmNyZWF0ZVNlY3VyZVRhc2tEZWZpbml0aW9uKHByb3BzLCBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSwgbG9nR3JvdXApO1xuXG4gICAgY29uc3QgZmFyZ2F0ZVNlcnZpY2VQcm9wczogYW55ID0ge1xuICAgICAgY2x1c3RlcjogdGhpcy5jbHVzdGVyLFxuICAgICAgc2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZGVzaXJlZENvdW50OiBwcm9wcy5kZXNpcmVkQ291bnQsXG4gICAgICBwdWJsaWNMb2FkQmFsYW5jZXI6IHRydWUsXG4gICAgICBsaXN0ZW5lclBvcnQ6IHByb3BzLmVuYWJsZUhUVFBTID8gNDQzIDogODAsXG4gICAgICBwcm90b2NvbDogcHJvcHMuZW5hYmxlSFRUUFMgXG4gICAgICAgID8gZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFBTIFxuICAgICAgICA6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgY2VydGlmaWNhdGU6IHRoaXMuY2VydGlmaWNhdGUsXG4gICAgICBkb21haW5ab25lOiB1bmRlZmluZWQsIC8vIEN1c3RvbSBkb21haW4gem9uZSB3b3VsZCBiZSBjb25maWd1cmVkIHNlcGFyYXRlbHlcbiAgICAgIGRvbWFpbk5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICByZWRpcmVjdEhUVFA6IHByb3BzLmVuYWJsZUhUVFBTLCAvLyBSZWRpcmVjdCBIVFRQIHRvIEhUVFBTIHdoZW4gSFRUUFMgaXMgZW5hYmxlZFxuICAgICAgYXNzaWduUHVibGljSXA6IHRydWUsXG4gICAgfTtcblxuICAgIC8vIFVzZSBzZWN1cmUgdGFzayBkZWZpbml0aW9uIGlmIGF2YWlsYWJsZSwgb3RoZXJ3aXNlIHVzZSBzdGFuZGFyZCB0YXNrSW1hZ2VPcHRpb25zXG4gICAgaWYgKHNlY3VyZVRhc2tEZWZpbml0aW9uKSB7XG4gICAgICBmYXJnYXRlU2VydmljZVByb3BzLnRhc2tEZWZpbml0aW9uID0gc2VjdXJlVGFza0RlZmluaXRpb247XG4gICAgfSBlbHNlIHtcbiAgICAgIGZhcmdhdGVTZXJ2aWNlUHJvcHMuY3B1ID0gcHJvcHMuY3B1O1xuICAgICAgZmFyZ2F0ZVNlcnZpY2VQcm9wcy5tZW1vcnlMaW1pdE1pQiA9IHByb3BzLm1lbW9yeUxpbWl0TWlCO1xuICAgICAgZmFyZ2F0ZVNlcnZpY2VQcm9wcy50YXNrSW1hZ2VPcHRpb25zID0ge1xuICAgICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHRoaXMucmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgICBjb250YWluZXJOYW1lOiAndGVzdGFwcCcsXG4gICAgICAgIGNvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICAgIHRhc2tSb2xlLFxuICAgICAgICBsb2dEcml2ZXI6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICAgIHN0cmVhbVByZWZpeDogJ3Rlc3RhcHAnLFxuICAgICAgICAgIGxvZ0dyb3VwLFxuICAgICAgICB9KSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBSRVFVSVJFRF9TRVRUSU5HOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICBFTlZJUk9OTUVOVDogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgfSxcbiAgICAgICAgc2VjcmV0czoge1xuICAgICAgICAgIC8vIEluZGl2aWR1YWwgc2VjcmV0cyBmcm9tIEFXUyBTZWNyZXRzIE1hbmFnZXJcbiAgICAgICAgICBTRUNSRVRfS0VZOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcih0aGlzLmFwcFNlY3JldHMsICdhcHBsaWNhdGlvbi5zZWNyZXRfa2V5JyksXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGZhcmdhdGVTZXJ2aWNlID0gbmV3IGVjc19wYXR0ZXJucy5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlZEZhcmdhdGVTZXJ2aWNlKHRoaXMsICdUZXN0QXBwU2VydmljZScsIGZhcmdhdGVTZXJ2aWNlUHJvcHMpO1xuXG4gICAgLy8gQ29uZmlndXJlIGhlYWx0aCBjaGVja1xuICAgIGZhcmdhdGVTZXJ2aWNlLnRhcmdldEdyb3VwLmNvbmZpZ3VyZUhlYWx0aENoZWNrKHtcbiAgICAgIHBhdGg6ICcvaGVhbHRoLycsXG4gICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5Qcm90b2NvbC5IVFRQLFxuICAgICAgcG9ydDogJzgwMDAnLFxuICAgICAgaGVhbHRoeUh0dHBDb2RlczogJzIwMCcsXG4gICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICB9KTtcblxuICAgIC8vIENvbmZpZ3VyZSBhdXRvIHNjYWxpbmdcbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IGZhcmdhdGVTZXJ2aWNlLnNlcnZpY2UuYXV0b1NjYWxlVGFza0NvdW50KHtcbiAgICAgIG1pbkNhcGFjaXR5OiBwcm9wcy5kZXNpcmVkQ291bnQsXG4gICAgICBtYXhDYXBhY2l0eTogcHJvcHMuZGVzaXJlZENvdW50ICogMyxcbiAgICB9KTtcblxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25DcHVVdGlsaXphdGlvbignQ3B1U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogNzAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgfSk7XG5cbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uTWVtb3J5VXRpbGl6YXRpb24oJ01lbW9yeVNjYWxpbmcnLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDgwLFxuICAgICAgc2NhbGVJbkNvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgIHNjYWxlT3V0Q29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDIpLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIHRoZSBzZXJ2aWNlXG4gICAgZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5jb25uZWN0aW9ucy5zZWN1cml0eUdyb3Vwcy5mb3JFYWNoKHNnID0+IHtcbiAgICAgIHNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgICBlYzIuUGVlci5hbnlJcHY0KCksXG4gICAgICAgIGVjMi5Qb3J0LnRjcCg4MDAwKSxcbiAgICAgICAgJ0FsbG93IEhUVFAgdHJhZmZpYyBmcm9tIEFMQidcbiAgICAgICk7XG5cbiAgICAgIGlmIChwcm9wcy5lbmFibGVJUHY2KSB7XG4gICAgICAgIHNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgICAgIGVjMi5QZWVyLmFueUlwdjYoKSxcbiAgICAgICAgICBlYzIuUG9ydC50Y3AoODAwMCksXG4gICAgICAgICAgJ0FsbG93IEhUVFAgdHJhZmZpYyBmcm9tIEFMQiAoSVB2NiknXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gZmFyZ2F0ZVNlcnZpY2U7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVZQQ0Zsb3dMb2dzQnVja2V0KHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogczMuQnVja2V0IHtcbiAgICBjb25zdCBidWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdWUENGbG93TG9nc0J1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGB0ZXN0YXBwLXZwYy1mbG93LWxvZ3MtJHtwcm9wcy5lbnZpcm9ubWVudH0tJHt0aGlzLmFjY291bnR9YCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICB2ZXJzaW9uZWQ6IGZhbHNlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnRGVsZXRlT2xkRmxvd0xvZ3MnLFxuICAgICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgZXhwaXJhdGlvbjogY2RrLkR1cmF0aW9uLmRheXMocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDkwIDogMzApLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBUYWcgdGhlIGJ1Y2tldFxuICAgIGNkay5UYWdzLm9mKGJ1Y2tldCkuYWRkKCdQdXJwb3NlJywgJ1ZQQy1GbG93LUxvZ3MnKTtcbiAgICBjZGsuVGFncy5vZihidWNrZXQpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgXG4gICAgcmV0dXJuIGJ1Y2tldDtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVlBDRmxvd0xvZ3MocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuZmxvd0xvZ3NCdWNrZXQpIHJldHVybjtcblxuICAgIC8vIENyZWF0ZSBWUEMgRmxvdyBMb2dzXG4gICAgbmV3IGVjMi5GbG93TG9nKHRoaXMsICdWUENGbG93TG9nJywge1xuICAgICAgcmVzb3VyY2VUeXBlOiBlYzIuRmxvd0xvZ1Jlc291cmNlVHlwZS5mcm9tVnBjKHRoaXMudnBjKSxcbiAgICAgIGRlc3RpbmF0aW9uOiBlYzIuRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvUzModGhpcy5mbG93TG9nc0J1Y2tldCwgJ3ZwYy1mbG93LWxvZ3MvJyksXG4gICAgICB0cmFmZmljVHlwZTogZWMyLkZsb3dMb2dUcmFmZmljVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgRmxvdyBMb2cgZm9yIGluZGl2aWR1YWwgc3VibmV0cyAobW9yZSBncmFudWxhcilcbiAgICB0aGlzLnZwYy5wcml2YXRlU3VibmV0cy5mb3JFYWNoKChzdWJuZXQsIGluZGV4KSA9PiB7XG4gICAgICBuZXcgZWMyLkZsb3dMb2codGhpcywgYFByaXZhdGVTdWJuZXRGbG93TG9nJHtpbmRleH1gLCB7XG4gICAgICAgIHJlc291cmNlVHlwZTogZWMyLkZsb3dMb2dSZXNvdXJjZVR5cGUuZnJvbVN1Ym5ldChzdWJuZXQpLFxuICAgICAgICBkZXN0aW5hdGlvbjogZWMyLkZsb3dMb2dEZXN0aW5hdGlvbi50b1MzKHRoaXMuZmxvd0xvZ3NCdWNrZXQhLCBgcHJpdmF0ZS1zdWJuZXRzL3N1Ym5ldC0ke2luZGV4fS9gKSxcbiAgICAgICAgdHJhZmZpY1R5cGU6IGVjMi5GbG93TG9nVHJhZmZpY1R5cGUuQUxMLFxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNlcnRpZmljYXRlKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZSB7XG4gICAgaWYgKCFwcm9wcy5kb21haW5OYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0RvbWFpbiBuYW1lIGlzIHJlcXVpcmVkIHdoZW4gSFRUUFMgaXMgZW5hYmxlZCcpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBTU0wgY2VydGlmaWNhdGVcbiAgICByZXR1cm4gbmV3IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZSh0aGlzLCAnU1NMQ2VydGlmaWNhdGUnLCB7XG4gICAgICBkb21haW5OYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgICAgc3ViamVjdEFsdGVybmF0aXZlTmFtZXM6IFtgKi4ke3Byb3BzLmRvbWFpbk5hbWV9YF0sXG4gICAgICB2YWxpZGF0aW9uOiBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMoKSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlV0FGKHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogd2FmdjIuQ2ZuV2ViQUNMIHtcbiAgICAvLyBDcmVhdGUgSVAgc2V0cyBmb3IgcmF0ZSBsaW1pdGluZyBhbmQgYmxvY2tpbmdcbiAgICBjb25zdCBpcFNldEFsbG93TGlzdCA9IG5ldyB3YWZ2Mi5DZm5JUFNldCh0aGlzLCAnSVBTZXRBbGxvd0xpc3QnLCB7XG4gICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hbGxvdy1saXN0YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWxsb3dlZCBJUCBhZGRyZXNzZXMnLFxuICAgICAgaXBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgYWRkcmVzc2VzOiBbXSwgLy8gQWRkIHlvdXIgYWxsb3dlZCBJUHMgaGVyZVxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgV0FGIFdlYiBBQ0xcbiAgICBjb25zdCB3ZWJBQ0wgPSBuZXcgd2FmdjIuQ2ZuV2ViQUNMKHRoaXMsICdXZWJBQ0wnLCB7XG4gICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS13ZWItYWNsYCxcbiAgICAgIGRlc2NyaXB0aW9uOiBgV0FGIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgIHNjb3BlOiAnUkVHSU9OQUwnLFxuICAgICAgZGVmYXVsdEFjdGlvbjogeyBhbGxvdzoge30gfSxcbiAgICAgIFxuICAgICAgcnVsZXM6IFtcbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBDb3JlIFJ1bGUgU2V0XG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgIHByaW9yaXR5OiAxLFxuICAgICAgICAgIG92ZXJyaWRlQWN0aW9uOiB7IG5vbmU6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdDb21tb25SdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBcbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBLbm93biBCYWQgSW5wdXRzXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDIsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0tub3duQmFkSW5wdXRzUnVsZVNldE1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgdmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFJhdGUgbGltaXRpbmcgcnVsZVxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1JhdGVMaW1pdFJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiAzLFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1JhdGVMaW1pdFJ1bGVNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICByYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgbGltaXQ6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAyMDAwIDogMTAwMCxcbiAgICAgICAgICAgICAgYWdncmVnYXRlS2V5VHlwZTogJ0lQJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBHZW9ncmFwaGljIHJlc3RyaWN0aW9uIChvcHRpb25hbCAtIGNhbiBiZSBjb25maWd1cmVkIHBlciBlbnZpcm9ubWVudClcbiAgICAgICAgLi4uKHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBbe1xuICAgICAgICAgIG5hbWU6ICdHZW9SZXN0cmljdGlvblJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiA0LFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIGdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGNvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCddLCAvLyBCbG9jayBzcGVjaWZpYyBjb3VudHJpZXNcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0gOiBbXSksXG4gICAgICBdLFxuXG4gICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgbWV0cmljTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0td2ViLWFjbGAsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gVGFnIHRoZSBXZWIgQUNMXG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdQdXJwb3NlJywgJ0REb1MtUHJvdGVjdGlvbicpO1xuXG4gICAgcmV0dXJuIHdlYkFDTDtcbiAgfVxuXG4gIHByaXZhdGUgYXNzb2NpYXRlV0FGV2l0aEFMQigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMud2ViQUNMKSByZXR1cm47XG5cbiAgICAvLyBBc3NvY2lhdGUgV0FGIHdpdGggQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIG5ldyB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbih0aGlzLCAnV2ViQUNMQXNzb2NpYXRpb24nLCB7XG4gICAgICByZXNvdXJjZUFybjogdGhpcy5mYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgd2ViQWNsQXJuOiB0aGlzLndlYkFDTC5hdHRyQXJuLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKCk6IHZvaWQge1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdWcGNJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnZwYy52cGNJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVlBDIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1WcGNJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3Rlck5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbHVzdGVyLmNsdXN0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbHVzdGVyTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2FkQmFsYW5jZXJETlMnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5mYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBETlMgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9hZEJhbGFuY2VyRE5TYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTZXJ2aWNlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmZhcmdhdGVTZXJ2aWNlLnNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBTZXJ2aWNlIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVNlcnZpY2VOYW1lYCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHByb3RvY29sID0gdGhpcy5jZXJ0aWZpY2F0ZSA/ICdodHRwcycgOiAnaHR0cCc7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcGxpY2F0aW9uVXJsJywge1xuICAgICAgdmFsdWU6IGAke3Byb3RvY29sfTovLyR7dGhpcy5mYXJnYXRlU2VydmljZS5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZX1gLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBVUkwnLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHktcmVsYXRlZCBvdXRwdXRzIChpZiBlbmFibGVkKVxuICAgIGlmICh0aGlzLndlYkFDTCkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1dBRldlYkFDTEFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVdBRldlYkFDTEFybmAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5mbG93TG9nc0J1Y2tldCkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Zsb3dMb2dzQnVja2V0TmFtZScsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuZmxvd0xvZ3NCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgICAgZGVzY3JpcHRpb246ICdWUEMgRmxvdyBMb2dzIFMzIEJ1Y2tldCBOYW1lJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUZsb3dMb2dzQnVja2V0TmFtZWAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NlcnRpZmljYXRlQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5jZXJ0aWZpY2F0ZS5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNlcnRpZmljYXRlQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufSJdfQ==