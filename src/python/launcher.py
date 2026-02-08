#!/usr/bin/env python3
"""
Text Recognition App Launcher
Double-click this file to start the application
"""

import subprocess
import sys
import os
from pathlib import Path

def check_nodejs():
    """Check if Node.js is installed"""
    try:
        result = subprocess.run(['node', '--version'], 
                              capture_output=True, 
                              text=True,
                              timeout=5)
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False

def check_npm():
    """Check if npm is installed"""
    try:
        result = subprocess.run(['npm', '--version'], 
                              capture_output=True, 
                              text=True,
                              timeout=5)
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False

def check_python_packages():
    """Check if required Python packages are installed"""
    packages = ['pytesseract', 'easyocr', 'paddleocr', 'torch']
    missing = []
    
    for package in packages:
        try:
            __import__(package)
        except ImportError:
            missing.append(package)
    
    return missing

def show_error(title, message):
    """Show error message using tkinter or print"""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(title, message)
        root.destroy()
    except:
        print(f"\n❌ ERROR: {title}\n{message}\n")
        input("Press Enter to exit...")

def show_warning(title, message):
    """Show warning message using tkinter or print"""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showwarning(title, message)
        root.destroy()
    except:
        print(f"\n⚠️  WARNING: {title}\n{message}\n")
        input("Press Enter to continue...")

def show_info(title, message):
    """Show info message"""
    print(f"\n✓ {title}\n{message}\n")

def install_npm_dependencies():
    """Install npm dependencies if node_modules doesn't exist"""
    # Navigate to the project root (two levels up from src/python/)
    script_dir = Path(__file__).parent.absolute()
    project_root = script_dir.parent.parent
    node_modules = project_root / 'node_modules'
    
    if not node_modules.exists():
        try:
            print("Installing Node.js dependencies (this may take a moment)...")
            result = subprocess.run(['npm', 'install'], 
                                  cwd=project_root,
                                  capture_output=True,
                                  text=True,
                                  timeout=300)
            if result.returncode != 0:
                show_warning("npm Installation", 
                           f"npm install had warnings:\n{result.stderr[:500]}")
                return False
            return True
        except subprocess.TimeoutExpired:
            show_error("npm Installation Failed", 
                      "npm install took too long. Please run 'npm install' manually.")
            return False
        except Exception as e:
            show_error("npm Installation Failed", 
                      f"Could not install dependencies: {str(e)}")
            return False
    return True

def main():
    """Main launcher function"""
    print("\n" + "="*60)
    print("  Advanced Text Recognition App")
    print("="*60 + "\n")
    
    # Navigate to the project root (two levels up from src/python/)
    script_dir = Path(__file__).parent.absolute()
    project_root = script_dir.parent.parent
    
    # Check Node.js
    print("Checking dependencies...")
    if not check_nodejs():
        show_error(
            "Node.js Not Found",
            "Node.js is not installed or not in your PATH.\n\n"
            "Please install Node.js from: https://nodejs.org/\n\n"
            "Make sure to check 'Add to PATH' during installation."
        )
        return False
    
    # Check npm
    if not check_npm():
        show_error(
            "npm Not Found",
            "npm is not installed or not in your PATH.\n\n"
            "Please reinstall Node.js from: https://nodejs.org/"
        )
        return False
    
    print("✓ Node.js found")
    
    # Check Python packages
    missing_packages = check_python_packages()
    if missing_packages:
        show_warning(
            "Missing Python Packages",
            f"The following packages are not installed:\n"
            f"{', '.join(missing_packages)}\n\n"
            f"Please run: pip install -r requirements.txt\n\n"
            f"The app may not work properly without these packages."
        )
    else:
        print("✓ Python packages found")
    
    # Install npm dependencies if needed
    if not install_npm_dependencies():
        return False
    
    print("✓ All dependencies ready\n")
    print("Starting application...\n")
    
    # Start the Electron app
    try:
        # On Windows, hide the console window
        if sys.platform == 'win32':
            CREATE_NO_WINDOW = 0x08000000
            subprocess.Popen(
                ['npm', 'start'],
                cwd=project_root,
                creationflags=CREATE_NO_WINDOW
            )
        else:
            subprocess.Popen(
                ['npm', 'start'],
                cwd=project_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        
        print("✓ Application started successfully!")
        print("\nYou can close this window. The app will continue running.")
        
    except Exception as e:
        show_error(
            "Failed to Start Application",
            f"Could not start the app:\n{str(e)}\n\n"
            f"Try running 'npm start' manually in the project directory."
        )
        return False
    
    return True

if __name__ == '__main__':
    try:
        success = main()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\nLauncher cancelled by user.")
        sys.exit(0)
    except Exception as e:
        show_error("Launcher Error", f"An unexpected error occurred:\n{str(e)}")
        sys.exit(1)
