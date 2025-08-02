# Makefile for TestApp Container Management
# Usage: make <target>

.PHONY: help build build-dev build-prod run run-dev run-prod stop clean test logs shell sops-setup sops-encrypt sops-decrypt sops-encrypt-pattern sops-decrypt-pattern sops-to-act sops-test requirements-snyk lint format test-django test-coverage install sync check security audit infra-install infra-build infra-test infra-synth infra-diff infra-deploy infra-deploy-dev infra-deploy-prod infra-destroy infra-destroy-dev infra-destroy-prod infra-enable-waf infra-enable-flow-logs infra-enable-https infra-enable-container-security infra-disable-security infra-security-status

# Default target
.DEFAULT_GOAL := help

# Variables
IMAGE_NAME := testapp
DEV_TAG := dev
PROD_TAG := prod
LATEST_TAG := latest
CONTAINER_DEV := testapp-dev
CONTAINER_PROD := testapp-prod
PORT := 8000

# Colors for output
BLUE := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RED := \033[31m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "$(BLUE)TestApp Container Management$(NC)"
	@echo ""
	@echo "$(GREEN)Available targets:$(NC)"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "  $(YELLOW)%-15s$(NC) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# Build targets
build: build-prod ## Build production container (default)

build-dev: ## Build development container
	@echo "$(BLUE)Building development container...$(NC)"
	docker build -f Dockerfile.development -t $(IMAGE_NAME):$(DEV_TAG) .
	@echo "$(GREEN)Development container built successfully!$(NC)"

build-prod: ## Build production container
	@echo "$(BLUE)Building production container...$(NC)"
	docker build -f Dockerfile -t $(IMAGE_NAME):$(PROD_TAG) .
	docker tag $(IMAGE_NAME):$(PROD_TAG) $(IMAGE_NAME):$(LATEST_TAG)
	@echo "$(GREEN)Production container built successfully!$(NC)"

build-all: build-dev build-prod ## Build both development and production containers
	@echo "$(GREEN)All containers built successfully!$(NC)"
	@make images

# Run targets
run: run-prod ## Run production container (default)

run-dev: stop-dev ## Run development container
	@echo "$(BLUE)Starting development container...$(NC)"
	docker run -d \
		--name $(CONTAINER_DEV) \
		-p $(PORT):8000 \
		-e REQUIRED_SETTING=development \
		-e DEBUG=True \
		$(IMAGE_NAME):$(DEV_TAG)
	@echo "$(GREEN)Development container started at http://localhost:$(PORT)$(NC)"
	@echo "$(YELLOW)Health check: http://localhost:$(PORT)/health/$(NC)"

run-prod: stop-prod ## Run production container
	@echo "$(BLUE)Starting production container...$(NC)"
	docker run -d \
		--name $(CONTAINER_PROD) \
		-p $(PORT):8000 \
		-e REQUIRED_SETTING=production \
		$(IMAGE_NAME):$(PROD_TAG)
	@echo "$(GREEN)Production container started at http://localhost:$(PORT)$(NC)"
	@echo "$(YELLOW)Health check: http://localhost:$(PORT)/health/$(NC)"

# Stop targets
stop: stop-prod ## Stop production container (default)

stop-dev: ## Stop development container
	@echo "$(YELLOW)Stopping development container...$(NC)"
	@docker stop $(CONTAINER_DEV) 2>/dev/null || true
	@docker rm $(CONTAINER_DEV) 2>/dev/null || true

stop-prod: ## Stop production container
	@echo "$(YELLOW)Stopping production container...$(NC)"
	@docker stop $(CONTAINER_PROD) 2>/dev/null || true
	@docker rm $(CONTAINER_PROD) 2>/dev/null || true

stop-all: stop-dev stop-prod ## Stop all containers

# Test targets
test: ## Test the application endpoints
	@echo "$(BLUE)Testing application endpoints...$(NC)"
	@echo "Testing root endpoint:"
	@curl -s http://localhost:$(PORT)/ || echo "$(RED)Failed to reach root endpoint$(NC)"
	@echo ""
	@echo "Testing health endpoint:"
	@curl -s http://localhost:$(PORT)/health/ || echo "$(RED)Failed to reach health endpoint$(NC)"
	@echo ""

test-dev: run-dev ## Run development container and test
	@sleep 3
	@make test

test-prod: run-prod ## Run production container and test
	@sleep 3
	@make test

# Log targets
logs: logs-prod ## Show production container logs (default)

logs-dev: ## Show development container logs
	@docker logs -f $(CONTAINER_DEV)

logs-prod: ## Show production container logs
	@docker logs -f $(CONTAINER_PROD)

# Shell access
shell: shell-prod ## Access production container shell (default)

shell-dev: ## Access development container shell
	@docker exec -it $(CONTAINER_DEV) /bin/bash

shell-prod: ## Access production container shell
	@docker exec -it $(CONTAINER_PROD) /bin/bash

# Utility targets
images: ## List TestApp Docker images
	@echo "$(BLUE)TestApp Docker images:$(NC)"
	@docker images | grep $(IMAGE_NAME) || echo "$(YELLOW)No TestApp images found$(NC)"

ps: ## Show running TestApp containers
	@echo "$(BLUE)Running TestApp containers:$(NC)"
	@docker ps | grep $(IMAGE_NAME) || echo "$(YELLOW)No TestApp containers running$(NC)"

clean: stop-all ## Clean up containers and images
	@echo "$(YELLOW)Cleaning up TestApp resources...$(NC)"
	@docker rmi $(IMAGE_NAME):$(DEV_TAG) 2>/dev/null || true
	@docker rmi $(IMAGE_NAME):$(PROD_TAG) 2>/dev/null || true
	@docker rmi $(IMAGE_NAME):$(LATEST_TAG) 2>/dev/null || true
	@echo "$(GREEN)Cleanup completed!$(NC)"

# Docker Compose targets
compose-up: ## Start services with docker-compose
	@echo "$(BLUE)Starting services with docker-compose...$(NC)"
	docker-compose up -d

compose-down: ## Stop services with docker-compose
	@echo "$(YELLOW)Stopping docker-compose services...$(NC)"
	docker-compose down

compose-logs: ## Show docker-compose logs
	docker-compose logs -f

# Development workflow
dev: build-dev run-dev ## Quick development setup (build + run dev)
	@echo "$(GREEN)Development environment ready!$(NC)"

prod: build-prod run-prod ## Quick production setup (build + run prod)
	@echo "$(GREEN)Production environment ready!$(NC)"

# CI/CD simulation
ci: build-all test-prod ## Simulate CI/CD pipeline (build all + test)
	@echo "$(GREEN)CI/CD simulation completed successfully!$(NC)"

# SOPS wrapper targets
sops-setup: ## Setup SOPS wrapper dependencies
	@echo "$(BLUE)Setting up SOPS wrapper...$(NC)"
	@uv run scripts/python/sops/setup_sops_wrapper.py
	@echo "$(GREEN)SOPS wrapper setup completed!$(NC)"

sops-encrypt: ## Encrypt secrets using SOPS wrapper
	@echo "$(BLUE)Encrypting secrets...$(NC)"
	@uv run scripts/python/sops/sops_wrapper.py encrypt
	@echo "$(GREEN)Encryption completed!$(NC)"

sops-decrypt: ## Decrypt secrets using SOPS wrapper
	@echo "$(BLUE)Decrypting secrets...$(NC)"
	@uv run scripts/python/sops/sops_wrapper.py decrypt
	@echo "$(GREEN)Decryption completed!$(NC)"

sops-encrypt-pattern: ## Encrypt secrets with custom pattern (use PATTERN=...)
	@echo "$(BLUE)Encrypting secrets with pattern: $(PATTERN)$(NC)"
	@uv run scripts/python/sops/sops_wrapper.py encrypt --pattern "$(PATTERN)"

sops-decrypt-pattern: ## Decrypt secrets with custom pattern (use PATTERN=...)
	@echo "$(BLUE)Decrypting secrets with pattern: $(PATTERN)$(NC)"
	@uv run scripts/python/sops/sops_wrapper.py decrypt --pattern "$(PATTERN)"

sops-to-act: ## Convert secrets to .act/.secrets format for GitHub Actions
	@echo "$(BLUE)Converting secrets to .act/.secrets format...$(NC)"
	@uv run scripts/python/sops/sops_wrapper.py to-act
	@echo "$(GREEN)Conversion to act format completed!$(NC)"

sops-test: ## Run SOPS wrapper tests
	@echo "$(BLUE)Running SOPS wrapper tests...$(NC)"
	@uv run scripts/python/sops/test_sops_wrapper.py
	@echo "$(GREEN)SOPS tests completed!$(NC)"

# Dependencies and CI/CD targets
requirements-snyk: ## Generate requirements-snyk.txt for Snyk dependency scanning
	@echo "$(BLUE)🔄 Regenerating requirements-snyk.txt for Snyk scanning...$(NC)"
	@echo "# This file was autogenerated for Snyk dependency vulnerability scanning" > requirements-snyk.txt
	@echo "# Generated from pyproject.toml production dependencies" >> requirements-snyk.txt
	@echo "#" >> requirements-snyk.txt
	@uv export --format requirements-txt --group production --no-hashes | grep -E "^[a-zA-Z0-9].*==" >> requirements-snyk.txt
	@echo "$(GREEN)✅ Successfully generated requirements-snyk.txt$(NC)"
	@echo "$(YELLOW)📋 File contains $$(grep -c "==" requirements-snyk.txt) production dependencies$(NC)"

# UV Development Tools
install: ## Install project dependencies
	@echo "$(BLUE)📦 Installing project dependencies...$(NC)"
	@uv sync
	@echo "$(GREEN)✅ Dependencies installed successfully$(NC)"

sync: ## Sync dependencies and update lock file
	@echo "$(BLUE)🔄 Syncing dependencies...$(NC)"
	@uv sync --upgrade
	@echo "$(GREEN)✅ Dependencies synced successfully$(NC)"

# Code Quality Tools
lint: ## Run ruff linter to check code quality
	@echo "$(BLUE)🔍 Running ruff linter...$(NC)"
	@uv run ruff check .
	@echo "$(GREEN)✅ Linting completed$(NC)"

format: ## Format code with ruff
	@echo "$(BLUE)🎨 Formatting code with ruff...$(NC)"
	@uv run ruff format .
	@uv run ruff check --fix .
	@echo "$(GREEN)✅ Code formatting completed$(NC)"

# Testing Tools
test-django: ## Run Django tests
	@echo "$(BLUE)🧪 Running Django tests...$(NC)"
	@mkdir -p logs src/static
	@cd src && SECRET_KEY=django-test-secret-key-for-ci ENVIRONMENT=testing DEBUG=false REQUIRED_SETTING=test-value-for-ci EMAIL_URL=smtp://localhost:25 uv run python -u manage.py test
	@echo "$(GREEN)✅ Django tests completed$(NC)"

test-coverage: ## Run Django tests with coverage
	@echo "$(BLUE)📊 Running Django tests with coverage...$(NC)"
	@mkdir -p logs src/static
	@cd src && SECRET_KEY=django-test-secret-key-for-ci ENVIRONMENT=testing DEBUG=false REQUIRED_SETTING=test-value-for-ci EMAIL_URL=smtp://localhost:25 uv run coverage run --source='testapp' manage.py test
	@cd src && uv run coverage report
	@cd src && uv run coverage html
	@echo "$(GREEN)✅ Coverage report generated at src/htmlcov/index.html$(NC)"

check: ## Run Django system checks
	@echo "$(BLUE)✔️  Running Django system checks...$(NC)"
	@mkdir -p logs src/static
	@cd src && SECRET_KEY=django-test-secret-key-for-ci ENVIRONMENT=testing DEBUG=false REQUIRED_SETTING=test-value-for-ci EMAIL_URL=smtp://localhost:25 uv run python -u manage.py check
	@echo "$(GREEN)✅ System checks passed$(NC)"

# Security Tools
security: ## Run security scans with bandit
	@echo "$(BLUE)🔒 Running security scan with bandit...$(NC)"
	@uv run bandit -r src/ -f json -o bandit-report.json || true
	@uv run bandit -r src/ || true
	@echo "$(GREEN)✅ Security scan completed$(NC)"

audit: ## Run pip-audit to check for known vulnerabilities
	@echo "$(BLUE)🔍 Running pip-audit for vulnerability check...$(NC)"
	@uv run pip-audit --format=json --output=pip-audit-report.json || true
	@uv run pip-audit || true
	@echo "$(GREEN)✅ Vulnerability audit completed$(NC)"

# Infrastructure Tools (AWS CDK)
infra-install: ## Install infrastructure dependencies
	@echo "$(BLUE)📦 Installing CDK infrastructure dependencies...$(NC)"
	@cd infrastructure && npm install
	@echo "$(GREEN)✅ Infrastructure dependencies installed$(NC)"

infra-build: ## Build infrastructure TypeScript
	@echo "$(BLUE)🔨 Building infrastructure TypeScript...$(NC)"
	@cd infrastructure && npm run build
	@echo "$(GREEN)✅ Infrastructure built successfully$(NC)"

infra-test: ## Run infrastructure tests
	@echo "$(BLUE)🧪 Running infrastructure tests...$(NC)"
	@cd infrastructure && npm test
	@echo "$(GREEN)✅ Infrastructure tests completed$(NC)"

infra-synth: infra-build ## Synthesize CloudFormation templates
	@echo "$(BLUE)📋 Synthesizing CloudFormation templates...$(NC)"
	@cd infrastructure && npm run synth
	@echo "$(GREEN)✅ CloudFormation templates generated in infrastructure/cdk.out/$(NC)"

infra-diff: infra-build ## Show infrastructure changes
	@echo "$(BLUE)🔍 Showing infrastructure diff...$(NC)"
	@cd infrastructure && npm run diff
	@echo "$(GREEN)✅ Infrastructure diff completed$(NC)"

infra-deploy: infra-deploy-dev ## Deploy to default (dev) environment

infra-deploy-dev: infra-build ## Deploy infrastructure to development environment
	@echo "$(BLUE)🚀 Deploying infrastructure to development...$(NC)"
	@cd infrastructure && npm run deploy -- TestApp-dev --require-approval never
	@echo "$(GREEN)✅ Development infrastructure deployed$(NC)"

infra-deploy-prod: infra-build ## Deploy infrastructure to production environment
	@echo "$(BLUE)🚀 Deploying infrastructure to production...$(NC)"
	@echo "$(YELLOW)⚠️  This will deploy to PRODUCTION environment$(NC)"
	@read -p "Are you sure? Type 'yes' to continue: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		cd infrastructure && npm run deploy -- TestApp-production --require-approval never; \
		echo "$(GREEN)✅ Production infrastructure deployed$(NC)"; \
	else \
		echo "$(YELLOW)🚫 Production deployment cancelled$(NC)"; \
	fi

infra-destroy: infra-destroy-dev ## Destroy default (dev) environment

infra-destroy-dev: ## Destroy development infrastructure
	@echo "$(BLUE)💥 Destroying development infrastructure...$(NC)"
	@echo "$(YELLOW)⚠️  This will DELETE all development resources$(NC)"
	@read -p "Are you sure? Type 'yes' to continue: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		cd infrastructure && npx cdk destroy TestApp-dev --force; \
		echo "$(GREEN)✅ Development infrastructure destroyed$(NC)"; \
	else \
		echo "$(YELLOW)🚫 Development destroy cancelled$(NC)"; \
	fi

infra-destroy-prod: ## Destroy production infrastructure
	@echo "$(BLUE)💥 Destroying production infrastructure...$(NC)"
	@echo "$(RED)⚠️  WARNING: This will DELETE all PRODUCTION resources!$(NC)"
	@echo "$(RED)⚠️  This action is IRREVERSIBLE!$(NC)"
	@read -p "Type 'DELETE-PRODUCTION' to confirm: " confirm; \
	if [ "$$confirm" = "DELETE-PRODUCTION" ]; then \
		cd infrastructure && npx cdk destroy TestApp-production --force; \
		echo "$(GREEN)✅ Production infrastructure destroyed$(NC)"; \
	else \
		echo "$(YELLOW)🚫 Production destroy cancelled$(NC)"; \
	fi

# Security Enhancement Commands
infra-enable-waf: ## Enable WAF protection for infrastructure
	@echo "$(BLUE)🔒 Enabling WAF protection...$(NC)"
	@echo "$(YELLOW)This will modify the infrastructure configuration to enable AWS WAF$(NC)"
	@echo "$(YELLOW)WAF provides DDoS protection and blocks common attacks$(NC)"
	@read -p "Enable WAF? Type 'yes' to continue: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		sed -i '' 's/enableWAF: false/enableWAF: true/g' infrastructure/bin/testapp-infrastructure.ts; \
		echo "$(GREEN)✅ WAF enabled in infrastructure configuration$(NC)"; \
		echo "$(YELLOW)Run 'make infra-deploy-dev' or 'make infra-deploy-prod' to apply changes$(NC)"; \
	else \
		echo "$(YELLOW)🚫 WAF enablement cancelled$(NC)"; \
	fi

infra-enable-flow-logs: ## Enable VPC Flow Logs for network monitoring
	@echo "$(BLUE)📊 Enabling VPC Flow Logs...$(NC)"
	@echo "$(YELLOW)This will create S3 bucket and enable VPC traffic logging$(NC)"
	@echo "$(YELLOW)Flow logs help with network monitoring and security analysis$(NC)"
	@read -p "Enable VPC Flow Logs? Type 'yes' to continue: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		sed -i '' 's/enableVPCFlowLogs: false/enableVPCFlowLogs: true/g' infrastructure/bin/testapp-infrastructure.ts; \
		echo "$(GREEN)✅ VPC Flow Logs enabled in infrastructure configuration$(NC)"; \
		echo "$(YELLOW)Run 'make infra-deploy-dev' or 'make infra-deploy-prod' to apply changes$(NC)"; \
	else \
		echo "$(YELLOW)🚫 VPC Flow Logs enablement cancelled$(NC)"; \
	fi

infra-enable-https: ## Enable HTTPS/TLS with SSL certificate
	@echo "$(BLUE)🔐 Enabling HTTPS/TLS...$(NC)"
	@echo "$(YELLOW)This will create SSL certificate and configure HTTPS listener$(NC)"
	@echo "$(RED)⚠️  You must have a domain name and Route53 hosted zone configured$(NC)"
	@read -p "Enter your domain name (e.g., example.com): " domain; \
	if [ -n "$$domain" ]; then \
		sed -i '' 's/enableHTTPS: false/enableHTTPS: true/g' infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' "s/domainName: undefined/domainName: '$$domain'/g" infrastructure/bin/testapp-infrastructure.ts; \
		echo "$(GREEN)✅ HTTPS enabled with domain: $$domain$(NC)"; \
		echo "$(YELLOW)Run 'make infra-deploy-dev' or 'make infra-deploy-prod' to apply changes$(NC)"; \
	else \
		echo "$(YELLOW)🚫 HTTPS enablement cancelled - domain name required$(NC)"; \
	fi

infra-enable-container-security: ## Enable container security features (non-root user, read-only filesystem)
	@echo "$(BLUE)🔒 Enabling container security features...$(NC)"
	@echo "$(YELLOW)This will enable:$(NC)"
	@echo "$(YELLOW)  - Non-root container user (UID/GID 1001)$(NC)"
	@echo "$(YELLOW)  - Read-only root filesystem$(NC)"
	@echo "$(YELLOW)  - Memory reservation limits$(NC)"
	@read -p "Enable container security features? Type 'yes' to continue: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		sed -i '' 's/enableNonRootContainer: false/enableNonRootContainer: true/g' infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' 's/enableReadOnlyRootFilesystem: false/enableReadOnlyRootFilesystem: true/g' infrastructure/bin/testapp-infrastructure.ts; \
		echo "$(GREEN)✅ Container security features enabled$(NC)"; \
		echo "$(YELLOW)Run 'make infra-deploy-dev' or 'make infra-deploy-prod' to apply changes$(NC)"; \
	else \
		echo "$(YELLOW)🚫 Container security enablement cancelled$(NC)"; \
	fi

infra-disable-security: ## Disable all security enhancements (reset to defaults)
	@echo "$(BLUE)🔓 Disabling security enhancements...$(NC)"
	@echo "$(YELLOW)This will reset all security features to default (disabled) state$(NC)"
	@read -p "Disable all security features? Type 'yes' to continue: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		sed -i '' 's/enableWAF: true/enableWAF: false/g' infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' 's/enableVPCFlowLogs: true/enableVPCFlowLogs: false/g' infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' 's/enableHTTPS: true/enableHTTPS: false/g' infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' "s/domainName: '[^']*'/domainName: undefined/g" infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' 's/enableNonRootContainer: true/enableNonRootContainer: false/g' infrastructure/bin/testapp-infrastructure.ts; \
		sed -i '' 's/enableReadOnlyRootFilesystem: true/enableReadOnlyRootFilesystem: false/g' infrastructure/bin/testapp-infrastructure.ts; \
		echo "$(GREEN)✅ All security features disabled$(NC)"; \
		echo "$(YELLOW)Run 'make infra-deploy-dev' or 'make infra-deploy-prod' to apply changes$(NC)"; \
	else \
		echo "$(YELLOW)🚫 Security disable cancelled$(NC)"; \
	fi

