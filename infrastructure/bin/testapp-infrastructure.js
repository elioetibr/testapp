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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsdUNBQXFDO0FBQ3JDLG1DQUFtQztBQUNuQyxnREFBNEM7QUFDNUMsa0VBQTZEO0FBQzdELGdFQUE0RDtBQUU1RCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQixtREFBbUQ7QUFDbkQsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLElBQUksS0FBSyxDQUFDO0FBRW5FLHVFQUF1RTtBQUN2RSxNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWUsQ0FBQztBQUVoRyxzQ0FBc0M7QUFDdEMsTUFBTSxrQkFBa0IsR0FBd0I7SUFDOUMsR0FBRyxFQUFFO1FBQ0gsb0JBQW9CO1FBQ3BCLFVBQVUsRUFBRSxLQUFLO1FBQ2pCLG1CQUFtQixFQUFFLEtBQUs7UUFDMUIsTUFBTSxFQUFFLENBQUM7UUFDVCxXQUFXLEVBQUUsQ0FBQztRQUNkLE9BQU8sRUFBRSxhQUFhO1FBQ3RCLG9CQUFvQixFQUFFLEVBQUU7UUFDeEIscUJBQXFCLEVBQUUsRUFBRTtRQUV6QixnRUFBZ0U7UUFDaEUsaUJBQWlCLEVBQUUsS0FBSztRQUN4QixTQUFTLEVBQUUsS0FBSztRQUNoQixrRkFBa0Y7UUFFbEYsNkJBQTZCO1FBQzdCLFdBQVcsRUFBRSxtQkFBbUIsV0FBVyxFQUFFO1FBQzdDLGNBQWMsRUFBRSxTQUFTO1FBRXpCLDRCQUE0QjtRQUM1QixXQUFXLEVBQUUsbUJBQW1CLFdBQVcsRUFBRTtRQUM3QyxZQUFZLEVBQUUsUUFBUTtRQUN0QixZ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SUFBSSxVQUFVLElBQUksT0FBTyxFQUFFO0lBQ3pCLE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDckQsSUFBSSxJQUFJLEVBQUU7UUFDUixNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsT0FBTyxDQUFDLGNBQWMsRUFBRSxHQUFHLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUNqRixPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sTUFBTSxNQUFNLGFBQWEsSUFBSSxPQUFPLElBQUksVUFBVSxFQUFFLENBQUMsQ0FBQztLQUN6RTtTQUFNO1FBQ0wsTUFBTSxTQUFTLEdBQUcsV0FBVyxLQUFLLFlBQVksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLFdBQVcsSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUN2RixPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sTUFBTSxHQUFHLFNBQVMsSUFBSSxVQUFVLEVBQUUsQ0FBQyxDQUFDO0tBQ3ZEO0NBQ0Y7S0FBTTtJQUNMLE9BQU8sQ0FBQyxHQUFHLENBQUMsMEJBQTBCLENBQUMsQ0FBQztDQUN6QyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBWcGNTdGFjayB9IGZyb20gJy4uL2xpYi92cGMtc3RhY2snO1xuaW1wb3J0IHsgRWNzUGxhdGZvcm1TdGFjayB9IGZyb20gJy4uL2xpYi9lY3MtcGxhdGZvcm0tc3RhY2snO1xuaW1wb3J0IHsgQXBwbGljYXRpb25TdGFjayB9IGZyb20gJy4uL2xpYi9hcHBsaWNhdGlvbi1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbi8vIEdldCBlbnZpcm9ubWVudCBmcm9tIGNvbnRleHQgb3IgZGVmYXVsdCB0byAnZGV2J1xuY29uc3QgZW52aXJvbm1lbnQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdlbnZpcm9ubWVudCcpIHx8ICdkZXYnO1xuXG4vLyBHZXQgUFIgSUQgZm9yIGVwaGVtZXJhbCBkZXBsb3ltZW50cyAoZnJvbSBDSSBlbnZpcm9ubWVudCBvciBjb250ZXh0KVxuY29uc3QgcHJJZCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3BySWQnKSB8fCBwcm9jZXNzLmVudi5QUl9JRCB8fCBwcm9jZXNzLmVudi5HSVRIVUJfSEVBRF9SRUY7XG5cbi8vIEVudmlyb25tZW50LXNwZWNpZmljIGNvbmZpZ3VyYXRpb25zXG5jb25zdCBlbnZpcm9ubWVudENvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gIGRldjoge1xuICAgIC8vIFZQQyBDb25maWd1cmF0aW9uXG4gICAgZW5hYmxlSVB2NjogZmFsc2UsXG4gICAgZW5hYmxlSEFOYXRHYXRld2F5czogZmFsc2UsXG4gICAgbWF4QXpzOiAyLFxuICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgIHZwY0NpZHI6ICcxMC4wLjAuMC8xNicsXG4gICAgcHVibGljU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgXG4gICAgLy8gU2VjdXJpdHkgRmVhdHVyZXMgKGRpc2FibGVkIGJ5IGRlZmF1bHQgZm9yIGNvc3Qgb3B0aW1pemF0aW9uKVxuICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiBmYWxzZSxcbiAgICBlbmFibGVXQUY6IGZhbHNlLFxuICAgIC8vIEhUVFBTIGlzIGFsd2F5cyBlbmFibGVkIC0gcHJvdmlkZSBjZXJ0aWZpY2F0ZUFybiBvciBiYXNlRG9tYWluIHRvIGNvbmZpZ3VyZSBTU0xcbiAgICBcbiAgICAvLyBFQ1MgUGxhdGZvcm0gQ29uZmlndXJhdGlvblxuICAgIGNsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7ZW52aXJvbm1lbnR9YCxcbiAgICByZXBvc2l0b3J5TmFtZTogJ3Rlc3RhcHAnLFxuICAgIFxuICAgIC8vIEFwcGxpY2F0aW9uIENvbmZpZ3VyYXRpb25cbiAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fWAsXG4gICAgdGFza0ltYWdlVGFnOiAnbGF0ZXN0JyxcbiAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgY3B1OiAyNTYsXG4gICAgbWVtb3J5TGltaXRNaUI6IDUxMixcbiAgICBjb250YWluZXJQb3J0OiA4MDAwLFxuICAgIFxuICAgIC8vIEF1dG8gU2NhbGluZyBDb25maWd1cmF0aW9uXG4gICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgbWF4Q2FwYWNpdHk6IDMsXG4gICAgY3B1VGFyZ2V0VXRpbGl6YXRpb246IDcwLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiA4MCxcbiAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiA1LFxuICAgIHNjYWxlT3V0Q29vbGRvd25NaW51dGVzOiAyLFxuICAgIFxuICAgIC8vIEhlYWx0aCBDaGVjayBDb25maWd1cmF0aW9uXG4gICAgaGVhbHRoQ2hlY2tQYXRoOiAnL2hlYWx0aC8nLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWw6IDMwLFxuICAgIGhlYWx0aENoZWNrVGltZW91dDogNSxcbiAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDMsXG4gICAgXG4gICAgLy8gQ29udGFpbmVyIFNlY3VyaXR5IChkaXNhYmxlZCBieSBkZWZhdWx0KVxuICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IGZhbHNlLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IGZhbHNlLFxuICAgIFxuICAgIC8vIEVudmlyb25tZW50IFZhcmlhYmxlc1xuICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICBERUJVRzogJ3RydWUnLFxuICAgIH0sXG4gIH0sXG4gIFxuICBwcm9kdWN0aW9uOiB7XG4gICAgLy8gVlBDIENvbmZpZ3VyYXRpb25cbiAgICBlbmFibGVJUHY2OiB0cnVlLFxuICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IHRydWUsXG4gICAgbWF4QXpzOiAzLFxuICAgIG5hdEdhdGV3YXlzOiAzLFxuICAgIHZwY0NpZHI6ICcxMC4yLjAuMC8xNicsXG4gICAgcHVibGljU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgIHByaXZhdGVTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgXG4gICAgLy8gU2VjdXJpdHkgRmVhdHVyZXMgKGZ1bGx5IGVuYWJsZWQgZm9yIHByb2R1Y3Rpb24pXG4gICAgZW5hYmxlVlBDRmxvd0xvZ3M6IHRydWUsXG4gICAgZW5hYmxlV0FGOiB0cnVlLFxuICAgIC8vIEhUVFBTIGlzIG1hbmRhdG9yeSAtIGNvbmZpZ3VyZSBiYXNlRG9tYWluIGFuZCBhcHBOYW1lIGZvciBhdXRvbWF0aWMgY2VydGlmaWNhdGVcbiAgICBcbiAgICAvLyBFQ1MgUGxhdGZvcm0gQ29uZmlndXJhdGlvblxuICAgIGNsdXN0ZXJOYW1lOiBgdGVzdGFwcC1jbHVzdGVyLSR7ZW52aXJvbm1lbnR9YCxcbiAgICByZXBvc2l0b3J5TmFtZTogJ3Rlc3RhcHAnLFxuICAgIFxuICAgIC8vIEFwcGxpY2F0aW9uIENvbmZpZ3VyYXRpb25cbiAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fWAsXG4gICAgdGFza0ltYWdlVGFnOiAnbGF0ZXN0JyxcbiAgICBkZXNpcmVkQ291bnQ6IDMsXG4gICAgY3B1OiAxMDI0LFxuICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxuICAgIGNvbnRhaW5lclBvcnQ6IDgwMDAsXG4gICAgXG4gICAgLy8gQXV0byBTY2FsaW5nIENvbmZpZ3VyYXRpb25cbiAgICBtaW5DYXBhY2l0eTogMyxcbiAgICBtYXhDYXBhY2l0eTogMTIsXG4gICAgY3B1VGFyZ2V0VXRpbGl6YXRpb246IDYwLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiA3MCxcbiAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiAxMCxcbiAgICBzY2FsZU91dENvb2xkb3duTWludXRlczogMyxcbiAgICBcbiAgICAvLyBIZWFsdGggQ2hlY2sgQ29uZmlndXJhdGlvblxuICAgIGhlYWx0aENoZWNrUGF0aDogJy9oZWFsdGgvJyxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiAzMCxcbiAgICBoZWFsdGhDaGVja1RpbWVvdXQ6IDUsXG4gICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgIFxuICAgIC8vIENvbnRhaW5lciBTZWN1cml0eSAoZnVsbHkgZW5hYmxlZCBmb3IgcHJvZHVjdGlvbilcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiB0cnVlLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IHRydWUsXG4gICAgXG4gICAgLy8gRW52aXJvbm1lbnQgVmFyaWFibGVzXG4gICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgIERFQlVHOiAnZmFsc2UnLFxuICAgIH0sXG4gIH0sXG59O1xuXG4vLyBHZXQgY29uZmlndXJhdGlvbiBmb3IgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnRcbmNvbnN0IGNvbmZpZyA9IGVudmlyb25tZW50Q29uZmlnc1tlbnZpcm9ubWVudF07XG5pZiAoIWNvbmZpZykge1xuICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gZW52aXJvbm1lbnQ6ICR7ZW52aXJvbm1lbnR9LiBTdXBwb3J0ZWQgZW52aXJvbm1lbnRzOiAke09iamVjdC5rZXlzKGVudmlyb25tZW50Q29uZmlncykuam9pbignLCAnKX1gKTtcbn1cblxuLy8gRG9tYWluIGNvbmZpZ3VyYXRpb25cbmNvbnN0IGJhc2VEb21haW4gPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdiYXNlRG9tYWluJyk7XG5jb25zdCBob3N0ZWRab25lSWQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdob3N0ZWRab25lSWQnKTtcbmNvbnN0IGFwcE5hbWUgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdhcHBOYW1lJyk7XG5cbi8vIEVuYWJsZSBIVFRQUyBpZiBkb21haW4gY29uZmlnIGlzIHByb3ZpZGVkIChIVFRQUyBpcyBtYW5kYXRvcnkgd2hlbiBwb3NzaWJsZSlcbmNvbnN0IGh0dHBzRW5hYmxlZCA9IGJhc2VEb21haW4gJiYgYXBwTmFtZTtcblxuY29uc29sZS5sb2coYPCfmoAgRGVwbG95aW5nIFRlc3RBcHAgaW5mcmFzdHJ1Y3R1cmUgZm9yIGVudmlyb25tZW50OiAke2Vudmlyb25tZW50fWApO1xuaWYgKHBySWQpIHtcbiAgY29uc29sZS5sb2coYPCflIAgUFIgRGVwbG95bWVudCBkZXRlY3RlZDogJHtwcklkfWApO1xufVxuY29uc29sZS5sb2coYPCfk4ogQ29uZmlndXJhdGlvbjpgLCBKU09OLnN0cmluZ2lmeSh7XG4gIGVudmlyb25tZW50LFxuICBwcklkOiBwcklkIHx8ICdOb3QgYSBQUiBkZXBsb3ltZW50JyxcbiAgYXBwTmFtZTogYXBwTmFtZSB8fCAnTm90IGNvbmZpZ3VyZWQnLFxuICBiYXNlRG9tYWluOiBiYXNlRG9tYWluIHx8ICdOb3QgY29uZmlndXJlZCcsIFxuICBodHRwc0VuYWJsZWQsXG4gIHNlY3VyaXR5RmVhdHVyZXM6IHtcbiAgICBlbmFibGVWUENGbG93TG9nczogY29uZmlnLmVuYWJsZVZQQ0Zsb3dMb2dzLFxuICAgIGVuYWJsZVdBRjogY29uZmlnLmVuYWJsZVdBRixcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiBjb25maWcuZW5hYmxlTm9uUm9vdENvbnRhaW5lcixcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBjb25maWcuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSxcbiAgfVxufSwgbnVsbCwgMikpO1xuXG4vLyBDb21tb24gc3RhY2sgcHJvcHNcbmNvbnN0IGNvbW1vblByb3BzID0ge1xuICBlbnY6IHtcbiAgICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICAgIHJlZ2lvbjogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfUkVHSU9OIHx8ICd1cy1lYXN0LTEnLFxuICB9LFxufTtcblxuaWYgKHBySWQpIHtcbiAgLy8gRm9yIFBSIGRlcGxveW1lbnRzOiBPbmx5IGNyZWF0ZSBhcHBsaWNhdGlvbiBzdGFjaywgcmV1c2UgZXhpc3RpbmcgVlBDIGFuZCBFQ1MgUGxhdGZvcm1cbiAgY29uc29sZS5sb2coYPCflIAgQ3JlYXRpbmcgZXBoZW1lcmFsIFBSIGRlcGxveW1lbnQ6IHJldXNpbmcgJHtlbnZpcm9ubWVudH0gVlBDIGFuZCBFQ1MgY2x1c3RlcmApO1xuICBcbiAgLy8gSW1wb3J0IGV4aXN0aW5nIFZQQyBhbmQgUGxhdGZvcm0gcmVzb3VyY2VzXG4gIGNvbnN0IGV4aXN0aW5nVnBjSWQgPSBgVGVzdEFwcC1WUEMtJHtlbnZpcm9ubWVudH1gO1xuICBjb25zdCBleGlzdGluZ1BsYXRmb3JtSWQgPSBgVGVzdEFwcC1QbGF0Zm9ybS0ke2Vudmlyb25tZW50fWA7XG4gIFxuICAvLyBHZW5lcmF0ZSB1bmlxdWUgc3RhY2sgbmFtZSBmb3IgUFIgYXBwbGljYXRpb25cbiAgY29uc3QgcHJTdGFja05hbWUgPSBgVGVzdEFwcC1BcHAtJHtlbnZpcm9ubWVudH0tcHItJHtwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpfWA7XG4gIFxuICAvLyBDcmVhdGUgb25seSBBcHBsaWNhdGlvbiBTdGFjayBmb3IgUFIgKHJldXNpbmcgZXhpc3RpbmcgaW5mcmFzdHJ1Y3R1cmUpXG4gIGNvbnN0IGFwcGxpY2F0aW9uU3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsIHByU3RhY2tOYW1lLCB7XG4gICAgLi4uY29tbW9uUHJvcHMsXG4gICAgc3RhY2tOYW1lOiBwclN0YWNrTmFtZSxcbiAgICBlbnZpcm9ubWVudCxcbiAgICAvLyBJbXBvcnQgZXhpc3RpbmcgVlBDIHJlc291cmNlcyBieSByZWZlcmVuY2luZyB0aGUgZXhpc3Rpbmcgc3RhY2tcbiAgICB2cGNJZDogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nVnBjSWR9LVZwY0lkYCksXG4gICAgcHJpdmF0ZVN1Ym5ldElkczogW1xuICAgICAgY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nVnBjSWR9LVByaXZhdGVTdWJuZXQxSWRgKSxcbiAgICAgIGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1ZwY0lkfS1Qcml2YXRlU3VibmV0MklkYCksXG4gICAgXSxcbiAgICBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZDogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nVnBjSWR9LUFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkYCksXG4gICAgLy8gSW1wb3J0IGV4aXN0aW5nIEVDUyBQbGF0Zm9ybSByZXNvdXJjZXNcbiAgICBjbHVzdGVyQXJuOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1DbHVzdGVyQXJuYCksXG4gICAgY2x1c3Rlck5hbWU6IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUNsdXN0ZXJOYW1lYCksXG4gICAgcmVwb3NpdG9yeVVyaTogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tUmVwb3NpdG9yeVVyaWApLFxuICAgIGxvYWRCYWxhbmNlckFybjogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tTG9hZEJhbGFuY2VyQXJuYCksXG4gICAgaHR0cExpc3RlbmVyQXJuOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1IdHRwTGlzdGVuZXJBcm5gKSxcbiAgICBodHRwc0xpc3RlbmVyQXJuOiBodHRwc0VuYWJsZWQgPyBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1IdHRwc0xpc3RlbmVyQXJuYCkgOiB1bmRlZmluZWQsXG4gICAgbG9nR3JvdXBOYW1lOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1Mb2dHcm91cE5hbWVgKSxcbiAgICBsb2dHcm91cEFybjogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tTG9nR3JvdXBBcm5gKSxcbiAgICAvLyBBcHBsaWNhdGlvbiBjb25maWd1cmF0aW9uIC0gdW5pcXVlIHNlcnZpY2UgbmFtZSBmb3IgUFJcbiAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fS1wci0ke3BySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCl9YCxcbiAgICB0YXNrSW1hZ2VUYWc6IGNvbmZpZy50YXNrSW1hZ2VUYWcsXG4gICAgZGVzaXJlZENvdW50OiAxLCAvLyBVc2UgbWluaW1hbCByZXNvdXJjZXMgZm9yIFBSXG4gICAgY3B1OiBjb25maWcuY3B1LFxuICAgIG1lbW9yeUxpbWl0TWlCOiBjb25maWcubWVtb3J5TGltaXRNaUIsXG4gICAgY29udGFpbmVyUG9ydDogY29uZmlnLmNvbnRhaW5lclBvcnQsXG4gICAgLy8gTWluaW1hbCBhdXRvIHNjYWxpbmcgZm9yIFBSXG4gICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgbWF4Q2FwYWNpdHk6IDIsXG4gICAgY3B1VGFyZ2V0VXRpbGl6YXRpb246IGNvbmZpZy5jcHVUYXJnZXRVdGlsaXphdGlvbixcbiAgICBtZW1vcnlUYXJnZXRVdGlsaXphdGlvbjogY29uZmlnLm1lbW9yeVRhcmdldFV0aWxpemF0aW9uLFxuICAgIHNjYWxlSW5Db29sZG93bk1pbnV0ZXM6IGNvbmZpZy5zY2FsZUluQ29vbGRvd25NaW51dGVzLFxuICAgIHNjYWxlT3V0Q29vbGRvd25NaW51dGVzOiBjb25maWcuc2NhbGVPdXRDb29sZG93bk1pbnV0ZXMsXG4gICAgLy8gSGVhbHRoIGNoZWNrIGNvbmZpZ3VyYXRpb25cbiAgICBoZWFsdGhDaGVja1BhdGg6IGNvbmZpZy5oZWFsdGhDaGVja1BhdGgsXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogY29uZmlnLmhlYWx0aENoZWNrSW50ZXJ2YWwsXG4gICAgaGVhbHRoQ2hlY2tUaW1lb3V0OiBjb25maWcuaGVhbHRoQ2hlY2tUaW1lb3V0LFxuICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogY29uZmlnLmhlYWx0aHlUaHJlc2hvbGRDb3VudCxcbiAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogY29uZmlnLnVuaGVhbHRoeVRocmVzaG9sZENvdW50LFxuICAgIC8vIENvbnRhaW5lciBzZWN1cml0eVxuICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IGNvbmZpZy5lbmFibGVOb25Sb290Q29udGFpbmVyLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IGNvbmZpZy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtLFxuICAgIC8vIEVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgIGVudmlyb25tZW50VmFyaWFibGVzOiBjb25maWcuZW52aXJvbm1lbnRWYXJpYWJsZXMsXG4gICAgLy8gRG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICBiYXNlRG9tYWluOiBiYXNlRG9tYWluLFxuICAgIGFwcE5hbWU6IGFwcE5hbWUsXG4gICAgcHJJZDogcHJJZCxcbiAgICBob3N0ZWRab25lSWQ6IGhvc3RlZFpvbmVJZCxcbiAgfSk7XG5cbiAgLy8gQWRkIHN0YWNrIHRhZ3MgZm9yIFBSIGRlcGxveW1lbnRcbiAgY2RrLlRhZ3Mub2YoYXBwbGljYXRpb25TdGFjaykuYWRkKCdFbnZpcm9ubWVudCcsIGVudmlyb25tZW50KTtcbiAgY2RrLlRhZ3Mub2YoYXBwbGljYXRpb25TdGFjaykuYWRkKCdQcm9qZWN0JywgJ1Rlc3RBcHAnKTtcbiAgY2RrLlRhZ3Mub2YoYXBwbGljYXRpb25TdGFjaykuYWRkKCdNYW5hZ2VkQnknLCAnQ0RLJyk7XG4gIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZCgnRGVwbG95bWVudFR5cGUnLCAnUFItRXBoZW1lcmFsJyk7XG4gIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZCgnUFJJZCcsIHBySWQudG9TdHJpbmcoKSk7XG4gIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZCgnRGVwbG95ZWRBdCcsIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7XG5cbiAgLy8gR2VuZXJhdGUgUFIgZG9tYWluIG5hbWVcbiAgY29uc3QgcHJEb21haW5OYW1lID0gYmFzZURvbWFpbiAmJiBhcHBOYW1lIFxuICAgID8gYHByLSR7cHJJZC50b1N0cmluZygpLnJlcGxhY2UoL1teYS16MC05LV0vZ2ksICctJykudG9Mb3dlckNhc2UoKX0tJHthcHBOYW1lfS4ke2Jhc2VEb21haW59YFxuICAgIDogdW5kZWZpbmVkO1xuXG4gIC8vIE91dHB1dCBmb3IgUFIgZGVwbG95bWVudFxuICBuZXcgY2RrLkNmbk91dHB1dChhcHBsaWNhdGlvblN0YWNrLCAnUFJEZXBsb3ltZW50U3VtbWFyeScsIHtcbiAgICB2YWx1ZTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcHJJZCxcbiAgICAgIGVudmlyb25tZW50LFxuICAgICAgc2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtlbnZpcm9ubWVudH0tcHItJHtwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpfWAsXG4gICAgICBkb21haW5OYW1lOiBwckRvbWFpbk5hbWUsXG4gICAgICBhcHBsaWNhdGlvblVybDogcHJEb21haW5OYW1lID8gKGh0dHBzRW5hYmxlZCA/IGBodHRwczovLyR7cHJEb21haW5OYW1lfWAgOiBgaHR0cDovLyR7cHJEb21haW5OYW1lfWApIDogJ0F2YWlsYWJsZSBhZnRlciBkZXBsb3ltZW50JyxcbiAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIH0sIG51bGwsIDIpLFxuICAgIGRlc2NyaXB0aW9uOiAnUFIgRGVwbG95bWVudCBTdW1tYXJ5JyxcbiAgfSk7XG5cbiAgY29uc29sZS5sb2coYOKchSBQUiBkZXBsb3ltZW50IGNvbmZpZ3VyYXRpb24gY29tcGxldGVkYCk7XG4gIGNvbnNvbGUubG9nKGDwn5OdIFBSIFN0YWNrIHRvIGJlIGRlcGxveWVkOiAke3ByU3RhY2tOYW1lfWApO1xuICBjb25zb2xlLmxvZyhg8J+UlyBTZXJ2aWNlIG5hbWU6IHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fS1wci0ke3BySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCl9YCk7XG4gIGlmIChwckRvbWFpbk5hbWUpIHtcbiAgICBjb25zb2xlLmxvZyhg8J+MkCBEb21haW46ICR7cHJEb21haW5OYW1lfWApO1xuICB9XG4gIFxufSBlbHNlIHtcbiAgLy8gUmVndWxhciBkZXBsb3ltZW50OiBDcmVhdGUgZnVsbCBpbmZyYXN0cnVjdHVyZVxuICBjb25zb2xlLmxvZyhg8J+Pl++4jyBDcmVhdGluZyBmdWxsIGluZnJhc3RydWN0dXJlIGRlcGxveW1lbnQgZm9yICR7ZW52aXJvbm1lbnR9YCk7XG5cbiAgLy8gMS4gQ3JlYXRlIFZQQyBTdGFjayAoRm91bmRhdGlvbiBMYXllcilcbiAgY29uc3QgdnBjU3RhY2sgPSBuZXcgVnBjU3RhY2soYXBwLCBgVGVzdEFwcC1WUEMtJHtlbnZpcm9ubWVudH1gLCB7XG4gICAgLi4uY29tbW9uUHJvcHMsXG4gICAgc3RhY2tOYW1lOiBgVGVzdEFwcC1WUEMtJHtlbnZpcm9ubWVudH1gLFxuICAgIGVudmlyb25tZW50LFxuICAgIGVuYWJsZUlQdjY6IGNvbmZpZy5lbmFibGVJUHY2LFxuICAgIGVuYWJsZUhBTmF0R2F0ZXdheXM6IGNvbmZpZy5lbmFibGVIQU5hdEdhdGV3YXlzLFxuICAgIG1heEF6czogY29uZmlnLm1heEF6cyxcbiAgICBuYXRHYXRld2F5czogY29uZmlnLm5hdEdhdGV3YXlzLFxuICAgIHZwY0NpZHI6IGNvbmZpZy52cGNDaWRyLFxuICAgIHB1YmxpY1N1Ym5ldENpZHJNYXNrOiBjb25maWcucHVibGljU3VibmV0Q2lkck1hc2ssXG4gICAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrOiBjb25maWcucHJpdmF0ZVN1Ym5ldENpZHJNYXNrLFxuICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiBjb25maWcuZW5hYmxlVlBDRmxvd0xvZ3MsXG4gIH0pO1xuXG4gIC8vIDIuIENyZWF0ZSBFQ1MgUGxhdGZvcm0gU3RhY2sgKFBsYXRmb3JtIExheWVyKVxuICBjb25zdCBlY3NQbGF0Zm9ybVN0YWNrID0gbmV3IEVjc1BsYXRmb3JtU3RhY2soYXBwLCBgVGVzdEFwcC1QbGF0Zm9ybS0ke2Vudmlyb25tZW50fWAsIHtcbiAgICAuLi5jb21tb25Qcm9wcyxcbiAgICBzdGFja05hbWU6IGBUZXN0QXBwLVBsYXRmb3JtLSR7ZW52aXJvbm1lbnR9YCxcbiAgICBlbnZpcm9ubWVudCxcbiAgICAvLyBWUEMgY29uZmlndXJhdGlvbiBmcm9tIFZQQyBzdGFja1xuICAgIHZwY0lkOiB2cGNTdGFjay52cGMudnBjSWQsXG4gICAgcHVibGljU3VibmV0SWRzOiB2cGNTdGFjay5wdWJsaWNTdWJuZXRzLm1hcChzdWJuZXQgPT4gc3VibmV0LnN1Ym5ldElkKSxcbiAgICBsb2FkQmFsYW5jZXJTZWN1cml0eUdyb3VwSWQ6IHZwY1N0YWNrLmxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXAuc2VjdXJpdHlHcm91cElkLFxuICAgIC8vIFBsYXRmb3JtIGNvbmZpZ3VyYXRpb25cbiAgICBjbHVzdGVyTmFtZTogY29uZmlnLmNsdXN0ZXJOYW1lLFxuICAgIHJlcG9zaXRvcnlOYW1lOiBjb25maWcucmVwb3NpdG9yeU5hbWUsXG4gICAgLy8gU2VjdXJpdHkgZW5oYW5jZW1lbnRzXG4gICAgZW5hYmxlV0FGOiBjb25maWcuZW5hYmxlV0FGLFxuICAgIGhvc3RlZFpvbmVJZDogaG9zdGVkWm9uZUlkLFxuICAgIGJhc2VEb21haW46IGJhc2VEb21haW4sXG4gICAgYXBwTmFtZTogYXBwTmFtZSxcbiAgfSk7XG5cbiAgLy8gMy4gQ3JlYXRlIEFwcGxpY2F0aW9uIERlcGxveW1lbnQgU3RhY2sgKFNlcnZpY2UgTGF5ZXIpXG4gIGNvbnN0IGFwcGxpY2F0aW9uU3RhY2sgPSBuZXcgQXBwbGljYXRpb25TdGFjayhhcHAsIGBUZXN0QXBwLUFwcC0ke2Vudmlyb25tZW50fWAsIHtcbiAgICAuLi5jb21tb25Qcm9wcyxcbiAgICBzdGFja05hbWU6IGBUZXN0QXBwLUFwcC0ke2Vudmlyb25tZW50fWAsXG4gICAgZW52aXJvbm1lbnQsXG4gICAgLy8gVlBDIGNvbmZpZ3VyYXRpb24gZnJvbSBWUEMgc3RhY2tcbiAgICB2cGNJZDogdnBjU3RhY2sudnBjLnZwY0lkLFxuICAgIHByaXZhdGVTdWJuZXRJZHM6IHZwY1N0YWNrLnByaXZhdGVTdWJuZXRzLm1hcChzdWJuZXQgPT4gc3VibmV0LnN1Ym5ldElkKSxcbiAgICBhcHBsaWNhdGlvblNlY3VyaXR5R3JvdXBJZDogdnBjU3RhY2suYXBwbGljYXRpb25TZWN1cml0eUdyb3VwLnNlY3VyaXR5R3JvdXBJZCxcbiAgICAvLyBFQ1MgUGxhdGZvcm0gY29uZmlndXJhdGlvbiBmcm9tIFBsYXRmb3JtIHN0YWNrXG4gICAgY2x1c3RlckFybjogZWNzUGxhdGZvcm1TdGFjay5jbHVzdGVyLmNsdXN0ZXJBcm4sXG4gICAgY2x1c3Rlck5hbWU6IGVjc1BsYXRmb3JtU3RhY2suY2x1c3Rlci5jbHVzdGVyTmFtZSxcbiAgICByZXBvc2l0b3J5VXJpOiBlY3NQbGF0Zm9ybVN0YWNrLnJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICBsb2FkQmFsYW5jZXJBcm46IGVjc1BsYXRmb3JtU3RhY2subG9hZEJhbGFuY2VyLmxvYWRCYWxhbmNlckFybixcbiAgICBodHRwTGlzdGVuZXJBcm46IGVjc1BsYXRmb3JtU3RhY2suaHR0cExpc3RlbmVyLmxpc3RlbmVyQXJuLFxuICAgIGh0dHBzTGlzdGVuZXJBcm46IGVjc1BsYXRmb3JtU3RhY2suaHR0cHNMaXN0ZW5lcj8ubGlzdGVuZXJBcm4sXG4gICAgbG9nR3JvdXBOYW1lOiBlY3NQbGF0Zm9ybVN0YWNrLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICBsb2dHcm91cEFybjogZWNzUGxhdGZvcm1TdGFjay5sb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAvLyBBcHBsaWNhdGlvbiBjb25maWd1cmF0aW9uXG4gICAgc2VydmljZU5hbWU6IGNvbmZpZy5zZXJ2aWNlTmFtZSxcbiAgICB0YXNrSW1hZ2VUYWc6IGNvbmZpZy50YXNrSW1hZ2VUYWcsXG4gICAgZGVzaXJlZENvdW50OiBjb25maWcuZGVzaXJlZENvdW50LFxuICAgIGNwdTogY29uZmlnLmNwdSxcbiAgICBtZW1vcnlMaW1pdE1pQjogY29uZmlnLm1lbW9yeUxpbWl0TWlCLFxuICAgIGNvbnRhaW5lclBvcnQ6IGNvbmZpZy5jb250YWluZXJQb3J0LFxuICAgIC8vIEF1dG8gc2NhbGluZyBjb25maWd1cmF0aW9uXG4gICAgbWluQ2FwYWNpdHk6IGNvbmZpZy5taW5DYXBhY2l0eSxcbiAgICBtYXhDYXBhY2l0eTogY29uZmlnLm1heENhcGFjaXR5LFxuICAgIGNwdVRhcmdldFV0aWxpemF0aW9uOiBjb25maWcuY3B1VGFyZ2V0VXRpbGl6YXRpb24sXG4gICAgbWVtb3J5VGFyZ2V0VXRpbGl6YXRpb246IGNvbmZpZy5tZW1vcnlUYXJnZXRVdGlsaXphdGlvbixcbiAgICBzY2FsZUluQ29vbGRvd25NaW51dGVzOiBjb25maWcuc2NhbGVJbkNvb2xkb3duTWludXRlcyxcbiAgICBzY2FsZU91dENvb2xkb3duTWludXRlczogY29uZmlnLnNjYWxlT3V0Q29vbGRvd25NaW51dGVzLFxuICAgIC8vIEhlYWx0aCBjaGVjayBjb25maWd1cmF0aW9uXG4gICAgaGVhbHRoQ2hlY2tQYXRoOiBjb25maWcuaGVhbHRoQ2hlY2tQYXRoLFxuICAgIGhlYWx0aENoZWNrSW50ZXJ2YWw6IGNvbmZpZy5oZWFsdGhDaGVja0ludGVydmFsLFxuICAgIGhlYWx0aENoZWNrVGltZW91dDogY29uZmlnLmhlYWx0aENoZWNrVGltZW91dCxcbiAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IGNvbmZpZy5oZWFsdGh5VGhyZXNob2xkQ291bnQsXG4gICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IGNvbmZpZy51bmhlYWx0aHlUaHJlc2hvbGRDb3VudCxcbiAgICAvLyBDb250YWluZXIgc2VjdXJpdHlcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiBjb25maWcuZW5hYmxlTm9uUm9vdENvbnRhaW5lcixcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBjb25maWcuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSxcbiAgICAvLyBFbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICBlbnZpcm9ubWVudFZhcmlhYmxlczogY29uZmlnLmVudmlyb25tZW50VmFyaWFibGVzLFxuICAgIC8vIERvbWFpbiBjb25maWd1cmF0aW9uXG4gICAgYmFzZURvbWFpbjogYmFzZURvbWFpbixcbiAgICBhcHBOYW1lOiBhcHBOYW1lLFxuICAgIGhvc3RlZFpvbmVJZDogaG9zdGVkWm9uZUlkLFxuICB9KTtcblxuICAvLyBBZGQgZXhwbGljaXQgZGVwZW5kZW5jaWVzIHRvIGVuc3VyZSBjb3JyZWN0IGRlcGxveW1lbnQgb3JkZXJcbiAgZWNzUGxhdGZvcm1TdGFjay5hZGREZXBlbmRlbmN5KHZwY1N0YWNrKTtcbiAgYXBwbGljYXRpb25TdGFjay5hZGREZXBlbmRlbmN5KGVjc1BsYXRmb3JtU3RhY2spO1xuXG4gIC8vIEFkZCBzdGFjayB0YWdzIGZvciBiZXR0ZXIgcmVzb3VyY2UgbWFuYWdlbWVudFxuICBjb25zdCBzdGFja1RhZ3MgPSB7XG4gICAgRW52aXJvbm1lbnQ6IGVudmlyb25tZW50LFxuICAgIFByb2plY3Q6ICdUZXN0QXBwJyxcbiAgICBNYW5hZ2VkQnk6ICdDREsnLFxuICAgIERlcGxveWVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfTtcblxuICBPYmplY3QuZW50cmllcyhzdGFja1RhZ3MpLmZvckVhY2goKFtrZXksIHZhbHVlXSkgPT4ge1xuICAgIGNkay5UYWdzLm9mKHZwY1N0YWNrKS5hZGQoa2V5LCB2YWx1ZSk7XG4gICAgY2RrLlRhZ3Mub2YoZWNzUGxhdGZvcm1TdGFjaykuYWRkKGtleSwgdmFsdWUpO1xuICAgIGNkay5UYWdzLm9mKGFwcGxpY2F0aW9uU3RhY2spLmFkZChrZXksIHZhbHVlKTtcbiAgfSk7XG5cbiAgLy8gQ3JlYXRlIGNvbXByZWhlbnNpdmUgc3RhY2sgb3V0cHV0cyBmb3IgQ0kvQ0QgaW50ZWdyYXRpb25cbiAgbmV3IGNkay5DZm5PdXRwdXQoYXBwbGljYXRpb25TdGFjaywgJ0RlcGxveW1lbnRTdW1tYXJ5Jywge1xuICAgIHZhbHVlOiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBlbnZpcm9ubWVudCxcbiAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgc3RhY2tzOiB7XG4gICAgICAgIHZwYzogdnBjU3RhY2suc3RhY2tOYW1lLFxuICAgICAgICBwbGF0Zm9ybTogZWNzUGxhdGZvcm1TdGFjay5zdGFja05hbWUsXG4gICAgICAgIGFwcGxpY2F0aW9uOiBhcHBsaWNhdGlvblN0YWNrLnN0YWNrTmFtZSxcbiAgICAgIH0sXG4gICAgICBzZWN1cml0eUZlYXR1cmVzOiB7XG4gICAgICAgIHZwY0Zsb3dMb2dzOiBjb25maWcuZW5hYmxlVlBDRmxvd0xvZ3MsXG4gICAgICAgIHdhZjogY29uZmlnLmVuYWJsZVdBRixcbiAgICAgICAgaHR0cHM6IGh0dHBzRW5hYmxlZCxcbiAgICAgICAgY29udGFpbmVyU2VjdXJpdHk6IGNvbmZpZy5lbmFibGVOb25Sb290Q29udGFpbmVyIHx8IGNvbmZpZy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtLFxuICAgICAgfSxcbiAgICAgIGFwcGxpY2F0aW9uVXJsOiBodHRwc0VuYWJsZWQgJiYgYmFzZURvbWFpbiAmJiBhcHBOYW1lIFxuICAgICAgICA/IGBodHRwczovLyR7ZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IGFwcE5hbWUgOiBgJHtlbnZpcm9ubWVudH0tJHthcHBOYW1lfWB9LiR7YmFzZURvbWFpbn1gXG4gICAgICAgIDogJ0F2YWlsYWJsZSBhZnRlciBkZXBsb3ltZW50JyxcbiAgICB9LCBudWxsLCAyKSxcbiAgICBkZXNjcmlwdGlvbjogJ0RlcGxveW1lbnQgU3VtbWFyeScsXG4gIH0pO1xuXG4gIGNvbnNvbGUubG9nKGDinIUgSW5mcmFzdHJ1Y3R1cmUgY29uZmlndXJhdGlvbiBjb21wbGV0ZWQgZm9yICR7ZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCk7XG4gIGNvbnNvbGUubG9nKGDwn5OdIFN0YWNrcyB0byBiZSBkZXBsb3llZDpgKTtcbiAgY29uc29sZS5sb2coYCAgIDEuICR7dnBjU3RhY2suc3RhY2tOYW1lfSAoVlBDLCBTdWJuZXRzLCBTZWN1cml0eSBHcm91cHMpYCk7XG4gIGNvbnNvbGUubG9nKGAgICAyLiAke2Vjc1BsYXRmb3JtU3RhY2suc3RhY2tOYW1lfSAoRUNTIENsdXN0ZXIsIEFMQiwgRUNSJHtjb25maWcuZW5hYmxlV0FGID8gJywgV0FGJyA6ICcnfSR7aHR0cHNFbmFibGVkID8gJywgU1NMIENlcnRpZmljYXRlJyA6ICcnfSlgKTtcbiAgY29uc29sZS5sb2coYCAgIDMuICR7YXBwbGljYXRpb25TdGFjay5zdGFja05hbWV9IChGYXJnYXRlIFNlcnZpY2UsIEF1dG8gU2NhbGluZywgVGFzayBEZWZpbml0aW9uKWApO1xufVxuXG4vLyBGaW5hbCBhcHBsaWNhdGlvbiBVUkwgaW5mb3JtYXRpb25cbmlmIChodHRwc0VuYWJsZWQpIHtcbiAgY29uc29sZS5sb2coYPCflJIgSFRUUFMgZW5hYmxlZCBmb3IgJHthcHBOYW1lfS4ke2Jhc2VEb21haW59IGFuZCBzdWJkb21haW5zYCk7XG59IGVsc2UgaWYgKGJhc2VEb21haW4gJiYgYXBwTmFtZSkge1xuICBjb25zb2xlLmxvZyhg4pqg77iPICBEb21haW4gY29uZmlndXJlZCBidXQgSFRUUFMgZGlzYWJsZWQgZm9yICR7ZW52aXJvbm1lbnR9IGVudmlyb25tZW50YCk7XG59IGVsc2Uge1xuICBjb25zb2xlLmxvZyhg4oS577iPICBVc2luZyBBTEIgRE5TIG5hbWUgZm9yIGFwcGxpY2F0aW9uIGFjY2Vzc2ApO1xufVxuXG5jb25zb2xlLmxvZyhg8J+OryBBcHBsaWNhdGlvbiB3aWxsIGJlIGFjY2Vzc2libGUgYXQ6YCk7XG5pZiAoYmFzZURvbWFpbiAmJiBhcHBOYW1lKSB7XG4gIGNvbnN0IGFwcFVybCA9IGh0dHBzRW5hYmxlZCA/ICdodHRwczovLycgOiAnaHR0cDovLyc7XG4gIGlmIChwcklkKSB7XG4gICAgY29uc3Qgc2FuaXRpemVkUHJJZCA9IHBySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCk7XG4gICAgY29uc29sZS5sb2coYCAgICR7YXBwVXJsfXByLSR7c2FuaXRpemVkUHJJZH0tJHthcHBOYW1lfS4ke2Jhc2VEb21haW59YCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgc3ViZG9tYWluID0gZW52aXJvbm1lbnQgPT09ICdwcm9kdWN0aW9uJyA/IGFwcE5hbWUgOiBgJHtlbnZpcm9ubWVudH0tJHthcHBOYW1lfWA7XG4gICAgY29uc29sZS5sb2coYCAgICR7YXBwVXJsfSR7c3ViZG9tYWlufS4ke2Jhc2VEb21haW59YCk7XG4gIH1cbn0gZWxzZSB7XG4gIGNvbnNvbGUubG9nKGAgICBodHRwOi8ve0FMQl9ETlNfTkFNRX1gKTtcbn0iXX0=