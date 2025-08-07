# 🚀 TestApp Infrastructure Deployment with Makefile

This Makefile provides a comprehensive set of commands for managing TestApp infrastructure deployments with specific container tags.

## 📋 Quick Start

```bash
# Show all available commands
make help

# Deploy application with specific tag to production
make deploy-app ENV=production TAG=v1.2.3

# Quick update without CDK (fastest)
make quick-update ENV=dev TAG=latest

# Check deployment status
make status ENV=production
```

## 🎯 Core Deployment Commands

### **Deploy Specific Container Tag**

```bash
# Deploy application stack with specific tag (recommended)
make deploy-app ENV=production TAG=v1.2.3

# Deploy full infrastructure with specific tag
make deploy-full ENV=production TAG=v1.2.3

# Deploy only infrastructure (no app changes)
make deploy-infra ENV=production
```

### **Quick Updates**

```bash
# Fastest method: Direct ECS service update (no CDK)
make quick-update ENV=production TAG=v1.2.3

# This method:
# - Updates task definition directly
# - Skips CDK deployment
# - Usually completes in 2-3 minutes
```

## 📊 Status and Verification

```bash
# Show complete deployment status
make status ENV=production

# Check ECS service health
make check-service ENV=production

# Verify deployment matches expected tag
make verify-deployment ENV=production TAG=v1.2.3

# Application health check
make health-check ENV=production
```

## 🛠️ Development Commands

```bash
# Build and test infrastructure
make build
make test
make test-coverage

# Validate CDK configuration
make validate ENV=dev TAG=latest

# List available container tags
make list-tags ENV=production
```

## 📋 Monitoring and Debugging

```bash
# View recent application logs
make logs ENV=production

# Open shell in running container (ECS Exec)
make shell ENV=production
```

## 🗑️ Destruction Commands

```bash
# Destroy application stack (requires confirmation)
make destroy-app ENV=dev

# Destroy all infrastructure (DANGEROUS - requires confirmation)
make destroy ENV=dev
```

## 🔧 Configuration

### **Default Values**
```makefile
ENV ?= dev                    # Environment (dev, production)
TAG ?= latest                 # Container image tag
TYPE ?= application-only      # Deployment type
AWS_PROFILE ?= eliodevbr-cdk # AWS profile
```

### **Override Defaults**
```bash
# Use different AWS profile
make deploy-app ENV=production TAG=v1.2.3 AWS_PROFILE=production-profile

# Change deployment type
make deploy ENV=dev TAG=latest TYPE=full
```

## 📚 Detailed Examples

### **Production Deployment Workflow**

```bash
# 1. Validate the tag exists in ECR
make list-tags ENV=production

# 2. Validate configuration
make validate ENV=production TAG=v1.2.3

# 3. Deploy application with new tag
make deploy-app ENV=production TAG=v1.2.3

# 4. Verify deployment
make verify-deployment ENV=production TAG=v1.2.3

# 5. Check application health
make health-check ENV=production

# 6. View logs if needed
make logs ENV=production
```

### **Development Quick Updates**

```bash
# Build and test locally
make build test

# Quick update to dev environment
make quick-update ENV=dev TAG=feature-branch-123

# Check if it worked
make status ENV=dev
```

### **Emergency Rollback**

```bash
# Check what tags are available
make list-tags ENV=production

# Quick rollback to previous tag
make quick-update ENV=production TAG=v1.2.2

# Verify rollback
make verify-deployment ENV=production TAG=v1.2.2
```

### **Full Infrastructure Deployment**

```bash
# Deploy everything from scratch
make deploy-full ENV=dev TAG=latest

# Or deploy in stages
make deploy-infra ENV=dev
make deploy-app ENV=dev TAG=latest
```

## ⚡ Speed Comparison

| Method | Time | Use Case |
|--------|------|----------|
| `make quick-update` | ~2-3 min | Hot fixes, tag updates |
| `make deploy-app` | ~5-8 min | Application changes |
| `make deploy-full` | ~15-20 min | Complete infrastructure |

## 🛡️ Safety Features

- **Tag validation**: Verifies image exists in ECR before deployment
- **Environment validation**: Only allows `dev` and `production`
- **Confirmation prompts**: Destruction commands require explicit confirmation
- **Health checks**: Automatic application health validation
- **Status reporting**: Comprehensive deployment status information
- **Error handling**: Clear error messages and validation

## 📖 Command Reference

| Command | Description | Example |
|---------|-------------|---------|
| `make help` | Show all available commands | `make help` |
| `make deploy-app` | Deploy application stack | `make deploy-app ENV=prod TAG=v1.2.3` |
| `make quick-update` | Fast ECS service update | `make quick-update ENV=dev TAG=latest` |
| `make status` | Show deployment status | `make status ENV=production` |
| `make health-check` | Test application health | `make health-check ENV=production` |
| `make verify-deployment` | Verify current deployment | `make verify-deployment ENV=prod TAG=v1.2.3` |
| `make list-tags` | List available image tags | `make list-tags ENV=production` |
| `make logs` | Show recent application logs | `make logs ENV=production` |
| `make destroy-app` | Destroy application stack | `make destroy-app ENV=dev` |

## 💡 Tips

1. **Always validate first**: Use `make validate` before deploying
2. **Check available tags**: Use `make list-tags` to see what's available
3. **Use quick-update for hot fixes**: It's the fastest deployment method
4. **Verify after deployment**: Always run `make verify-deployment`
5. **Monitor with logs**: Use `make logs` to watch application behavior
6. **Use environment variables**: Set commonly used values in your shell profile

## 🚨 Common Issues

**Issue**: "Image tag not found in ECR"
```bash
# Solution: Check available tags
make list-tags ENV=production
```

**Issue**: "Service not found"
```bash
# Solution: Check if infrastructure is deployed
make status ENV=production
```

**Issue**: "Health check failed"
```bash
# Solution: Check logs
make logs ENV=production
```

This Makefile provides a production-ready, easy-to-use interface for all your TestApp deployment needs! 🎉