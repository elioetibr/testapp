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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZWNzLXBsYXRmb3JtLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsaUZBQWlGO0FBQ2pGLHlFQUF5RTtBQUN6RSwrQ0FBK0M7QUFDL0MsbURBQW1EO0FBQ25ELGtFQUFrRTtBQW1CbEUsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQVc3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLHlCQUF5QjtRQUN6QixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDekQsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ2xCLGlCQUFpQixFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxFQUFFO1lBQ2xDLGVBQWUsRUFBRSxLQUFLLENBQUMsZUFBZTtTQUN2QyxDQUFDLENBQUM7UUFFSCxzQ0FBc0M7UUFDdEMsTUFBTSx5QkFBeUIsR0FBRyxHQUFHLENBQUMsYUFBYSxDQUFDLG1CQUFtQixDQUNyRSxJQUFJLEVBQUUsbUNBQW1DLEVBQ3pDLEtBQUssQ0FBQywyQkFBMkIsQ0FDbEMsQ0FBQztRQUVGLDhDQUE4QztRQUM5QyxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFM0MscUJBQXFCO1FBQ3JCLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUVqRCx3QkFBd0I7UUFDeEIsSUFBSSxDQUFDLFVB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QUFFO2dCQUMxQyxXQUFXLEVBQUUsaUJBQWlCO2FBQy9CLENBQUMsQ0FBQztTQUNKO2FBQU07WUFDTCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztZQUNyRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO2dCQUN4QyxLQUFLLEVBQUUsR0FBRyxRQUFRLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxtQkFBbUIsRUFBRTtnQkFDL0QsV0FBVyxFQUFFLGlCQUFpQjthQUMvQixDQUFDLENBQUM7U0FDSjtJQUNILENBQUM7Q0FDRjtBQWxmRCw0Q0FrZkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGNlcnRpZmljYXRlbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHdhZnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy13YWZ2Mic7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWNzUGxhdGZvcm1TdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICAvLyBWUEMgY29uZmlndXJhdGlvblxuICB2cGNJZDogc3RyaW5nO1xuICBwdWJsaWNTdWJuZXRJZHM6IHN0cmluZ1tdO1xuICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6IHN0cmluZztcbiAgLy8gUGxhdGZvcm0gY29uZmlndXJhdGlvblxuICBjbHVzdGVyTmFtZT86IHN0cmluZztcbiAgcmVwb3NpdG9yeU5hbWU/OiBzdHJpbmc7XG4gIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICBlbmFibGVXQUY/OiBib29sZWFuO1xuICBlbmFibGVIVFRQUz86IGJvb2xlYW47XG4gIGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIGhvc3RlZFpvbmVJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEVjc1BsYXRmb3JtU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgY2x1c3RlcjogZWNzLkNsdXN0ZXI7XG4gIHB1YmxpYyByZWFkb25seSByZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGxvYWRCYWxhbmNlcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcjtcbiAgcHVibGljIHJlYWRvbmx5IGh0dHBMaXN0ZW5lcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyO1xuICBwdWJsaWMgcmVhZG9ubHkgaHR0cHNMaXN0ZW5lcj86IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lcjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHdlYkFDTD86IHdhZnYyLkNmbldlYkFDTDtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ0dyb3VwOiBsb2dzLkxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gSW1wb3J0IFZQQyBhbmQgc3VibmV0c1xuICAgIGNvbnN0IHZwYyA9IGVjMi5WcGMuZnJvbVZwY0F0dHJpYnV0ZXModGhpcywgJ0ltcG9ydGVkVnBjJywge1xuICAgICAgdnBjSWQ6IHByb3BzLnZwY0lkLFxuICAgICAgYXZhaWxhYmlsaXR5Wm9uZXM6IGNkay5Gbi5nZXRBenMoKSxcbiAgICAgIHB1YmxpY1N1Ym5ldElkczogcHJvcHMucHVibGljU3VibmV0SWRzLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IExvYWQgQmFsYW5jZXIgU2VjdXJpdHkgR3JvdXBcbiAgICBjb25zdCBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwID0gZWMyLlNlY3VyaXR5R3JvdXAuZnJvbVNlY3VyaXR5R3JvdXBJZChcbiAgICAgIHRoaXMsICdJbXBvcnRlZExvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXAnLFxuICAgICAgcHJvcHMubG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBDbG91ZFdhdGNoIExvZyBHcm91cCBmb3IgdGhlIGNsdXN0ZXJcbiAgICB0aGlzLmxvZ0dyb3VwID0gdGhpcy5jcmVhdGVMb2dHcm91cChwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgRUNTIENsdXN0ZXJcbiAgICB0aGlzLmNsdXN0ZXIgPSB0aGlzLmNyZWF0ZUVjc0NsdXN0ZXIocHJvcHMsIHZwYyk7XG5cbiAgICAvLyBDcmVhdGUgRUNSIFJlcG9zaXRvcnlcbiAgICB0aGlzLnJlcG9zaXRvcnkgPSB0aGlzLmNyZWF0ZUVjclJlcG9zaXRvcnkocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIFJvdXRlNTMgSG9zdGVkIFpvbmUgKGlmIGRvbWFpbiBwcm92aWRlZClcbiAgICBpZiAocHJvcHMuZG9tYWluTmFtZSAmJiBwcm9wcy5ob3N0ZWRab25lSWQpIHtcbiAgICAgIHRoaXMuaG9zdGVkWm9uZSA9IHJvdXRlNTMuSG9zdGVkWm9uZS5mcm9tSG9zdGVkWm9uZUF0dHJpYnV0ZXModGhpcywgJ0hvc3RlZFpvbmUnLCB7XG4gICAgICAgIGhvc3RlZFpvbmVJZDogcHJvcHMuaG9zdGVkWm9uZUlkLFxuICAgICAgICB6b25lTmFtZTogcHJvcHMuZG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBTU0wgY2VydGlmaWNhdGUgKGlmIEhUVFBTIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZUhUVFBTICYmIHByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSB0aGlzLmNyZWF0ZUNlcnRpZmljYXRlKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIHRoaXMubG9hZEJhbGFuY2VyID0gdGhpcy5jcmVhdGVBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcihwcm9wcywgdnBjLCBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwKTtcblxuICAgIC8vIENyZWF0ZSBsaXN0ZW5lcnNcbiAgICB0aGlzLmh0dHBMaXN0ZW5lciA9IHRoaXMuY3JlYXRlSHR0cExpc3RlbmVyKCk7XG4gICAgaWYgKHByb3BzLmVuYWJsZUhUVFBTICYmIHRoaXMuY2VydGlmaWNhdGUpIHtcbiAgICAgIHRoaXMuaHR0cHNMaXN0ZW5lciA9IHRoaXMuY3JlYXRlSHR0cHNMaXN0ZW5lcigpO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBSb3V0ZTUzIEROUyByZWNvcmQgKGlmIGhvc3RlZCB6b25lIGV4aXN0cylcbiAgICBpZiAodGhpcy5ob3N0ZWRab25lICYmIHByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRoaXMuY3JlYXRlRG5zUmVjb3JkKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgV0FGIChpZiBlbmFibGVkKVxuICAgIGlmIChwcm9wcy5lbmFibGVXQUYpIHtcbiAgICAgIHRoaXMud2ViQUNMID0gdGhpcy5jcmVhdGVXQUYocHJvcHMpO1xuICAgICAgdGhpcy5hc3NvY2lhdGVXQUZXaXRoQUxCKCk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIHN0YWNrIG91dHB1dHNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMocHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVMb2dHcm91cChwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogbG9ncy5Mb2dHcm91cCB7XG4gICAgcmV0dXJuIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdFY3NMb2dHcm91cCcsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9hd3MvZWNzL3Rlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgcmV0ZW50aW9uOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICA/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgICAgOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3NDbHVzdGVyKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMsIHZwYzogZWMyLklWcGMpOiBlY3MuQ2x1c3RlciB7XG4gICAgY29uc3QgY2x1c3Rlck5hbWUgPSBwcm9wcy5jbHVzdGVyTmFtZSB8fCBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YDtcbiAgICBcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdFY3NDbHVzdGVyJywge1xuICAgICAgdnBjLFxuICAgICAgY2x1c3Rlck5hbWUsXG4gICAgICBlbmFibGVGYXJnYXRlQ2FwYWNpdHlQcm92aWRlcnM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29udGFpbmVyIGluc2lnaHRzIGlmIHByb2R1Y3Rpb25cbiAgICBpZiAocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJykge1xuICAgICAgY2x1c3Rlci5hZGREZWZhdWx0Q2xvdWRNYXBOYW1lc3BhY2Uoe1xuICAgICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGNsdXN0ZXIpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdDb21wb25lbnQnLCAnRUNTLVBsYXRmb3JtJyk7XG5cbiAgICByZXR1cm4gY2x1c3RlcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRWNyUmVwb3NpdG9yeShwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogZWNyLlJlcG9zaXRvcnkge1xuICAgIGNvbnN0IHJlcG9zaXRvcnlOYW1lID0gcHJvcHMucmVwb3NpdG9yeU5hbWUgfHwgYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gO1xuICAgIFxuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ0VjclJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZSxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGltYWdlVGFnTXV0YWJpbGl0eTogZWNyLlRhZ011dGFiaWxpdHkuTVVUQUJMRSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBydWxlUHJpb3JpdHk6IDEsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdEZWxldGUgdW50YWdnZWQgaW1hZ2VzIGFmdGVyIDEgZGF5JyxcbiAgICAgICAgICB0YWdTdGF0dXM6IGVjci5UYWdTdGF0dXMuVU5UQUdHRUQsXG4gICAgICAgICAgbWF4SW1hZ2VBZ2U6IGNkay5EdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgcnVsZVByaW9yaXR5OiAyLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsXG4gICAgICAgICAgdGFnU3RhdHVzOiBlY3IuVGFnU3RhdHVzLkFOWSxcbiAgICAgICAgICBtYXhJbWFnZUNvdW50OiAxMCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTiBcbiAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihyZXBvc2l0b3J5KS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHJlcG9zaXRvcnkpLmFkZCgnTWFuYWdlZEJ5JywgJ0NESycpO1xuICAgIGNkay5UYWdzLm9mKHJlcG9zaXRvcnkpLmFkZCgnQ29tcG9uZW50JywgJ0NvbnRhaW5lci1SZWdpc3RyeScpO1xuXG4gICAgcmV0dXJuIHJlcG9zaXRvcnk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNlcnRpZmljYXRlKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBjZXJ0aWZpY2F0ZW1hbmFnZXIuSUNlcnRpZmljYXRlIHtcbiAgICBpZiAoIXByb3BzLmRvbWFpbk5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRG9tYWluIG5hbWUgaXMgcmVxdWlyZWQgd2hlbiBIVFRQUyBpcyBlbmFibGVkJyk7XG4gICAgfVxuXG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBuZXcgY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlKHRoaXMsICdTU0xDZXJ0aWZpY2F0ZScsIHtcbiAgICAgIGRvbWFpbk5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICBzdWJqZWN0QWx0ZXJuYXRpdmVOYW1lczogW2AqLiR7cHJvcHMuZG9tYWluTmFtZX1gXSxcbiAgICAgIHZhbGlkYXRpb246IHRoaXMuaG9zdGVkWm9uZSBcbiAgICAgICAgPyBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnModGhpcy5ob3N0ZWRab25lKVxuICAgICAgICA6IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucygpLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoY2VydGlmaWNhdGUpLmFkZCgnQ29tcG9uZW50JywgJ1NTTC1DZXJ0aWZpY2F0ZScpO1xuXG4gICAgcmV0dXJuIGNlcnRpZmljYXRlO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcihcbiAgICBwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzLCBcbiAgICB2cGM6IGVjMi5JVnBjLCBcbiAgICBzZWN1cml0eUdyb3VwOiBlYzIuSVNlY3VyaXR5R3JvdXBcbiAgKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlciB7XG4gICAgY29uc3QgYWxiID0gbmV3IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgJ0FwcGxpY2F0aW9uTG9hZEJhbGFuY2VyJywge1xuICAgICAgdnBjLFxuICAgICAgaW50ZXJuZXRGYWNpbmc6IHRydWUsXG4gICAgICBzZWN1cml0eUdyb3VwLFxuICAgICAgbG9hZEJhbGFuY2VyTmFtZTogYHRlc3RhcHAtYWxiLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKGFsYikuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ0NvbXBvbmVudCcsICdMb2FkLUJhbGFuY2VyJyk7XG5cbiAgICByZXR1cm4gYWxiO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVIdHRwTGlzdGVuZXIoKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyIHtcbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwTGlzdGVuZXInLCB7XG4gICAgICBwb3J0OiA4MCxcbiAgICAgIHByb3RvY29sOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICB9KTtcblxuICAgIC8vIERlZmF1bHQgYWN0aW9uIC0gd2lsbCBiZSBvdmVycmlkZGVuIGJ5IGFwcGxpY2F0aW9uIHN0YWNrXG4gICAgbGlzdGVuZXIuYWRkQWN0aW9uKCdEZWZhdWx0QWN0aW9uJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoNTAzLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlSHR0cHNMaXN0ZW5lcigpOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIge1xuICAgIGlmICghdGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdDZXJ0aWZpY2F0ZSBpcyByZXF1aXJlZCBmb3IgSFRUUFMgbGlzdGVuZXInKTtcbiAgICB9XG5cbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwc0xpc3RlbmVyJywge1xuICAgICAgcG9ydDogNDQzLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgIGNlcnRpZmljYXRlczogW3RoaXMuY2VydGlmaWNhdGVdLFxuICAgIH0pO1xuXG4gICAgLy8gRGVmYXVsdCBhY3Rpb24gLSB3aWxsIGJlIG92ZXJyaWRkZW4gYnkgYXBwbGljYXRpb24gc3RhY2tcbiAgICBsaXN0ZW5lci5hZGRBY3Rpb24oJ0RlZmF1bHRBY3Rpb24nLCB7XG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZml4ZWRSZXNwb25zZSg1MDMsIHtcbiAgICAgICAgY29udGVudFR5cGU6ICd0ZXh0L3BsYWluJyxcbiAgICAgICAgbWVzc2FnZUJvZHk6ICdTZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlJyxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEhUVFAgdG8gSFRUUFMgcmVkaXJlY3RcbiAgICB0aGlzLmh0dHBMaXN0ZW5lci5hZGRBY3Rpb24oJ1JlZGlyZWN0VG9IdHRwcycsIHtcbiAgICAgIGFjdGlvbjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5MaXN0ZW5lckFjdGlvbi5yZWRpcmVjdCh7XG4gICAgICAgIHByb3RvY29sOiAnSFRUUFMnLFxuICAgICAgICBwb3J0OiAnNDQzJyxcbiAgICAgICAgcGVybWFuZW50OiB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGlzdGVuZXI7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZURuc1JlY29yZChwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmhvc3RlZFpvbmUgfHwgIXByb3BzLmRvbWFpbk5hbWUpIHJldHVybjtcblxuICAgIC8vIENyZWF0ZSBBIHJlY29yZCBmb3IgdGhlIGRvbWFpblxuICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgJ0Ruc0FSZWNvcmQnLCB7XG4gICAgICB6b25lOiB0aGlzLmhvc3RlZFpvbmUsXG4gICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMoXG4gICAgICAgIG5ldyByb3V0ZTUzdGFyZ2V0cy5Mb2FkQmFsYW5jZXJUYXJnZXQodGhpcy5sb2FkQmFsYW5jZXIpXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIEFBQUEgcmVjb3JkIGZvciBJUHY2IChpZiBBTEIgc3VwcG9ydHMgaXQpXG4gICAgbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCAnRG5zQWFhYVJlY29yZCcsIHtcbiAgICAgIHpvbmU6IHRoaXMuaG9zdGVkWm9uZSxcbiAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhcbiAgICAgICAgbmV3IHJvdXRlNTN0YXJnZXRzLkxvYWRCYWxhbmNlclRhcmdldCh0aGlzLmxvYWRCYWxhbmNlcilcbiAgICAgICksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVdBRihwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogd2FmdjIuQ2ZuV2ViQUNMIHtcbiAgICAvLyBDcmVhdGUgSVAgc2V0cyBmb3IgcmF0ZSBsaW1pdGluZ1xuICAgIGNvbnN0IGlwU2V0QWxsb3dMaXN0ID0gbmV3IHdhZnYyLkNmbklQU2V0KHRoaXMsICdJUFNldEFsbG93TGlzdCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LWFsbG93LWxpc3RgLFxuICAgICAgZGVzY3JpcHRpb246ICdBbGxvd2VkIElQIGFkZHJlc3NlcyBmb3IgaGlnaGVyIHJhdGUgbGltaXRzJyxcbiAgICAgIGlwQWRkcmVzc1ZlcnNpb246ICdJUFY0JyxcbiAgICAgIGFkZHJlc3NlczogW10sIC8vIENhbiBiZSBwb3B1bGF0ZWQgd2l0aCB0cnVzdGVkIElQc1xuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgfSk7XG5cbiAgICBjb25zdCB3ZWJBQ0wgPSBuZXcgd2FmdjIuQ2ZuV2ViQUNMKHRoaXMsICdXZWJBQ0wnLCB7XG4gICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS13ZWItYWNsYCxcbiAgICAgIGRlc2NyaXB0aW9uOiBgV0FGIGZvciBUZXN0QXBwICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCxcbiAgICAgIHNjb3BlOiAnUkVHSU9OQUwnLFxuICAgICAgZGVmYXVsdEFjdGlvbjogeyBhbGxvdzoge30gfSxcbiAgICAgIFxuICAgICAgcnVsZXM6IFtcbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBDb3JlIFJ1bGUgU2V0XG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgIHByaW9yaXR5OiAxLFxuICAgICAgICAgIG92ZXJyaWRlQWN0aW9uOiB7IG5vbmU6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdDb21tb25SdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBcbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBLbm93biBCYWQgSW5wdXRzXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDIsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0tub3duQmFkSW5wdXRzUnVsZVNldE1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgdmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIEFXUyBNYW5hZ2VkIFJ1bGUgU2V0IC0gU1FMIEluamVjdGlvblxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FXUy1BV1NNYW5hZ2VkUnVsZXNTUUxpUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDMsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ1NRTGlSdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0JyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBSYXRlIGxpbWl0aW5nIHJ1bGVcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdSYXRlTGltaXRSdWxlJyxcbiAgICAgICAgICBwcmlvcml0eTogMTAsXG4gICAgICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnUmF0ZUxpbWl0UnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIHJhdGVCYXNlZFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBsaW1pdDogcHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IDIwMDAgOiAxMDAwLFxuICAgICAgICAgICAgICBhZ2dyZWdhdGVLZXlUeXBlOiAnSVAnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIEdlb2dyYXBoaWMgcmVzdHJpY3Rpb24gZm9yIHByb2R1Y3Rpb25cbiAgICAgICAgLi4uKHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBbe1xuICAgICAgICAgIG5hbWU6ICdHZW9SZXN0cmljdGlvblJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiAxNSxcbiAgICAgICAgICBhY3Rpb246IHsgYmxvY2s6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdHZW9SZXN0cmljdGlvblJ1bGVNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBnZW9NYXRjaFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICBjb3VudHJ5Q29kZXM6IFsnQ04nLCAnUlUnLCAnS1AnLCAnSVInXSwgLy8gQmxvY2sgc3BlY2lmaWMgaGlnaC1yaXNrIGNvdW50cmllc1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSA6IFtdKSxcbiAgICAgIF0sXG5cbiAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICBtZXRyaWNOYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fS13ZWItYWNsYCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnTWFuYWdlZEJ5JywgJ0NESycpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdDb21wb25lbnQnLCAnV0FGJyk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ1B1cnBvc2UnLCAnRERvUy1Qcm90ZWN0aW9uJyk7XG5cbiAgICByZXR1cm4gd2ViQUNMO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3NvY2lhdGVXQUZXaXRoQUxCKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy53ZWJBQ0wpIHJldHVybjtcblxuICAgIG5ldyB3YWZ2Mi5DZm5XZWJBQ0xBc3NvY2lhdGlvbih0aGlzLCAnV2ViQUNMQXNzb2NpYXRpb24nLCB7XG4gICAgICByZXNvdXJjZUFybjogdGhpcy5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgd2ViQWNsQXJuOiB0aGlzLndlYkFDTC5hdHRyQXJuLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVPdXRwdXRzKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiB2b2lkIHtcbiAgICAvLyBFQ1MgQ2x1c3RlciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NsdXN0ZXJBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2x1c3RlckFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3Rlck5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbHVzdGVyLmNsdXN0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgQ2x1c3RlciBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbHVzdGVyTmFtZWAsXG4gICAgfSk7XG5cbiAgICAvLyBFQ1IgUmVwb3NpdG9yeSBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1JlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5yZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwb3NpdG9yeUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SZXBvc2l0b3J5QXJuYCxcbiAgICB9KTtcblxuICAgIC8vIExvYWQgQmFsYW5jZXIgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2FkQmFsYW5jZXJBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9hZEJhbGFuY2VyQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2FkQmFsYW5jZXJETlMnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBETlMgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9hZEJhbGFuY2VyRE5TYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2FkQmFsYW5jZXJab25lSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyQ2Fub25pY2FsSG9zdGVkWm9uZUlkLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEhvc3RlZCBab25lIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJab25lSWRgLFxuICAgIH0pO1xuXG4gICAgLy8gTGlzdGVuZXIgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdIdHRwTGlzdGVuZXJBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5odHRwTGlzdGVuZXIubGlzdGVuZXJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0hUVFAgTGlzdGVuZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1IdHRwTGlzdGVuZXJBcm5gLFxuICAgIH0pO1xuXG4gICAgaWYgKHRoaXMuaHR0cHNMaXN0ZW5lcikge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0h0dHBzTGlzdGVuZXJBcm4nLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLmh0dHBzTGlzdGVuZXIubGlzdGVuZXJBcm4sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnSFRUUFMgTGlzdGVuZXIgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUh0dHBzTGlzdGVuZXJBcm5gLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gTG9nIEdyb3VwIG91dHB1dFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2dHcm91cE5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sb2dHcm91cC5sb2dHcm91cE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTG9nIEdyb3VwIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvZ0dyb3VwTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTG9nR3JvdXBBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBMb2cgR3JvdXAgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2dHcm91cEFybmAsXG4gICAgfSk7XG5cbiAgICAvLyBDZXJ0aWZpY2F0ZSBvdXRwdXQgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMuY2VydGlmaWNhdGUpIHtcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDZXJ0aWZpY2F0ZUFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuY2VydGlmaWNhdGUuY2VydGlmaWNhdGVBcm4sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU1NMIENlcnRpZmljYXRlIEFSTicsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DZXJ0aWZpY2F0ZUFybmAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBXQUYgb3V0cHV0IChpZiBlbmFibGVkKVxuICAgIGlmICh0aGlzLndlYkFDTCkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1dBRldlYkFDTEFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVdBRldlYkFDTEFybmAsXG4gICAgICB9KTtcblxuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1dBRldlYkFDTElkJywge1xuICAgICAgICB2YWx1ZTogdGhpcy53ZWJBQ0wuYXR0cklkLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1dBRiBXZWIgQUNMIElEJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVdBRldlYkFDTElkYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEROUyBvdXRwdXRzIChpZiBkb21haW4gY29uZmlndXJlZClcbiAgICBpZiAocHJvcHMuZG9tYWluTmFtZSkge1xuICAgICAgY29uc3QgcHJvdG9jb2wgPSB0aGlzLmNlcnRpZmljYXRlID8gJ2h0dHBzJyA6ICdodHRwJztcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcHBsaWNhdGlvblVybCcsIHtcbiAgICAgICAgdmFsdWU6IGAke3Byb3RvY29sfTovLyR7cHJvcHMuZG9tYWluTmFtZX1gLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFVSTCcsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgcHJvdG9jb2wgPSB0aGlzLmNlcnRpZmljYXRlID8gJ2h0dHBzJyA6ICdodHRwJztcbiAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcHBsaWNhdGlvblVybCcsIHtcbiAgICAgICAgdmFsdWU6IGAke3Byb3RvY29sfTovLyR7dGhpcy5sb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZX1gLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIFVSTCcsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn0iXX0=