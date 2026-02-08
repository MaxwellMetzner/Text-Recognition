#!/usr/bin/env python3
"""
Advanced OCR Engine with Multiple Backends
Supports Tesseract, EasyOCR, and PaddleOCR for maximum accuracy
GPU-accelerated when available
"""

import sys
import json
import os
from pathlib import Path

def check_gpu_availability():
    """Check if CUDA is available for GPU acceleration"""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False

def ocr_with_tesseract(image_path):
    """Process image with Tesseract OCR"""
    try:
        import pytesseract
        from PIL import Image
        
        # Try to set tesseract path for Windows
        if sys.platform == 'win32':
            possible_paths = [
                r'C:\Program Files\Tesseract-OCR\tesseract.exe',
                r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
            ]
            for path in possible_paths:
                if os.path.exists(path):
                    pytesseract.pytesseract.tesseract_cmd = path
                    break
        
        img = Image.open(image_path)
        
        # Get detailed data including confidence
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        text = pytesseract.image_to_string(img)
        
        # Calculate average confidence
        confidences = [int(conf) for conf in data['conf'] if conf != '-1']
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0
        
        return {
            'text': text.strip(),
            'confidence': round(avg_confidence, 2),
            'method': 'Tesseract OCR'
        }
    except Exception as e:
        return None

def ocr_with_easyocr(image_path, use_gpu=True):
    """Process image with EasyOCR (Deep Learning-based)"""
    try:
        import easyocr
        
        # Initialize reader (supports 80+ languages)
        # Using English by default, can add more languages: ['en', 'es', 'fr', etc.]
        reader = easyocr.Reader(['en'], gpu=use_gpu)
        
        # Read text from image
        results = reader.readtext(image_path, detail=1)
        
        if not results:
            return None
        
        # Extract text and confidence
        text_parts = []
        confidences = []
        
        for detection in results:
            bbox, text, conf = detection
            text_parts.append(text)
            confidences.append(conf)
        
        full_text = ' '.join(text_parts)
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0
        
        return {
            'text': full_text.strip(),
            'confidence': round(avg_confidence * 100, 2),
            'method': 'EasyOCR' + (' (GPU)' if use_gpu else ' (CPU)')
        }
    except Exception as e:
        return None

def ocr_with_paddleocr(image_path, use_gpu=True):
    """Process image with PaddleOCR (Excellent for multi-language and complex layouts)"""
    try:
        from paddleocr import PaddleOCR
        
        # Initialize PaddleOCR
        ocr = PaddleOCR(
            use_angle_cls=True,  # Enable angle classification
            lang='en',  # Language
            use_gpu=use_gpu,
            show_log=False
        )
        
        # Perform OCR
        results = ocr.ocr(image_path, cls=True)
        
        if not results or not results[0]:
            return None
        
        # Extract text and confidence
        text_parts = []
        confidences = []
        
        for line in results[0]:
            text = line[1][0]
            conf = line[1][1]
            text_parts.append(text)
            confidences.append(conf)
        
        full_text = ' '.join(text_parts)
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0
        
        return {
            'text': full_text.strip(),
            'confidence': round(avg_confidence * 100, 2),
            'method': 'PaddleOCR' + (' (GPU)' if use_gpu else ' (CPU)')
        }
    except Exception as e:
        return None

def process_image(image_path):
    """
    Process image with multiple OCR engines and return the best result
    Priority: PaddleOCR > EasyOCR > Tesseract (all are excellent, but this order for complex images)
    """
    
    if not os.path.exists(image_path):
        return {
            'error': f'Image file not found: {image_path}',
            'success': False
        }
    
    # Check GPU availability
    has_gpu = check_gpu_availability()
    
    results = []
    
    # Try PaddleOCR first (excellent for complex layouts)
    paddle_result = ocr_with_paddleocr(image_path, use_gpu=has_gpu)
    if paddle_result:
        results.append(paddle_result)
    
    # Try EasyOCR (great with handwriting and diverse fonts)
    easy_result = ocr_with_easyocr(image_path, use_gpu=has_gpu)
    if easy_result:
        results.append(easy_result)
    
    # Try Tesseract (excellent baseline, very fast)
    tesseract_result = ocr_with_tesseract(image_path)
    if tesseract_result:
        results.append(tesseract_result)
    
    if not results:
        return {
            'error': 'All OCR engines failed to process the image',
            'success': False
        }
    
    # Choose the result with highest confidence
    best_result = max(results, key=lambda x: x['confidence'])
    
    # If confidence is very low, try to combine results
    if best_result['confidence'] < 50 and len(results) > 1:
        # Use the longest text result as a fallback
        best_result = max(results, key=lambda x: len(x['text']))
        best_result['method'] += ' (Low Confidence - Manual Review Recommended)'
    
    return best_result

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            'error': 'No image path provided',
            'success': False
        }))
        sys.exit(1)
    
    image_path = sys.argv[1]
    result = process_image(image_path)
    
    # Output JSON result
    print(json.dumps(result, ensure_ascii=False))
    
    if 'error' in result:
        sys.exit(1)
    else:
        sys.exit(0)

if __name__ == '__main__':
    main()
