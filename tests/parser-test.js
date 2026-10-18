// Runs the year-tab parser on the exported spreadsheet and compares its balance with the sheet's own formulas.

import { isYearTab, parseYearTab } from '../js/budget.js';

const out = document.getElementById('out');

function line(text, cls) {
  const p = document.createElement(cls === 'pre' ? 'pre' : 'p');
  if (cls && cls !== 'pre') p.className = cls;
  p.textContent = text;
  out.append(p);
}

async function main() {
  out.replaceChildren();
  const res = await fetch('../private/fixture.json');
  if (!res.ok) {
    line(`Could not load fixture (${res.status}).`, 'fail');
    return;
  }
  const fixture = await res.json();
  line(`Source: ${fixture.source}`);
  let failures = 0;

  for (const tab of fixture.tabs.filter((t) => isYearTab(t.title))) {
    const parsed = parseYearTab(tab.title, tab.values);
    const balanceOk = !parsed.tabProblems.some((p) => p.code === 'balance-mismatch' || p.code === 'no-summary');
    const layoutOk = !parsed.layoutProblem;
    if (!balanceOk || !layoutOk) failures++;

    const [a, b] = Object.entries(parsed.totals);
    line(
      `${tab.title}: ${parsed.entries.length} entries, ${parsed.blocks.length} month blocks, carry-over ${parsed.carry ? `row ${parsed.carry.rowNumber}` : 'none'} · ` +
      `${a[0]} owes ${a[1].owes.toFixed(2)}, ${b[0]} owes ${b[1].owes.toFixed(2)} ` +
      `(sheet: ${parsed.sheetSummary?.[a[0]].owes}, ${parsed.sheetSummary?.[b[0]].owes})`,
      balanceOk && layoutOk ? 'ok' : 'fail',
    );
    if (parsed.layoutProblem) line(parsed.layoutProblem, 'fail');

    const rowProblems = parsed.entries.concat(parsed.carry || []).flatMap((e) => e.problems.map((p) => `  row ${e.rowNumber}: [${p.code}] ${p.text}`));
    const tabProblems = parsed.tabProblems.map((p) => `  [${p.code}] ${p.text}`);
    line([...tabProblems, ...rowProblems].join('\n') || '  no problems', 'pre');
  }
  line(failures ? `${failures} tab(s) FAILED` : 'All year tabs: layout recognised, balance matches the sheet.', failures ? 'fail' : 'ok');
}

main().catch((err) => line(String(err.stack || err), 'fail'));
