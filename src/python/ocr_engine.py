#!/usr/bin/env python3
"""
Local OCR, document parsing, QR/barcode decoding, and CLI pipeline.

The Electron app calls this file as:
    python ocr_engine.py <path> <json options>

The same script also works as a CLI:
    python ocr_engine.py invoice.pdf --mode best --output-style markdown
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from statistics import median
from typing import Any, Callable

os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')

SUPPORTED_IMAGE_EXTENSIONS = {
    '.png',
    '.jpg',
    '.jpeg',
    '.bmp',
    '.tif',
    '.tiff',
    '.webp',
    '.heic',
    '.heif',
}
SUPPORTED_DOCUMENT_EXTENSIONS = {'.pdf'}
SUPPORTED_EXTENSIONS = SUPPORTED_IMAGE_EXTENSIONS | SUPPORTED_DOCUMENT_EXTENSIONS

DEFAULT_PREPROCESSING = {
    'autoRotate': True,
    'upscaleSmallText': True,
    'deskew': True,
    'cropBorders': True,
    'denoise': True,
    'contrast': True,
    'sharpen': False,
    'binarize': False,
    'removeShadows': True,
    'detectPageBoundaries': True,
}

DEFAULT_OPTIONS = {
    'ocrMode': 'best',
    'outputStyle': 'line_breaks',
    'preserveLayout': True,
    'detectCodes': True,
    'mergeCodesIntoText': True,
    'languageMode': 'manual',
    'languages': ['en'],
    'customWords': [],
    'ignoredWords': [],
    'preprocessing': DEFAULT_PREPROCESSING,
    'region': None,
    'pdfDpi': None,
    'maxPages': 100,
    'useDocling': False,
    'recursive': True,
}

LANGUAGE_PRESETS = {
    'en': {'label': 'English', 'paddle': 'en', 'easy': ['en'], 'tesseract': 'eng'},
    'fr': {
        'label': 'French',
        'paddle': 'fr',
        'easy': ['fr', 'en'],
        'tesseract': 'fra+eng',
    },
    'de': {
        'label': 'German',
        'paddle': 'de',
        'easy': ['de', 'en'],
        'tesseract': 'deu+eng',
    },
    'es': {
        'label': 'Spanish',
        'paddle': 'es',
        'easy': ['es', 'en'],
        'tesseract': 'spa+eng',
    },
    'it': {
        'label': 'Italian',
        'paddle': 'it',
        'easy': ['it', 'en'],
        'tesseract': 'ita+eng',
    },
    'pt': {
        'label': 'Portuguese',
        'paddle': 'pt',
        'easy': ['pt', 'en'],
        'tesseract': 'por+eng',
    },
    'nl': {
        'label': 'Dutch',
        'paddle': 'nl',
        'easy': ['nl', 'en'],
        'tesseract': 'nld+eng',
    },
    'pl': {
        'label': 'Polish',
        'paddle': 'pl',
        'easy': ['pl', 'en'],
        'tesseract': 'pol+eng',
    },
    'ru': {
        'label': 'Russian',
        'paddle': 'ru',
        'easy': ['ru', 'en'],
        'tesseract': 'rus+eng',
    },
    'uk': {
        'label': 'Ukrainian',
        'paddle': 'uk',
        'easy': ['uk', 'en'],
        'tesseract': 'ukr+eng',
    },
    'ja': {
        'label': 'Japanese',
        'paddle': 'japan',
        'easy': ['ja', 'en'],
        'tesseract': 'jpn+eng',
    },
    'ko': {
        'label': 'Korean',
        'paddle': 'korean',
        'easy': ['ko', 'en'],
        'tesseract': 'kor+eng',
    },
    'zh': {
        'label': 'Chinese Simplified',
        'paddle': 'ch',
        'easy': ['ch_sim', 'en'],
        'tesseract': 'chi_sim+eng',
    },
    'zh_cht': {
        'label': 'Chinese Traditional',
        'paddle': 'chinese_cht',
        'easy': ['ch_tra', 'en'],
        'tesseract': 'chi_tra+eng',
    },
    'ar': {
        'label': 'Arabic',
        'paddle': 'ar',
        'easy': ['ar', 'en'],
        'tesseract': 'ara+eng',
    },
    'hi': {
        'label': 'Hindi',
        'paddle': 'hi',
        'easy': ['hi', 'en'],
        'tesseract': 'hin+eng',
    },
    'th': {
        'label': 'Thai',
        'paddle': 'th',
        'easy': ['th', 'en'],
        'tesseract': 'tha+eng',
    },
    'el': {
        'label': 'Greek',
        'paddle': 'el',
        'easy': ['el', 'en'],
        'tesseract': 'ell+eng',
    },
    'tr': {
        'label': 'Turkish',
        'paddle': 'tr',
        'easy': ['tr', 'en'],
        'tesseract': 'tur+eng',
    },
    'auto': {'label': 'Auto', 'paddle': 'en', 'easy': ['en'], 'tesseract': 'eng'},
}

EASYOCR_READERS: dict[tuple[Any, ...], Any] = {}
PADDLE_OCR_ENGINES: dict[tuple[Any, ...], Any] = {}


@dataclass
class PreparedPage:
    path: str
    page_number: int
    width: int
    height: int
    source_path: str
    cleanup_actions: list[str]


@lru_cache(maxsize=1)
def check_gpu_availability() -> bool:
    """Check if CUDA is available for GPU acceleration."""
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


def get_package_version(*package_names: str) -> str | None:
    """Return the first available installed package version."""
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:
        return None

    for package_name in package_names:
        try:
            return version(package_name)
        except PackageNotFoundError:
            continue
        except Exception:
            continue
    return None


def base_runtime_check(
    check_id: str,
    label: str,
    probe: str,
    package_names: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        'id': check_id,
        'label': label,
        'probe': probe,
        'version': get_package_version(*package_names) if package_names else None,
        'importable': False,
        'cpuUsable': False,
        'cudaWheel': False,
        'cudaAvailable': False,
        'cudaUsable': False,
        'deviceCount': 0,
        'devices': [],
        'details': [],
    }


def collect_torch_diagnostics() -> dict[str, Any]:
    diagnostics = base_runtime_check(
        'torch', 'PyTorch', 'import + CUDA tensor test', ('torch',)
    )

    try:
        import torch

        diagnostics['importable'] = True
        diagnostics['cpuUsable'] = True
        diagnostics['version'] = diagnostics['version'] or getattr(
            torch, '__version__', None
        )
        build_cuda = getattr(getattr(torch, 'version', None), 'cuda', None)
        diagnostics['cudaWheel'] = bool(build_cuda)
        diagnostics['cudaVersion'] = build_cuda

        try:
            diagnostics['cudaAvailable'] = bool(torch.cuda.is_available())
            diagnostics['deviceCount'] = (
                int(torch.cuda.device_count()) if diagnostics['cudaAvailable'] else 0
            )
        except Exception as error:
            diagnostics['details'].append(f'CUDA availability probe failed: {error}')

        if diagnostics['cudaAvailable']:
            devices = []
            for index in range(diagnostics['deviceCount']):
                try:
                    devices.append(torch.cuda.get_device_name(index))
                except Exception as error:
                    devices.append(f'GPU {index} (name unavailable: {error})')
            diagnostics['devices'] = devices

            try:
                tensor = torch.tensor([1.0], device='cuda')
                diagnostics['cudaUsable'] = abs(float((tensor * 2).item()) - 2.0) < 1e-6
                diagnostics['details'].append('CUDA tensor test passed')
            except Exception as error:
                diagnostics['details'].append(f'CUDA tensor test failed: {error}')
        elif diagnostics['cudaWheel']:
            diagnostics['details'].append(
                'CUDA-enabled wheel installed but no CUDA device is available'
            )
        else:
            diagnostics['details'].append('CPU-only wheel detected')
    except Exception as error:
        diagnostics['error'] = str(error)
        diagnostics['details'].append(f'Import failed: {error}')

    return diagnostics


def collect_paddle_diagnostics() -> dict[str, Any]:
    diagnostics = base_runtime_check(
        'paddle',
        'PaddlePaddle',
        'import + optional GPU tensor test',
        ('paddlepaddle', 'paddlepaddle-gpu'),
    )

    try:
        import paddle

        diagnostics['importable'] = True
        diagnostics['cpuUsable'] = True
        diagnostics['version'] = diagnostics['version'] or getattr(
            paddle, '__version__', None
        )
        compiled_with_cuda = False
        try:
            compiled_with_cuda = bool(paddle.device.is_compiled_with_cuda())
        except Exception as error:
            diagnostics['details'].append(f'CUDA build probe failed: {error}')

        diagnostics['cudaWheel'] = compiled_with_cuda

        if compiled_with_cuda:
            try:
                diagnostics['deviceCount'] = int(paddle.device.cuda.device_count())
            except Exception as error:
                diagnostics['details'].append(f'GPU count probe failed: {error}')

        diagnostics['cudaAvailable'] = (
            diagnostics['cudaWheel'] and diagnostics['deviceCount'] > 0
        )

        if diagnostics['cudaAvailable']:
            previous_device = None
            try:
                previous_device = paddle.get_device()
            except Exception:
                previous_device = None

            diagnostics['devices'] = [
                f'GPU {index}' for index in range(diagnostics['deviceCount'])
            ]
            try:
                paddle.set_device('gpu:0')
                tensor = paddle.to_tensor([1.0], dtype='float32')
                value = float((tensor * 2).numpy()[0])
                diagnostics['cudaUsable'] = abs(value - 2.0) < 1e-6
                diagnostics['details'].append('CUDA tensor test passed')
            except Exception as error:
                diagnostics['details'].append(f'CUDA tensor test failed: {error}')
            finally:
                if previous_device:
                    try:
                        paddle.set_device(previous_device)
                    except Exception:
                        pass
        elif diagnostics['cudaWheel']:
            diagnostics['details'].append(
                'CUDA-enabled wheel installed but no Paddle GPU device is available'
            )
        else:
            diagnostics['details'].append('CPU-only Paddle build detected')
    except Exception as error:
        diagnostics['error'] = str(error)
        diagnostics['details'].append(f'Import failed: {error}')

    return diagnostics


def collect_module_diagnostics(
    check_id: str,
    label: str,
    module_name: str,
    package_names: tuple[str, ...],
    probe: str = 'import',
) -> dict[str, Any]:
    diagnostics = base_runtime_check(check_id, label, probe, package_names)
    try:
        module = __import__(module_name)
        diagnostics['importable'] = True
        diagnostics['cpuUsable'] = True
        diagnostics['version'] = diagnostics['version'] or getattr(
            module, '__version__', None
        )
        diagnostics['details'].append('Import succeeded')
    except Exception as error:
        diagnostics['error'] = str(error)
        diagnostics['details'].append(f'Import failed: {error}')
    return diagnostics


def collect_tesseract_diagnostics() -> dict[str, Any]:
    diagnostics = base_runtime_check(
        'tesseract', 'Tesseract OCR', 'import + binary version probe', ('pytesseract',)
    )
    try:
        import pytesseract

        resolve_tesseract_path()
        diagnostics['importable'] = True
        diagnostics['version'] = diagnostics['version'] or getattr(
            pytesseract, '__version__', None
        )
        version = pytesseract.get_tesseract_version()
        diagnostics['cpuUsable'] = True
        diagnostics['details'].append(f'Binary version: {version}')
        diagnostics['details'].append(
            f'Executable: {pytesseract.pytesseract.tesseract_cmd or "PATH lookup"}'
        )
    except Exception as error:
        diagnostics['error'] = str(error)
        diagnostics['details'].append(f'Tesseract probe failed: {error}')
    return diagnostics


def collect_nvidia_smi_diagnostics() -> dict[str, Any]:
    diagnostics = {
        'available': False,
        'ok': False,
        'gpus': [],
    }

    if not shutil.which('nvidia-smi'):
        diagnostics['error'] = 'nvidia-smi not found'
        return diagnostics

    diagnostics['available'] = True
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader'],
            capture_output=True,
            text=True,
            timeout=8,
        )
        diagnostics['ok'] = result.returncode == 0
        if result.stdout.strip():
            diagnostics['gpus'] = [
                line.strip() for line in result.stdout.splitlines() if line.strip()
            ]
        if result.stderr.strip():
            diagnostics['stderr'] = result.stderr.strip()
        if result.returncode != 0 and not diagnostics.get('stderr'):
            diagnostics['error'] = f'nvidia-smi exited with code {result.returncode}'
    except Exception as error:
        diagnostics['error'] = str(error)

    return diagnostics


def build_environment_summary(checks: list[dict[str, Any]]) -> str:
    if any(check.get('cudaUsable') for check in checks):
        return 'CUDA runtime is usable for at least one installed OCR dependency.'
    if any(check.get('cudaWheel') for check in checks):
        return 'CUDA-capable wheels are installed, but no successful CUDA runtime test completed.'
    if any(check.get('importable') for check in checks):
        return 'OCR dependencies are importable, but the current environment looks CPU-only.'
    return 'Core OCR dependencies are missing or not importable in the selected Python environment.'


def collect_environment_diagnostics() -> dict[str, Any]:
    torch_check = collect_torch_diagnostics()
    paddle_check = collect_paddle_diagnostics()
    easyocr_check = collect_module_diagnostics(
        'easyocr', 'EasyOCR', 'easyocr', ('easyocr',), 'import only'
    )
    paddleocr_check = collect_module_diagnostics(
        'paddleocr', 'PaddleOCR', 'paddleocr', ('paddleocr',), 'import only'
    )
    docling_check = collect_module_diagnostics(
        'docling', 'Docling', 'docling', ('docling',), 'import only'
    )
    pyzbar_check = collect_module_diagnostics(
        'pyzbar', 'pyzbar', 'pyzbar', ('pyzbar',), 'import only'
    )
    torchvision_check = collect_module_diagnostics(
        'torchvision', 'torchvision', 'torchvision', ('torchvision',), 'import only'
    )
    tesseract_check = collect_tesseract_diagnostics()

    if easyocr_check['importable']:
        if torch_check.get('cudaUsable'):
            easyocr_check['details'].append(
                'Torch CUDA runtime is available for EasyOCR'
            )
        elif torch_check.get('cpuUsable'):
            easyocr_check['details'].append(
                'EasyOCR can fall back to CPU through torch'
            )

    if paddleocr_check['importable']:
        if paddle_check.get('cudaUsable'):
            paddleocr_check['details'].append(
                'Paddle CUDA runtime is available for PaddleOCR'
            )
        elif paddle_check.get('cpuUsable'):
            paddleocr_check['details'].append(
                'PaddleOCR can fall back to CPU through PaddlePaddle'
            )

    checks = [
        torch_check,
        torchvision_check,
        paddle_check,
        paddleocr_check,
        easyocr_check,
        tesseract_check,
        pyzbar_check,
        docling_check,
    ]

    return {
        'success': True,
        'summary': build_environment_summary(checks),
        'python': {
            'version': sys.version.split()[0],
            'executable': sys.executable,
            'platform': platform.platform(),
        },
        'system': {
            'nvidiaSmi': collect_nvidia_smi_diagnostics(),
        },
        'checks': checks,
    }


def normalize_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in re.split(r'[\n,;]+', value) if item.strip()]
    if isinstance(value, (list, tuple, set)):
        normalized = []
        for item in value:
            if isinstance(item, str):
                normalized.extend(normalize_string_list(item))
            elif item is not None:
                normalized.append(str(item).strip())
        return [item for item in normalized if item]
    return [str(value).strip()] if str(value).strip() else []


def load_options(raw_options: str | None = None) -> dict[str, Any]:
    """Parse scan options passed from Electron or CLI."""
    options = DEFAULT_OPTIONS.copy()
    options['preprocessing'] = DEFAULT_PREPROCESSING.copy()

    if raw_options:
        try:
            parsed = json.loads(raw_options)
            if isinstance(parsed, dict):
                options.update(parsed)
        except json.JSONDecodeError:
            pass

    mode = str(options.get('ocrMode', 'best')).lower()
    options['ocrMode'] = (
        mode if mode in {'fast', 'balanced', 'best', 'document'} else 'best'
    )

    style = str(options.get('outputStyle', 'paragraphs')).lower()
    allowed_styles = {
        'plain',
        'line_breaks',
        'paragraphs',
        'columns',
        'tables',
        'form_fields',
        'key_values',
        'markdown',
        'json',
    }
    options['outputStyle'] = style if style in allowed_styles else 'paragraphs'

    preprocessing = DEFAULT_PREPROCESSING.copy()
    if isinstance(options.get('preprocessing'), dict):
        preprocessing.update(options['preprocessing'])
    for key in DEFAULT_PREPROCESSING:
        preprocessing[key] = bool(preprocessing.get(key))
    options['preprocessing'] = preprocessing

    options['preserveLayout'] = bool(options.get('preserveLayout', True))
    options['detectCodes'] = bool(options.get('detectCodes', True))
    options['mergeCodesIntoText'] = bool(options.get('mergeCodesIntoText', True))
    options['useDocling'] = bool(options.get('useDocling', False))
    options['recursive'] = bool(options.get('recursive', True))
    options['customWords'] = normalize_string_list(options.get('customWords'))
    options['ignoredWords'] = normalize_string_list(options.get('ignoredWords'))

    languages = normalize_string_list(options.get('languages')) or ['en']
    options['languages'] = [language.lower() for language in languages]
    if str(options.get('languageMode', 'manual')).lower() == 'auto':
        options['languageMode'] = 'auto'
    else:
        options['languageMode'] = 'manual'

    try:
        max_pages = int(options.get('maxPages') or 100)
    except (TypeError, ValueError):
        max_pages = 100
    options['maxPages'] = max(1, min(max_pages, 1000))

    try:
        pdf_dpi = int(options['pdfDpi']) if options.get('pdfDpi') else None
    except (TypeError, ValueError):
        pdf_dpi = None
    options['pdfDpi'] = pdf_dpi

    return options


def resolve_tesseract_path() -> None:
    """Try to locate the Tesseract executable on Windows."""
    try:
        import pytesseract
    except ImportError:
        return

    if sys.platform != 'win32':
        return

    possible_paths = [
        r'C:\Program Files\Tesseract-OCR\tesseract.exe',
        r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
    ]
    for candidate in possible_paths:
        if os.path.exists(candidate):
            pytesseract.pytesseract.tesseract_cmd = candidate
            return


def get_language_codes(options: dict[str, Any]) -> dict[str, Any]:
    selected = options.get('languages') or ['en']
    if options.get('languageMode') == 'auto':
        selected = ['en']

    presets = [LANGUAGE_PRESETS.get(code, LANGUAGE_PRESETS['en']) for code in selected]
    easy_languages: list[str] = []
    tesseract_languages: list[str] = []

    for preset in presets:
        for code in preset['easy']:
            if code not in easy_languages:
                easy_languages.append(code)
        for code in preset['tesseract'].split('+'):
            if code and code not in tesseract_languages:
                tesseract_languages.append(code)

    paddle_lang = presets[0]['paddle'] if presets else 'en'
    if len(selected) > 1:
        latin_codes = {'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'tr'}
        if all(code in latin_codes for code in selected):
            paddle_lang = 'latin'

    return {
        'selected': selected,
        'paddle': paddle_lang,
        'easy': easy_languages or ['en'],
        'tesseract': '+'.join(tesseract_languages or ['eng']),
    }


def decode_bytes(value: Any) -> str:
    """Decode barcode payloads without crashing on mixed encodings."""
    if isinstance(value, bytes):
        for encoding in ('utf-8', 'latin-1'):
            try:
                return value.decode(encoding)
            except UnicodeDecodeError:
                continue
        return value.decode('utf-8', errors='replace')
    return str(value)


def clamp_confidence(value: Any) -> float:
    """Normalize confidence values into a 0-100 percentage."""
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0

    if confidence <= 1:
        confidence *= 100
    return round(max(0.0, min(confidence, 100.0)), 2)


def to_builtin(value: Any) -> Any:
    if hasattr(value, 'tolist'):
        return value.tolist()
    if isinstance(value, dict):
        return {key: to_builtin(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_builtin(item) for item in value]
    return value


def normalize_rect(
    left: float, top: float, right: float, bottom: float
) -> dict[str, float]:
    width = max(0.0, right - left)
    height = max(0.0, bottom - top)
    return {
        'left': round(float(left), 2),
        'top': round(float(top), 2),
        'right': round(float(right), 2),
        'bottom': round(float(bottom), 2),
        'width': round(width, 2),
        'height': round(height, 2),
    }


def normalize_bbox(points: Any) -> dict[str, float]:
    if points is None:
        return normalize_rect(0, 0, 0, 0)

    points = to_builtin(points)
    if isinstance(points, dict):
        left = float(points.get('left', 0))
        top = float(points.get('top', 0))
        width = float(points.get('width', 0))
        height = float(points.get('height', 0))
        return normalize_rect(left, top, left + width, top + height)

    if (
        isinstance(points, (list, tuple))
        and len(points) == 4
        and all(isinstance(item, (int, float)) for item in points)
    ):
        left, top, right, bottom = points
        return normalize_rect(float(left), float(top), float(right), float(bottom))

    normalized_points = []
    if isinstance(points, (list, tuple)):
        for point in points:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                normalized_points.append((float(point[0]), float(point[1])))

    if not normalized_points:
        return normalize_rect(0, 0, 0, 0)

    xs = [point[0] for point in normalized_points]
    ys = [point[1] for point in normalized_points]
    return normalize_rect(min(xs), min(ys), max(xs), max(ys))


def normalize_detection(
    text: Any,
    confidence: Any,
    bbox: Any,
    page: int = 1,
    engine: str = '',
    level: str = 'line',
    source_index: int | None = None,
) -> dict[str, Any] | None:
    clean_text = str(text or '').strip()
    if not clean_text:
        return None

    rect = normalize_bbox(bbox)
    detection = {
        'text': clean_text,
        'confidence': clamp_confidence(confidence),
        'bbox': rect,
        'centerY': rect['top'] + (rect['height'] / 2.0),
        'page': page,
        'engine': engine,
        'level': level,
    }
    if source_index is not None:
        detection['sourceIndex'] = source_index
    return detection


def image_to_cv2(image: Any) -> Any:
    import cv2
    import numpy as np

    rgb = image.convert('RGB')
    return cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)


def cv2_to_pil(image: Any) -> Any:
    import cv2
    from PIL import Image

    if len(image.shape) == 2:
        return Image.fromarray(image)
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


def open_image_with_orientation(path: str) -> Any:
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass

    image = Image.open(path)
    return ImageOps.exif_transpose(image).convert('RGB')


def rotate_bound(
    image: Any, angle: float, border_value: tuple[int, int, int] = (255, 255, 255)
) -> Any:
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    center = (width / 2, height / 2)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos = abs(matrix[0, 0])
    sin = abs(matrix[0, 1])
    new_width = int((height * sin) + (width * cos))
    new_height = int((height * cos) + (width * sin))
    matrix[0, 2] += (new_width / 2) - center[0]
    matrix[1, 2] += (new_height / 2) - center[1]
    return cv2.warpAffine(
        image,
        matrix,
        (new_width, new_height),
        flags=cv2.INTER_CUBIC,
        borderValue=border_value,
    )


def auto_rotate_with_osd(image: Any) -> tuple[Any, str | None]:
    try:
        import cv2
        import pytesseract

        resolve_tesseract_path()
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        osd = pytesseract.image_to_osd(rgb)
        rotation_match = re.search(r'Rotate:\s+(\d+)', osd)
        confidence_match = re.search(r'Orientation confidence:\s+([0-9.]+)', osd)
        if not rotation_match:
            return image, None

        confidence = 0.0
        if confidence_match:
            try:
                confidence = float(confidence_match.group(1))
            except ValueError:
                confidence = 0.0

        rotation = int(rotation_match.group(1))
        if rotation == 0:
            return image, None
        if confidence < 8.0:
            return image, None
        return rotate_bound(image, -rotation), f'rotated {rotation} degrees'
    except Exception:
        return image, None


def order_points(points: Any) -> Any:
    import numpy as np

    rect = np.zeros((4, 2), dtype='float32')
    sums = points.sum(axis=1)
    rect[0] = points[np.argmin(sums)]
    rect[2] = points[np.argmax(sums)]
    diffs = np.diff(points, axis=1)
    rect[1] = points[np.argmin(diffs)]
    rect[3] = points[np.argmax(diffs)]
    return rect


def four_point_transform(image: Any, points: Any) -> Any:
    import cv2
    import numpy as np

    rect = order_points(points)
    top_left, top_right, bottom_right, bottom_left = rect
    width_a = np.linalg.norm(bottom_right - bottom_left)
    width_b = np.linalg.norm(top_right - top_left)
    height_a = np.linalg.norm(top_right - bottom_right)
    height_b = np.linalg.norm(top_left - bottom_left)
    max_width = int(max(width_a, width_b))
    max_height = int(max(height_a, height_b))
    if max_width < 20 or max_height < 20:
        return image

    destination = np.array(
        [
            [0, 0],
            [max_width - 1, 0],
            [max_width - 1, max_height - 1],
            [0, max_height - 1],
        ],
        dtype='float32',
    )
    matrix = cv2.getPerspectiveTransform(rect, destination)
    return cv2.warpPerspective(
        image, matrix, (max_width, max_height), borderValue=(255, 255, 255)
    )


def detect_and_warp_page(image: Any) -> tuple[Any, str | None]:
    try:
        import cv2
        import numpy as np

        ratio = image.shape[0] / 900.0
        resized = (
            cv2.resize(image, (int(image.shape[1] / ratio), 900))
            if image.shape[0] > 900
            else image.copy()
        )
        scale = ratio if image.shape[0] > 900 else 1.0
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(gray, 50, 150)
        edges = cv2.dilate(edges, None, iterations=1)
        contours, _ = cv2.findContours(
            edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            return image, None

        page_area = image.shape[0] * image.shape[1]
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
            perimeter = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
            area = cv2.contourArea(contour) * (scale**2)
            if len(approx) == 4 and area > page_area * 0.15:
                points = approx.reshape(4, 2).astype('float32') * scale
                return four_point_transform(image, points), 'page boundary corrected'

        largest = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(largest)
        x = int(x * scale)
        y = int(y * scale)
        w = int(w * scale)
        h = int(h * scale)
        if w * h > page_area * 0.2:
            pad = 12
            left = max(0, x - pad)
            top = max(0, y - pad)
            right = min(image.shape[1], x + w + pad)
            bottom = min(image.shape[0], y + h + pad)
            return image[top:bottom, left:right], 'page bounds cropped'
    except Exception:
        return image, None

    return image, None


def crop_borders(image: Any) -> tuple[Any, str | None]:
    try:
        import cv2

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 245, 255, cv2.THRESH_BINARY_INV)
        contours, _ = cv2.findContours(
            thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            return image, None
        x, y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))
        page_area = image.shape[0] * image.shape[1]
        if w * h < page_area * 0.08:
            return image, None
        pad = 8
        left = max(0, x - pad)
        top = max(0, y - pad)
        right = min(image.shape[1], x + w + pad)
        bottom = min(image.shape[0], y + h + pad)
        if right - left < image.shape[1] * 0.98 or bottom - top < image.shape[0] * 0.98:
            return image[top:bottom, left:right], 'borders cropped'
    except Exception:
        return image, None
    return image, None


def remove_shadows(image: Any) -> Any:
    import cv2

    planes = cv2.split(image)
    normalized_planes = []
    for plane in planes:
        dilated = cv2.dilate(plane, None, iterations=7)
        background = cv2.medianBlur(dilated, 21)
        diff = 255 - cv2.absdiff(plane, background)
        normalized = cv2.normalize(
            diff, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX
        )
        normalized_planes.append(normalized)
    return cv2.merge(normalized_planes)


def has_uneven_background(image: Any) -> bool:
    import cv2
    import numpy as np

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    min_side = max(3, min(gray.shape[:2]))
    max_kernel = max(3, ((min_side // 2) * 2) - 1)
    kernel_size = min(max(31, int(min_side / 18) | 1), max_kernel)
    background = cv2.medianBlur(gray, kernel_size)
    return float(np.std(background)) > 16.0


def has_visible_noise(image: Any) -> bool:
    import cv2
    import numpy as np

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 180)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    high_frequency = cv2.absdiff(gray, blurred)
    non_edge_pixels = high_frequency[edges == 0]
    if non_edge_pixels.size < 100:
        return False
    return float(np.percentile(non_edge_pixels, 95)) > 7.0


def is_low_contrast(image: Any) -> bool:
    import cv2
    import numpy as np

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    low, high = np.percentile(gray, [5, 95])
    return float(high - low) < 120.0


def improve_contrast(image: Any) -> Any:
    import cv2

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    merged = cv2.merge((clahe.apply(l_channel), a_channel, b_channel))
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def sharpen_image(image: Any) -> Any:
    import cv2

    gaussian = cv2.GaussianBlur(image, (0, 0), 1.2)
    return cv2.addWeighted(image, 1.45, gaussian, -0.45, 0)


def deskew_image(image: Any) -> tuple[Any, str | None]:
    try:
        import cv2
        import numpy as np

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray = cv2.bitwise_not(gray)
        thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
        coordinates = np.column_stack(np.where(thresh > 0))
        if len(coordinates) < 20:
            return image, None
        angle = cv2.minAreaRect(coordinates)[-1]
        if angle < -45:
            angle = -(90 + angle)
        else:
            angle = -angle
        if abs(angle) < 0.35 or abs(angle) > 20:
            return image, None
        return rotate_bound(image, angle), f'deskewed {angle:.2f} degrees'
    except Exception:
        return image, None


def binarize_image(image: Any) -> Any:
    import cv2

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 11
    )


def upscale_for_ocr(image: Any) -> tuple[Any, str | None]:
    import cv2

    height, width = image.shape[:2]
    longest_side = max(width, height)
    if longest_side >= 1800:
        return image, None

    scale = min(2.0, 1800.0 / max(longest_side, 1))
    if scale < 1.15:
        return image, None

    resized = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return resized, f'upscaled {scale:.2f}x'


def add_ocr_border(image: Any, border: int = 12) -> Any:
    import cv2

    value = 255 if len(image.shape) == 2 else (255, 255, 255)
    return cv2.copyMakeBorder(
        image, border, border, border, border, cv2.BORDER_CONSTANT, value=value
    )


def apply_region(image: Any, region: dict[str, Any] | None) -> Any:
    if not region:
        return image

    width, height = image.size
    try:
        x = float(region.get('x', 0))
        y = float(region.get('y', 0))
        region_width = float(region.get('width', 0))
        region_height = float(region.get('height', 0))
        source_width = float(region.get('sourceWidth') or width)
        source_height = float(region.get('sourceHeight') or height)
    except (TypeError, ValueError):
        return image

    if x <= 1 and y <= 1 and region_width <= 1 and region_height <= 1:
        left = int(x * width)
        top = int(y * height)
        right = int((x + region_width) * width)
        bottom = int((y + region_height) * height)
    else:
        scale_x = width / source_width if source_width else 1
        scale_y = height / source_height if source_height else 1
        left = int(x * scale_x)
        top = int(y * scale_y)
        right = int((x + region_width) * scale_x)
        bottom = int((y + region_height) * scale_y)

    left = max(0, min(left, width - 1))
    top = max(0, min(top, height - 1))
    right = max(left + 1, min(right, width))
    bottom = max(top + 1, min(bottom, height))
    return image.crop((left, top, right, bottom))


def preprocess_image(
    path: str, output_path: str, options: dict[str, Any]
) -> PreparedPage:
    import cv2

    page_number = int(options.get('_pageNumber') or 1)
    image = open_image_with_orientation(path)
    image = apply_region(image, options.get('region'))
    cv_image = image_to_cv2(image)
    cleanup = options.get('preprocessing', DEFAULT_PREPROCESSING)
    actions: list[str] = []

    if cleanup.get('autoRotate'):
        cv_image, action = auto_rotate_with_osd(cv_image)
        if action:
            actions.append(action)

    if cleanup.get('detectPageBoundaries'):
        cv_image, action = detect_and_warp_page(cv_image)
        if action:
            actions.append(action)

    if cleanup.get('cropBorders'):
        cv_image, action = crop_borders(cv_image)
        if action:
            actions.append(action)

    if cleanup.get('upscaleSmallText'):
        cv_image, action = upscale_for_ocr(cv_image)
        if action:
            actions.append(action)

    if cleanup.get('removeShadows') and has_uneven_background(cv_image):
        cv_image = remove_shadows(cv_image)
        actions.append('shadows reduced')

    if cleanup.get('denoise') and has_visible_noise(cv_image):
        cv_image = cv2.fastNlMeansDenoisingColored(cv_image, None, 7, 7, 7, 21)
        actions.append('denoised')

    if cleanup.get('contrast') and is_low_contrast(cv_image):
        cv_image = improve_contrast(cv_image)
        actions.append('contrast normalized')

    if cleanup.get('deskew'):
        cv_image, action = deskew_image(cv_image)
        if action:
            actions.append(action)

    if cleanup.get('sharpen'):
        cv_image = sharpen_image(cv_image)
        actions.append('sharpened')

    if cleanup.get('binarize'):
        cv_image = binarize_image(cv_image)
        actions.append('binarized')

    cv_image = add_ocr_border(cv_image)
    pil_image = cv2_to_pil(cv_image)
    pil_image.save(output_path, format='PNG')
    width, height = pil_image.size
    return PreparedPage(
        path=output_path,
        page_number=page_number,
        width=width,
        height=height,
        source_path=path,
        cleanup_actions=actions,
    )


def expand_inputs(paths: list[str], recursive: bool = True) -> list[str]:
    expanded: list[str] = []
    seen: set[str] = set()

    for raw_path in paths:
        if not raw_path:
            continue
        path = Path(raw_path).expanduser()
        if not path.exists():
            continue
        candidates: list[Path]
        if path.is_dir():
            iterator = path.rglob('*') if recursive else path.glob('*')
            candidates = [candidate for candidate in iterator if candidate.is_file()]
        else:
            candidates = [path]

        for candidate in candidates:
            if candidate.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            resolved = str(candidate.resolve())
            if resolved not in seen:
                seen.add(resolved)
                expanded.append(resolved)

    expanded.sort(key=lambda item: item.lower())
    return expanded


def get_pdf_dpi(options: dict[str, Any]) -> int:
    if options.get('pdfDpi'):
        return int(options['pdfDpi'])
    mode = options.get('ocrMode')
    if mode == 'fast':
        return 180
    if mode == 'balanced':
        return 240
    return 300


def render_pdf_pages(
    path: str, temp_dir: str, options: dict[str, Any]
) -> tuple[list[str], str]:
    try:
        import fitz
    except ImportError:
        try:
            import pymupdf as fitz
        except ImportError as error:
            raise RuntimeError(
                'PDF support is unavailable because PyMuPDF is missing in the active Python environment. '
                'Start the app through the launcher or reinstall the project requirements.'
            ) from error

    doc = fitz.open(path)
    rendered_paths: list[str] = []
    text_layer_parts: list[str] = []
    max_pages = min(len(doc), int(options.get('maxPages') or 100))
    dpi = get_pdf_dpi(options)

    for page_index in range(max_pages):
        page = doc[page_index]
        page_text = page.get_text('text').strip()
        if page_text:
            text_layer_parts.append(page_text)
        pixmap = page.get_pixmap(dpi=dpi, alpha=False)
        output_path = os.path.join(temp_dir, f'page_{page_index + 1:04d}.png')
        pixmap.save(output_path)
        rendered_paths.append(output_path)

    doc.close()
    return rendered_paths, '\n\n'.join(text_layer_parts).strip()


def get_easyocr_reader(languages: list[str], use_gpu: bool) -> Any:
    cache_key = (tuple(languages), bool(use_gpu))
    if cache_key not in EASYOCR_READERS:
        import easyocr

        EASYOCR_READERS[cache_key] = easyocr.Reader(languages, gpu=use_gpu)
    return EASYOCR_READERS[cache_key]


@lru_cache(maxsize=1)
def get_docling_converter() -> Any:
    from docling.document_converter import DocumentConverter

    return DocumentConverter()


def get_paddle_ocr(language: str, use_gpu: bool, options: dict[str, Any]) -> Any:
    mode = options.get('ocrMode')
    use_orientation_classify = mode in {'balanced', 'best', 'document'}
    text_det_limit_side_len = 1800 if mode in {'best', 'document'} else 1440
    cache_key = (
        language, bool(use_gpu), use_orientation_classify, text_det_limit_side_len
    )
    if cache_key in PADDLE_OCR_ENGINES:
        return PADDLE_OCR_ENGINES[cache_key]

    from paddleocr import PaddleOCR

    device = 'gpu:0' if use_gpu else 'cpu'
    common_kwargs = {
        'lang': language,
        'ocr_version': 'PP-OCRv5',
        'device': device,
        'use_doc_orientation_classify': use_orientation_classify,
        'use_doc_unwarping': False,
        'use_textline_orientation': True,
        'text_det_limit_side_len': text_det_limit_side_len,
        'text_det_limit_type': 'max',
        'text_det_unclip_ratio': 2.0,
        'text_rec_score_thresh': 0.0,
    }

    if not use_gpu:
        common_kwargs.update(
            {
                'engine': 'paddle_static',
                'engine_config': {
                    'device_type': 'cpu',
                    'cpu_threads': min(8, max(2, os.cpu_count() or 4)),
                    'run_mode': 'paddle',
                },
            }
        )

    attempts = [
        common_kwargs,
        {
            **common_kwargs,
            'use_textline_orientation': False,
        },
        {
            **common_kwargs,
            'use_doc_orientation_classify': False,
            'use_doc_unwarping': False,
        },
        {
            'lang': language,
            'ocr_version': 'PP-OCRv5',
            'device': device,
        },
    ]

    last_error: Exception | None = None
    for kwargs in attempts:
        try:
            engine = PaddleOCR(**kwargs)
            PADDLE_OCR_ENGINES[cache_key] = engine
            return engine
        except Exception as error:
            last_error = error

    raise RuntimeError(f'PaddleOCR could not initialize: {last_error}')


def parse_paddle_predict_results(results: Any, page: int) -> list[dict[str, Any]]:
    detections: list[dict[str, Any]] = []
    results = to_builtin(results)

    if isinstance(results, dict):
        items = [results]
    elif isinstance(results, list):
        items = results
    else:
        return detections

    for item in items:
        if hasattr(item, 'json'):
            json_value = item.json() if callable(item.json) else item.json
            item = to_builtin(json_value)
        if not isinstance(item, dict):
            continue
        data = item.get('res', item)
        texts = data.get('rec_texts') or data.get('texts') or []
        scores = data.get('rec_scores') or data.get('scores') or []
        boxes = (
            data.get('rec_polys') or data.get('rec_boxes') or data.get('dt_polys') or []
        )

        for index, text in enumerate(texts):
            confidence = scores[index] if index < len(scores) else 0
            bbox = boxes[index] if index < len(boxes) else None
            detection = normalize_detection(
                text,
                confidence,
                bbox,
                page=page,
                engine='PaddleOCR',
                level='line',
                source_index=index,
            )
            if detection:
                detections.append(detection)

    return detections


def parse_paddle_ocr_results(results: Any, page: int) -> list[dict[str, Any]]:
    detections: list[dict[str, Any]] = []
    results = to_builtin(results)
    page_results = (
        results[0]
        if isinstance(results, list) and results and isinstance(results[0], list)
        else results
    )

    if not isinstance(page_results, list):
        return detections

    for index, line in enumerate(page_results):
        if not isinstance(line, list) or len(line) < 2:
            continue
        bbox = line[0]
        text_result = line[1]
        if isinstance(text_result, (list, tuple)) and len(text_result) >= 2:
            text = text_result[0]
            confidence = text_result[1]
        else:
            text = text_result
            confidence = 0
        detection = normalize_detection(
            text,
            confidence,
            bbox,
            page=page,
            engine='PaddleOCR',
            level='line',
            source_index=index,
        )
        if detection:
            detections.append(detection)

    return detections


def build_ocr_result(
    text: str,
    detections: list[dict[str, Any]],
    confidence: float,
    method: str,
    options: dict[str, Any],
) -> dict[str, Any] | None:
    rendered_text = text.strip()
    if detections:
        rendered_text = render_detections(
            detections, options, options.get('outputStyle', 'paragraphs')
        )

    if not rendered_text:
        return None

    confidences = [
        item['confidence'] for item in detections if item.get('confidence', 0) > 0
    ]
    average_confidence = (
        sum(confidences) / len(confidences) if confidences else confidence
    )
    return {
        'text': rendered_text,
        'confidence': clamp_confidence(average_confidence),
        'method': method,
        'detections': detections,
        'lineCount': (
            len(split_into_lines(detections))
            if detections
            else len(rendered_text.splitlines())
        ),
    }


def get_tesseract_psm_values(options: dict[str, Any]) -> list[int]:
    mode = options.get('ocrMode')
    if options.get('region'):
        return [6, 7, 13, 11]
    if mode == 'fast':
        return [6, 4, 3, 11]
    if mode == 'balanced':
        return [6, 4, 3, 11]
    return [6, 4, 3, 11, 12]


def get_tesseract_config_variants(
    options: dict[str, Any], psm: int
) -> list[tuple[str, str]]:
    variants = [('', '')]
    if options.get('ocrMode') == 'fast' and psm in {6, 11}:
        variants.append(
            (
                ' -c load_system_dawg=0 -c load_freq_dawg=0',
                'dictionary-light',
            )
        )
    return variants


def build_tesseract_config(
    options: dict[str, Any],
    temp_dir: str | None,
    psm: int,
    extra_config: str = '',
) -> str:
    config = f'--oem 1 --psm {int(psm)} -c user_defined_dpi=300'
    if options.get('preserveLayout'):
        config += ' -c preserve_interword_spaces=1'

    custom_words = options.get('customWords') or []
    if custom_words and temp_dir:
        words_path = os.path.join(temp_dir, 'tesseract_user_words.txt')
        with open(words_path, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(custom_words))
        config += f' --user-words "{words_path}"'
    config += extra_config
    config += ' quiet'
    return config


def should_keep_tesseract_word(text: str, confidence: float) -> bool:
    clean_text = str(text or '').strip()
    if not clean_text:
        return False
    if confidence >= 25:
        return True
    if (
        confidence >= 15
        and len(clean_text) >= 3
        and re.search(r'[A-Za-z0-9]', clean_text)
    ):
        return True
    return False


def extract_tesseract_detections(
    data: dict[str, Any], page: int
) -> list[dict[str, Any]]:
    detections = []
    texts = data.get('text', [])
    for index, text in enumerate(texts):
        try:
            raw_confidence = data.get('conf', ['0'])[index]
            confidence = float(raw_confidence)
            if confidence < 0 or not should_keep_tesseract_word(str(text), confidence):
                continue
        except (TypeError, ValueError, IndexError):
            continue

        detection = normalize_detection(
            text,
            confidence,
            {
                'left': data.get('left', [0])[index],
                'top': data.get('top', [0])[index],
                'width': data.get('width', [0])[index],
                'height': data.get('height', [0])[index],
            },
            page=page,
            engine='Tesseract',
            level='word',
            source_index=index,
        )
        if detection:
            detections.append(detection)
    return detections


def ocr_with_tesseract(
    image_path: str,
    options: dict[str, Any],
    page: int = 1,
    temp_dir: str | None = None,
) -> dict[str, Any] | None:
    try:
        import pytesseract

        resolve_tesseract_path()
        language_codes = get_language_codes(options)
        # Passing the prepared file avoids re-encoding it for every PSM/variant.
        image = os.path.abspath(image_path)
        candidates = []

        for psm in get_tesseract_psm_values(options):
            for extra_config, variant_label in get_tesseract_config_variants(
                options, psm
            ):
                config = build_tesseract_config(options, temp_dir, psm, extra_config)
                method_label = (
                    f'Tesseract OCR (PSM {psm}, {variant_label})'
                    if variant_label
                    else f'Tesseract OCR (PSM {psm})'
                )
                data = pytesseract.image_to_data(
                    image,
                    lang=language_codes['tesseract'],
                    output_type=pytesseract.Output.DICT,
                    config=config,
                )

                detections = extract_tesseract_detections(data, page)
                if detections:
                    result = build_ocr_result('', detections, 0, method_label, options)
                    if result:
                        candidates.append(result)
                        continue

                text = pytesseract.image_to_string(
                    image,
                    lang=language_codes['tesseract'],
                    config=config,
                ).strip()
                result = build_ocr_result(text, [], 0, method_label, options)
                if result:
                    candidates.append(result)

        if not candidates:
            return None
        return max(candidates, key=lambda item: score_ocr_result(item, options))
    except Exception:
        return None


def ocr_with_easyocr(
    image_path: str, options: dict[str, Any], use_gpu: bool, page: int = 1
) -> dict[str, Any] | None:
    try:
        language_codes = get_language_codes(options)
        try:
            reader = get_easyocr_reader(language_codes['easy'], use_gpu)
        except Exception:
            reader = get_easyocr_reader(['en'], use_gpu)

        mode = options.get('ocrMode')
        results = reader.readtext(
            image_path,
            detail=1,
            paragraph=False,
            decoder='beamsearch' if mode in {'best', 'document'} else 'greedy',
            beamWidth=8,
            batch_size=1,
            workers=0,
            contrast_ths=0.05,
            adjust_contrast=0.7,
            text_threshold=0.6,
            low_text=0.3,
            link_threshold=0.4,
            canvas_size=3200,
            mag_ratio=1.5 if mode in {'best', 'document'} else 1.2,
            add_margin=0.08,
        )
        detections = []
        for index, (bbox, text, confidence) in enumerate(results):
            detection = normalize_detection(
                text,
                confidence,
                bbox,
                page=page,
                engine='EasyOCR',
                level='line',
                source_index=index,
            )
            if detection:
                detections.append(detection)

        if not detections:
            return None

        method = 'EasyOCR' + (' (GPU)' if use_gpu else ' (CPU)')
        return build_ocr_result('', detections, 0, method, options)
    except Exception:
        return None


def ocr_with_paddleocr(
    image_path: str, options: dict[str, Any], use_gpu: bool, page: int = 1
) -> dict[str, Any] | None:
    try:
        language_codes = get_language_codes(options)
        ocr = get_paddle_ocr(language_codes['paddle'], use_gpu, options)
        detections: list[dict[str, Any]] = []

        if hasattr(ocr, 'predict'):
            try:
                detections = parse_paddle_predict_results(ocr.predict(image_path), page)
            except Exception:
                detections = []

        if not detections and hasattr(ocr, 'ocr'):
            try:
                detections = parse_paddle_ocr_results(
                    ocr.ocr(image_path, cls=True), page
                )
            except TypeError:
                detections = parse_paddle_ocr_results(ocr.ocr(image_path), page)

        if not detections:
            return None

        method = 'PaddleOCR PP-OCRv5' + (' (GPU)' if use_gpu else ' (CPU)')
        return build_ocr_result('', detections, 0, method, options)
    except Exception:
        return None


def call_docling_export(document: Any, method_name: str, **kwargs: Any) -> str:
    exporter = getattr(document, method_name)
    try:
        return exporter(**kwargs)
    except TypeError:
        return exporter()


def export_docling_text(document: Any, style: str) -> str:
    if style in {'markdown', 'tables', 'document'}:
        return call_docling_export(
            document, 'export_to_markdown', traverse_pictures=True
        )

    try:
        return call_docling_export(document, 'export_to_text', traverse_pictures=True)
    except Exception:
        return call_docling_export(
            document, 'export_to_markdown', traverse_pictures=True
        )


def extract_with_docling(path: str, options: dict[str, Any]) -> dict[str, Any] | None:
    if not (options.get('useDocling') or options.get('ocrMode') == 'document'):
        return None

    try:
        converter = get_docling_converter()
        result = converter.convert(path)
        document = result.document
        text = export_docling_text(document, options.get('outputStyle', 'paragraphs'))

        json_data = None
        for attr in ('export_to_dict', 'model_dump'):
            if hasattr(document, attr):
                try:
                    json_data = getattr(document, attr)()
                    break
                except Exception:
                    pass

        if not text.strip():
            return None
        return {
            'text': text.strip(),
            'confidence': 92.0,
            'method': 'Docling document parser',
            'detections': [],
            'jsonData': to_builtin(json_data) if json_data else None,
        }
    except Exception:
        return None


def split_into_lines(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    usable = [item for item in detections if item and item.get('text')]
    if not usable:
        return []

    pages: dict[int, list[dict[str, Any]]] = {}
    for item in usable:
        pages.setdefault(int(item.get('page') or 1), []).append(item)

    all_lines: list[dict[str, Any]] = []
    for page, page_items in sorted(pages.items()):
        page_items.sort(key=lambda item: (item['centerY'], item['bbox']['left']))
        heights = [
            item['bbox']['height'] for item in page_items if item['bbox']['height'] > 0
        ]
        line_threshold = max(8.0, median(heights) * 0.62) if heights else 12.0
        lines: list[dict[str, Any]] = []

        for detection in page_items:
            placed = False
            for line in lines:
                if abs(detection['centerY'] - line['centerY']) <= line_threshold:
                    line['items'].append(detection)
                    centers = [item['centerY'] for item in line['items']]
                    line['centerY'] = sum(centers) / len(centers)
                    placed = True
                    break

            if not placed:
                lines.append(
                    {
                        'page': page,
                        'centerY': detection['centerY'],
                        'items': [detection],
                    }
                )

        for line in lines:
            line['items'].sort(key=lambda item: item['bbox']['left'])
            line['bbox'] = union_bbox([item['bbox'] for item in line['items']])

        lines.sort(
            key=lambda line: (line['page'], line['bbox']['top'], line['bbox']['left'])
        )
        all_lines.extend(lines)

    return all_lines


def union_bbox(boxes: list[dict[str, float]]) -> dict[str, float]:
    if not boxes:
        return normalize_rect(0, 0, 0, 0)
    return normalize_rect(
        min(box['left'] for box in boxes),
        min(box['top'] for box in boxes),
        max(box['right'] for box in boxes),
        max(box['bottom'] for box in boxes),
    )


def join_line_items(items: list[dict[str, Any]], preserve_layout: bool = True) -> str:
    if not items:
        return ''

    if not preserve_layout:
        return ' '.join(item['text'] for item in items).strip()

    pieces = [items[0]['text']]
    previous = items[0]

    for item in items[1:]:
        gap = item['bbox']['left'] - previous['bbox']['right']
        previous_text_length = max(len(previous['text']), 1)
        char_width = max(previous['bbox']['width'] / previous_text_length, 4.0)
        spaces = 1
        if gap > char_width * 2.5:
            spaces = min(12, max(2, int(round(gap / char_width / 1.8))))
        pieces.append((' ' * spaces) + item['text'])
        previous = item

    return ''.join(pieces).strip()


def lines_with_text(
    detections: list[dict[str, Any]], preserve_layout: bool = True
) -> list[dict[str, Any]]:
    lines = split_into_lines(detections)
    for line in lines:
        line['text'] = join_line_items(line['items'], preserve_layout)
    return [line for line in lines if line['text']]


def is_paragraph_continuation(previous: str, current: str) -> bool:
    if not previous or not current:
        return False
    if previous.endswith('-'):
        return True
    if previous.endswith(('.', '!', '?', ':', ';', '|')):
        return False
    if re.match(r'^[a-z0-9,;:)\]]', current):
        return True
    if len(previous) > 40 and len(current) > 20:
        return True
    return False


def reflow_paragraph_lines(lines: list[dict[str, Any]]) -> str:
    if not lines:
        return ''

    heights = [line['bbox']['height'] for line in lines if line['bbox']['height'] > 0]
    median_height = median(heights) if heights else 18.0
    paragraphs: list[str] = []
    current = ''
    previous_line: dict[str, Any] | None = None

    for line in lines:
        line_text = line['text'].strip()
        if not line_text:
            continue

        gap = 0.0
        if previous_line and previous_line.get('page') == line.get('page'):
            gap = line['bbox']['top'] - previous_line['bbox']['bottom']

        if (
            current
            and previous_line
            and (
                gap > median_height * 1.35
                or not is_paragraph_continuation(current, line_text)
            )
        ):
            paragraphs.append(current.strip())
            current = line_text
        elif current:
            if current.endswith('-'):
                current = current[:-1] + line_text
            else:
                current += ' ' + line_text
        else:
            current = line_text

        previous_line = line

    if current:
        paragraphs.append(current.strip())

    return '\n\n'.join(paragraphs).strip()


def render_line_breaks(
    detections: list[dict[str, Any]], preserve_layout: bool = True
) -> str:
    lines = lines_with_text(detections, preserve_layout)
    if not lines:
        return ''

    heights = [line['bbox']['height'] for line in lines if line['bbox']['height'] > 0]
    median_height = median(heights) if heights else 18.0
    output: list[str] = []
    previous_line: dict[str, Any] | None = None

    for line in lines:
        if previous_line and previous_line.get('page') != line.get('page'):
            output.append('')
            output.append(f'--- Page {line["page"]} ---')
        elif previous_line:
            gap = line['bbox']['top'] - previous_line['bbox']['bottom']
            if gap > median_height * 1.35:
                output.append('')
        elif line.get('page', 1) > 1:
            output.append(f'--- Page {line["page"]} ---')

        output.append(line['text'])
        previous_line = line

    return '\n'.join(output).strip()


def detect_column_groups(lines: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    if len(lines) < 6:
        return [lines]

    groups_by_page: dict[int, list[dict[str, Any]]] = {}
    for line in lines:
        groups_by_page.setdefault(int(line.get('page') or 1), []).append(line)

    ordered_groups: list[list[dict[str, Any]]] = []
    for _page, page_lines in sorted(groups_by_page.items()):
        lefts = sorted(line['bbox']['left'] for line in page_lines)
        gaps = [
            (lefts[index + 1] - lefts[index], index) for index in range(len(lefts) - 1)
        ]
        if not gaps:
            ordered_groups.append(page_lines)
            continue
        widest_gap, split_index = max(gaps)
        page_width = max(line['bbox']['right'] for line in page_lines) - min(
            line['bbox']['left'] for line in page_lines
        )
        if widest_gap < max(80, page_width * 0.18):
            ordered_groups.append(page_lines)
            continue

        split_x = (lefts[split_index] + lefts[split_index + 1]) / 2
        left_column = [line for line in page_lines if line['bbox']['left'] < split_x]
        right_column = [line for line in page_lines if line['bbox']['left'] >= split_x]
        for column in (left_column, right_column):
            if column:
                column.sort(
                    key=lambda line: (line['bbox']['top'], line['bbox']['left'])
                )
                ordered_groups.append(column)

    return ordered_groups or [lines]


def render_columns(detections: list[dict[str, Any]]) -> str:
    lines = lines_with_text(detections, True)
    groups = detect_column_groups(lines)
    sections = []
    for index, group in enumerate(groups):
        if index > 0:
            sections.append('')
        sections.extend(line['text'] for line in group)
    return '\n'.join(sections).strip()


def detect_table_rows_from_lines(lines: list[dict[str, Any]]) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in lines:
        items = line.get('items') or []
        if len(items) >= 2:
            widths = [max(len(item['text']), 1) for item in items]
            gaps = [
                items[index + 1]['bbox']['left'] - items[index]['bbox']['right']
                for index in range(len(items) - 1)
            ]
            char_widths = [
                max(items[index]['bbox']['width'] / widths[index], 4.0)
                for index in range(len(items) - 1)
            ]
            if any(gap > char_widths[index] * 3.2 for index, gap in enumerate(gaps)):
                rows.append([item['text'] for item in items])
                continue

        split_cells = [
            cell.strip()
            for cell in re.split(r'\s{2,}|\t+', line.get('text', ''))
            if cell.strip()
        ]
        if len(split_cells) >= 2:
            rows.append(split_cells)
    return rows


def normalize_table_rows(rows: list[list[str]]) -> list[list[str]]:
    if len(rows) < 2:
        return []
    max_columns = max(len(row) for row in rows)
    if max_columns < 2:
        return []
    normalized = []
    for row in rows:
        padded = row + [''] * (max_columns - len(row))
        normalized.append(padded[:max_columns])
    return normalized


def table_to_markdown(rows: list[list[str]]) -> str:
    rows = normalize_table_rows(rows)
    if not rows:
        return ''
    header = rows[0]
    separator = ['---'] * len(header)
    body = rows[1:]

    def row_to_md(row: list[str]) -> str:
        return '| ' + ' | '.join(cell.replace('|', '\\|') for cell in row) + ' |'

    return '\n'.join(
        [row_to_md(header), row_to_md(separator), *[row_to_md(row) for row in body]]
    )


def extract_tables(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lines = lines_with_text(detections, True)
    tables: list[dict[str, Any]] = []
    current_rows: list[list[str]] = []
    current_page = None

    for line in lines:
        rows = detect_table_rows_from_lines([line])
        if rows:
            if (
                current_page is not None
                and current_page != line.get('page')
                and current_rows
            ):
                normalized = normalize_table_rows(current_rows)
                if normalized:
                    tables.append(
                        {
                            'page': current_page,
                            'rows': normalized,
                            'markdown': table_to_markdown(normalized),
                        }
                    )
                current_rows = []
            current_page = line.get('page', 1)
            current_rows.extend(rows)
        elif current_rows:
            normalized = normalize_table_rows(current_rows)
            if normalized:
                tables.append(
                    {
                        'page': current_page or 1,
                        'rows': normalized,
                        'markdown': table_to_markdown(normalized),
                    }
                )
            current_rows = []
            current_page = None

    if current_rows:
        normalized = normalize_table_rows(current_rows)
        if normalized:
            tables.append(
                {
                    'page': current_page or 1,
                    'rows': normalized,
                    'markdown': table_to_markdown(normalized),
                }
            )

    return tables


def extract_key_values_from_text(text: str) -> list[dict[str, str]]:
    key_values: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or len(line) < 4:
            continue
        match = re.match(r'^(.{2,60}?)(?:\s*[:=]\s*|\s{2,}| - )(.{1,200})$', line)
        if not match:
            continue
        key = match.group(1).strip(' .:-\t')
        value = match.group(2).strip()
        if not key or not value or len(key) > 80:
            continue
        pair = (key.lower(), value.lower())
        if pair in seen:
            continue
        seen.add(pair)
        key_values.append({'key': key, 'value': value})
    return key_values


def extract_form_fields_from_text(text: str) -> list[dict[str, str]]:
    fields: list[dict[str, str]] = []
    for line in text.splitlines():
        clean = line.strip()
        if not clean:
            continue
        checkbox = re.match(r'^(\[[ xX]\]|\([ xX]\)|[☐☑])\s*(.+)$', clean)
        if checkbox:
            marker = checkbox.group(1)
            checked = 'x' in marker.lower() or marker == '☑'
            fields.append(
                {
                    'label': checkbox.group(2).strip(),
                    'value': 'checked' if checked else 'unchecked',
                    'type': 'checkbox',
                }
            )
            continue
        underline = re.match(r'^(.{2,50}?)[\s:]+_{3,}\s*(.*)$', clean)
        if underline:
            fields.append(
                {
                    'label': underline.group(1).strip(),
                    'value': underline.group(2).strip(),
                    'type': 'blank',
                }
            )
    return fields


def render_detections(
    detections: list[dict[str, Any]], options: dict[str, Any], style: str
) -> str:
    if not detections:
        return ''

    preserve_layout = bool(options.get('preserveLayout', True))
    lines = lines_with_text(detections, preserve_layout)

    if style == 'plain':
        return ' '.join(line['text'] for line in lines).strip()
    if style == 'line_breaks':
        return render_line_breaks(detections, preserve_layout)
    if style == 'columns':
        return render_columns(detections)
    if style == 'tables':
        tables = extract_tables(detections)
        if tables:
            return '\n\n'.join(table['markdown'] for table in tables)
        return render_line_breaks(detections, preserve_layout)
    if style == 'key_values':
        text = render_line_breaks(detections, preserve_layout)
        pairs = extract_key_values_from_text(text)
        if pairs:
            return '\n'.join(f'{item["key"]}: {item["value"]}' for item in pairs)
        return text
    if style == 'form_fields':
        text = render_line_breaks(detections, preserve_layout)
        fields = extract_form_fields_from_text(text)
        if fields:
            return '\n'.join(f'{item["label"]}: {item["value"]}' for item in fields)
        return text
    return reflow_paragraph_lines(lines)


def build_code_result(
    code_type: str,
    data: Any,
    bbox: Any = None,
    quality: Any = None,
    source: str = 'Barcode Decoder',
) -> dict[str, Any] | None:
    clean_data = decode_bytes(data).strip()
    if not clean_data:
        return None

    result: dict[str, Any] = {
        'type': code_type,
        'text': clean_data,
        'source': source,
    }
    if bbox is not None:
        result['bbox'] = normalize_bbox(bbox)
    if quality is not None:
        try:
            result['quality'] = float(quality)
        except (TypeError, ValueError):
            pass
    return result


def unique_code_key(code: dict[str, Any]) -> tuple[str, str]:
    return (code.get('type', ''), code.get('text', ''))


def add_code_result(
    collection: list[dict[str, Any]],
    seen: set[tuple[str, str]],
    code: dict[str, Any] | None,
) -> None:
    if not code:
        return
    key = unique_code_key(code)
    if key in seen:
        return
    seen.add(key)
    collection.append(code)


def generate_code_variants(image: Any) -> list[Any]:
    try:
        import cv2
    except ImportError:
        return []

    if image is None:
        return []

    variants = [image]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    variants.append(gray)
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(otsu)

    height, width = gray.shape[:2]
    scale = 2 if max(height, width) < 1400 else 1.35
    resized = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    variants.append(resized)
    return variants


def decode_codes_with_pyzbar(image: Any) -> list[dict[str, Any]]:
    try:
        from pyzbar.pyzbar import decode
    except Exception:
        return []

    codes: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for variant in generate_code_variants(image):
        try:
            results = decode(variant)
        except Exception:
            continue

        for item in results:
            rect = getattr(item, 'rect', None)
            bbox = None
            if rect is not None:
                bbox = {
                    'left': getattr(rect, 'left', 0),
                    'top': getattr(rect, 'top', 0),
                    'width': getattr(rect, 'width', 0),
                    'height': getattr(rect, 'height', 0),
                }
            code = build_code_result(
                getattr(item, 'type', 'UNKNOWN'),
                getattr(item, 'data', ''),
                bbox=bbox,
                quality=getattr(item, 'quality', None),
                source='pyzbar',
            )
            add_code_result(codes, seen, code)
    return codes


def decode_qr_with_opencv(image: Any) -> list[dict[str, Any]]:
    try:
        import cv2
    except ImportError:
        return []

    if image is None:
        return []

    detector = cv2.QRCodeDetector()
    if hasattr(detector, 'setUseAlignmentMarkers'):
        detector.setUseAlignmentMarkers(True)

    codes: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for variant in generate_code_variants(image):
        try:
            multi_result = detector.detectAndDecodeMulti(variant)
        except Exception:
            multi_result = None

        if multi_result and len(multi_result) >= 3 and multi_result[0]:
            decoded_info = multi_result[1] or []
            points = multi_result[2]
            for index, payload in enumerate(decoded_info):
                if not payload:
                    continue
                bbox_points = (
                    points[index]
                    if points is not None and len(points) > index
                    else None
                )
                add_code_result(
                    codes,
                    seen,
                    build_code_result(
                        'QRCODE', payload, bbox=bbox_points, source='OpenCV QR'
                    ),
                )

        try:
            payload, points, _ = detector.detectAndDecode(variant)
        except Exception:
            payload, points = '', None
        add_code_result(
            codes,
            seen,
            build_code_result('QRCODE', payload, bbox=points, source='OpenCV QR'),
        )
    return codes


def detect_codes(image_path: str, page: int = 1) -> list[dict[str, Any]]:
    try:
        import cv2
    except ImportError:
        return []

    image = cv2.imread(image_path)
    if image is None:
        return []

    seen: set[tuple[str, str]] = set()
    codes: list[dict[str, Any]] = []
    for code in decode_codes_with_pyzbar(image):
        code['page'] = page
        add_code_result(codes, seen, code)
    for code in decode_qr_with_opencv(image):
        code['page'] = page
        add_code_result(codes, seen, code)

    codes.sort(
        key=lambda item: (
            item.get('page', 1),
            item.get('type', ''),
            item.get('text', ''),
        )
    )
    return codes


def score_ocr_result(result: dict[str, Any] | None, options: dict[str, Any]) -> float:
    if not result or not result.get('text'):
        return -math.inf

    text = result.get('text', '')
    confidence = float(result.get('confidence') or 0)
    detections = result.get('detections') or []
    detection_count = len(detections)
    line_bonus = min(result.get('lineCount', 0), 15) * (
        1.2 if options.get('preserveLayout') else 0.4
    )
    length_bonus = min(len(text) / 30.0, 20.0)
    structure_bonus = min(detection_count / 6.0, 10.0)
    replacement_penalty = text.count('\ufffd') * 8.0
    symbol_count = len(re.findall(r'[^\w\s.,;:!?\'"()/#@%&+$=\-\[\]{}<>|\\]', text))
    symbol_penalty = min(symbol_count * 1.5, 20.0)
    low_confidence_count = sum(
        1 for item in detections if float(item.get('confidence') or 0) < 45
    )
    low_confidence_penalty = (
        min((low_confidence_count / max(detection_count, 1)) * 18.0, 18.0)
        if detections
        else 0.0
    )
    very_short_penalty = 12.0 if len(text.strip()) < 8 else 0.0
    return (
        confidence
        + line_bonus
        + length_bonus
        + structure_bonus
        - replacement_penalty
        - symbol_penalty
        - low_confidence_penalty
        - very_short_penalty
    )


def fast_result_needs_fallback(result: dict[str, Any] | None) -> bool:
    if not result or not result.get('text', '').strip():
        return True

    text = result.get('text', '')
    confidence = float(result.get('confidence') or 0)
    detections = result.get('detections') or []
    weird_symbols = len(re.findall(r'[^\w\s.,;:!?\'"()/#@%&+$=\-\[\]{}<>|\\]', text))
    low_confidence_count = sum(
        1 for item in detections if float(item.get('confidence') or 0) < 45
    )
    low_confidence_ratio = low_confidence_count / max(len(detections), 1)

    if confidence < 85:
        return True
    if len(text.strip()) < 20:
        return True
    if weird_symbols > max(8, len(text) * 0.06):
        return True
    if detections and low_confidence_ratio > 0.35:
        return True
    return False


def run_ocr_on_page(
    page: PreparedPage, options: dict[str, Any], has_gpu: bool, temp_dir: str
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    mode = options.get('ocrMode')
    runners: list[Callable[[], dict[str, Any] | None]]

    if mode == 'fast':
        tesseract_result = ocr_with_tesseract(
            page.path, options, page.page_number, temp_dir
        )
        results = [tesseract_result] if tesseract_result else []
        if fast_result_needs_fallback(tesseract_result):
            paddle_result = ocr_with_paddleocr(
                page.path, options, has_gpu, page.page_number
            )
            if paddle_result:
                results.append(paddle_result)

        if not results:
            return None, []
        best_result = max(results, key=lambda item: score_ocr_result(item, options))
        return best_result, results
    elif mode == 'balanced':
        runners = [
            lambda: ocr_with_tesseract(page.path, options, page.page_number, temp_dir),
            lambda: ocr_with_paddleocr(page.path, options, has_gpu, page.page_number),
        ]
    else:
        runners = [
            lambda: ocr_with_tesseract(page.path, options, page.page_number, temp_dir),
            lambda: ocr_with_paddleocr(page.path, options, has_gpu, page.page_number),
            lambda: ocr_with_easyocr(page.path, options, has_gpu, page.page_number),
        ]

    results = []
    for runner in runners:
        result = runner()
        if result:
            results.append(result)

    if not results:
        return None, []
    best_result = max(results, key=lambda item: score_ocr_result(item, options))
    return best_result, results


def detect_language_from_text(text: str) -> dict[str, Any] | None:
    clean = re.sub(r'\s+', ' ', text).strip()
    if len(clean) < 20:
        return None
    try:
        from langdetect import detect_langs

        guesses = detect_langs(clean[:4000])
        if not guesses:
            return None
        best = guesses[0]
        return {
            'language': best.lang,
            'confidence': round(float(best.prob) * 100, 2),
            'source': 'langdetect',
        }
    except Exception:
        pass

    if re.search(r'[\u4e00-\u9fff]', clean):
        return {'language': 'zh', 'confidence': 70.0, 'source': 'script heuristic'}
    if re.search(r'[\u3040-\u30ff]', clean):
        return {'language': 'ja', 'confidence': 70.0, 'source': 'script heuristic'}
    if re.search(r'[\u0600-\u06ff]', clean):
        return {'language': 'ar', 'confidence': 70.0, 'source': 'script heuristic'}
    if re.search(r'[\u0400-\u04ff]', clean):
        return {'language': 'ru/uk', 'confidence': 65.0, 'source': 'script heuristic'}
    return {'language': 'unknown', 'confidence': 0.0, 'source': 'none'}


def word_is_ignored(word: str, ignored_words: set[str], custom_words: set[str]) -> bool:
    clean = re.sub(r'^\W+|\W+$', '', word).lower()
    return not clean or clean in ignored_words or clean in custom_words


def analyze_warnings(
    detections: list[dict[str, Any]],
    text: str,
    options: dict[str, Any],
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    ignored_words = {word.lower() for word in options.get('ignoredWords') or []}
    custom_words = {word.lower() for word in options.get('customWords') or []}
    seen: set[tuple[str, str]] = set()

    def add_warning(
        kind: str,
        message: str,
        severity: str = 'medium',
        sample: str = '',
        bbox: Any = None,
        page: int | None = None,
    ) -> None:
        key = (kind, sample or message)
        if key in seen:
            return
        seen.add(key)
        item: dict[str, Any] = {'type': kind, 'message': message, 'severity': severity}
        if sample:
            item['sample'] = sample
        if bbox:
            item['bbox'] = bbox
        if page:
            item['page'] = page
        warnings.append(item)

    for detection in detections:
        sample = detection.get('text', '')
        confidence = float(detection.get('confidence') or 0)
        words = re.findall(r"[\w'|]+", sample)
        if (
            confidence
            and confidence < 60
            and not all(
                word_is_ignored(word, ignored_words, custom_words) for word in words
            )
        ):
            add_warning(
                'low_confidence',
                f'Low-confidence OCR near "{sample[:60]}"',
                'high' if confidence < 40 else 'medium',
                sample=sample,
                bbox=detection.get('bbox'),
                page=detection.get('page'),
            )

        if re.search(r'[�□■¤§]{1,}|[^\w\s.,;:!?\'"()/#@%&+$=\-\[\]{}<>|\\]', sample):
            add_warning(
                'weird_symbols',
                'Unexpected symbols may be OCR noise',
                'medium',
                sample=sample,
                bbox=detection.get('bbox'),
                page=detection.get('page'),
            )

        for word in words:
            if word_is_ignored(word, ignored_words, custom_words):
                continue
            if re.search(r'[A-Za-z]0[A-Za-z]', word) or re.search(r'\dO\d', word):
                add_warning(
                    'confusable',
                    'Possible 0/O OCR confusion',
                    'medium',
                    sample=word,
                    bbox=detection.get('bbox'),
                    page=detection.get('page'),
                )
            if re.search(r'\d[lI|]\d', word) or re.search(
                r'[A-Za-z][1|][A-Za-z]', word
            ):
                add_warning(
                    'confusable',
                    'Possible 1/l/I/| OCR confusion',
                    'medium',
                    sample=word,
                    bbox=detection.get('bbox'),
                    page=detection.get('page'),
                )
            if 'rn' in word and len(word) > 4:
                add_warning(
                    'confusable',
                    'Possible rn/m OCR confusion',
                    'low',
                    sample=word,
                    bbox=detection.get('bbox'),
                    page=detection.get('page'),
                )

    lines = (
        [
            line.strip()
            for line in render_line_breaks(detections, True).splitlines()
            if line.strip()
        ]
        if detections
        else [line.strip() for line in text.splitlines() if line.strip()]
    )
    for index, line in enumerate(lines[:-1]):
        next_line = lines[index + 1]
        if (
            len(line) > 50
            and not re.search(r'[.!?:;,"\')\]]$', line)
            and re.match(r'^[A-Z]', next_line)
        ):
            add_warning(
                'missing_punctuation',
                'Line may be missing punctuation before the next sentence',
                'low',
                sample=line[:80],
            )
        if line.endswith('-') or (
            line and next_line and line[-1].islower() and next_line[0].islower()
        ):
            add_warning(
                'broken_wrapping',
                'Line wrapping may need reflow',
                'low',
                sample=f'{line[:45]} / {next_line[:45]}',
            )

    warnings.sort(
        key=lambda item: {'high': 0, 'medium': 1, 'low': 2}.get(item['severity'], 3)
    )
    return warnings[:200]


def compose_codes_text(codes: list[dict[str, Any]]) -> str:
    if not codes:
        return ''
    return '\n'.join(
        f'{code.get("type", "CODE")}: {code.get("text", "")}' for code in codes
    )


def build_markdown(
    text: str,
    codes: list[dict[str, Any]],
    tables: list[dict[str, Any]],
    key_values: list[dict[str, str]],
    form_fields: list[dict[str, str]],
) -> str:
    sections: list[str] = []
    if codes:
        sections.append(
            '## Detected Codes\n\n'
            + '\n'.join(
                f'- **{code.get("type", "CODE")}**: `{code.get("text", "")}`'
                for code in codes
            )
        )
    if key_values:
        sections.append(
            '## Key-Value Pairs\n\n'
            + '\n'.join(f'- **{item["key"]}**: {item["value"]}' for item in key_values)
        )
    if form_fields:
        sections.append(
            '## Form Fields\n\n'
            + '\n'.join(
                f'- **{item["label"]}**: {item["value"]}' for item in form_fields
            )
        )
    if tables:
        sections.append(
            '## Tables\n\n'
            + '\n\n'.join(
                table['markdown'] for table in tables if table.get('markdown')
            )
        )
    if text:
        sections.append('## Text\n\n' + text)
    return '\n\n'.join(sections).strip()


def nonempty_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def docling_text_is_flattened(docling_text: str, ocr_text: str, style: str) -> bool:
    if style != 'line_breaks' or not docling_text.strip() or not ocr_text.strip():
        return False

    docling_lines = nonempty_lines(docling_text)
    ocr_lines = nonempty_lines(ocr_text)
    if len(ocr_lines) < 3:
        return False

    longest_docling_line = max((len(line) for line in docling_lines), default=0)
    if len(docling_lines) <= 1 and len(ocr_lines) > 1:
        return True
    if longest_docling_line > 160 and len(ocr_lines) > len(docling_lines):
        return True
    return False


def finalize_result(
    source_path: str,
    options: dict[str, Any],
    page_results: list[dict[str, Any]],
    all_candidates: list[dict[str, Any]],
    codes: list[dict[str, Any]],
    text_layer: str = '',
    docling_result: dict[str, Any] | None = None,
    cleanup_actions: list[str] | None = None,
) -> dict[str, Any]:
    detections: list[dict[str, Any]] = []
    for result in page_results:
        detections.extend(result.get('detections') or [])

    style = options.get('outputStyle', 'paragraphs')
    rendered_text = render_detections(detections, options, style) if detections else ''
    if not rendered_text:
        rendered_text = '\n\n'.join(
            result.get('text', '').strip()
            for result in page_results
            if result.get('text', '').strip()
        )
    if not rendered_text and text_layer:
        rendered_text = text_layer

    method = 'No OCR'
    confidence = 0.0
    if page_results:
        confidences = [
            float(result.get('confidence') or 0)
            for result in page_results
            if result.get('confidence') is not None
        ]
        confidence = (
            round(sum(confidences) / len(confidences), 2) if confidences else 0.0
        )
        methods = []
        for result in page_results:
            if result.get('method') and result['method'] not in methods:
                methods.append(result['method'])
        method = ', '.join(methods[:3]) if methods else method

    if text_layer and (not rendered_text or options.get('ocrMode') == 'fast'):
        rendered_text = text_layer
        method = (
            'PDF text layer' if method == 'No OCR' else f'{method} + PDF text layer'
        )
        confidence = max(confidence, 100.0)

    if docling_result and (
        options.get('ocrMode') == 'document' or style in {'markdown', 'tables'}
    ):
        if docling_text_is_flattened(docling_result['text'], rendered_text, style):
            method = f'{docling_result["method"]} + OCR line layout'
        else:
            rendered_text = docling_result['text']
            method = docling_result['method']
        confidence = max(confidence, float(docling_result.get('confidence') or 0))

    tables = extract_tables(detections)
    key_value_text = (
        rendered_text if rendered_text else render_line_breaks(detections, True)
    )
    key_values = extract_key_values_from_text(key_value_text)
    form_fields = extract_form_fields_from_text(key_value_text)
    markdown = build_markdown(rendered_text, codes, tables, key_values, form_fields)

    final_text = rendered_text.strip()
    if (
        codes
        and options.get('mergeCodesIntoText')
        and style not in {'json', 'markdown'}
    ):
        codes_block = 'Detected Codes\n' + compose_codes_text(codes)
        final_text = codes_block + (
            ('\n\nExtracted Text\n' + final_text) if final_text else ''
        )

    json_data = {
        'sourcePath': source_path,
        'text': rendered_text,
        'codes': codes,
        'tables': tables,
        'keyValues': key_values,
        'formFields': form_fields,
        'detections': detections,
        'confidence': confidence,
        'method': method,
        'cleanupActions': cleanup_actions or [],
        'language': detect_language_from_text(rendered_text),
    }

    if docling_result and docling_result.get('jsonData'):
        json_data['docling'] = docling_result['jsonData']

    if style == 'markdown':
        final_text = markdown
    elif style == 'json':
        final_text = json.dumps(json_data, ensure_ascii=False, indent=2)

    warnings = analyze_warnings(detections, rendered_text, options)
    available_engines = []
    for result in all_candidates:
        if result.get('method') and result['method'] not in available_engines:
            available_engines.append(result['method'])
    if docling_result and docling_result['method'] not in available_engines:
        available_engines.append(docling_result['method'])
    if text_layer and 'PDF text layer' not in available_engines:
        available_engines.append('PDF text layer')

    success = bool(final_text.strip() or codes)
    if not success:
        return {
            'error': 'No text, QR codes, or barcodes could be detected',
            'success': False,
            'sourcePath': source_path,
            'options': options,
        }

    return {
        'text': final_text.strip(),
        'ocrText': rendered_text.strip(),
        'markdown': markdown,
        'jsonData': json_data,
        'codes': codes,
        'tables': tables,
        'keyValues': key_values,
        'formFields': form_fields,
        'warnings': warnings,
        'confidence': confidence,
        'method': method if rendered_text else 'Code Detection Only',
        'availableEngines': available_engines,
        'language': json_data['language'],
        'cleanupActions': cleanup_actions or [],
        'pageCount': max([item.get('page', 1) for item in detections] or [1]),
        'charCount': len(final_text.strip()),
        'options': options,
        'sourcePath': source_path,
        'success': True,
    }


def process_prepared_pages(
    source_path: str,
    prepared_pages: list[PreparedPage],
    options: dict[str, Any],
    temp_dir: str,
    text_layer: str = '',
) -> dict[str, Any]:
    has_gpu = check_gpu_availability()
    page_results: list[dict[str, Any]] = []
    all_candidates: list[dict[str, Any]] = []
    codes: list[dict[str, Any]] = []
    cleanup_actions: list[str] = []

    docling_result = extract_with_docling(source_path, options)

    for page in prepared_pages:
        cleanup_actions.extend(
            f'Page {page.page_number}: {action}' for action in page.cleanup_actions
        )
        if options.get('detectCodes'):
            codes.extend(detect_codes(page.path, page.page_number))
        best, candidates = run_ocr_on_page(page, options, has_gpu, temp_dir)
        all_candidates.extend(candidates)
        if best:
            page_results.append(best)

    result = finalize_result(
        source_path,
        options,
        page_results,
        all_candidates,
        codes,
        text_layer=text_layer,
        docling_result=docling_result,
        cleanup_actions=cleanup_actions,
    )
    result['gpuEnabled'] = has_gpu
    return result


def process_single_path(path: str, options: dict[str, Any]) -> dict[str, Any]:
    if not os.path.exists(path):
        return {
            'error': f'File not found: {path}',
            'success': False,
            'sourcePath': path,
        }

    suffix = Path(path).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        return {
            'error': f'Unsupported file type: {suffix}',
            'success': False,
            'sourcePath': path,
        }

    with tempfile.TemporaryDirectory(prefix='text_recognition_') as temp_dir:
        prepared_pages: list[PreparedPage] = []
        text_layer = ''

        if suffix in SUPPORTED_DOCUMENT_EXTENSIONS:
            rendered_paths, text_layer = render_pdf_pages(path, temp_dir, options)
            for index, rendered_path in enumerate(rendered_paths, start=1):
                page_options = options.copy()
                page_options['_pageNumber'] = index
                output_path = os.path.join(temp_dir, f'clean_page_{index:04d}.png')
                prepared_pages.append(
                    preprocess_image(rendered_path, output_path, page_options)
                )
        else:
            output_path = os.path.join(temp_dir, 'clean_image.png')
            prepared_pages.append(preprocess_image(path, output_path, options))

        return process_prepared_pages(
            path, prepared_pages, options, temp_dir, text_layer=text_layer
        )


def combine_batch_results(
    items: list[dict[str, Any]], options: dict[str, Any]
) -> dict[str, Any]:
    successful = [item for item in items if item.get('success')]
    if not successful:
        return {
            'error': 'No supported files could be processed successfully',
            'success': False,
            'items': items,
            'options': options,
        }

    text_parts = []
    markdown_parts = []
    all_codes: list[dict[str, Any]] = []
    all_tables: list[dict[str, Any]] = []
    all_warnings: list[dict[str, Any]] = []
    confidences = []

    for item in successful:
        title = Path(item.get('sourcePath', 'Document')).name
        if item.get('text'):
            text_parts.append(f'===== {title} =====\n{item["text"]}')
        if item.get('markdown'):
            markdown_parts.append(f'# {title}\n\n{item["markdown"]}')
        all_codes.extend(item.get('codes') or [])
        all_tables.extend(item.get('tables') or [])
        all_warnings.extend(item.get('warnings') or [])
        confidences.append(float(item.get('confidence') or 0))

    combined_text = '\n\n'.join(text_parts).strip()
    combined_markdown = '\n\n'.join(markdown_parts).strip()
    average_confidence = (
        round(sum(confidences) / len(confidences), 2) if confidences else 0.0
    )

    json_data = {
        'items': [item.get('jsonData') for item in successful if item.get('jsonData')],
        'fileCount': len(items),
        'successCount': len(successful),
        'codes': all_codes,
        'tables': all_tables,
    }

    final_text = combined_text
    if options.get('outputStyle') == 'markdown':
        final_text = combined_markdown or combined_text
    elif options.get('outputStyle') == 'json':
        final_text = json.dumps(json_data, ensure_ascii=False, indent=2)

    return {
        'text': final_text,
        'ocrText': combined_text,
        'markdown': combined_markdown,
        'jsonData': json_data,
        'codes': all_codes,
        'tables': all_tables,
        'warnings': all_warnings[:400],
        'confidence': average_confidence,
        'method': 'Batch OCR',
        'availableEngines': sorted(
            {
                engine
                for item in successful
                for engine in item.get('availableEngines', [])
            }
        ),
        'items': items,
        'fileCount': len(items),
        'successCount': len(successful),
        'charCount': len(final_text),
        'options': options,
        'success': True,
    }


def process_inputs(paths: list[str], options: dict[str, Any]) -> dict[str, Any]:
    explicit_paths = normalize_string_list(options.get('paths'))
    input_paths = explicit_paths or paths
    expanded_paths = expand_inputs(input_paths, bool(options.get('recursive', True)))

    if not expanded_paths:
        return {
            'error': 'No supported image or PDF files found',
            'success': False,
            'options': options,
        }

    items = []
    for path in expanded_paths:
        try:
            items.append(process_single_path(path, options))
        except Exception as error:
            items.append(
                {
                    'error': str(error),
                    'traceback': traceback.format_exc(limit=4),
                    'success': False,
                    'sourcePath': path,
                }
            )

    if len(items) == 1:
        return items[0]
    return combine_batch_results(items, options)


def process_image(
    image_path: str, options: dict[str, Any] | None = None
) -> dict[str, Any]:
    scan_options = DEFAULT_OPTIONS.copy()
    scan_options['preprocessing'] = DEFAULT_PREPROCESSING.copy()
    if options:
        scan_options.update(options)
        if isinstance(options.get('preprocessing'), dict):
            preprocessing = DEFAULT_PREPROCESSING.copy()
            preprocessing.update(options['preprocessing'])
            scan_options['preprocessing'] = preprocessing
    return process_inputs([image_path], scan_options)


def parse_cli_arguments(argv: list[str]) -> tuple[list[str], dict[str, Any], bool]:
    if not argv:
        return [], load_options(None), True

    if len(argv) >= 2 and argv[1].lstrip().startswith('{'):
        options = load_options(argv[1])
        return [argv[0]], options, True

    parser = argparse.ArgumentParser(
        description='OCR images, folders, and PDFs locally.'
    )
    parser.add_argument('paths', nargs='+', help='Image, PDF, or folder paths to OCR')
    parser.add_argument(
        '--mode', choices=['fast', 'balanced', 'best', 'document'], default='best'
    )
    parser.add_argument(
        '--output-style',
        choices=[
            'plain',
            'line_breaks',
            'paragraphs',
            'columns',
            'tables',
            'form_fields',
            'key_values',
            'markdown',
            'json',
        ],
        default='paragraphs',
    )
    parser.add_argument(
        '--languages',
        default='en',
        help='Comma-separated language codes, for example en,es,fr',
    )
    parser.add_argument(
        '--auto-language',
        action='store_true',
        help='Post-detect language from recognized text',
    )
    parser.add_argument(
        '--no-codes', action='store_true', help='Disable QR/barcode decoding'
    )
    parser.add_argument(
        '--no-layout', action='store_true', help='Do not preserve line breaks/gaps'
    )
    parser.add_argument(
        '--use-docling',
        action='store_true',
        help='Use Docling when installed for document layout parsing',
    )
    parser.add_argument(
        '--region-json',
        default=None,
        help='Region JSON with x,y,width,height and optional sourceWidth/sourceHeight',
    )
    parser.add_argument('--max-pages', type=int, default=100)
    parser.add_argument('--pdf-dpi', type=int, default=None)
    parser.add_argument(
        '--custom-words', default='', help='Comma/newline separated custom words'
    )
    parser.add_argument(
        '--ignored-words',
        default='',
        help='Comma/newline separated ignored warning words',
    )
    parser.add_argument(
        '--raw-json', action='store_true', help='Print the full JSON result object'
    )
    args = parser.parse_args(argv)

    options = load_options(None)
    options.update(
        {
            'ocrMode': args.mode,
            'outputStyle': args.output_style,
            'languages': normalize_string_list(args.languages),
            'languageMode': 'auto' if args.auto_language else 'manual',
            'detectCodes': not args.no_codes,
            'preserveLayout': not args.no_layout,
            'useDocling': args.use_docling,
            'maxPages': args.max_pages,
            'pdfDpi': args.pdf_dpi,
            'customWords': normalize_string_list(args.custom_words),
            'ignoredWords': normalize_string_list(args.ignored_words),
        }
    )
    if args.region_json:
        try:
            options['region'] = json.loads(args.region_json)
        except json.JSONDecodeError:
            options['region'] = None

    options = load_options(json.dumps(options))
    return args.paths, options, args.raw_json or args.output_style == 'json'


def emit_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True))


def run_worker() -> None:
    # Keep native library/model logs off the newline-delimited JSON channel too.
    sys.stdout.flush()
    with os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8') as output:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        for line in sys.stdin:
            request_id = None
            try:
                request = json.loads(line)
                request_id = request['id']
                args = request['args']
                if not isinstance(args, list) or not all(
                    isinstance(arg, str) for arg in args
                ):
                    raise ValueError('Worker args must be a list of strings')
                if args == ['--doctor']:
                    result = collect_environment_diagnostics()
                else:
                    paths, options, _ = parse_cli_arguments(args)
                    result = (
                        process_inputs(paths, options)
                        if paths
                        else {'error': 'No input path provided', 'success': False}
                    )
            except (Exception, SystemExit) as error:
                traceback.print_exc(file=sys.stderr)
                result = {'error': f'OCR request failed: {error}', 'success': False}
            output.write(json.dumps({'id': request_id, 'result': result}) + '\n')
            output.flush()


def main() -> None:
    if sys.argv[1:] == ['--worker']:
        run_worker()
        return
    if len(sys.argv) >= 2 and sys.argv[1] == '--doctor':
        emit_json(collect_environment_diagnostics())
        sys.exit(0)

    paths, options, raw_json = parse_cli_arguments(sys.argv[1:])
    if not paths:
        emit_json({'error': 'No input path provided', 'success': False})
        sys.exit(1)

    result = process_inputs(paths, options)
    if raw_json:
        emit_json(result)
    else:
        emit_json(result)
    sys.exit(0 if result.get('success') else 1)


if __name__ == '__main__':
    main()
