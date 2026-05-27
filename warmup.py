#!/usr/bin/env python3
"""Pre-warm PaddleOCR models at container startup so they're cached in the volume."""

import os
import sys

def main():
    use_gpu = os.environ.get("PADDLE_USE_GPU", "False").lower() in ("1", "true", "yes", "on")
    lang = os.environ.get("PADDLE_OCR_LANG", "en")
    use_angle_cls = os.environ.get("PADDLE_USE_ANGLE_CLS", "true").lower() in ("1", "true", "yes", "on")

    print(f"Warming up PaddleOCR (lang={lang}, gpu={use_gpu}, angle_cls={use_angle_cls})...")
    sys.stdout.flush()

    from paddleocr import PaddleOCR
    PaddleOCR(use_angle_cls=use_angle_cls, lang=lang, use_gpu=use_gpu, show_log=False)

    print("PaddleOCR models ready.")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
