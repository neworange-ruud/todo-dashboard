"""Build Buddy's macOS icon from the supplied portrait (requires Pillow and OpenCV)."""

from pathlib import Path
from tempfile import TemporaryDirectory
import os
import subprocess

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
SOURCE = ASSETS / "Buddy-icon-source.png"


def main() -> None:
    original = Image.open(SOURCE).convert("RGB")
    if original.size != (703, 599):
        raise ValueError(f"Expected the supplied 703×599 portrait, got {original.size}")

    # The pasted portrait includes the mouse pointer over the bridge of Buddy's nose.
    # Inpaint only that small artifact before cropping; keep the original untouched.
    pixels = cv2.cvtColor(np.asarray(original), cv2.COLOR_RGB2BGR)
    mask = np.zeros(pixels.shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [np.array([
        [382, 369], [407, 388], [402, 394], [397, 390], [397, 404],
        [390, 406], [380, 385],
    ], dtype=np.int32)], 255)
    repaired = Image.fromarray(cv2.cvtColor(cv2.inpaint(pixels, mask, 5, cv2.INPAINT_TELEA), cv2.COLOR_BGR2RGB))
    side = min(repaired.size)
    x = (repaired.width - side) // 2
    y = (repaired.height - side) // 2
    square = repaired.crop((x, y, x + side, y + side)).resize((1024, 1024), Image.Resampling.LANCZOS)

    # Render the alpha mask at 4× to keep the edge clean on Retina and Dock previews.
    large = Image.new("L", (4096, 4096))
    ImageDraw.Draw(large).rounded_rectangle((0, 0, 4095, 4095), radius=880, fill=255)
    alpha = large.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon = square.convert("RGBA")
    icon.putalpha(alpha)
    icon.save(ASSETS / "Buddy-icon.png")

    with TemporaryDirectory(prefix="buddy-icon-", dir=ROOT / ".build") as temporary:
        folder = Path(temporary) / "Buddy.iconset"
        folder.mkdir()
        for points in (16, 32, 128, 256, 512):
            icon.resize((points, points), Image.Resampling.LANCZOS).save(folder / f"icon_{points}x{points}.png")
            retina = points * 2
            icon.resize((retina, retina), Image.Resampling.LANCZOS).save(folder / f"icon_{points}x{points}@2x.png")
        result = Path(temporary) / "Buddy.icns"
        subprocess.run(["iconutil", "--convert", "icns", "--output", str(result), str(folder)], check=True)
        os.replace(result, ASSETS / "Buddy.icns")


if __name__ == "__main__":
    main()
