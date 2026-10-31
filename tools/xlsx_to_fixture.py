"""Converts an .xlsx export into private/fixture.json for local testing without signing in
(the test data the app uses on the local dev server, and tests/parser.html). The output is git-ignored.

Per tab: cached cell values (like the Sheets API's UNFORMATTED_VALUE response), formulas,
cells with a date format, dropdown rules and the frozen row count.

    python tools/xlsx_to_fixture.py "private/Wallet Dev.xlsx"
"""

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
BUILTIN_DATE_FORMATS = set(range(14, 23))


def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def is_date_format(code):
    code = re.sub(r'"[^"]*"|\[[^\]]*\]', "", code or "").lower()
    return bool(re.search(r"[dy]", code)) or bool(re.search(r"(^|[^h])m{1,4}([^ms]|$)", code) and "d" in code)


def main(src):
    z = zipfile.ZipFile(src)
    xml = lambda name: ET.fromstring(z.read(name))
    shared = ["".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t"))
              for si in xml("xl/sharedStrings.xml").findall("m:si", NS)]
    rels = {r.get("Id"): r.get("Target") for r in xml("xl/_rels/workbook.xml.rels").findall("pr:Relationship", NS)}

    styles = xml("xl/styles.xml")
    custom = {int(nf.get("numFmtId")): nf.get("formatCode") for nf in styles.findall("m:numFmts/m:numFmt", NS)}
    xf_is_date = []
    for xf in styles.findall("m:cellXfs/m:xf", NS):
        fid = int(xf.get("numFmtId", 0))
        xf_is_date.append(fid in BUILTIN_DATE_FORMATS or (fid in custom and is_date_format(custom[fid])))

    tabs = []
    for sheet in xml("xl/workbook.xml").findall("m:sheets/m:sheet", NS):
        target = "xl/" + rels[sheet.get(f"{{{NS['r']}}}id")].lstrip("/").removeprefix("xl/")
        root = xml(target)
        grid, formulas, date_cells = {}, {}, []
        for row in root.findall("m:sheetData/m:row", NS):
            r = int(row.get("r")) - 1
            for c in row.findall("m:c", NS):
                ci = col_index(c.get("r"))
                f = c.find("m:f", NS)
                if f is not None:
                    formulas[f"{r},{ci}"] = "=" + f.text if f.text else "=(shared formula)"
                v = c.find("m:v", NS)
                t = c.get("t")
                if t == "inlineStr":
                    value = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                elif v is None or v.text is None:
                    continue
                elif t == "s":
                    value = shared[int(v.text)]
                elif t in ("str", "e"):
                    value = v.text
                elif t == "b":
                    value = v.text == "1"
                else:
                    num = float(v.text)
                    value = int(num) if num.is_integer() else num
                    s = int(c.get("s", 0))
                    if s < len(xf_is_date) and xf_is_date[s]:
                        date_cells.append(f"{r},{ci}")
                if value != "":
                    grid.setdefault(r, {})[ci] = value
        # Like the API: rows/cells up to the last non-empty one, gaps as "" (rows as []).
        values = []
        for r in range(max(grid) + 1 if grid else 0):
            cells = grid.get(r, {})
            values.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])

        validations = []
        for dv in root.findall("m:dataValidations/m:dataValidation", NS):
            f1 = dv.find("m:formula1", NS)
            validations.append({"sqref": dv.get("sqref"),
                                "type": dv.get("type"),
                                "formula1": f1.text if f1 is not None else None})

        pane = root.find("m:sheetViews/m:sheetView/m:pane", NS)
        frozen = int(float(pane.get("ySplit", 0))) if pane is not None and pane.get("state") == "frozen" else 0

        tabs.append({"title": sheet.get("name"), "values": values, "formulas": formulas,
                     "dateCells": date_cells, "validations": validations, "frozenRows": frozen})

    out = Path(__file__).resolve().parent.parent / "private" / "fixture.json"
    out.write_text(json.dumps({"source": Path(src).name, "tabs": tabs}, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out} ({len(tabs)} tabs)")


if __name__ == "__main__":
    main(sys.argv[1])
