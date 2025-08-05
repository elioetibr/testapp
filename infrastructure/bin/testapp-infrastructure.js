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
        enableHTTPS: true,
        // ECS Platform Configuration
        clusterName: `testapp-cluster-${environment}`,
        repositoryName: `testapp-${environment}`,
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
        enableHTTPS: true,
        // ECS Platform Configuration
        clusterName: `testapp-cluster-${environment}`,
        repositoryName: `testapp-${environment}`,
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
// Enable HTTPS only if domain config is provided and configuration allows it
const httpsEnabled = config.enableHTTPS && baseDomain && appName;
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
        enableHTTPS: httpsEnabled,
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
        enableHTTPS: httpsEnabled,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdGFwcC1pbmZyYXN0cnVjdHVyZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRlc3RhcHAtaW5mcmFzdHJ1Y3R1cmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsdUNBQXFDO0FBQ3JDLG1DQUFtQztBQUNuQyxnREFBNEM7QUFDNUMsa0VBQTZEO0FBQzdELGdFQUE0RDtBQUU1RCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQixtREFBbUQ7QUFDbkQsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLElBQUksS0FBSyxDQUFDO0FBRW5FLHVFQUF1RTtBQUN2RSxNQUFNLElBQUksR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWUsQ0FBQztBQUVoRyxzQ0FBc0M7QUFDdEMsTUFBTSxrQkFBa0IsR0FBd0I7SUFDOUMsR0FBRyxFQUFFO1FBQ0gsb0JBQW9CO1FBQ3BCLFVBQVUsRUFBRSxLQUFLO1FBQ2pCLG1CQUFtQixFQUFFLEtBQUs7UUFDMUIsTUFBTSxFQUFFLENBQUM7UUFDVCxXQUFXLEVBQUUsQ0FBQztRQUNkLE9BQU8sRUFBRSxhQUFhO1FBQ3RCLG9CQUFvQixFQUFFLEVBQUU7UUFDeEIscUJBQXFCLEVBQUUsRUFBRTtRQUV6QixnRUFBZ0U7UUFDaEUsaUJBQWlCLEVBQUUsS0FBSztRQUN4QixTQUFTLEVBQUUsS0FBSztRQUNoQixXQUFXLEVBQUUsSUFBSTtRQUVqQiw2QkFBNkI7UUFDN0IsV0FBVyxFQUFFLG1CQUFtQixXQUFXLEVBQUU7UUFDN0MsY0FBYyxFQUFFLFdBQVcsV0FBVyxFQUFFO1FBRXhDLDRCQUE0QjtRQUM1QixXQUFXLEVBQUUsbUJBQW1CLFdBQVcsRUFBRTtRQUM3QyxZQUFZ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TTtJQUNMLE9BQU8sQ0FBQyxHQUFHLENBQUMsK0NBQStDLENBQUMsQ0FBQztDQUM5RDtBQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsdUNBQXVDLENBQUMsQ0FBQztBQUNyRCxJQUFJLFVBQVUsSUFBSSxPQUFPLEVBQUU7SUFDekIsTUFBTSxNQUFNLEdBQUcsWUFBWSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztJQUNyRCxJQUFJLElBQUksRUFBRTtRQUNSLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQyxPQUFPLENBQUMsY0FBYyxFQUFFLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQ2pGLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxNQUFNLE1BQU0sYUFBYSxJQUFJLE9BQU8sSUFBSSxVQUFVLEVBQUUsQ0FBQyxDQUFDO0tBQ3pFO1NBQU07UUFDTCxNQUFNLFNBQVMsR0FBRyxXQUFXLEtBQUssWUFBWSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsV0FBVyxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQ3ZGLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxNQUFNLEdBQUcsU0FBUyxJQUFJLFVBQVUsRUFBRSxDQUFDLENBQUM7S0FDdkQ7Q0FDRjtLQUFNO0lBQ0wsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0NBQ3pDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFZwY1N0YWNrIH0gZnJvbSAnLi4vbGliL3ZwYy1zdGFjayc7XG5pbXBvcnQgeyBFY3NQbGF0Zm9ybVN0YWNrIH0gZnJvbSAnLi4vbGliL2Vjcy1wbGF0Zm9ybS1zdGFjayc7XG5pbXBvcnQgeyBBcHBsaWNhdGlvblN0YWNrIH0gZnJvbSAnLi4vbGliL2FwcGxpY2F0aW9uLXN0YWNrJztcblxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcblxuLy8gR2V0IGVudmlyb25tZW50IGZyb20gY29udGV4dCBvciBkZWZhdWx0IHRvICdkZXYnXG5jb25zdCBlbnZpcm9ubWVudCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ2Vudmlyb25tZW50JykgfHwgJ2Rldic7XG5cbi8vIEdldCBQUiBJRCBmb3IgZXBoZW1lcmFsIGRlcGxveW1lbnRzIChmcm9tIENJIGVudmlyb25tZW50IG9yIGNvbnRleHQpXG5jb25zdCBwcklkID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgncHJJZCcpIHx8IHByb2Nlc3MuZW52LlBSX0lEIHx8IHByb2Nlc3MuZW52LkdJVEhVQl9IRUFEX1JFRjtcblxuLy8gRW52aXJvbm1lbnQtc3BlY2lmaWMgY29uZmlndXJhdGlvbnNcbmNvbnN0IGVudmlyb25tZW50Q29uZmlnczogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgZGV2OiB7XG4gICAgLy8gVlBDIENvbmZpZ3VyYXRpb25cbiAgICBlbmFibGVJUHY2OiBmYWxzZSxcbiAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiBmYWxzZSxcbiAgICBtYXhBenM6IDIsXG4gICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgdnBjQ2lkcjogJzEwLjAuMC4wLzE2JyxcbiAgICBwdWJsaWNTdWJuZXRDaWRyTWFzazogMjQsXG4gICAgcHJpdmF0ZVN1Ym5ldENpZHJNYXNrOiAyNCxcbiAgICBcbiAgICAvLyBTZWN1cml0eSBGZWF0dXJlcyAoZGlzYWJsZWQgYnkgZGVmYXVsdCBmb3IgY29zdCBvcHRpbWl6YXRpb24pXG4gICAgZW5hYmxlVlBDRmxvd0xvZ3M6IGZhbHNlLFxuICAgIGVuYWJsZVdBRjogZmFsc2UsXG4gICAgZW5hYmxlSFRUUFM6IHRydWUsXG4gICAgXG4gICAgLy8gRUNTIFBsYXRmb3JtIENvbmZpZ3VyYXRpb25cbiAgICBjbHVzdGVyTmFtZTogYHRlc3RhcHAtY2x1c3Rlci0ke2Vudmlyb25tZW50fWAsXG4gICAgcmVwb3NpdG9yeU5hbWU6IGB0ZXN0YXBwLSR7ZW52aXJvbm1lbnR9YCxcbiAgICBcbiAgICAvLyBBcHBsaWNhdGlvbiBDb25maWd1cmF0aW9uXG4gICAgc2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtlbnZpcm9ubWVudH1gLFxuICAgIHRhc2tJbWFnZVRhZzogJ2xhdGVzdCcsXG4gICAgZGVzaXJlZENvdW50OiAxLFxuICAgIGNwdTogMjU2LFxuICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgY29udGFpbmVyUG9ydDogODAwMCxcbiAgICBcbiAgICAvLyBBdXRvIFNjYWxpbmcgQ29uZmlndXJhdGlvblxuICAgIG1pbkNhcGFjaXR5OiAxLFxuICAgIG1heENhcGFjaXR5OiAzLFxuICAgIGNwdVRhcmdldFV0aWxpemF0aW9uOiA3MCxcbiAgICBtZW1vcnlUYXJnZXRVdGlsaXphdGlvbjogODAsXG4gICAgc2NhbGVJbkNvb2xkb3duTWludXRlczogNSxcbiAgICBzY2FsZU91dENvb2xkb3duTWludXRlczogMixcbiAgICBcbiAgICAvLyBIZWFsdGggQ2hlY2sgQ29uZmlndXJhdGlvblxuICAgIGhlYWx0aENoZWNrUGF0aDogJy9oZWFsdGgvJyxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiAzMCxcbiAgICBoZWFsdGhDaGVja1RpbWVvdXQ6IDUsXG4gICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxuICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxuICAgIFxuICAgIC8vIENvbnRhaW5lciBTZWN1cml0eSAoZGlzYWJsZWQgYnkgZGVmYXVsdClcbiAgICBlbmFibGVOb25Sb290Q29udGFpbmVyOiBmYWxzZSxcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiBmYWxzZSxcbiAgICBcbiAgICAvLyBFbnZpcm9ubWVudCBWYXJpYWJsZXNcbiAgICBlbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgREVCVUc6ICd0cnVlJyxcbiAgICB9LFxuICB9LFxuICBcbiAgcHJvZHVjdGlvbjoge1xuICAgIC8vIFZQQyBDb25maWd1cmF0aW9uXG4gICAgZW5hYmxlSVB2NjogdHJ1ZSxcbiAgICBlbmFibGVIQU5hdEdhdGV3YXlzOiB0cnVlLFxuICAgIG1heEF6czogMyxcbiAgICBuYXRHYXRld2F5czogMyxcbiAgICB2cGNDaWRyOiAnMTAuMi4wLjAvMTYnLFxuICAgIHB1YmxpY1N1Ym5ldENpZHJNYXNrOiAyNCxcbiAgICBwcml2YXRlU3VibmV0Q2lkck1hc2s6IDI0LFxuICAgIFxuICAgIC8vIFNlY3VyaXR5IEZlYXR1cmVzIChmdWxseSBlbmFibGVkIGZvciBwcm9kdWN0aW9uKVxuICAgIGVuYWJsZVZQQ0Zsb3dMb2dzOiB0cnVlLFxuICAgIGVuYWJsZVdBRjogdHJ1ZSxcbiAgICBlbmFibGVIVFRQUzogdHJ1ZSwgLy8gUmVxdWlyZXMgZG9tYWluTmFtZSB0byBiZSBjb25maWd1cmVkXG4gICAgXG4gICAgLy8gRUNTIFBsYXRmb3JtIENvbmZpZ3VyYXRpb25cbiAgICBjbHVzdGVyTmFtZTogYHRlc3RhcHAtY2x1c3Rlci0ke2Vudmlyb25tZW50fWAsXG4gICAgcmVwb3NpdG9yeU5hbWU6IGB0ZXN0YXBwLSR7ZW52aXJvbm1lbnR9YCxcbiAgICBcbiAgICAvLyBBcHBsaWNhdGlvbiBDb25maWd1cmF0aW9uXG4gICAgc2VydmljZU5hbWU6IGB0ZXN0YXBwLXNlcnZpY2UtJHtlbnZpcm9ubWVudH1gLFxuICAgIHRhc2tJbWFnZVRhZzogJ2xhdGVzdCcsXG4gICAgZGVzaXJlZENvdW50OiAzLFxuICAgIGNwdTogMTAyNCxcbiAgICBtZW1vcnlMaW1pdE1pQjogMjA0OCxcbiAgICBjb250YWluZXJQb3J0OiA4MDAwLFxuICAgIFxuICAgIC8vIEF1dG8gU2NhbGluZyBDb25maWd1cmF0aW9uXG4gICAgbWluQ2FwYWNpdHk6IDMsXG4gICAgbWF4Q2FwYWNpdHk6IDEyLFxuICAgIGNwdVRhcmdldFV0aWxpemF0aW9uOiA2MCxcbiAgICBtZW1vcnlUYXJnZXRVdGlsaXphdGlvbjogNzAsXG4gICAgc2NhbGVJbkNvb2xkb3duTWludXRlczogMTAsXG4gICAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM6IDMsXG4gICAgXG4gICAgLy8gSGVhbHRoIENoZWNrIENvbmZpZ3VyYXRpb25cbiAgICBoZWFsdGhDaGVja1BhdGg6ICcvaGVhbHRoLycsXG4gICAgaGVhbHRoQ2hlY2tJbnRlcnZhbDogMzAsXG4gICAgaGVhbHRoQ2hlY2tUaW1lb3V0OiA1LFxuICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcbiAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICBcbiAgICAvLyBDb250YWluZXIgU2VjdXJpdHkgKGZ1bGx5IGVuYWJsZWQgZm9yIHByb2R1Y3Rpb24pXG4gICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogdHJ1ZSxcbiAgICBlbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtOiB0cnVlLFxuICAgIFxuICAgIC8vIEVudmlyb25tZW50IFZhcmlhYmxlc1xuICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICBERUJVRzogJ2ZhbHNlJyxcbiAgICB9LFxuICB9LFxufTtcblxuLy8gR2V0IGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBjdXJyZW50IGVudmlyb25tZW50XG5jb25zdCBjb25maWcgPSBlbnZpcm9ubWVudENvbmZpZ3NbZW52aXJvbm1lbnRdO1xuaWYgKCFjb25maWcpIHtcbiAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGVudmlyb25tZW50OiAke2Vudmlyb25tZW50fS4gU3VwcG9ydGVkIGVudmlyb25tZW50czogJHtPYmplY3Qua2V5cyhlbnZpcm9ubWVudENvbmZpZ3MpLmpvaW4oJywgJyl9YCk7XG59XG5cbi8vIERvbWFpbiBjb25maWd1cmF0aW9uXG5jb25zdCBiYXNlRG9tYWluID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnYmFzZURvbWFpbicpO1xuY29uc3QgaG9zdGVkWm9uZUlkID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnaG9zdGVkWm9uZUlkJyk7XG5jb25zdCBhcHBOYW1lID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnYXBwTmFtZScpO1xuXG4vLyBFbmFibGUgSFRUUFMgb25seSBpZiBkb21haW4gY29uZmlnIGlzIHByb3ZpZGVkIGFuZCBjb25maWd1cmF0aW9uIGFsbG93cyBpdFxuY29uc3QgaHR0cHNFbmFibGVkID0gY29uZmlnLmVuYWJsZUhUVFBTICYmIGJhc2VEb21haW4gJiYgYXBwTmFtZTtcblxuY29uc29sZS5sb2coYPCfmoAgRGVwbG95aW5nIFRlc3RBcHAgaW5mcmFzdHJ1Y3R1cmUgZm9yIGVudmlyb25tZW50OiAke2Vudmlyb25tZW50fWApO1xuaWYgKHBySWQpIHtcbiAgY29uc29sZS5sb2coYPCflIAgUFIgRGVwbG95bWVudCBkZXRlY3RlZDogJHtwcklkfWApO1xufVxuY29uc29sZS5sb2coYPCfk4ogQ29uZmlndXJhdGlvbjpgLCBKU09OLnN0cmluZ2lmeSh7XG4gIGVudmlyb25tZW50LFxuICBwcklkOiBwcklkIHx8ICdOb3QgYSBQUiBkZXBsb3ltZW50JyxcbiAgYXBwTmFtZTogYXBwTmFtZSB8fCAnTm90IGNvbmZpZ3VyZWQnLFxuICBiYXNlRG9tYWluOiBiYXNlRG9tYWluIHx8ICdOb3QgY29uZmlndXJlZCcsIFxuICBodHRwc0VuYWJsZWQsXG4gIHNlY3VyaXR5RmVhdHVyZXM6IHtcbiAgICBlbmFibGVWUENGbG93TG9nczogY29uZmlnLmVuYWJsZVZQQ0Zsb3dMb2dzLFxuICAgIGVuYWJsZVdBRjogY29uZmlnLmVuYWJsZVdBRixcbiAgICBlbmFibGVIVFRQUzogaHR0cHNFbmFibGVkLFxuICAgIGVuYWJsZU5vblJvb3RDb250YWluZXI6IGNvbmZpZy5lbmFibGVOb25Sb290Q29udGFpbmVyLFxuICAgIGVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW06IGNvbmZpZy5lbmFibGVSZWFkT25seVJvb3RGaWxlc3lzdGVtLFxuICB9XG59LCBudWxsLCAyKSk7XG5cbi8vIENvbW1vbiBzdGFjayBwcm9wc1xuY29uc3QgY29tbW9uUHJvcHMgPSB7XG4gIGVudjoge1xuICAgIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXG4gICAgcmVnaW9uOiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9SRUdJT04gfHwgJ3VzLWVhc3QtMScsXG4gIH0sXG59O1xuXG5pZiAocHJJZCkge1xuICAvLyBGb3IgUFIgZGVwbG95bWVudHM6IE9ubHkgY3JlYXRlIGFwcGxpY2F0aW9uIHN0YWNrLCByZXVzZSBleGlzdGluZyBWUEMgYW5kIEVDUyBQbGF0Zm9ybVxuICBjb25zb2xlLmxvZyhg8J+UgCBDcmVhdGluZyBlcGhlbWVyYWwgUFIgZGVwbG95bWVudDogcmV1c2luZyAke2Vudmlyb25tZW50fSBWUEMgYW5kIEVDUyBjbHVzdGVyYCk7XG4gIFxuICAvLyBJbXBvcnQgZXhpc3RpbmcgVlBDIGFuZCBQbGF0Zm9ybSByZXNvdXJjZXNcbiAgY29uc3QgZXhpc3RpbmdWcGNJZCA9IGBUZXN0QXBwLVZQQy0ke2Vudmlyb25tZW50fWA7XG4gIGNvbnN0IGV4aXN0aW5nUGxhdGZvcm1JZCA9IGBUZXN0QXBwLVBsYXRmb3JtLSR7ZW52aXJvbm1lbnR9YDtcbiAgXG4gIC8vIEdlbmVyYXRlIHVuaXF1ZSBzdGFjayBuYW1lIGZvciBQUiBhcHBsaWNhdGlvblxuICBjb25zdCBwclN0YWNrTmFtZSA9IGBUZXN0QXBwLUFwcC0ke2Vudmlyb25tZW50fS1wci0ke3BySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCl9YDtcbiAgXG4gIC8vIENyZWF0ZSBvbmx5IEFwcGxpY2F0aW9uIFN0YWNrIGZvciBQUiAocmV1c2luZyBleGlzdGluZyBpbmZyYXN0cnVjdHVyZSlcbiAgY29uc3QgYXBwbGljYXRpb25TdGFjayA9IG5ldyBBcHBsaWNhdGlvblN0YWNrKGFwcCwgcHJTdGFja05hbWUsIHtcbiAgICAuLi5jb21tb25Qcm9wcyxcbiAgICBzdGFja05hbWU6IHByU3RhY2tOYW1lLFxuICAgIGVudmlyb25tZW50LFxuICAgIC8vIEltcG9ydCBleGlzdGluZyBWUEMgcmVzb3VyY2VzIGJ5IHJlZmVyZW5jaW5nIHRoZSBleGlzdGluZyBzdGFja1xuICAgIHZwY0lkOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdWcGNJZH0tVnBjSWRgKSxcbiAgICBwcml2YXRlU3VibmV0SWRzOiBbXG4gICAgICBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdWcGNJZH0tUHJpdmF0ZVN1Ym5ldDFJZGApLFxuICAgICAgY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nVnBjSWR9LVByaXZhdGVTdWJuZXQySWRgKSxcbiAgICBdLFxuICAgIGFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cElkOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdWcGNJZH0tQXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWRgKSxcbiAgICAvLyBJbXBvcnQgZXhpc3RpbmcgRUNTIFBsYXRmb3JtIHJlc291cmNlc1xuICAgIGNsdXN0ZXJBcm46IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUNsdXN0ZXJBcm5gKSxcbiAgICBjbHVzdGVyTmFtZTogY2RrLkZuLmltcG9ydFZhbHVlKGAke2V4aXN0aW5nUGxhdGZvcm1JZH0tQ2x1c3Rlck5hbWVgKSxcbiAgICByZXBvc2l0b3J5VXJpOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1SZXBvc2l0b3J5VXJpYCksXG4gICAgbG9hZEJhbGFuY2VyQXJuOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1Mb2FkQmFsYW5jZXJBcm5gKSxcbiAgICBodHRwTGlzdGVuZXJBcm46IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUh0dHBMaXN0ZW5lckFybmApLFxuICAgIGh0dHBzTGlzdGVuZXJBcm46IGh0dHBzRW5hYmxlZCA/IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUh0dHBzTGlzdGVuZXJBcm5gKSA6IHVuZGVmaW5lZCxcbiAgICBsb2dHcm91cE5hbWU6IGNkay5Gbi5pbXBvcnRWYWx1ZShgJHtleGlzdGluZ1BsYXRmb3JtSWR9LUxvZ0dyb3VwTmFtZWApLFxuICAgIGxvZ0dyb3VwQXJuOiBjZGsuRm4uaW1wb3J0VmFsdWUoYCR7ZXhpc3RpbmdQbGF0Zm9ybUlkfS1Mb2dHcm91cEFybmApLFxuICAgIC8vIEFwcGxpY2F0aW9uIGNvbmZpZ3VyYXRpb24gLSB1bmlxdWUgc2VydmljZSBuYW1lIGZvciBQUlxuICAgIHNlcnZpY2VOYW1lOiBgdGVzdGFwcC1zZXJ2aWNlLSR7ZW52aXJvbm1lbnR9LXByLSR7cHJJZC50b1N0cmluZygpLnJlcGxhY2UoL1teYS16MC05LV0vZ2ksICctJykudG9Mb3dlckNhc2UoKX1gLFxuICAgIHRhc2tJbWFnZVRhZzogY29uZmlnLnRhc2tJbWFnZVRhZyxcbiAgICBkZXNpcmVkQ291bnQ6IDEsIC8vIFVzZSBtaW5pbWFsIHJlc291cmNlcyBmb3IgUFJcbiAgICBjcHU6IGNvbmZpZy5jcHUsXG4gICAgbWVtb3J5TGltaXRNaUI6IGNvbmZpZy5tZW1vcnlMaW1pdE1pQixcbiAgICBjb250YWluZXJQb3J0OiBjb25maWcuY29udGFpbmVyUG9ydCxcbiAgICAvLyBNaW5pbWFsIGF1dG8gc2NhbGluZyBmb3IgUFJcbiAgICBtaW5DYXBhY2l0eTogMSxcbiAgICBtYXhDYXBhY2l0eTogMixcbiAgICBjcHVUYXJnZXRVdGlsaXphdGlvbjogY29uZmlnLmNwdVRhcmdldFV0aWxpemF0aW9uLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiBjb25maWcubWVtb3J5VGFyZ2V0VXRpbGl6YXRpb24sXG4gICAgc2NhbGVJbkNvb2xkb3duTWludXRlczogY29uZmlnLnNjYWxlSW5Db29sZG93bk1pbnV0ZXMsXG4gICAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM6IGNvbmZpZy5zY2FsZU91dENvb2xkb3duTWludXRlcyxcbiAgICAvLyBIZWFsdGggY2hlY2sgY29uZmlndXJhdGlvblxuICAgIGhlYWx0aENoZWNrUGF0aDogY29uZmlnLmhlYWx0aENoZWNrUGF0aCxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiBjb25maWcuaGVhbHRoQ2hlY2tJbnRlcnZhbCxcbiAgICBoZWFsdGhDaGVja1RpbWVvdXQ6IGNvbmZpZy5oZWFsdGhDaGVja1RpbWVvdXQsXG4gICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiBjb25maWcuaGVhbHRoeVRocmVzaG9sZENvdW50LFxuICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiBjb25maWcudW5oZWFsdGh5VGhyZXNob2xkQ291bnQsXG4gICAgLy8gQ29udGFpbmVyIHNlY3VyaXR5XG4gICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogY29uZmlnLmVuYWJsZU5vblJvb3RDb250YWluZXIsXG4gICAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbTogY29uZmlnLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0sXG4gICAgLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG4gICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IGNvbmZpZy5lbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAvLyBEb21haW4gY29uZmlndXJhdGlvblxuICAgIGJhc2VEb21haW46IGJhc2VEb21haW4sXG4gICAgYXBwTmFtZTogYXBwTmFtZSxcbiAgICBwcklkOiBwcklkLFxuICAgIGhvc3RlZFpvbmVJZDogaG9zdGVkWm9uZUlkLFxuICB9KTtcblxuICAvLyBBZGQgc3RhY2sgdGFncyBmb3IgUFIgZGVwbG95bWVudFxuICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoJ0Vudmlyb25tZW50JywgZW52aXJvbm1lbnQpO1xuICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoJ1Byb2plY3QnLCAnVGVzdEFwcCcpO1xuICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiAgY2RrLlRhZ3Mub2YoYXBwbGljYXRpb25TdGFjaykuYWRkKCdEZXBsb3ltZW50VHlwZScsICdQUi1FcGhlbWVyYWwnKTtcbiAgY2RrLlRhZ3Mub2YoYXBwbGljYXRpb25TdGFjaykuYWRkKCdQUklkJywgcHJJZC50b1N0cmluZygpKTtcbiAgY2RrLlRhZ3Mub2YoYXBwbGljYXRpb25TdGFjaykuYWRkKCdEZXBsb3llZEF0JywgbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtcblxuICAvLyBHZW5lcmF0ZSBQUiBkb21haW4gbmFtZVxuICBjb25zdCBwckRvbWFpbk5hbWUgPSBiYXNlRG9tYWluICYmIGFwcE5hbWUgXG4gICAgPyBgcHItJHtwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpfS0ke2FwcE5hbWV9LiR7YmFzZURvbWFpbn1gXG4gICAgOiB1bmRlZmluZWQ7XG5cbiAgLy8gT3V0cHV0IGZvciBQUiBkZXBsb3ltZW50XG4gIG5ldyBjZGsuQ2ZuT3V0cHV0KGFwcGxpY2F0aW9uU3RhY2ssICdQUkRlcGxveW1lbnRTdW1tYXJ5Jywge1xuICAgIHZhbHVlOiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBwcklkLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICBzZXJ2aWNlTmFtZTogYHRlc3RhcHAtc2VydmljZS0ke2Vudmlyb25tZW50fS1wci0ke3BySWQudG9TdHJpbmcoKS5yZXBsYWNlKC9bXmEtejAtOS1dL2dpLCAnLScpLnRvTG93ZXJDYXNlKCl9YCxcbiAgICAgIGRvbWFpbk5hbWU6IHByRG9tYWluTmFtZSxcbiAgICAgIGFwcGxpY2F0aW9uVXJsOiBwckRvbWFpbk5hbWUgPyAoaHR0cHNFbmFibGVkID8gYGh0dHBzOi8vJHtwckRvbWFpbk5hbWV9YCA6IGBodHRwOi8vJHtwckRvbWFpbk5hbWV9YCkgOiAnQXZhaWxhYmxlIGFmdGVyIGRlcGxveW1lbnQnLFxuICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfSwgbnVsbCwgMiksXG4gICAgZGVzY3JpcHRpb246ICdQUiBEZXBsb3ltZW50IFN1bW1hcnknLFxuICB9KTtcblxuICBjb25zb2xlLmxvZyhg4pyFIFBSIGRlcGxveW1lbnQgY29uZmlndXJhdGlvbiBjb21wbGV0ZWRgKTtcbiAgY29uc29sZS5sb2coYPCfk50gUFIgU3RhY2sgdG8gYmUgZGVwbG95ZWQ6ICR7cHJTdGFja05hbWV9YCk7XG4gIGNvbnNvbGUubG9nKGDwn5SXIFNlcnZpY2UgbmFtZTogdGVzdGFwcC1zZXJ2aWNlLSR7ZW52aXJvbm1lbnR9LXByLSR7cHJJZC50b1N0cmluZygpLnJlcGxhY2UoL1teYS16MC05LV0vZ2ksICctJykudG9Mb3dlckNhc2UoKX1gKTtcbiAgaWYgKHByRG9tYWluTmFtZSkge1xuICAgIGNvbnNvbGUubG9nKGDwn4yQIERvbWFpbjogJHtwckRvbWFpbk5hbWV9YCk7XG4gIH1cbiAgXG59IGVsc2Uge1xuICAvLyBSZWd1bGFyIGRlcGxveW1lbnQ6IENyZWF0ZSBmdWxsIGluZnJhc3RydWN0dXJlXG4gIGNvbnNvbGUubG9nKGDwn4+X77iPIENyZWF0aW5nIGZ1bGwgaW5mcmFzdHJ1Y3R1cmUgZGVwbG95bWVudCBmb3IgJHtlbnZpcm9ubWVudH1gKTtcblxuICAvLyAxLiBDcmVhdGUgVlBDIFN0YWNrIChGb3VuZGF0aW9uIExheWVyKVxuICBjb25zdCB2cGNTdGFjayA9IG5ldyBWcGNTdGFjayhhcHAsIGBUZXN0QXBwLVZQQy0ke2Vudmlyb25tZW50fWAsIHtcbiAgICAuLi5jb21tb25Qcm9wcyxcbiAgICBzdGFja05hbWU6IGBUZXN0QXBwLVZQQy0ke2Vudmlyb25tZW50fWAsXG4gICAgZW52aXJvbm1lbnQsXG4gICAgZW5hYmxlSVB2NjogY29uZmlnLmVuYWJsZUlQdjYsXG4gICAgZW5hYmxlSEFOYXRHYXRld2F5czogY29uZmlnLmVuYWJsZUhBTmF0R2F0ZXdheXMsXG4gICAgbWF4QXpzOiBjb25maWcubWF4QXpzLFxuICAgIG5hdEdhdGV3YXlzOiBjb25maWcubmF0R2F0ZXdheXMsXG4gICAgdnBjQ2lkcjogY29uZmlnLnZwY0NpZHIsXG4gICAgcHVibGljU3VibmV0Q2lkck1hc2s6IGNvbmZpZy5wdWJsaWNTdWJuZXRDaWRyTWFzayxcbiAgICBwcml2YXRlU3VibmV0Q2lkck1hc2s6IGNvbmZpZy5wcml2YXRlU3VibmV0Q2lkck1hc2ssXG4gICAgZW5hYmxlVlBDRmxvd0xvZ3M6IGNvbmZpZy5lbmFibGVWUENGbG93TG9ncyxcbiAgfSk7XG5cbiAgLy8gMi4gQ3JlYXRlIEVDUyBQbGF0Zm9ybSBTdGFjayAoUGxhdGZvcm0gTGF5ZXIpXG4gIGNvbnN0IGVjc1BsYXRmb3JtU3RhY2sgPSBuZXcgRWNzUGxhdGZvcm1TdGFjayhhcHAsIGBUZXN0QXBwLVBsYXRmb3JtLSR7ZW52aXJvbm1lbnR9YCwge1xuICAgIC4uLmNvbW1vblByb3BzLFxuICAgIHN0YWNrTmFtZTogYFRlc3RBcHAtUGxhdGZvcm0tJHtlbnZpcm9ubWVudH1gLFxuICAgIGVudmlyb25tZW50LFxuICAgIC8vIFZQQyBjb25maWd1cmF0aW9uIGZyb20gVlBDIHN0YWNrXG4gICAgdnBjSWQ6IHZwY1N0YWNrLnZwYy52cGNJZCxcbiAgICBwdWJsaWNTdWJuZXRJZHM6IHZwY1N0YWNrLnB1YmxpY1N1Ym5ldHMubWFwKHN1Ym5ldCA9PiBzdWJuZXQuc3VibmV0SWQpLFxuICAgIGxvYWRCYWxhbmNlclNlY3VyaXR5R3JvdXBJZDogdnBjU3RhY2subG9hZEJhbGFuY2VyU2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWQsXG4gICAgLy8gUGxhdGZvcm0gY29uZmlndXJhdGlvblxuICAgIGNsdXN0ZXJOYW1lOiBjb25maWcuY2x1c3Rlck5hbWUsXG4gICAgcmVwb3NpdG9yeU5hbWU6IGNvbmZpZy5yZXBvc2l0b3J5TmFtZSxcbiAgICAvLyBTZWN1cml0eSBlbmhhbmNlbWVudHNcbiAgICBlbmFibGVXQUY6IGNvbmZpZy5lbmFibGVXQUYsXG4gICAgZW5hYmxlSFRUUFM6IGh0dHBzRW5hYmxlZCxcbiAgICBob3N0ZWRab25lSWQ6IGhvc3RlZFpvbmVJZCxcbiAgICBiYXNlRG9tYWluOiBiYXNlRG9tYWluLFxuICAgIGFwcE5hbWU6IGFwcE5hbWUsXG4gIH0pO1xuXG4gIC8vIDMuIENyZWF0ZSBBcHBsaWNhdGlvbiBEZXBsb3ltZW50IFN0YWNrIChTZXJ2aWNlIExheWVyKVxuICBjb25zdCBhcHBsaWNhdGlvblN0YWNrID0gbmV3IEFwcGxpY2F0aW9uU3RhY2soYXBwLCBgVGVzdEFwcC1BcHAtJHtlbnZpcm9ubWVudH1gLCB7XG4gICAgLi4uY29tbW9uUHJvcHMsXG4gICAgc3RhY2tOYW1lOiBgVGVzdEFwcC1BcHAtJHtlbnZpcm9ubWVudH1gLFxuICAgIGVudmlyb25tZW50LFxuICAgIC8vIFZQQyBjb25maWd1cmF0aW9uIGZyb20gVlBDIHN0YWNrXG4gICAgdnBjSWQ6IHZwY1N0YWNrLnZwYy52cGNJZCxcbiAgICBwcml2YXRlU3VibmV0SWRzOiB2cGNTdGFjay5wcml2YXRlU3VibmV0cy5tYXAoc3VibmV0ID0+IHN1Ym5ldC5zdWJuZXRJZCksXG4gICAgYXBwbGljYXRpb25TZWN1cml0eUdyb3VwSWQ6IHZwY1N0YWNrLmFwcGxpY2F0aW9uU2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWQsXG4gICAgLy8gRUNTIFBsYXRmb3JtIGNvbmZpZ3VyYXRpb24gZnJvbSBQbGF0Zm9ybSBzdGFja1xuICAgIGNsdXN0ZXJBcm46IGVjc1BsYXRmb3JtU3RhY2suY2x1c3Rlci5jbHVzdGVyQXJuLFxuICAgIGNsdXN0ZXJOYW1lOiBlY3NQbGF0Zm9ybVN0YWNrLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgcmVwb3NpdG9yeVVyaTogZWNzUGxhdGZvcm1TdGFjay5yZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgbG9hZEJhbGFuY2VyQXJuOiBlY3NQbGF0Zm9ybVN0YWNrLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJBcm4sXG4gICAgaHR0cExpc3RlbmVyQXJuOiBlY3NQbGF0Zm9ybVN0YWNrLmh0dHBMaXN0ZW5lci5saXN0ZW5lckFybixcbiAgICBodHRwc0xpc3RlbmVyQXJuOiBlY3NQbGF0Zm9ybVN0YWNrLmh0dHBzTGlzdGVuZXI/Lmxpc3RlbmVyQXJuLFxuICAgIGxvZ0dyb3VwTmFtZTogZWNzUGxhdGZvcm1TdGFjay5sb2dHcm91cC5sb2dHcm91cE5hbWUsXG4gICAgbG9nR3JvdXBBcm46IGVjc1BsYXRmb3JtU3RhY2subG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgLy8gQXBwbGljYXRpb24gY29uZmlndXJhdGlvblxuICAgIHNlcnZpY2VOYW1lOiBjb25maWcuc2VydmljZU5hbWUsXG4gICAgdGFza0ltYWdlVGFnOiBjb25maWcudGFza0ltYWdlVGFnLFxuICAgIGRlc2lyZWRDb3VudDogY29uZmlnLmRlc2lyZWRDb3VudCxcbiAgICBjcHU6IGNvbmZpZy5jcHUsXG4gICAgbWVtb3J5TGltaXRNaUI6IGNvbmZpZy5tZW1vcnlMaW1pdE1pQixcbiAgICBjb250YWluZXJQb3J0OiBjb25maWcuY29udGFpbmVyUG9ydCxcbiAgICAvLyBBdXRvIHNjYWxpbmcgY29uZmlndXJhdGlvblxuICAgIG1pbkNhcGFjaXR5OiBjb25maWcubWluQ2FwYWNpdHksXG4gICAgbWF4Q2FwYWNpdHk6IGNvbmZpZy5tYXhDYXBhY2l0eSxcbiAgICBjcHVUYXJnZXRVdGlsaXphdGlvbjogY29uZmlnLmNwdVRhcmdldFV0aWxpemF0aW9uLFxuICAgIG1lbW9yeVRhcmdldFV0aWxpemF0aW9uOiBjb25maWcubWVtb3J5VGFyZ2V0VXRpbGl6YXRpb24sXG4gICAgc2NhbGVJbkNvb2xkb3duTWludXRlczogY29uZmlnLnNjYWxlSW5Db29sZG93bk1pbnV0ZXMsXG4gICAgc2NhbGVPdXRDb29sZG93bk1pbnV0ZXM6IGNvbmZpZy5zY2FsZU91dENvb2xkb3duTWludXRlcyxcbiAgICAvLyBIZWFsdGggY2hlY2sgY29uZmlndXJhdGlvblxuICAgIGhlYWx0aENoZWNrUGF0aDogY29uZmlnLmhlYWx0aENoZWNrUGF0aCxcbiAgICBoZWFsdGhDaGVja0ludGVydmFsOiBjb25maWcuaGVhbHRoQ2hlY2tJbnRlcnZhbCxcbiAgICBoZWFsdGhDaGVja1RpbWVvdXQ6IGNvbmZpZy5oZWFsdGhDaGVja1RpbWVvdXQsXG4gICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiBjb25maWcuaGVhbHRoeVRocmVzaG9sZENvdW50LFxuICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiBjb25maWcudW5oZWFsdGh5VGhyZXNob2xkQ291bnQsXG4gICAgLy8gQ29udGFpbmVyIHNlY3VyaXR5XG4gICAgZW5hYmxlTm9uUm9vdENvbnRhaW5lcjogY29uZmlnLmVuYWJsZU5vblJvb3RDb250YWluZXIsXG4gICAgZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbTogY29uZmlnLmVuYWJsZVJlYWRPbmx5Um9vdEZpbGVzeXN0ZW0sXG4gICAgLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG4gICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IGNvbmZpZy5lbnZpcm9ubWVudFZhcmlhYmxlcyxcbiAgICAvLyBEb21haW4gY29uZmlndXJhdGlvblxuICAgIGJhc2VEb21haW46IGJhc2VEb21haW4sXG4gICAgYXBwTmFtZTogYXBwTmFtZSxcbiAgICBob3N0ZWRab25lSWQ6IGhvc3RlZFpvbmVJZCxcbiAgfSk7XG5cbiAgLy8gQWRkIGV4cGxpY2l0IGRlcGVuZGVuY2llcyB0byBlbnN1cmUgY29ycmVjdCBkZXBsb3ltZW50IG9yZGVyXG4gIGVjc1BsYXRmb3JtU3RhY2suYWRkRGVwZW5kZW5jeSh2cGNTdGFjayk7XG4gIGFwcGxpY2F0aW9uU3RhY2suYWRkRGVwZW5kZW5jeShlY3NQbGF0Zm9ybVN0YWNrKTtcblxuICAvLyBBZGQgc3RhY2sgdGFncyBmb3IgYmV0dGVyIHJlc291cmNlIG1hbmFnZW1lbnRcbiAgY29uc3Qgc3RhY2tUYWdzID0ge1xuICAgIEVudmlyb25tZW50OiBlbnZpcm9ubWVudCxcbiAgICBQcm9qZWN0OiAnVGVzdEFwcCcsXG4gICAgTWFuYWdlZEJ5OiAnQ0RLJyxcbiAgICBEZXBsb3llZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG5cbiAgT2JqZWN0LmVudHJpZXMoc3RhY2tUYWdzKS5mb3JFYWNoKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICBjZGsuVGFncy5vZih2cGNTdGFjaykuYWRkKGtleSwgdmFsdWUpO1xuICAgIGNkay5UYWdzLm9mKGVjc1BsYXRmb3JtU3RhY2spLmFkZChrZXksIHZhbHVlKTtcbiAgICBjZGsuVGFncy5vZihhcHBsaWNhdGlvblN0YWNrKS5hZGQoa2V5LCB2YWx1ZSk7XG4gIH0pO1xuXG4gIC8vIENyZWF0ZSBjb21wcmVoZW5zaXZlIHN0YWNrIG91dHB1dHMgZm9yIENJL0NEIGludGVncmF0aW9uXG4gIG5ldyBjZGsuQ2ZuT3V0cHV0KGFwcGxpY2F0aW9uU3RhY2ssICdEZXBsb3ltZW50U3VtbWFyeScsIHtcbiAgICB2YWx1ZTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIHN0YWNrczoge1xuICAgICAgICB2cGM6IHZwY1N0YWNrLnN0YWNrTmFtZSxcbiAgICAgICAgcGxhdGZvcm06IGVjc1BsYXRmb3JtU3RhY2suc3RhY2tOYW1lLFxuICAgICAgICBhcHBsaWNhdGlvbjogYXBwbGljYXRpb25TdGFjay5zdGFja05hbWUsXG4gICAgICB9LFxuICAgICAgc2VjdXJpdHlGZWF0dXJlczoge1xuICAgICAgICB2cGNGbG93TG9nczogY29uZmlnLmVuYWJsZVZQQ0Zsb3dMb2dzLFxuICAgICAgICB3YWY6IGNvbmZpZy5lbmFibGVXQUYsXG4gICAgICAgIGh0dHBzOiBodHRwc0VuYWJsZWQsXG4gICAgICAgIGNvbnRhaW5lclNlY3VyaXR5OiBjb25maWcuZW5hYmxlTm9uUm9vdENvbnRhaW5lciB8fCBjb25maWcuZW5hYmxlUmVhZE9ubHlSb290RmlsZXN5c3RlbSxcbiAgICAgIH0sXG4gICAgICBhcHBsaWNhdGlvblVybDogaHR0cHNFbmFibGVkICYmIGJhc2VEb21haW4gJiYgYXBwTmFtZSBcbiAgICAgICAgPyBgaHR0cHM6Ly8ke2Vudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBhcHBOYW1lIDogYCR7ZW52aXJvbm1lbnR9LSR7YXBwTmFtZX1gfS4ke2Jhc2VEb21haW59YFxuICAgICAgICA6ICdBdmFpbGFibGUgYWZ0ZXIgZGVwbG95bWVudCcsXG4gICAgfSwgbnVsbCwgMiksXG4gICAgZGVzY3JpcHRpb246ICdEZXBsb3ltZW50IFN1bW1hcnknLFxuICB9KTtcblxuICBjb25zb2xlLmxvZyhg4pyFIEluZnJhc3RydWN0dXJlIGNvbmZpZ3VyYXRpb24gY29tcGxldGVkIGZvciAke2Vudmlyb25tZW50fSBlbnZpcm9ubWVudGApO1xuICBjb25zb2xlLmxvZyhg8J+TnSBTdGFja3MgdG8gYmUgZGVwbG95ZWQ6YCk7XG4gIGNvbnNvbGUubG9nKGAgICAxLiAke3ZwY1N0YWNrLnN0YWNrTmFtZX0gKFZQQywgU3VibmV0cywgU2VjdXJpdHkgR3JvdXBzKWApO1xuICBjb25zb2xlLmxvZyhgICAgMi4gJHtlY3NQbGF0Zm9ybVN0YWNrLnN0YWNrTmFtZX0gKEVDUyBDbHVzdGVyLCBBTEIsIEVDUiR7Y29uZmlnLmVuYWJsZVdBRiA/ICcsIFdBRicgOiAnJ30ke2h0dHBzRW5hYmxlZCA/ICcsIFNTTCBDZXJ0aWZpY2F0ZScgOiAnJ30pYCk7XG4gIGNvbnNvbGUubG9nKGAgICAzLiAke2FwcGxpY2F0aW9uU3RhY2suc3RhY2tOYW1lfSAoRmFyZ2F0ZSBTZXJ2aWNlLCBBdXRvIFNjYWxpbmcsIFRhc2sgRGVmaW5pdGlvbilgKTtcbn1cblxuLy8gRmluYWwgYXBwbGljYXRpb24gVVJMIGluZm9ybWF0aW9uXG5pZiAoaHR0cHNFbmFibGVkKSB7XG4gIGNvbnNvbGUubG9nKGDwn5SSIEhUVFBTIGVuYWJsZWQgZm9yICR7YXBwTmFtZX0uJHtiYXNlRG9tYWlufSBhbmQgc3ViZG9tYWluc2ApO1xufSBlbHNlIGlmIChiYXNlRG9tYWluICYmIGFwcE5hbWUpIHtcbiAgY29uc29sZS5sb2coYOKaoO+4jyAgRG9tYWluIGNvbmZpZ3VyZWQgYnV0IEhUVFBTIGRpc2FibGVkIGZvciAke2Vudmlyb25tZW50fSBlbnZpcm9ubWVudGApO1xufSBlbHNlIHtcbiAgY29uc29sZS5sb2coYOKEue+4jyAgVXNpbmcgQUxCIEROUyBuYW1lIGZvciBhcHBsaWNhdGlvbiBhY2Nlc3NgKTtcbn1cblxuY29uc29sZS5sb2coYPCfjq8gQXBwbGljYXRpb24gd2lsbCBiZSBhY2Nlc3NpYmxlIGF0OmApO1xuaWYgKGJhc2VEb21haW4gJiYgYXBwTmFtZSkge1xuICBjb25zdCBhcHBVcmwgPSBodHRwc0VuYWJsZWQgPyAnaHR0cHM6Ly8nIDogJ2h0dHA6Ly8nO1xuICBpZiAocHJJZCkge1xuICAgIGNvbnN0IHNhbml0aXplZFBySWQgPSBwcklkLnRvU3RyaW5nKCkucmVwbGFjZSgvW15hLXowLTktXS9naSwgJy0nKS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnNvbGUubG9nKGAgICAke2FwcFVybH1wci0ke3Nhbml0aXplZFBySWR9LSR7YXBwTmFtZX0uJHtiYXNlRG9tYWlufWApO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHN1YmRvbWFpbiA9IGVudmlyb25tZW50ID09PSAncHJvZHVjdGlvbicgPyBhcHBOYW1lIDogYCR7ZW52aXJvbm1lbnR9LSR7YXBwTmFtZX1gO1xuICAgIGNvbnNvbGUubG9nKGAgICAke2FwcFVybH0ke3N1YmRvbWFpbn0uJHtiYXNlRG9tYWlufWApO1xuICB9XG59IGVsc2Uge1xuICBjb25zb2xlLmxvZyhgICAgaHR0cDovL3tBTEJfRE5TX05BTUV9YCk7XG59Il19