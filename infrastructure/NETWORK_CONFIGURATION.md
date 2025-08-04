# Network Configuration Guide

## Overview

This guide explains how to define and customize IPv4 and IPv6 CIDR blocks and subnet configurations for the TestApp infrastructure. The network configuration is managed through the **VPC Stack** in our modular architecture, with comprehensive test coverage ensuring reliable deployments.

> **✅ Test Status**: 26/26 VPC Stack tests passing with 100% success rate

## CIDR Block Configuration Locations

### 1. Environment Configuration (`bin/testapp-infrastructure.ts`)

This is the **primary location** where you define CIDR blocks for each environment:

```typescript
const config = {
  dev: {
    // IPv4 Configuration
    vpcCidr: '10.0.0.0/16',              // VPC CIDR block
    publicSubnetCidrMask: 24,            // /24 = 254 IPs per subnet  
    privateSubnetCidrMask: 24,           // /24 = 254 IPs per subnet
    
    // IPv6 Configuration (disabled for dev)
    enableIPv6: false,
    // ipv6CidrBlock: undefined          // Uses AWS-provided when enabled
  },
  
  staging: {
    // IPv4 Configuration  
    vpcCidr: '10.1.0.0/16',              // Different network for staging
    publicSubnetCidrMask: 24,            // /24 = 254 IPs per subnet
    privateSubnetCidrMask: 23,           // /23 = 510 IPs per subnet (more containers)
    
    // IPv6 Configuration
    enableIPv6: true,                    // Enable IPv6
    // ipv6CidrBlock: undefined          // Uses AWS-provided IPv6 block
  },
  
  production: {
    // IPv4 Configuration
    vpcCidr: '10.2.0.0/16',              // Separate network for production
    publicSubnetCidrMask: 24,            // /24 = 254 IPs per subnet
    privateSubnetCidrMask: 22,           // /22 = 1022 IPs per subnet (max scalability)
    
    // IPv6 Configuration
    enableIPv6: true,                    // Enable IPv6
    // Custom IPv6 CIDR (optional):
    // ipv6CidrBlock: '2001:0db8::/56'   // Uncomment to use custom IPv6 block
  }
};
```

### 2. VPC Stack Interface (`lib/vpc-stack.ts`)

The **modular VPC Stack** defines the available network configuration options:

```typescript
export interface VpcStackProps extends cdk.StackProps {
  environment: string;                 // Environment identifier
  
  // IPv4 Network configuration
  vpcCidr?: string;                    // VPC CIDR block (default: '10.0.0.0/16')
  publicSubnetCidrMask?: number;       // Public subnet mask (default: 24)
  privateSubnetCidrMask?: number;      // Private subnet mask (default: 24)
  
  // Availability Zone configuration
  maxAzs?: number;                     // Maximum AZs to use (default: 3)
  natGateways?: number;                // Number of NAT Gateways
  enableHANatGateways?: boolean;       // High Availability NAT Gateways
  
  // IPv6 Network configuration
  enableIPv6?: boolean;                // Enable IPv6 support
  ipv6CidrBlock?: string;              // Custom IPv6 CIDR (optional)
  
  // VPC Flow Logs configuration
  enableVPCFlowLogs?: boolean;         // Enable VPC Flow Logs to S3
}
```

### 3. VPC Creation Logic (`lib/vpc-stack.ts`)

The **VPC Stack** creates isolated network infrastructure with comprehensive testing:

```typescript
private createVpc(props: VpcStackProps): ec2.Vpc {
  const subnetConfiguration: ec2.SubnetConfiguration[] = [
    {
      name: 'Public',
      subnetType: ec2.SubnetType.PUBLIC,
      cidrMask: props.publicSubnetCidrMask || 24,
    },
    {
      name: 'Private',
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      cidrMask: props.privateSubnetCidrMask || 24,
    },
  ];

  const vpc = new ec2.Vpc(this, 'Vpc', {
    ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr || '10.0.0.0/16'),
    maxAzs: props.maxAzs || 3,
    natGateways: this.calculateNatGateways(props),
    subnetConfiguration,
    enableDnsHostnames: true,
    enableDnsSupport: true,
  });

  // IPv6 support (tested and validated)
  if (props.enableIPv6) {
    this.enableIPv6Support(vpc, props);
  }

  // VPC Flow Logs (with lifecycle management)
  if (props.enableVPCFlowLogs) {
    this.createVPCFlowLogs(props);
  }

  return vpc;
}
```

