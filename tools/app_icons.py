"""Makes the home-screen app icons (PNG) from assets/icons/app-icon.svg.

Phones need PNG pictures in fixed sizes (manifest.webmanifest and the apple-touch-icon in the pages):
180 px (iPhone), 192 px and 512 px (Android). Microsoft Edge, in headless mode, draws the SVG at each size.

    python tools/app_icons.py
"""

import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'assets' / 'icons' / 'app-icon.svg'
SIZES = [180, 192, 512]
EDGE = pathlib.Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')


def main():
    if not EDGE.exists():
        sys.exit(f'Microsoft Edge not found at {EDGE}')
    svg = SOURCE.read_text(encoding='utf-8')
    with tempfile.TemporaryDirectory() as tmp:
        for size in SIZES:
            # A page exactly as big as the icon, with the SVG filling it.
            page = pathlib.Path(tmp) / f'icon-{size}.html'
            page.write_text(
                '<!doctype html><style>html,body{margin:0;overflow:hidden}svg{display:block;'
                f'width:{size}px;height:{size}px}}</style>{svg}',
                encoding='utf-8',
            )
            out = ROOT / 'assets' / 'icons' / f'app-icon-{size}.png'
            subprocess.run([
                str(EDGE), '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                f'--user-data-dir={tmp}/profile', f'--window-size={size},{size}', f'--screenshot={out}',
                page.as_uri(),
            ], check=True, capture_output=True, timeout=60)
            print(f'{out.relative_to(ROOT)}: {out.stat().st_size} bytes')


if __name__ == '__main__':
    main()
