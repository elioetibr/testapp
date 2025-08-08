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
        // Request-based auto scaling
        scalableTarget.scaleOnRequestCount('RequestScaling', {
            requestsPerTarget: 1000,
            targetGroup: fargateService.targetGroup,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsNkRBQTZEO0FBQzdELDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsMkNBQTJDO0FBQzNDLGlGQUFpRjtBQUNqRixpRUFBaUU7QUFDakUsK0NBQStDO0FBQy9DLHlDQUF5QztBQUN6Qyx5RUFBeUU7QUFFekUsc0RBQWtEO0FBMkJsRCxNQUFhLDBCQUEyQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBV3ZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0M7UUFDOUUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNEJBQTRCO1FBQzVCLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSw4QkFBYSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUxRCw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFekQsMkNBQTJDO1FBQzNDLElBQUksS0FBSyxDQUFDLGlCQUFpQixFQUFFO1lBQzNCLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxDQUFDO1NBQzNEO1FBRUQsNERBQTREO1FBQzVELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVqQyxvQ0FBb0M7UUFDcEMsSUFBSSxLQUFLLENBQUMsaUJBQWlCLElBQUksSUFBSSxDQUFDLGNBQWMsRUFBRTtZQUNsRCxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDL0I7UUFF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Q0FBQyxVQUFVO2dCQUNyQyxXQUFXLEVBQUUsOEJBQThCO2dCQUMzQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxxQkFBcUI7YUFDbkQsQ0FBQyxDQUFDO1NBQ0o7UUFFRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUU7WUFDcEIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtnQkFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsY0FBYztnQkFDdEMsV0FBVyxFQUFFLHFCQUFxQjtnQkFDbEMsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsaUJBQWlCO2FBQy9DLENBQUMsQ0FBQztTQUNKO0lBQ0gsQ0FBQztDQUNGO0FBaHFCRCxnRUFncUJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVjc19wYXR0ZXJucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzLXBhdHRlcm5zJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZWxhc3RpY2xvYWRiYWxhbmNpbmd2MiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mic7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXdhZnYyJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBjZXJ0aWZpY2F0ZW1hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlcic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IFNlY3JldHNMb2FkZXIgfSBmcm9tICcuLi9zZWNyZXRzLWxvYWRlcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgZW52aXJvbm1lbnQ6IHN0cmluZztcbiAgZW5hYmxlSVB2NjogYm9vbGVhbjtcbiAgZW5hYmxlSEFOYXRHYXRld2F5czogYm9vbGVhbjtcbiAgbWF4QXpzOiBudW1iZXI7XG4gIG5hdEdhdGV3YXlzOiBudW1iZXI7XG4gIGRlc2lyZWRDb3VudDogbnVtYmVyO1xuICBjcHU6IG51bWJlcjtcbiAgbWVtb3J5TGltaXRNaUI6IG51bWJlcjtcbiAgLy8gTmV0d29yayBjb25maWd1cmF0aW9uXG4gIHZwY0NpZHI/OiBzdHJpbmc7XG4gIHB1YmxpY1N1Ym5ldENpZHJNYXNrPzogbnVtYmVyO1xuICBwcml2YXRlU3VibmV0Q2lkck1hc2s/OiBudW1iZXI7XG4gIC8vIElQdjYgY29uZmlndXJhdGlvblxuICBpcHY2Q2lkckJsb2NrPzogc3RyaW5nOyAvLyBJZiBub3QgcHJvdmlkZWQsIEFXUyB3aWxsIGFzc2lnbiBvbmUgYXV0b21hdGljYWxseVxuICAvLyBTZWN1cml0eSBlbmhhbmNlbWVudHMgKGRpc2FibGVkIGJ5IGRlZmF1bHQpXG4gIGVuYWJsZVdBRj86IGJvb2xlYW47XG4gIGVuYWJsZVZQQ0Zsb3dMb2dzPzogYm9vbGVhbjtcbiAgZW5hYmxlSFRUUFM/OiBib29sZWFuO1xuICBkb21haW5OYW1lPzogc3RyaW5nO1xuICAvLyBDb250YWluZXIgc2VjdXJpdHlcbiAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcj86IGJvb2xlYW47XG4gIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0/OiBib29sZWFuO1xufVxuXG5leHBvcnQgY2xhc3MgVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgdnBjOiBlYzIuVnBjO1xuICBwdWJsaWMgcmVhZG9ubHkgY2x1c3RlcjogZWNzLkNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSByZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGZhcmdhdGVTZXJ2aWNlOiBlY3NfcGF0dGVybnMuQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZTtcbiAgcHJpdmF0ZSByZWFkb25seSBzZWNyZXRzTG9hZGVyOiBTZWNyZXRzTG9hZGVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGFwcFNlY3JldHM6IHNlY3JldHNtYW5hZ2VyLlNlY3JldDtcbiAgcHJpdmF0ZSByZWFkb25seSBmbG93TG9nc0J1Y2tldD86IHMzLkJ1Y2tldDtcbiAgcHJpdmF0ZSByZWFkb25seSB3ZWJBQ0w/OiB3YWZ2Mi5DZm5XZWJBQ0w7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBjZXJ0aWZpY2F0ZW1hbmFnZXIuSUNlcnRpZmljYXRlO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBJbml0aWFsaXplIHNlY3JldHMgbG9hZGVyXG4gICAgdGhpcy5zZWNyZXRzTG9hZGVyID0gbmV3IFNlY3JldHNMb2FkZXIocHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIFxuICAgIC8vIENyZWF0ZSBBV1MgU2VjcmV0cyBNYW5hZ2VyIHNlY3JldCBmcm9tIFNPUFNcbiAgICB0aGlzLmFwcFNlY3JldHMgPSB0aGlzLmNyZWF0ZVNlY3JldHNNYW5hZ2VyU2VjcmV0KHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBWUEMgRmxvdyBMb2dzIGJ1Y2tldCAoaWYgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlVlBDRmxvd0xvZ3MpIHtcbiAgICAgIHRoaXMuZmxvd0xvZ3NCdWNrZXQgPSB0aGlzLmNyZWF0ZVZQQ0Zsb3dMb2dzQnVja2V0KHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgVlBDIHdpdGggY29uZmlndXJhYmxlIElQdjYgYW5kIE5BVCBHYXRld2F5IG9wdGlvbnNcbiAgICB0aGlzLnZwYyA9IHRoaXMuY3JlYXRlVnBjKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBWUEMgRmxvdyBMb2dzIChpZiBlbmFibGVkKVxuICAgIGlmIChwcm9wcy5lbmFibGVWUENGbG93TG9ncyAmJiB0aGlzLmZsb3dMb2dzQnVja2V0KSB7XG4gICAgICB0aGlzLmNyZWF0ZVZQQ0Zsb3dMb2dzKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgU1NMIGNlcnRpZmljYXRlIChIVFRQUyBpcyBtYW5kYXRvcnkgd2hlbiBkb21haW4gaXMgcHJvdmlkZWQpXG4gICAgaWYgKHByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSB0aGlzLmNyZWF0ZUNlcnRpZmljYXRlKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgRUNSIFJlcG9zaXRvcnlcbiAgICB0aGlzLnJlcG9zaXRvcnkgPSB0aGlzLmNyZWF0ZUVjclJlcG9zaXRvcnkocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUyBDbHVzdGVyXG4gICAgdGhpcy5jbHVzdGVyID0gdGhpcy5jcmVhdGVFY3NDbHVzdGVyKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBGYXJnYXRlIFNlcnZpY2Ugd2l0aCBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyXG4gICAgdGhpcy5mYXJnYXRlU2VydmljZSA9IHRoaXMuY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFdBRiAoaWYgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlV0FGKSB7XG4gICAgICB0aGlzLndlYkFDTCA9IHRoaXMuY3JlYXRlV0FGKHByb3BzKTtcbiAgICAgIHRoaXMuYXNzb2NpYXRlV0FGV2l0aEFMQigpO1xuICAgIH1cblxuICAgIC8vIE91dHB1dCBpbXBvcnRhbnQgcmVzb3VyY2VzXG4gICAgdGhpcy5jcmVhdGVPdXRwdXRzKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3JldHNNYW5hZ2VyU2VjcmV0KHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogc2VjcmV0c21hbmFnZXIuU2VjcmV0IHtcbiAgICB0cnkge1xuICAgICAgLy8gTG9hZCBzZWNyZXRzIGZyb20gU09QU1xuICAgICAgY29uc3Qgc2VjcmV0cyA9IHRoaXMuc2VjcmV0c0xvYWRlci5sb2FkU2VjcmV0c1dpdGhGYWxsYmFjaygpO1xuICAgICAgXG4gICAgICAvLyBDcmVhdGUgU2VjcmV0cyBNYW5hZ2VyIHNlY3JldFxuICAgICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCAnQXBwU2VjcmV0cycsIHtcbiAgICAgICAgc2VjcmV0TmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tc2VjcmV0c2AsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgQXBwbGljYXRpb24gc2VjcmV0cyBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudGAsXG4gICAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHNlY3JldHMpLFxuICAgICAgICAgIGdlbmVyYXRlU3RyaW5nS2V5OiAnZ2VuZXJhdGVkX2F0JyxcbiAgICAgICAgICBpbmNsdWRlU3BhY2U6IGZhbHNlLFxuICAgICAgICAgIGV4Y2x1ZGVDaGFyYWN0ZXJzOiAnXCJAL1xcXFwnXG4gICAgICAgIH0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFRhZyB0aGUgc2VjcmV0XG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgICBjZGsuVGFncy5vZihzZWNyZXQpLmFkZCgnTWFuYWdlZEJ5JywgJ0NESy1TT1BTJyk7XG4gICAgICBcbiAgICAgIHJldHVybiBzZWNyZXQ7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUud2FybihgRmFpbGVkIHRvIGxvYWQgU09QUyBzZWNyZXRzLCBjcmVhdGluZyBlbXB0eSBzZWNyZXQ6ICR7ZXJyb3J9YCk7XG4gICAgICBcbiAgICAgIC8vIEZhbGxiYWNrOiBjcmVhdGUgZW1wdHkgc2VjcmV0IHRoYXQgY2FuIGJlIHBvcHVsYXRlZCBsYXRlclxuICAgICAgcmV0dXJuIG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0FwcFNlY3JldHMnLCB7XG4gICAgICAgIHNlY3JldE5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXNlY3JldHNgLFxuICAgICAgICBkZXNjcmlwdGlvbjogYEFwcGxpY2F0aW9uIHNlY3JldHMgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnQgKGVtcHR5IC0gcG9wdWxhdGUgbWFudWFsbHkpYCxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVZwYyhwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjMi5WcGMge1xuICAgIGNvbnN0IHN1Ym5ldENvbmZpZ3VyYXRpb246IGVjMi5TdWJuZXRDb25maWd1cmF0aW9uW10gPSBbXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQdWJsaWMnLFxuICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgIGNpZHJNYXNrOiBwcm9wcy5wdWJsaWNTdWJuZXRDaWRyTWFzayB8fCAyNCxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdQcml2YXRlJyxcbiAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgY2lkck1hc2s6IHByb3BzLnByaXZhdGVTdWJuZXRDaWRyTWFzayB8fCAyNCxcbiAgICAgIH1cbiAgICBdO1xuXG4gICAgY29uc3QgdnBjUHJvcHM6IGVjMi5WcGNQcm9wcyA9IHtcbiAgICAgIG1heEF6czogcHJvcHMubWF4QXpzLFxuICAgICAgbmF0R2F0ZXdheXM6IHByb3BzLmVuYWJsZUhBTmF0R2F0ZXdheXMgPyBwcm9wcy5tYXhBenMgOiBNYXRoLm1pbihwcm9wcy5uYXRHYXRld2F5cywgcHJvcHMubWF4QXpzKSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb24sXG4gICAgICBlbmFibGVEbnNIb3N0bmFtZXM6IHRydWUsXG4gICAgICBlbmFibGVEbnNTdXBwb3J0OiB0cnVlLFxuICAgICAgLy8gQ3VzdG9tIElQdjQgQ0lEUiBibG9jayAodXNpbmcgbmV3IGlwQWRkcmVzc2VzIEFQSSlcbiAgICAgIGlwQWRkcmVzc2VzOiBlYzIuSXBBZGRyZXNzZXMuY2lkcihwcm9wcy52cGNDaWRyIHx8ICcxMC4wLjAuMC8xNicpLFxuICAgIH07XG5cbiAgICAvLyBBZGQgSVB2NiBzdXBwb3J0IGlmIGVuYWJsZWRcbiAgICBpZiAocHJvcHMuZW5hYmxlSVB2Nikge1xuICAgICAgLy8gSVB2NiBjb25maWd1cmF0aW9uXG4gICAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnVGVzdEFwcFZwYycsIHtcbiAgICAgICAgLi4udnBjUHJvcHMsXG4gICAgICAgIC8vIElQdjYgd2lsbCBiZSBhZGRlZCB2aWEgc2VwYXJhdGUgY29uZmlndXJhdGlvblxuICAgICAgfSk7XG5cbiAgICAgIC8vIEFkZCBJUHY2IENJRFIgYmxvY2sgdG8gVlBDXG4gICAgICBjb25zdCBpcHY2Q2lkckJsb2NrID0gbmV3IGVjMi5DZm5WUENDaWRyQmxvY2sodGhpcywgJ0lwdjZDaWRyQmxvY2snLCB7XG4gICAgICAgIHZwY0lkOiB2cGMudnBjSWQsXG4gICAgICAgIC8vIFVzZSBjdXN0b20gSVB2NiBDSURSIGlmIHByb3ZpZGVkLCBvdGhlcndpc2UgdXNlIEFtYXpvbi1wcm92aWRlZFxuICAgICAgICAuLi4ocHJvcHMuaXB2NkNpZHJCbG9jayBcbiAgICAgICAgICA/IHsgaXB2NkNpZHJCbG9jazogcHJvcHMuaXB2NkNpZHJCbG9jayB9XG4gICAgICAgICAgOiB7IGFtYXpvblByb3ZpZGVkSXB2NkNpZHJCbG9jazogdHJ1ZSB9XG4gICAgICAgICksXG4gICAgICB9KTtcblxuICAgICAgLy8gQ29uZmlndXJlIElQdjYgZm9yIHB1YmxpYyBzdWJuZXRzXG4gICAgICB2cGMucHVibGljU3VibmV0cy5mb3JFYWNoKChzdWJuZXQsIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IGNmblN1Ym5ldCA9IHN1Ym5ldC5ub2RlLmRlZmF1bHRDaGlsZCBhcyBlYzIuQ2ZuU3VibmV0O1xuICAgICAgICBjZm5TdWJuZXQuaXB2NkNpZHJCbG9jayA9IGNkay5Gbi5zZWxlY3QoaW5kZXgsIGNkay5Gbi5jaWRyKFxuICAgICAgICAgIGNkay5Gbi5zZWxlY3QoMCwgdnBjLnZwY0lwdjZDaWRyQmxvY2tzKSxcbiAgICAgICAgICAyNTYsXG4gICAgICAgICAgJzY0J1xuICAgICAgICApKTtcbiAgICAgICAgY2ZuU3VibmV0LmFzc2lnbklwdjZBZGRyZXNzT25DcmVhdGlvbiA9IHRydWU7XG4gICAgICAgIGNmblN1Ym5ldC5hZGREZXBlbmRlbmN5KGlwdjZDaWRyQmxvY2spO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIEFkZCBJUHY2IHJvdXRlIGZvciBwdWJsaWMgc3VibmV0c1xuICAgICAgdnBjLnB1YmxpY1N1Ym5ldHMuZm9yRWFjaCgoc3VibmV0LCBpbmRleCkgPT4ge1xuICAgICAgICBuZXcgZWMyLkNmblJvdXRlKHRoaXMsIGBJcHY2Um91dGUtJHtpbmRleH1gLCB7XG4gICAgICAgICAgcm91dGVUYWJsZUlkOiBzdWJuZXQucm91dGVUYWJsZS5yb3V0ZVRhYmxlSWQsXG4gICAgICAgICAgZGVzdGluYXRpb25JcHY2Q2lkckJsb2NrOiAnOjovMCcsXG4gICAgICAgICAgZ2F0ZXdheUlkOiB2cGMuaW50ZXJuZXRHYXRld2F5SWQsXG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiB2cGM7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBlYzIuVnBjKHRoaXMsICdUZXN0QXBwVnBjJywgdnBjUHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzOiBUZXN0QXBwSW5mcmFzdHJ1Y3R1cmVTdGFja1Byb3BzKTogZWNyLlJlcG9zaXRvcnkge1xuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ1Rlc3RBcHBSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBydWxlUHJpb3JpdHk6IDEsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICB0YWdTdGF0dXM6IGVjci5UYWdTdGF0dXMuQU5ZLFxuICAgICAgICAgIG1heEltYWdlQ291bnQ6IDEwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVwb3NpdG9yeTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRWNzQ2x1c3Rlcihwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IGVjcy5DbHVzdGVyIHtcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdUZXN0QXBwQ2x1c3RlcicsIHtcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBjbHVzdGVyTmFtZTogYHRlc3RhcHAtY2x1c3Rlci0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICAvLyBOb3RlOiBjb250YWluZXJJbnNpZ2h0cyBpcyBkZXByZWNhdGVkIGJ1dCBzdGlsbCBmdW5jdGlvbmFsXG4gICAgICAvLyBJbiBuZXdlciBDREsgdmVyc2lvbnMsIHVzZSBjb250YWluZXJJbnNpZ2h0czogZWNzLkNvbnRhaW5lckluc2lnaHRzLkVOSEFOQ0VEXG4gICAgfSk7XG5cbiAgICByZXR1cm4gY2x1c3RlcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjdXJlVGFza0RlZmluaXRpb24ocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMsIGV4ZWN1dGlvblJvbGU6IGlhbS5Sb2xlLCB0YXNrUm9sZTogaWFtLlJvbGUsIGxvZ0dyb3VwOiBsb2dzLkxvZ0dyb3VwKTogZWNzLlRhc2tEZWZpbml0aW9uIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIXByb3BzLmVuYWJsZU5vblJvb3RDb250YWluZXIgJiYgIXByb3BzLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0pIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7IC8vIFVzZSBkZWZhdWx0IHRhc2sgZGVmaW5pdGlvblxuICAgIH1cblxuICAgIC8vIENyZWF0ZSBjdXN0b20gdGFzayBkZWZpbml0aW9uIHdpdGggc2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCAnU2VjdXJlVGFza0RlZmluaXRpb24nLCB7XG4gICAgICBjcHU6IHByb3BzLmNwdSxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlMaW1pdE1pQixcbiAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICB0YXNrUm9sZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBjb250YWluZXIgd2l0aCBzZWN1cml0eSBlbmhhbmNlbWVudHNcbiAgICBjb25zdCBjb250YWluZXIgPSB0YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ3Rlc3RhcHAnLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KHRoaXMucmVwb3NpdG9yeSwgJ2xhdGVzdCcpLFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogJ3Rlc3RhcHAnLFxuICAgICAgICBsb2dHcm91cCxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUkVRVUlSRURfU0VUVElORzogcHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIFNFQ1JFVF9LRVk6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHRoaXMuYXBwU2VjcmV0cywgJ2FwcGxpY2F0aW9uLnNlY3JldF9rZXknKSxcbiAgICAgIH0sXG4gICAgICAvLyBTZWN1cml0eSBlbmhhbmNlbWVudHNcbiAgICAgIHVzZXI6IHByb3BzLmVuYWJsZU5vblJvb3RDb250YWluZXIgPyAnMTAwMToxMDAxJyA6IHVuZGVmaW5lZCwgLy8gTm9uLXJvb3QgdXNlclxuICAgICAgcmVhZG9ubHlSb290RmlsZXN5c3RlbTogcHJvcHMuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSB8fCBmYWxzZSxcbiAgICAgIC8vIFJlc291cmNlIGxpbWl0cyBmb3Igc2VjdXJpdHlcbiAgICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiBNYXRoLmZsb29yKHByb3BzLm1lbW9yeUxpbWl0TWlCICogMC44KSwgLy8gUmVzZXJ2ZSA4MCUgb2YgbWVtb3J5XG4gICAgfSk7XG5cbiAgICAvLyBBZGQgcG9ydCBtYXBwaW5nXG4gICAgY29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7XG4gICAgICBjb250YWluZXJQb3J0OiA4MDAwLFxuICAgICAgcHJvdG9jb2w6IGVjcy5Qcm90b2NvbC5UQ1AsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdG1wZnMgbW91bnRzIGlmIHJlYWQtb25seSByb290IGZpbGVzeXN0ZW0gaXMgZW5hYmxlZFxuICAgIGlmIChwcm9wcy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtKSB7XG4gICAgICB0YXNrRGVmaW5pdGlvbi5hZGRWb2x1bWUoe1xuICAgICAgICBuYW1lOiAndG1wLXZvbHVtZScsXG4gICAgICAgIGhvc3Q6IHt9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ3RtcC12b2x1bWUnLFxuICAgICAgICBjb250YWluZXJQYXRoOiAnL3RtcCcsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBBZGQgbG9ncyB2b2x1bWVcbiAgICAgIHRhc2tEZWZpbml0aW9uLmFkZFZvbHVtZSh7XG4gICAgICAgIG5hbWU6ICdsb2dzLXZvbHVtZScsXG4gICAgICAgIGhvc3Q6IHt9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnRhaW5lci5hZGRNb3VudFBvaW50cyh7XG4gICAgICAgIHNvdXJjZVZvbHVtZTogJ2xvZ3Mtdm9sdW1lJyxcbiAgICAgICAgY29udGFpbmVyUGF0aDogJy9hcHAvbG9ncycsXG4gICAgICAgIHJlYWRPbmx5OiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0YXNrRGVmaW5pdGlvbjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRmFyZ2F0ZVNlcnZpY2UocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBlY3NfcGF0dGVybnMuQXBwbGljYXRpb25Mb2FkQmFsYW5jZWRGYXJnYXRlU2VydmljZSB7XG4gICAgLy8gQ3JlYXRlIENsb3VkV2F0Y2ggTG9nIEdyb3VwXG4gICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnVGVzdEFwcExvZ0dyb3VwJywge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9lY3MvdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICByZXRlbnRpb246IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAgICA6IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdGFzayBleGVjdXRpb24gcm9sZVxuICAgIGNvbnN0IGV4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rlc3RBcHBFeGVjdXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcbiAgICAgIF0sXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBFQ1JBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hDaGVja0xheWVyQXZhaWxhYmlsaXR5JyxcbiAgICAgICAgICAgICAgICAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLFxuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdGFzayByb2xlIHdpdGggc2VjcmV0cyBhY2Nlc3NcbiAgICBjb25zdCB0YXNrUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnVGVzdEFwcFRhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBDbG91ZFdhdGNoTG9nczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxuICAgICAgICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTZWNyZXRzTWFuYWdlckFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3RoaXMuYXBwU2VjcmV0cy5zZWNyZXRBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIHNlY3VyZSB0YXNrIGRlZmluaXRpb24gaWYgc2VjdXJpdHkgZW5oYW5jZW1lbnRzIGFyZSBlbmFibGVkXG4gICAgY29uc3Qgc2VjdXJlVGFza0RlZmluaXRpb24gPSB0aGlzLmNyZWF0ZVNlY3VyZVRhc2tEZWZpbml0aW9uKHByb3BzLCBleGVjdXRpb25Sb2xlLCB0YXNrUm9sZSwgbG9nR3JvdXApO1xuXG4gICAgY29uc3QgZmFyZ2F0ZVNlcnZpY2VQcm9wczogYW55ID0ge1xuICAgICAgY2x1c3RlcjogdGhpcy5jbHVzdGVyLFxuICAgICAgc2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZGVzaXJlZENvdW50OiBwcm9wcy5kZXNpcmVkQ291bnQsXG4gICAgICBwdWJsaWNMb2FkQmFsYW5jZXI6IHRydWUsXG4gICAgICBsaXN0ZW5lclBvcnQ6IHRoaXMuY2VydGlmaWNhdGUgPyA0NDMgOiA4MCxcbiAgICAgIHByb3RvY29sOiB0aGlzLmNlcnRpZmljYXRlIFxuICAgICAgICA/IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyBcbiAgICAgICAgOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIGNlcnRpZmljYXRlOiB0aGlzLmNlcnRpZmljYXRlLFxuICAgICAgZG9tYWluWm9uZTogdW5kZWZpbmVkLCAvLyBDdXN0b20gZG9tYWluIHpvbmUgd291bGQgYmUgY29uZmlndXJlZCBzZXBhcmF0ZWx5XG4gICAgICBkb21haW5OYW1lOiB1bmRlZmluZWQsIC8vIERvbWFpbiBuYW1lIHJlcXVpcmVzIGRvbWFpblpvbmUgY29uZmlndXJhdGlvblxuICAgICAgcmVkaXJlY3RIVFRQOiB0aGlzLmNlcnRpZmljYXRlID8gdHJ1ZSA6IGZhbHNlLCAvLyBSZWRpcmVjdCBIVFRQIHRvIEhUVFBTIHdoZW4gY2VydGlmaWNhdGUgaXMgYXZhaWxhYmxlXG4gICAgICBhc3NpZ25QdWJsaWNJcDogdHJ1ZSxcbiAgICB9O1xuXG4gICAgLy8gVXNlIHNlY3VyZSB0YXNrIGRlZmluaXRpb24gaWYgYXZhaWxhYmxlLCBvdGhlcndpc2UgdXNlIHN0YW5kYXJkIHRhc2tJbWFnZU9wdGlvbnNcbiAgICBpZiAoc2VjdXJlVGFza0RlZmluaXRpb24pIHtcbiAgICAgIGZhcmdhdGVTZXJ2aWNlUHJvcHMudGFza0RlZmluaXRpb24gPSBzZWN1cmVUYXNrRGVmaW5pdGlvbjtcbiAgICB9IGVsc2Uge1xuICAgICAgZmFyZ2F0ZVNlcnZpY2VQcm9wcy5jcHUgPSBwcm9wcy5jcHU7XG4gICAgICBmYXJnYXRlU2VydmljZVByb3BzLm1lbW9yeUxpbWl0TWlCID0gcHJvcHMubWVtb3J5TGltaXRNaUI7XG4gICAgICBmYXJnYXRlU2VydmljZVByb3BzLnRhc2tJbWFnZU9wdGlvbnMgPSB7XG4gICAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkodGhpcy5yZXBvc2l0b3J5LCAnbGF0ZXN0JyksXG4gICAgICAgIGNvbnRhaW5lck5hbWU6ICd0ZXN0YXBwJyxcbiAgICAgICAgY29udGFpbmVyUG9ydDogODAwMCxcbiAgICAgICAgZXhlY3V0aW9uUm9sZSxcbiAgICAgICAgdGFza1JvbGUsXG4gICAgICAgIGxvZ0RyaXZlcjogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XG4gICAgICAgICAgc3RyZWFtUHJlZml4OiAndGVzdGFwcCcsXG4gICAgICAgICAgbG9nR3JvdXAsXG4gICAgICAgIH0pLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIFJFUVVJUkVEX1NFVFRJTkc6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICAgIEVOVklST05NRU5UOiBwcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICB9LFxuICAgICAgICBzZWNyZXRzOiB7XG4gICAgICAgICAgLy8gSW5kaXZpZHVhbCBzZWNyZXRzIGZyb20gQVdTIFNlY3JldHMgTWFuYWdlclxuICAgICAgICAgIFNFQ1JFVF9LRVk6IGVjcy5TZWNyZXQuZnJvbVNlY3JldHNNYW5hZ2VyKHRoaXMuYXBwU2VjcmV0cywgJ2FwcGxpY2F0aW9uLnNlY3JldF9rZXknKSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgZmFyZ2F0ZVNlcnZpY2UgPSBuZXcgZWNzX3BhdHRlcm5zLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VkRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ1Rlc3RBcHBTZXJ2aWNlJywgZmFyZ2F0ZVNlcnZpY2VQcm9wcyk7XG5cbiAgICAvLyBDb25maWd1cmUgaGVhbHRoIGNoZWNrXG4gICAgZmFyZ2F0ZVNlcnZpY2UudGFyZ2V0R3JvdXAuY29uZmlndXJlSGVhbHRoQ2hlY2soe1xuICAgICAgcGF0aDogJy9oZWFsdGgvJyxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLlByb3RvY29sLkhUVFAsXG4gICAgICBwb3J0OiAnODAwMCcsXG4gICAgICBoZWFsdGh5SHR0cENvZGVzOiAnMjAwJyxcbiAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgIH0pO1xuXG4gICAgLy8gQ29uZmlndXJlIGF1dG8gc2NhbGluZ1xuICAgIGNvbnN0IHNjYWxhYmxlVGFyZ2V0ID0gZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5hdXRvU2NhbGVUYXNrQ291bnQoe1xuICAgICAgbWluQ2FwYWNpdHk6IHByb3BzLmRlc2lyZWRDb3VudCxcbiAgICAgIG1heENhcGFjaXR5OiBwcm9wcy5kZXNpcmVkQ291bnQgKiAzLFxuICAgIH0pO1xuXG4gICAgc2NhbGFibGVUYXJnZXQuc2NhbGVPbkNwdVV0aWxpemF0aW9uKCdDcHVTY2FsaW5nJywge1xuICAgICAgdGFyZ2V0VXRpbGl6YXRpb25QZXJjZW50OiA3MCxcbiAgICAgIHNjYWxlSW5Db29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBzY2FsZU91dENvb2xkb3duOiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICB9KTtcblxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25NZW1vcnlVdGlsaXphdGlvbignTWVtb3J5U2NhbGluZycsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogODAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgfSk7XG5cbiAgICAvLyBSZXF1ZXN0LWJhc2VkIGF1dG8gc2NhbGluZ1xuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25SZXF1ZXN0Q291bnQoJ1JlcXVlc3RTY2FsaW5nJywge1xuICAgICAgcmVxdWVzdHNQZXJUYXJnZXQ6IDEwMDAsXG4gICAgICB0YXJnZXRHcm91cDogZmFyZ2F0ZVNlcnZpY2UudGFyZ2V0R3JvdXAsXG4gICAgICBzY2FsZUluQ29vbGRvd246IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgc2NhbGVPdXRDb29sZG93bjogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgfSk7XG5cbiAgICAvLyBTZWN1cml0eSBncm91cCBmb3IgdGhlIHNlcnZpY2VcbiAgICBmYXJnYXRlU2VydmljZS5zZXJ2aWNlLmNvbm5lY3Rpb25zLnNlY3VyaXR5R3JvdXBzLmZvckVhY2goc2cgPT4ge1xuICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgIGVjMi5QZWVyLmFueUlwdjQoKSxcbiAgICAgICAgZWMyLlBvcnQudGNwKDgwMDApLFxuICAgICAgICAnQWxsb3cgSFRUUCB0cmFmZmljIGZyb20gQUxCJ1xuICAgICAgKTtcblxuICAgICAgaWYgKHByb3BzLmVuYWJsZUlQdjYpIHtcbiAgICAgICAgc2cuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgICAgZWMyLlBlZXIuYW55SXB2NigpLFxuICAgICAgICAgIGVjMi5Qb3J0LnRjcCg4MDAwKSxcbiAgICAgICAgICAnQWxsb3cgSFRUUCB0cmFmZmljIGZyb20gQUxCIChJUHY2KSdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBmYXJnYXRlU2VydmljZTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVlBDRmxvd0xvZ3NCdWNrZXQocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBzMy5CdWNrZXQge1xuICAgIGNvbnN0IGJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ1ZQQ0Zsb3dMb2dzQnVja2V0Jywge1xuICAgICAgYnVja2V0TmFtZTogYHRlc3RhcHAtdnBjLWZsb3ctbG9ncy0ke3Byb3BzLmVudmlyb25tZW50fS0ke3RoaXMuYWNjb3VudH1gLFxuICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIHZlcnNpb25lZDogZmFsc2UsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdEZWxldGVPbGRGbG93TG9ncycsXG4gICAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICBleHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cyhwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gOTAgOiAzMCksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyBcbiAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4gXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIFRhZyB0aGUgYnVja2V0XG4gICAgY2RrLlRhZ3Mub2YoYnVja2V0KS5hZGQoJ1B1cnBvc2UnLCAnVlBDLUZsb3ctTG9ncycpO1xuICAgIGNkay5UYWdzLm9mKGJ1Y2tldCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBcbiAgICByZXR1cm4gYnVja2V0O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVWUENGbG93TG9ncyhwcm9wczogVGVzdEFwcEluZnJhc3RydWN0dXJlU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5mbG93TG9nc0J1Y2tldCkgcmV0dXJuO1xuXG4gICAgLy8gQ3JlYXRlIFZQQyBGbG93IExvZ3NcbiAgICBuZXcgZWMyLkZsb3dMb2codGhpcywgJ1ZQQ0Zsb3dMb2cnLCB7XG4gICAgICByZXNvdXJjZVR5cGU6IGVjMi5GbG93TG9nUmVzb3VyY2VUeXBlLmZyb21WcGModGhpcy52cGMpLFxuICAgICAgZGVzdGluYXRpb246IGVjMi5GbG93TG9nRGVzdGluYXRpb24udG9TMyh0aGlzLmZsb3dMb2dzQnVja2V0LCAndnBjLWZsb3ctbG9ncy8nKSxcbiAgICAgIHRyYWZmaWNUeXBlOiBlYzIuRmxvd0xvZ1RyYWZmaWNUeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBGbG93IExvZyBmb3IgaW5kaXZpZHVhbCBzdWJuZXRzIChtb3JlIGdyYW51bGFyKVxuICAgIHRoaXMudnBjLnByaXZhdGVTdWJuZXRzLmZvckVhY2goKHN1Ym5ldCwgaW5kZXgpID0+IHtcbiAgICAgIG5ldyBlYzIuRmxvd0xvZyh0aGlzLCBgUHJpdmF0ZVN1Ym5ldEZsb3dMb2cke2luZGV4fWAsIHtcbiAgICAgICAgcmVzb3VyY2VUeXBlOiBlYzIuRmxvd0xvZ1Jlc291cmNlVHlwZS5mcm9tU3VibmV0KHN1Ym5ldCksXG4gICAgICAgIGRlc3RpbmF0aW9uOiBlYzIuRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvUzModGhpcy5mbG93TG9nc0J1Y2tldCEsIGBwcml2YXRlLXN1Ym5ldHMvc3VibmV0LSR7aW5kZXh9L2ApLFxuICAgICAgICB0cmFmZmljVHlwZTogZWMyLkZsb3dMb2dUcmFmZmljVHlwZS5BTEwsXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ2VydGlmaWNhdGUocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiBjZXJ0aWZpY2F0ZW1hbmFnZXIuSUNlcnRpZmljYXRlIHtcbiAgICBpZiAoIXByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRG9tYWluIG5hbWUgaXMgcmVxdWlyZWQgd2hlbiBIVFRQUyBpcyBlbmFibGVkJyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFNTTCBjZXJ0aWZpY2F0ZVxuICAgIHJldHVybiBuZXcgY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlKHRoaXMsICdTU0xDZXJ0aWZpY2F0ZScsIHtcbiAgICAgIGRvbWFpbk5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICBzdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogW2AqLiR7cHJvcHMuZG9tYWluTmFtZX1gXSxcbiAgICAgIHZhbGlkYXRpb246IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucygpLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVXQUYocHJvcHM6IFRlc3RBcHBJbmZyYXN0cnVjdHVyZVN0YWNrUHJvcHMpOiB3YWZ2Mi5DZm5XZWJBQ0wge1xuICAgIC8vIENyZWF0ZSBJUCBzZXRzIGZvciByYXRlIGxpbWl0aW5nIGFuZCBibG9ja2luZ1xuICAgIGNvbnN0IGlwU2V0QWxsb3dMaXN0ID0gbmV3IHdhZnYyLkNmbklQU2V0KHRoaXMsICdJUFNldEFsbG93TGlzdCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFsbG93LWxpc3RgLFxuICAgICAgZGVzY3JpcHRpb246ICdBbGxvd2VkIElQIGFkZHJlc3NlcycsXG4gICAgICBpcEFkZHJlc3NWZXJzaW9uOiAnSVBWNCcsXG4gICAgICBhZGRyZXNzZXM6IFtdLCAvLyBBZGQgeW91ciBhbGxvd2VkIElQcyBoZXJlXG4gICAgICBzY29wZTogJ1JFR0lPTkFMJyxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBXQUYgV2ViIEFDTFxuICAgIGNvbnN0IHdlYkFDTCA9IG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcywgJ1dlYkFDTCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgZGVzY3JpcHRpb246IGBXQUYgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICBkZWZhdWx0QWN0aW9uOiB7IGFsbG93OiB7fSB9LFxuICAgICAgXG4gICAgICBydWxlczogW1xuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIENvcmUgUnVsZSBTZXRcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDEsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0NvbW1vblJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFxuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIEtub3duIEJhZCBJbnB1dHNcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMixcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnS25vd25CYWRJbnB1dHNSdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gUmF0ZSBsaW1pdGluZyBydWxlXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDMsXG4gICAgICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnUmF0ZUxpbWl0UnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIHJhdGVCYXNlZFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBsaW1pdDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDIwMDAgOiAxMDAwLFxuICAgICAgICAgICAgICBhZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIEdlb2dyYXBoaWMgcmVzdHJpY3Rpb24gKG9wdGlvbmFsIC0gY2FuIGJlIGNvbmZpZ3VyZWQgcGVyIGVudmlyb25tZW50KVxuICAgICAgICAuLi4ocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IFt7XG4gICAgICAgICAgbmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDQsXG4gICAgICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnR2VvUmVzdHJpY3Rpb25SdWxlTWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgZ2VvTWF0Y2hTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgY291bnRyeUNvZGVzOiBbJ0NOJywgJ1JVJywgJ0tQJ10sIC8vIEJsb2NrIHNwZWNpZmljIGNvdW50cmllc1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSA6IFtdKSxcbiAgICAgIF0sXG5cbiAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICBtZXRyaWNOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS13ZWItYWNsYCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBUYWcgdGhlIFdlYiBBQ0xcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ1B1cnBvc2UnLCAnRERvUy1Qcm90ZWN0aW9uJyk7XG5cbiAgICByZXR1cm4gd2ViQUNMO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3NvY2lhdGVXQUZXaXRoQUxCKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy53ZWJBQ0wpIHJldHVybjtcblxuICAgIC8vIEFzc29jaWF0ZSBXQUYgd2l0aCBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyXG4gICAgbmV3IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uKHRoaXMsICdXZWJBQ0xBc3NvY2lhdGlvbicsIHtcbiAgICAgIHJlc291cmNlQXJuOiB0aGlzLmZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICB3ZWJBY2xBcm46IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMoKTogdm9pZCB7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1ZwY0lkJywge1xuICAgICAgdmFsdWU6IHRoaXMudnBjLnZwY0lkLFxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVZwY0lkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsdXN0ZXJOYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJETlNgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NlcnZpY2VOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuZmFyZ2F0ZVNlcnZpY2Uuc2VydmljZS5zZXJ2aWNlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIFNlcnZpY2UgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tU2VydmljZU5hbWVgLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcHJvdG9jb2wgPSB0aGlzLmNlcnRpZmljYXRlID8gJ2h0dHBzJyA6ICdodHRwJztcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBwbGljYXRpb25VcmwnLCB7XG4gICAgICB2YWx1ZTogYCR7cHJvdG9jb2x9Oi8vJHt0aGlzLmZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFVSTCcsXG4gICAgfSk7XG5cbiAgICAvLyBTZWN1cml0eS1yZWxhdGVkIG91dHB1dHMgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMud2ViQUNMKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy53ZWJBQ0wuYXR0ckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmZsb3dMb2dzQnVja2V0KSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRmxvd0xvZ3NCdWNrZXROYW1lJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5mbG93TG9nc0J1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1ZQQyBGbG93IExvZ3MgUzMgQnVja2V0IE5hbWUnLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tRmxvd0xvZ3NCdWNrZXROYW1lYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2VydGlmaWNhdGVBcm4nLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLmNlcnRpZmljYXRlLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1NTTCBDZXJ0aWZpY2F0ZSBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2VydGlmaWNhdGVBcm5gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59Il19