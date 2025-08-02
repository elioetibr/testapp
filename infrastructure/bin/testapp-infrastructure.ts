#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TestAppInfrastructureStack } from '../lib/testapp-infrastructure-stack';

const app = new cdk.App();

// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';

// Environment-specific configuration
const config = {
  dev: {
    enableIPv6: false,
    enableHANatGateways: false,
    maxAzs: 2,
    natGateways: 1,
    desiredCount: 1,
    cpu: 256,
    memoryLimitMiB: 512,
    // Network configuration
    vpcCidr: '10.0.0.0/16',
    publicSubnetCidrMask: 24,  // /24 = 254 IPs per subnet
    privateSubnetCidrMask: 24,
    // IPv6 not configured for dev
    // Security enhancements (disabled by default)
    enableWAF: false,
    enableVPCFlowLogs: false,
    enableHTTPS: false,
    domainName: undefined, // Set to your domain name when enabling HTTPS
    // Container security (disabled by default)
    enableNonRootContainer: false,
    enableReadOnlyRootFilesystem: false,
  },
  production: {
    enableIPv6: true,
    enableHANatGateways: true,
    maxAzs: 3,
    natGateways: 3, // HA NAT Gateways - one per AZ
    desiredCount: 3,
    cpu: 1024,
    memoryLimitMiB: 2048,
    // Network configuration
    vpcCidr: '10.2.0.0/16',
    publicSubnetCidrMask: 24,
    privateSubnetCidrMask: 22,  // /22 = 1022 IPs per subnet for maximum scalability
    // IPv6 will use Amazon-provided block
    // To use custom IPv6: ipv6CidrBlock: '2001:0db8::/56'
    // Security enhancements (disabled by default - enable as needed)
    enableWAF: false, // Set to true to enable WAF protection
    enableVPCFlowLogs: false, // Set to true to enable VPC flow logs
    enableHTTPS: false, // Set to true to enable HTTPS/TLS
    domainName: undefined, // Set to your domain name when enabling HTTPS: 'example.com'
    // Container security (disabled by default - enable as needed)
    enableNonRootContainer: false, // Set to true for non-root container security
    enableReadOnlyRootFilesystem: false, // Set to true for read-only root filesystem
  }
};

const envConfig = config[environment as keyof typeof config] || config.dev;

new TestAppInfrastructureStack(app, `TestApp-${environment}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  environment,
  ...envConfig,
  tags: {
    Environment: environment,
    Project: 'TestApp',
    ManagedBy: 'CDK'
  }
});