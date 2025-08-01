# TestApp API Testing with Postman

This directory contains comprehensive Postman collections and environments for testing the Django TestApp API across different deployment scenarios.

## 📋 Collection Overview

### Main Collection: `TestApp-API.postman_collection.json`

**5 Test Categories with 8+ Test Scenarios:**

1. **Health Checks** 🏥
   - `/health/` endpoint validation
   - Response time verification
   - Load balancer compatibility tests

2. **Application Endpoints** 🌐
   - `/` root endpoint ("Hello World")
   - Content validation
   - Server header verification

3. **Error Handling Tests** ⚠️
   - 404 Not Found scenarios
   - Method not allowed (405) tests
   - Error response format validation

4. **Performance Tests** 🚀
   - Load testing for health checks
   - Concurrent request handling
   - Response time benchmarking

5. **Security Tests** 🔒
   - Security headers validation
   - Information disclosure checks
   - Basic security posture assessment

## 🌍 Environment Files

### 1. Local Development: `TestApp-Environments.postman_environment.json`
```json
{
  "base_url": "http://localhost:8000",
  "environment": "development",
  "timeout": "5000"
}
```

### 2. Docker Compose: `TestApp-Docker.postman_environment.json`
```json
{
  "base_url": "http://localhost:8000", 
  "environment": "docker",
  "container_name": "matific-testapp-1"
}
```

### 3. AWS Production: `TestApp-Production.postman_environment.json`
```json
{
  "base_url": "https://your-alb-url.us-east-1.elb.amazonaws.com",
  "environment": "production",
  "aws_region": "us-east-1"
}
```

## 🚀 Quick Start

### 1. Import Collection & Environments
```bash
# In Postman:
# File → Import → Select all .json files from this directory
```

### 2. Select Environment
- **Local Development**: Use Django dev server (`python manage.py runserver`)
- **Docker**: Use `docker compose up -d`
- **Production**: Update ALB URL after AWS deployment

### 3. Run Tests

#### Individual Tests
- Select any request and click "Send"
- Check test results in "Test Results" tab

#### Collection Runner
1. Click "Runner" in Postman
2. Select "TestApp Django API Collection"
3. Choose environment
4. Run all tests

#### Command Line (Newman)
```bash
# Install Newman
npm install -g newman

# Run entire collection
newman run TestApp-API.postman_collection.json \
  -e TestApp-Docker.postman_environment.json \
  --reporters html,cli

# Run specific folder
newman run TestApp-API.postman_collection.json \
  -e TestApp-Environments.postman_environment.json \
  --folder "Health Checks"
```

## 📊 Test Scenarios

### ✅ Functional Tests
- **GET /** → Returns "Hello World" (200)
- **GET /health/** → Returns "OK" (200)
- **GET /nonexistent** → Returns 404 error
- **POST /** → Returns 405 method not allowed

### ⚡ Performance Tests
- Response time < 500ms for health checks
- Response time < 1000ms for main endpoint
- Concurrent request handling
- Load testing capabilities

### 🔐 Security Tests
- Security headers validation (X-Frame-Options, X-Content-Type-Options)
- Information disclosure prevention
- Server header analysis

### 🏥 Health Check Tests
- Load balancer compatibility
- Monitoring system integration
- Uptime verification

## 📈 Advanced Usage

### Environment Variables
All environments support these variables:
- `{{base_url}}` - API base URL
- `{{environment}}` - Environment type
- `{{timeout}}` - Request timeout

### Custom Headers
The collection includes:
- `Accept: text/html,application/json`
- `User-Agent: PostmanTestAgent/1.0`

### Pre/Post Scripts
- **Pre-request**: Logs request details and timestamps
- **Post-request**: Logs completion and performance metrics

### Test Automation
```javascript
// Example custom test
pm.test("Custom business logic", function () {
    const response = pm.response.json();
    pm.expect(response.status).to.eql("healthy");
});
```

## 🐛 Troubleshooting

### Common Issues

#### Connection Refused
```
Error: connect ECONNREFUSED 127.0.0.1:8000
```
**Solution**: Ensure the application is running
- Local: `cd testapp && ./start.sh`
- Docker: `docker compose up -d`

#### Timeout Errors
**Solution**: Increase timeout in environment variables or check application performance

#### 404 on All Requests
**Solution**: Verify `base_url` in environment matches your deployment

### Debug Tips
1. Check Postman Console (View → Show Postman Console)
2. Verify environment is selected (top-right dropdown)
3. Test individual requests before running collection
4. Check application logs for server-side issues

## 📋 Test Reports

### HTML Reports (Newman)
```bash
newman run TestApp-API.postman_collection.json \
  -e TestApp-Production.postman_environment.json \
  --reporters html \
  --reporter-html-export testapp-results.html
```

### CI/CD Integration
```yaml
# GitHub Actions example
- name: Run API Tests
  run: |
    newman run TestApp-API.postman_collection.json \
      -e TestApp-Production.postman_environment.json \
      --reporters junit \
      --reporter-junit-export test-results.xml
```

## 🔄 Continuous Testing

### Monitoring Setup
- Import collection into Postman Monitor
- Set up scheduled runs (every 5 minutes)
- Configure alerts for failures
- Track performance trends

### Load Testing
Use collection with tools like:
- **k6**: Convert Postman to k6 script
- **Artillery**: HTTP load testing
- **Newman + cron**: Scheduled testing

This comprehensive test suite ensures your Django TestApp is production-ready across all deployment scenarios! 🚀