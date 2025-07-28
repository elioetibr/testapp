# SOPS Python Wrapper

A comprehensive Python wrapper for Mozilla SOPS (Secrets OPerationS) that provides intelligent encryption and decryption of secrets with change detection and validation.

## Features

- **Smart Change Detection**: Only encrypts files when content has actually changed
- **Empty File Prevention**: Ensures no empty encrypted files are generated
- **Parallel Processing**: Processes multiple files concurrently for better performance
- **GitHub Actions Integration**: Convert encrypted secrets to `.act/.secrets` format
- **YAML Validation**: Validates YAML structure before and after operations
- **Hash-based Comparison**: Uses SHA256 hashes to detect content changes
- **Comprehensive Error Handling**: Robust error handling with detailed logging
- **AWS Profile Support**: Configurable AWS profile for KMS access

## Requirements

- Python 3.8+
- [SOPS](https://github.com/mozilla/sops) installed and in PATH
- PyYAML package
- AWS credentials configured (for KMS-based encryption)

## Installation

1. **Install SOPS** (if not already installed):
   ```bash
   # macOS
   brew install sops
   
   # Linux
   curl -LO https://github.com/mozilla/sops/releases/latest/download/sops-v3.8.1.linux.amd64
   sudo mv sops-v3.8.1.linux.amd64 /usr/local/bin/sops
   sudo chmod +x /usr/local/bin/sops
   ```

2. **Set up the Python wrapper**:
   ```bash
   # Using Make (recommended)
   make sops-setup
   
   # Or directly
   uv run scripts/python/sops/setup_sops_wrapper.py
   ```

   This will:
   - Install required Python dependencies (PyYAML)
   - Make the wrapper script executable
   - Create convenience wrapper scripts (`sops-encrypt`, `sops-decrypt`)

## Usage

### Command Line Interface

#### Basic Usage

```bash
# Using Make targets (recommended)
make sops-encrypt    # Encrypt all *.dec.yaml files
make sops-decrypt    # Decrypt all *.enc.yaml files
make sops-to-act     # Convert secrets to .act/.secrets format

# Or directly
uv run scripts/python/sops/sops_wrapper.py encrypt
uv run scripts/python/sops/sops_wrapper.py decrypt
uv run scripts/python/sops/sops_wrapper.py to-act
```

#### Advanced Usage

```bash
# Using Make with custom patterns
make sops-encrypt-pattern PATTERN="secrets/*.dec.yaml"
make sops-decrypt-pattern PATTERN="config/*.enc.yaml"

# Or directly with full options
uv run scripts/python/sops/sops_wrapper.py encrypt --pattern "secrets/*.dec.yaml"
uv run scripts/python/sops/sops_wrapper.py decrypt --pattern "config/*.enc.yaml"

# Convert to GitHub Actions format
uv run scripts/python/sops/sops_wrapper.py to-act --secrets-file secrets/prod/secrets.enc.yaml
uv run scripts/python/sops/sops_wrapper.py to-act --output-file .act/.prod-secrets

# Specify base directory
uv run scripts/python/sops/sops_wrapper.py encrypt --base-dir /path/to/secrets

# Custom AWS profile
uv run scripts/python/sops/sops_wrapper.py encrypt --aws-profile my-profile

# Adjust parallel workers
uv run scripts/python/sops/sops_wrapper.py encrypt --max-workers 8

# Enable verbose logging
uv run scripts/python/sops/sops_wrapper.py encrypt --verbose
```

#### Command Line Options

```
positional arguments:
  {encrypt,decrypt,to-act}  Action to perform

optional arguments:
  -h, --help            Show help message and exit
  --pattern PATTERN     File pattern to match 
                        (default: *.dec.yaml for encrypt, *.enc.yaml for decrypt)
  --base-dir BASE_DIR   Base directory to search (default: current directory)
  --secrets-file SECRETS_FILE
                        Path to encrypted secrets file for to-act command 
                        (default: secrets/ci/secrets.enc.yaml)
  --output-file OUTPUT_FILE
                        Output file for to-act command (default: .act/.secrets)
  --environment ENVIRONMENT
                        Environment name for to-act command (default: ci)
  --aws-profile AWS_PROFILE
                        AWS profile to use (default: eliodevbr-cdk)
  --max-workers MAX_WORKERS
                        Maximum number of parallel workers (default: 4)
  -v, --verbose         Enable verbose logging
```

### Python API

```python
import sys
from pathlib import Path

# Add the SOPS wrapper to Python path
sys.path.insert(0, str(Path(__file__).parent / "scripts" / "python" / "sops"))
from sops_wrapper import SOPSWrapper

# Initialize wrapper
sops = SOPSWrapper(aws_profile="my-profile", max_workers=4)

# Encrypt files
encrypted_count = sops.encrypt_files("*.dec.yaml", base_dir="/path/to/secrets")

# Decrypt files  
decrypted_count = sops.decrypt_files("*.enc.yaml", base_dir="/path/to/secrets")

# Convert to GitHub Actions format
success = sops.to_act_format("secrets/ci/secrets.enc.yaml", ".act/.secrets")

# Find files matching pattern
files = sops.find_files("secrets*.yaml", base_dir="/path/to/search")

# Clean up
sops.cleanup()
```

## File Naming Convention

The wrapper follows a consistent naming convention:

- **Decrypted files**: `*.dec.yaml` (human-readable secrets)
- **Encrypted files**: `*.enc.yaml` (SOPS-encrypted secrets)

Example:
- `secrets.dec.yaml` → `secrets.enc.yaml`
- `database.dec.yaml` → `database.enc.yaml`

## Smart Encryption Logic

The wrapper only encrypts files when necessary:

1. **No encrypted file exists**: Always encrypt
2. **Encrypted file is empty**: Always encrypt  
3. **Source file is newer**: Encrypt if modification time is newer
4. **Content has changed**: Encrypt if SHA256 hash differs
5. **No changes detected**: Skip encryption

This prevents unnecessary encryption operations and ensures consistency.

## Example Workflow

### 1. Create decrypted secrets file

```yaml
# secrets.dec.yaml
database:
  host: "localhost"
  username: "myuser"
  password: "supersecret"

api:
  key: "api_key_12345"
  secret: "api_secret_67890"
```

### 2. Encrypt the secrets

```bash
# Using Make (recommended)
make sops-encrypt

# Or directly
uv run scripts/python/sops/sops_wrapper.py encrypt
```

### 3. Check encrypted output

```yaml
# secrets.enc.yaml (example - actual output will be different)
database:
  host: ENC[AES256_GCM,data:8/2+OlGT,iv:ABC123...]
  username: ENC[AES256_GCM,data:9kJ2mN,iv:DEF456...]
  password: ENC[AES256_GCM,data:L3kS9P,iv:GHI789...]
# ... SOPS metadata ...
```

### 4. Convert to GitHub Actions format

```bash
# Using Make (recommended)
make sops-to-act

# Or directly
uv run scripts/python/sops/sops_wrapper.py to-act
```

This creates a `.act/.secrets` file in environment variable format:

```
# .act/.secrets
DATABASE_HOST=localhost
DATABASE_USERNAME=myuser
DATABASE_PASSWORD="supersecret"
API_KEY=api_key_12345
API_SECRET=api_secret_67890
```

### 5. Later, decrypt when needed

```bash
# Using Make (recommended)
make sops-decrypt

# Or directly
uv run scripts/python/sops/sops_wrapper.py decrypt
```

## Error Handling

The wrapper provides comprehensive error handling:

- **SOPS not found**: Clear error message with installation instructions
- **AWS credential issues**: Detailed AWS-related error messages
- **Invalid YAML**: Validation before and after operations
- **Empty file detection**: Prevents creation of empty encrypted files
- **Timeout handling**: Configurable timeouts for SOPS operations
- **Parallel execution errors**: Individual file failures don't stop the entire batch

## Testing

Run the comprehensive test suite:

```bash
# Using Make (recommended)
make sops-test

# Or directly
uv run scripts/python/sops/test_sops_wrapper.py

# Run with verbose output
python3 -m pytest scripts/python/sops/test_sops_wrapper.py -v

# Run specific test class
python3 -m unittest scripts.python.sops.test_sops_wrapper.TestSOPSWrapper
```

The test suite includes:
- Unit tests for all core functionality
- Mock-based tests that don't require SOPS
- Integration tests (when SOPS is available)
- Edge case testing
- Error condition testing

## Configuration

### AWS Profile Configuration

The wrapper uses AWS profiles for KMS access. Ensure your AWS credentials are configured:

```bash
# Configure AWS CLI
aws configure --profile eliodevbr-cdk

# Or set environment variables
export AWS_PROFILE=eliodevbr-cdk
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=us-east-1
```

### SOPS Configuration

Create a `.sops.yaml` file in your project root to configure SOPS behavior:

```yaml
# .sops.yaml
creation_rules:
  - path_regex: \.enc\.yaml$
    kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012'
    aws_profile: eliodevbr-cdk
```

## Migration from Shell Scripts

If you're migrating from the existing shell scripts:

### Before (Shell)
```bash
# Old way
./sops-encrypt.sh
./sops-decrypt.sh
./sops-to-act.sh
```

### After (Python + Make)
```bash
# New way - same functionality, better features
make sops-encrypt
make sops-decrypt
make sops-to-act

# Or directly
uv run scripts/python/sops/sops_wrapper.py encrypt
uv run scripts/python/sops/sops_wrapper.py decrypt
uv run scripts/python/sops/sops_wrapper.py to-act
```

## Performance

The Python wrapper provides several performance improvements over shell scripts:

- **Parallel Processing**: Configurable worker threads (default: 4)
- **Smart Change Detection**: Avoids unnecessary encryption operations
- **Efficient File Operations**: Optimized file I/O and hash calculations
- **Reduced SOPS Calls**: Only calls SOPS when necessary

## Troubleshooting

### Common Issues

1. **"SOPS is not installed or not in PATH"**
   - Install SOPS following the installation instructions above
   - Verify with: `sops --version`

2. **"Failed to decrypt: NoCredentialsError"**
   - Configure AWS credentials: `aws configure --profile eliodevbr-cdk`
   - Verify KMS access permissions

3. **"Permission denied"**
   - Make scripts executable: `chmod +x sops_wrapper.py`
   - Check file permissions on secret files

4. **"Invalid YAML"**
   - Validate YAML syntax in your .dec.yaml files
   - Use `yamllint` or online YAML validators

### Debug Mode

Enable verbose logging for troubleshooting:

```bash
uv run scripts/python/sops/sops_wrapper.py encrypt --verbose
```

This will show:
- File discovery process
- Encryption decisions and reasons
- Detailed error messages
- Performance timing information

## Security Considerations

- **Never commit `.dec.yaml` files**: Add them to `.gitignore`
- **Always commit `.enc.yaml` files**: These are safe to store in version control
- **Rotate KMS keys regularly**: Follow AWS KMS best practices
- **Use least privilege**: Grant minimal required KMS permissions
- **Audit access**: Monitor KMS key usage through CloudTrail

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

This project is for assessment purposes only.