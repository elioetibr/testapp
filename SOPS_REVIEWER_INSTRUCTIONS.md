# SOPS GPG Key Instructions for Assessment Reviewer

This document provides instructions for the assessment reviewer to decrypt SOPS-encrypted secrets using the provided GPG key.

## Files Provided

1. `assessment-reviewer-private-key.asc` - Private GPG key (no passphrase required)
2. `assessment-reviewer-public-key.asc` - Public GPG key (for reference)

## Automated Setup (Recommended)

### Single Command Setup

The easiest way to get started is using the automated setup:

```bash
# Complete setup in one command
make reviewer-setup
```

This command will:
1. Install Python dependencies via `uv sync`
2. Import the GPG private key automatically
3. Verify the key was imported correctly
4. Decrypt all SOPS secrets to `secrets/*/secrets.dec.yaml`

### Verify Decrypted Secrets

After running the automated setup, you can access the decrypted secrets:

```bash
# View production secrets
cat secrets/production/secrets.dec.yaml

# View all decrypted environments
ls secrets/*/secrets.dec.yaml
```

## Manual Setup (Alternative)

If you prefer manual setup or the automated setup fails, follow these steps:

### 1. Import the GPG Key

```bash
# Import the private key
gpg --import assessment-reviewer-private-key.asc

# Verify the key was imported
gpg --list-keys "elio+sops@elio.eti.br"
```

### 2. Trust the Key (Optional)

If you encounter trust issues, you can trust the key:

```bash
# Trust the key
echo "E41DE5CC3F04BB4759F2E00794FA699AFBCB48FF:6:" | gpg --import-ownertrust
```

### 3. Install Dependencies

```bash
# Install Python dependencies
uv sync
```

### 4. Decrypt SOPS Files

```bash
# Decrypt using existing make target
make sops-decrypt

# Or manually decrypt specific files
sops --decrypt secrets/production/secrets.enc.yaml
```

## GPG Key Details

- **Key ID:** `E41DE5CC3F04BB4759F2E00794FA699AFBCB48FF`
- **User ID:** TestApp SOPS Assessment Reviewer <elio+sops@elio.eti.br>
- **Type:** RSA 4096-bit
- **Expires:** 2026-08-10
- **Passphrase:** None (no passphrase required)

## Available Secret Files

### Decrypted Content Location
After setup, decrypted secrets are available in:
- `secrets/production/secrets.dec.yaml` - Production secrets
- `secrets/dev/secrets.dec.yaml` - Development secrets  
- `secrets/test/secrets.dec.yaml` - Test secrets
- `secrets/ci/secrets.dec.yaml` - CI secrets
- `secrets/local/secrets.dec.yaml` - Local secrets

### Production Secrets Content
The production secrets include:
- `secret_key`: Django secret key
- `jwt_secret`: JWT signing secret
- `required_setting`: Environment setting
- `api_key`: Placeholder for API key
- `webhook_secret`: Placeholder for webhook secret
- `datadog_api_key`: Placeholder for Datadog API key
- `sentry_dsn`: Placeholder for Sentry DSN

## SOPS Configuration

The project uses two SOPS creation rules in `.sops.yaml`:
1. AWS KMS + GPG for production use
2. GPG-only for assessment reviewer access

```yaml
creation_rules:
  - path_regex: '^secrets/(.*)/secrets\.enc\.ya?ml$'
    kms: 'arn:aws:kms:us-east-1:892193016253:key/af3d21e1-4bd2-470e-ae23-197f64c578be'
    profile: 'eliodevbr-cdk'
  - path_regex: '^secrets/(.*)/secrets\.enc\.ya?ml$'
    pgp: 'E41DE5CC3F04BB4759F2E00794FA699AFBCB48FF'
```

## Troubleshooting

### GPG Agent Issues
If you encounter GPG agent issues:

```bash
# Restart GPG agent
gpg-connect-agent reloadagent /bye

# Or kill and restart
pkill gpg-agent
```

### Decryption Issues
If decryption fails:

```bash
# Check if key is available
gpg --list-secret-keys "elio+sops@elio.eti.br"

# Test manual decryption
sops --decrypt secrets/production/secrets.enc.yaml
```

### Dependencies Issues
If uv is not available:

```bash
# Install uv (if not available)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or use pip fallback (not recommended)
pip install -r requirements.txt
```

## Security Notes

- This GPG key is created specifically for assessment purposes
- The key has no passphrase for convenience during review
- In production, always use passphrases and proper key management
- The key expires in 1 year from creation date

## Clean Up

After assessment, you can remove the key:

```bash
# Remove the key
gpg --delete-secret-keys E41DE5CC3F04BB4759F2E00794FA699AFBCB48FF
gpg --delete-keys E41DE5CC3F04BB4759F2E00794FA699AFBCB48FF

# Remove key files
rm assessment-reviewer-*.asc
```
