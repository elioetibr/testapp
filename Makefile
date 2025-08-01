# Makefile for TestApp Container Management
# Usage: make <target>

.PHONY: help build build-dev build-prod run run-dev run-prod stop clean test logs shell sops-setup sops-encrypt sops-decrypt sops-encrypt-pattern sops-decrypt-pattern sops-to-act sops-test requirements-snyk lint format test-django test-coverage install sync check security audit

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
