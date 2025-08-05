"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EcsPlatformStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecr = require("aws-cdk-lib/aws-ecr");
const logs = require("aws-cdk-lib/aws-logs");
const elasticloadbalancingv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const certificatemanager = require("aws-cdk-lib/aws-certificatemanager");
const wafv2 = require("aws-cdk-lib/aws-wafv2");
const route53 = require("aws-cdk-lib/aws-route53");
class EcsPlatformStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Validate configuration
        if (props.enableHTTPS && (!props.baseDomain || !props.appName)) {
            throw new Error('Base domain and app name are required when HTTPS is enabled');
        }
        // Import VPC and subnets
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
            vpcId: props.vpcId,
            availabilityZones: cdk.Fn.getAzs(),
            publicSubnetIds: props.publicSubnetIds,
        });
        // Import Load Balancer Security Group
        const loadBalancerSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'ImportedLoadBalancerSecurityGroup', props.loadBalancerSecurityGroupId);
        // Create CloudWatch Log Group for the cluster
        this.logGroup = this.createLogGroup(props);
        // Create ECS Cluster
        this.cluster = this.createEcsCluster(props, vpc);
        // Create ECR Repository
        this.repository = this.createEcrRepository(props);
        // Create Route53 Hosted Zone (if domain provided)
        if (props.baseDomain && props.hostedZoneId) {
            this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
                hostedZoneId: props.hostedZoneId,
                zoneName: props.baseDomain, // Use base domain for hosted zone
            });
        }
        // Create SSL certificate (if HTTPS enabled)
        if (props.enableHTTPS && props.baseDomain) {
            this.certificate = this.createCertificate(props);
        }
        // Create Application Load Balancer
        this.loadBalancer = this.createApplicationLoadBalancer(props, vpc, loadBalancerSecurityGroup);
        // Create listeners
        this.httpListener = this.createHttpListener();
        if (props.enableHTTPS && this.certificate) {
            this.httpsListener = this.createHttpsListener();
        }
        // Note: Route53 DNS records are now managed by ApplicationStack
        // Create WAF (if enabled)
        if (props.enableWAF) {
            this.webACL = this.createWAF(props);
            this.associateWAFWithALB();
        }
        // Create stack outputs
        this.createOutputs(props);
    }
    createLogGroup(props) {
        return new logs.LogGroup(this, 'EcsLogGroup', {
            logGroupName: `/aws/ecs/testapp-${props.environment}`,
            retention: props.environment === 'production'
                ? logs.RetentionDays.ONE_MONTH
                : logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
    }
    createEcsCluster(props, vpc) {
        const clusterName = props.clusterName || `testapp-cluster-${props.environment}`;
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc,
            clusterName,
            enableFargateCapacityProviders: true,
        });
        // Add container insights if production
        if (props.environment === 'production') {
            cluster.addDefaultCloudMapNamespace({
                name: `testapp-${props.environment}`,
            });
        }
        // Add tags
        cdk.Tags.of(cluster).add('Environment', props.environment);
        cdk.Tags.of(cluster).add('ManagedBy', 'CDK');
        cdk.Tags.of(cluster).add('Component', 'ECS-Platform');
        return cluster;
    }
    createEcrRepository(props) {
        const repositoryName = props.repositoryName || `testapp-${props.environment}`;
        const repository = new ecr.Repository(this, 'EcrRepository', {
            repositoryName,
            imageScanOnPush: true,
            imageTagMutability: ecr.TagMutability.MUTABLE,
            lifecycleRules: [
                {
                    rulePriority: 1,
                    description: 'Delete untagged images after 1 day',
                    tagStatus: ecr.TagStatus.UNTAGGED,
                    maxImageAge: cdk.Duration.days(1),
                },
                {
                    rulePriority: 2,
                    description: 'Keep last 10 images',
                    tagStatus: ecr.TagStatus.ANY,
                    maxImageCount: 10,
                },
            ],
            removalPolicy: props.environment === 'production'
                ? cdk.RemovalPolicy.RETAIN
                : cdk.RemovalPolicy.DESTROY,
        });
        // Add tags
        cdk.Tags.of(repository).add('Environment', props.environment);
        cdk.Tags.of(repository).add('ManagedBy', 'CDK');
        cdk.Tags.of(repository).add('Component', 'Container-Registry');
        return repository;
    }
    createCertificate(props) {
        // baseDomain is guaranteed to exist due to constructor validation
        if (!props.baseDomain) {
            throw new Error('Base domain is required for certificate creation');
        }
        const certificate = new certificatemanager.Certificate(this, 'SSLCertificate', {
            domainName: props.baseDomain,
            subjectAlternativeNames: [`*.${props.baseDomain}`],
            validation: this.hostedZone
                ? certificatemanager.CertificateValidation.fromDns(this.hostedZone)
                : certificatemanager.CertificateValidation.fromDns(),
        });
        // Add tags
        cdk.Tags.of(certificate).add('Environment', props.environment);
        cdk.Tags.of(certificate).add('ManagedBy', 'CDK');
        cdk.Tags.of(certificate).add('Component', 'SSL-Certificate');
        return certificate;
    }
    createApplicationLoadBalancer(props, vpc, securityGroup) {
        const alb = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
            vpc,
            internetFacing: true,
            securityGroup,
            loadBalancerName: `testapp-alb-${props.environment}`,
            deletionProtection: props.environment === 'production',
        });
        // Add tags
        cdk.Tags.of(alb).add('Environment', props.environment);
        cdk.Tags.of(alb).add('ManagedBy', 'CDK');
        cdk.Tags.of(alb).add('Component', 'Load-Balancer');
        return alb;
    }
    createHttpListener() {
        const listener = this.loadBalancer.addListener('HttpListener', {
            port: 80,
            protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
        });
        // Default action - will be overridden by application stack
        listener.addAction('DefaultAction', {
            action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
                contentType: 'text/plain',
                messageBody: 'Service temporarily unavailable',
            }),
        });
        return listener;
    }
    createHttpsListener() {
        // certificate is guaranteed to exist when this method is called
        if (!this.certificate) {
            throw new Error('Certificate is required for HTTPS listener creation');
        }
        const listener = this.loadBalancer.addListener('HttpsListener', {
            port: 443,
            protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
            certificates: [this.certificate],
        });
        // Default action - will be overridden by application stack
        listener.addAction('DefaultAction', {
            action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
                contentType: 'text/plain',
                messageBody: 'Service temporarily unavailable',
            }),
        });
        // Add HTTP to HTTPS redirect
        this.httpListener.addAction('RedirectToHttps', {
            action: elasticloadbalancingv2.ListenerAction.redirect({
                protocol: 'HTTPS',
                port: '443',
                permanent: true,
            }),
        });
        return listener;
    }
    createWAF(props) {
        // Create IP sets for rate limiting
        const ipSetAllowList = new wafv2.CfnIPSet(this, 'IPSetAllowList', {
            name: `testapp-${props.environment}-allow-list`,
            description: 'Allowed IP addresses for higher rate limits',
            ipAddressVersion: 'IPV4',
            addresses: [],
            scope: 'REGIONAL',
        });
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
                // AWS Managed Rule Set - SQL Injection
                {
                    name: 'AWS-AWSManagedRulesSQLiRuleSet',
                    priority: 3,
                    overrideAction: { none: {} },
                    visibilityConfig: {
                        sampledRequestsEnabled: true,
                        cloudWatchMetricsEnabled: true,
                        metricName: 'SQLiRuleSetMetric',
                    },
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: 'AWS',
                            name: 'AWSManagedRulesSQLiRuleSet',
                        },
                    },
                },
                // Rate limiting rule
                {
                    name: 'RateLimitRule',
                    priority: 10,
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
                // Geographic restriction for production
                ...(props.environment === 'production' ? [{
                        name: 'GeoRestrictionRule',
                        priority: 15,
                        action: { block: {} },
                        visibilityConfig: {
                            sampledRequestsEnabled: true,
                            cloudWatchMetricsEnabled: true,
                            metricName: 'GeoRestrictionRuleMetric',
                        },
                        statement: {
                            geoMatchStatement: {
                                countryCodes: ['CN', 'RU', 'KP', 'IR'], // Block specific high-risk countries
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
        // Add tags
        cdk.Tags.of(webACL).add('Environment', props.environment);
        cdk.Tags.of(webACL).add('ManagedBy', 'CDK');
        cdk.Tags.of(webACL).add('Component', 'WAF');
        cdk.Tags.of(webACL).add('Purpose', 'DDoS-Protection');
        return webACL;
    }
    associateWAFWithALB() {
        if (!this.webACL)
            return;
        new wafv2.CfnWebACLAssociation(this, 'WebACLAssociation', {
            resourceArn: this.loadBalancer.loadBalancerArn,
            webAclArn: this.webACL.attrArn,
        });
    }
    createOutputs(props) {
        // ECS Cluster outputs
        new cdk.CfnOutput(this, 'ClusterArn', {
            value: this.cluster.clusterArn,
            description: 'ECS Cluster ARN',
            exportName: `${this.stackName}-ClusterArn`,
        });
        new cdk.CfnOutput(this, 'ClusterName', {
            value: this.cluster.clusterName,
            description: 'ECS Cluster Name',
            exportName: `${this.stackName}-ClusterName`,
        });
        // ECR Repository outputs
        new cdk.CfnOutput(this, 'RepositoryUri', {
            value: this.repository.repositoryUri,
            description: 'ECR Repository URI',
            exportName: `${this.stackName}-RepositoryUri`,
        });
        new cdk.CfnOutput(this, 'RepositoryArn', {
            value: this.repository.repositoryArn,
            description: 'ECR Repository ARN',
            exportName: `${this.stackName}-RepositoryArn`,
        });
        // Load Balancer outputs
        new cdk.CfnOutput(this, 'LoadBalancerArn', {
            value: this.loadBalancer.loadBalancerArn,
            description: 'Application Load Balancer ARN',
            exportName: `${this.stackName}-LoadBalancerArn`,
        });
        new cdk.CfnOutput(this, 'LoadBalancerDNS', {
            value: this.loadBalancer.loadBalancerDnsName,
            description: 'Application Load Balancer DNS Name',
            exportName: `${this.stackName}-LoadBalancerDNS`,
        });
        new cdk.CfnOutput(this, 'LoadBalancerZoneId', {
            value: this.loadBalancer.loadBalancerCanonicalHostedZoneId,
            description: 'Application Load Balancer Hosted Zone ID',
            exportName: `${this.stackName}-LoadBalancerZoneId`,
        });
        // Listener outputs
        new cdk.CfnOutput(this, 'HttpListenerArn', {
            value: this.httpListener.listenerArn,
            description: 'HTTP Listener ARN',
            exportName: `${this.stackName}-HttpListenerArn`,
        });
        if (this.httpsListener) {
            new cdk.CfnOutput(this, 'HttpsListenerArn', {
                value: this.httpsListener.listenerArn,
                description: 'HTTPS Listener ARN',
                exportName: `${this.stackName}-HttpsListenerArn`,
            });
        }
        // Log Group output
        new cdk.CfnOutput(this, 'LogGroupName', {
            value: this.logGroup.logGroupName,
            description: 'CloudWatch Log Group Name',
            exportName: `${this.stackName}-LogGroupName`,
        });
        new cdk.CfnOutput(this, 'LogGroupArn', {
            value: this.logGroup.logGroupArn,
            description: 'CloudWatch Log Group ARN',
            exportName: `${this.stackName}-LogGroupArn`,
        });
        // Certificate output (if enabled)
        if (this.certificate) {
            new cdk.CfnOutput(this, 'CertificateArn', {
                value: this.certificate.certificateArn,
                description: 'SSL Certificate ARN',
                exportName: `${this.stackName}-CertificateArn`,
            });
        }
        // WAF output (if enabled)
        if (this.webACL) {
            new cdk.CfnOutput(this, 'WAFWebACLArn', {
                value: this.webACL.attrArn,
                description: 'WAF Web ACL ARN',
                exportName: `${this.stackName}-WAFWebACLArn`,
            });
            new cdk.CfnOutput(this, 'WAFWebACLId', {
                value: this.webACL.attrId,
                description: 'WAF Web ACL ID',
                exportName: `${this.stackName}-WAFWebACLId`,
            });
        }
        // ALB DNS output already created above - removing duplicate
    }
}
exports.EcsPlatformStack = EcsPlatformStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZWNzLXBsYXRmb3JtLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsaUZBQWlGO0FBQ2pGLHlFQUF5RTtBQUN6RSwrQ0FBK0M7QUFDL0MsbURBQW1EO0FBcUJuRCxNQUFhLGdCQUFpQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBWTdDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIseUJBQXlCO1FBQ3pCLElBQUksS0FBSyxDQUFDLFdBQVcsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsRUFBRTtZQUM5RCxNQUFNLElBQUksS0FBSyxDQUFDLDZEQUE2RCxDQUFDLENBQUM7U0FDaEY7UUFFRCx5QkFBeUI7UUFDekIsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3pELEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztZQUNsQixpQkFBaUIsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRTtZQUNsQyxlQUFlLEVBQUUsS0FBSyxDQUFDLGVBQWU7U0FDdkMsQ0FBQyxDQUFDO1FBRUgsc0NBQXNDO1FBQ3RDLE1BQU0seUJBQXlCLEdBQUcsR0FBRyxDQUFDLGFBQWEsQ0FBQyxtQkFBbUIsQ0FDckUsSUFBSSxFQUFFLG1DQUFtQyxFQUN6QyxLQUFLLENBQUMsMkJBQTJCLENBQ2xDLENBQUM7UUFFRiw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRTNDLHFCQUFxQjtRQUNyQixJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFFakQsd0JBQXdCO1FBQ3hCLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRWxELGtEQUFrRDtRQUNsRCxJQUFJLEtBQUssQ0FBQyxVQUFVLElBQUksS0FBSyxDQUFDLFlBQVksRUFBRTtZQUMxQyxJQUFJLENBQUMsVUFBVSxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsd0JBQXdCLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDaEYsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZO2dCQUNoQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRSxrQ0FBa0M7YUFDL0QsQ0FBQyxDQUFDO1NBQ0o7UUFFRCw0Q0FBNEM7UUFDNUMsSUFBSSxLQUFLLENBQUMsV0FBVyxJQUFJLEtBQUssQ0FBQyxVQUFVLEVBQUU7WUFDekMsSUFBSSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLENBQUM7U0FDbEQ7UUFFRCxtQ0FBbUM7UUFDbkMsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsNkJBQTZCLENBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO1FBRTlGLG1CQUFtQjtRQUNuQixJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQzlDLElBQUksS0FBSyxDQUFDLFdBQVcsSUFBSSxJQUFJLENBQUMsV0FBVyxFQUFFO1lBQ3pDLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixFQUFFLENBQUM7U0FDakQ7UUFFRCxnRUFBZ0U7UUFFaEUsMEJBQTBCO1FBQzFCLElBQUksS0FBSyxDQUFDLFNBQVMsRUFBRTtZQUNuQixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDcEMsSUFBSSxDQUFDLG1CQUFtQixFQUFFLENBQUM7U0FDNUI7UUFFRCx1QkFBdUI7UUFDdkIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1QixDQUFDO0lBRU8sY0FBYyxDQUFDLEtBQTRCO1FBQ2pELE9BQU8sSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDNUMsWUFBWSxFQUFFLG9CQUFvQixLQUFLLENBQUMsV0FBVyxFQUFFO1lBQ3JELFNBQVMsRUFBRSxLQUFLLENBQUMsV0FBVyxLQUFLLFlBQVk7Z0JBQzNDLENBQUMsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7Z0JBQzlCLENBQUMsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVE7WUFDL0IsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUN6QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRU8sZ0JBQWdCLENBQUMsS0FBNEIsRUFBRSxHQUFhO1FBQ2xFLE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksbUJBQW1CLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUVoRixNQUFNLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNsRCxHQUFHO1lBQ0gsV0FBVztZQUNYLDhCQUE4QixFQUFFLElBQUk7U0FDckMsQ0FBQyxDQUFDO1FBRUgsdUNBQXVDO1FBQ3ZDLElBQUksS0FBSyxDQUFDLFdBQVcsS0FBSyxZQUFZLEVBQUU7WUFDdEMsT0FBTyxDQUFDLDJCQUEyQixDQUFDO2dCQUNsQyxJQUFJLEVBQUUsV0FBVyxLQUFLLENBQUMsV0FBVyxFQUFFO2FBQ3JDLENBQUMsQ0FBQztTQUNKO1FBRUQsV0FBVztRQUNYLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzNELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDN0MsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxjQUFjLENBQUMsQ0FBQztRQUV0RCxPQUFPLE9BQU8sQ0FBQztJQUNqQixDQUFDO0lBRU8sbUJBQW1CLENBQUMsS0FBNEI7UUFDdEQsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxXQUFXLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUU5RSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUMzRCxjQUFjO1lBQ2QsZUFBZSxFQUFFLElBQUk7WUFDckIsa0JBQWtCLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQzdDLGNBQWMsRUFBRTtnQkFDZDtvQkFDRSxZQUFZLEVBQUUsQ0FBQztvQkFDZixXQUFXLEVBQUUsb0NBQW9DO29CQUNqRCxTQUFTLEVBQUUsR0FBRyxDQUFDLFNBQVMsQ0FBQyxRQUFRO29CQUNqQyxXQUFXLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO2lCQUNsQztnQkFDRDtvQkFDRSxZQUFZLEVBQUUsQ0FBQztvQkFDZixXQUFXLEVBQUUscUJBQXFCO29CQUNsQyxTQUFTLEVBQUUsR0FBRyxDQUFDLFNBQVMsQ0FBQyxHQUFHO29CQUM1QixhQUFhLEVBQUUsRUFBRTtpQkFDbEI7YUFDRjtZQUNELGFBQWEsRUFBRSxLQUFLLENBQUMsV0FBVyxLQUFLLFlBQVk7Z0JBQy9DLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLE1BQU07Z0JBQzFCLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87U0FDOUIsQ0FBQyxDQUFDO1FBRUgsV0FBVztRQUNYLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzlELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDaEQsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1FBRS9ELE9BQU8sVUFBVSxDQUFDO0lBQ3BCLENBQUM7SUFFTyxpQkFBaUIsQ0FBQyxLQUE0QjtRQUNwRCxrRUFBa0U7UUFDbEUsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLEVBQUU7WUFDckIsTUFBTSxJQUFJLEtBQUssQ0FBQyxrREFBa0QsQ0FBQyxDQUFDO1NBQ3JFO1FBRUQsTUFBTSxXQUFXLEdBQUcsSUFBSSxrQkFBa0IsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQzdFLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtZQUM1Qix1QkFBdUIsRUFBRSxDQUFDLEtBQUssS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2xELFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVTtnQkFDekIsQ0FBQyxDQUFDLGtCQUFrQixDQUFDLHFCQUFxQixDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDO2dCQUNuRSxDQUFDLENBQUMsa0JBQWtCLENBQUMscUJBQXFCLENBQUMsT0FBTyxFQUFFO1NBQ3ZELENBQUMsQ0FBQztRQUVILFdBQVc7UUFDWCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUMvRCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ2pELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUU3RCxPQUFPLFdBQVcsQ0FBQztJQUNyQixDQUFDO0lBRU8sNkJBQTZCLENBQ25DLEtBQTRCLEVBQzVCLEdBQWEsRUFDYixhQUFpQztRQUVqQyxNQUFNLEdBQUcsR0FBRyxJQUFJLHNCQUFzQixDQUFDLHVCQUF1QixDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtZQUM5RixHQUFHO1lBQ0gsY0FBYyxFQUFFLElBQUk7WUFDcEIsYUFBYTtZQUNiLGdCQUFnQixFQUFFLGVBQWUsS0FBSyxDQUFDLFdBQVcsRUFBRTtZQUNwRCxrQkFBa0IsRUFBRSxLQUFLLENBQUMsV0FBVyxLQUFLLFlBQVk7U0FDdkQsQ0FBQyxDQUFDO1FBRUgsV0FBVztRQUNYLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQ3ZELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDekMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxlQUFlLENBQUMsQ0FBQztRQUVuRCxPQUFPLEdBQUcsQ0FBQztJQUNiLENBQUM7SUFFTyxrQkFBa0I7UUFDeEIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsY0FBYyxFQUFFO1lBQzdELElBQUksRUFBRSxFQUFFO1lBQ1IsUUFBUSxFQUFFLHNCQUFzQixDQUFDLG1CQUFtQixDQUFDLElBQUk7U0FDMUQsQ0FBQyxDQUFDO1FBRUgsMkRBQTJEO1FBQzNELFFBQVEsQ0FBQyxTQUFTLENBQUMsZUFBZSxFQUFFO1lBQ2xDLE1BQU0sRUFBRSxzQkFBc0IsQ0FBQyxjQUFjLENBQUMsYUFBYSxDQUFDLEdBQUcsRUFBRTtnQkFDL0QsV0FBVyxFQUFFLFlBQVk7Z0JBQ3pCLFdBQVcsRUFBRSxpQ0FBaUM7YUFDL0MsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILE9BQU8sUUFBUSxDQUFDO0lBQ2xCLENBQUM7SUFFTyxtQkFBbUI7UUFDekIsZ0VBQWdFO1FBQ2hFLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFO1lBQ3JCLE1BQU0sSUFBSSxLQUFLLENBQUMscURBQXFELENBQUMsQ0FBQztTQUN4RTtRQUVELE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsV0FBVyxDQUFDLGVBQWUsRUFBRTtZQUM5RCxJQUFJLEVBQUUsR0FBRztZQUNULFFBQVEsRUFBRSxzQkFBc0IsQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLO1lBQzFELFlBQVksRUFBRSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUM7U0FDakMsQ0FBQyxDQUFDO1FBRUgsMkRBQTJEO1FBQzNELFFBQVEsQ0FBQyxTQUFTLENBQUMsZUFBZSxFQUFFO1lBQ2xDLE1BQU0sRUFBRSxzQkFBc0IsQ0FBQyxjQUFjLENBQUMsYUFBYSxDQUFDLEdBQUcsRUFBRTtnQkFDL0QsV0FBVyxFQUFFLFlBQVk7Z0JBQ3pCLFdBQVcsRUFBRSxpQ0FBaUM7YUFDL0MsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILDZCQUE2QjtRQUM3QixJQUFJLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsRUFBRTtZQUM3QyxNQUFNLEVBQUUsc0JBQXNCLENBQUMsY0FBYyxDQUFDLFFBQVEsQ0FBQztnQkFDckQsUUFBUSxFQUFFLE9BQU87Z0JBQ2pCLElBQUksRUFBRSxLQUFLO2dCQUNYLFNBQVMsRUFBRSxJQUFJO2FBQ2hCLENBQUM7U0FDSCxDQUFDLENBQUM7UUFFSCxPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0lBR08sU0FBUyxDQUFDLEtBQTRCO1FBQzVDLG1DQUFtQztRQUNuQyxNQUFNLGNBQWMsR0FBRyxJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ2hFLElBQUksRUFBRSxXQUFXLEtBQUssQ0FBQyxXQUFXLGFBQWE7WUFDL0MsV0FBVyxFQUFFLDZDQUE2QztZQUMxRCxnQkFBZ0IsRUFBRSxNQUFNO1lBQ3hCLFNBQVMsRUFBRSxFQUFFO1lBQ2IsS0FBSyxFQUFFLFVBQVU7U0FDbEIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxNQUFNLEdBQUcsSUFBSSxLQUFLLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDakQsSUFBSSxFQUFFLFdBQVcsS0FBSyxDQUFDLFdBQVcsVUFBVTtZQUM1QyxXQUFXLEVBQUUsbUJBQW1CLEtBQUssQ0FBQyxXQUFXLGNBQWM7WUFDL0QsS0FBSyxFQUFFLFVBQVU7WUFDakIsYUFBYSxFQUFFLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRTtZQUU1QixLQUFLLEVBQUU7Z0JBQ0wsdUNBQXVDO2dCQUN2QztvQkFDRSxJQUFJLEVBQUUsa0NBQWtDO29CQUN4QyxRQUFRLEVBQUUsQ0FBQztvQkFDWCxjQUFjLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFO29CQUM1QixnQkFBZ0IsRUFBRTt3QkFDaEIsc0JBQXNCLEVBQUUsSUFBSTt3QkFDNUIsd0JBQXdCLEVBQUUsSUFBSTt3QkFDOUIsVUFBVSxFQUFFLHFCQUFxQjtxQkFDbEM7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULHlCQUF5QixFQUFFOzRCQUN6QixVQUFVLEVBQUUsS0FBSzs0QkFDakIsSUFBSSxFQUFFLDhCQUE4Qjt5QkFDckM7cUJBQ0Y7aUJBQ0Y7Z0JBRUQsMENBQTBDO2dCQUMxQztvQkFDRSxJQUFJLEVBQUUsMENBQTBDO29CQUNoRCxRQUFRLEVBQUUsQ0FBQztvQkFDWCxjQUFjLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFO29CQUM1QixnQkFBZ0IsRUFBRTt3QkFDaEIsc0JBQXNCLEVBQUUsSUFBSTt3QkFDNUIsd0JBQXdCLEVBQUUsSUFBSTt3QkFDOUIsVUFBVSxFQUFFLDZCQUE2QjtxQkFDMUM7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULHlCQUF5QixFQUFFOzRCQUN6QixVQUFVLEVBQUUsS0FBSzs0QkFDakIsSUFBSSxFQUFFLHNDQUFzQzt5QkFDN0M7cUJBQ0Y7aUJBQ0Y7Z0JBRUQsdUNBQXVDO2dCQUN2QztvQkFDRSxJQUFJLEVBQUUsZ0NBQWdDO29CQUN0QyxRQUFRLEVBQUUsQ0FBQztvQkFDWCxjQUFjLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFO29CQUM1QixnQkFBZ0IsRUFBRTt3QkFDaEIsc0JBQXNCLEVBQUUsSUFBSTt3QkFDNUIsd0JBQXdCLEVBQUUsSUFBSTt3QkFDOUIsVUFBVSxFQUFFLG1CQUFtQjtxQkFDaEM7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULHlCQUF5QixFQUFFOzRCQUN6QixVQUFVLEVBQUUsS0FBSzs0QkFDakIsSUFBSSxFQUFFLDRCQUE0Qjt5QkFDbkM7cUJBQ0Y7aUJBQ0Y7Z0JBRUQscUJBQXFCO2dCQUNyQjtvQkFDRSxJQUFJLEVBQUUsZUFBZTtvQkFDckIsUUFBUSxFQUFFLEVBQUU7b0JBQ1osTUFBTSxFQUFFLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRTtvQkFDckIsZ0JBQWdCLEVBQUU7d0JBQ2hCLHNCQUFzQixFQUFFLElBQUk7d0JBQzVCLHdCQUF3QixFQUFFLElBQUk7d0JBQzlCLFVBQVUsRUFBRSxxQkFBcUI7cUJBQ2xDO29CQUNELFNBQVMsRUFBRTt3QkFDVCxrQkFBa0IsRUFBRTs0QkFDbEIsS0FBSyxFQUFFLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUk7NEJBQ3ZELGdCQUFnQixFQUFFLElBQUk7eUJBQ3ZCO3FCQUNGO2lCQUNGO2dCQUVELHdDQUF3QztnQkFDeEMsR0FBRyxDQUFDLEtBQUssQ0FBQyxXQUFXLEtBQUssWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUN4QyxJQUFJLEVBQUUsb0JBQW9CO3dCQUMxQixRQUFRLEVBQUUsRUFBRTt3QkFDWixNQUFNLEVBQUUsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFO3dCQUNyQixnQkFBZ0IsRUFBRTs0QkFDaEIsc0JBQXNCLEVBQUUsSUFBSTs0QkFDNUIsd0JBQXdCLEVBQUUsSUFBSTs0QkFDOUIsVUFBVSxFQUFFLDBCQUEwQjt5QkFDdkM7d0JBQ0QsU0FBUyxFQUFFOzRCQUNULGlCQUFpQixFQUFFO2dDQUNqQixZQUFZLEVBQUUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsRUFBRSxxQ0FBcUM7NkJBQzlFO3lCQUNGO3FCQUNGLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2FBQ1Q7WUFFRCxnQkFBZ0IsRUFBRTtnQkFDaEIsc0JBQXNCLEVBQUUsSUFBSTtnQkFDNUIsd0JBQXdCLEVBQUUsSUFBSTtnQkFDOUIsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDLFdBQVcsVUFBVTthQUNuRDtTQUNGLENBQUMsQ0FBQztRQUVILFdBQVc7UUFDWCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsYUFBYSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUMxRCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQzVDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDNUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO1FBRXRELE9BQU8sTUFBTSxDQUFDO0lBQ2hCLENBQUM7SUFFTyxtQkFBbUI7UUFDekIsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNO1lBQUUsT0FBTztRQUV6QixJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDeEQsV0FBVyxFQUFFLElBQUksQ0FBQyxZQUFZLENBQUMsZUFBZTtZQUM5QyxTQUFTLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPO1NBQy9CLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFTyxhQUFhLENBQUMsS0FBNEI7UUFDaEQsc0JBQXNCO1FBQ3RCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVU7WUFDOUIsV0FBVyxFQUFFLGlCQUFpQjtZQUM5QixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxhQUFhO1NBQzNDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDL0IsV0FBVyxFQUFFLGtCQUFrQjtZQUMvQixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxjQUFjO1NBQzVDLENBQUMsQ0FBQztRQUVILHlCQUF5QjtRQUN6QixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUN2QyxLQUFLLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxhQUFhO1lBQ3BDLFdBQVcsRUFBRSxvQkFBb0I7WUFDakMsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsZ0JBQWdCO1NBQzlDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO1lBQ3ZDLEtBQUssRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLGFBQWE7WUFDcEMsV0FBVyxFQUFFLG9CQUFvQjtZQUNqQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxnQkFBZ0I7U0FDOUMsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDekMsS0FBSyxFQUFFLElBQUksQ0FBQyxZQUFZLENBQUMsZUFBZTtZQUN4QyxXQUFXLEVBQUUsK0JBQStCO1lBQzVDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGtCQUFrQjtTQUNoRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3pDLEtBQUssRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLG1CQUFtQjtZQUM1QyxXQUFXLEVBQUUsb0NBQW9DO1lBQ2pELFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGtCQUFrQjtTQUNoRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzVDLEtBQUssRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLGlDQUFpQztZQUMxRCxXQUFXLEVBQUUsMENBQTBDO1lBQ3ZELFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLHFCQUFxQjtTQUNuRCxDQUFDLENBQUM7UUFFSCxtQkFBbUI7UUFDbkIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsSUFBSSxDQUFDLFlBQVksQ0FBQyxXQUFXO1lBQ3BDLFdBQVcsRUFBRSxtQkFBbUI7WUFDaEMsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsa0JBQWtCO1NBQ2hELENBQUMsQ0FBQztRQUVILElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRTtZQUN0QixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO2dCQUMxQyxLQUFLLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxXQUFXO2dCQUNyQyxXQUFXLEVBQUUsb0JBQW9CO2dCQUNqQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxtQkFBbUI7YUFDakQsQ0FBQyxDQUFDO1NBQ0o7UUFFRCxtQkFBbUI7UUFDbkIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDdEMsS0FBSyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsWUFBWTtZQUNqQyxXQUFXLEVBQUUsMkJBQTJCO1lBQ3hDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGVBQWU7U0FDN0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDckMsS0FBSyxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsV0FBVztZQUNoQyxXQUFXLEVBQUUsMEJBQTBCO1lBQ3ZDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGNBQWM7U0FDNUMsQ0FBQyxDQUFDO1FBRUgsa0NBQWtDO1FBQ2xDLElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRTtZQUNwQixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO2dCQUN4QyxLQUFLLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxjQUFjO2dCQUN0QyxXQUFXLEVBQUUscUJBQXFCO2dCQUNsQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxpQkFBaUI7YUFDL0MsQ0FBQyxDQUFDO1NBQ0o7UUFFRCwwQkFBMEI7UUFDMUIsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ2YsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7Z0JBQ3RDLEtBQUssRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU87Z0JBQzFCLFdBQVcsRUFBRSxpQkFBaUI7Z0JBQzlCLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGVBQWU7YUFDN0MsQ0FBQyxDQUFDO1lBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3JDLEtBQUssRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU07Z0JBQ3pCLFdBQVcsRUFBRSxnQkFBZ0I7Z0JBQzdCLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGNBQWM7YUFDNUMsQ0FBQyxDQUFDO1NBQ0o7UUFFRCw0REFBNEQ7SUFDOUQsQ0FBQztDQUNGO0FBcmRELDRDQXFkQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgY2VydGlmaWNhdGVtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXInO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXdhZnYyJztcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMnO1xuaW1wb3J0ICogYXMgcm91dGU1M3RhcmdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0cyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGVudmlyb25tZW50OiBzdHJpbmc7XG4gIC8vIFZQQyBjb25maWd1cmF0aW9uXG4gIHZwY0lkOiBzdHJpbmc7XG4gIHB1YmxpY1N1Ym5ldElkczogc3RyaW5nW107XG4gIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogc3RyaW5nO1xuICAvLyBQbGF0Zm9ybSBjb25maWd1cmF0aW9uXG4gIGNsdXN0ZXJOYW1lPzogc3RyaW5nO1xuICByZXBvc2l0b3J5TmFtZT86IHN0cmluZztcbiAgLy8gU2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gIGVuYWJsZVdBRj86IGJvb2xlYW47XG4gIGVuYWJsZUhUVFBTPzogYm9vbGVhbjtcbiAgaG9zdGVkWm9uZUlkPzogc3RyaW5nO1xuICBiYXNlRG9tYWluPzogc3RyaW5nO1xuICBhcHBOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgRWNzUGxhdGZvcm1TdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcbiAgcHVibGljIHJlYWRvbmx5IHJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgbG9hZEJhbGFuY2VyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyO1xuICBwdWJsaWMgcmVhZG9ubHkgaHR0cExpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXI7XG4gIHB1YmxpYyByZWFkb25seSBodHRwc0xpc3RlbmVyPzogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyO1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBjZXJ0aWZpY2F0ZW1hbmFnZXIuSUNlcnRpZmljYXRlO1xuICBwdWJsaWMgcmVhZG9ubHkgd2ViQUNMPzogd2FmdjIuQ2ZuV2ViQUNMO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nR3JvdXA6IGxvZ3MuTG9nR3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFZhbGlkYXRlIGNvbmZpZ3VyYXRpb25cbiAgICBpZiAocHJvcHMuZW5hYmxlSFRUUFMgJiYgKCFwcm9wcy5iYXNlRG9tYWluIHx8ICFwcm9wcy5hcHBOYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdCYXNlIGRvbWFpbiBhbmQgYXBwIG5hbWUgYXJlIHJlcXVpcmVkIHdoZW4gSFRUUFMgaXMgZW5hYmxlZCcpO1xuICAgIH1cblxuICAgIC8vIEltcG9ydCBWUEMgYW5kIHN1Ym5ldHNcbiAgICBjb25zdCB2cGMgPSBlYzIuVnBjLmZyb21WcGNBdHRyaWJ1dGVzKHRoaXMsICdJbXBvcnRlZFZwYycsIHtcbiAgICAgIHZwY0lkOiBwcm9wcy52cGNJZCxcbiAgICAgIGF2YWlsYWJpbGl0eVpvbmVzOiBjZGsuRm4uZ2V0QXpzKCksXG4gICAgICBwdWJsaWNTdWJuZXRJZHM6IHByb3BzLnB1YmxpY1N1Ym5ldElkcyxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBMb2FkIEJhbGFuY2VyIFNlY3VyaXR5IEdyb3VwXG4gICAgY29uc3QgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cCA9IGVjMi5TZWN1cml0eUdyb3VwLmZyb21TZWN1cml0eUdyb3VwSWQoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRMb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwJyxcbiAgICAgIHByb3BzLmxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZFxuICAgICk7XG5cbiAgICAvLyBDcmVhdGUgQ2xvdWRXYXRjaCBMb2cgR3JvdXAgZm9yIHRoZSBjbHVzdGVyXG4gICAgdGhpcy5sb2dHcm91cCA9IHRoaXMuY3JlYXRlTG9nR3JvdXAocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUyBDbHVzdGVyXG4gICAgdGhpcy5jbHVzdGVyID0gdGhpcy5jcmVhdGVFY3NDbHVzdGVyKHByb3BzLCB2cGMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUiBSZXBvc2l0b3J5XG4gICAgdGhpcy5yZXBvc2l0b3J5ID0gdGhpcy5jcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBSb3V0ZTUzIEhvc3RlZCBab25lIChpZiBkb21haW4gcHJvdmlkZWQpXG4gICAgaWYgKHByb3BzLmJhc2VEb21haW4gJiYgcHJvcHMuaG9zdGVkWm9uZUlkKSB7XG4gICAgICB0aGlzLmhvc3RlZFpvbmUgPSByb3V0ZTUzLkhvc3RlZFpvbmUuZnJvbUhvc3RlZFpvbmVBdHRyaWJ1dGVzKHRoaXMsICdIb3N0ZWRab25lJywge1xuICAgICAgICBob3N0ZWRab25lSWQ6IHByb3BzLmhvc3RlZFpvbmVJZCxcbiAgICAgICAgem9uZU5hbWU6IHByb3BzLmJhc2VEb21haW4sIC8vIFVzZSBiYXNlIGRvbWFpbiBmb3IgaG9zdGVkIHpvbmVcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBTU0wgY2VydGlmaWNhdGUgKGlmIEhUVFBTIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZUhUVFBTICYmIHByb3BzLmJhc2VEb21haW4pIHtcbiAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSB0aGlzLmNyZWF0ZUNlcnRpZmljYXRlKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIHRoaXMubG9hZEJhbGFuY2VyID0gdGhpcy5jcmVhdGVBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcihwcm9wcywgdnBjLCBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwKTtcblxuICAgIC8vIENyZWF0ZSBsaXN0ZW5lcnNcbiAgICB0aGlzLmh0dHBMaXN0ZW5lciA9IHRoaXMuY3JlYXRlSHR0cExpc3RlbmVyKCk7XG4gICAgaWYgKHByb3BzLmVuYWJsZUhUVFBTICYmIHRoaXMuY2VydGlmaWNhdGUpIHtcbiAgICAgIHRoaXMuaHR0cHNMaXN0ZW5lciA9IHRoaXMuY3JlYXRlSHR0cHNMaXN0ZW5lcigpO1xuICAgIH1cblxuICAgIC8vIE5vdGU6IFJvdXRlNTMgRE5TIHJlY29yZHMgYXJlIG5vdyBtYW5hZ2VkIGJ5IEFwcGxpY2F0aW9uU3RhY2tcblxuICAgIC8vIENyZWF0ZSBXQUYgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVdBRikge1xuICAgICAgdGhpcy53ZWJBQ0wgPSB0aGlzLmNyZWF0ZVdBRihwcm9wcyk7XG4gICAgICB0aGlzLmFzc29jaWF0ZVdBRldpdGhBTEIoKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgc3RhY2sgb3V0cHV0c1xuICAgIHRoaXMuY3JlYXRlT3V0cHV0cyhwcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUxvZ0dyb3VwKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBsb2dzLkxvZ0dyb3VwIHtcbiAgICByZXR1cm4gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0Vjc0xvZ0dyb3VwJywge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9lY3MvdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICByZXRlbnRpb246IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAgICA6IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjc0NsdXN0ZXIocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcywgdnBjOiBlYzIuSVZwYyk6IGVjcy5DbHVzdGVyIHtcbiAgICBjb25zdCBjbHVzdGVyTmFtZSA9IHByb3BzLmNsdXN0ZXJOYW1lIHx8IGB0ZXN0YXBwLWNsdXN0ZXItJHtwcm9wcy5lbnZpcm9ubWVudH1gO1xuICAgIFxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0Vjc0NsdXN0ZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBjbHVzdGVyTmFtZSxcbiAgICAgIGVuYWJsZUZhcmdhdGVDYXBhY2l0eVByb3ZpZGVyczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBjb250YWluZXIgaW5zaWdodHMgaWYgcHJvZHVjdGlvblxuICAgIGlmIChwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nKSB7XG4gICAgICBjbHVzdGVyLmFkZERlZmF1bHRDbG91ZE1hcE5hbWVzcGFjZSh7XG4gICAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihjbHVzdGVyKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihjbHVzdGVyKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtUGxhdGZvcm0nKTtcblxuICAgIHJldHVybiBjbHVzdGVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBlY3IuUmVwb3NpdG9yeSB7XG4gICAgY29uc3QgcmVwb3NpdG9yeU5hbWUgPSBwcm9wcy5yZXBvc2l0b3J5TmFtZSB8fCBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWA7XG4gICAgXG4gICAgY29uc3QgcmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnRWNyUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgaW1hZ2VUYWdNdXRhYmlsaXR5OiBlY3IuVGFnTXV0YWJpbGl0eS5NVVRBQkxFLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ0RlbGV0ZSB1bnRhZ2dlZCBpbWFnZXMgYWZ0ZXIgMSBkYXknLFxuICAgICAgICAgIHRhZ1N0YXR1czogZWNyLlRhZ1N0YXR1cy5VTlRBR0dFRCxcbiAgICAgICAgICBtYXhJbWFnZUFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBydWxlUHJpb3JpdHk6IDIsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICB0YWdTdGF0dXM6IGVjci5UYWdTdGF0dXMuQU5ZLFxuICAgICAgICAgIG1heEltYWdlQ291bnQ6IDEwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHJlcG9zaXRvcnkpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YocmVwb3NpdG9yeSkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YocmVwb3NpdG9yeSkuYWRkKCdDb21wb25lbnQnLCAnQ29udGFpbmVyLVJlZ2lzdHJ5Jyk7XG5cbiAgICByZXR1cm4gcmVwb3NpdG9yeTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ2VydGlmaWNhdGUocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcyk6IGNlcnRpZmljYXRlbWFuYWdlci5JQ2VydGlmaWNhdGUge1xuICAgIC8vIGJhc2VEb21haW4gaXMgZ3VhcmFudGVlZCB0byBleGlzdCBkdWUgdG8gY29uc3RydWN0b3IgdmFsaWRhdGlvblxuICAgIGlmICghcHJvcHMuYmFzZURvbWFpbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdCYXNlIGRvbWFpbiBpcyByZXF1aXJlZCBmb3IgY2VydGlmaWNhdGUgY3JlYXRpb24nKTtcbiAgICB9XG4gICAgXG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBuZXcgY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlKHRoaXMsICdTU0xDZXJ0aWZpY2F0ZScsIHtcbiAgICAgIGRvbWFpbk5hbWU6IHByb3BzLmJhc2VEb21haW4sXG4gICAgICBzdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogW2AqLiR7cHJvcHMuYmFzZURvbWFpbn1gXSxcbiAgICAgIHZhbGlkYXRpb246IHRoaXMuaG9zdGVkWm9uZSBcbiAgICAgICAgPyBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnModGhpcy5ob3N0ZWRab25lKVxuICAgICAgICA6IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucygpLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoY2VydGlmaWNhdGUpLmFkZCgnQ29tcG9uZW50JywgJ1NTTC1DZXJ0aWZpY2F0ZScpO1xuXG4gICAgcmV0dXJuIGNlcnRpZmljYXRlO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcihcbiAgICBwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzLCBcbiAgICB2cGM6IGVjMi5JVnBjLCBcbiAgICBzZWN1cml0eUdyb3VwOiBlYzIuSVNlY3VyaXR5R3JvdXBcbiAgKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlciB7XG4gICAgY29uc3QgYWxiID0gbmV3IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgJ0FwcGxpY2F0aW9uTG9hZEJhbGFuY2VyJywge1xuICAgICAgdnBjLFxuICAgICAgaW50ZXJuZXRGYWNpbmc6IHRydWUsXG4gICAgICBzZWN1cml0eUdyb3VwLFxuICAgICAgbG9hZEJhbGFuY2VyTmFtZTogYHRlc3RhcHAtYWxiLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKGFsYikuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ0NvbXBvbmVudCcsICdMb2FkLUJhbGFuY2VyJyk7XG5cbiAgICByZXR1cm4gYWxiO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVIdHRwTGlzdGVuZXIoKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyIHtcbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwTGlzdGVuZXInLCB7XG4gICAgICBwb3J0OiA4MCxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICB9KTtcblxuICAgIC8vIERlZmF1bHQgYWN0aW9uIC0gd2lsbCBiZSBvdmVycmlkZGVuIGJ5IGFwcGxpY2F0aW9uIHN0YWNrXG4gICAgbGlzdGVuZXIuYWRkQWN0aW9uKCdEZWZhdWx0QWN0aW9uJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoNTAzLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlSHR0cHNMaXN0ZW5lcigpOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIge1xuICAgIC8vIGNlcnRpZmljYXRlIGlzIGd1YXJhbnRlZWQgdG8gZXhpc3Qgd2hlbiB0aGlzIG1ldGhvZCBpcyBjYWxsZWRcbiAgICBpZiAoIXRoaXMuY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2VydGlmaWNhdGUgaXMgcmVxdWlyZWQgZm9yIEhUVFBTIGxpc3RlbmVyIGNyZWF0aW9uJyk7XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IGxpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBzTGlzdGVuZXInLCB7XG4gICAgICBwb3J0OiA0NDMsXG4gICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFBTLFxuICAgICAgY2VydGlmaWNhdGVzOiBbdGhpcy5jZXJ0aWZpY2F0ZV0sXG4gICAgfSk7XG5cbiAgICAvLyBEZWZhdWx0IGFjdGlvbiAtIHdpbGwgYmUgb3ZlcnJpZGRlbiBieSBhcHBsaWNhdGlvbiBzdGFja1xuICAgIGxpc3RlbmVyLmFkZEFjdGlvbignRGVmYXVsdEFjdGlvbicsIHtcbiAgICAgIGFjdGlvbjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckFjdGlvbi5maXhlZFJlc3BvbnNlKDUwMywge1xuICAgICAgICBjb250ZW50VHlwZTogJ3RleHQvcGxhaW4nLFxuICAgICAgICBtZXNzYWdlQm9keTogJ1NlcnZpY2UgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUnLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgSFRUUCB0byBIVFRQUyByZWRpcmVjdFxuICAgIHRoaXMuaHR0cExpc3RlbmVyLmFkZEFjdGlvbignUmVkaXJlY3RUb0h0dHBzJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLnJlZGlyZWN0KHtcbiAgICAgICAgcHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgIHBvcnQ6ICc0NDMnLFxuICAgICAgICBwZXJtYW5lbnQ6IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG5cbiAgcHJpdmF0ZSBjcmVhdGVXQUYocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcyk6IHdhZnYyLkNmbldlYkFDTCB7XG4gICAgLy8gQ3JlYXRlIElQIHNldHMgZm9yIHJhdGUgbGltaXRpbmdcbiAgICBjb25zdCBpcFNldEFsbG93TGlzdCA9IG5ldyB3YWZ2Mi5DZm5JUFNldCh0aGlzLCAnSVBTZXRBbGxvd0xpc3QnLCB7XG4gICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS1hbGxvdy1saXN0YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWxsb3dlZCBJUCBhZGRyZXNzZXMgZm9yIGhpZ2hlciByYXRlIGxpbWl0cycsXG4gICAgICBpcEFkZHJlc3NWZXJzaW9uOiAnSVBWNCcsXG4gICAgICBhZGRyZXNzZXM6IFtdLCAvLyBDYW4gYmUgcG9wdWxhdGVkIHdpdGggdHJ1c3RlZCBJUHNcbiAgICAgIHNjb3BlOiAnUkVHSU9OQUwnLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgd2ViQUNMID0gbmV3IHdhZnYyLkNmbldlYkFDTCh0aGlzLCAnV2ViQUNMJywge1xuICAgICAgbmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0td2ViLWFjbGAsXG4gICAgICBkZXNjcmlwdGlvbjogYFdBRiBmb3IgVGVzdEFwcCAke3Byb3BzLmVudmlyb25tZW50fSBlbnZpcm9ubWVudGAsXG4gICAgICBzY29wZTogJ1JFR0lPTkFMJyxcbiAgICAgIGRlZmF1bHRBY3Rpb246IHsgYWxsb3c6IHt9IH0sXG4gICAgICBcbiAgICAgIHJ1bGVzOiBbXG4gICAgICAgIC8vIEFXUyBNYW5hZ2VkIFJ1bGUgU2V0IC0gQ29yZSBSdWxlIFNldFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMSxcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnQ29tbW9uUnVsZVNldE1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgdmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0JyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgXG4gICAgICAgIC8vIEFXUyBNYW5hZ2VkIFJ1bGUgU2V0IC0gS25vd24gQmFkIElucHV0c1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLFxuICAgICAgICAgIHByaW9yaXR5OiAyLFxuICAgICAgICAgIG92ZXJyaWRlQWN0aW9uOiB7IG5vbmU6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdLbm93bkJhZElucHV0c1J1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIFNRTCBJbmplY3Rpb25cbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzU1FMaVJ1bGVTZXQnLFxuICAgICAgICAgIHByaW9yaXR5OiAzLFxuICAgICAgICAgIG92ZXJyaWRlQWN0aW9uOiB7IG5vbmU6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdTUUxpUnVsZVNldE1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgdmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gUmF0ZSBsaW1pdGluZyBydWxlXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUmF0ZUxpbWl0UnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDEwLFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1JhdGVMaW1pdFJ1bGVNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICByYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgbGltaXQ6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyAyMDAwIDogMTAwMCxcbiAgICAgICAgICAgICAgYWdncmVnYXRlS2V5VHlwZTogJ0lQJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBHZW9ncmFwaGljIHJlc3RyaWN0aW9uIGZvciBwcm9kdWN0aW9uXG4gICAgICAgIC4uLihwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gW3tcbiAgICAgICAgICBuYW1lOiAnR2VvUmVzdHJpY3Rpb25SdWxlJyxcbiAgICAgICAgICBwcmlvcml0eTogMTUsXG4gICAgICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnR2VvUmVzdHJpY3Rpb25SdWxlTWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgZ2VvTWF0Y2hTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgY291bnRyeUNvZGVzOiBbJ0NOJywgJ1JVJywgJ0tQJywgJ0lSJ10sIC8vIEJsb2NrIHNwZWNpZmljIGhpZ2gtcmlzayBjb3VudHJpZXNcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0gOiBbXSksXG4gICAgICBdLFxuXG4gICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgbWV0cmljTmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0td2ViLWFjbGAsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnQ29tcG9uZW50JywgJ1dBRicpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdQdXJwb3NlJywgJ0REb1MtUHJvdGVjdGlvbicpO1xuXG4gICAgcmV0dXJuIHdlYkFDTDtcbiAgfVxuXG4gIHByaXZhdGUgYXNzb2NpYXRlV0FGV2l0aEFMQigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMud2ViQUNMKSByZXR1cm47XG5cbiAgICBuZXcgd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24odGhpcywgJ1dlYkFDTEFzc29jaWF0aW9uJywge1xuICAgICAgcmVzb3VyY2VBcm46IHRoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckFybixcbiAgICAgIHdlYkFjbEFybjogdGhpcy53ZWJBQ0wuYXR0ckFybixcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlT3V0cHV0cyhwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgLy8gRUNTIENsdXN0ZXIgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsdXN0ZXJBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NsdXN0ZXJOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2x1c3Rlci5jbHVzdGVyTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2x1c3Rlck5hbWVgLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1JlcG9zaXRvcnlBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5yZXBvc2l0b3J5LnJlcG9zaXRvcnlBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUiBSZXBvc2l0b3J5IEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUmVwb3NpdG9yeUFybmAsXG4gICAgfSk7XG5cbiAgICAvLyBMb2FkIEJhbGFuY2VyIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9hZEJhbGFuY2VyQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvYWRCYWxhbmNlckFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9hZEJhbGFuY2VyRE5TJywge1xuICAgICAgdmFsdWU6IHRoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckRuc05hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgRE5TIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvYWRCYWxhbmNlckROU2AsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9hZEJhbGFuY2VyWm9uZUlkJywge1xuICAgICAgdmFsdWU6IHRoaXMubG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckNhbm9uaWNhbEhvc3RlZFpvbmVJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBIb3N0ZWQgWm9uZSBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9hZEJhbGFuY2VyWm9uZUlkYCxcbiAgICB9KTtcblxuICAgIC8vIExpc3RlbmVyIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSHR0cExpc3RlbmVyQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuaHR0cExpc3RlbmVyLmxpc3RlbmVyQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdIVFRQIExpc3RlbmVyIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSHR0cExpc3RlbmVyQXJuYCxcbiAgICB9KTtcblxuICAgIGlmICh0aGlzLmh0dHBzTGlzdGVuZXIpIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdIdHRwc0xpc3RlbmVyQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5odHRwc0xpc3RlbmVyLmxpc3RlbmVyQXJuLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0hUVFBTIExpc3RlbmVyIEFSTicsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1IdHRwc0xpc3RlbmVyQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIExvZyBHcm91cCBvdXRwdXRcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9nR3JvdXBOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMubG9nR3JvdXAubG9nR3JvdXBOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2dHcm91cE5hbWVgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvZ0dyb3VwQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMubG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTG9nIEdyb3VwIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9nR3JvdXBBcm5gLFxuICAgIH0pO1xuXG4gICAgLy8gQ2VydGlmaWNhdGUgb3V0cHV0IChpZiBlbmFibGVkKVxuICAgIGlmICh0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2VydGlmaWNhdGVBcm4nLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLmNlcnRpZmljYXRlLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1NTTCBDZXJ0aWZpY2F0ZSBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2VydGlmaWNhdGVBcm5gLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gV0FGIG91dHB1dCAoaWYgZW5hYmxlZClcbiAgICBpZiAodGhpcy53ZWJBQ0wpIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdXQUZXZWJBQ0xBcm4nLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLndlYkFDTC5hdHRyQXJuLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1dBRiBXZWIgQUNMIEFSTicsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1XQUZXZWJBQ0xBcm5gLFxuICAgICAgfSk7XG5cbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdXQUZXZWJBQ0xJZCcsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMud2ViQUNMLmF0dHJJZCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBJRCcsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1XQUZXZWJBQ0xJZGAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBTEIgRE5TIG91dHB1dCBhbHJlYWR5IGNyZWF0ZWQgYWJvdmUgLSByZW1vdmluZyBkdXBsaWNhdGVcbiAgfVxufSJdfQ==