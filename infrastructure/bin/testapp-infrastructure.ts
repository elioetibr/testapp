#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EcsPlatformStack } from '../lib/ecs-platform-stack';
import { ApplicationStack } from '../lib/application-stack';

const app = new cdk.App();

// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';

// Get PR ID for ephemeral deployments (from CI environment or context)
const prId = app.node.tryGetContext('prId') || process.env.PR_ID || process.env.GITHUB_HEAD_REF;

// Environment-specific configurations
const environmentConfigs: Record<string, any> = {
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
  const applicationStack = new ApplicationStack(app, prStackName, {
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
    desiredCount: 1, // Use minimal resources for PR
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
  
} else {
  // Regular deployment: Create full infrastructure
  console.log(`🏗️ Creating full infrastructure deployment for ${environment}`);

  // 1. Create VPC Stack (Foundation Layer)
  const vpcStack = new VpcStack(app, `TestApp-VPC-${environment}`, {
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
  const ecsPlatformStack = new EcsPlatformStack(app, `TestApp-Platform-${environment}`, {
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
  const applicationStack = new ApplicationStack(app, `TestApp-App-${environment}`, {
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
} else if (baseDomain && appName) {
  console.log(`⚠️  Domain configured but HTTPS disabled for ${environment} environment`);
} else {
  console.log(`ℹ️  Using ALB DNS name for application access`);
}

console.log(`🎯 Application will be accessible at:`);
if (baseDomain && appName) {
  const appUrl = httpsEnabled ? 'https://' : 'http://';
  if (prId) {
    const sanitizedPrId = prId.toString().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    console.log(`   ${appUrl}pr-${sanitizedPrId}-${appName}.${baseDomain}`);
  } else {
    const subdomain = environment === 'production' ? appName : `${environment}-${appName}`;
    console.log(`   ${appUrl}${subdomain}.${baseDomain}`);
  }
} else {
  console.log(`   http://{ALB_DNS_NAME}`);
}