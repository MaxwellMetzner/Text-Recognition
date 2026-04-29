#!/usr/bin/env python3
"""
Text Recognition Studio launcher.
Double-click this file to start the Electron application.
"""

import subprocess
import sys
from pathlib import Path


def check_nodejs():
    """Check if Node.js is installed."""
    try:
        result = subprocess.run(['node', '--version'], capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def check_npm():
    """Check if npm is installed."""
    try:
        result = subprocess.run(['npm', '--version'], capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def check_python_packages():
    """Check if required Python packages are installed."""
    packages = {
        'pytesseract': 'pytesseract',
        'easyocr': 'easyocr',
        'paddleocr': 'paddleocr',
        'paddle': 'paddlepaddle',
        'torch': 'torch',
        'PIL': 'Pillow',
        'pillow_heif': 'pillow-heif',
        'cv2': 'opencv-python',
        'pyzbar': 'pyzbar',
        'fitz': 'PyMuPDF',
        'langdetect': 'langdetect',
        'docling': 'docling',
    }
    missing = []

    for module_name, package_name in packages.items():
        try:
            __import__(module_name)
        except ImportError:
            missing.append(package_name)

    return sorted(set(missing))


def show_error(title, message):
    """Show an error message using tkinter or print."""
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(title, message)
        root.destroy()
    except Exception:
        print(f'\nERROR: {title}\n{message}\n')
        input('Press Enter to exit...')


def show_warning(title, message):
    """Show a warning message using tkinter or print."""
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showwarning(title, message)
        root.destroy()
    except Exception:
        print(f'\nWARNING: {title}\n{message}\n')
        input('Press Enter to continue...')


def install_npm_dependencies():
    """Install npm dependencies if node_modules does not exist."""
    script_dir = Path(__file__).parent.absolute()
    project_root = script_dir.parent.parent
    node_modules = project_root / 'node_modules'

    if not node_modules.exists():
        try:
            print('Installing Node.js dependencies...')
            result = subprocess.run(['npm', 'install'], cwd=project_root, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                show_warning('npm Installation', f'npm install had warnings:\n{result.stderr[:500]}')
                return False
            return True
        except subprocess.TimeoutExpired:
            show_error('npm Installation Failed', "npm install took too long. Please run 'npm install' manually.")
            return False
        except Exception as error:
            show_error('npm Installation Failed', f'Could not install dependencies: {error}')
            return False
    return True


def main():
    """Main launcher function."""
    print('\n' + '=' * 60)
    print('  Text Recognition Studio')
    print('=' * 60 + '\n')

    script_dir = Path(__file__).parent.absolute()
    project_root = script_dir.parent.parent

    print('Checking dependencies...')
    if not check_nodejs():
        show_error(
            'Node.js Not Found',
            "Node.js is not installed or not in your PATH.\n\n"
            'Please install Node.js from: https://nodejs.org/\n\n'
            "Make sure to check 'Add to PATH' during installation.",
        )
        return False

    if not check_npm():
        show_error(
            'npm Not Found',
            'npm is not installed or not in your PATH.\n\n'
            'Please reinstall Node.js from: https://nodejs.org/',
        )
        return False

    print('OK: Node.js found')

    missing_packages = check_python_packages()
    if missing_packages:
        show_warning(
            'Missing Python Packages',
            'The following packages are not installed:\n'
            f'{", ".join(missing_packages)}\n\n'
            'Please run: pip install -r requirements.txt\n\n'
            'The app may not work properly without these packages.',
        )
    else:
        print('OK: Python packages found')

    if not install_npm_dependencies():
        return False

    print('OK: All dependencies ready\n')
    print('Starting application...\n')

    try:
        if sys.platform == 'win32':
            create_no_window = 0x08000000
            subprocess.Popen(['npm', 'start'], cwd=project_root, creationflags=create_no_window)
        else:
            subprocess.Popen(['npm', 'start'], cwd=project_root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        print('OK: Application started successfully.')
        print('\nYou can close this window. The app will continue running.')
    except Exception as error:
        show_error(
            'Failed to Start Application',
            f'Could not start the app:\n{error}\n\n'
            "Try running 'npm start' manually in the project directory.",
        )
        return False

    return True


if __name__ == '__main__':
    try:
        success = main()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print('\n\nLauncher cancelled by user.')
        sys.exit(0)
    except Exception as error:
        show_error('Launcher Error', f'An unexpected error occurred:\n{error}')
        sys.exit(1)
