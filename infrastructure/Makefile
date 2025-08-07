# TestApp Infrastructure Makefile
# Usage: make <target> ENV=<environment> TAG=<image-tag>

# Default values
ENV ?= dev
TAG ?= latest
TYPE ?= application-only
APP_NAME ?= testapp
AWS_PROFILE ?= eliodevbr-cdk
AWS_REGION ?= us-east-1

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
BLUE := \033[0;34m
CYAN := \033[0;36m
NC := \033[0m

# Computed variables
CLUSTER_NAME := testapp-cluster-$(ENV)
SERVICE_NAME := testapp-service-$(ENV)
ECR_REPO := testapp-$(ENV)
ALB_NAME := testapp-alb-$(ENV)
CDK_APP := npx ts-node bin/testapp-infrastructure.ts

.PHONY: help build test clean deploy deploy-full deploy-app deploy-infra quick-update list-tags verify-deployment check-service health-check destroy status logs shell

# Default target
help: ## Show this help message
	@echo "$(CYAN)TestApp Infrastructure Management$(NC)"
	@echo ""
	@echo "$(YELLOW)Usage:$(NC)"
	@echo "  make <target> ENV=<environment> TAG=<image-tag>"
	@echo ""
	@echo "$(YELLOW)Examples:$(NC)"
	@echo "  make deploy-app ENV=production TAG=v1.2.3"
	@echo "  make quick-update ENV=dev TAG=latest"
	@echo "  make status ENV=production"
	@echo ""
	@echo "$(YELLOW)Available targets:$(NC)"
	@awk 'BEGIN {FS = ":.*##"; printf ""} /^[a-zA-Z_-]+:.*?##/ { printf "  $(CYAN)%-20s$(NC) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "$(YELLOW)Default values:$(NC)"
	@echo "  ENV=$(ENV)"
	@echo "  TAG=$(TAG)"
	@echo "  TYPE=$(TYPE)"
	@echo "  APP_NAME=$(APP_NAME)"
	@echo "  AWS_PROFILE=$(AWS_PROFILE)"

# =============================================================================
# BUILD AND TEST TARGETS
# =============================================================================

build: ## Build TypeScript infrastructure code
	@echo "$(YELLOW)🔨 Building infrastructure...$(NC)"
	npm run build
	@echo "$(GREEN)✅ Build completed$(NC)"

test: ## Run all infrastructure tests
	@echo "$(YELLOW)🧪 Running infrastructure tests...$(NC)"
	npm test
	@echo "$(GREEN)✅ Tests completed$(NC)"

test-coverage: ## Run tests with coverage report
	@echo "$(YELLOW)📊 Running tests with coverage...$(NC)"
	npm test -- --coverage
	@echo "$(GREEN)✅ Coverage report generated$(NC)"

clean: ## Clean build artifacts and node_modules
	@echo "$(YELLOW)🧹 Cleaning build artifacts...$(NC)"
	rm -rf lib/*.js lib/*.d.ts lib/**/*.js lib/**/*.d.ts
	rm -rf node_modules
	rm -rf cdk.out
	rm -rf coverage
	@echo "$(GREEN)✅ Clean completed$(NC)"

validate: build ## Validate CDK syntax and configuration
	@echo "$(YELLOW)🔍 Validating CDK configuration...$(NC)"
	npx cdk synth --app "$(CDK_APP)" --context environment=$(ENV) --context taskImageTag=$(TAG) --context appName=$(APP_NAME) > /dev/null
	@echo "$(GREEN)✅ CDK validation passed$(NC)"

wait-for-stacks: ## Wait for CloudFormation stacks to be in stable state
	@echo "$(YELLOW)⏳ Checking CloudFormation stack states...$(NC)"
	@$(MAKE) _wait-for-stack STACK_NAME=TestApp-VPC-$(ENV)
	@$(MAKE) _wait-for-stack STACK_NAME=TestApp-Platform-$(ENV)
	@$(MAKE) _wait-for-stack STACK_NAME=TestApp-App-$(ENV)
	@echo "$(GREEN)✅ All stacks are ready$(NC)"

# =============================================================================
# DEPLOYMENT TARGETS
# =============================================================================

deploy: validate ## Deploy based on TYPE (infrastructure-only, application-only, or full)
	@echo "$(BLUE)🚀 Starting $(TYPE) deployment to $(ENV) with tag $(TAG)$(NC)"
	@$(MAKE) deploy-$(TYPE)

deploy-full: wait-for-stacks ## Deploy complete infrastructure (VPC + Platform + Application)
	@echo "$(BLUE)🏗️ Deploying full infrastructure to $(ENV) with tag $(TAG)$(NC)"
	npx cdk deploy --app "$(CDK_APP)" \
		--all \
		--require-approval never \
		--context environment=$(ENV) \
		--context taskImageTag=$(TAG) \
		--context appName=$(APP_NAME)
	@echo "$(GREEN)✅ Full deployment completed$(NC)"
	@$(MAKE) _show-deployment-info

deploy-infra: deploy-infrastructure-only ## Alias for deploy-infrastructure-only

deploy-infrastructure-only: wait-for-stacks ## Deploy only infrastructure stacks (VPC + Platform)
	@echo "$(BLUE)🏗️ Deploying infrastructure stacks to $(ENV)$(NC)"
	npx cdk deploy --app "$(CDK_APP)" \
		TestApp-VPC-$(ENV) \
		TestApp-Platform-$(ENV) \
		--require-approval never \
		--context environment=$(ENV) \
		--context taskImageTag=$(TAG) \
		--context appName=$(APP_NAME)
	@echo "$(GREEN)✅ Infrastructure deployment completed$(NC)"

deploy-app: deploy-application-only ## Alias for deploy-application-only

deploy-application-only: wait-for-stacks ## Deploy only application stack
	@echo "$(BLUE)🚀 Deploying application stack to $(ENV) with tag $(TAG)$(NC)"
	npx cdk deploy --app "$(CDK_APP)" \
		TestApp-App-$(ENV) \
		--require-approval never \
		--context environment=$(ENV) \
		--context taskImageTag=$(TAG) \
		--context appName=$(APP_NAME)
	@echo "$(GREEN)✅ Application deployment completed$(NC)"
	@$(MAKE) _show-deployment-info

quick-update: ## Quick ECS service update without CDK (fastest)
	@echo "$(BLUE)⚡ Quick updating $(SERVICE_NAME) with tag $(TAG)$(NC)"
	@$(MAKE) _validate-environment
	@$(MAKE) _validate-image-tag
	@echo "$(YELLOW)📋 Getting current task definition...$(NC)"
	$(eval CURRENT_TASK_DEF := $(shell aws ecs describe-services --profile $(AWS_PROFILE) --cluster $(CLUSTER_NAME) --services $(SERVICE_NAME) --query 'services[0].taskDefinition' --output text))
	@echo "$(BLUE)Current task definition: $(CURRENT_TASK_DEF)$(NC)"
	@echo "$(YELLOW)🔧 Creating new task definition...$(NC)"
	aws ecs describe-task-definition --profile $(AWS_PROFILE) --task-definition $(CURRENT_TASK_DEF) --query 'taskDefinition' > current-task-def.json
	$(eval ECR_URI := $(shell aws ecr describe-repositories --profile $(AWS_PROFILE) --repository-names $(ECR_REPO) --query 'repositories[0].repositoryUri' --output text))
	jq --arg image "$(ECR_URI):$(TAG)" \
		'.containerDefinitions[0].image = $$image | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .placementConstraints, .compatibilities, .registeredAt, .registeredBy)' \
		current-task-def.json > new-task-def.json
	$(eval NEW_TASK_DEF_ARN := $(shell aws ecs register-task-definition --profile $(AWS_PROFILE) --cli-input-json file://new-task-def.json --query 'taskDefinition.taskDefinitionArn' --output text))
	@echo "$(BLUE)New task definition: $(NEW_TASK_DEF_ARN)$(NC)"
	@echo "$(YELLOW)🚀 Updating ECS service...$(NC)"
	aws ecs update-service --profile $(AWS_PROFILE) --cluster $(CLUSTER_NAME) --service $(SERVICE_NAME) --task-definition $(NEW_TASK_DEF_ARN) > /dev/null
	@echo "$(YELLOW)⏳ Waiting for service to stabilize...$(NC)"
	aws ecs wait services-stable --profile $(AWS_PROFILE) --cluster $(CLUSTER_NAME) --services $(SERVICE_NAME) --cli-read-timeout 600
	@rm -f current-task-def.json new-task-def.json
	@echo "$(GREEN)✅ Quick update completed$(NC)"
	@$(MAKE) verify-deployment

# =============================================================================
# UTILITY TARGETS
# =============================================================================

list-tags: ## List available container image tags in ECR
	@echo "$(YELLOW)📋 Available image tags in $(ECR_REPO):$(NC)"
	aws ecr list-images --profile $(AWS_PROFILE) \
		--repository-name $(ECR_REPO) \
		--query 'imageIds[*].imageTag' \
		--output table 2>/dev/null || echo "$(RED)❌ Repository $(ECR_REPO) not found$(NC)"

status: ## Show current deployment status
	@echo "$(CYAN)📊 Deployment Status for $(ENV):$(NC)"
	@echo ""
	@echo "$(YELLOW)Environment:$(NC) $(ENV)"
	@echo "$(YELLOW)Cluster:$(NC) $(CLUSTER_NAME)"
	@echo "$(YELLOW)Service:$(NC) $(SERVICE_NAME)"
	@echo ""
	@$(MAKE) check-service
	@echo ""
	@$(MAKE) _show-current-image
	@echo ""
	@$(MAKE) _show-load-balancer-info

check-service: ## Check ECS service status
	@echo "$(YELLOW)🔍 ECS Service Status:$(NC)"
	aws ecs describe-services --profile $(AWS_PROFILE) \
		--cluster $(CLUSTER_NAME) \
		--services $(SERVICE_NAME) \
		--query 'services[0].{ServiceName:serviceName,Status:status,RunningCount:runningCount,PendingCount:pendingCount,DesiredCount:desiredCount,TaskDefinition:taskDefinition}' \
		--output table 2>/dev/null || echo "$(RED)❌ Service $(SERVICE_NAME) not found$(NC)"

health-check: ## Perform application health check
	@echo "$(YELLOW)🏥 Performing health check...$(NC)"
	$(eval ALB_DNS := $(shell aws elbv2 describe-load-balancers --profile $(AWS_PROFILE) --names $(ALB_NAME) --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null))
	@if [ "$(ALB_DNS)" != "None" ] && [ "$(ALB_DNS)" != "" ]; then \
		echo "$(BLUE)Testing: http://$(ALB_DNS)/health/$(NC)"; \
		curl -sf http://$(ALB_DNS)/health/ > /dev/null && \
		echo "$(GREEN)✅ Health check passed$(NC)" || \
		echo "$(RED)❌ Health check failed$(NC)"; \
	else \
		echo "$(RED)❌ Load balancer not found$(NC)"; \
	fi

verify-deployment: ## Verify current deployment
	@echo "$(YELLOW)🔍 Verifying deployment...$(NC)"
	$(eval CURRENT_TASK_DEF := $(shell aws ecs describe-services --profile $(AWS_PROFILE) --cluster $(CLUSTER_NAME) --services $(SERVICE_NAME) --query 'services[0].taskDefinition' --output text 2>/dev/null))
	@if [ "$(CURRENT_TASK_DEF)" != "None" ] && [ "$(CURRENT_TASK_DEF)" != "" ]; then \
		CURRENT_IMAGE=$$(aws ecs describe-task-definition --profile $(AWS_PROFILE) --task-definition $(CURRENT_TASK_DEF) --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null); \
		CURRENT_TAG=$$(echo $$CURRENT_IMAGE | cut -d':' -f2); \
		echo "$(BLUE)Current image tag: $$CURRENT_TAG$(NC)"; \
		if [ "$$CURRENT_TAG" = "$(TAG)" ]; then \
			echo "$(GREEN)✅ Deployment verified: Tag matches$(NC)"; \
		else \
			echo "$(YELLOW)⚠️  Tag mismatch: Expected $(TAG), got $$CURRENT_TAG$(NC)"; \
		fi; \
	else \
		echo "$(RED)❌ Service not found or not running$(NC)"; \
	fi

logs: ## Show recent application logs
	@echo "$(YELLOW)📋 Recent application logs for $(ENV):$(NC)"
	aws logs tail --profile $(AWS_PROFILE) \
		--follow \
		/aws/ecs/testapp-$(ENV) \
		--since 10m

shell: ## Open shell in running container (ECS Exec)
	@echo "$(YELLOW)💻 Opening shell in $(SERVICE_NAME)...$(NC)"
	$(eval TASK_ARN := $(shell aws ecs list-tasks --profile $(AWS_PROFILE) --cluster $(CLUSTER_NAME) --service-name $(SERVICE_NAME) --query 'taskArns[0]' --output text 2>/dev/null))
	@if [ "$(TASK_ARN)" != "None" ] && [ "$(TASK_ARN)" != "" ]; then \
		echo "$(BLUE)Connecting to task: $(TASK_ARN)$(NC)"; \
		aws ecs execute-command --profile $(AWS_PROFILE) \
			--cluster $(CLUSTER_NAME) \
			--task $(TASK_ARN) \
			--container testapp-container \
			--interactive \
			--command "/bin/sh"; \
	else \
		echo "$(RED)❌ No running tasks found$(NC)"; \
	fi

# =============================================================================
# DESTRUCTION TARGETS
# =============================================================================

destroy: ## Destroy infrastructure (DANGEROUS - requires confirmation)
	@echo "$(RED)⚠️  WARNING: This will destroy all infrastructure for $(ENV)!$(NC)"
	@echo "$(RED)This action is IRREVERSIBLE!$(NC)"
	@echo ""
	@echo "Type 'DESTROY' to confirm:"
	@read confirmation && [ "$$confirmation" = "DESTROY" ] || (echo "$(RED)❌ Confirmation failed$(NC)" && exit 1)
	@echo "$(YELLOW)🗑️  Destroying infrastructure for $(ENV)...$(NC)"
	npx cdk destroy --app "$(CDK_APP)" \
		--all \
		--force \
		--context environment=$(ENV) \
		--context appName=$(APP_NAME)
	@echo "$(GREEN)✅ Infrastructure destroyed$(NC)"

destroy-app: ## Destroy only application stack
	@echo "$(RED)⚠️  WARNING: This will destroy the application stack for $(ENV)!$(NC)"
	@echo "Type 'DESTROY' to confirm:"
	@read confirmation && [ "$$confirmation" = "DESTROY" ] || (echo "$(RED)❌ Confirmation failed$(NC)" && exit 1)
	@echo "$(YELLOW)🗑️  Destroying application stack...$(NC)"
	npx cdk destroy --app "$(CDK_APP)" \
		TestApp-App-$(ENV) \
		--force \
		--context environment=$(ENV) \
		--context appName=$(APP_NAME)
	@echo "$(GREEN)✅ Application stack destroyed$(NC)"

# =============================================================================
# INTERNAL HELPER TARGETS
# =============================================================================

_validate-environment:
	@if ! echo "$(ENV)" | grep -qE "^(dev|production)$$"; then \
		echo "$(RED)❌ Error: ENV must be 'dev' or 'production'$(NC)"; \
		exit 1; \
	fi

_validate-image-tag:
	@echo "$(YELLOW)🔍 Validating image tag $(TAG) exists in ECR...$(NC)"
	@aws ecr describe-images --profile $(AWS_PROFILE) \
		--repository-name $(ECR_REPO) \
		--image-ids imageTag=$(TAG) \
		--query 'imageDetails[0].imageTags' --output text > /dev/null 2>&1 || \
		(echo "$(RED)❌ Error: Image tag $(TAG) not found in $(ECR_REPO)$(NC)" && \
		echo "$(YELLOW)Available tags:$(NC)" && \
		$(MAKE) list-tags && exit 1)
	@echo "$(GREEN)✅ Image tag validated$(NC)"

_show-current-image:
	@echo "$(YELLOW)🐳 Current Container Image:$(NC)"
	$(eval CURRENT_TASK_DEF := $(shell aws ecs describe-services --profile $(AWS_PROFILE) --cluster $(CLUSTER_NAME) --services $(SERVICE_NAME) --query 'services[0].taskDefinition' --output text 2>/dev/null))
	@if [ "$(CURRENT_TASK_DEF)" != "None" ] && [ "$(CURRENT_TASK_DEF)" != "" ]; then \
		CURRENT_IMAGE=$$(aws ecs describe-task-definition --profile $(AWS_PROFILE) --task-definition $(CURRENT_TASK_DEF) --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null); \
		echo "   Image: $$CURRENT_IMAGE"; \
		echo "   Task Definition: $(CURRENT_TASK_DEF)"; \
	else \
		echo "   $(RED)No running service found$(NC)"; \
	fi

_show-load-balancer-info:
	@echo "$(YELLOW)🔗 Load Balancer Info:$(NC)"
	$(eval ALB_DNS := $(shell aws elbv2 describe-load-balancers --profile $(AWS_PROFILE) --names $(ALB_NAME) --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null))
	@if [ "$(ALB_DNS)" != "None" ] && [ "$(ALB_DNS)" != "" ]; then \
		echo "   Application URL: http://$(ALB_DNS)"; \
		echo "   Health Check: http://$(ALB_DNS)/health/"; \
		echo "   Load Balancer: $(ALB_NAME)"; \
	else \
		echo "   $(RED)Load balancer not found$(NC)"; \
	fi

_show-deployment-info:
	@echo ""
	@echo "$(CYAN)🎉 Deployment Information:$(NC)"
	@$(MAKE) _show-current-image
	@$(MAKE) _show-load-balancer-info
	@echo ""
	@echo "$(BLUE)🔍 Verify deployment:$(NC) make verify-deployment ENV=$(ENV)"
	@echo "$(BLUE)🏥 Health check:$(NC) make health-check ENV=$(ENV)"
	@echo "$(BLUE)📋 Service status:$(NC) make status ENV=$(ENV)"

_wait-for-stack:
	@echo "$(YELLOW)⏳ Checking stack $(STACK_NAME)...$(NC)"
	@max_attempts=30; \
	attempt=1; \
	while [ $$attempt -le $$max_attempts ]; do \
		status=$$(aws cloudformation describe-stacks --profile $(AWS_PROFILE) --stack-name $(STACK_NAME) --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND"); \
		case $$status in \
			"CREATE_COMPLETE"|"UPDATE_COMPLETE"|"ROLLBACK_COMPLETE"|"UPDATE_ROLLBACK_COMPLETE"|"NOT_FOUND") \
				echo "$(GREEN)✅ Stack $(STACK_NAME) is ready ($$status)$(NC)"; \
				break; \
				;; \
			"CREATE_IN_PROGRESS"|"UPDATE_IN_PROGRESS"|"DELETE_IN_PROGRESS"|"ROLLBACK_IN_PROGRESS"|"UPDATE_ROLLBACK_IN_PROGRESS") \
				echo "$(YELLOW)⏳ Stack $(STACK_NAME) is busy ($$status), waiting... ($$attempt/$$max_attempts)$(NC)"; \
				sleep 60; \
				;; \
			"CREATE_FAILED"|"UPDATE_FAILED"|"DELETE_FAILED") \
				echo "$(RED)❌ Stack $(STACK_NAME) is in failed state: $$status$(NC)"; \
				exit 1; \
				;; \
			*) \
				echo "$(YELLOW)⚠️  Unknown status for $(STACK_NAME): $$status$(NC)"; \
				sleep 30; \
				;; \
		esac; \
		attempt=$$((attempt + 1)); \
	done; \
	if [ $$attempt -gt $$max_attempts ]; then \
		echo "$(RED)❌ Timeout waiting for stack $(STACK_NAME)$(NC)"; \
		exit 1; \
	fi