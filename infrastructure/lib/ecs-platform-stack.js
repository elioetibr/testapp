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
        // Validate configuration for domain-based HTTPS
        if (props.baseDomain && !props.appName) {
            throw new Error('App name is required when base domain is provided');
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
        // Create SSL certificate (if domain provided)
        if (props.baseDomain) {
            this.certificate = this.createCertificate(props);
        }
        // Create Application Load Balancer
        this.loadBalancer = this.createApplicationLoadBalancer(props, vpc, loadBalancerSecurityGroup);
        // Create listeners - HTTPS is mandatory, HTTP redirects to HTTPS
        this.httpListener = this.createHttpListener();
        // Always try to create HTTPS listener
        if (this.certificate) {
            // Use custom certificate for production with domain
            this.httpsListener = this.createHttpsListener();
            this.addHttpToHttpsRedirect();
        }
        else {
            // Try to create HTTPS listener with imported certificate
            try {
                this.httpsListener = this.createHttpsListenerWithImportedCert(props);
                this.addHttpToHttpsRedirect();
            }
            catch (error) {
                console.warn(`⚠️  HTTPS listener not created: ${error}`);
                console.warn(`   Application will be available on HTTP only temporarily.`);
                console.warn(`   For production-ready deployment, provide a certificate ARN via context or configure baseDomain.`);
            }
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
        const repositoryName = props.repositoryName || 'testapp';
        // Import existing ECR repository instead of creating a new one
        const repository = ecr.Repository.fromRepositoryName(this, 'EcrRepository', repositoryName);
        // Note: Lifecycle rules and other settings must be configured manually
        // for imported repositories or through a separate stack
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
        // Note: Redirect logic will be added after HTTPS listener is created (if successful)
        // Default action - will be overridden by application stack or redirect
        listener.addAction('DefaultAction', {
            action: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
                contentType: 'text/plain',
                messageBody: 'Service temporarily unavailable',
            }),
        });
        return listener;
    }
    addHttpToHttpsRedirect() {
        // Add redirect rule for all paths
        this.httpListener.addAction('RedirectToHttps', {
            action: elasticloadbalancingv2.ListenerAction.redirect({
                protocol: 'HTTPS',
                port: '443',
                permanent: true,
            }),
            conditions: [
                elasticloadbalancingv2.ListenerCondition.pathPatterns(['*']),
            ],
            priority: 1,
        });
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
        return listener;
    }
    createHttpsListenerWithImportedCert(props) {
        // For development environments without custom domain, try to import an existing certificate
        // or provide instructions for manual certificate creation
        const certificateArn = props.certificateArn || this.node.tryGetContext('certificateArn');
        if (!certificateArn) {
            // Log instructions for manual certificate setup
            console.warn(`⚠️  HTTPS enabled for ${props.environment} but no certificate ARN provided.`);
            console.warn(`   To enable HTTPS, create a certificate in ACM manually and provide the ARN via:`);
            console.warn(`   - Context: --context certificateArn=arn:aws:acm:region:account:certificate/xxx`);
            console.warn(`   - Or add certificateArn to EcsPlatformStackProps`);
            console.warn(`   For now, falling back to HTTP-only configuration.`);
            throw new Error(`Certificate ARN required for HTTPS in ${props.environment} environment. See console warnings for setup instructions.`);
        }
        // Import existing certificate
        const certificate = certificatemanager.Certificate.fromCertificateArn(this, 'ImportedCertificate', certificateArn);
        const listener = this.loadBalancer.addListener('HttpsListener', {
            port: 443,
            protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
            certificates: [certificate],
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZWNzLXBsYXRmb3JtLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsaUZBQWlGO0FBQ2pGLHlFQUF5RTtBQUN6RSwrQ0FBK0M7QUFDL0MsbURBQW1EO0FBcUJuRCxNQUFhLGdCQUFpQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBWTdDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFHeEIsZ0RBQWdEO1FBQ2hELElBQUksS0FBSyxDQUFDLFVBQVUsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUU7WUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO1NBQ3RFO1FBRUQseUJBQXlCO1FBQ3pCLE1BQU0sR0FBRyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUN6RCxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUs7WUFDbEIsaUJBQWlCLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUU7WUFDbEMsZUFBZSxFQUFFLEtBQUssQ0FBQyxlQUFlO1NBQ3ZDLENBQUMsQ0FBQztRQUVILHNDQUFzQztRQUN0QyxNQUFNLHlCQUF5QixHQUFHLEdBQUcsQ0FBQyxhQUFhLENBQUMsbUJBQW1CLENBQ3JFLElBQUksRUFBRSxtQ0FBbUMsRUFDekMsS0FBSyxDQUFDLDJCQUEyQixDQUNsQyxDQUFDO1FBRUYsOENBQThDO1FBQzlDLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUUzQyxxQkFBcUI7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ZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBlbGFzdGljbG9hZGJhbGFuY2luZ3YyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGNlcnRpZmljYXRlbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyJztcbmltcG9ydCAqIGFzIHdhZnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy13YWZ2Mic7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzJztcbmltcG9ydCAqIGFzIHJvdXRlNTN0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWNzUGxhdGZvcm1TdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBlbnZpcm9ubWVudDogc3RyaW5nO1xuICAvLyBWUEMgY29uZmlndXJhdGlvblxuICB2cGNJZDogc3RyaW5nO1xuICBwdWJsaWNTdWJuZXRJZHM6IHN0cmluZ1tdO1xuICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6IHN0cmluZztcbiAgLy8gUGxhdGZvcm0gY29uZmlndXJhdGlvblxuICBjbHVzdGVyTmFtZT86IHN0cmluZztcbiAgcmVwb3NpdG9yeU5hbWU/OiBzdHJpbmc7XG4gIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICBlbmFibGVXQUY/OiBib29sZWFuO1xuICBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcbiAgaG9zdGVkWm9uZUlkPzogc3RyaW5nO1xuICBiYXNlRG9tYWluPzogc3RyaW5nO1xuICBhcHBOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgRWNzUGxhdGZvcm1TdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcbiAgcHVibGljIHJlYWRvbmx5IHJlcG9zaXRvcnk6IGVjci5JUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGxvYWRCYWxhbmNlcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcjtcbiAgcHVibGljIHJlYWRvbmx5IGh0dHBMaXN0ZW5lcjogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyO1xuICBwdWJsaWMgcmVhZG9ubHkgaHR0cHNMaXN0ZW5lcj86IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25MaXN0ZW5lcjtcbiAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZTtcbiAgcHVibGljIHJlYWRvbmx5IHdlYkFDTD86IHdhZnYyLkNmbldlYkFDTDtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ0dyb3VwOiBsb2dzLkxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cblxuICAgIC8vIFZhbGlkYXRlIGNvbmZpZ3VyYXRpb24gZm9yIGRvbWFpbi1iYXNlZCBIVFRQU1xuICAgIGlmIChwcm9wcy5iYXNlRG9tYWluICYmICFwcm9wcy5hcHBOYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FwcCBuYW1lIGlzIHJlcXVpcmVkIHdoZW4gYmFzZSBkb21haW4gaXMgcHJvdmlkZWQnKTtcbiAgICB9XG5cbiAgICAvLyBJbXBvcnQgVlBDIGFuZCBzdWJuZXRzXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tVnBjQXR0cmlidXRlcyh0aGlzLCAnSW1wb3J0ZWRWcGMnLCB7XG4gICAgICB2cGNJZDogcHJvcHMudnBjSWQsXG4gICAgICBhdmFpbGFiaWxpdHlab25lczogY2RrLkZuLmdldEF6cygpLFxuICAgICAgcHVibGljU3VibmV0SWRzOiBwcm9wcy5wdWJsaWNTdWJuZXRJZHMsXG4gICAgfSk7XG5cbiAgICAvLyBJbXBvcnQgTG9hZCBCYWxhbmNlciBTZWN1cml0eSBHcm91cFxuICAgIGNvbnN0IGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXAgPSBlYzIuU2VjdXJpdHlHcm91cC5mcm9tU2VjdXJpdHlHcm91cElkKFxuICAgICAgdGhpcywgJ0ltcG9ydGVkTG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cCcsXG4gICAgICBwcm9wcy5sb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWRcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIENsb3VkV2F0Y2ggTG9nIEdyb3VwIGZvciB0aGUgY2x1c3RlclxuICAgIHRoaXMubG9nR3JvdXAgPSB0aGlzLmNyZWF0ZUxvZ0dyb3VwKHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBFQ1MgQ2x1c3RlclxuICAgIHRoaXMuY2x1c3RlciA9IHRoaXMuY3JlYXRlRWNzQ2x1c3Rlcihwcm9wcywgdnBjKTtcblxuICAgIC8vIENyZWF0ZSBFQ1IgUmVwb3NpdG9yeVxuICAgIHRoaXMucmVwb3NpdG9yeSA9IHRoaXMuY3JlYXRlRWNyUmVwb3NpdG9yeShwcm9wcyk7XG5cbiAgICAvLyBDcmVhdGUgUm91dGU1MyBIb3N0ZWQgWm9uZSAoaWYgZG9tYWluIHByb3ZpZGVkKVxuICAgIGlmIChwcm9wcy5iYXNlRG9tYWluICYmIHByb3BzLmhvc3RlZFpvbmVJZCkge1xuICAgICAgdGhpcy5ob3N0ZWRab25lID0gcm91dGU1My5Ib3N0ZWRab25lLmZyb21Ib3N0ZWRab25lQXR0cmlidXRlcyh0aGlzLCAnSG9zdGVkWm9uZScsIHtcbiAgICAgICAgaG9zdGVkWm9uZUlkOiBwcm9wcy5ob3N0ZWRab25lSWQsXG4gICAgICAgIHpvbmVOYW1lOiBwcm9wcy5iYXNlRG9tYWluLCAvLyBVc2UgYmFzZSBkb21haW4gZm9yIGhvc3RlZCB6b25lXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgU1NMIGNlcnRpZmljYXRlIChpZiBkb21haW4gcHJvdmlkZWQpXG4gICAgaWYgKHByb3BzLmJhc2VEb21haW4pIHtcbiAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSB0aGlzLmNyZWF0ZUNlcnRpZmljYXRlKHByb3BzKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIHRoaXMubG9hZEJhbGFuY2VyID0gdGhpcy5jcmVhdGVBcHBsaWNhdGlvbkxvYWRCYWxhbmNlcihwcm9wcywgdnBjLCBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwKTtcblxuICAgIC8vIENyZWF0ZSBsaXN0ZW5lcnMgLSBIVFRQUyBpcyBtYW5kYXRvcnksIEhUVFAgcmVkaXJlY3RzIHRvIEhUVFBTXG4gICAgdGhpcy5odHRwTGlzdGVuZXIgPSB0aGlzLmNyZWF0ZUh0dHBMaXN0ZW5lcigpO1xuICAgIFxuICAgIC8vIEFsd2F5cyB0cnkgdG8gY3JlYXRlIEhUVFBTIGxpc3RlbmVyXG4gICAgaWYgKHRoaXMuY2VydGlmaWNhdGUpIHtcbiAgICAgIC8vIFVzZSBjdXN0b20gY2VydGlmaWNhdGUgZm9yIHByb2R1Y3Rpb24gd2l0aCBkb21haW5cbiAgICAgIHRoaXMuaHR0cHNMaXN0ZW5lciA9IHRoaXMuY3JlYXRlSHR0cHNMaXN0ZW5lcigpO1xuICAgICAgdGhpcy5hZGRIdHRwVG9IdHRwc1JlZGlyZWN0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFRyeSB0byBjcmVhdGUgSFRUUFMgbGlzdGVuZXIgd2l0aCBpbXBvcnRlZCBjZXJ0aWZpY2F0ZVxuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5odHRwc0xpc3RlbmVyID0gdGhpcy5jcmVhdGVIdHRwc0xpc3RlbmVyV2l0aEltcG9ydGVkQ2VydChwcm9wcyk7XG4gICAgICAgIHRoaXMuYWRkSHR0cFRvSHR0cHNSZWRpcmVjdCgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS53YXJuKGDimqDvuI8gIEhUVFBTIGxpc3RlbmVyIG5vdCBjcmVhdGVkOiAke2Vycm9yfWApO1xuICAgICAgICBjb25zb2xlLndhcm4oYCAgIEFwcGxpY2F0aW9uIHdpbGwgYmUgYXZhaWxhYmxlIG9uIEhUVFAgb25seSB0ZW1wb3JhcmlseS5gKTtcbiAgICAgICAgY29uc29sZS53YXJuKGAgICBGb3IgcHJvZHVjdGlvbi1yZWFkeSBkZXBsb3ltZW50LCBwcm92aWRlIGEgY2VydGlmaWNhdGUgQVJOIHZpYSBjb250ZXh0IG9yIGNvbmZpZ3VyZSBiYXNlRG9tYWluLmApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE5vdGU6IFJvdXRlNTMgRE5TIHJlY29yZHMgYXJlIG5vdyBtYW5hZ2VkIGJ5IEFwcGxpY2F0aW9uU3RhY2tcblxuICAgIC8vIENyZWF0ZSBXQUYgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHByb3BzLmVuYWJsZVdBRikge1xuICAgICAgdGhpcy53ZWJBQ0wgPSB0aGlzLmNyZWF0ZVdBRihwcm9wcyk7XG4gICAgICB0aGlzLmFzc29jaWF0ZVdBRldpdGhBTEIoKTtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgc3RhY2sgb3V0cHV0c1xuICAgIHRoaXMuY3JlYXRlT3V0cHV0cyhwcm9wcyk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUxvZ0dyb3VwKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBsb2dzLkxvZ0dyb3VwIHtcbiAgICByZXR1cm4gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0Vjc0xvZ0dyb3VwJywge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9lY3MvdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICByZXRlbnRpb246IHByb3BzLmVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgXG4gICAgICAgID8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAgICA6IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjc0NsdXN0ZXIocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcywgdnBjOiBlYzIuSVZwYyk6IGVjcy5DbHVzdGVyIHtcbiAgICBjb25zdCBjbHVzdGVyTmFtZSA9IHByb3BzLmNsdXN0ZXJOYW1lIHx8IGB0ZXN0YXBwLWNsdXN0ZXItJHtwcm9wcy5lbnZpcm9ubWVudH1gO1xuICAgIFxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ0Vjc0NsdXN0ZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBjbHVzdGVyTmFtZSxcbiAgICAgIGVuYWJsZUZhcmdhdGVDYXBhY2l0eVByb3ZpZGVyczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBjb250YWluZXIgaW5zaWdodHMgaWYgcHJvZHVjdGlvblxuICAgIGlmIChwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nKSB7XG4gICAgICBjbHVzdGVyLmFkZERlZmF1bHRDbG91ZE1hcE5hbWVzcGFjZSh7XG4gICAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9YCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdFbnZpcm9ubWVudCcsIHByb3BzLmVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZihjbHVzdGVyKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihjbHVzdGVyKS5hZGQoJ0NvbXBvbmVudCcsICdFQ1MtUGxhdGZvcm0nKTtcblxuICAgIHJldHVybiBjbHVzdGVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiBlY3IuSVJlcG9zaXRvcnkge1xuICAgIGNvbnN0IHJlcG9zaXRvcnlOYW1lID0gcHJvcHMucmVwb3NpdG9yeU5hbWUgfHwgJ3Rlc3RhcHAnO1xuICAgIFxuICAgIC8vIEltcG9ydCBleGlzdGluZyBFQ1IgcmVwb3NpdG9yeSBpbnN0ZWFkIG9mIGNyZWF0aW5nIGEgbmV3IG9uZVxuICAgIGNvbnN0IHJlcG9zaXRvcnkgPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUoXG4gICAgICB0aGlzLCAnRWNyUmVwb3NpdG9yeScsXG4gICAgICByZXBvc2l0b3J5TmFtZVxuICAgICk7XG4gICAgXG4gICAgLy8gTm90ZTogTGlmZWN5Y2xlIHJ1bGVzIGFuZCBvdGhlciBzZXR0aW5ncyBtdXN0IGJlIGNvbmZpZ3VyZWQgbWFudWFsbHlcbiAgICAvLyBmb3IgaW1wb3J0ZWQgcmVwb3NpdG9yaWVzIG9yIHRocm91Z2ggYSBzZXBhcmF0ZSBzdGFja1xuICAgIHJldHVybiByZXBvc2l0b3J5O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDZXJ0aWZpY2F0ZShwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZSB7XG4gICAgLy8gYmFzZURvbWFpbiBpcyBndWFyYW50ZWVkIHRvIGV4aXN0IGR1ZSB0byBjb25zdHJ1Y3RvciB2YWxpZGF0aW9uXG4gICAgaWYgKCFwcm9wcy5iYXNlRG9tYWluKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Jhc2UgZG9tYWluIGlzIHJlcXVpcmVkIGZvciBjZXJ0aWZpY2F0ZSBjcmVhdGlvbicpO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG5ldyBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGUodGhpcywgJ1NTTENlcnRpZmljYXRlJywge1xuICAgICAgZG9tYWluTmFtZTogcHJvcHMuYmFzZURvbWFpbixcbiAgICAgIHN1YmplY3RBbHRlcm5hdGl2ZU5hbWVzOiBbYCouJHtwcm9wcy5iYXNlRG9tYWlufWBdLFxuICAgICAgdmFsaWRhdGlvbjogdGhpcy5ob3N0ZWRab25lIFxuICAgICAgICA/IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyh0aGlzLmhvc3RlZFpvbmUpXG4gICAgICAgIDogY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKCksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGNlcnRpZmljYXRlKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKGNlcnRpZmljYXRlKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdDb21wb25lbnQnLCAnU1NMLUNlcnRpZmljYXRlJyk7XG5cbiAgICByZXR1cm4gY2VydGlmaWNhdGU7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKFxuICAgIHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMsIFxuICAgIHZwYzogZWMyLklWcGMsIFxuICAgIHNlY3VyaXR5R3JvdXA6IGVjMi5JU2VjdXJpdHlHcm91cFxuICApOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyIHtcbiAgICBjb25zdCBhbGIgPSBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnQXBwbGljYXRpb25Mb2FkQmFsYW5jZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXAsXG4gICAgICBsb2FkQmFsYW5jZXJOYW1lOiBgdGVzdGFwcC1hbGItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihhbGIpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihhbGIpLmFkZCgnQ29tcG9uZW50JywgJ0xvYWQtQmFsYW5jZXInKTtcblxuICAgIHJldHVybiBhbGI7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUh0dHBMaXN0ZW5lcigpOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIge1xuICAgIGNvbnN0IGxpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDgwLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgIH0pO1xuXG4gICAgLy8gTm90ZTogUmVkaXJlY3QgbG9naWMgd2lsbCBiZSBhZGRlZCBhZnRlciBIVFRQUyBsaXN0ZW5lciBpcyBjcmVhdGVkIChpZiBzdWNjZXNzZnVsKVxuICAgIC8vIERlZmF1bHQgYWN0aW9uIC0gd2lsbCBiZSBvdmVycmlkZGVuIGJ5IGFwcGxpY2F0aW9uIHN0YWNrIG9yIHJlZGlyZWN0XG4gICAgbGlzdGVuZXIuYWRkQWN0aW9uKCdEZWZhdWx0QWN0aW9uJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoNTAzLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgYWRkSHR0cFRvSHR0cHNSZWRpcmVjdCgpOiB2b2lkIHtcbiAgICAvLyBBZGQgcmVkaXJlY3QgcnVsZSBmb3IgYWxsIHBhdGhzXG4gICAgdGhpcy5odHRwTGlzdGVuZXIuYWRkQWN0aW9uKCdSZWRpcmVjdFRvSHR0cHMnLCB7XG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24ucmVkaXJlY3Qoe1xuICAgICAgICBwcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgICAgcG9ydDogJzQ0MycsXG4gICAgICAgIHBlcm1hbmVudDogdHJ1ZSxcbiAgICAgIH0pLFxuICAgICAgY29uZGl0aW9uczogW1xuICAgICAgICBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQ29uZGl0aW9uLnBhdGhQYXR0ZXJucyhbJyonXSksXG4gICAgICBdLFxuICAgICAgcHJpb3JpdHk6IDEsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUh0dHBzTGlzdGVuZXIoKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyIHtcbiAgICAvLyBjZXJ0aWZpY2F0ZSBpcyBndWFyYW50ZWVkIHRvIGV4aXN0IHdoZW4gdGhpcyBtZXRob2QgaXMgY2FsbGVkXG4gICAgaWYgKCF0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NlcnRpZmljYXRlIGlzIHJlcXVpcmVkIGZvciBIVFRQUyBsaXN0ZW5lciBjcmVhdGlvbicpO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwc0xpc3RlbmVyJywge1xuICAgICAgcG9ydDogNDQzLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgIGNlcnRpZmljYXRlczogW3RoaXMuY2VydGlmaWNhdGVdLFxuICAgIH0pO1xuXG4gICAgLy8gRGVmYXVsdCBhY3Rpb24gLSB3aWxsIGJlIG92ZXJyaWRkZW4gYnkgYXBwbGljYXRpb24gc3RhY2tcbiAgICBsaXN0ZW5lci5hZGRBY3Rpb24oJ0RlZmF1bHRBY3Rpb24nLCB7XG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZml4ZWRSZXNwb25zZSg1MDMsIHtcbiAgICAgICAgY29udGVudFR5cGU6ICd0ZXh0L3BsYWluJyxcbiAgICAgICAgbWVzc2FnZUJvZHk6ICdTZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlJyxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxpc3RlbmVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVIdHRwc0xpc3RlbmVyV2l0aEltcG9ydGVkQ2VydChwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyIHtcbiAgICAvLyBGb3IgZGV2ZWxvcG1lbnQgZW52aXJvbm1lbnRzIHdpdGhvdXQgY3VzdG9tIGRvbWFpbiwgdHJ5IHRvIGltcG9ydCBhbiBleGlzdGluZyBjZXJ0aWZpY2F0ZVxuICAgIC8vIG9yIHByb3ZpZGUgaW5zdHJ1Y3Rpb25zIGZvciBtYW51YWwgY2VydGlmaWNhdGUgY3JlYXRpb25cbiAgICBjb25zdCBjZXJ0aWZpY2F0ZUFybiA9IHByb3BzLmNlcnRpZmljYXRlQXJuIHx8IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdjZXJ0aWZpY2F0ZUFybicpO1xuICAgIFxuICAgIGlmICghY2VydGlmaWNhdGVBcm4pIHtcbiAgICAgIC8vIExvZyBpbnN0cnVjdGlvbnMgZm9yIG1hbnVhbCBjZXJ0aWZpY2F0ZSBzZXR1cFxuICAgICAgY29uc29sZS53YXJuKGDimqDvuI8gIEhUVFBTIGVuYWJsZWQgZm9yICR7cHJvcHMuZW52aXJvbm1lbnR9IGJ1dCBubyBjZXJ0aWZpY2F0ZSBBUk4gcHJvdmlkZWQuYCk7XG4gICAgICBjb25zb2xlLndhcm4oYCAgIFRvIGVuYWJsZSBIVFRQUywgY3JlYXRlIGEgY2VydGlmaWNhdGUgaW4gQUNNIG1hbnVhbGx5IGFuZCBwcm92aWRlIHRoZSBBUk4gdmlhOmApO1xuICAgICAgY29uc29sZS53YXJuKGAgICAtIENvbnRleHQ6IC0tY29udGV4dCBjZXJ0aWZpY2F0ZUFybj1hcm46YXdzOmFjbTpyZWdpb246YWNjb3VudDpjZXJ0aWZpY2F0ZS94eHhgKTtcbiAgICAgIGNvbnNvbGUud2FybihgICAgLSBPciBhZGQgY2VydGlmaWNhdGVBcm4gdG8gRWNzUGxhdGZvcm1TdGFja1Byb3BzYCk7XG4gICAgICBjb25zb2xlLndhcm4oYCAgIEZvciBub3csIGZhbGxpbmcgYmFjayB0byBIVFRQLW9ubHkgY29uZmlndXJhdGlvbi5gKTtcbiAgICAgIFxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBDZXJ0aWZpY2F0ZSBBUk4gcmVxdWlyZWQgZm9yIEhUVFBTIGluICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50LiBTZWUgY29uc29sZSB3YXJuaW5ncyBmb3Igc2V0dXAgaW5zdHJ1Y3Rpb25zLmApO1xuICAgIH1cblxuICAgIC8vIEltcG9ydCBleGlzdGluZyBjZXJ0aWZpY2F0ZVxuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgIHRoaXMsICdJbXBvcnRlZENlcnRpZmljYXRlJywgXG4gICAgICBjZXJ0aWZpY2F0ZUFyblxuICAgICk7XG5cbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwc0xpc3RlbmVyJywge1xuICAgICAgcG9ydDogNDQzLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgIGNlcnRpZmljYXRlczogW2NlcnRpZmljYXRlXSxcbiAgICB9KTtcblxuICAgIC8vIERlZmF1bHQgYWN0aW9uIC0gd2lsbCBiZSBvdmVycmlkZGVuIGJ5IGFwcGxpY2F0aW9uIHN0YWNrXG4gICAgbGlzdGVuZXIuYWRkQWN0aW9uKCdEZWZhdWx0QWN0aW9uJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoNTAzLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlV0FGKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiB3YWZ2Mi5DZm5XZWJBQ0wge1xuICAgIC8vIENyZWF0ZSBJUCBzZXRzIGZvciByYXRlIGxpbWl0aW5nXG4gICAgY29uc3QgaXBTZXRBbGxvd0xpc3QgPSBuZXcgd2FmdjIuQ2ZuSVBTZXQodGhpcywgJ0lQU2V0QWxsb3dMaXN0Jywge1xuICAgICAgbmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tYWxsb3ctbGlzdGAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FsbG93ZWQgSVAgYWRkcmVzc2VzIGZvciBoaWdoZXIgcmF0ZSBsaW1pdHMnLFxuICAgICAgaXBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgYWRkcmVzc2VzOiBbXSwgLy8gQ2FuIGJlIHBvcHVsYXRlZCB3aXRoIHRydXN0ZWQgSVBzXG4gICAgICBzY29wZTogJ1JFR0lPTkFMJyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHdlYkFDTCA9IG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcywgJ1dlYkFDTCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgZGVzY3JpcHRpb246IGBXQUYgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICBkZWZhdWx0QWN0aW9uOiB7IGFsbG93OiB7fSB9LFxuICAgICAgXG4gICAgICBydWxlczogW1xuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIENvcmUgUnVsZSBTZXRcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDEsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0NvbW1vblJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFxuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIEtub3duIEJhZCBJbnB1dHNcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMixcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnS25vd25CYWRJbnB1dHNSdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBTUUwgSW5qZWN0aW9uXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMyxcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnU1FMaVJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzU1FMaVJ1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFJhdGUgbGltaXRpbmcgcnVsZVxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1JhdGVMaW1pdFJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiAxMCxcbiAgICAgICAgICBhY3Rpb246IHsgYmxvY2s6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdSYXRlTGltaXRSdWxlTWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgcmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGxpbWl0OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gMjAwMCA6IDEwMDAsXG4gICAgICAgICAgICAgIGFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gR2VvZ3JhcGhpYyByZXN0cmljdGlvbiBmb3IgcHJvZHVjdGlvblxuICAgICAgICAuLi4ocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IFt7XG4gICAgICAgICAgbmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDE1LFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIGdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGNvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCcsICdJUiddLCAvLyBCbG9jayBzcGVjaWZpYyBoaWdoLXJpc2sgY291bnRyaWVzXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dIDogW10pLFxuICAgICAgXSxcblxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIG1ldHJpY05hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0NvbXBvbmVudCcsICdXQUYnKTtcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnUHVycG9zZScsICdERG9TLVByb3RlY3Rpb24nKTtcblxuICAgIHJldHVybiB3ZWJBQ0w7XG4gIH1cblxuICBwcml2YXRlIGFzc29jaWF0ZVdBRldpdGhBTEIoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLndlYkFDTCkgcmV0dXJuO1xuXG4gICAgbmV3IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uKHRoaXMsICdXZWJBQ0xBc3NvY2lhdGlvbicsIHtcbiAgICAgIHJlc291cmNlQXJuOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICB3ZWJBY2xBcm46IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIEVDUyBDbHVzdGVyIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3RlckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbHVzdGVyQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsdXN0ZXJOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5QXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5QXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJlcG9zaXRvcnlBcm5gLFxuICAgIH0pO1xuXG4gICAgLy8gTG9hZCBCYWxhbmNlciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJETlNgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlclpvbmVJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJDYW5vbmljYWxIb3N0ZWRab25lSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgSG9zdGVkIFpvbmUgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvYWRCYWxhbmNlclpvbmVJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBMaXN0ZW5lciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0h0dHBMaXN0ZW5lckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmh0dHBMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnSFRUUCBMaXN0ZW5lciBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUh0dHBMaXN0ZW5lckFybmAsXG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5odHRwc0xpc3RlbmVyKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSHR0cHNMaXN0ZW5lckFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuaHR0cHNMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdIVFRQUyBMaXN0ZW5lciBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSHR0cHNMaXN0ZW5lckFybmAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBMb2cgR3JvdXAgb3V0cHV0XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvZ0dyb3VwTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBMb2cgR3JvdXAgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9nR3JvdXBOYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2dHcm91cEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvZ0dyb3VwQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIENlcnRpZmljYXRlIG91dHB1dCAoaWYgZW5hYmxlZClcbiAgICBpZiAodGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NlcnRpZmljYXRlQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5jZXJ0aWZpY2F0ZS5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNlcnRpZmljYXRlQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFdBRiBvdXRwdXQgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMud2ViQUNMKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy53ZWJBQ0wuYXR0ckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMQXJuYCxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMSWQnLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLndlYkFDTC5hdHRySWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgSUQnLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMSWRgLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQUxCIEROUyBvdXRwdXQgYWxyZWFkeSBjcmVhdGVkIGFib3ZlIC0gcmVtb3ZpbmcgZHVwbGljYXRlXG4gIH1cbn0iXX0=