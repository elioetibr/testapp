# TestApp Infrastructure Deployment Guide

## Overview

This guide covers the deployment of Phase 2: AWS Infrastructure (CDK TypeScript) for the Django TestApp project. The infrastructure includes configurable IPv6 support and High Availability NAT Gateways for production environments.

## Features Implemented

### ✅ Core Infrastructure

- **VPC with Multi-AZ Support**: Configurable 2-3 Availability Zones
- **IPv6 Toggle**: Enable/disable IPv6 support per environment
- **HA NAT Gateways Toggle**: Production-ready high availability setup
- **ECS Fargate Cluster**: Serverless container management
- **Application Load Balancer**: Layer 7 load balancing with health checks
- **ECR Repository**: Private container registry with lifecycle policies

### ✅ Environment-Specific Configuration

| Environment | IPv6 | HA NAT | AZs | Tasks | CPU  | Memory | Use Case |
|-------------|------|--------|-----|-------|------|--------|----------|
| dev         | ❌   | ❌     | 2   | 1     | 256  | 512MB  | Development |
| staging     | ✅   | ❌     | 2   | 2     | 512  | 1GB    | Testing |
| production  | ✅   | ✅     | 3   | 3     | 1024 | 2GB    | Production |

### ✅ Security & Monitoring

- **Least Privilege IAM**: Minimal required permissions
- **Private Subnets**: Applications isolated from internet
- **Security Groups**: Restricted network access
- **CloudWatch Logs**: Centralized logging with retention policies
- **Auto Scaling**: CPU and memory-based scaling
- **Container Scanning**: ECR image vulnerability scanning

## Deployment Commands

### Prerequisites

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Validate configuration (without AWS)
npx ts-node validate.ts
```

### Environment Deployment

#### Development Environment

```bash
# Deploy with minimal resources
./scripts/deploy.sh dev

# Or using CDK directly
npx cdk deploy -c environment=dev
```

#### Staging Environment (with IPv6)

```bash
# Deploy with IPv6 support
./scripts/deploy.sh staging

# Or using CDK directly
npx cdk deploy -c environment=staging
```

#### Production Environment (with IPv6 + HA NAT)

```bash
# Deploy with full production features
./scripts/deploy.sh production

# Or using CDK directly
npx cdk deploy -c environment=production
```

### Utility Commands

```bash
# View differences before deployment
npx cdk diff -c environment=production

# Synthesize CloudFormation template
npx cdk synth -c environment=production

# Destroy infrastructure
./scripts/destroy.sh production
```

## Architecture Highlights

### Network Architecture

```text
┌─────────────────────────────────────────────────────┐
│                   Internet                          │
│                (IPv4 + IPv6*)                      │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────┐
│             Internet Gateway                        │
│            (Public Subnets)                        │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │  Public Subnet  │  │  Public Subnet  │         │
│  │      AZ-a       │  │      AZ-b       │         │
│  └─────────────────┘  └─────────────────┘         │
└─────────────┬─────────────────┬───────────────────────┘
              │                 │
┌─────────────┴─────────────────┴───────────────────────┐
│           Application Load Balancer                   │
└─────────────┬─────────────────┬───────────────────────┘
              │                 │
┌─────────────┴─────────────────┴───────────────────────┐
│                Private Subnets                        │
│  ┌─────────────────┐  ┌─────────────────┐             │
│  │ ECS Tasks       │  │ ECS Tasks       │             │
│  │ (Fargate)       │  │ (Fargate)       │             │
│  └─────────────────┘  └─────────────────┘             │
└─────────────┬─────────────────┬───────────────────────┘
              │                 │
