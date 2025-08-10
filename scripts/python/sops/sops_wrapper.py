#!/usr/bin/env python3
"""
SOPS Wrapper - Python utility for encrypting and decrypting secrets with SOPS.

This wrapper provides functionality to:
- Detect changes in decrypted files
- Encrypt only when necessary
- Update keys during encryption or separately
- Ensure no empty encrypted files are generated
- Provide parallel processing for better performance
"""

import argparse
import hashlib
import logging
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml


class SOPSWrapper:
    """Python wrapper for SOPS encryption/decryption operations."""

    def __init__(self, aws_profile: str = "eliodevbr-cdk", max_workers: int = 4):
        """
        Initialize SOPS wrapper.

        Args:
            aws_profile: AWS profile to use for SOPS operations
            max_workers: Maximum number of parallel workers
        """
        self.aws_profile = aws_profile
        self.max_workers = max_workers
        self.logger = self._setup_logging()

        # Set AWS profile
        os.environ["AWS_PROFILE"] = self.aws_profile

        # Verify SOPS is available
        if not self._check_sops_available():
            raise RuntimeError("SOPS is not installed or not in PATH")

    def _setup_logging(self) -> logging.Logger:
        """Set up logging configuration."""
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s - %(levelname)s - %(message)s",
            handlers=[
                logging.StreamHandler(sys.stdout)
            ]
        )
        return logging.getLogger(__name__)

    def _check_sops_available(self) -> bool:
        """Check if SOPS command is available."""
        try:
            result = subprocess.run(
                ["sops", "--version"],
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return False

    def _is_file_not_empty(self, file_path: Path) -> bool:
        """Check if file exists and is not empty."""
        return file_path.exists() and file_path.stat().st_size > 0

    def _is_valid_yaml(self, file_path: Path) -> bool:
        """Validate if file contains valid YAML content."""
        if not self._is_file_not_empty(file_path):
            return False

        try:
            with open(file_path, encoding="utf-8") as f:
                yaml.safe_load(f)
            return True
        except yaml.YAMLError:
            return False

    def _get_file_hash(self, file_path: Path) -> str | None:
        """Get SHA256 hash of file content."""
        if not file_path.exists():
            return None

        try:
            with open(file_path, "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()
        except OSError:
            return None

    def _should_encrypt(self, dec_file: Path, enc_file: Path) -> tuple[bool, str]:
        """
        Determine if file should be encrypted based on various conditions.

        Returns:
            Tuple of (should_encrypt: bool, reason: str)
        """
        # Check if decrypted file is valid
        if not self._is_valid_yaml(dec_file):
            return False, "source file is empty or invalid YAML"

        # No encrypted file exists
        if not enc_file.exists():
            return True, "no encrypted file exists"

        # Encrypted file is empty
        if not self._is_file_not_empty(enc_file):
            return True, "encrypted file is empty"

        # Check if source is newer than encrypted file
        if dec_file.stat().st_mtime > enc_file.stat().st_mtime:
            return True, "source file is newer"

        # Check if content has changed using hash comparison
        dec_hash = self._get_file_hash(dec_file)

        # Try to decrypt and compare with original
        try:
            temp_file = self._decrypt_to_temp(enc_file)
            if temp_file:
                enc_content_hash = self._get_file_hash(temp_file)
                temp_file.unlink()  # Clean up

                if dec_hash != enc_content_hash:
                    return True, "content has changed"
        except Exception:
            # If we can't decrypt for comparison, encrypt to be safe
            return True, "unable to verify encrypted content"

        return False, "no changes detected"

    def _decrypt_to_temp(self, enc_file: Path) -> Path | None:
        """Decrypt file to temporary location for comparison."""
        try:
            with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".yaml") as temp_f:
                temp_path = Path(temp_f.name)

            result = subprocess.run([
                "sops", "--input-type", "yaml", "--output-type", "yaml",
                "-d", str(enc_file)
            ], capture_output=True, text=True, timeout=30)

            if result.returncode == 0:
                with open(temp_path, "w", encoding="utf-8") as f:
                    f.write(result.stdout)
                return temp_path

        except Exception as e:
            self.logger.debug(f"Failed to decrypt {enc_file} for comparison: {e}")

        return None

    def _updatekeys_file(self, enc_file: Path) -> bool:
        """Update keys for an existing encrypted file using SOPS updatekeys."""
        try:
            # Run SOPS updatekeys command
            result = subprocess.run([
                "sops", "updatekeys", "--yes", str(enc_file)
            ], capture_output=True, text=True, timeout=60)

            if result.returncode != 0:
                self.logger.error(f"SOPS updatekeys failed for {enc_file}: {result.stderr}")
                return False

            # Verify encrypted file is still valid and not empty
            if not self._is_file_not_empty(enc_file):
                self.logger.error(f"Updatekeys created empty file: {enc_file}")
                return False

            self.logger.info(f"✅ Successfully updated keys: {enc_file}")
            return True

        except subprocess.TimeoutExpired:
            self.logger.error(f"Updatekeys timeout for {enc_file}")
            return False
        except Exception as e:
            self.logger.error(f"Updatekeys error for {enc_file}: {e}")
            return False

    def _encrypt_file(self, dec_file: Path, enc_file: Path, update_keys: bool = False) -> bool:
        """Encrypt a single file using SOPS."""
        try:
            # Ensure output directory exists
            enc_file.parent.mkdir(parents=True, exist_ok=True)

            # Run SOPS encryption
            result = subprocess.run([
                "sops", "--input-type", "yaml", "--output-type", "yaml",
                "-e", str(dec_file)
            ], capture_output=True, text=True, timeout=60)

            if result.returncode != 0:
                self.logger.error(f"SOPS encryption failed for {dec_file}: {result.stderr}")
                return False

            # Write encrypted content to file
            with open(enc_file, "w", encoding="utf-8") as f:
                f.write(result.stdout)

            # Verify encrypted file was created and is not empty
            if not self._is_file_not_empty(enc_file):
                self.logger.error(f"Encryption created empty file: {enc_file}")
                enc_file.unlink(missing_ok=True)  # Clean up empty file
                return False

            self.logger.info(f"✅ Successfully encrypted: {dec_file} -> {enc_file}")

            # Update keys if requested
            if update_keys:
                self.logger.info(f"Updating keys for: {enc_file}")
                if not self._updatekeys_file(enc_file):
                    self.logger.warning(f"Key update failed for {enc_file}, but encryption was successful")
                    return True  # Encryption was successful even if key update failed

            return True

        except subprocess.TimeoutExpired:
            self.logger.error(f"Encryption timeout for {dec_file}")
            return False
        except Exception as e:
            self.logger.error(f"Encryption error for {dec_file}: {e}")
            return False

    def _decrypt_file(self, enc_file: Path, dec_file: Path) -> bool:
        """Decrypt a single file using SOPS."""
        try:
            # Ensure output directory exists
            dec_file.parent.mkdir(parents=True, exist_ok=True)

            # Run SOPS decryption
            result = subprocess.run([
                "sops", "--input-type", "yaml", "--output-type", "yaml",
                "-d", str(enc_file)
            ], capture_output=True, text=True, timeout=60)

            if result.returncode != 0:
                self.logger.error(f"SOPS decryption failed for {enc_file}: {result.stderr}")
                return False

            # Write decrypted content to file
            with open(dec_file, "w", encoding="utf-8") as f:
                f.write(result.stdout)

            # Verify decrypted file is valid YAML
            if not self._is_valid_yaml(dec_file):
                self.logger.error(f"Decryption created invalid YAML: {dec_file}")
                dec_file.unlink(missing_ok=True)  # Clean up invalid file
                return False

            self.logger.info(f"✅ Successfully decrypted: {enc_file} -> {dec_file}")
            return True

        except subprocess.TimeoutExpired:
            self.logger.error(f"Decryption timeout for {enc_file}")
            return False
        except Exception as e:
            self.logger.error(f"Decryption error for {enc_file}: {e}")
            return False

    def find_files(self, pattern: str, base_dir: Path | None = None) -> list[Path]:
        """Find files matching the given pattern."""
        if base_dir is None:
            base_dir = Path.cwd()

        return sorted(base_dir.rglob(pattern))

    def encrypt_files(self, pattern: str = "*.dec.yaml", base_dir: Path | None = None, update_keys: bool = False) -> int:
        """
        Encrypt all files matching the pattern.

        Args:
            pattern: File pattern to match (default: *.dec.yaml)
            base_dir: Base directory to search (default: current directory)
            update_keys: Whether to update keys after encryption (default: False)

        Returns:
            Number of files successfully encrypted
        """
        dec_files = self.find_files(pattern, base_dir)

        if not dec_files:
            self.logger.info(f"No files found matching pattern: {pattern}")
            return 0

        self.logger.info(f"Found {len(dec_files)} files to process")

        # Process files in parallel
        successful_encryptions = 0

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []

            for dec_file in dec_files:
                # Generate encrypted filename
                enc_filename = dec_file.name.replace(".dec.", ".enc.")
                enc_file = dec_file.parent / enc_filename

                # Check if encryption is needed
                should_encrypt, reason = self._should_encrypt(dec_file, enc_file)

                if should_encrypt:
                    self.logger.info(f"Encrypting: {dec_file} -> {enc_file} ({reason})")
                    future = executor.submit(self._encrypt_file, dec_file, enc_file, update_keys)
                    futures.append(future)
                else:
                    self.logger.info(f"Skipping: {dec_file} ({reason})")

            # Wait for all encryptions to complete
            for future in futures:
                if future.result():
                    successful_encryptions += 1

        self.logger.info(f"Encryption completed. {successful_encryptions}/{len(futures)} files encrypted successfully")
        return successful_encryptions

    def decrypt_files(self, pattern: str = "*.enc.yaml", base_dir: Path | None = None) -> int:
        """
        Decrypt all files matching the pattern.

        Args:
            pattern: File pattern to match (default: *.enc.yaml)
            base_dir: Base directory to search (default: current directory)

        Returns:
            Number of files successfully decrypted
        """
        enc_files = self.find_files(pattern, base_dir)

        if not enc_files:
            self.logger.info(f"No files found matching pattern: {pattern}")
            return 0

        self.logger.info(f"Found {len(enc_files)} files to decrypt")

        # Process files in parallel
        successful_decryptions = 0

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []

            for enc_file in enc_files:
                # Generate decrypted filename
                dec_filename = enc_file.name.replace(".enc.", ".dec.")
                dec_file = enc_file.parent / dec_filename

                self.logger.info(f"Decrypting: {enc_file} -> {dec_file}")
                future = executor.submit(self._decrypt_file, enc_file, dec_file)
                futures.append(future)

            # Wait for all decryptions to complete
            for future in futures:
                if future.result():
                    successful_decryptions += 1

        self.logger.info(f"Decryption completed. {successful_decryptions}/{len(enc_files)} files decrypted successfully")
        return successful_decryptions

    def updatekeys_files(self, pattern: str = "*.enc.yaml", base_dir: Path | None = None) -> int:
        """
        Update keys for all encrypted files matching the pattern.

        Args:
            pattern: File pattern to match (default: *.enc.yaml)
            base_dir: Base directory to search (default: current directory)

        Returns:
            Number of files successfully updated
        """
        enc_files = self.find_files(pattern, base_dir)

        if not enc_files:
            self.logger.info(f"No files found matching pattern: {pattern}")
            return 0

        self.logger.info(f"Found {len(enc_files)} encrypted files to update keys")

        # Process files in parallel
        successful_updates = 0

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []

            for enc_file in enc_files:
                self.logger.info(f"Updating keys: {enc_file}")
                future = executor.submit(self._updatekeys_file, enc_file)
                futures.append(future)

            # Wait for all updates to complete
            for future in futures:
                if future.result():
                    successful_updates += 1

        self.logger.info(f"Key update completed. {successful_updates}/{len(enc_files)} files updated successfully")
        return successful_updates

    def _yaml_to_env_format(self, yaml_content: str, section: str = "act") -> str:
        """Convert YAML content to .env format for GitHub Actions."""
        try:
            data = yaml.safe_load(yaml_content)
            if not isinstance(data, dict):
                raise ValueError("YAML content must be a dictionary")

            env_lines = []

            # Extract the specified section (default: 'act')
            section_data = data.get(section, {})
            if not isinstance(section_data, dict):
                self.logger.warning(f"Section '{section}' not found or not a dictionary, using entire document")
                section_data = data

            # Convert to env format
            for key, value in section_data.items():
                # Convert key to uppercase
                env_key = key.upper()

                # Handle different value types
                if isinstance(value, str | int | float | bool):
                    env_value = str(value)
                elif isinstance(value, list | dict):
                    # For complex types, convert to JSON string
                    import json
                    env_value = json.dumps(value)
                else:
                    env_value = str(value)

                # Quote values that contain spaces or special characters
                if " " in env_value or any(char in env_value for char in ['"', "'", "$", "`", "\\"]):
                    env_value = f'"{env_value}"'

                env_lines.append(f"{env_key}={env_value}")

            return "\n".join(env_lines)

        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML content: {e}")
        except Exception as e:
            raise ValueError(f"Error converting YAML to env format: {e}")

    def to_act_format(self, secrets_file: str, output_file: str = ".act/.secrets", environment: str = "ci") -> bool:
        """Convert SOPS encrypted secrets to .act/.secrets format for GitHub Actions.

        Args:
            secrets_file: Path to encrypted secrets file
            output_file: Output file path (default: .act/.secrets)
            environment: Environment name (default: ci)

        Returns:
            True if conversion successful, False otherwise
        """
        enc_file = Path(secrets_file)

        if not enc_file.exists():
            self.logger.error(f"Encrypted secrets file not found: {enc_file}")
            return False

        try:
            # Decrypt the SOPS file
            self.logger.info(f"Decrypting: {enc_file}")
            result = subprocess.run([
                "sops", "-d", str(enc_file)
            ], capture_output=True, text=True, timeout=60)

            if result.returncode != 0:
                self.logger.error(f"Failed to decrypt {enc_file}: {result.stderr}")
                return False

            decrypted_content = result.stdout
            self.logger.info("Successfully decrypted secrets")

            # Convert YAML to .env format
            self.logger.info("Converting to .env format...")
            env_content = self._yaml_to_env_format(decrypted_content, "act")

            # Create output directory if it doesn't exist
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)

            # Write to output file
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(env_content)

            # Set proper permissions (readable only by owner)
            output_path.chmod(0o600)

            # Count variables for reporting
            var_count = len([line for line in env_content.split("\n") if line.strip() and "=" in line])

            self.logger.info(f"✅ Successfully created {output_file}")
            self.logger.info(f"File contains {var_count} environment variables")

            # Show preview (keys only for security)
            if var_count > 0:
                self.logger.info("Preview (keys only):")
                lines = env_content.split("\n")[:5]
                for line in lines:
                    if line.strip() and "=" in line:
                        key = line.split("=")[0]
                        self.logger.info(f"  {key}=***")

                if var_count > 5:
                    self.logger.info(f"  ... and {var_count - 5} more variables")

            return True

        except subprocess.TimeoutExpired:
            self.logger.error(f"Decryption timeout for {enc_file}")
            return False
        except Exception as e:
            self.logger.error(f"Error converting to act format: {e}")
            return False

    def cleanup(self):
        """Clean up environment variables."""
        if "AWS_PROFILE" in os.environ and os.environ["AWS_PROFILE"] == self.aws_profile:
            del os.environ["AWS_PROFILE"]


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Python SOPS wrapper for encrypting and decrypting secrets",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s encrypt                    # Encrypt all *.dec.yaml files
  %(prog)s encrypt --update-keys      # Encrypt and update keys
  %(prog)s decrypt                    # Decrypt all *.enc.yaml files
  %(prog)s updatekeys                 # Update keys for all *.enc.yaml files
  %(prog)s to-act                     # Convert secrets to .act/.secrets format
  %(prog)s encrypt --pattern "secrets/*.dec.yaml"
  %(prog)s updatekeys --pattern "secrets/*.enc.yaml"
  %(prog)s decrypt --base-dir /path/to/secrets
  %(prog)s to-act --secrets-file secrets/prod/secrets.enc.yaml
  %(prog)s encrypt --max-workers 8   # Use 8 parallel workers
        """
    )

    parser.add_argument(
        "action",
        choices=["encrypt", "decrypt", "updatekeys", "to-act"],
        help="Action to perform"
    )

    parser.add_argument(
        "--pattern",
        default=None,
        help="File pattern to match (default: *.dec.yaml for encrypt, *.enc.yaml for decrypt)"
    )

    parser.add_argument(
        "--secrets-file",
        default="secrets/ci/secrets.enc.yaml",
        help="Path to encrypted secrets file for to-act command (default: secrets/ci/secrets.enc.yaml)"
    )

    parser.add_argument(
        "--output-file",
        default=".act/.secrets",
        help="Output file for to-act command (default: .act/.secrets)"
    )

    parser.add_argument(
        "--environment",
        default="ci",
        help="Environment name for to-act command (default: ci)"
    )

    parser.add_argument(
        "--base-dir",
        type=Path,
        default=None,
        help="Base directory to search (default: current directory)"
    )

    parser.add_argument(
        "--aws-profile",
        default="eliodevbr-cdk",
        help="AWS profile to use (default: eliodevbr-cdk)"
    )

    parser.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Maximum number of parallel workers (default: 4)"
    )

    parser.add_argument(
        "--update-keys",
        action="store_true",
        help="Update keys after encryption (only for encrypt action)"
    )

    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging"
    )

    args = parser.parse_args()

    # Set logging level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Initialize SOPS wrapper
    try:
        sops = SOPSWrapper(aws_profile=args.aws_profile, max_workers=args.max_workers)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        # Determine default pattern based on action
        if args.pattern is None:
            if args.action == "encrypt":
                args.pattern = "*.dec.yaml"
            elif args.action in ["decrypt", "updatekeys"]:
                args.pattern = "*.enc.yaml"

        # Execute action
        if args.action == "encrypt":
            result = sops.encrypt_files(args.pattern, args.base_dir, args.update_keys)
        elif args.action == "decrypt":
            result = sops.decrypt_files(args.pattern, args.base_dir)
        elif args.action == "updatekeys":
            result = sops.updatekeys_files(args.pattern, args.base_dir)
        else:  # to-act
            result = sops.to_act_format(args.secrets_file, args.output_file, args.environment)
            result = 1 if result else 0  # Convert boolean to count for consistency

        # Exit with appropriate code
        sys.exit(0 if result > 0 else 1)

    except KeyboardInterrupt:
        print("\nOperation cancelled by user", file=sys.stderr)
        sys.exit(130)  # Standard exit code for SIGINT
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        sops.cleanup()


if __name__ == "__main__":
    main()
