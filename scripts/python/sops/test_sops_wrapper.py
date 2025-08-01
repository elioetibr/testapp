#!/usr/bin/env python3
"""
Test suite for SOPS wrapper functionality.
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import yaml

# Import the SOPS wrapper (assuming it's in the same directory)
try:
    from sops_wrapper import SOPSWrapper
except ImportError:
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from sops_wrapper import SOPSWrapper


class TestSOPSWrapper(unittest.TestCase):
    """Test cases for SOPS wrapper functionality."""

    def setUp(self):
        """Set up test environment."""
        self.temp_dir = Path(tempfile.mkdtemp())
        self.test_aws_profile = "test-profile"

        # Create test YAML content
        self.test_yaml_content = {
            "secrets": {
                "database_password": "super_secret_password",
                "api_key": "test_api_key_12345"
            },
            "config": {
                "environment": "test"
            }
        }

        # Mock SOPS availability
        self.sops_available_patcher = patch("sops_wrapper.SOPSWrapper._check_sops_available")
        self.mock_sops_available = self.sops_available_patcher.start()
        self.mock_sops_available.return_value = True

    def tearDown(self):
        """Clean up test environment."""
        # Clean up temporary directory
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

        # Stop patchers
        self.sops_available_patcher.stop()

    def create_test_file(self, filename: str, content: dict) -> Path:
        """Create a test YAML file with given content."""
        file_path = self.temp_dir / filename
        with open(file_path, "w") as f:
            yaml.safe_dump(content, f)
        return file_path

    def create_empty_file(self, filename: str) -> Path:
        """Create an empty test file."""
        file_path = self.temp_dir / filename
        file_path.touch()
        return file_path

    def test_initialization(self):
        """Test SOPS wrapper initialization."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)
        self.assertEqual(wrapper.aws_profile, self.test_aws_profile)
        self.assertEqual(wrapper.max_workers, 4)
        self.assertEqual(os.environ.get("AWS_PROFILE"), self.test_aws_profile)

    def test_is_file_not_empty(self):
        """Test file emptiness check."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Test with non-existent file
        non_existent = self.temp_dir / "nonexistent.yaml"
        self.assertFalse(wrapper._is_file_not_empty(non_existent))

        # Test with empty file
        empty_file = self.create_empty_file("empty.yaml")
        self.assertFalse(wrapper._is_file_not_empty(empty_file))

        # Test with non-empty file
        non_empty_file = self.create_test_file("nonempty.yaml", self.test_yaml_content)
        self.assertTrue(wrapper._is_file_not_empty(non_empty_file))

    def test_is_valid_yaml(self):
        """Test YAML validation."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Test with valid YAML
        valid_yaml = self.create_test_file("valid.yaml", self.test_yaml_content)
        self.assertTrue(wrapper._is_valid_yaml(valid_yaml))

        # Test with invalid YAML
        invalid_yaml = self.temp_dir / "invalid.yaml"
        with open(invalid_yaml, "w") as f:
            f.write("invalid: yaml: content: [\n")
        self.assertFalse(wrapper._is_valid_yaml(invalid_yaml))

        # Test with empty file
        empty_file = self.create_empty_file("empty.yaml")
        self.assertFalse(wrapper._is_valid_yaml(empty_file))

    def test_get_file_hash(self):
        """Test file hash calculation."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Test with existing file
        test_file = self.create_test_file("test.yaml", self.test_yaml_content)
        hash1 = wrapper._get_file_hash(test_file)
        self.assertIsNotNone(hash1)
        self.assertEqual(len(hash1), 64)  # SHA256 hex digest length

        # Test with same content should produce same hash
        test_file2 = self.create_test_file("test2.yaml", self.test_yaml_content)
        hash2 = wrapper._get_file_hash(test_file2)
        self.assertEqual(hash1, hash2)

        # Test with non-existent file
        non_existent = self.temp_dir / "nonexistent.yaml"
        hash3 = wrapper._get_file_hash(non_existent)
        self.assertIsNone(hash3)

    def test_should_encrypt_conditions(self):
        """Test encryption decision logic."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Create test files
        dec_file = self.create_test_file("secrets.dec.yaml", self.test_yaml_content)
        enc_file = self.temp_dir / "secrets.enc.yaml"

        # Test: No encrypted file exists
        should_encrypt, reason = wrapper._should_encrypt(dec_file, enc_file)
        self.assertTrue(should_encrypt)
        self.assertEqual(reason, "no encrypted file exists")

        # Test: Empty encrypted file
        self.create_empty_file("secrets.enc.yaml")
        should_encrypt, reason = wrapper._should_encrypt(dec_file, enc_file)
        self.assertTrue(should_encrypt)
        self.assertEqual(reason, "encrypted file is empty")

        # Test: Invalid decrypted file
        empty_dec = self.create_empty_file("empty.dec.yaml")
        should_encrypt, reason = wrapper._should_encrypt(empty_dec, enc_file)
        self.assertFalse(should_encrypt)
        self.assertEqual(reason, "source file is empty or invalid YAML")

    @patch("subprocess.run")
    def test_encrypt_file_success(self, mock_run):
        """Test successful file encryption."""
        # Mock successful SOPS encryption
        mock_run.return_value = Mock(returncode=0, stdout="encrypted_content")

        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        dec_file = self.create_test_file("test.dec.yaml", self.test_yaml_content)
        enc_file = self.temp_dir / "test.enc.yaml"

        result = wrapper._encrypt_file(dec_file, enc_file)

        self.assertTrue(result)
        self.assertTrue(enc_file.exists())
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_encrypt_file_failure(self, mock_run):
        """Test failed file encryption."""
        # Mock failed SOPS encryption
        mock_run.return_value = Mock(returncode=1, stderr="encryption error")

        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        dec_file = self.create_test_file("test.dec.yaml", self.test_yaml_content)
        enc_file = self.temp_dir / "test.enc.yaml"

        result = wrapper._encrypt_file(dec_file, enc_file)

        self.assertFalse(result)
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_decrypt_file_success(self, mock_run):
        """Test successful file decryption."""
        # Mock successful SOPS decryption
        decrypted_yaml = yaml.safe_dump(self.test_yaml_content)
        mock_run.return_value = Mock(returncode=0, stdout=decrypted_yaml)

        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        enc_file = self.create_test_file("test.enc.yaml", {"encrypted": "content"})
        dec_file = self.temp_dir / "test.dec.yaml"

        result = wrapper._decrypt_file(enc_file, dec_file)

        self.assertTrue(result)
        self.assertTrue(dec_file.exists())
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_decrypt_file_failure(self, mock_run):
        """Test failed file decryption."""
        # Mock failed SOPS decryption
        mock_run.return_value = Mock(returncode=1, stderr="decryption error")

        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        enc_file = self.create_test_file("test.enc.yaml", {"encrypted": "content"})
        dec_file = self.temp_dir / "test.dec.yaml"

        result = wrapper._decrypt_file(enc_file, dec_file)

        self.assertFalse(result)
        mock_run.assert_called_once()

    def test_find_files(self):
        """Test file finding functionality."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Create test files
        self.create_test_file("secrets1.dec.yaml", self.test_yaml_content)
        self.create_test_file("secrets2.dec.yaml", self.test_yaml_content)
        self.create_test_file("config.enc.yaml", self.test_yaml_content)
        self.create_test_file("readme.txt", {"not": "yaml"})

        # Find .dec.yaml files
        dec_files = wrapper.find_files("*.dec.yaml", self.temp_dir)
        self.assertEqual(len(dec_files), 2)
        self.assertTrue(all(f.name.endswith(".dec.yaml") for f in dec_files))

        # Find .enc.yaml files
        enc_files = wrapper.find_files("*.enc.yaml", self.temp_dir)
        self.assertEqual(len(enc_files), 1)
        self.assertTrue(enc_files[0].name.endswith(".enc.yaml"))

    @patch("sops_wrapper.SOPSWrapper._encrypt_file")
    @patch("sops_wrapper.SOPSWrapper._should_encrypt")
    def test_encrypt_files(self, mock_should_encrypt, mock_encrypt_file):
        """Test batch file encryption."""
        # Mock encryption decision and execution
        mock_should_encrypt.return_value = (True, "test reason")
        mock_encrypt_file.return_value = True

        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Create test files
        self.create_test_file("secrets1.dec.yaml", self.test_yaml_content)
        self.create_test_file("secrets2.dec.yaml", self.test_yaml_content)

        result = wrapper.encrypt_files("*.dec.yaml", self.temp_dir)

        self.assertEqual(result, 2)
        self.assertEqual(mock_encrypt_file.call_count, 2)

    @patch("sops_wrapper.SOPSWrapper._decrypt_file")
    def test_decrypt_files(self, mock_decrypt_file):
        """Test batch file decryption."""
        # Mock decryption execution
        mock_decrypt_file.return_value = True

        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Create test files
        self.create_test_file("secrets1.enc.yaml", {"encrypted": "content1"})
        self.create_test_file("secrets2.enc.yaml", {"encrypted": "content2"})

        result = wrapper.decrypt_files("*.enc.yaml", self.temp_dir)

        self.assertEqual(result, 2)
        self.assertEqual(mock_decrypt_file.call_count, 2)

    def test_cleanup(self):
        """Test environment cleanup."""
        wrapper = SOPSWrapper(aws_profile=self.test_aws_profile)

        # Verify AWS_PROFILE is set
        self.assertEqual(os.environ.get("AWS_PROFILE"), self.test_aws_profile)

        # Clean up
        wrapper.cleanup()

        # Verify AWS_PROFILE is removed
        self.assertNotEqual(os.environ.get("AWS_PROFILE"), self.test_aws_profile)


class TestSOPSWrapperIntegration(unittest.TestCase):
    """Integration tests that require actual SOPS installation."""

    def setUp(self):
        """Set up integration test environment."""
        # Check if SOPS is actually available
        try:
            import subprocess
            result = subprocess.run(
                ["sops", "--version"],
                capture_output=True,
                timeout=5
            )
            self.sops_available = result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            self.sops_available = False

        if not self.sops_available:
            self.skipTest("SOPS not available for integration tests")

    def test_sops_availability_check(self):
        """Test that SOPS availability check works correctly."""
        wrapper = SOPSWrapper()
        self.assertTrue(wrapper._check_sops_available())


def run_tests():
    """Run all tests."""
    # Create test suite
    suite = unittest.TestSuite()

    # Add unit tests
    suite.addTest(unittest.makeSuite(TestSOPSWrapper))

    # Add integration tests
    suite.addTest(unittest.makeSuite(TestSOPSWrapperIntegration))

    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    exit(0 if success else 1)