┌─────────────┴─────────────────┴───────────────────────┐
│               NAT Gateways                            │
│        (1 for dev, HA for prod)                      │
└───────────────────────────────────────────────────────┘
```

### Toggle Configuration

#### IPv6 Toggle

- **Enabled**: Adds IPv6 CIDR blocks, routing, and security group rules
- **Disabled**: IPv4-only configuration for cost optimization
- **Default**: Disabled for dev, enabled for staging/production

#### HA NAT Gateways Toggle

- **Enabled**: One NAT Gateway per Availability Zone for high availability
- **Disabled**: Single NAT Gateway for cost optimization
- **Default**: Disabled for dev/staging, enabled for production

## Monitoring & Operations

### CloudWatch Integration
- **Log Groups**: `/aws/ecs/testapp-{environment}`
- **Container Insights**: Enabled for detailed ECS metrics
- **Retention**: 1 week (dev), 1 month (production)

### 🎯 **Enterprise Auto-Scaling Configuration**

**Three-Dimensional Scaling Strategy:**

#### 1. CPU-Based Scaling
- **Target**: 70% CPU utilization
- **Scale Out Cooldown**: 120 seconds (2 minutes)
- **Scale In Cooldown**: 300 seconds (5 minutes)
- **CloudWatch Alarms**: Automatic high/low threshold monitoring

#### 2. Memory-Based Scaling  
- **Target**: 80% memory utilization
- **Scale Out Cooldown**: 120 seconds (2 minutes)
- **Scale In Cooldown**: 300 seconds (5 minutes)
- **CloudWatch Alarms**: Automatic high/low threshold monitoring

#### 3. Request-Based Scaling
- **Target**: 1000 requests per target
- **Metric Source**: ALB target group metrics
- **Scale Out Cooldown**: 120 seconds (2 minutes)
- **Scale In Cooldown**: 300 seconds (5 minutes)
- **CloudWatch Alarms**: Automatic high/low threshold monitoring

**Scaling Capacity Configuration:**
- **Development**: Min 1, Max 3 tasks (cost optimized)
- **Production**: Min 1, Max 10 tasks (performance optimized)
- **Asymmetric Cooldowns**: Faster scale-out (2min) vs scale-in (5min) prevents flapping

**Monitoring Commands:**
```bash
# Check auto-scaling status
aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids service/testapp-cluster-dev/testapp-service-dev

# View scaling policies
aws application-autoscaling describe-scaling-policies --service-namespace ecs --resource-id service/testapp-cluster-dev/testapp-service-dev

# Monitor scaling activities
aws application-autoscaling describe-scaling-activities --service-namespace ecs --resource-id service/testapp-cluster-dev/testapp-service-dev
```

### Health Checks
- **ALB Health Check**: `/health/` endpoint
- **Check Interval**: 30 seconds
- **Timeout**: 5 seconds
- **Healthy Threshold**: 2 consecutive successes
- **Unhealthy Threshold**: 3 consecutive failures

## Cost Optimization

### Development Environment
- Single NAT Gateway: ~$45/month
- Minimal compute resources: ~$10-20/month
- **Total**: ~$55-65/month

### Production Environment
- HA NAT Gateways (3): ~$135/month
- Higher compute resources: ~$50-100/month
- **Total**: ~$185-235/month

### Cost Reduction Tips
1. Use Spot instances for development
2. Implement scheduled scaling
3. Regular review of unused resources
4. Use development environments only during business hours

## Troubleshooting

### Common Issues

#### CDK Bootstrap Required
```bash
# Error: Need to bootstrap
cdk bootstrap
```

#### AWS Credentials Not Configured
```bash
# Configure credentials
aws configure
# Or use AWS SSO
aws sso login
```

#### Container Image Not Found
```bash
# Push container image to ECR first
# See main project README for container commands
```

### Verification Commands
```bash
# Check stack status
aws cloudformation describe-stacks --stack-name TestApp-production

# Verify ECS service
aws ecs describe-services --cluster testapp-cluster-production --services testapp-service-production

# Check application health
curl http://<alb-dns-name>/health/
```

## Security Considerations

### Network Security

- Applications run in private subnets
- No direct internet access to containers
- Security groups with minimal required ports
- WAF integration ready (future enhancement)

### Container Security

- Non-root container execution
- Minimal base image (Python 3.9-slim)
- Image vulnerability scanning enabled
- Secrets management via AWS Secrets Manager

### Access Control

- Least privilege IAM roles
- Service-linked roles for ECS
- Cross-account access for CI/CD ready

## Next Steps

1. **Configure AWS Credentials**: Set up AWS CLI or SSO
2. **Bootstrap CDK**: Prepare AWS account for CDK deployments
3. **Deploy Infrastructure**: Start with development environment
4. **Implement CI/CD**: Phase 3 of the implementation plan
5. **Add Database**: Future enhancement for stateful workloads

## Support

For issues or questions:

1. Check CloudWatch logs for application errors
2. Review CDK deployment logs
3. Validate configuration with `npx ts-node validate.ts`
4. Run infrastructure tests with `npm test`
