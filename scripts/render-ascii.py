"""
Render the ANSI Shadow "CLAUDE CODE" ASCII art to a PNG with Consolas, so
it renders identically on every device regardless of system mono font
box-drawing support. Output is trimmed to content, transparent background,
coral fill color.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ASCII = """\
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗    ██████╗ ██████╗ ██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝   ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗     ██║     ██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝     ██║     ██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗   ╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝"""

FONT_PATH = "C:/Windows/Fonts/consola.ttf"    # Consolas regular — bold weight overshoots vertical metrics
FONT_SIZE = 72                                 # source resolution; scales down beautifully
COLOR = (226, 112, 76, 255)                    # --accent #e2704c
OUT = Path(__file__).resolve().parent.parent / "docs" / "claude-code.png"

def measure_block(font: ImageFont.FreeTypeFont) -> tuple[int, int, int]:
    """Measure the exact rendered extent of a lone █ character. Returns
    (row_pitch, top_offset_from_origin, rendered_block_height). We need
    the row pitch to equal the block's rendered height so vertical bars
    in the ASCII art tile edge-to-edge with zero gap and zero overlap."""
    probe = Image.new("RGBA", (font.size * 3, font.size * 3), (0, 0, 0, 0))
    d = ImageDraw.Draw(probe)
    d.text((font.size, font.size), "█", font=font, fill=(255, 255, 255, 255))
    bbox = probe.getbbox()
    if bbox is None:
        raise RuntimeError("failed to measure █ glyph")
    top = bbox[1] - font.size             # how far above the baseline-origin y the block starts
    block_h = bbox[3] - bbox[1]           # actual rendered pixel height
    return block_h, top, block_h


def render() -> None:
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    lines = ASCII.splitlines()

    row_pitch, top_offset, block_h = measure_block(font)
    pad = 8

    # Width: widest line. Use a line of all █ to get a tight upper bound.
    dummy = Image.new("RGBA", (1, 1))
    dd = ImageDraw.Draw(dummy)
    widths = [dd.textlength(line, font=font) for line in lines]
    w = int(max(widths)) + pad * 2
    h = row_pitch * len(lines) + pad * 2

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Draw each line at the SAME x, y offset by row_pitch so blocks tile.
    # Origin y subtracts top_offset so the █ glyph sits flush at row top.
    for i, line in enumerate(lines):
        y = pad + i * row_pitch - top_offset
        draw.text((pad, y), line, font=font, fill=COLOR)

    tight = img.getbbox()
    if tight:
        img = img.crop(tight)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}  ({img.size[0]}x{img.size[1]})  row_pitch={row_pitch}")

if __name__ == "__main__":
    render()
