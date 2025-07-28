#!/usr/bin/env python3
"""
Setup script for SOPS wrapper dependencies and configuration.
"""

import subprocess
import sys
from pathlib import Path


def install_dependencies():
    """Install required Python dependencies."""
    dependencies = [
        "PyYAML>=6.0",
    ]
    
    print("Installing SOPS wrapper dependencies...")
    for dep in dependencies:
        try:
            subprocess.run([
                sys.executable, "-m", "pip", "install", dep
            ], check=True, capture_output=True)
            print(f"✅ Installed: {dep}")
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to install {dep}: {e}")
            return False
    
    return True


def make_executable():
    """Make the SOPS wrapper script executable."""
    script_path = Path(__file__).parent / "sops_wrapper.py"
    if script_path.exists():
        script_path.chmod(0o755)
        print(f"✅ Made executable: {script_path}")
    else:
        print(f"❌ Script not found: {script_path}")
        return False
    
    return True


def create_symlinks():
    """Create convenient symlinks for the wrapper."""
    script_path = Path(__file__).parent / "sops_wrapper.py"
    
    symlinks = [
        ("sops-encrypt", "encrypt"),
        ("sops-decrypt", "decrypt"),
    ]
    
    for link_name, action in symlinks:
        link_path = Path(__file__).parent / link_name
        
        # Remove existing symlink if it exists
        if link_path.exists() or link_path.is_symlink():
            link_path.unlink()
        
        try:
            # Create a wrapper script instead of symlink for better portability
            wrapper_content = f"""#!/usr/bin/env python3
import sys
from pathlib import Path

# Add the directory containing sops_wrapper.py to Python path
sys.path.insert(0, str(Path(__file__).parent))

# Import and run with predefined action
from sops_wrapper import main
import argparse

# Override sys.argv to include the action
if len(sys.argv) == 1 or sys.argv[1] not in ["encrypt", "decrypt"]:
    sys.argv.insert(1, "{action}")

if __name__ == "__main__":
    main()
"""
            
            with open(link_path, 'w') as f:
                f.write(wrapper_content)
            
            link_path.chmod(0o755)
            print(f"✅ Created wrapper: {link_name}")
            
        except Exception as e:
            print(f"❌ Failed to create wrapper {link_name}: {e}")


def verify_sops():
    """Verify that SOPS is installed."""
    try:
        result = subprocess.run(
            ["sops", "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print(f"✅ SOPS is available: {result.stdout.strip()}")
            return True
        else:
            print("❌ SOPS command failed")
            return False
    except FileNotFoundError:
        print("❌ SOPS is not installed or not in PATH")
        print("   Install SOPS from: https://github.com/mozilla/sops")
        return False
    except subprocess.TimeoutExpired:
        print("❌ SOPS command timed out")
        return False


def main():
    """Main setup function."""
    print("Setting up SOPS Python wrapper...\n")
    
    success = True
    
    # Check SOPS availability
    if not verify_sops():
        print("\n⚠️  Warning: SOPS is not available. The wrapper will not work without it.")
        success = False
    
    print()
    
    # Install dependencies
    if not install_dependencies():
        success = False
    
    print()
    
    # Make script executable
    if not make_executable():
        success = False
    
    print()
    
    # Create convenience wrappers
    create_symlinks()
    
    print()
    
    if success:
        print("✅ Setup completed successfully!")
        print("\nUsage examples:")
        print("  python3 sops_wrapper.py encrypt")
        print("  python3 sops_wrapper.py decrypt")
        print("  ./sops-encrypt --pattern 'secrets/*.dec.yaml'")
        print("  ./sops-decrypt --base-dir /path/to/secrets")
    else:
        print("❌ Setup completed with warnings. Please address the issues above.")
        sys.exit(1)


if __name__ == "__main__":
    main()