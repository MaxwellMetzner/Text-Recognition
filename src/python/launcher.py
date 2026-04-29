#!/usr/bin/env python3
"""
Text Recognition Studio launcher.
Double-click this file to start the Electron application.
"""

import subprocess
import sys
from pathlib import Path


def is_runnable_python(python_command):
    """Return whether the provided Python executable can be launched."""
    try:
        result = subprocess.run([str(python_command), '--version'], capture_output=True, text=True, timeout=10)
        return result.returncode == 0
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False


def get_project_venv_python(project_root):
    """Return the expected Python executable inside the project virtual environment."""
    if sys.platform == 'win32':
        return project_root / '.venv' / 'Scripts' / 'python.exe'
    return project_root / '.venv' / 'bin' / 'python'


def summarize_command_output(result, limit=1200):
    """Return the most useful tail of a subprocess result for display."""
    output = (result.stderr or result.stdout or '').strip()
    if len(output) <= limit:
        return output
    return output[-limit:]


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


def ensure_project_python(project_root):
    """Create or repair the project virtual environment when needed."""
    venv_dir = project_root / '.venv'
    venv_python = get_project_venv_python(project_root)
    if is_runnable_python(venv_python):
        return str(venv_python)

    base_python = Path(sys.executable)
    if not is_runnable_python(base_python):
        return None

    try:
        command = [str(base_python), '-m', 'venv']
        if venv_dir.exists():
            print('Repairing project virtual environment...')
            command.append('--clear')
        else:
            print('Creating project virtual environment...')
        command.append(str(venv_dir))

        result = subprocess.run(command, cwd=project_root, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            show_error(
                'Python Environment Failed',
                'Could not create or repair the project virtual environment.\n\n'
                f'{summarize_command_output(result) or "No error details were reported."}',
            )
            return None
    except subprocess.TimeoutExpired:
        show_error(
            'Python Environment Failed',
            'Creating the project virtual environment took too long.\n\n'
            'Try running the launcher again or recreate .venv manually.',
        )
        return None
    except Exception as error:
        show_error('Python Environment Failed', f'Could not create or repair the project virtual environment:\n{error}')
        return None

    return str(venv_python) if is_runnable_python(venv_python) else None


def check_python_packages(python_command):
    """Check if required Python packages are installed in the project environment."""
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
            result = subprocess.run(
                [str(python_command), '-c', f'import {module_name}'],
                capture_output=True,
                text=True,
                timeout=20,
            )
            if result.returncode != 0:
                missing.append(package_name)
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            missing.append(package_name)

    return sorted(set(missing))


def install_python_dependencies(project_root, python_command):
    """Install the project's Python dependencies into the project environment."""
    requirements_path = project_root / 'requirements.txt'
    if not requirements_path.exists():
        show_error(
            'requirements.txt Not Found',
            f'Could not find the project requirements file at:\n{requirements_path}',
        )
        return False

    try:
        print('Installing Python dependencies...')
        result = subprocess.run(
            [str(python_command), '-m', 'pip', 'install', '-r', str(requirements_path)],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=1800,
        )
        if result.returncode != 0:
            show_error(
                'Python Dependency Installation Failed',
                'Could not install the project Python dependencies.\n\n'
                f'{summarize_command_output(result) or "No error details were reported."}',
            )
            return False
    except subprocess.TimeoutExpired:
        show_error(
            'Python Dependency Installation Failed',
            'Installing the project Python dependencies took too long.\n\n'
            'Try running the launcher again once your network is available.',
        )
        return False
    except Exception as error:
        show_error('Python Dependency Installation Failed', f'Could not install Python dependencies:\n{error}')
        return False

    return True


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

    python_command = ensure_project_python(project_root)
    if not python_command:
        return False

    print(f'OK: Using project Python at {python_command}')

    missing_packages = check_python_packages(python_command)
    if missing_packages:
        print(f'Installing missing Python packages: {", ".join(missing_packages)}')
        if not install_python_dependencies(project_root, python_command):
            return False

        remaining_packages = check_python_packages(python_command)
        if remaining_packages:
            show_error(
                'Missing Python Packages',
                'Some required packages are still unavailable after installation:\n'
                f'{", ".join(remaining_packages)}',
            )
            return False

        print('OK: Python packages installed')
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
