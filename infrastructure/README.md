# TestApp Infrastructure

AWS CDK TypeScript infrastructure for Django TestApp deployment to ECS Fargate.

## Features

- **Environment-specific configuration** with toggles for IPv6 and HA NAT Gateways
- **IPv6 Support**: Configurable IPv6 support for modern networking
- **High Availability NAT Gateways**: Production-ready HA NAT Gateway setup
- **ECS Fargate**: Serverless container management
- **Application Load Balancer**: Layer 7 load balancing with health checks
- **Auto Scaling**: CPU and memory-based scaling policies
- **CloudWatch Integration**: Comprehensive logging and monitoring
- **ECR Repository**: Private container registry with lifecycle policies
- **Security**: Least privilege IAM roles and security groups

## Environment Configuration

| Environment | IPv6 | HA NAT Gateways | AZs | Desired Count | CPU | Memory |
|-------------|------|----------------|-----|---------------|-----|--------|
| dev         | ❌   | ❌             | 2   | 1             | 256 | 512    |
| staging     | ✅   | ❌             | 2   | 2             | 512 | 1024   |
| production  | ✅   | ✅             | 3   | 3             | 1024| 2048   |

## Deployment Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Deploy to development (default)
npx cdk deploy

# Deploy to staging
npx cdk deploy -c environment=staging

# Deploy to production (with IPv6 and HA NAT Gateways)
npx cdk deploy -c environment=production

# View differences
npx cdk diff -c environment=production

# Synthesize CloudFormation template
npx cdk synth -c environment=production

# Destroy stack
npx cdk destroy -c environment=production
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                          Internet                            │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Application Load Balancer                  │
│                    (Public Subnets)                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│               ECS Fargate Service                           │
│                (Private Subnets)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Container  │  │  Container  │  │  Container  │        │
│  │   (Task)    │  │   (Task)    │  │   (Task)    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    CloudWatch Logs                         │
└─────────────────────────────────────────────────────────────┘
```

## Outputs

The stack provides the following outputs:

- **VpcId**: VPC identifier
- **ClusterName**: ECS cluster name
- **RepositoryUri**: ECR repository URI for container images
- **LoadBalancerDNS**: Application Load Balancer DNS name
- **ServiceName**: ECS service name
- **ApplicationUrl**: Direct URL to access the application

## Security Features

- **Network Isolation**: Applications run in private subnets
- **Least Privilege IAM**: Minimal required permissions for tasks
- **Security Groups**: Restricted network access
- **Container Scanning**: ECR image vulnerability scanning
- **CloudWatch Monitoring**: Comprehensive logging and metrics

## Cost Optimization

- **Environment-specific sizing**: Different resource allocations per environment
- **NAT Gateway optimization**: Single NAT in dev, HA in production
- **Log retention policies**: Shorter retention for dev environments
- **ECR lifecycle policies**: Automatic cleanup of old container images

## Monitoring

- **Health Checks**: Application-level health monitoring via `/health/` endpoint
- **Auto Scaling**: Automatic scaling based on CPU and memory utilization
- **CloudWatch Logs**: Centralized application logging
- **Container Insights**: ECS-specific monitoring metrics