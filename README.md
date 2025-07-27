# TestApp - DevOps Assessment

A simple Django web application for DevOps assessment purposes.

## Project Overview

TestApp is a minimal Django application that provides basic HTTP endpoints including a hello world endpoint and health check. This project is designed for DevOps assessment and demonstrates basic Django application structure.

## Requirements

### System Requirements

- **Python**: 3.9+
- **Operating System**: Linux, macOS, or Windows
- **Memory**: Minimum 512MB RAM
- **Disk Space**: 100MB

### Python Dependencies

See `TestApp/requirements.txt` for complete dependency list:

- Django==3.2.16
- asgiref==3.5.2
- pytz==2022.5
- sqlparse==0.4.3

## Installation & Setup

### Prerequisites

1. **Python 3.9+** - Install from [python.org](https://python.org) or using your system's package manager
2. **pip** - Python package installer (usually comes with Python)
3. **Virtual Environment** (recommended) - For dependency isolation

### Quick Start

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
   cd TestApp
   pip install -r requirements.txt
   ```

4. **Set required environment variable**

   ```bash
   export REQUIRED_SETTING=test_value
   ```

5. **Start the application**

   ```bash
   cd testapp
   chmod +x start.sh
   ./start.sh
   ```

   Or manually:

   ```bash
   python manage.py runserver 0.0.0.0:8000
   ```

6. **Access the application**
   - Main endpoint: <http://localhost:8000>
   - Health check: <http://localhost:8000/health/>

## Project Structure

```text
TestApp/
├── requirements.txt          # Python dependencies
├── README.md                # Project documentation
└── testapp/                 # Main Django project
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
# Run development server
python manage.py runserver

# Run tests
python manage.py test

# Create migrations (if models are added)
python manage.py makemigrations

# Apply migrations (if database is configured)
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

# Run tests
./test.sh

# Or manually
python manage.py test
```

## Security Considerations

⚠️ **SECURITY WARNING**: This application contains several security issues that should be addressed before production use:

- Hardcoded SECRET_KEY in settings
- DEBUG mode enabled
- Empty ALLOWED_HOSTS configuration
- Outdated Django version

See [SECURITY.md](SECURITY.md) for detailed security assessment and recommendations.

## Troubleshooting

### Common Issues

1. **ModuleNotFoundError: No module named 'django'**
   - Solution: Install dependencies with `pip install -r requirements.txt`

2. **Test failures with REQUIRED_SETTING**
   - Solution: Set environment variable `export REQUIRED_SETTING=test_value`

3. **Permission denied on shell scripts**
   - Solution: Make scripts executable with `chmod +x start.sh test.sh`

4. **Port 8000 already in use**
   - Solution: Kill existing process or use different port with `python manage.py runserver 0.0.0.0:8001`

### Getting Help

- Check Django documentation: <https://docs.djangoproject.com/>
- Review application logs for error details
- Ensure all dependencies are properly installed
- Verify Python version compatibility

## License

This project is for assessment purposes only.