## Current Network Layout

### Environment Separation

| Environment | VPC CIDR      | Public Mask | Private Mask | IPv6 Support |
|-------------|---------------|-------------|--------------|--------------|
| dev         | 10.0.0.0/16   | /24         | /24          | ❌           |
| staging     | 10.1.0.0/16   | /24         | /23          | ✅ (AWS)     |
| production  | 10.2.0.0/16   | /24         | /22          | ✅ (AWS)     |

### Subnet Allocation Examples

#### Development Environment (10.0.0.0/16, 2 AZs)
- **Public Subnets** (/24 each):
  - AZ-a: 10.0.0.0/24 (10.0.0.1 - 10.0.0.254)
  - AZ-b: 10.0.1.0/24 (10.0.1.1 - 10.0.1.254)
- **Private Subnets** (/24 each):
  - AZ-a: 10.0.2.0/24 (10.0.2.1 - 10.0.2.254)
  - AZ-b: 10.0.3.0/24 (10.0.3.1 - 10.0.3.254)

#### Production Environment (10.2.0.0/16, 3 AZs)
- **Public Subnets** (/24 each):
  - AZ-a: 10.2.0.0/24 (254 IPs)
  - AZ-b: 10.2.1.0/24 (254 IPs)
  - AZ-c: 10.2.2.0/24 (254 IPs)
- **Private Subnets** (/22 each):
  - AZ-a: 10.2.4.0/22 (1022 IPs)
  - AZ-b: 10.2.8.0/22 (1022 IPs)
  - AZ-c: 10.2.12.0/22 (1022 IPs)

## Customization Examples

### 1. Change VPC CIDR Range

To use a different IP range (e.g., for corporate network integration):

```typescript
// In bin/testapp-infrastructure.ts
production: {
  vpcCidr: '172.16.0.0/16',  // Change from 10.2.0.0/16
  // ... other config
}
```

### 2. Use Custom IPv6 CIDR

To use your own IPv6 address space:

```typescript
// In bin/testapp-infrastructure.ts
production: {
  enableIPv6: true,
  ipv6CidrBlock: '2001:0db8::/56',  // Your custom IPv6 range
  // ... other config  
}
```

### 3. Adjust Subnet Sizes

To allocate more IPs for containers:

```typescript
// In bin/testapp-infrastructure.ts
production: {
  publicSubnetCidrMask: 26,   // /26 = 62 IPs (smaller public subnets)
  privateSubnetCidrMask: 20,  // /20 = 4094 IPs (larger private subnets)
  // ... other config
}
```

### 4. Add Environment-Specific Custom Configuration

```typescript
// In bin/testapp-infrastructure.ts
const config = {
  // ... existing environments
  
  // New custom environment
  'prod-eu': {
    enableIPv6: true,
    enableHANatGateways: true,
    maxAzs: 3,
    natGateways: 3,
    desiredCount: 5,
    cpu: 2048,
    memoryLimitMiB: 4096,
    // Custom network for EU region
    vpcCidr: '192.168.0.0/16',
    publicSubnetCidrMask: 24,
    privateSubnetCidrMask: 21,  // /21 = 2046 IPs per subnet
    ipv6CidrBlock: '2001:0db8:1000::/48',  // Custom IPv6 range
  }
};
```

## CIDR Block Planning Guidelines

### IPv4 Planning

