#!/usr/bin/env python3
"""Run OCR/card recognition for one uploaded image.

The Node API expects this script to write exactly one JSON object to stdout.
Human-readable diagnostics should go to stderr so stdout remains parseable.
"""

import json
import os
import sys
import traceback
from contextlib import redirect_stdout
from pathlib import Path


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default

    return value.lower() in ("1", "true", "yes", "on")


def deck_to_best_card(deck):
    """Return the first recognized card name from mtgscan's deck output."""
    if deck is None:
        return None

    lines = [line.strip() for line in str(deck).splitlines() if line.strip()]
    if not lines:
        return None

    first = lines[0]
    parts = first.split(" ", 1)

    if len(parts) == 2 and parts[0].isdigit():
        return parts[1].strip()

    return first


def recognition_from_box_texts(box_texts):
    from mtgscan.text import MagicRecognition

    recognizer = MagicRecognition(
        file_all_cards=os.environ.get("MTGSCAN_ALL_CARDS_FILE", "all_cards.txt"),
        file_keywords=os.environ.get("MTGSCAN_KEYWORDS_FILE", "Keywords.json"),
    )

    deck = recognizer.box_texts_to_deck(box_texts)
    detected_card_name = deck_to_best_card(deck)

    if not detected_card_name:
        raise RuntimeError("No Magic card was recognized in the image.")

    return detected_card_name


def scan_image(image_path):
    provider = os.environ.get("OCR_PROVIDER", "paddle").lower()

    if provider == "azure":
        return scan_with_azure(image_path)

    if provider == "paddle":
        return scan_with_paddle(image_path)

    raise RuntimeError(f"Unsupported OCR_PROVIDER '{provider}'. Use 'paddle' or 'azure'.")


def scan_with_azure(image_path):
    from mtgscan.ocr.azure import Azure

    azure = Azure()
    box_texts = azure.image_to_box_texts(str(image_path))
    detected_card_name = recognition_from_box_texts(box_texts)

    return {
        "detected_card_name": detected_card_name,
        "confidence_score": None,
        "ocr_provider": "azure",
    }


def scan_with_paddle(image_path):
    from mtgscan.box_text import BoxTextList

    ocr = create_paddle_ocr()
    raw_results = run_paddle_ocr(ocr, image_path)
    box_texts = BoxTextList()
    confidences = []

    for box, text, confidence in iter_paddle_lines(raw_results):
        box_texts.add(box, text)
        if confidence is not None:
            confidences.append(confidence)

    detected_card_name = recognition_from_box_texts(box_texts)
    confidence_score = sum(confidences) / len(confidences) if confidences else None

    return {
        "detected_card_name": detected_card_name,
        "confidence_score": confidence_score,
        "ocr_provider": "paddle",
    }


def create_paddle_ocr():
    from paddleocr import PaddleOCR

    use_gpu = env_bool("PADDLE_USE_GPU", True)
    lang = os.environ.get("PADDLE_OCR_LANG", "en")
    use_angle_cls = env_bool("PADDLE_USE_ANGLE_CLS", True)
    device = os.environ.get("PADDLE_DEVICE") or ("gpu:0" if use_gpu else "cpu")

    try:
        return PaddleOCR(
            lang=lang,
            device=device,
        )
    except TypeError:
        return PaddleOCR(
            use_angle_cls=use_angle_cls,
            lang=lang,
            use_gpu=use_gpu,
            show_log=False,
        )


def run_paddle_ocr(ocr, image_path):
    use_angle_cls = env_bool("PADDLE_USE_ANGLE_CLS", True)

    if hasattr(ocr, "predict"):
        return list(ocr.predict(str(image_path)))

    return ocr.ocr(str(image_path), cls=use_angle_cls)


def iter_paddle_lines(raw_results):
    """Yield Azure-style bounding boxes, text, and confidence from PaddleOCR output.

    PaddleOCR has had a couple of result shapes across versions. This parser keeps
    the wrapper tolerant so a package patch does not break the pipeline instantly.
    """
    if not raw_results:
        return

    pages = raw_results
    if len(raw_results) == 1 and isinstance(raw_results[0], list):
        pages = raw_results[0]

    for item in pages:
        if hasattr(item, "res"):
            item = item.res

        if isinstance(item, dict):
            rec_texts = item.get("rec_texts") or []
            rec_scores = item.get("rec_scores") or []
            rec_boxes = item.get("rec_boxes") or item.get("dt_polys") or []

            for index, text in enumerate(rec_texts):
                box = rec_boxes[index] if index < len(rec_boxes) else None
                score = rec_scores[index] if index < len(rec_scores) else None
                yield normalize_paddle_box(box), text, score

            continue

        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue

        box = item[0]
        text_info = item[1]

        if isinstance(text_info, (list, tuple)) and text_info:
            text = text_info[0]
            score = text_info[1] if len(text_info) > 1 else None
            yield normalize_paddle_box(box), text, score


def normalize_paddle_box(box):
    if box is None:
        return [0, 0, 0, 0, 0, 0, 0, 0]

    if hasattr(box, "tolist"):
        box = box.tolist()

    if len(box) == 4 and all(isinstance(point, (list, tuple)) for point in box):
        return [coordinate for point in box for coordinate in point[:2]]

    if len(box) == 4 and all(isinstance(value, (int, float)) for value in box):
        x_min, y_min, x_max, y_max = box
        return [x_min, y_min, x_max, y_min, x_max, y_max, x_min, y_max]

    if len(box) == 8:
        return box

    return [0, 0, 0, 0, 0, 0, 0, 0]


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: scan.py <image_path>"}))
        return 2

    image_path = Path(sys.argv[1]).expanduser().resolve()

    if not image_path.exists():
        print(json.dumps({"error": f"Image file does not exist: {image_path}"}))
        return 2

    # Redirect fd 1 to stderr at OS level so PaddleX C-extension output
    # doesn't corrupt the JSON we write to stdout.
    real_stdout_fd = os.dup(1)
    os.dup2(2, 1)

    try:
        with redirect_stdout(sys.stderr):
            result = scan_image(image_path)
        output = json.dumps(result)
        exit_code = 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        output = json.dumps({"error": str(exc)})
        exit_code = 1
    finally:
        os.dup2(real_stdout_fd, 1)
        os.close(real_stdout_fd)

    print(output, flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
