#!/bin/bash

# TestApp Infrastructure Deployment Script
# Usage: ./deploy.sh [environment] [profile]

set -e

# Default values
ENVIRONMENT=${1:-dev}
AWS_PROFILE=${2:-default}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MAIN_PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"

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

echo_info "Starting deployment for environment: $ENVIRONMENT"
echo_info "Using AWS profile: $AWS_PROFILE"

# Change to project directory
cd "$PROJECT_ROOT"

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo_error "AWS CDK is not installed. Please install it first:"
    echo "npm install -g aws-cdk"
    exit 1
fi

# Check if required environment variables are set
if [[ -z "$CDK_DEFAULT_ACCOUNT" ]]; then
    echo_warning "CDK_DEFAULT_ACCOUNT not set. Using AWS CLI default account."
fi

if [[ -z "$CDK_DEFAULT_REGION" ]]; then
    echo_warning "CDK_DEFAULT_REGION not set. Using AWS CLI default region."
fi

# Install dependencies
echo_info "Installing dependencies..."
npm install

# Build TypeScript
echo_info "Building TypeScript..."
npm run build

# Bootstrap CDK (if needed)
echo_info "Checking CDK bootstrap status..."
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --profile "$AWS_PROFILE" >/dev/null 2>&1; then
    echo_info "Bootstrapping CDK..."
    cdk bootstrap --profile "$AWS_PROFILE"
else
    echo_info "CDK already bootstrapped"
fi

echo_info "Loading and validating secrets..."

# Test SOPS secrets access if available
if command -v sops &> /dev/null; then
    if [ -f "$MAIN_PROJECT_ROOT/secrets/$ENVIRONMENT/secrets.yaml" ]; then
        echo_info "Testing SOPS secrets decryption for environment: $ENVIRONMENT"
        cd "$MAIN_PROJECT_ROOT"
        ./scripts/sops-helper.sh view "$ENVIRONMENT" secrets.yaml > /dev/null && echo_success "SOPS secrets successfully validated"
        cd "$PROJECT_ROOT"
    else
        echo_warning "SOPS secrets file not found for environment: $ENVIRONMENT"
    fi
else
    echo_warning "SOPS not installed - secrets will be loaded from environment variables"
fi

# Deploy the stack
echo_info "Deploying infrastructure with SOPS integration..."
cdk deploy \
    --context environment="$ENVIRONMENT" \
    --profile "$AWS_PROFILE" \
    --require-approval never \
    --outputs-file "outputs-$ENVIRONMENT.json"

if [ $? -eq 0 ]; then
    echo_success "Deployment completed successfully!"
    
    # Display outputs
    if [ -f "outputs-$ENVIRONMENT.json" ]; then
        echo_info "Stack outputs:"
        cat "outputs-$ENVIRONMENT.json" | jq -r 'to_entries[] | .value | to_entries[] | "  \(.key): \(.value)"'
    fi
    
    echo_info "Environment: $ENVIRONMENT"
    echo_info "Check the AWS Console for detailed resource information"
else
    echo_error "Deployment failed!"
    exit 1
fi