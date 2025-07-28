# TestApp - DevOps Assessment

A simple Django web application for DevOps assessment purposes.

## Project Overview

TestApp is a minimal Django application that provides basic HTTP endpoints including a hello world endpoint and health check. This project is designed for DevOps assessment and demonstrates basic Django application structure.

## Application

The 'testapp' directory contains the application which runs on Python 3.13. Project dependencies are defined in `pyproject.toml` using modern Python packaging standards and can be installed with `uv sync` or `pip install -e .`. Running `start.sh` will start the application server on port 8000.

## Tests

Running `test.sh` will execute the test suite. The environment variable REQUIRED_SETTING must be set to some value for the tests to pass.

## Requirements

### System Requirements

- **Python**: 3.13+ (latest stable version recommended)
- **Operating System**: Linux, macOS, or Windows
- **Memory**: Minimum 512MB RAM
- **Disk Space**: 100MB

### Python Dependencies

Dependencies are managed using modern Python packaging standards in `pyproject.toml`:

- Django>=5.2.0,<6.0.0
- asgiref>=3.9.0,<4.0.0
- pytz>=2025.2,<2026.0
- sqlparse>=0.5.3,<1.0.0

The project uses `uv.lock` for reproducible dependency resolution.

## Installation & Setup

### Prerequisites

