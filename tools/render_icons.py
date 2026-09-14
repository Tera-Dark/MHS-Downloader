"""Optional design tool: pip install -r requirements-design.txt; python tools/render_icons.py."""

from pathlib import Path
import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "design/icon.svg"
for size in (16, 19, 32, 38, 48, 64, 96, 128, 256, 512, 1024):
    output = (
        ROOT
        / ("extension" if size in (16, 32, 48, 128) else "design")
        / f"icon{size}.png"
    )
    cairosvg.svg2png(
        url=str(SVG), write_to=str(output), output_width=size, output_height=size
    )
canvas = Image.new("RGB", (1200, 690), "#f6f3eb")
draw = ImageDraw.Draw(canvas)
draw.text((52, 32), "ARTWORK ARCHIVE / ICON SYSTEM", fill="#285441", font_size=28)
draw.text(
    (54, 80),
    "Picture card + archive tray. Original vector artwork.",
    fill="#71866a",
    font_size=18,
)
hero = Image.open(ROOT / "design/icon256.png").convert("RGBA")
canvas.paste(hero, (66, 150), hero)
draw.rounded_rectangle((375, 140, 1150, 365), radius=22, fill="#ffffff")
draw.rounded_rectangle((375, 395, 1150, 620), radius=22, fill="#172d25")
for x, size in zip((420, 515, 635, 790, 955), (16, 32, 48, 64, 128)):
    src = (
        ROOT
        / ("extension" if size in (16, 32, 48, 128) else "design")
        / f"icon{size}.png"
    )
    icon = Image.open(src).convert("RGBA")
    for y, color in ((190, "#6b8267"), (445, "#adbea4")):
        canvas.paste(icon, (x, y + (128 - size) // 2), icon)
        draw.text((x, y + 142), f"{size}px", fill=color, font_size=16)
for i, color in enumerate(("#285441", "#48765A", "#DDE8D1", "#FFFCF1", "#E9A977")):
    draw.rounded_rectangle(
        (67 + i * 51, 458, 106 + i * 51, 497), radius=8, fill=color, outline="#c9d5bc"
    )
draw.text((67, 531), "SVG master / PNG exports", fill="#71866a", font_size=18)
canvas.save(ROOT / "docs/images/icon-sheet.png")
