# Production Dockerfile for Django TestApp - Python 3.13 + Django 5.2
# Security: Uses astral-sh/uv base with distroless runtime for maximum security
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS builder

# Install additional system dependencies for building
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    UV_SYSTEM_PYTHON=1

# Stage 2: Dependencies installation
FROM builder AS dependencies

# Create and set working directory
WORKDIR /app

# Copy project files needed for installation
COPY pyproject.toml .

# Install Python dependencies with uv (production group)
RUN uv sync --group production --no-dev

# Create directories that will be needed in runtime (since distroless can't create them)
RUN mkdir -p /app/logs /app/staticfiles

# Stage 3: Runtime image (Distroless for maximum security)
FROM gcr.io/distroless/python3-debian12:latest AS runtime

# Set production environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ENVIRONMENT=production \
    DJANGO_SETTINGS_MODULE=testapp.settings \
    PYTHONPATH=/app

# Set working directory
WORKDIR /app

# Copy Python packages from dependencies stage
COPY --from=dependencies /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=dependencies /usr/local/bin /usr/local/bin

# Copy application code
COPY --chown=nonroot:nonroot src/ .

# Copy pre-created directories from dependencies stage
COPY --from=dependencies --chown=nonroot:nonroot /app/logs /app/logs
COPY --from=dependencies --chown=nonroot:nonroot /app/staticfiles /app/staticfiles

# Expose port
EXPOSE 8000

# Distroless security benefits:
# - No shell, package managers, or unnecessary tools
# - Minimal attack surface
# - Runs as nonroot user by default
# - Only contains Python runtime and application

# Use Gunicorn for production (note: distroless python3 already has python3)
CMD ["python3", "-m", "gunicorn", "--bind", "0.0.0.0:8000", "--workers", "4", "--worker-class", "sync", "--timeout", "30", "--keep-alive", "2", "--max-requests", "1000", "--max-requests-jitter", "100", "--preload", "testapp.wsgi:application"]