1. **Python 3.13+** - Install from [python.org](https://python.org) or using your system's package manager
2. **Package Manager** - Choose one of the following:
   - **uv** (recommended) - Modern, fast Python package manager
   - **pip** - Standard Python package installer (usually comes with Python)
3. **Virtual Environment** (recommended) - For dependency isolation

#### Installing uv (Recommended)

uv is a fast Python package installer and resolver, written in Rust. It's significantly faster than pip and provides better dependency resolution.

**Install uv:**

```bash
# On macOS and Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# On Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Or using pip
pip install uv
```

### Quick Start

Choose between **uv** (recommended) or **pip** installation methods:

#### Option A: Using uv (Recommended)

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd testapp
   ```

2. **Install dependencies**

   ```bash
   # uv automatically creates virtual environment and installs from pyproject.toml
   uv sync
   
   # Or if you prefer manual virtual environment creation
   uv venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   uv pip install -e .
   ```

#### Option B: Using pip (Traditional)

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd testapp
   ```

2. **Set up virtual environment** (recommended)

   ```bash
   python3 -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**

   ```bash
   # Install project in editable mode
   pip install -e .
   
   # Or install individual dependencies if needed
   pip install "django>=5.2.0,<6.0.0" "asgiref>=3.9.0,<4.0.0" "pytz>=2025.2,<2026.0" "sqlparse>=0.5.3,<1.0.0"
   ```

#### Continue Setup (Both Methods)

4. **Set required environment variable**

   ```bash
   export REQUIRED_SETTING=test_value
   ```

5. **Start the application**

   ```bash
   cd src
   chmod +x start.sh
   ./start.sh
   ```

   Or manually:

   ```bash
   # With uv
   uv run python manage.py runserver 0.0.0.0:8000
   
   # With pip (ensure virtual environment is activated)
   python manage.py runserver 0.0.0.0:8000
   ```

6. **Access the application**
   - Main endpoint: <http://localhost:8000>
   - Health check: <http://localhost:8000/health/>

## Project Structure

```text
testapp/
├── ASSESSMENT.md            # Security assessment narrative
├── README.md                # Main project documentation
├── SECURITY.md              # Security policy and vulnerabilities
├── SOPS_WRAPPER_README.md   # SOPS wrapper documentation
├── Makefile                 # Build automation and workflow management
├── pyproject.toml           # Modern Python project configuration and dependencies
├── uv.lock                  # Locked dependency versions for reproducible builds
├── DevOps Assessment CDK.txt # Original assessment document
├── scripts/                 # Utility scripts and tools
│   └── python/
│       └── sops/            # SOPS encryption/decryption wrapper
│           ├── sops_wrapper.py         # Main SOPS Python wrapper
│           ├── setup_sops_wrapper.py   # Setup and configuration script
│           └── test_sops_wrapper.py    # Comprehensive test suite
└── src/                     # Application source code
    ├── manage.py            # Django management script
    ├── start.sh             # Application startup script
    ├── test.sh              # Test execution script
    └── testapp/             # Django application package
        ├── __init__.py      # Python package marker
        ├── asgi.py          # ASGI configuration
        ├── wsgi.py          # WSGI configuration
        ├── settings.py      # Django settings
        ├── urls.py          # URL routing
        ├── views.py         # View functions
        └── tests.py         # Test cases
```

## Available Scripts

### Start Application

```bash
./start.sh
```

Starts the Django development server on `0.0.0.0:8000`

### Run Tests

```bash
./test.sh
```

Executes the Django test suite. **Note**: Requires `REQUIRED_SETTING` environment variable to be set.

### Manual Commands

```bash
# With uv (runs in virtual environment automatically)
uv run python manage.py runserver
uv run python manage.py test
uv run python manage.py makemigrations
uv run python manage.py migrate

# With pip (ensure virtual environment is activated first)
python manage.py runserver
python manage.py test
python manage.py makemigrations
python manage.py migrate
```

## API Endpoints

| Endpoint | Method | Description | Response |
|----------|--------|-------------|----------|
| `/` | GET | Hello World endpoint | `Hello World` |
| `/health/` | GET | Health check endpoint | `OK` |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REQUIRED_SETTING` | Yes (for tests) | None | Required for test execution |
| `DJANGO_SETTINGS_MODULE` | No | `testapp.settings` | Django settings module |

## Development

### Running in Development Mode

The application runs in debug mode by default. For production deployment, ensure:

1. Set `DEBUG = False` in settings.py
2. Configure `ALLOWED_HOSTS` properly
3. Use environment variables for sensitive settings
4. Set up proper database configuration

### Testing

```bash
# Set required environment variable
export REQUIRED_SETTING=test_value

# Run tests using scripts
./test.sh

# Or manually with uv
uv run python manage.py test

# Or manually with pip (ensure virtual environment is activated)
python manage.py test
```

## Security Considerations

⚠️ **SECURITY WARNING**: This application contains several security issues that should be addressed before production use:

- Hardcoded SECRET_KEY in settings
- DEBUG mode enabled
- Empty ALLOWED_HOSTS configuration
- Previous security issues (now resolved with Django 5.2 upgrade)

See [SECURITY.md](SECURITY.md) for detailed security assessment and recommendations.

## SOPS Wrapper

The project includes a comprehensive Python wrapper for SOPS (Secrets OPerationS) that provides intelligent encryption and decryption of secrets with change detection and validation.

### Quick Start

```bash
# Setup SOPS wrapper (one-time)
make sops-setup

# Encrypt secrets
make sops-encrypt

# Decrypt secrets  
make sops-decrypt

# Convert secrets to GitHub Actions format
make sops-to-act

# Run tests
make sops-test
```

### Advanced Usage

```bash
# Encrypt with custom pattern
make sops-encrypt-pattern PATTERN="secrets/*.dec.yaml"

# Decrypt with custom pattern
make sops-decrypt-pattern PATTERN="config/*.enc.yaml"
```

### Features

- **Smart Change Detection**: Only encrypts files when content has actually changed
- **Empty File Prevention**: Ensures no empty encrypted files are generated
- **Parallel Processing**: Processes multiple files concurrently for better performance
- **GitHub Actions Integration**: Convert encrypted secrets to `.act/.secrets` format
- **Comprehensive Testing**: Full test suite with mocks and integration tests

See [SOPS_WRAPPER_README.md](SOPS_WRAPPER_README.md) for detailed documentation.

## Troubleshooting

### Common Issues

1. **ModuleNotFoundError: No module named 'django'**
   - Solution with uv: `uv sync` (installs from pyproject.toml)
   - Solution with pip: `pip install -e .` (installs project in editable mode)

2. **Test failures with REQUIRED_SETTING**
   - Solution: Set environment variable `export REQUIRED_SETTING=test_value`

3. **Permission denied on shell scripts**
   - Solution: Make scripts executable with `chmod +x start.sh test.sh`

4. **Port 8000 already in use**
   - Solution with uv: Kill existing process or use different port with `uv run python manage.py runserver 0.0.0.0:8001`
   - Solution with pip: Kill existing process or use different port with `python manage.py runserver 0.0.0.0:8001`

5. **uv command not found**
   - Solution: Install uv using the installation instructions above, or use pip instead

### Getting Help

- Check Django documentation: <https://docs.djangoproject.com/>
- Review application logs for error details
- Ensure all dependencies are properly installed
- Verify Python version compatibility

## License

This project is for assessment purposes only.
