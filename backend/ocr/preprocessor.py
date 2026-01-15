import cv2
import numpy as np
from PIL import Image


def preprocess_image(image_path: str) -> np.ndarray:
    """
    Preprocess image for better OCR results.

    Applies:
    - Auto-rotation correction (if needed)
    - Contrast enhancement
    - Noise reduction
    - Binarization for text clarity
    """
    # Read image
    img = cv2.imread(image_path)

    if img is None:
        raise ValueError(f"Could not read image: {image_path}")

    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Denoise
    denoised = cv2.fastNlMeansDenoising(gray, h=10)

    # Enhance contrast using CLAHE
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)

    # Detect and correct skew
    corrected = deskew_image(enhanced)

    return corrected


def deskew_image(image: np.ndarray) -> np.ndarray:
    """
    Detect and correct image skew using Hough transform.
    """
    # Edge detection
    edges = cv2.Canny(image, 50, 150, apertureSize=3)

    # Detect lines
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=100,
        minLineLength=100,
        maxLineGap=10
    )

    if lines is None:
        return image

    # Calculate angles of detected lines
    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        # Only consider near-horizontal lines
        if abs(angle) < 45:
            angles.append(angle)

    if not angles:
        return image

    # Get median angle
    median_angle = np.median(angles)

    # Only correct if skew is significant but not too extreme
    if abs(median_angle) < 0.5 or abs(median_angle) > 15:
        return image

    # Rotate image
    h, w = image.shape[:2]
    center = (w // 2, h // 2)
    rotation_matrix = cv2.getRotationMatrix2D(center, median_angle, 1.0)
    rotated = cv2.warpAffine(
        image,
        rotation_matrix,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE
    )

    return rotated


def enhance_for_ocr(image: np.ndarray) -> np.ndarray:
    """
    Additional enhancement specifically for OCR on receipts/invoices.
    """
    # Adaptive thresholding for better text extraction
    binary = cv2.adaptiveThreshold(
        image,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        11,
        2
    )

    # Morphological operations to clean up
    kernel = np.ones((1, 1), np.uint8)
    cleaned = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    return cleaned


def resize_for_ocr(image: np.ndarray, max_dimension: int = 2000) -> np.ndarray:
    """
    Resize image if too large, maintaining aspect ratio.
    """
    h, w = image.shape[:2]
    max_dim = max(h, w)

    if max_dim <= max_dimension:
        return image

    scale = max_dimension / max_dim
    new_w = int(w * scale)
    new_h = int(h * scale)

    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized
