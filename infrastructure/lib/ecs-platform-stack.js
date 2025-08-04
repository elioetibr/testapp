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
const route53targets = require("aws-cdk-lib/aws-route53-targets");
class EcsPlatformStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Validate configuration
        if (props.enableHTTPS && !props.domainName) {
            throw new Error('Domain name is required when HTTPS is enabled');
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
        if (props.domainName && props.hostedZoneId) {
            this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
                hostedZoneId: props.hostedZoneId,
                zoneName: props.domainName,
            });
        }
        // Create SSL certificate (if HTTPS enabled)
        if (props.enableHTTPS && props.domainName) {
            this.certificate = this.createCertificate(props);
        }
        // Create Application Load Balancer
        this.loadBalancer = this.createApplicationLoadBalancer(props, vpc, loadBalancerSecurityGroup);
        // Create listeners
        this.httpListener = this.createHttpListener();
        if (props.enableHTTPS && this.certificate) {
            this.httpsListener = this.createHttpsListener();
        }
        // Create Route53 DNS record (if hosted zone exists)
        if (this.hostedZone && props.domainName) {
            this.createDnsRecord(props);
        }
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
        if (!props.domainName) {
            throw new Error('Domain name is required when HTTPS is enabled');
        }
        const certificate = new certificatemanager.Certificate(this, 'SSLCertificate', {
            domainName: props.domainName,
            subjectAlternativeNames: [`*.${props.domainName}`],
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
        if (!this.certificate) {
            throw new Error('Certificate is required for HTTPS listener');
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
    createDnsRecord(props) {
        if (!this.hostedZone || !props.domainName)
            return;
        // Create A record for the domain
        new route53.ARecord(this, 'DnsARecord', {
            zone: this.hostedZone,
            recordName: props.domainName,
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(this.loadBalancer)),
        });
        // Create AAAA record for IPv6 (if ALB supports it)
        new route53.AaaaRecord(this, 'DnsAaaaRecord', {
            zone: this.hostedZone,
            recordName: props.domainName,
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(this.loadBalancer)),
        });
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
        // DNS outputs (if domain configured)
        if (props.domainName) {
            const protocol = this.certificate ? 'https' : 'http';
            new cdk.CfnOutput(this, 'ApplicationUrl', {
                value: `${protocol}://${props.domainName}`,
                description: 'Application URL',
            });
        }
        else {
            const protocol = this.certificate ? 'https' : 'http';
            new cdk.CfnOutput(this, 'ApplicationUrl', {
                value: `${protocol}://${this.loadBalancer.loadBalancerDnsName}`,
                description: 'Application URL',
            });
        }
    }
}
exports.EcsPlatformStack = EcsPlatformStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZWNzLXBsYXRmb3JtLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsaUZBQWlGO0FBQ2pGLHlFQUF5RTtBQUN6RSwrQ0FBK0M7QUFDL0MsbURBQW1EO0FBQ25ELGtFQUFrRTtBQW1CbEUsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQVc3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLHlCQUF5QjtRQUN6QixJQUFJLEtBQUssQ0FBQyxXQUFXLElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxFQUFFO1lBQzFDLE1BQU0sSUFBSSxLQUFLLENBQUMsK0NBQStDLENBQUMsQ0FBQztTQUNsRTtRQUVELHlCQUF5QjtRQUN6QixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDekQsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ2xCLGlCQUFpQixFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFO1lBQ2xDLGVBQWUsRUFBRSxLQUFLLENBQUMsZUFBZTtTQUN2QyxDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMsTUFBTSx5QkFBeUIsR0FBRyxHQUFHLENBQUMsYUFBYSxDQUFDLG1CQUFtQixDQUNyRSxJQUFJLEVBQUUsbUNBQW1DLEVBQ3pDLEtBQUssQ0FBQywyQkFBMkIsQ0FDbEMsQ0FBQztRQUVGLDhDQUE4QztRQUM5QyxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUM7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LENBQUMsTUFBTSxDQUFDO1lBQ3JELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7Z0JBQ3hDLEtBQUssRUFBRSxHQUFHLFFBQVEsTUFBTSxLQUFLLENBQUMsVUFBVSxFQUFFO2dCQUMxQyxXQUFXLEVBQUUsaUJBQWlCO2FBQy9CLENBQUMsQ0FBQztTQUNKO2FBQU07WUFDTCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztZQUNyRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO2dCQUN4QyxLQUFLLEVBQUUsR0FBRyxRQUFRLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxtQkFBbUIsRUFBRTtnQkFDL0QsV0FBVyxFQUFFLGlCQUFpQjthQUMvQixDQUFDLENBQUM7U0FDSjtJQUNILENBQUM7Q0FDRjtBQXZmRCw0Q0F1ZkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGNlcnRpZmljYXRlbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHdhZnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy13YWZ2Mic7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWNzUGxhdGZvcm1TdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICAvLyBWUEMgY29uZmlndXJhdGlvblxuICB2cGNJZDogc3RyaW5nO1xuICBwdWJsaWNTdWJuZXRJZHM6IHN0cmluZ1tdO1xuICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6IHN0cmluZztcbiAgLy8gUGxhdGZvcm0gY29uZmlndXJhdGlvblxuICBjbHVzdGVyTmFtZT86IHN0cmluZztcbiAgcmVwb3NpdG9yeU5hbWU/OiBzdHJpbmc7XG4gIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICBlbmFibGVXQUY/OiBib29sZWFuO1xuICBlbmFibGVIVFRQUz86IGJvb2xlYW47XG4gIGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIGhvc3RlZFpvbmVJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEVjc1BsYXRmb3JtU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgY2x1c3RlcjogZWNzLkNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSByZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGxvYWRCYWxhbmNlcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcjtcbiAgcHVibGljIHJlYWRvbmx5IGh0dHBMaXN0ZW5lcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyO1xuICBwdWJsaWMgcmVhZG9ubHkgaHR0cHNMaXN0ZW5lcj86IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lcjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHdlYkFDTD86IHdhZnYyLkNmbldlYkFDTDtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ0dyb3VwOiBsb2dzLkxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gVmFsaWRhdGUgY29uZmlndXJhdGlvblxuICAgIGlmIChwcm9wcy5lbmFibGVIVFRQUyAmJiAhcHJvcHMuZG9tYWluTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdEb21haW4gbmFtZSBpcyByZXF1aXJlZCB3aGVuIEhUVFBTIGlzIGVuYWJsZWQnKTtcbiAgICB9XG5cbiAgICAvLyBJbXBvcnQgVlBDIGFuZCBzdWJuZXRzXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tVnBjQXR0cmlidXRlcyh0aGlzLCAnSW1wb3J0ZWRWcGMnLCB7XG4gICAgICB2cGNJZDogcHJvcHMudnBjSWQsXG4gICAgICBhdmFpbGFiaWxpdHlab25lczogY2RrLkZuLmdldEF6cygpLFxuICAgICAgcHVibGljU3VibmV0SWRzOiBwcm9wcy5wdWJsaWNTdWJuZXRJZHMsXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgTG9hZCBCYWxhbmNlciBTZWN1cml0eSBHcm91cFxuICAgIGNvbnN0IGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXAgPSBlYzIuU2VjdXJpdHlHcm91cC5mcm9tU2VjdXJpdHlHcm91cElkKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cCcsXG4gICAgICBwcm9wcy5sb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWRcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIENsb3VkV2F0Y2ggTG9nIEdyb3VwIGZvciB0aGUgY2x1c3RlclxuICAgIHRoaXMubG9nR3JvdXAgPSB0aGlzLmNyZWF0ZUxvZ0dyb3VwKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBFQ1MgQ2x1c3RlclxuICAgIHRoaXMuY2x1c3RlciA9IHRoaXMuY3JlYXRlRWNzQ2x1c3Rlcihwcm9wcywgdnBjKTtcblxuICAgIC8vIENyZWF0ZSBFQ1IgUmVwb3NpdG9yeVxuICAgIHRoaXMucmVwb3NpdG9yeSA9IHRoaXMuY3JlYXRlRWNyUmVwb3NpdG9yeShwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgUm91dGU1MyBIb3N0ZWQgWm9uZSAoaWYgZG9tYWluIHByb3ZpZGVkKVxuICAgIGlmIChwcm9wcy5kb21haW5OYW1lICYmIHByb3BzLmhvc3RlZFpvbmVJZCkge1xuICAgICAgdGhpcy5ob3N0ZWRab25lID0gcm91dGU1My5Ib3N0ZWRab25lLmZyb21Ib3N0ZWRab25lQXR0cmlidXRlcyh0aGlzLCAnSG9zdGVkWm9uZScsIHtcbiAgICAgICAgaG9zdGVkWm9uZUlkOiBwcm9wcy5ob3N0ZWRab25lSWQsXG4gICAgICAgIHpvbmVOYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFNTTCBjZXJ0aWZpY2F0ZSAoaWYgSFRUUFMgZW5hYmxlZClcbiAgICBpZiAocHJvcHMuZW5hYmxlSFRUUFMgJiYgcHJvcHMuZG9tYWluTmFtZSkge1xuICAgICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IHRoaXMuY3JlYXRlQ2VydGlmaWNhdGUocHJvcHMpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyXG4gICAgdGhpcy5sb2FkQmFsYW5jZXIgPSB0aGlzLmNyZWF0ZUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHByb3BzLCB2cGMsIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXApO1xuXG4gICAgLy8gQ3JlYXRlIGxpc3RlbmVyc1xuICAgIHRoaXMuaHR0cExpc3RlbmVyID0gdGhpcy5jcmVhdGVIdHRwTGlzdGVuZXIoKTtcbiAgICBpZiAocHJvcHMuZW5hYmxlSFRUUFMgJiYgdGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhpcy5odHRwc0xpc3RlbmVyID0gdGhpcy5jcmVhdGVIdHRwc0xpc3RlbmVyKCk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFJvdXRlNTMgRE5TIHJlY29yZCAoaWYgaG9zdGVkIHpvbmUgZXhpc3RzKVxuICAgIGlmICh0aGlzLmhvc3RlZFpvbmUgJiYgcHJvcHMuZG9tYWluTmFtZSkge1xuICAgICAgdGhpcy5jcmVhdGVEbnNSZWNvcmQocHJvcHMpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBXQUYgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVdBRikge1xuICAgICAgdGhpcy53ZWJBQ0wgPSB0aGlzLmNyZWF0ZVdBRihwcm9wcyk7XG4gICAgICB0aGlzLmFzc29jaWF0ZVdBRldpdGhBTEIoKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgc3RhY2sgb3V0cHV0c1xuICAgIHRoaXMuY3JlYXRlT3V0cHV0cyhwcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUxvZ0dyb3VwKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBsb2dzLkxvZ0dyb3VwIHtcbiAgICByZXR1cm4gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0Vjc0xvZ0dyb3VwJywge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9lY3MvdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICByZXRlbnRpb246IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAgICA6IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjc0NsdXN0ZXIocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcywgdnBjOiBlYzIuSVZwYyk6IGVjcy5DbHVzdGVyIHtcbiAgICBjb25zdCBjbHVzdGVyTmFtZSA9IHByb3BzLmNsdXN0ZXJOYW1lIHx8IGB0ZXN0YXBwLWNsdXN0ZXItJHtwcm9wcy5lbnZpcm9ubWVudH1gO1xuICAgIFxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0Vjc0NsdXN0ZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBjbHVzdGVyTmFtZSxcbiAgICAgIGVuYWJsZUZhcmdhdGVDYXBhY2l0eVByb3ZpZGVyczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBjb250YWluZXIgaW5zaWdodHMgaWYgcHJvZHVjdGlvblxuICAgIGlmIChwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nKSB7XG4gICAgICBjbHVzdGVyLmFkZERlZmF1bHRDbG91ZE1hcE5hbWVzcGFjZSh7XG4gICAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihjbHVzdGVyKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihjbHVzdGVyKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtUGxhdGZvcm0nKTtcblxuICAgIHJldHVybiBjbHVzdGVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBlY3IuUmVwb3NpdG9yeSB7XG4gICAgY29uc3QgcmVwb3NpdG9yeU5hbWUgPSBwcm9wcy5yZXBvc2l0b3J5TmFtZSB8fCBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWA7XG4gICAgXG4gICAgY29uc3QgcmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnRWNyUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgaW1hZ2VUYWdNdXRhYmlsaXR5OiBlY3IuVGFnTXV0YWJpbGl0eS5NVVRBQkxFLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHJ1bGVQcmlvcml0eTogMSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ0RlbGV0ZSB1bnRhZ2dlZCBpbWFnZXMgYWZ0ZXIgMSBkYXknLFxuICAgICAgICAgIHRhZ1N0YXR1czogZWNyLlRhZ1N0YXR1cy5VTlRBR0dFRCxcbiAgICAgICAgICBtYXhJbWFnZUFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBydWxlUHJpb3JpdHk6IDIsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJyxcbiAgICAgICAgICB0YWdTdGF0dXM6IGVjci5UYWdTdGF0dXMuQU5ZLFxuICAgICAgICAgIG1heEltYWdlQ291bnQ6IDEwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOIFxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHJlcG9zaXRvcnkpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YocmVwb3NpdG9yeSkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YocmVwb3NpdG9yeSkuYWRkKCdDb21wb25lbnQnLCAnQ29udGFpbmVyLVJlZ2lzdHJ5Jyk7XG5cbiAgICByZXR1cm4gcmVwb3NpdG9yeTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ2VydGlmaWNhdGUocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcyk6IGNlcnRpZmljYXRlbWFuYWdlci5JQ2VydGlmaWNhdGUge1xuICAgIGlmICghcHJvcHMuZG9tYWluTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdEb21haW4gbmFtZSBpcyByZXF1aXJlZCB3aGVuIEhUVFBTIGlzIGVuYWJsZWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG5ldyBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGUodGhpcywgJ1NTTENlcnRpZmljYXRlJywge1xuICAgICAgZG9tYWluTmFtZTogcHJvcHMuZG9tYWluTmFtZSxcbiAgICAgIHN1YmplY3RBbHRlcm5hdGl2ZU5hbWVzOiBbYCouJHtwcm9wcy5kb21haW5OYW1lfWBdLFxuICAgICAgdmFsaWRhdGlvbjogdGhpcy5ob3N0ZWRab25lIFxuICAgICAgICA/IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyh0aGlzLmhvc3RlZFpvbmUpXG4gICAgICAgIDogY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKCksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGNlcnRpZmljYXRlKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKGNlcnRpZmljYXRlKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdDb21wb25lbnQnLCAnU1NMLUNlcnRpZmljYXRlJyk7XG5cbiAgICByZXR1cm4gY2VydGlmaWNhdGU7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKFxuICAgIHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMsIFxuICAgIHZwYzogZWMyLklWcGMsIFxuICAgIHNlY3VyaXR5R3JvdXA6IGVjMi5JU2VjdXJpdHlHcm91cFxuICApOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyIHtcbiAgICBjb25zdCBhbGIgPSBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnQXBwbGljYXRpb25Mb2FkQmFsYW5jZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXAsXG4gICAgICBsb2FkQmFsYW5jZXJOYW1lOiBgdGVzdGFwcC1hbGItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihhbGIpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihhbGIpLmFkZCgnQ29tcG9uZW50JywgJ0xvYWQtQmFsYW5jZXInKTtcblxuICAgIHJldHVybiBhbGI7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUh0dHBMaXN0ZW5lcigpOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIge1xuICAgIGNvbnN0IGxpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDgwLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgIH0pO1xuXG4gICAgLy8gRGVmYXVsdCBhY3Rpb24gLSB3aWxsIGJlIG92ZXJyaWRkZW4gYnkgYXBwbGljYXRpb24gc3RhY2tcbiAgICBsaXN0ZW5lci5hZGRBY3Rpb24oJ0RlZmF1bHRBY3Rpb24nLCB7XG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZml4ZWRSZXNwb25zZSg1MDMsIHtcbiAgICAgICAgY29udGVudFR5cGU6ICd0ZXh0L3BsYWluJyxcbiAgICAgICAgbWVzc2FnZUJvZHk6ICdTZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlJyxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxpc3RlbmVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVIdHRwc0xpc3RlbmVyKCk6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lciB7XG4gICAgaWYgKCF0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NlcnRpZmljYXRlIGlzIHJlcXVpcmVkIGZvciBIVFRQUyBsaXN0ZW5lcicpO1xuICAgIH1cblxuICAgIGNvbnN0IGxpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBzTGlzdGVuZXInLCB7XG4gICAgICBwb3J0OiA0NDMsXG4gICAgICBwcm90b2NvbDogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFBTLFxuICAgICAgY2VydGlmaWNhdGVzOiBbdGhpcy5jZXJ0aWZpY2F0ZV0sXG4gICAgfSk7XG5cbiAgICAvLyBEZWZhdWx0IGFjdGlvbiAtIHdpbGwgYmUgb3ZlcnJpZGRlbiBieSBhcHBsaWNhdGlvbiBzdGFja1xuICAgIGxpc3RlbmVyLmFkZEFjdGlvbignRGVmYXVsdEFjdGlvbicsIHtcbiAgICAgIGFjdGlvbjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckFjdGlvbi5maXhlZFJlc3BvbnNlKDUwMywge1xuICAgICAgICBjb250ZW50VHlwZTogJ3RleHQvcGxhaW4nLFxuICAgICAgICBtZXNzYWdlQm9keTogJ1NlcnZpY2UgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUnLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgSFRUUCB0byBIVFRQUyByZWRpcmVjdFxuICAgIHRoaXMuaHR0cExpc3RlbmVyLmFkZEFjdGlvbignUmVkaXJlY3RUb0h0dHBzJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLnJlZGlyZWN0KHtcbiAgICAgICAgcHJvdG9jb2w6ICdIVFRQUycsXG4gICAgICAgIHBvcnQ6ICc0NDMnLFxuICAgICAgICBwZXJtYW5lbnQ6IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRG5zUmVjb3JkKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaG9zdGVkWm9uZSB8fCAhcHJvcHMuZG9tYWluTmFtZSkgcmV0dXJuO1xuXG4gICAgLy8gQ3JlYXRlIEEgcmVjb3JkIGZvciB0aGUgZG9tYWluXG4gICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCAnRG5zQVJlY29yZCcsIHtcbiAgICAgIHpvbmU6IHRoaXMuaG9zdGVkWm9uZSxcbiAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgbmV3IHJvdXRlNTN0YXJnZXRzLkxvYWRCYWxhbmNlclRhcmdldCh0aGlzLmxvYWRCYWxhbmNlcilcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgQUFBQSByZWNvcmQgZm9yIElQdjYgKGlmIEFMQiBzdXBwb3J0cyBpdClcbiAgICBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsICdEbnNBYWFhUmVjb3JkJywge1xuICAgICAgem9uZTogdGhpcy5ob3N0ZWRab25lLFxuICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluTmFtZSxcbiAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKFxuICAgICAgICBuZXcgcm91dGU1M3RhcmdldHMuTG9hZEJhbGFuY2VyVGFyZ2V0KHRoaXMubG9hZEJhbGFuY2VyKVxuICAgICAgKSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlV0FGKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiB3YWZ2Mi5DZm5XZWJBQ0wge1xuICAgIC8vIENyZWF0ZSBJUCBzZXRzIGZvciByYXRlIGxpbWl0aW5nXG4gICAgY29uc3QgaXBTZXRBbGxvd0xpc3QgPSBuZXcgd2FmdjIuQ2ZuSVBTZXQodGhpcywgJ0lQU2V0QWxsb3dMaXN0Jywge1xuICAgICAgbmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tYWxsb3ctbGlzdGAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FsbG93ZWQgSVAgYWRkcmVzc2VzIGZvciBoaWdoZXIgcmF0ZSBsaW1pdHMnLFxuICAgICAgaXBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgYWRkcmVzc2VzOiBbXSwgLy8gQ2FuIGJlIHBvcHVsYXRlZCB3aXRoIHRydXN0ZWQgSVBzXG4gICAgICBzY29wZTogJ1JFR0lPTkFMJyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHdlYkFDTCA9IG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcywgJ1dlYkFDTCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgZGVzY3JpcHRpb246IGBXQUYgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICBkZWZhdWx0QWN0aW9uOiB7IGFsbG93OiB7fSB9LFxuICAgICAgXG4gICAgICBydWxlczogW1xuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIENvcmUgUnVsZSBTZXRcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDEsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0NvbW1vblJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFxuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIEtub3duIEJhZCBJbnB1dHNcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMixcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnS25vd25CYWRJbnB1dHNSdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBTUUwgSW5qZWN0aW9uXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMyxcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnU1FMaVJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzU1FMaVJ1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFJhdGUgbGltaXRpbmcgcnVsZVxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1JhdGVMaW1pdFJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiAxMCxcbiAgICAgICAgICBhY3Rpb246IHsgYmxvY2s6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdSYXRlTGltaXRSdWxlTWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgcmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGxpbWl0OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gMjAwMCA6IDEwMDAsXG4gICAgICAgICAgICAgIGFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gR2VvZ3JhcGhpYyByZXN0cmljdGlvbiBmb3IgcHJvZHVjdGlvblxuICAgICAgICAuLi4ocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IFt7XG4gICAgICAgICAgbmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDE1LFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIGdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGNvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCcsICdJUiddLCAvLyBCbG9jayBzcGVjaWZpYyBoaWdoLXJpc2sgY291bnRyaWVzXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dIDogW10pLFxuICAgICAgXSxcblxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIG1ldHJpY05hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0NvbXBvbmVudCcsICdXQUYnKTtcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnUHVycG9zZScsICdERG9TLVByb3RlY3Rpb24nKTtcblxuICAgIHJldHVybiB3ZWJBQ0w7XG4gIH1cblxuICBwcml2YXRlIGFzc29jaWF0ZVdBRldpdGhBTEIoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLndlYkFDTCkgcmV0dXJuO1xuXG4gICAgbmV3IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uKHRoaXMsICdXZWJBQ0xBc3NvY2lhdGlvbicsIHtcbiAgICAgIHJlc291cmNlQXJuOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICB3ZWJBY2xBcm46IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIEVDUyBDbHVzdGVyIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3RlckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbHVzdGVyQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsdXN0ZXJOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5QXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5QXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJlcG9zaXRvcnlBcm5gLFxuICAgIH0pO1xuXG4gICAgLy8gTG9hZCBCYWxhbmNlciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJETlNgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlclpvbmVJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJDYW5vbmljYWxIb3N0ZWRab25lSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgSG9zdGVkIFpvbmUgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvYWRCYWxhbmNlclpvbmVJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBMaXN0ZW5lciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0h0dHBMaXN0ZW5lckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmh0dHBMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnSFRUUCBMaXN0ZW5lciBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUh0dHBMaXN0ZW5lckFybmAsXG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5odHRwc0xpc3RlbmVyKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSHR0cHNMaXN0ZW5lckFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuaHR0cHNMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdIVFRQUyBMaXN0ZW5lciBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSHR0cHNMaXN0ZW5lckFybmAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBMb2cgR3JvdXAgb3V0cHV0XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvZ0dyb3VwTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBMb2cgR3JvdXAgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9nR3JvdXBOYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2dHcm91cEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvZ0dyb3VwQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIENlcnRpZmljYXRlIG91dHB1dCAoaWYgZW5hYmxlZClcbiAgICBpZiAodGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NlcnRpZmljYXRlQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5jZXJ0aWZpY2F0ZS5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNlcnRpZmljYXRlQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFdBRiBvdXRwdXQgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMud2ViQUNMKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy53ZWJBQ0wuYXR0ckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMQXJuYCxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMSWQnLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLndlYkFDTC5hdHRySWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgSUQnLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMSWRgLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gRE5TIG91dHB1dHMgKGlmIGRvbWFpbiBjb25maWd1cmVkKVxuICAgIGlmIChwcm9wcy5kb21haW5OYW1lKSB7XG4gICAgICBjb25zdCBwcm90b2NvbCA9IHRoaXMuY2VydGlmaWNhdGUgPyAnaHR0cHMnIDogJ2h0dHAnO1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcGxpY2F0aW9uVXJsJywge1xuICAgICAgICB2YWx1ZTogYCR7cHJvdG9jb2x9Oi8vJHtwcm9wcy5kb21haW5OYW1lfWAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMJyxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBwcm90b2NvbCA9IHRoaXMuY2VydGlmaWNhdGUgPyAnaHR0cHMnIDogJ2h0dHAnO1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwcGxpY2F0aW9uVXJsJywge1xuICAgICAgICB2YWx1ZTogYCR7cHJvdG9jb2x9Oi8vJHt0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lfWAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gVVJMJyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufSJdfQ==