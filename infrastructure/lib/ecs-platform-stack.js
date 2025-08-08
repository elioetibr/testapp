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
        // Create or import Route53 Hosted Zone (if domain provided)
        if (props.baseDomain) {
            this.hostedZone = this.createOrImportHostedZone(props);
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
    createOrImportHostedZone(props) {
        if (!props.baseDomain) {
            throw new Error('Base domain is required for hosted zone creation');
        }
        // If hostedZoneId is provided, import the existing hosted zone
        if (props.hostedZoneId) {
            console.log(`📍 Importing existing hosted zone: ${props.hostedZoneId} for domain: ${props.baseDomain}`);
            return route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
                hostedZoneId: props.hostedZoneId,
                zoneName: props.baseDomain,
            });
        }
        // Create a new hosted zone
        // Note: HostedZone.fromLookup() would require the zone to exist at synthesis time
        // and would fail if it doesn't exist. Since we want to create if it doesn't exist,
        // we'll always create a new one unless hostedZoneId is explicitly provided.
        console.log(`🆕 Creating new hosted zone for domain: ${props.baseDomain}`);
        const hostedZone = new route53.HostedZone(this, 'HostedZone', {
            zoneName: props.baseDomain,
            comment: `Hosted zone for ${props.baseDomain} - managed by CDK`,
        });
        // Add tags
        cdk.Tags.of(hostedZone).add('Environment', props.environment);
        cdk.Tags.of(hostedZone).add('ManagedBy', 'CDK');
        cdk.Tags.of(hostedZone).add('Component', 'DNS-HostedZone');
        return hostedZone;
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
        // Hosted Zone outputs (if created or imported)
        if (this.hostedZone) {
            new cdk.CfnOutput(this, 'HostedZoneId', {
                value: this.hostedZone.hostedZoneId,
                description: 'Route53 Hosted Zone ID',
                exportName: `${this.stackName}-HostedZoneId`,
            });
            new cdk.CfnOutput(this, 'HostedZoneName', {
                value: this.hostedZone.zoneName,
                description: 'Route53 Hosted Zone Name',
                exportName: `${this.stackName}-HostedZoneName`,
            });
        }
        // ALB DNS output already created above - removing duplicate
    }
}
exports.EcsPlatformStack = EcsPlatformStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLXBsYXRmb3JtLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZWNzLXBsYXRmb3JtLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsaUZBQWlGO0FBQ2pGLHlFQUF5RTtBQUN6RSwrQ0FBK0M7QUFDL0MsbURBQW1EO0FBcUJuRCxNQUFhLGdCQUFpQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBWTdDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFHeEIsZ0RBQWdEO1FBQ2hELElBQUksS0FBSyxDQUFDLFVBQVUsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUU7WUFDdEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO1NBQ3RFO1FBRUQseUJBQXlCO1FBQ3pCLE1BQU0sR0FBRyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUN6RCxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUs7WUFDbEIsaUJBQWlCLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUU7WUFDbEMsZUFBZSxFQUFFLEtBQUssQ0FBQyxlQUFlO1NBQ3ZDLENBQUMsQ0FBQztRQUVILHNDQUFzQztRQUN0QyxNQUFNLHlCQUF5QixHQUFHLEdBQUcsQ0FBQyxhQUFhLENBQUMsbUJBQW1CLENBQ3JFLElBQUksRUFBRSxtQ0FBbUMsRUFDekMsS0FBSyxDQUFDLDJCQUEyQixDQUNsQyxDQUFDO1FBRUYsOENBQThDO1FBQzlDLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUUzQyxxQkFBcUI7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Z0JBQ25DLFdBQVcsRUFBRSx3QkFBd0I7Z0JBQ3JDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGVBQWU7YUFDN0MsQ0FBQyxDQUFDO1lBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtnQkFDeEMsS0FBSyxFQUFFLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUTtnQkFDL0IsV0FBVyxFQUFFLDBCQUEwQjtnQkFDdkMsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsaUJBQWlCO2FBQy9DLENBQUMsQ0FBQztTQUNKO1FBRUQsNERBQTREO0lBQzlELENBQUM7Q0FDRjtBQXppQkQsNENBeWlCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgY2VydGlmaWNhdGVtYW5hZ2VyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXInO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXdhZnYyJztcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMnO1xuaW1wb3J0ICogYXMgcm91dGU1M3RhcmdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0cyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGVudmlyb25tZW50OiBzdHJpbmc7XG4gIC8vIFZQQyBjb25maWd1cmF0aW9uXG4gIHZwY0lkOiBzdHJpbmc7XG4gIHB1YmxpY1N1Ym5ldElkczogc3RyaW5nW107XG4gIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogc3RyaW5nO1xuICAvLyBQbGF0Zm9ybSBjb25maWd1cmF0aW9uXG4gIGNsdXN0ZXJOYW1lPzogc3RyaW5nO1xuICByZXBvc2l0b3J5TmFtZT86IHN0cmluZztcbiAgLy8gU2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gIGVuYWJsZVdBRj86IGJvb2xlYW47XG4gIGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuICBob3N0ZWRab25lSWQ/OiBzdHJpbmc7XG4gIGJhc2VEb21haW4/OiBzdHJpbmc7XG4gIGFwcE5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBFY3NQbGF0Zm9ybVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGNsdXN0ZXI6IGVjcy5DbHVzdGVyO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgbG9hZEJhbGFuY2VyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyO1xuICBwdWJsaWMgcmVhZG9ubHkgaHR0cExpc3RlbmVyOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXI7XG4gIHB1YmxpYyByZWFkb25seSBodHRwc0xpc3RlbmVyPzogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyO1xuICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBjZXJ0aWZpY2F0ZW1hbmFnZXIuSUNlcnRpZmljYXRlO1xuICBwdWJsaWMgcmVhZG9ubHkgd2ViQUNMPzogd2FmdjIuQ2ZuV2ViQUNMO1xuICBwdWJsaWMgcmVhZG9ubHkgbG9nR3JvdXA6IGxvZ3MuTG9nR3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuXG4gICAgLy8gVmFsaWRhdGUgY29uZmlndXJhdGlvbiBmb3IgZG9tYWluLWJhc2VkIEhUVFBTXG4gICAgaWYgKHByb3BzLmJhc2VEb21haW4gJiYgIXByb3BzLmFwcE5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQXBwIG5hbWUgaXMgcmVxdWlyZWQgd2hlbiBiYXNlIGRvbWFpbiBpcyBwcm92aWRlZCcpO1xuICAgIH1cblxuICAgIC8vIEltcG9ydCBWUEMgYW5kIHN1Ym5ldHNcbiAgICBjb25zdCB2cGMgPSBlYzIuVnBjLmZyb21WcGNBdHRyaWJ1dGVzKHRoaXMsICdJbXBvcnRlZFZwYycsIHtcbiAgICAgIHZwY0lkOiBwcm9wcy52cGNJZCxcbiAgICAgIGF2YWlsYWJpbGl0eVpvbmVzOiBjZGsuRm4uZ2V0QXpzKCksXG4gICAgICBwdWJsaWNTdWJuZXRJZHM6IHByb3BzLnB1YmxpY1N1Ym5ldElkcyxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCBMb2FkIEJhbGFuY2VyIFNlY3VyaXR5IEdyb3VwXG4gICAgY29uc3QgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cCA9IGVjMi5TZWN1cml0eUdyb3VwLmZyb21TZWN1cml0eUdyb3VwSWQoXG4gICAgICB0aGlzLCAnSW1wb3J0ZWRMb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwJyxcbiAgICAgIHByb3BzLmxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZFxuICAgICk7XG5cbiAgICAvLyBDcmVhdGUgQ2xvdWRXYXRjaCBMb2cgR3JvdXAgZm9yIHRoZSBjbHVzdGVyXG4gICAgdGhpcy5sb2dHcm91cCA9IHRoaXMuY3JlYXRlTG9nR3JvdXAocHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUyBDbHVzdGVyXG4gICAgdGhpcy5jbHVzdGVyID0gdGhpcy5jcmVhdGVFY3NDbHVzdGVyKHByb3BzLCB2cGMpO1xuXG4gICAgLy8gQ3JlYXRlIEVDUiBSZXBvc2l0b3J5XG4gICAgdGhpcy5yZXBvc2l0b3J5ID0gdGhpcy5jcmVhdGVFY3JSZXBvc2l0b3J5KHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBvciBpbXBvcnQgUm91dGU1MyBIb3N0ZWQgWm9uZSAoaWYgZG9tYWluIHByb3ZpZGVkKVxuICAgIGlmIChwcm9wcy5iYXNlRG9tYWluKSB7XG4gICAgICB0aGlzLmhvc3RlZFpvbmUgPSB0aGlzLmNyZWF0ZU9ySW1wb3J0SG9zdGVkWm9uZShwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIFNTTCBjZXJ0aWZpY2F0ZSAoaWYgZG9tYWluIHByb3ZpZGVkKVxuICAgIGlmIChwcm9wcy5iYXNlRG9tYWluKSB7XG4gICAgICB0aGlzLmNlcnRpZmljYXRlID0gdGhpcy5jcmVhdGVDZXJ0aWZpY2F0ZShwcm9wcyk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcbiAgICB0aGlzLmxvYWRCYWxhbmNlciA9IHRoaXMuY3JlYXRlQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIocHJvcHMsIHZwYywgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cCk7XG5cbiAgICAvLyBDcmVhdGUgbGlzdGVuZXJzIC0gSFRUUFMgaXMgbWFuZGF0b3J5LCBIVFRQIHJlZGlyZWN0cyB0byBIVFRQU1xuICAgIHRoaXMuaHR0cExpc3RlbmVyID0gdGhpcy5jcmVhdGVIdHRwTGlzdGVuZXIoKTtcbiAgICBcbiAgICAvLyBBbHdheXMgdHJ5IHRvIGNyZWF0ZSBIVFRQUyBsaXN0ZW5lclxuICAgIGlmICh0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICAvLyBVc2UgY3VzdG9tIGNlcnRpZmljYXRlIGZvciBwcm9kdWN0aW9uIHdpdGggZG9tYWluXG4gICAgICB0aGlzLmh0dHBzTGlzdGVuZXIgPSB0aGlzLmNyZWF0ZUh0dHBzTGlzdGVuZXIoKTtcbiAgICAgIHRoaXMuYWRkSHR0cFRvSHR0cHNSZWRpcmVjdCgpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBUcnkgdG8gY3JlYXRlIEhUVFBTIGxpc3RlbmVyIHdpdGggaW1wb3J0ZWQgY2VydGlmaWNhdGVcbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMuaHR0cHNMaXN0ZW5lciA9IHRoaXMuY3JlYXRlSHR0cHNMaXN0ZW5lcldpdGhJbXBvcnRlZENlcnQocHJvcHMpO1xuICAgICAgICB0aGlzLmFkZEh0dHBUb0h0dHBzUmVkaXJlY3QoKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnNvbGUud2Fybihg4pqg77iPICBIVFRQUyBsaXN0ZW5lciBub3QgY3JlYXRlZDogJHtlcnJvcn1gKTtcbiAgICAgICAgY29uc29sZS53YXJuKGAgICBBcHBsaWNhdGlvbiB3aWxsIGJlIGF2YWlsYWJsZSBvbiBIVFRQIG9ubHkgdGVtcG9yYXJpbHkuYCk7XG4gICAgICAgIGNvbnNvbGUud2FybihgICAgRm9yIHByb2R1Y3Rpb24tcmVhZHkgZGVwbG95bWVudCwgcHJvdmlkZSBhIGNlcnRpZmljYXRlIEFSTiB2aWEgY29udGV4dCBvciBjb25maWd1cmUgYmFzZURvbWFpbi5gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBOb3RlOiBSb3V0ZTUzIEROUyByZWNvcmRzIGFyZSBub3cgbWFuYWdlZCBieSBBcHBsaWNhdGlvblN0YWNrXG5cbiAgICAvLyBDcmVhdGUgV0FGIChpZiBlbmFibGVkKVxuICAgIGlmIChwcm9wcy5lbmFibGVXQUYpIHtcbiAgICAgIHRoaXMud2ViQUNMID0gdGhpcy5jcmVhdGVXQUYocHJvcHMpO1xuICAgICAgdGhpcy5hc3NvY2lhdGVXQUZXaXRoQUxCKCk7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIHN0YWNrIG91dHB1dHNcbiAgICB0aGlzLmNyZWF0ZU91dHB1dHMocHJvcHMpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVMb2dHcm91cChwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogbG9ncy5Mb2dHcm91cCB7XG4gICAgcmV0dXJuIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdFY3NMb2dHcm91cCcsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9hd3MvZWNzL3Rlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgcmV0ZW50aW9uOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nIFxuICAgICAgICA/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICAgICAgOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVFY3NDbHVzdGVyKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMsIHZwYzogZWMyLklWcGMpOiBlY3MuQ2x1c3RlciB7XG4gICAgY29uc3QgY2x1c3Rlck5hbWUgPSBwcm9wcy5jbHVzdGVyTmFtZSB8fCBgdGVzdGFwcC1jbHVzdGVyLSR7cHJvcHMuZW52aXJvbm1lbnR9YDtcbiAgICBcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdFY3NDbHVzdGVyJywge1xuICAgICAgdnBjLFxuICAgICAgY2x1c3Rlck5hbWUsXG4gICAgICBlbmFibGVGYXJnYXRlQ2FwYWNpdHlQcm92aWRlcnM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29udGFpbmVyIGluc2lnaHRzIGlmIHByb2R1Y3Rpb25cbiAgICBpZiAocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJykge1xuICAgICAgY2x1c3Rlci5hZGREZWZhdWx0Q2xvdWRNYXBOYW1lc3BhY2Uoe1xuICAgICAgICBuYW1lOiBgdGVzdGFwcC0ke3Byb3BzLmVudmlyb25tZW50fWAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGNsdXN0ZXIpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoY2x1c3RlcikuYWRkKCdDb21wb25lbnQnLCAnRUNTLVBsYXRmb3JtJyk7XG5cbiAgICByZXR1cm4gY2x1c3RlcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRWNyUmVwb3NpdG9yeShwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogZWNyLklSZXBvc2l0b3J5IHtcbiAgICBjb25zdCByZXBvc2l0b3J5TmFtZSA9IHByb3BzLnJlcG9zaXRvcnlOYW1lIHx8ICd0ZXN0YXBwJztcbiAgICBcbiAgICAvLyBJbXBvcnQgZXhpc3RpbmcgRUNSIHJlcG9zaXRvcnkgaW5zdGVhZCBvZiBjcmVhdGluZyBhIG5ldyBvbmVcbiAgICBjb25zdCByZXBvc2l0b3J5ID0gZWNyLlJlcG9zaXRvcnkuZnJvbVJlcG9zaXRvcnlOYW1lKFxuICAgICAgdGhpcywgJ0VjclJlcG9zaXRvcnknLFxuICAgICAgcmVwb3NpdG9yeU5hbWVcbiAgICApO1xuICAgIFxuICAgIC8vIE5vdGU6IExpZmVjeWNsZSBydWxlcyBhbmQgb3RoZXIgc2V0dGluZ3MgbXVzdCBiZSBjb25maWd1cmVkIG1hbnVhbGx5XG4gICAgLy8gZm9yIGltcG9ydGVkIHJlcG9zaXRvcmllcyBvciB0aHJvdWdoIGEgc2VwYXJhdGUgc3RhY2tcbiAgICByZXR1cm4gcmVwb3NpdG9yeTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlT3JJbXBvcnRIb3N0ZWRab25lKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiByb3V0ZTUzLklIb3N0ZWRab25lIHtcbiAgICBpZiAoIXByb3BzLmJhc2VEb21haW4pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQmFzZSBkb21haW4gaXMgcmVxdWlyZWQgZm9yIGhvc3RlZCB6b25lIGNyZWF0aW9uJyk7XG4gICAgfVxuXG4gICAgLy8gSWYgaG9zdGVkWm9uZUlkIGlzIHByb3ZpZGVkLCBpbXBvcnQgdGhlIGV4aXN0aW5nIGhvc3RlZCB6b25lXG4gICAgaWYgKHByb3BzLmhvc3RlZFpvbmVJZCkge1xuICAgICAgY29uc29sZS5sb2coYPCfk40gSW1wb3J0aW5nIGV4aXN0aW5nIGhvc3RlZCB6b25lOiAke3Byb3BzLmhvc3RlZFpvbmVJZH0gZm9yIGRvbWFpbjogJHtwcm9wcy5iYXNlRG9tYWlufWApO1xuICAgICAgcmV0dXJuIHJvdXRlNTMuSG9zdGVkWm9uZS5mcm9tSG9zdGVkWm9uZUF0dHJpYnV0ZXModGhpcywgJ0hvc3RlZFpvbmUnLCB7XG4gICAgICAgIGhvc3RlZFpvbmVJZDogcHJvcHMuaG9zdGVkWm9uZUlkLFxuICAgICAgICB6b25lTmFtZTogcHJvcHMuYmFzZURvbWFpbixcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBhIG5ldyBob3N0ZWQgem9uZVxuICAgIC8vIE5vdGU6IEhvc3RlZFpvbmUuZnJvbUxvb2t1cCgpIHdvdWxkIHJlcXVpcmUgdGhlIHpvbmUgdG8gZXhpc3QgYXQgc3ludGhlc2lzIHRpbWVcbiAgICAvLyBhbmQgd291bGQgZmFpbCBpZiBpdCBkb2Vzbid0IGV4aXN0LiBTaW5jZSB3ZSB3YW50IHRvIGNyZWF0ZSBpZiBpdCBkb2Vzbid0IGV4aXN0LFxuICAgIC8vIHdlJ2xsIGFsd2F5cyBjcmVhdGUgYSBuZXcgb25lIHVubGVzcyBob3N0ZWRab25lSWQgaXMgZXhwbGljaXRseSBwcm92aWRlZC5cbiAgICBjb25zb2xlLmxvZyhg8J+GlSBDcmVhdGluZyBuZXcgaG9zdGVkIHpvbmUgZm9yIGRvbWFpbjogJHtwcm9wcy5iYXNlRG9tYWlufWApO1xuICAgIGNvbnN0IGhvc3RlZFpvbmUgPSBuZXcgcm91dGU1My5Ib3N0ZWRab25lKHRoaXMsICdIb3N0ZWRab25lJywge1xuICAgICAgem9uZU5hbWU6IHByb3BzLmJhc2VEb21haW4sXG4gICAgICBjb21tZW50OiBgSG9zdGVkIHpvbmUgZm9yICR7cHJvcHMuYmFzZURvbWFpbn0gLSBtYW5hZ2VkIGJ5IENES2AsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGhvc3RlZFpvbmUpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoaG9zdGVkWm9uZSkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2YoaG9zdGVkWm9uZSkuYWRkKCdDb21wb25lbnQnLCAnRE5TLUhvc3RlZFpvbmUnKTtcblxuICAgIHJldHVybiBob3N0ZWRab25lO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDZXJ0aWZpY2F0ZShwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogY2VydGlmaWNhdGVtYW5hZ2VyLklDZXJ0aWZpY2F0ZSB7XG4gICAgLy8gYmFzZURvbWFpbiBpcyBndWFyYW50ZWVkIHRvIGV4aXN0IGR1ZSB0byBjb25zdHJ1Y3RvciB2YWxpZGF0aW9uXG4gICAgaWYgKCFwcm9wcy5iYXNlRG9tYWluKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Jhc2UgZG9tYWluIGlzIHJlcXVpcmVkIGZvciBjZXJ0aWZpY2F0ZSBjcmVhdGlvbicpO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG5ldyBjZXJ0aWZpY2F0ZW1hbmFnZXIuQ2VydGlmaWNhdGUodGhpcywgJ1NTTENlcnRpZmljYXRlJywge1xuICAgICAgZG9tYWluTmFtZTogcHJvcHMuYmFzZURvbWFpbixcbiAgICAgIHN1YmplY3RBbHRlcm5hdGl2ZU5hbWVzOiBbYCouJHtwcm9wcy5iYXNlRG9tYWlufWBdLFxuICAgICAgdmFsaWRhdGlvbjogdGhpcy5ob3N0ZWRab25lIFxuICAgICAgICA/IGNlcnRpZmljYXRlbWFuYWdlci5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyh0aGlzLmhvc3RlZFpvbmUpXG4gICAgICAgIDogY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKCksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGFnc1xuICAgIGNkay5UYWdzLm9mKGNlcnRpZmljYXRlKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKGNlcnRpZmljYXRlKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihjZXJ0aWZpY2F0ZSkuYWRkKCdDb21wb25lbnQnLCAnU1NMLUNlcnRpZmljYXRlJyk7XG5cbiAgICByZXR1cm4gY2VydGlmaWNhdGU7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKFxuICAgIHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMsIFxuICAgIHZwYzogZWMyLklWcGMsIFxuICAgIHNlY3VyaXR5R3JvdXA6IGVjMi5JU2VjdXJpdHlHcm91cFxuICApOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyIHtcbiAgICBjb25zdCBhbGIgPSBuZXcgZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnQXBwbGljYXRpb25Mb2FkQmFsYW5jZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICAgIHNlY3VyaXR5R3JvdXAsXG4gICAgICBsb2FkQmFsYW5jZXJOYW1lOiBgdGVzdGFwcC1hbGItJHtwcm9wcy5lbnZpcm9ubWVudH1gLFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRhZ3NcbiAgICBjZGsuVGFncy5vZihhbGIpLmFkZCgnRW52aXJvbm1lbnQnLCBwcm9wcy5lbnZpcm9ubWVudCk7XG4gICAgY2RrLlRhZ3Mub2YoYWxiKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgICBjZGsuVGFncy5vZihhbGIpLmFkZCgnQ29tcG9uZW50JywgJ0xvYWQtQmFsYW5jZXInKTtcblxuICAgIHJldHVybiBhbGI7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUh0dHBMaXN0ZW5lcigpOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkFwcGxpY2F0aW9uTGlzdGVuZXIge1xuICAgIGNvbnN0IGxpc3RlbmVyID0gdGhpcy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0h0dHBMaXN0ZW5lcicsIHtcbiAgICAgIHBvcnQ6IDgwLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgIH0pO1xuXG4gICAgLy8gTm90ZTogUmVkaXJlY3QgbG9naWMgd2lsbCBiZSBhZGRlZCBhZnRlciBIVFRQUyBsaXN0ZW5lciBpcyBjcmVhdGVkIChpZiBzdWNjZXNzZnVsKVxuICAgIC8vIERlZmF1bHQgYWN0aW9uIC0gd2lsbCBiZSBvdmVycmlkZGVuIGJ5IGFwcGxpY2F0aW9uIHN0YWNrIG9yIHJlZGlyZWN0XG4gICAgbGlzdGVuZXIuYWRkQWN0aW9uKCdEZWZhdWx0QWN0aW9uJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoNTAzLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgYWRkSHR0cFRvSHR0cHNSZWRpcmVjdCgpOiB2b2lkIHtcbiAgICAvLyBBZGQgcmVkaXJlY3QgcnVsZSBmb3IgYWxsIHBhdGhzXG4gICAgdGhpcy5odHRwTGlzdGVuZXIuYWRkQWN0aW9uKCdSZWRpcmVjdFRvSHR0cHMnLCB7XG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24ucmVkaXJlY3Qoe1xuICAgICAgICBwcm90b2NvbDogJ0hUVFBTJyxcbiAgICAgICAgcG9ydDogJzQ0MycsXG4gICAgICAgIHBlcm1hbmVudDogdHJ1ZSxcbiAgICAgIH0pLFxuICAgICAgY29uZGl0aW9uczogW1xuICAgICAgICBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQ29uZGl0aW9uLnBhdGhQYXR0ZXJucyhbJyonXSksXG4gICAgICBdLFxuICAgICAgcHJpb3JpdHk6IDEsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUh0dHBzTGlzdGVuZXIoKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyIHtcbiAgICAvLyBjZXJ0aWZpY2F0ZSBpcyBndWFyYW50ZWVkIHRvIGV4aXN0IHdoZW4gdGhpcyBtZXRob2QgaXMgY2FsbGVkXG4gICAgaWYgKCF0aGlzLmNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NlcnRpZmljYXRlIGlzIHJlcXVpcmVkIGZvciBIVFRQUyBsaXN0ZW5lciBjcmVhdGlvbicpO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwc0xpc3RlbmVyJywge1xuICAgICAgcG9ydDogNDQzLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgIGNlcnRpZmljYXRlczogW3RoaXMuY2VydGlmaWNhdGVdLFxuICAgIH0pO1xuXG4gICAgLy8gRGVmYXVsdCBhY3Rpb24gLSB3aWxsIGJlIG92ZXJyaWRkZW4gYnkgYXBwbGljYXRpb24gc3RhY2tcbiAgICBsaXN0ZW5lci5hZGRBY3Rpb24oJ0RlZmF1bHRBY3Rpb24nLCB7XG4gICAgICBhY3Rpb246IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuTGlzdGVuZXJBY3Rpb24uZml4ZWRSZXNwb25zZSg1MDMsIHtcbiAgICAgICAgY29udGVudFR5cGU6ICd0ZXh0L3BsYWluJyxcbiAgICAgICAgbWVzc2FnZUJvZHk6ICdTZXJ2aWNlIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlJyxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxpc3RlbmVyO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVIdHRwc0xpc3RlbmVyV2l0aEltcG9ydGVkQ2VydChwcm9wczogRWNzUGxhdGZvcm1TdGFja1Byb3BzKTogZWxhc3RpY2xvYWRiYWxhbmNpbmd2Mi5BcHBsaWNhdGlvbkxpc3RlbmVyIHtcbiAgICAvLyBGb3IgZGV2ZWxvcG1lbnQgZW52aXJvbm1lbnRzIHdpdGhvdXQgY3VzdG9tIGRvbWFpbiwgdHJ5IHRvIGltcG9ydCBhbiBleGlzdGluZyBjZXJ0aWZpY2F0ZVxuICAgIC8vIG9yIHByb3ZpZGUgaW5zdHJ1Y3Rpb25zIGZvciBtYW51YWwgY2VydGlmaWNhdGUgY3JlYXRpb25cbiAgICBjb25zdCBjZXJ0aWZpY2F0ZUFybiA9IHByb3BzLmNlcnRpZmljYXRlQXJuIHx8IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdjZXJ0aWZpY2F0ZUFybicpO1xuICAgIFxuICAgIGlmICghY2VydGlmaWNhdGVBcm4pIHtcbiAgICAgIC8vIExvZyBpbnN0cnVjdGlvbnMgZm9yIG1hbnVhbCBjZXJ0aWZpY2F0ZSBzZXR1cFxuICAgICAgY29uc29sZS53YXJuKGDimqDvuI8gIEhUVFBTIGVuYWJsZWQgZm9yICR7cHJvcHMuZW52aXJvbm1lbnR9IGJ1dCBubyBjZXJ0aWZpY2F0ZSBBUk4gcHJvdmlkZWQuYCk7XG4gICAgICBjb25zb2xlLndhcm4oYCAgIFRvIGVuYWJsZSBIVFRQUywgY3JlYXRlIGEgY2VydGlmaWNhdGUgaW4gQUNNIG1hbnVhbGx5IGFuZCBwcm92aWRlIHRoZSBBUk4gdmlhOmApO1xuICAgICAgY29uc29sZS53YXJuKGAgICAtIENvbnRleHQ6IC0tY29udGV4dCBjZXJ0aWZpY2F0ZUFybj1hcm46YXdzOmFjbTpyZWdpb246YWNjb3VudDpjZXJ0aWZpY2F0ZS94eHhgKTtcbiAgICAgIGNvbnNvbGUud2FybihgICAgLSBPciBhZGQgY2VydGlmaWNhdGVBcm4gdG8gRWNzUGxhdGZvcm1TdGFja1Byb3BzYCk7XG4gICAgICBjb25zb2xlLndhcm4oYCAgIEZvciBub3csIGZhbGxpbmcgYmFjayB0byBIVFRQLW9ubHkgY29uZmlndXJhdGlvbi5gKTtcbiAgICAgIFxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBDZXJ0aWZpY2F0ZSBBUk4gcmVxdWlyZWQgZm9yIEhUVFBTIGluICR7cHJvcHMuZW52aXJvbm1lbnR9IGVudmlyb25tZW50LiBTZWUgY29uc29sZSB3YXJuaW5ncyBmb3Igc2V0dXAgaW5zdHJ1Y3Rpb25zLmApO1xuICAgIH1cblxuICAgIC8vIEltcG9ydCBleGlzdGluZyBjZXJ0aWZpY2F0ZVxuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gY2VydGlmaWNhdGVtYW5hZ2VyLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgIHRoaXMsICdJbXBvcnRlZENlcnRpZmljYXRlJywgXG4gICAgICBjZXJ0aWZpY2F0ZUFyblxuICAgICk7XG5cbiAgICBjb25zdCBsaXN0ZW5lciA9IHRoaXMubG9hZEJhbGFuY2VyLmFkZExpc3RlbmVyKCdIdHRwc0xpc3RlbmVyJywge1xuICAgICAgcG9ydDogNDQzLFxuICAgICAgcHJvdG9jb2w6IGVsYXN0aWNsb2FkYmFsYW5jaW5ndjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQUyxcbiAgICAgIGNlcnRpZmljYXRlczogW2NlcnRpZmljYXRlXSxcbiAgICB9KTtcblxuICAgIC8vIERlZmF1bHQgYWN0aW9uIC0gd2lsbCBiZSBvdmVycmlkZGVuIGJ5IGFwcGxpY2F0aW9uIHN0YWNrXG4gICAgbGlzdGVuZXIuYWRkQWN0aW9uKCdEZWZhdWx0QWN0aW9uJywge1xuICAgICAgYWN0aW9uOiBlbGFzdGljbG9hZGJhbGFuY2luZ3YyLkxpc3RlbmVyQWN0aW9uLmZpeGVkUmVzcG9uc2UoNTAzLCB7XG4gICAgICAgIGNvbnRlbnRUeXBlOiAndGV4dC9wbGFpbicsXG4gICAgICAgIG1lc3NhZ2VCb2R5OiAnU2VydmljZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZScsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHJldHVybiBsaXN0ZW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlV0FGKHByb3BzOiBFY3NQbGF0Zm9ybVN0YWNrUHJvcHMpOiB3YWZ2Mi5DZm5XZWJBQ0wge1xuICAgIC8vIENyZWF0ZSBJUCBzZXRzIGZvciByYXRlIGxpbWl0aW5nXG4gICAgY29uc3QgaXBTZXRBbGxvd0xpc3QgPSBuZXcgd2FmdjIuQ2ZuSVBTZXQodGhpcywgJ0lQU2V0QWxsb3dMaXN0Jywge1xuICAgICAgbmFtZTogYHRlc3RhcHAtJHtwcm9wcy5lbnZpcm9ubWVudH0tYWxsb3ctbGlzdGAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FsbG93ZWQgSVAgYWRkcmVzc2VzIGZvciBoaWdoZXIgcmF0ZSBsaW1pdHMnLFxuICAgICAgaXBBZGRyZXNzVmVyc2lvbjogJ0lQVjQnLFxuICAgICAgYWRkcmVzc2VzOiBbXSwgLy8gQ2FuIGJlIHBvcHVsYXRlZCB3aXRoIHRydXN0ZWQgSVBzXG4gICAgICBzY29wZTogJ1JFR0lPTkFMJyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHdlYkFDTCA9IG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcywgJ1dlYkFDTCcsIHtcbiAgICAgIG5hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgZGVzY3JpcHRpb246IGBXQUYgZm9yIFRlc3RBcHAgJHtwcm9wcy5lbnZpcm9ubWVudH0gZW52aXJvbm1lbnRgLFxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsXG4gICAgICBkZWZhdWx0QWN0aW9uOiB7IGFsbG93OiB7fSB9LFxuICAgICAgXG4gICAgICBydWxlczogW1xuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIENvcmUgUnVsZSBTZXRcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDEsXG4gICAgICAgICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0NvbW1vblJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFxuICAgICAgICAvLyBBV1MgTWFuYWdlZCBSdWxlIFNldCAtIEtub3duIEJhZCBJbnB1dHNcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1MtQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMixcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnS25vd25CYWRJbnB1dHNSdWxlU2V0TWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgbWFuYWdlZFJ1bGVHcm91cFN0YXRlbWVudDoge1xuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gQVdTIE1hbmFnZWQgUnVsZSBTZXQgLSBTUUwgSW5qZWN0aW9uXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTLUFXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMyxcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnU1FMaVJ1bGVTZXRNZXRyaWMnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzU1FMaVJ1bGVTZXQnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFJhdGUgbGltaXRpbmcgcnVsZVxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1JhdGVMaW1pdFJ1bGUnLFxuICAgICAgICAgIHByaW9yaXR5OiAxMCxcbiAgICAgICAgICBhY3Rpb246IHsgYmxvY2s6IHt9IH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdSYXRlTGltaXRSdWxlTWV0cmljJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICAgICAgcmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGxpbWl0OiBwcm9wcy5lbnZpcm9ubWVudCA9PT0gJ3Byb2R1Y3Rpb24nID8gMjAwMCA6IDEwMDAsXG4gICAgICAgICAgICAgIGFnZ3JlZ2F0ZUtleVR5cGU6ICdJUCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gR2VvZ3JhcGhpYyByZXN0cmljdGlvbiBmb3IgcHJvZHVjdGlvblxuICAgICAgICAuLi4ocHJvcHMuZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IFt7XG4gICAgICAgICAgbmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZScsXG4gICAgICAgICAgcHJpb3JpdHk6IDE1LFxuICAgICAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0dlb1Jlc3RyaWN0aW9uUnVsZU1ldHJpYycsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIGdlb01hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIGNvdW50cnlDb2RlczogWydDTicsICdSVScsICdLUCcsICdJUiddLCAvLyBCbG9jayBzcGVjaWZpYyBoaWdoLXJpc2sgY291bnRyaWVzXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dIDogW10pLFxuICAgICAgXSxcblxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIG1ldHJpY05hbWU6IGB0ZXN0YXBwLSR7cHJvcHMuZW52aXJvbm1lbnR9LXdlYi1hY2xgLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0YWdzXG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0Vudmlyb25tZW50JywgcHJvcHMuZW52aXJvbm1lbnQpO1xuICAgIGNkay5UYWdzLm9mKHdlYkFDTCkuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gICAgY2RrLlRhZ3Mub2Yod2ViQUNMKS5hZGQoJ0NvbXBvbmVudCcsICdXQUYnKTtcbiAgICBjZGsuVGFncy5vZih3ZWJBQ0wpLmFkZCgnUHVycG9zZScsICdERG9TLVByb3RlY3Rpb24nKTtcblxuICAgIHJldHVybiB3ZWJBQ0w7XG4gIH1cblxuICBwcml2YXRlIGFzc29jaWF0ZVdBRldpdGhBTEIoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLndlYkFDTCkgcmV0dXJuO1xuXG4gICAgbmV3IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uKHRoaXMsICdXZWJBQ0xBc3NvY2lhdGlvbicsIHtcbiAgICAgIHJlc291cmNlQXJuOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICB3ZWJBY2xBcm46IHRoaXMud2ViQUNMLmF0dHJBcm4sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMocHJvcHM6IEVjc1BsYXRmb3JtU3RhY2tQcm9wcyk6IHZvaWQge1xuICAgIC8vIEVDUyBDbHVzdGVyIG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2x1c3RlckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3RlckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNTIENsdXN0ZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbHVzdGVyQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbHVzdGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBDbHVzdGVyIE5hbWUnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsdXN0ZXJOYW1lYCxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IG91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXBvc2l0b3J5QXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5QXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgUmVwb3NpdG9yeSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVJlcG9zaXRvcnlBcm5gLFxuICAgIH0pO1xuXG4gICAgLy8gTG9hZCBCYWxhbmNlciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdBcHBsaWNhdGlvbiBMb2FkIEJhbGFuY2VyIEROUyBOYW1lJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Mb2FkQmFsYW5jZXJETlNgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlclpvbmVJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJDYW5vbmljYWxIb3N0ZWRab25lSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXIgSG9zdGVkIFpvbmUgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvYWRCYWxhbmNlclpvbmVJZGAsXG4gICAgfSk7XG5cbiAgICAvLyBMaXN0ZW5lciBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0h0dHBMaXN0ZW5lckFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmh0dHBMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnSFRUUCBMaXN0ZW5lciBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUh0dHBMaXN0ZW5lckFybmAsXG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5odHRwc0xpc3RlbmVyKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSHR0cHNMaXN0ZW5lckFybicsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuaHR0cHNMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdIVFRQUyBMaXN0ZW5lciBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSHR0cHNMaXN0ZW5lckFybmAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBMb2cgR3JvdXAgb3V0cHV0XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvZ0dyb3VwTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBMb2cgR3JvdXAgTmFtZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tTG9nR3JvdXBOYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMb2dHcm91cEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIExvZyBHcm91cCBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUxvZ0dyb3VwQXJuYCxcbiAgICB9KTtcblxuICAgIC8vIENlcnRpZmljYXRlIG91dHB1dCAoaWYgZW5hYmxlZClcbiAgICBpZiAodGhpcy5jZXJ0aWZpY2F0ZSkge1xuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NlcnRpZmljYXRlQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5jZXJ0aWZpY2F0ZS5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdTU0wgQ2VydGlmaWNhdGUgQVJOJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNlcnRpZmljYXRlQXJuYCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFdBRiBvdXRwdXQgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMud2ViQUNMKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMQXJuJywge1xuICAgICAgICB2YWx1ZTogdGhpcy53ZWJBQ0wuYXR0ckFybixcbiAgICAgICAgZGVzY3JpcHRpb246ICdXQUYgV2ViIEFDTCBBUk4nLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMQXJuYCxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV0FGV2ViQUNMSWQnLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLndlYkFDTC5hdHRySWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnV0FGIFdlYiBBQ0wgSUQnLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tV0FGV2ViQUNMSWRgLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gSG9zdGVkIFpvbmUgb3V0cHV0cyAoaWYgY3JlYXRlZCBvciBpbXBvcnRlZClcbiAgICBpZiAodGhpcy5ob3N0ZWRab25lKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSG9zdGVkWm9uZUlkJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5ob3N0ZWRab25lLmhvc3RlZFpvbmVJZCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdSb3V0ZTUzIEhvc3RlZCBab25lIElEJyxcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUhvc3RlZFpvbmVJZGAsXG4gICAgICB9KTtcblxuICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0hvc3RlZFpvbmVOYW1lJywge1xuICAgICAgICB2YWx1ZTogdGhpcy5ob3N0ZWRab25lLnpvbmVOYW1lLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1JvdXRlNTMgSG9zdGVkIFpvbmUgTmFtZScsXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Ib3N0ZWRab25lTmFtZWAsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBTEIgRE5TIG91dHB1dCBhbHJlYWR5IGNyZWF0ZWQgYWJvdmUgLSByZW1vdmluZyBkdXBsaWNhdGVcbiAgfVxufSJdfQ==