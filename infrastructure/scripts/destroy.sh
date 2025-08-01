#!/bin/bash

# TestApp Infrastructure Destruction Script
# Usage: ./destroy.sh [environment] [profile]

set -e

# Default values
ENVIRONMENT=${1:-dev}
AWS_PROFILE=${2:-default}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

echo_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

echo_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|production)$ ]]; then
    echo_error "Invalid environment: $ENVIRONMENT"
    echo "Valid environments: dev, staging, production"
    exit 1
fi

echo_warning "⚠️  You are about to DESTROY the $ENVIRONMENT infrastructure!"
echo_warning "This action is IRREVERSIBLE and will delete:"
echo "  - ECS Service and Tasks"
echo "  - Application Load Balancer"
echo "  - VPC and all networking components"
echo "  - CloudWatch Log Groups"
if [[ "$ENVIRONMENT" != "production" ]]; then
    echo "  - ECR Repository and all container images"
fi

echo ""
read -p "Are you sure you want to continue? Type 'yes' to confirm: " -r
if [[ ! $REPLY =~ ^yes$ ]]; then
    echo_info "Destruction cancelled."
    exit 0
fi

echo_info "Starting destruction for environment: $ENVIRONMENT"
echo_info "Using AWS profile: $AWS_PROFILE"

# Change to project directory
cd "$PROJECT_ROOT"

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo_error "AWS CDK is not installed. Please install it first:"
    echo "npm install -g aws-cdk"
    exit 1
fi

# Install dependencies and build
echo_info "Installing dependencies..."
npm install

echo_info "Building TypeScript..."
npm run build

# Destroy the stack
echo_info "Destroying infrastructure..."
cdk destroy \
    --context environment="$ENVIRONMENT" \
    --profile "$AWS_PROFILE" \
    --force

if [ $? -eq 0 ]; then
    echo_success "Infrastructure destroyed successfully!"
    
    # Clean up output files
    if [ -f "outputs-$ENVIRONMENT.json" ]; then
        rm "outputs-$ENVIRONMENT.json"
        echo_info "Cleaned up output files"
    fi
else
    echo_error "Destruction failed!"
    exit 1
fi