infra-security-status: ## Show current security configuration status
	@echo "$(BLUE)🔍 Infrastructure Security Status$(NC)"
	@echo ""
	@echo "$(GREEN)Current Security Configuration:$(NC)"
	@grep -E "(enableWAF|enableVPCFlowLogs|enableHTTPS|domainName|enableNonRootContainer|enableReadOnlyRootFilesystem)" infrastructure/bin/testapp-infrastructure.ts | \
		sed 's/^[ ]*/  /' | \
		sed 's/enableWAF: true/$(GREEN)✅ WAF Protection: ENABLED$(NC)/' | \
		sed 's/enableWAF: false/$(RED)❌ WAF Protection: DISABLED$(NC)/' | \
		sed 's/enableVPCFlowLogs: true/$(GREEN)✅ VPC Flow Logs: ENABLED$(NC)/' | \
		sed 's/enableVPCFlowLogs: false/$(RED)❌ VPC Flow Logs: DISABLED$(NC)/' | \
		sed 's/enableHTTPS: true/$(GREEN)✅ HTTPS\/TLS: ENABLED$(NC)/' | \
		sed 's/enableHTTPS: false/$(RED)❌ HTTPS\/TLS: DISABLED$(NC)/' | \
		sed 's/enableNonRootContainer: true/$(GREEN)✅ Non-Root Container: ENABLED$(NC)/' | \
		sed 's/enableNonRootContainer: false/$(RED)❌ Non-Root Container: DISABLED$(NC)/' | \
		sed 's/enableReadOnlyRootFilesystem: true/$(GREEN)✅ Read-Only Filesystem: ENABLED$(NC)/' | \
		sed 's/enableReadOnlyRootFilesystem: false/$(RED)❌ Read-Only Filesystem: DISABLED$(NC)/' | \
		grep -v "domainName: undefined"
	@echo ""
