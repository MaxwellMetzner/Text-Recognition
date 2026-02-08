# Advanced Text Recognition App

A powerful desktop application for extracting text from images using multiple OCR engines with GPU acceleration support.

## Features

- **Multi-Engine OCR** — Combines Tesseract, EasyOCR, and PaddleOCR for maximum accuracy
- **GPU Acceleration** — Leverages NVIDIA GPUs for faster processing via CUDA
- **Drag & Drop** — Drag images directly into the application
- **Clipboard Support** — Paste images with `Ctrl+V`
- **Multiple Formats** — PNG, JPG, JPEG, BMP, TIFF
- **Confidence Scores** — Quality assessment for each OCR result
- **One-Click Copy** — Copy extracted text to clipboard instantly
- **Modern UI** — Dark-themed Electron interface

---

## Prerequisites

| Software | Version | Download |
|----------|---------|----------|
| **Node.js** | v16+ | https://nodejs.org/ |
| **Python** | 3.8 – 3.11 | https://www.python.org/ |
| **Tesseract OCR** | Latest | See below |

> **Important:** Check **"Add Python to PATH"** during the Python installation.

### Tesseract OCR

| Platform | Install |
|----------|---------|
| **Windows** | Download from [UB-Mannheim/tesseract](https://github.com/UB-Mannheim/tesseract/wiki). Install to `C:\Program Files\Tesseract-OCR`. |
| **macOS** | `brew install tesseract` |
| **Linux** | `sudo apt-get install tesseract-ocr` |

---

## Installation

### 1. Install Node.js Dependencies

```sh
npm install
```

### 2. Install Python Dependencies

**GPU users (NVIDIA):**

```sh
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
pip install -r requirements.txt
```

**CPU-only users:**

```sh
pip install torch torchvision
pip install pytesseract easyocr opencv-python Pillow numpy scikit-image paddlepaddle
```

> First run will download OCR language models (~100-200 MB each). This only happens once.

### 3. Verify Installation

```sh
# Should print CUDA availability info
python -c "import torch; print('CUDA:', torch.cuda.is_available())"

# Quick test (will exit with an error since no image is provided, but shouldn't crash)
python src/python/ocr_engine.py
```

---

## Usage

### Starting the App

```sh
npm start
```

Development mode (with DevTools):

```sh
npm run dev
```

Or use the launcher scripts:

- **Windows:** double-click `run.bat`
- **macOS / Linux:** `./run.sh`

### Loading Images

| Method | How |
|--------|-----|
| **Drag & Drop** | Drag an image file onto the drop zone |
| **Browse** | Click **Browse Files** |
| **Clipboard** | `Ctrl+V` or click **Paste from Clipboard** |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+V` | Paste image from clipboard |
| `Ctrl+C` | Copy extracted text |
| `Escape` | Clear current image & results |

### Understanding Results

| Confidence | Meaning |
|------------|---------|
| **80–100%** | High — text is likely accurate |
| **60–79%** | Medium — review recommended |
| **0–59%** | Low — manual verification needed |

---

## OCR Engines

The app tries all available engines and returns the highest-confidence result:

1. **PaddleOCR** — Best for complex layouts & multilingual text
2. **EasyOCR** — Great with handwriting and diverse fonts
3. **Tesseract** — Fast, reliable baseline

---

## GPU Setup (Optional)

If you have an NVIDIA GPU (GTX 1050+, 4 GB+ VRAM):

1. Install [CUDA Toolkit 11.8](https://developer.nvidia.com/cuda-11-8-0-download-archive)
2. Optionally install [cuDNN](https://developer.nvidia.com/cudnn)
3. Restart your computer
4. Verify:
   ```sh
   python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
   ```

### Typical Performance

| Hardware | Time per Image |
|----------|---------------|
| RTX 4090 | ~1-2 s |
| RTX 3080 | ~2-3 s |
| RTX 2060 | ~3-4 s |
| Mid-range CPU | ~8-12 s |

---

## Configuration

### Change OCR Language

Edit `src/python/ocr_engine.py`:

```python
# Single language
reader = easyocr.Reader(['es'], gpu=use_gpu)
ocr = PaddleOCR(lang='es', ...)

# Multiple languages
reader = easyocr.Reader(['en', 'es', 'fr'], gpu=use_gpu)
```

EasyOCR supports 80+ languages.

### Force CPU Mode

In `src/python/ocr_engine.py`, pass `use_gpu=False` to the engine functions.

### Custom Tesseract Path (Windows)

If Tesseract is installed in a non-standard location, update the path in `src/python/ocr_engine.py`:

```python
pytesseract.pytesseract.tesseract_cmd = r'C:\Your\Custom\Path\tesseract.exe'
```

---

## Tips for Best Results

**Good images:** high resolution (300+ DPI), clear & sharp text, high contrast, horizontal orientation.

**Avoid:** blurry images, heavy compression, watermarks over text, extreme angles.

| Text Type | Accuracy |
|-----------|----------|
| Printed / typed text | Excellent |
| Digital screenshots | Excellent |
| Handwriting | Good (varies) |
| Stylized fonts | Moderate |
| Heavily distorted | Poor |

---

## Troubleshooting

### `python` / `node` is not recognized

Reinstall the respective tool and ensure **"Add to PATH"** is checked. Restart your terminal afterward.

### pip packages fail to install

```sh
python -m pip install --upgrade pip setuptools wheel
```

Use Python 3.8–3.11 (avoid 3.12+ due to package compatibility).

### Tesseract not found

Verify it exists at `C:\Program Files\Tesseract-OCR\tesseract.exe`, or update the path in `src/python/ocr_engine.py`.

### GPU not detected

```sh
python -c "import torch; print(torch.cuda.is_available())"
```

Ensure NVIDIA drivers are up to date and PyTorch CUDA version matches your CUDA Toolkit.

### App won't start

```sh
npm install        # reinstall deps
npm run dev        # run with DevTools for error details
```

### CUDA version mismatch

Match PyTorch to your installed CUDA version:

```sh
# CUDA 11.8
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
# CUDA 12.1
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

---

## Project Structure

```
TextRecognition/
├── package.json            # Node.js dependencies & scripts
├── requirements.txt        # Python dependencies
├── run.bat                 # Windows launcher
├── run.sh                  # macOS/Linux launcher
├── README.md
└── src/
    ├── main/
    │   └── main.js         # Electron main process
    ├── renderer/
    │   ├── index.html      # UI layout
    │   ├── renderer.js     # Frontend logic
    │   └── styles.css      # Styling
    └── python/
        ├── ocr_engine.py   # Multi-engine OCR backend
        └── launcher.py     # Dependency checker & app launcher
```

---

## Building for Distribution

```sh
npm install electron-builder --save-dev
npm run build
```

Outputs distributable packages to the `dist/` folder.

---

## Future Enhancements

- [ ] Batch processing for multiple images
- [ ] PDF input support
- [ ] Export to TXT / DOCX / PDF
- [ ] In-app OCR result editing
- [ ] Automatic language detection
- [ ] Cloud storage integration

---

## License

MIT License

## Acknowledgments

- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) — Google's OCR engine
- [EasyOCR](https://github.com/JaidedAI/EasyOCR) — Jaided AI's deep learning OCR
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — Baidu's production-ready OCR
- [Electron](https://www.electronjs.org/) — Cross-platform desktop apps

---

> **Privacy:** All image processing happens locally on your machine. No data is sent to external servers.