1. **VPC Size Selection**:
   - `/16` (65,536 IPs): Large deployments, multiple environments
   - `/20` (4,096 IPs): Medium deployments
   - `/24` (256 IPs): Small deployments, single environment

2. **Subnet Sizing**:
   - **Public subnets**: Usually smaller (`/24` to `/26`) - only for load balancers
   - **Private subnets**: Larger (`/20` to `/24`) - for application containers

3. **Reserved Addresses**:
   - AWS reserves 5 IPs per subnet (network, broadcast, router, DNS, future)
   - Plan accordingly when calculating capacity

### IPv6 Planning

1. **AWS-Provided IPv6**:
   - AWS assigns a `/56` block to your VPC
   - Subnets get `/64` blocks automatically
   - Recommended for most use cases

2. **Custom IPv6** (BYOIP):
   - Requires IPv6 address registration with AWS
   - Use only if you have specific IPv6 requirements
   - Must be at least `/48` block

## Validation and Testing

### 🧪 **Comprehensive Test Coverage**

Our VPC Stack has **100% test success rate** with 26 passing tests covering all network configurations:

```bash
# Run VPC-specific tests
npm test -- test/vpc-stack.test.ts

# Run all infrastructure tests  
npm test
```

**Test Categories Covered**:
- ✅ **Basic VPC Configuration**: CIDR blocks, subnets, gateways (7 tests)
- ✅ **Custom Configuration**: HA NAT Gateways, custom CIDR ranges (3 tests)  
- ✅ **IPv6 Support**: Dual-stack networking, IPv6 routes (3 tests)
- ✅ **VPC Flow Logs**: S3 storage, lifecycle policies, bucket configuration (4 tests)
- ✅ **Security Groups**: Load balancer and application security groups (1 test)
- ✅ **Stack Outputs**: All required exports for cross-stack references (6 tests)
- ✅ **Environment-specific**: Production vs development configurations (2 tests)

### 1. Run Tests Before Deployment
```bash
# Validate all network configurations
npm test -- test/vpc-stack.test.ts

# Check specific network features
npm test -- --testNamePattern="IPv6|Flow|CIDR"
```

### 2. Check Synthesized Template
```bash
npx cdk synth VPC-Stack-production
```

### 3. Deploy and Verify
```bash
# Deploy VPC Stack
npx cdk deploy VPC-Stack-production

# Verify deployment
aws ec2 describe-vpcs --filters "Name=tag:Environment,Values=production"
aws ec2 describe-flow-logs --filters "Name=resource-type,Values=VPC"
```

## Best Practices

### Network Isolation
- Use separate VPC CIDR ranges for each environment
- Avoid overlapping ranges if you plan to peer VPCs
- Reserve IP ranges for future expansion

### Subnet Sizing
- Size private subnets based on maximum expected container count
- Keep public subnets smaller (only need IPs for load balancers)
- Plan for auto-scaling capacity

### IPv6 Considerations
- Enable IPv6 for modern applications and better scaling
- Use AWS-provided IPv6 unless you have specific requirements
- Ensure your application code supports dual-stack networking

### Security
- Never expose private subnet resources directly to the internet
- Use security groups to control traffic between subnets
- Regularly audit and update CIDR blocks as requirements change

## Troubleshooting

### Common Issues

1. **CIDR Conflicts**: Ensure no overlap between environments
2. **Subnet Exhaustion**: Monitor IP usage and increase subnet sizes
3. **IPv6 Routing**: Verify IPv6 routes are properly configured
4. **NAT Gateway Limits**: Check AWS service limits for NAT Gateways

### Monitoring Commands
```bash
# Check VPC information
aws ec2 describe-vpcs --vpc-ids vpc-xxxxxxxxx

# List subnets
aws ec2 describe-subnets --filters "Name=vpc-id,Values=vpc-xxxxxxxxx"

# Check IPv6 CIDR blocks
aws ec2 describe-vpcs --vpc-ids vpc-xxxxxxxxx --query 'Vpcs[*].Ipv6CidrBlockAssociationSet'
```