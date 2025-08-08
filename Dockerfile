# Production Dockerfile for Django TestApp - Python 3.13 + Django 5.2
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS base

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    UV_SYSTEM_PYTHON=1

# Install system dependencies and uv
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Add uv to PATH
ENV PATH="/root/.cargo/bin:$PATH"

# Stage 2: Dependencies installation
FROM base AS dependencies

# Create and set working directory
WORKDIR /app

# Copy project files needed for installation
COPY pyproject.toml uv.lock ./

# Install Python dependencies with uv (production group)
RUN uv pip install --system -e . --group production

# Stage 3: Runtime image
FROM python:3.13-slim-bookworm AS runtime

# Set production environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ENVIRONMENT=production \
    DJANGO_SETTINGS_MODULE=testapp.settings \
    SECRET_KEY=django-production-secret-key-change-me \
    REQUIRED_SETTING=production

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Create app directory and logs directory
WORKDIR /app
RUN mkdir -p /app/logs && mkdir -p /app/staticfiles

# Copy Python packages from dependencies stage
COPY --from=dependencies /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=dependencies /usr/local/bin /usr/local/bin

# Copy application code (updated path)
COPY src/ .

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Use Gunicorn for production with optimized settings
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "4", "--worker-class", "sync", "--timeout", "30", "--keep-alive", "2", "--max-requests", "1000", "--max-requests-jitter", "100", "--preload", "testapp.wsgi:application"]
