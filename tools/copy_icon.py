"""Copies an SVG icon into the app, rounding path coordinates to fewer decimals (smaller file,
same look at the sizes the app uses). Only the d="…" path data is changed; the viewBox, colours
and everything else are copied as they are. The source file is never modified.

    python tools/copy_icon.py "private/Cavalier icon 3.svg" assets/icons/cavalier.svg [decimals]
"""

import re
import sys
from pathlib import Path

TOKEN = re.compile(r'[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')


def fmt(number, decimals):
    text = f'{float(number):.{decimals}f}'
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return '0' if text in ('-0', '') else text


def round_path(d, decimals):
    out = []
    previous_number = False
    for token in TOKEN.findall(d):
        if token[0].isalpha():
            out.append(token)
            previous_number = False
        else:
            value = fmt(token, decimals)
            # Separate from the previous number unless the sign already does.
            if previous_number and not value.startswith('-'):
                out.append(' ')
            out.append(value)
            previous_number = True
    return ''.join(out)


def main(src, dst, decimals=1):
    text = Path(src).read_text(encoding='utf-8')
    result = re.sub(r'\sd="([^"]*)"', lambda m: f' d="{round_path(m.group(1), decimals)}"', text)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_text(result, encoding='utf-8')
    print(f'{src}: {len(text.encode())} bytes -> {dst}: {len(result.encode())} bytes')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1)
