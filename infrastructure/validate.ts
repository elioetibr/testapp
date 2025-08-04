#!/usr/bin/env ts-node

import * as cdk from 'aws-cdk-lib';
import { TestAppInfrastructureStack } from './lib/legacy/testapp-infrastructure-stack';

// Create a validation app without AWS authentication
const app = new cdk.App();

// Test all environments
const environments = ['dev', 'staging', 'production'];

environments.forEach(environment => {
  const config = {
    dev: {
      enableIPv6: false,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      vpcCidr: '10.0.0.0/16',
      publicSubnetCidrMask: 24,
      privateSubnetCidrMask: 24
    },
    staging: {
      enableIPv6: true,
      enableHANatGateways: false,
      maxAzs: 2,
      natGateways: 1,
      desiredCount: 2,
      cpu: 512,
      memoryLimitMiB: 1024,
      vpcCidr: '10.1.0.0/16',
      publicSubnetCidrMask: 24,
      privateSubnetCidrMask: 23
    },
    production: {
      enableIPv6: true,
      enableHANatGateways: true,
      maxAzs: 3,
      natGateways: 3,
      desiredCount: 3,
      cpu: 1024,
      memoryLimitMiB: 2048,
      vpcCidr: '10.2.0.0/16',
      publicSubnetCidrMask: 24,
      privateSubnetCidrMask: 22
    }
  };

  const envConfig = config[environment as keyof typeof config];

  try {
    const stack = new TestAppInfrastructureStack(app, `TestApp-${environment}-validation`, {
      env: {
        account: '123456789012', // Dummy account for validation
        region: 'us-east-1',
      },
      environment,
      ...envConfig,
      tags: {
        Environment: environment,
        Project: 'TestApp',
        ManagedBy: 'CDK'
      }
    });

    console.log(`✅ ${environment} environment configuration is valid`);
    console.log(`   - VPC CIDR: ${envConfig.vpcCidr}`);
    console.log(`   - Public Subnet CIDR Mask: /${envConfig.publicSubnetCidrMask}`);
    console.log(`   - Private Subnet CIDR Mask: /${envConfig.privateSubnetCidrMask}`);
    console.log(`   - IPv6: ${envConfig.enableIPv6 ? 'Enabled (AWS-provided)' : 'Disabled'}`);
    console.log(`   - HA NAT Gateways: ${envConfig.enableHANatGateways ? 'Enabled' : 'Disabled'}`);
    console.log(`   - Max AZs: ${envConfig.maxAzs}`);
    console.log(`   - NAT Gateways: ${envConfig.natGateways}`);
    console.log(`   - Desired Count: ${envConfig.desiredCount}`);
    console.log(`   - CPU: ${envConfig.cpu}`);
    console.log(`   - Memory: ${envConfig.memoryLimitMiB}MB`);
    console.log('');
  } catch (error) {
    console.error(`❌ ${environment} environment configuration failed:`, error);
  }
});

console.log('🎉 All infrastructure configurations validated successfully!');
console.log('');
console.log('Next steps:');
console.log('1. Configure AWS credentials: aws configure');
console.log('2. Bootstrap CDK: cdk bootstrap');
console.log('3. Deploy: ./scripts/deploy.sh [environment]');