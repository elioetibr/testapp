#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcStack } from '../lib/vpc-stack';
import { EcsPlatformStack } from '../lib/ecs-platform-stack';
import { ApplicationStack } from '../lib/application-stack';

const app = new cdk.App();

// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';

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
    enableHTTPS: false,
    
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
  
  staging: {
    // VPC Configuration
    enableIPv6: false,
    enableHANatGateways: true,
    maxAzs: 2,
    natGateways: 2,
    vpcCidr: '10.1.0.0/16',
    publicSubnetCidrMask: 24,
    privateSubnetCidrMask: 24,
    
    // Security Features (selectively enabled)
    enableVPCFlowLogs: true,
    enableWAF: true,
    enableHTTPS: false, // Enable when domain is configured
    
    // ECS Platform Configuration
    clusterName: `testapp-cluster-${environment}`,
    repositoryName: `testapp-${environment}`,
    
    // Application Configuration
    serviceName: `testapp-service-${environment}`,
    taskImageTag: 'latest',
    desiredCount: 2,
    cpu: 512,
    memoryLimitMiB: 1024,
    containerPort: 8000,
    
    // Auto Scaling Configuration
    minCapacity: 2,
    maxCapacity: 6,
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
    
    // Container Security (enhanced for staging)
    enableNonRootContainer: true,
    enableReadOnlyRootFilesystem: true,
    
    // Environment Variables
    environmentVariables: {
      DEBUG: 'false',
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
    enableHTTPS: true, // Requires domainName to be configured
    
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

// Optional domain configuration (can be set via context)
const domainName = app.node.tryGetContext('domainName');
const hostedZoneId = app.node.tryGetContext('hostedZoneId');

// Enable HTTPS only if domain is provided and configuration allows it
const httpsEnabled = config.enableHTTPS && domainName;

console.log(`🚀 Deploying TestApp infrastructure for environment: ${environment}`);
console.log(`📊 Configuration:`, JSON.stringify({
  environment,
  domainName: domainName || 'Not configured',
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
  enableHTTPS: httpsEnabled,
  domainName: domainName,
  hostedZoneId: hostedZoneId,
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
    applicationUrl: httpsEnabled && domainName 
      ? `https://${domainName}`
      : 'Available after deployment',
  }, null, 2),
  description: 'Deployment Summary',
});

console.log(`✅ Infrastructure configuration completed for ${environment} environment`);
console.log(`📝 Stacks to be deployed:`);
console.log(`   1. ${vpcStack.stackName} (VPC, Subnets, Security Groups)`);
console.log(`   2. ${ecsPlatformStack.stackName} (ECS Cluster, ALB, ECR${config.enableWAF ? ', WAF' : ''}${httpsEnabled ? ', SSL Certificate' : ''})`);
console.log(`   3. ${applicationStack.stackName} (Fargate Service, Auto Scaling, Task Definition)`);

if (httpsEnabled) {
  console.log(`🔒 HTTPS enabled with domain: ${domainName}`);
} else if (domainName) {
  console.log(`⚠️  Domain configured but HTTPS disabled for ${environment} environment`);
} else {
  console.log(`ℹ️  Using ALB DNS name for application access`);
}

console.log(`🎯 Application will be accessible at:`);
const appUrl = httpsEnabled && domainName 
  ? `https://${domainName}`
  : 'http://{ALB_DNS_NAME}';
console.log(`   ${appUrl}`);