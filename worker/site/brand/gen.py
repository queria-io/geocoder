# mark.svg と og.svg から favicon・ホーム画面のアイコン・共有画像を作る。uv run --with cairosvg --with pillow python gen.py
import io

import cairosvg
from PIL import Image

png = lambda src, size, bg=None: Image.open(io.BytesIO(cairosvg.svg2png(url=src, output_width=size, output_height=size, background_color=bg)))

def padded(size, bg="#ffffff", pad=0.14):
    inner = round(size * (1 - 2 * pad))
    canvas = Image.new("RGBA", (size, size), bg)
    canvas.alpha_composite(png("mark.svg", inner).convert("RGBA"), ((size - inner) // 2,) * 2)
    return canvas.convert("RGB")

png("mark.svg", 48).save("favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
padded(180).save("apple-touch-icon.png")
padded(512).save("icon-512.png")
cairosvg.svg2png(url="og.svg", write_to="og.png", output_width=1200, output_height=630)
