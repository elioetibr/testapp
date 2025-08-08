#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const vpc_stack_1 = require("../lib/vpc-stack");
const ecs_platform_stack_1 = require("../lib/ecs-platform-stack");
const application_stack_1 = require("../lib/application-stack");
const app = new cdk.App();
// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';
// Get PR ID for ephemeral deployments (from CI environment or context)
const prId = app.node.tryGetContext('prId') || process.env.PR_ID || process.env.GITHUB_HEAD_REF;
// Environment-specific configurations
const environmentConfigs = {
    dev: {
        // VPC Configuration
        enableIPv6: false,
        enableHANatGateways: false,
        maxAzs: 2,
        natGateways: 1,
        vpcCidr: '10.0.0.0/16',
        publicSubnetCidrMask: 24,
        privateSubnetCidrMask: 24,
        // Security Features (disabled by default for cost optimization)
        enableVPCFlowLogs: false,
        enableWAF: false,
        // HTTPS is always enabled - provide certificateArn or baseDomain to configure SSL
        // ECS Platform Configuration
        clusterName: `testapp-cluster-${environment}`,
        repositoryName: 'testapp',
        // Application Configuration
        serviceName: `testapp-service-${environment}`,
        taskImageTag: 'latest',
        desiredCount: 1,
        cpu: 256,
        memoryLimitMiB: 512,
        containerPort: 8000,
        // Auto Scaling Configuration
        minCapacity: 1,
        maxCapacity: 3,
        cpuTargetUtilization: 70,
        memoryTargetUtilization: 80,
        scaleInCooldownMinutes: 5,
        scaleOutCooldownMinutes: 2,
        // Health Check Configuration
        healthCheckPath: '/health/',
        healthCheckInterval: 30,
        healthCheckTimeout: 5,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        // Container Security (disabled by default)
        enableNonRootContainer: false,
        enableReadOnlyRootFilesystem: false,
        // Environment Variables
        environmentVariables: {
            DEBUG: 'true',
        },
    },
    production: {
        // VPC Configuration
        enableIPv6: true,
        enableHANatGateways: true,
        maxAzs: 3,
        natGateways: 3,
        vpcCidr: '10.2.0.0/16',
        publicSubnetCidrMask: 24,
        privateSubnetCidrMask: 24,
        // Security Features (fully enabled for production)
        enableVPCFlowLogs: true,
        enableWAF: true,
        // HTTPS is mandatory - configure baseDomain and appName for automatic certificate
        // ECS Platform Configuration
        clusterName: `testapp-cluster-${environment}`,
        repositoryName: 'testapp',
        // Application Configuration
        serviceName: `testapp-service-${environment}`,
        taskImageTag: 'latest',
        desiredCount: 3,
        cpu: 1024,
        memoryLimitMiB: 2048,
        containerPort: 8000,
        // Auto Scaling Configuration
        minCapacity: 3,
        maxCapacity: 12,
        cpuTargetUtilization: 60,
        memoryTargetUtilization: 70,
        scaleInCooldownMinutes: 10,
        scaleOutCooldownMinutes: 3,
        // Health Check Configuration
        healthCheckPath: '/health/',
        healthCheckInterval: 30,
        healthCheckTimeout: 5,
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 2,
        // Container Security (fully enabled for production)
        enableNonRootContainer: true,
        enableReadOnlyRootFilesystem: true,
        // Environment Variables
        environmentVariables: {
            DEBUG: 'false',
        },
    },
};
// Get configuration for the current environment
const config = environmentConfigs[environment];
if (!config) {
    throw new Error(`Unknown environment: ${environment}. Supported environments: ${Object.keys(environmentConfigs).join(', ')}`);
}
// Domain configuration
const baseDomain = app.node.tryGetContext('baseDomain');
const hostedZoneId = app.node.tryGetContext('hostedZoneId');
const appName = app.node.tryGetContext('appName');
// Enable HTTPS if domain config is provided (HTTPS is mandatory when possible)
const httpsEnabled = baseDomain && appName;
console.log(`🚀 Deploying TestApp infrastructure for environment: ${environment}`);
if (prId) {
    console.log(`🔀 PR Deployment detected: ${prId}`);
}
console.log(`📊 Configuration:`, JSON.stringify({
    environment,
    prId: prId || 'Not a PR deployment',
    appName: appName || 'Not configured',
    baseDomain: baseDomain || 'Not configured',
    httpsEnabled,
    securityFeatures: {
        enableVPCFlowLogs: config.enableVPCFlowLogs,
        enableWAF: config.enableWAF,
        enableNonRootContainer: config.enableNonRootContainer,
        enableReadOnlyRootFilesystem: config.enableReadOnlyRootFilesystem,
    }
}, null, 2));
// Common stack props
const commonProps = {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
    },
    // Set stack timeout to 20 minutes for infrastructure operations
    timeout: cdk.Duration.minutes(20),
};
if (prId) {
    // For PR deployments: Only create application stack, reuse existing VPC and ECS Platform
    console.log(`🔀 Creating ephemeral PR deployment: reusing ${environment} VPC and ECS cluster`);
    // Import existing VPC and Platform resources
    const existingVpcId = `TestApp-VPC-${environment}`;
    const existingPlatformId = `TestApp-Platform-${environment}`;
    // Generate unique stack name for PR application
    const prStackName = `TestApp-App-${environment}-pr-${prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
    // Create only Application Stack for PR (reusing existing infrastructure)
    const applicationStack = new application_stack_1.ApplicationStack(app, prStackName, {
        ...commonProps,
        stackName: prStackName,
        environment,
        // Import existing VPC resources by referencing the existing stack
        vpcId: cdk.Fn.importValue(`${existingVpcId}-VpcId`),
        privateSubnetIds: [
            cdk.Fn.importValue(`${existingVpcId}-PrivateSubnet1Id`),
            cdk.Fn.importValue(`${existingVpcId}-PrivateSubnet2Id`),
        ],
        applicationSecurityGroupId: cdk.Fn.importValue(`${existingVpcId}-ApplicationSecurityGroupId`),
        // Import existing ECS Platform resources
        clusterArn: cdk.Fn.importValue(`${existingPlatformId}-ClusterArn`),
        clusterName: cdk.Fn.importValue(`${existingPlatformId}-ClusterName`),
        repositoryUri: cdk.Fn.importValue(`${existingPlatformId}-RepositoryUri`),
        loadBalancerArn: cdk.Fn.importValue(`${existingPlatformId}-LoadBalancerArn`),
        httpListenerArn: cdk.Fn.importValue(`${existingPlatformId}-HttpListenerArn`),
        httpsListenerArn: httpsEnabled ? cdk.Fn.importValue(`${existingPlatformId}-HttpsListenerArn`) : undefined,
        logGroupName: cdk.Fn.importValue(`${existingPlatformId}-LogGroupName`),
        logGroupArn: cdk.Fn.importValue(`${existingPlatformId}-LogGroupArn`),
        // Application configuration - unique service name for PR
        serviceName: `testapp-service-${environment}-pr-${prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
        taskImageTag: config.taskImageTag,
        desiredCount: 1,
        cpu: config.cpu,
        memoryLimitMiB: config.memoryLimitMiB,
        containerPort: config.containerPort,
        // Minimal auto scaling for PR
        minCapacity: 1,
        maxCapacity: 2,
        cpuTargetUtilization: config.cpuTargetUtilization,
        memoryTargetUtilization: config.memoryTargetUtilization,
        scaleInCooldownMinutes: config.scaleInCooldownMinutes,
        scaleOutCooldownMinutes: config.scaleOutCooldownMinutes,
        // Health check configuration
        healthCheckPath: config.healthCheckPath,
        healthCheckInterval: config.healthCheckInterval,
        healthCheckTimeout: config.healthCheckTimeout,
        healthyThresholdCount: config.healthyThresholdCount,
        unhealthyThresholdCount: config.unhealthyThresholdCount,
        // Container security
        enableNonRootContainer: config.enableNonRootContainer,
        enableReadOnlyRootFilesystem: config.enableReadOnlyRootFilesystem,
        // Environment variables
        environmentVariables: config.environmentVariables,
        // Domain configuration
        baseDomain: baseDomain,
        appName: appName,
        prId: prId,
        hostedZoneId: hostedZoneId,
    });
    // Add stack tags for PR deployment
    cdk.Tags.of(applicationStack).add('Environment', environment);
    cdk.Tags.of(applicationStack).add('Project', 'TestApp');
    cdk.Tags.of(applicationStack).add('ManagedBy', 'CDK');
    cdk.Tags.of(applicationStack).add('DeploymentType', 'PR-Ephemeral');
    cdk.Tags.of(applicationStack).add('PRId', prId.toString());
    cdk.Tags.of(applicationStack).add('DeployedAt', new Date().toISOString());
    // Generate PR domain name
    const prDomainName = baseDomain && appName
        ? `pr-${prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${appName}.${baseDomain}`
        : undefined;
    // Output for PR deployment
    new cdk.CfnOutput(applicationStack, 'PRDeploymentSummary', {
        value: JSON.stringify({
            prId,
            environment,
            serviceName: `testapp-service-${environment}-pr-${prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
            domainName: prDomainName,
            applicationUrl: prDomainName ? (httpsEnabled ? `https://${prDomainName}` : `http://${prDomainName}`) : 'Available after deployment',
            timestamp: new Date().toISOString(),
        }, null, 2),
        description: 'PR Deployment Summary',
    });
    console.log(`✅ PR deployment configuration completed`);
    console.log(`📝 PR Stack to be deployed: ${prStackName}`);
    console.log(`🔗 Service name: testapp-service-${environment}-pr-${prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`);
    if (prDomainName) {
        console.log(`🌐 Domain: ${prDomainName}`);
    }
}
else {
    // Regular deployment: Create full infrastructure
    console.log(`🏗️ Creating full infrastructure deployment for ${environment}`);
    // 1. Create VPC Stack (Foundation Layer)
    const vpcStack = new vpc_stack_1.VpcStack(app, `TestApp-VPC-${environment}`, {
        ...commonProps,
        stackName: `TestApp-VPC-${environment}`,
        environment,
        enableIPv6: config.enableIPv6,
        enableHANatGateways: config.enableHANatGateways,
        maxAzs: config.maxAzs,
        natGateways: config.natGateways,
        vpcCidr: config.vpcCidr,
        publicSubnetCidrMask: config.publicSubnetCidrMask,
        privateSubnetCidrMask: config.privateSubnetCidrMask,
        enableVPCFlowLogs: config.enableVPCFlowLogs,
    });
    // 2. Create ECS Platform Stack (Platform Layer)
    const ecsPlatformStack = new ecs_platform_stack_1.EcsPlatformStack(app, `TestApp-Platform-${environment}`, {
        ...commonProps,
        stackName: `TestApp-Platform-${environment}`,
        environment,
        // VPC configuration from VPC stack
        vpcId: vpcStack.vpc.vpcId,
        publicSubnetIds: vpcStack.publicSubnets.map(subnet => subnet.subnetId),
        loadBalancerSecurityGroupId: vpcStack.loadBalancerSecurityGroup.securityGroupId,
        // Platform configuration
        clusterName: config.clusterName,
        repositoryName: config.repositoryName,
        // Security enhancements
        enableWAF: config.enableWAF,
        hostedZoneId: hostedZoneId,
        baseDomain: baseDomain,
        appName: appName,
    });
    // 3. Create Application Deployment Stack (Service Layer)
    const applicationStack = new application_stack_1.ApplicationStack(app, `TestApp-App-${environment}`, {
        ...commonProps,
        stackName: `TestApp-App-${environment}`,
        environment,
        // VPC configuration from VPC stack
        vpcId: vpcStack.vpc.vpcId,
        privateSubnetIds: vpcStack.privateSubnets.map(subnet => subnet.subnetId),
        applicationSecurityGroupId: vpcStack.applicationSecurityGroup.securityGroupId,
        // ECS Platform configuration from Platform stack
        clusterArn: ecsPlatformStack.cluster.clusterArn,
        clusterName: ecsPlatformStack.cluster.clusterName,
        repositoryUri: ecsPlatformStack.repository.repositoryUri,
        loadBalancerArn: ecsPlatformStack.loadBalancer.loadBalancerArn,
        httpListenerArn: ecsPlatformStack.httpListener.listenerArn,
        httpsListenerArn: ecsPlatformStack.httpsListener?.listenerArn,
        logGroupName: ecsPlatformStack.logGroup.logGroupName,
        logGroupArn: ecsPlatformStack.logGroup.logGroupArn,
        // Application configuration
        serviceName: config.serviceName,
        taskImageTag: config.taskImageTag,
        desiredCount: config.desiredCount,
        cpu: config.cpu,
        memoryLimitMiB: config.memoryLimitMiB,
        containerPort: config.containerPort,
        // Auto scaling configuration
        minCapacity: config.minCapacity,
        maxCapacity: config.maxCapacity,
        cpuTargetUtilization: config.cpuTargetUtilization,
        memoryTargetUtilization: config.memoryTargetUtilization,
        scaleInCooldownMinutes: config.scaleInCooldownMinutes,
        scaleOutCooldownMinutes: config.scaleOutCooldownMinutes,
        // Health check configuration
        healthCheckPath: config.healthCheckPath,
        healthCheckInterval: config.healthCheckInterval,
        healthCheckTimeout: config.healthCheckTimeout,
        healthyThresholdCount: config.healthyThresholdCount,
        unhealthyThresholdCount: config.unhealthyThresholdCount,
        // Container security
        enableNonRootContainer: config.enableNonRootContainer,
        enableReadOnlyRootFilesystem: config.enableReadOnlyRootFilesystem,
        // Environment variables
        environmentVariables: config.environmentVariables,
        // Domain configuration
        baseDomain: baseDomain,
        appName: appName,
        hostedZoneId: hostedZoneId,
    });
    // Add explicit dependencies to ensure correct deployment order
    ecsPlatformStack.addDependency(vpcStack);
    applicationStack.addDependency(ecsPlatformStack);
    // Add stack tags for better resource management
    const stackTags = {
        Environment: environment,
        Project: 'TestApp',
        ManagedBy: 'CDK',
        DeployedAt: new Date().toISOString(),
    };
    Object.entries(stackTags).forEach(([key, value]) => {
        cdk.Tags.of(vpcStack).add(key, value);
        cdk.Tags.of(ecsPlatformStack).add(key, value);
        cdk.Tags.of(applicationStack).add(key, value);
    });
    // Create comprehensive stack outputs for CI/CD integration
    new cdk.CfnOutput(applicationStack, 'DeploymentSummary', {
        value: JSON.stringify({
            environment,
            timestamp: new Date().toISOString(),
            stacks: {
                vpc: vpcStack.stackName,
                platform: ecsPlatformStack.stackName,
                application: applicationStack.stackName,
            },
            securityFeatures: {
                vpcFlowLogs: config.enableVPCFlowLogs,
                waf: config.enableWAF,
                https: httpsEnabled,
                containerSecurity: config.enableNonRootContainer || config.enableReadOnlyRootFilesystem,
            },
            applicationUrl: httpsEnabled && baseDomain && appName
                ? `https://${environment === 'production' ? appName : `${environment}-${appName}`}.${baseDomain}`
                : 'Available after deployment',
        }, null, 2),
        description: 'Deployment Summary',
    });
    console.log(`✅ Infrastructure configuration completed for ${environment} environment`);
    console.log(`📝 Stacks to be deployed:`);
    console.log(`   1. ${vpcStack.stackName} (VPC, Subnets, Security Groups)`);
    console.log(`   2. ${ecsPlatformStack.stackName} (ECS Cluster, ALB, ECR${config.enableWAF ? ', WAF' : ''}${httpsEnabled ? ', SSL Certificate' : ''})`);
    console.log(`   3. ${applicationStack.stackName} (Fargate Service, Auto Scaling, Task Definition)`);
}
// Final application URL information
if (httpsEnabled) {
    console.log(`🔒 HTTPS enabled for ${appName}.${baseDomain} and subdomains`);
}
else if (baseDomain && appName) {
    console.log(`⚠️  Domain configured but HTTPS disabled for ${environment} environment`);
}
else {
    console.log(`ℹ️  Using ALB DNS name for application access`);
}
console.log(`🎯 Application will be accessible at:`);
if (baseDomain && appName) {
    const appUrl = httpsEnabled ? 'https://' : 'http://';
    if (prId) {
        const sanitizedPrId = prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        console.log(`   ${appUrl}pr-${sanitizedPrId}-${appName}.${baseDomain}`);
    }
    else {
        const subdomain = environment === 'production' ? appName : `${environment}-${appName}`;
        console.log(`   ${appUrl}${subdomain}.${baseDomain}`);
    }
}
else {
    console.log(`   http://{ALB_DNS_NAME}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsdUNBQXFDO0FBQ3JDLG1DQUFtQztBQUNuQyxnREFBNEM7QUFDNUMsa0VBQTZEO0FBQzdELGdFQUE0RDtBQUU1RCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQixtREFBbUQ7QUFDbkQsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLElBQUksS0FBSyxDQUFDO0FBRW5FLHVFQUF1RTtBQUN2RSxNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWUsQ0FBQztBQUVoRyxzQ0FBc0M7QUFDdEMsTUFBTSxrQkFBa0IsR0FBd0I7SUFDOUMsR0FBRyxFQUFFO1FBQ0gsb0JBQW9CO1FBQ3BCLFVBQVUsRUFBRSxLQUFLO1FBQ2pCLG1CQUFtQixFQUFFLEtBQUs7UUFDMUIsTUFBTSxFQUFFLENBQUM7UUFDVCxXQUFXLEVBQUUsQ0FBQztRQUNkLE9BQU8sRUFBRSxhQUFhO1FBQ3RCLG9CQUFvQixFQUFFLEVBQUU7UUFDeEIscUJBQXFCLEVBQUUsRUFBRTtRQUV6QixnRUFBZ0U7UUFDaEUsaUJBQWlCLEVBQUUsS0FBSztRQUN4QixTQUFTLEVBQUUsS0FBSztRQUNoQixrRkFBa0Y7UUFFbEYsNkJBQTZCO1FBQzdCLFdBQVcsRUFBRSxtQkFBbUIsV0FBVyxFQUFFO1FBQzdDLGNBQWMsRUFBRSxTQUFTO1FBRXpCLDRCQUE0QjtRQUM1QixXQUFXLEVBQUUsbUJBQW1CLFdBQVcsRUFBRTtRQUM3QyxZQUFZLEVBQUUsUUFBUTtRQUN0QixZ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QUErQyxDQUFDLENBQUM7Q0FDOUQ7QUFFRCxPQUFPLENBQUMsR0FBRyxDQUFDLHVDQUF1QyxDQUFDLENBQUM7QUFDckQsSUFBSSxVQUFVLElBQUksT0FBTyxFQUFFO0lBQ3pCLE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDckQsSUFBSSxJQUFJLEVBQUU7UUFDUixNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsT0FBTyxDQUFDLGNBQWMsRUFBRSxHQUFHLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUNqRixPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sTUFBTSxNQUFNLGFBQWEsSUFBSSxPQUFPLElBQUksVUFBVSxFQUFFLENBQUMsQ0FBQztLQUN6RTtTQUFNO1FBQ0wsTUFBTSxTQUFTLEdBQUcsV0FBVyxLQUFLLFlBQVksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLFdBQVcsSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUN2RixPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sTUFBTSxHQUFHLFNBQVMsSUFBSSxVQUFVLEVBQUUsQ0FBQyxDQUFDO0tBQ3ZEO0NBQ0Y7S0FBTTtJQUNMLE9BQU8sQ0FBQyxHQUFHLENBQUMsMEJBQTBCLENBQUMsQ0FBQztDQUN6QyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBWcGNTdGFjayB9IGZyb20gJy4uL2xpYi92cGMtc3RhY2snO1xuaW1wb3J0IHsgRWNzUGxhdGZvcm1TdGFjayB9IGZyb20gJy4uL2xpYi9lY3MtcGxhdGZvcm0tc3RhY2snO1xuaW1wb3J0IHsgQXBwbGljYXRpb25TdGFjayB9IGZyb20gJy4uL2xpYi9hcHBsaWNhdGlvbi1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbi8vIEdldCBlbnZpcm9ubWVudCBmcm9tIGNvbnRleHQgb3IgZGVmYXVsdCB0byAnZGV2J1xuY29uc3QgZW52aXJvbm1lbnQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdlbnZpcm9ubWVudCcpIHx8ICdkZXYnO1xuXG4vLyBHZXQgUFIgSUQgZm9yIGVwaGVtZXJhbCBkZXBsb3ltZW50cyAoZnJvbSBDSSBlbnZpcm9ubWVudCBvciBjb250ZXh0KVxuY29uc3QgcHJJZCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3BySWQnKSB8fCBwcm9jZXNzLmVudi5QUl9JRCB8fCBwcm9jZXNzLmVudi5HSVRIVUJfSEVBRF9SRUY7XG5cbi8vIEVudmlyb25tZW50LXNwZWNpZmljIGNvbmZpZ3VyYXRpb25zXG5jb25zdCBlbnZpcm9ubWVudENvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gIGRldjoge1xuICAgIC8vIFZQQyBDb25maWd1cmF0aW9uXG4gICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgbWF4QXpzOiAyLFxuICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgIHZwY0NpZHI6ICcxMC4wLjAuMC8xNicsXG4gICAgcHVibGljU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgXG4gICAgLy8gU2VjdXJpdHkgRmVhdHVyZXMgKGRpc2FibGVkIGJ5IGRlZmF1bHQgZm9yIGNvc3Qgb3B0aW1pemF0aW9uKVxuICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiBmYWxzZSxcbiAgICBlbmFibGVXQUY6IGZhbHNlLFxuICAgIC8vIEhUVFBTIGlzIGFsd2F5cyBlbmFibGVkIC0gcHJvdmlkZSBjZXJ0aWZpY2F0ZUFybiBvciBiYXNlRG9tYWluIHRvIGNvbmZpZ3VyZSBTU0xcbiAgICBcbiAgICAvLyBFQ1MgUGxhdGZvcm0gQ29uZmlndXJhdGlvblxuICAgIGNsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7ZW52aXJvbm1lbnR9YCxcbiAgICByZXBvc2l0b3J5TmFtZTogJ3Rlc3RhcHAnLFxuICAgIFxuICAgIC8vIEFwcGxpY2F0aW9uIENvbmZpZ3VyYXRpb25cbiAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fWAsXG4gICAgdGFza0ltYWdlVGFnOiAnbGF0ZXN0JyxcbiAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgY3B1OiAyNTYsXG4gICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICBjb250YWluZXJQb3J0OiA4MDAwLFxuICAgIFxuICAgIC8vIEF1dG8gU2NhbGluZyBDb25maWd1cmF0aW9uXG4gICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgbWF4Q2FwYWNpdHk6IDMsXG4gICAgY3B1VGFyZ2V0VXRpbGl6YXRpb246IDcwLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiA4MCxcbiAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiA1LFxuICAgIHNjYWxlT3V0Q29vbGRvd25NaW51dGVzOiAyLFxuICAgIFxuICAgIC8vIEhlYWx0aCBDaGVjayBDb25maWd1cmF0aW9uXG4gICAgaGVhbHRoQ2hlY2tQYXRoOiAnL2hlYWx0aC8nLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWw6IDMwLFxuICAgIGhlYWx0aENoZWNrVGltZW91dDogNSxcbiAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDMsXG4gICAgXG4gICAgLy8gQ29udGFpbmVyIFNlY3VyaXR5IChkaXNhYmxlZCBieSBkZWZhdWx0KVxuICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IGZhbHNlLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IGZhbHNlLFxuICAgIFxuICAgIC8vIEVudmlyb25tZW50IFZhcmlhYmxlc1xuICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICBERUJVRzogJ3RydWUnLFxuICAgIH0sXG4gIH0sXG4gIFxuICBwcm9kdWN0aW9uOiB7XG4gICAgLy8gVlBDIENvbmZpZ3VyYXRpb25cbiAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IHRydWUsXG4gICAgbWF4QXpzOiAzLFxuICAgIG5hdEdhdGV3YXlzOiAzLFxuICAgIHZwY0NpZHI6ICcxMC4yLjAuMC8xNicsXG4gICAgcHVibGljU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgXG4gICAgLy8gU2VjdXJpdHkgRmVhdHVyZXMgKGZ1bGx5IGVuYWJsZWQgZm9yIHByb2R1Y3Rpb24pXG4gICAgZW5hYmxlVlBDRmxvd0xvZ3M6IHRydWUsXG4gICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgIC8vIEhUVFBTIGlzIG1hbmRhdG9yeSAtIGNvbmZpZ3VyZSBiYXNlRG9tYWluIGFuZCBhcHBOYW1lIGZvciBhdXRvbWF0aWMgY2VydGlmaWNhdGVcbiAgICBcbiAgICAvLyBFQ1MgUGxhdGZvcm0gQ29uZmlndXJhdGlvblxuICAgIGNsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7ZW52aXJvbm1lbnR9YCxcbiAgICByZXBvc2l0b3J5TmFtZTogJ3Rlc3RhcHAnLFxuICAgIFxuICAgIC8vIEFwcGxpY2F0aW9uIENvbmZpZ3VyYXRpb25cbiAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fWAsXG4gICAgdGFza0ltYWdlVGFnOiAnbGF0ZXN0JyxcbiAgICBkZXNpcmVkQ291bnQ6IDMsXG4gICAgY3B1OiAxMDI0LFxuICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxuICAgIGNvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgXG4gICAgLy8gQXV0byBTY2FsaW5nIENvbmZpZ3VyYXRpb25cbiAgICBtaW5DYXBhY2l0eTogMyxcbiAgICBtYXhDYXBhY2l0eTogMTIsXG4gICAgY3B1VGFyZ2V0VXRpbGl6YXRpb246IDYwLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiA3MCxcbiAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiAxMCxcbiAgICBzY2FsZU91dENvb2xkb3duTWludXRlczogMyxcbiAgICBcbiAgICAvLyBIZWFsdGggQ2hlY2sgQ29uZmlndXJhdGlvblxuICAgIGhlYWx0aENoZWNrUGF0aDogJy9oZWFsdGgvJyxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiAzMCxcbiAgICBoZWFsdGhDaGVja1RpbWVvdXQ6IDUsXG4gICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgIFxuICAgIC8vIENvbnRhaW5lciBTZWN1cml0eSAoZnVsbHkgZW5hYmxlZCBmb3IgcHJvZHVjdGlvbilcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiB0cnVlLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IHRydWUsXG4gICAgXG4gICAgLy8gRW52aXJvbm1lbnQgVmFyaWFibGVzXG4gICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgIERFQlVHOiAnZmFsc2UnLFxuICAgIH0sXG4gIH0sXG59O1xuXG4vLyBHZXQgY29uZmlndXJhdGlvbiBmb3IgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnRcbmNvbnN0IGNvbmZpZyA9IGVudmlyb25tZW50Q29uZmlnc1tlbnZpcm9ubWVudF07XG5pZiAoIWNvbmZpZykge1xuICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gZW52aXJvbm1lbnQ6ICR7ZW52aXJvbm1lbnR9LiBTdXBwb3J0ZWQgZW52aXJvbm1lbnRzOiAke09iamVjdC5rZXlzKGVudmlyb25tZW50Q29uZmlncykuam9pbignLCAnKX1gKTtcbn1cblxuLy8gRG9tYWluIGNvbmZpZ3VyYXRpb25cbmNvbnN0IGJhc2VEb21haW4gPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdiYXNlRG9tYWluJyk7XG5jb25zdCBob3N0ZWRab25lSWQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdob3N0ZWRab25lSWQnKTtcbmNvbnN0IGFwcE5hbWUgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdhcHBOYW1lJyk7XG5cbi8vIEVuYWJsZSBIVFRQUyBpZiBkb21haW4gY29uZmlnIGlzIHByb3ZpZGVkIChIVFRQUyBpcyBtYW5kYXRvcnkgd2hlbiBwb3NzaWJsZSlcbmNvbnN0IGh0dHBzRW5hYmxlZCA9IGJhc2VEb21haW4gJiYgYXBwTmFtZTtcblxuY29uc29sZS5sb2coYPCfmoAgRGVwbG95aW5nIFRlc3RBcHAgaW5mcmFzdHJ1Y3R1cmUgZm9yIGVudmlyb25tZW50OiAke2Vudmlyb25tZW50fWApO1xuaWYgKHBySWQpIHtcbiAgY29uc29sZS5sb2coYPCflIAgUFIgRGVwbG95bWVudCBkZXRlY3RlZDogJHtwcklkfWApO1xufVxuY29uc29sZS5sb2coYPCfk4ogQ29uZmlndXJhdGlvbjpgLCBKU09OLnN0cmluZ2lmeSh7XG4gIGVudmlyb25tZW50LFxuICBwcklkOiBwcklkIHx8ICdOb3QgYSBQUiBkZXBsb3ltZW50JyxcbiAgYXBwTmFtZTogYXBwTmFtZSB8fCAnTm90IGNvbmZpZ3VyZWQnLFxuICBiYXNlRG9tYWluOiBiYXNlRG9tYWluIHx8ICdOb3QgY29uZmlndXJlZCcsIFxuICBodHRwc0VuYWJsZWQsXG4gIHNlY3VyaXR5RmVhdHVyZXM6IHtcbiAgICBlbmFibGVWUENGbG93TG9nczogY29uZmlnLmVuYWJsZVZQQ0Zsb3dMb2dzLFxuICAgIGVuYWJsZVdBRjogY29uZmlnLmVuYWJsZVdBRixcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiBjb25maWcuZW5hYmxlTm9uUm9vdENvbnRhaW5lcixcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBjb25maWcuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSxcbiAgfVxufSwgbnVsbCwgMikpO1xuXG4vLyBDb21tb24gc3RhY2sgcHJvcHNcbmNvbnN0IGNvbW1vblByb3BzID0ge1xuICBlbnY6IHtcbiAgICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICAgIHJlZ2lvbjogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfUkVHSU9OIHx8ICd1cy1lYXN0LTEnLFxuICB9LFxuICAvLyBTZXQgc3RhY2sgdGltZW91dCB0byAyMCBtaW51dGVzIGZvciBpbmZyYXN0cnVjdHVyZSBvcGVyYXRpb25zXG4gIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDIwKSxcbn07XG5cbmlmIChwcklkKSB7XG4gIC8vIEZvciBQUiBkZXBsb3ltZW50czogT25seSBjcmVhdGUgYXBwbGljYXRpb24gc3RhY2ssIHJldXNlIGV4aXN0aW5nIFZQQyBhbmQgRUNTIFBsYXRmb3JtXG4gIGNvbnNvbGUubG9nKGDwn5SAIENyZWF0aW5nIGVwaGVtZXJhbCBQUiBkZXBsb3ltZW50OiByZXVzaW5nICR7ZW52aXJvbm1lbnR9IFZQQyBhbmQgRUNTIGNsdXN0ZXJgKTtcbiAgXG4gIC8vIEltcG9ydCBleGlzdGluZyBWUEMgYW5kIFBsYXRmb3JtIHJlc291cmNlc1xuICBjb25zdCBleGlzdGluZ1ZwY0lkID0gYFRlc3RBcHAtVlBDLSR7ZW52aXJvbm1lbnR9YDtcbiAgY29uc3QgZXhpc3RpbmdQbGF0Zm9ybUlkID0gYFRlc3RBcHAtUGxhdGZvcm0tJHtlbnZpcm9ubWVudH1gO1xuICBcbiAgLy8gR2VuZXJhdGUgdW5pcXVlIHN0YWNrIG5hbWUgZm9yIFBSIGFwcGxpY2F0aW9uXG4gIGNvbnN0IHByU3RhY2tOYW1lID0gYFRlc3RBcHAtQXBwLSR7ZW52aXJvbm1lbnR9LXByLSR7cHJJZC50b1N0cmluZygpLnJlcGxhY2UoL1teYS16MC05LV0vZ2ksICctJykudG9Mb3dlckNhc2UoKX1gO1xuICBcbiAgLy8gQ3JlYXRlIG9ubHkgQXBwbGljYXRpb24gU3RhY2sgZm9yIFBSIChyZXVzaW5nIGV4aXN0aW5nIGluZnJhc3RydWN0dXJlKVxuICBjb25zdCBhcHBsaWNhdGlvblN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCBwclN0YWNrTmFtZSwge1xuICAgIC4uLmNvbW1vblByb3BzLFxuICAgIHN0YWNrTmFtZTogcHJTdGFja05hbWUsXG4gICAgZW52aXJvbm1lbnQsXG4gICAgLy8gSW1wb3J0IGV4aXN0aW5nIFZQQyByZXNvdXJjZXMgYnkgcmVmZXJlbmNpbmcgdGhlIGV4aXN0aW5nIHN0YWNrXG4gICAgdnBjSWQ6IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1ZwY0lkfS1WcGNJZGApLFxuICAgIHByaXZhdGVTdWJuZXRJZHM6IFtcbiAgICAgIGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1ZwY0lkfS1Qcml2YXRlU3VibmV0MUlkYCksXG4gICAgICBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdWcGNJZH0tUHJpdmF0ZVN1Ym5ldDJJZGApLFxuICAgIF0sXG4gICAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1ZwY0lkfS1BcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZGApLFxuICAgIC8vIEltcG9ydCBleGlzdGluZyBFQ1MgUGxhdGZvcm0gcmVzb3VyY2VzXG4gICAgY2x1c3RlckFybjogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tQ2x1c3RlckFybmApLFxuICAgIGNsdXN0ZXJOYW1lOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1DbHVzdGVyTmFtZWApLFxuICAgIHJlcG9zaXRvcnlVcmk6IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LVJlcG9zaXRvcnlVcmlgKSxcbiAgICBsb2FkQmFsYW5jZXJBcm46IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUxvYWRCYWxhbmNlckFybmApLFxuICAgIGh0dHBMaXN0ZW5lckFybjogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tSHR0cExpc3RlbmVyQXJuYCksXG4gICAgaHR0cHNMaXN0ZW5lckFybjogaHR0cHNFbmFibGVkID8gY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tSHR0cHNMaXN0ZW5lckFybmApIDogdW5kZWZpbmVkLFxuICAgIGxvZ0dyb3VwTmFtZTogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tTG9nR3JvdXBOYW1lYCksXG4gICAgbG9nR3JvdXBBcm46IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUxvZ0dyb3VwQXJuYCksXG4gICAgLy8gQXBwbGljYXRpb24gY29uZmlndXJhdGlvbiAtIHVuaXF1ZSBzZXJ2aWNlIG5hbWUgZm9yIFBSXG4gICAgc2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtlbnZpcm9ubWVudH0tcHItJHtwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpfWAsXG4gICAgdGFza0ltYWdlVGFnOiBjb25maWcudGFza0ltYWdlVGFnLFxuICAgIGRlc2lyZWRDb3VudDogMSwgLy8gVXNlIG1pbmltYWwgcmVzb3VyY2VzIGZvciBQUlxuICAgIGNwdTogY29uZmlnLmNwdSxcbiAgICBtZW1vcnlMaW1pdE1pQjogY29uZmlnLm1lbW9yeUxpbWl0TWlCLFxuICAgIGNvbnRhaW5lclBvcnQ6IGNvbmZpZy5jb250YWluZXJQb3J0LFxuICAgIC8vIE1pbmltYWwgYXV0byBzY2FsaW5nIGZvciBQUlxuICAgIG1pbkNhcGFjaXR5OiAxLFxuICAgIG1heENhcGFjaXR5OiAyLFxuICAgIGNwdVRhcmdldFV0aWxpemF0aW9uOiBjb25maWcuY3B1VGFyZ2V0VXRpbGl6YXRpb24sXG4gICAgbWVtb3J5VGFyZ2V0VXRpbGl6YXRpb246IGNvbmZpZy5tZW1vcnlUYXJnZXRVdGlsaXphdGlvbixcbiAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiBjb25maWcuc2NhbGVJbkNvb2xkb3duTWludXRlcyxcbiAgICBzY2FsZU91dENvb2xkb3duTWludXRlczogY29uZmlnLnNjYWxlT3V0Q29vbGRvd25NaW51dGVzLFxuICAgIC8vIEhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uXG4gICAgaGVhbHRoQ2hlY2tQYXRoOiBjb25maWcuaGVhbHRoQ2hlY2tQYXRoLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWw6IGNvbmZpZy5oZWFsdGhDaGVja0ludGVydmFsLFxuICAgIGhlYWx0aENoZWNrVGltZW91dDogY29uZmlnLmhlYWx0aENoZWNrVGltZW91dCxcbiAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IGNvbmZpZy5oZWFsdGh5VGhyZXNob2xkQ291bnQsXG4gICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IGNvbmZpZy51bmhlYWx0aHlUaHJlc2hvbGRDb3VudCxcbiAgICAvLyBDb250YWluZXIgc2VjdXJpdHlcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiBjb25maWcuZW5hYmxlTm9uUm9vdENvbnRhaW5lcixcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBjb25maWcuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSxcbiAgICAvLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICBlbnZpcm9ubWVudFZhcmlhYmxlczogY29uZmlnLmVudmlyb25tZW50VmFyaWFibGVzLFxuICAgIC8vIERvbWFpbiBjb25maWd1cmF0aW9uXG4gICAgYmFzZURvbWFpbjogYmFzZURvbWFpbixcbiAgICBhcHBOYW1lOiBhcHBOYW1lLFxuICAgIHBySWQ6IHBySWQsXG4gICAgaG9zdGVkWm9uZUlkOiBob3N0ZWRab25lSWQsXG4gIH0pO1xuXG4gIC8vIEFkZCBzdGFjayB0YWdzIGZvciBQUiBkZXBsb3ltZW50XG4gIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZCgnRW52aXJvbm1lbnQnLCBlbnZpcm9ubWVudCk7XG4gIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZCgnUHJvamVjdCcsICdUZXN0QXBwJyk7XG4gIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZCgnTWFuYWdlZEJ5JywgJ0NESycpO1xuICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoJ0RlcGxveW1lbnRUeXBlJywgJ1BSLUVwaGVtZXJhbCcpO1xuICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoJ1BSSWQnLCBwcklkLnRvU3RyaW5nKCkpO1xuICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoJ0RlcGxveWVkQXQnLCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO1xuXG4gIC8vIEdlbmVyYXRlIFBSIGRvbWFpbiBuYW1lXG4gIGNvbnN0IHByRG9tYWluTmFtZSA9IGJhc2VEb21haW4gJiYgYXBwTmFtZSBcbiAgICA/IGBwci0ke3BySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCl9LSR7YXBwTmFtZX0uJHtiYXNlRG9tYWlufWBcbiAgICA6IHVuZGVmaW5lZDtcblxuICAvLyBPdXRwdXQgZm9yIFBSIGRlcGxveW1lbnRcbiAgbmV3IGNkay5DZm5PdXRwdXQoYXBwbGljYXRpb25TdGFjaywgJ1BSRGVwbG95bWVudFN1bW1hcnknLCB7XG4gICAgdmFsdWU6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHBySWQsXG4gICAgICBlbnZpcm9ubWVudCxcbiAgICAgIHNlcnZpY2VOYW1lOiBgdGVzdGFwcC1zZXJ2aWNlLSR7ZW52aXJvbm1lbnR9LXByLSR7cHJJZC50b1N0cmluZygpLnJlcGxhY2UoL1teYS16MC05LV0vZ2ksICctJykudG9Mb3dlckNhc2UoKX1gLFxuICAgICAgZG9tYWluTmFtZTogcHJEb21haW5OYW1lLFxuICAgICAgYXBwbGljYXRpb25Vcmw6IHByRG9tYWluTmFtZSA/IChodHRwc0VuYWJsZWQgPyBgaHR0cHM6Ly8ke3ByRG9tYWluTmFtZX1gIDogYGh0dHA6Ly8ke3ByRG9tYWluTmFtZX1gKSA6ICdBdmFpbGFibGUgYWZ0ZXIgZGVwbG95bWVudCcsXG4gICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9LCBudWxsLCAyKSxcbiAgICBkZXNjcmlwdGlvbjogJ1BSIERlcGxveW1lbnQgU3VtbWFyeScsXG4gIH0pO1xuXG4gIGNvbnNvbGUubG9nKGDinIUgUFIgZGVwbG95bWVudCBjb25maWd1cmF0aW9uIGNvbXBsZXRlZGApO1xuICBjb25zb2xlLmxvZyhg8J+TnSBQUiBTdGFjayB0byBiZSBkZXBsb3llZDogJHtwclN0YWNrTmFtZX1gKTtcbiAgY29uc29sZS5sb2coYPCflJcgU2VydmljZSBuYW1lOiB0ZXN0YXBwLXNlcnZpY2UtJHtlbnZpcm9ubWVudH0tcHItJHtwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpfWApO1xuICBpZiAocHJEb21haW5OYW1lKSB7XG4gICAgY29uc29sZS5sb2coYPCfjJAgRG9tYWluOiAke3ByRG9tYWluTmFtZX1gKTtcbiAgfVxuICBcbn0gZWxzZSB7XG4gIC8vIFJlZ3VsYXIgZGVwbG95bWVudDogQ3JlYXRlIGZ1bGwgaW5mcmFzdHJ1Y3R1cmVcbiAgY29uc29sZS5sb2coYPCfj5fvuI8gQ3JlYXRpbmcgZnVsbCBpbmZyYXN0cnVjdHVyZSBkZXBsb3ltZW50IGZvciAke2Vudmlyb25tZW50fWApO1xuXG4gIC8vIDEuIENyZWF0ZSBWUEMgU3RhY2sgKEZvdW5kYXRpb24gTGF5ZXIpXG4gIGNvbnN0IHZwY1N0YWNrID0gbmV3IFZwY1N0YWNrKGFwcCwgYFRlc3RBcHAtVlBDLSR7ZW52aXJvbm1lbnR9YCwge1xuICAgIC4uLmNvbW1vblByb3BzLFxuICAgIHN0YWNrTmFtZTogYFRlc3RBcHAtVlBDLSR7ZW52aXJvbm1lbnR9YCxcbiAgICBlbnZpcm9ubWVudCxcbiAgICBlbmFibGVJUHY2OiBjb25maWcuZW5hYmxlSVB2NixcbiAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBjb25maWcuZW5hYmxlSEFOYXRHYXRld2F5cyxcbiAgICBtYXhBenM6IGNvbmZpZy5tYXhBenMsXG4gICAgbmF0R2F0ZXdheXM6IGNvbmZpZy5uYXRHYXRld2F5cyxcbiAgICB2cGNDaWRyOiBjb25maWcudnBjQ2lkcixcbiAgICBwdWJsaWNTdWJuZXRDaWRyTWFzazogY29uZmlnLnB1YmxpY1N1Ym5ldENpZHJNYXNrLFxuICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogY29uZmlnLnByaXZhdGVTdWJuZXRDaWRyTWFzayxcbiAgICBlbmFibGVWUENGbG93TG9nczogY29uZmlnLmVuYWJsZVZQQ0Zsb3dMb2dzLFxuICB9KTtcblxuICAvLyAyLiBDcmVhdGUgRUNTIFBsYXRmb3JtIFN0YWNrIChQbGF0Zm9ybSBMYXllcilcbiAgY29uc3QgZWNzUGxhdGZvcm1TdGFjayA9IG5ldyBFY3NQbGF0Zm9ybVN0YWNrKGFwcCwgYFRlc3RBcHAtUGxhdGZvcm0tJHtlbnZpcm9ubWVudH1gLCB7XG4gICAgLi4uY29tbW9uUHJvcHMsXG4gICAgc3RhY2tOYW1lOiBgVGVzdEFwcC1QbGF0Zm9ybS0ke2Vudmlyb25tZW50fWAsXG4gICAgZW52aXJvbm1lbnQsXG4gICAgLy8gVlBDIGNvbmZpZ3VyYXRpb24gZnJvbSBWUEMgc3RhY2tcbiAgICB2cGNJZDogdnBjU3RhY2sudnBjLnZwY0lkLFxuICAgIHB1YmxpY1N1Ym5ldElkczogdnBjU3RhY2sucHVibGljU3VibmV0cy5tYXAoc3VibmV0ID0+IHN1Ym5ldC5zdWJuZXRJZCksXG4gICAgbG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cElkOiB2cGNTdGFjay5sb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwLnNlY3VyaXR5R3JvdXBJZCxcbiAgICAvLyBQbGF0Zm9ybSBjb25maWd1cmF0aW9uXG4gICAgY2x1c3Rlck5hbWU6IGNvbmZpZy5jbHVzdGVyTmFtZSxcbiAgICByZXBvc2l0b3J5TmFtZTogY29uZmlnLnJlcG9zaXRvcnlOYW1lLFxuICAgIC8vIFNlY3VyaXR5IGVuaGFuY2VtZW50c1xuICAgIGVuYWJsZVdBRjogY29uZmlnLmVuYWJsZVdBRixcbiAgICBob3N0ZWRab25lSWQ6IGhvc3RlZFpvbmVJZCxcbiAgICBiYXNlRG9tYWluOiBiYXNlRG9tYWluLFxuICAgIGFwcE5hbWU6IGFwcE5hbWUsXG4gIH0pO1xuXG4gIC8vIDMuIENyZWF0ZSBBcHBsaWNhdGlvbiBEZXBsb3ltZW50IFN0YWNrIChTZXJ2aWNlIExheWVyKVxuICBjb25zdCBhcHBsaWNhdGlvblN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCBgVGVzdEFwcC1BcHAtJHtlbnZpcm9ubWVudH1gLCB7XG4gICAgLi4uY29tbW9uUHJvcHMsXG4gICAgc3RhY2tOYW1lOiBgVGVzdEFwcC1BcHAtJHtlbnZpcm9ubWVudH1gLFxuICAgIGVudmlyb25tZW50LFxuICAgIC8vIFZQQyBjb25maWd1cmF0aW9uIGZyb20gVlBDIHN0YWNrXG4gICAgdnBjSWQ6IHZwY1N0YWNrLnZwYy52cGNJZCxcbiAgICBwcml2YXRlU3VibmV0SWRzOiB2cGNTdGFjay5wcml2YXRlU3VibmV0cy5tYXAoc3VibmV0ID0+IHN1Ym5ldC5zdWJuZXRJZCksXG4gICAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6IHZwY1N0YWNrLmFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWQsXG4gICAgLy8gRUNTIFBsYXRmb3JtIGNvbmZpZ3VyYXRpb24gZnJvbSBQbGF0Zm9ybSBzdGFja1xuICAgIGNsdXN0ZXJBcm46IGVjc1BsYXRmb3JtU3RhY2suY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgIGNsdXN0ZXJOYW1lOiBlY3NQbGF0Zm9ybVN0YWNrLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgcmVwb3NpdG9yeVVyaTogZWNzUGxhdGZvcm1TdGFjay5yZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgbG9hZEJhbGFuY2VyQXJuOiBlY3NQbGF0Zm9ybVN0YWNrLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgaHR0cExpc3RlbmVyQXJuOiBlY3NQbGF0Zm9ybVN0YWNrLmh0dHBMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICBodHRwc0xpc3RlbmVyQXJuOiBlY3NQbGF0Zm9ybVN0YWNrLmh0dHBzTGlzdGVuZXI/Lmxpc3RlbmVyQXJuLFxuICAgIGxvZ0dyb3VwTmFtZTogZWNzUGxhdGZvcm1TdGFjay5sb2dHcm91cC5sb2dHcm91cE5hbWUsXG4gICAgbG9nR3JvdXBBcm46IGVjc1BsYXRmb3JtU3RhY2subG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgLy8gQXBwbGljYXRpb24gY29uZmlndXJhdGlvblxuICAgIHNlcnZpY2VOYW1lOiBjb25maWcuc2VydmljZU5hbWUsXG4gICAgdGFza0ltYWdlVGFnOiBjb25maWcudGFza0ltYWdlVGFnLFxuICAgIGRlc2lyZWRDb3VudDogY29uZmlnLmRlc2lyZWRDb3VudCxcbiAgICBjcHU6IGNvbmZpZy5jcHUsXG4gICAgbWVtb3J5TGltaXRNaUI6IGNvbmZpZy5tZW1vcnlMaW1pdE1pQixcbiAgICBjb250YWluZXJQb3J0OiBjb25maWcuY29udGFpbmVyUG9ydCxcbiAgICAvLyBBdXRvIHNjYWxpbmcgY29uZmlndXJhdGlvblxuICAgIG1pbkNhcGFjaXR5OiBjb25maWcubWluQ2FwYWNpdHksXG4gICAgbWF4Q2FwYWNpdHk6IGNvbmZpZy5tYXhDYXBhY2l0eSxcbiAgICBjcHVUYXJnZXRVdGlsaXphdGlvbjogY29uZmlnLmNwdVRhcmdldFV0aWxpemF0aW9uLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiBjb25maWcubWVtb3J5VGFyZ2V0VXRpbGl6YXRpb24sXG4gICAgc2NhbGVJbkNvb2xkb3duTWludXRlczogY29uZmlnLnNjYWxlSW5Db29sZG93bk1pbnV0ZXMsXG4gICAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM6IGNvbmZpZy5zY2FsZU91dENvb2xkb3duTWludXRlcyxcbiAgICAvLyBIZWFsdGggY2hlY2sgY29uZmlndXJhdGlvblxuICAgIGhlYWx0aENoZWNrUGF0aDogY29uZmlnLmhlYWx0aENoZWNrUGF0aCxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiBjb25maWcuaGVhbHRoQ2hlY2tJbnRlcnZhbCxcbiAgICBoZWFsdGhDaGVja1RpbWVvdXQ6IGNvbmZpZy5oZWFsdGhDaGVja1RpbWVvdXQsXG4gICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiBjb25maWcuaGVhbHRoeVRocmVzaG9sZENvdW50LFxuICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiBjb25maWcudW5oZWFsdGh5VGhyZXNob2xkQ291bnQsXG4gICAgLy8gQ29udGFpbmVyIHNlY3VyaXR5XG4gICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogY29uZmlnLmVuYWJsZU5vblJvb3RDb250YWluZXIsXG4gICAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbTogY29uZmlnLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0sXG4gICAgLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG4gICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IGNvbmZpZy5lbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAvLyBEb21haW4gY29uZmlndXJhdGlvblxuICAgIGJhc2VEb21haW46IGJhc2VEb21haW4sXG4gICAgYXBwTmFtZTogYXBwTmFtZSxcbiAgICBob3N0ZWRab25lSWQ6IGhvc3RlZFpvbmVJZCxcbiAgfSk7XG5cbiAgLy8gQWRkIGV4cGxpY2l0IGRlcGVuZGVuY2llcyB0byBlbnN1cmUgY29ycmVjdCBkZXBsb3ltZW50IG9yZGVyXG4gIGVjc1BsYXRmb3JtU3RhY2suYWRkRGVwZW5kZW5jeSh2cGNTdGFjayk7XG4gIGFwcGxpY2F0aW9uU3RhY2suYWRkRGVwZW5kZW5jeShlY3NQbGF0Zm9ybVN0YWNrKTtcblxuICAvLyBBZGQgc3RhY2sgdGFncyBmb3IgYmV0dGVyIHJlc291cmNlIG1hbmFnZW1lbnRcbiAgY29uc3Qgc3RhY2tUYWdzID0ge1xuICAgIEVudmlyb25tZW50OiBlbnZpcm9ubWVudCxcbiAgICBQcm9qZWN0OiAnVGVzdEFwcCcsXG4gICAgTWFuYWdlZEJ5OiAnQ0RLJyxcbiAgICBEZXBsb3llZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG5cbiAgT2JqZWN0LmVudHJpZXMoc3RhY2tUYWdzKS5mb3JFYWNoKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICBjZGsuVGFncy5vZih2cGNTdGFjaykuYWRkKGtleSwgdmFsdWUpO1xuICAgIGNkay5UYWdzLm9mKGVjc1BsYXRmb3JtU3RhY2spLmFkZChrZXksIHZhbHVlKTtcbiAgICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoa2V5LCB2YWx1ZSk7XG4gIH0pO1xuXG4gIC8vIENyZWF0ZSBjb21wcmVoZW5zaXZlIHN0YWNrIG91dHB1dHMgZm9yIENJL0NEIGludGVncmF0aW9uXG4gIG5ldyBjZGsuQ2ZuT3V0cHV0KGFwcGxpY2F0aW9uU3RhY2ssICdEZXBsb3ltZW50U3VtbWFyeScsIHtcbiAgICB2YWx1ZTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIHN0YWNrczoge1xuICAgICAgICB2cGM6IHZwY1N0YWNrLnN0YWNrTmFtZSxcbiAgICAgICAgcGxhdGZvcm06IGVjc1BsYXRmb3JtU3RhY2suc3RhY2tOYW1lLFxuICAgICAgICBhcHBsaWNhdGlvbjogYXBwbGljYXRpb25TdGFjay5zdGFja05hbWUsXG4gICAgICB9LFxuICAgICAgc2VjdXJpdHlGZWF0dXJlczoge1xuICAgICAgICB2cGNGbG93TG9nczogY29uZmlnLmVuYWJsZVZQQ0Zsb3dMb2dzLFxuICAgICAgICB3YWY6IGNvbmZpZy5lbmFibGVXQUYsXG4gICAgICAgIGh0dHBzOiBodHRwc0VuYWJsZWQsXG4gICAgICAgIGNvbnRhaW5lclNlY3VyaXR5OiBjb25maWcuZW5hYmxlTm9uUm9vdENvbnRhaW5lciB8fCBjb25maWcuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSxcbiAgICAgIH0sXG4gICAgICBhcHBsaWNhdGlvblVybDogaHR0cHNFbmFibGVkICYmIGJhc2VEb21haW4gJiYgYXBwTmFtZSBcbiAgICAgICAgPyBgaHR0cHM6Ly8ke2Vudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBhcHBOYW1lIDogYCR7ZW52aXJvbm1lbnR9LSR7YXBwTmFtZX1gfS4ke2Jhc2VEb21haW59YFxuICAgICAgICA6ICdBdmFpbGFibGUgYWZ0ZXIgZGVwbG95bWVudCcsXG4gICAgfSwgbnVsbCwgMiksXG4gICAgZGVzY3JpcHRpb246ICdEZXBsb3ltZW50IFN1bW1hcnknLFxuICB9KTtcblxuICBjb25zb2xlLmxvZyhg4pyFIEluZnJhc3RydWN0dXJlIGNvbmZpZ3VyYXRpb24gY29tcGxldGVkIGZvciAke2Vudmlyb25tZW50fSBlbnZpcm9ubWVudGApO1xuICBjb25zb2xlLmxvZyhg8J+TnSBTdGFja3MgdG8gYmUgZGVwbG95ZWQ6YCk7XG4gIGNvbnNvbGUubG9nKGAgICAxLiAke3ZwY1N0YWNrLnN0YWNrTmFtZX0gKFZQQywgU3VibmV0cywgU2VjdXJpdHkgR3JvdXBzKWApO1xuICBjb25zb2xlLmxvZyhgICAgMi4gJHtlY3NQbGF0Zm9ybVN0YWNrLnN0YWNrTmFtZX0gKEVDUyBDbHVzdGVyLCBBTEIsIEVDUiR7Y29uZmlnLmVuYWJsZVdBRiA/ICcsIFdBRicgOiAnJ30ke2h0dHBzRW5hYmxlZCA/ICcsIFNTTCBDZXJ0aWZpY2F0ZScgOiAnJ30pYCk7XG4gIGNvbnNvbGUubG9nKGAgICAzLiAke2FwcGxpY2F0aW9uU3RhY2suc3RhY2tOYW1lfSAoRmFyZ2F0ZSBTZXJ2aWNlLCBBdXRvIFNjYWxpbmcsIFRhc2sgRGVmaW5pdGlvbilgKTtcbn1cblxuLy8gRmluYWwgYXBwbGljYXRpb24gVVJMIGluZm9ybWF0aW9uXG5pZiAoaHR0cHNFbmFibGVkKSB7XG4gIGNvbnNvbGUubG9nKGDwn5SSIEhUVFBTIGVuYWJsZWQgZm9yICR7YXBwTmFtZX0uJHtiYXNlRG9tYWlufSBhbmQgc3ViZG9tYWluc2ApO1xufSBlbHNlIGlmIChiYXNlRG9tYWluICYmIGFwcE5hbWUpIHtcbiAgY29uc29sZS5sb2coYOKaoO+4jyAgRG9tYWluIGNvbmZpZ3VyZWQgYnV0IEhUVFBTIGRpc2FibGVkIGZvciAke2Vudmlyb25tZW50fSBlbnZpcm9ubWVudGApO1xufSBlbHNlIHtcbiAgY29uc29sZS5sb2coYOKEue+4jyAgVXNpbmcgQUxCIEROUyBuYW1lIGZvciBhcHBsaWNhdGlvbiBhY2Nlc3NgKTtcbn1cblxuY29uc29sZS5sb2coYPCfjq8gQXBwbGljYXRpb24gd2lsbCBiZSBhY2Nlc3NpYmxlIGF0OmApO1xuaWYgKGJhc2VEb21haW4gJiYgYXBwTmFtZSkge1xuICBjb25zdCBhcHBVcmwgPSBodHRwc0VuYWJsZWQgPyAnaHR0cHM6Ly8nIDogJ2h0dHA6Ly8nO1xuICBpZiAocHJJZCkge1xuICAgIGNvbnN0IHNhbml0aXplZFBySWQgPSBwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnNvbGUubG9nKGAgICAke2FwcFVybH1wci0ke3Nhbml0aXplZFBySWR9LSR7YXBwTmFtZX0uJHtiYXNlRG9tYWlufWApO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHN1YmRvbWFpbiA9IGVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBhcHBOYW1lIDogYCR7ZW52aXJvbm1lbnR9LSR7YXBwTmFtZX1gO1xuICAgIGNvbnNvbGUubG9nKGAgICAke2FwcFVybH0ke3N1YmRvbWFpbn0uJHtiYXNlRG9tYWlufWApO1xuICB9XG59IGVsc2Uge1xuICBjb25zb2xlLmxvZyhgICAgaHR0cDovL3tBTEJfRE5TX05BTUV9YCk7XG59Il19