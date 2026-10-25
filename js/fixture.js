// Development only: serves private/fixture.json (made by tools/xlsx_to_fixture.py) in place of the
// Sheets API, so the UI can be checked without signing in. Always used on the local dev server
// (Google sign-in isn't set up for it); ?real tries the real sign-in there instead.
// Writes change an in-memory copy only (lost on reload). window.__fixtureSet() simulates an edit
// made directly in Google Sheets, to test syncing.

import { serialToBg, isoToSerial } from './dates.js';

const LIVE_APP = 'https://alekskovachev.github.io/budget-sheets/';

export function fixtureRequested() {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local && !new URLSearchParams(location.search).has('real');
}

// A striped bar at the very top, so test data is never mistaken for the real spreadsheet.
export function showFixtureBanner() {
  const bar = document.createElement('div');
  bar.className = 'fixture-banner';
  bar.textContent = 'TEST DATA from the exported .xlsx – not your Google Sheet. Changes stay in this tab and are lost on reload.';
  const link = document.createElement('a');
  link.href = LIVE_APP + (location.pathname.split('/').pop() || '');
  link.textContent = 'Open the live app';
  bar.append(' ', link);
  document.body.prepend(bar);
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// "'2026'!B5", "List!$A$2:$A$50", "'2026'" -> { title, r1, c1, r2, c2 } (cell bounds null = whole tab)
function parseRange(range) {
  const match = range.replace(/^=/, '').match(/^(?:'((?:[^']|'')*)'|([^!]+?))(?:!(.+))?$/);
  const title = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
  if (!match[3]) return { title, r1: null };
  const [a, b] = match[3].replace(/\$/g, '').split(':');
  // "B5", or a whole row "5" (as in "5:5": columns A..ZZ).
  const cell = (ref, last) => {
    const m = ref.match(/^([A-Z]*)(\d+)$/i);
    return { r: Number(m[2]) - 1, c: m[1] ? colIndex(m[1]) : last ? 701 : 0 };
  };
  const start = cell(a, false);
  const end = b ? cell(b, true) : start;
  return { title, r1: start.r, c1: start.c, r2: end.r, c2: end.c };
}

function inSqref(sqref, r, c) {
  return sqref.split(' ').some((part) => {
    const box = parseRange(`x!${part}`);
    return r >= box.r1 && r <= box.r2 && c >= box.c1 && c <= box.c2;
  });
}

export async function loadFixtureApi() {
  const res = await fetch('private/fixture.json');
  if (!res.ok) throw new Error(`Could not load private/fixture.json (${res.status}).`);
  const fixture = await res.json();
  // Tabs in sheet order; sheetIds stay fixed when tabs are added (like in Sheets).
  const order = fixture.tabs.map((t, i) => ({ ...t, sheetId: i, dates: new Set(t.dateCells) }));
  const tabs = new Map(order.map((t) => [t.title, t]));
  const bySheetId = (sheetId) => order.find((t) => t.sheetId === sheetId);

  const tabFor = (range) => {
    const parsed = parseRange(range);
    const tab = tabs.get(parsed.title);
    if (!tab) throw new Error(`Fixture has no tab "${parsed.title}"`);
    return { tab, ...parsed };
  };
  const valueAt = (tab, r, c) => tab.values[r]?.[c] ?? '';
  const setValue = (tab, r, c, value, isDate) => {
    while (tab.values.length <= r) tab.values.push([]);
    const row = tab.values[r];
    while (row.length <= c) row.push('');
    row[c] = value;
    delete tab.formulas[`${r},${c}`];
    if (isDate) tab.dates.add(`${r},${c}`);
  };

  // Copies, like every response of the real API (callers keep and compare what they read).
  // formulas: true gives formula cells as their formula (valueRenderOption FORMULA).
  function slice(range, formulas = false) {
    const { tab, r1, c1, r2, c2 } = tabFor(range);
    const at = (r, c) => (formulas && tab.formulas[`${r},${c}`]) || valueAt(tab, r, c);
    const trim = (row) => {
      while (row.length && row.at(-1) === '') row.pop();
      return row;
    };
    if (r1 === null) {
      return tab.values.map((row, r) => {
        const width = Math.max(row.length, ...Object.keys(tab.formulas).filter((k) => k.startsWith(`${r},`)).map((k) => Number(k.split(',')[1]) + 1));
        return trim(Array.from({ length: width }, (_, c) => at(r, c)));
      });
    }
    const rows = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(at(r, c));
      rows.push(trim(row));
    }
    return rows;
  }

  function cellData(tab, r, c, withValidation) {
    const value = valueAt(tab, r, c);
    const formula = tab.formulas[`${r},${c}`];
    const isDate = tab.dates.has(`${r},${c}`) && typeof value === 'number';
    const typed = (v) => (typeof v === 'number' ? { numberValue: v } : v === '' ? undefined : { stringValue: String(v) });
    const cell = {};
    if (value !== '') cell.formattedValue = isDate ? serialToBg(value).replace(/\./g, '/') : String(value);
    if (formula) cell.userEnteredValue = { formulaValue: formula };
    else if (value !== '') cell.userEnteredValue = typed(value);
    if (value !== '') cell.effectiveValue = typed(value);
    if (tab.dates.has(`${r},${c}`)) cell.effectiveFormat = { numberFormat: { type: 'DATE' } };
    if (withValidation) {
      const rule = tab.validations.find((v) => inSqref(v.sqref, r, c));
      if (rule?.type === 'list' && rule.formula1?.startsWith('"')) {
        const values = rule.formula1.slice(1, -1).split(',').map((s) => ({ userEnteredValue: s }));
        cell.dataValidation = { condition: { type: 'ONE_OF_LIST', values }, showCustomUi: true };
      } else if (rule?.type === 'list') {
        cell.dataValidation = { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `=${rule.formula1}` }] }, showCustomUi: true };
      } else if (rule?.type === 'custom') {
        cell.dataValidation = { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${rule.formula1}` }] } };
      }
    }
    return cell;
  }

  // Rows from index `at` move by `by` (positive: empty rows inserted at `at`; negative: rows before `at` removed).
  function shiftRows(title, at, by) {
    const tab = tabs.get(title);
    if (by > 0) tab.values.splice(at, 0, ...Array.from({ length: by }, () => []));
    else tab.values.splice(at + by, -by);
    const move = (key) => {
      const [r, c] = key.split(',').map(Number);
      if (r < at + Math.min(by, 0)) return key;
      if (by < 0 && r < at) return null; // Deleted.
      return `${r + by},${c}`;
    };
    const formulas = {};
    for (const [key, f] of Object.entries(tab.formulas)) {
      const moved = move(key);
      if (moved) formulas[moved] = f;
    }
    tab.formulas = formulas;
    tab.dates = new Set([...tab.dates].map(move).filter(Boolean));
  }

  // Rows from..to (1-based) of a tab as "row: A | B | C | D..I", for checking the layout in tests.
  window.__fixtureRows = (title, from, to) => {
    const tab = tabs.get(title);
    const out = [];
    for (let r = from; r <= to; r++) {
      const cells = (tab.values[r - 1] || []).slice(0, 9).map((v, c) => (c === 0 && typeof v === 'number' ? serialToBg(v) : v));
      out.push(`${r}: ${cells.join(' | ')}`);
    }
    return out;
  };

  // A whole tab (values and formulas) as text, to check that undo puts everything back exactly.
  window.__fixtureTab = (title) => {
    const tab = tabs.get(title);
    return tab ? JSON.stringify(slice(`'${title}'`, true)) : null;
  };

  // An empty row inserted at a 1-based row, as if done in Google Sheets.
  window.__fixtureInsertRow = (title, row) => shiftRows(title, row - 1, 1);

  // A formula: { formula: '=12.4+3.6', value: 16 } (the fixture can't calculate it).
  window.__fixtureSet = (range, value) => {
    const { tab, r1, c1 } = tabFor(range);
    if (value?.formula) {
      setValue(tab, r1, c1, value.value, false);
      tab.formulas[`${r1},${c1}`] = value.formula;
    } else {
      setValue(tab, r1, c1, value, false);
    }
  };

  const fixtureApi = {
    async getSpreadsheet() {
      return {
        properties: { title: `${fixture.source} (fixture)`, locale: 'fixture', timeZone: 'no API' },
        sheets: order.map((t, index) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            index,
            gridProperties: { rowCount: t.values.length + 200, columnCount: 26, frozenRowCount: t.frozenRows },
          },
        })),
      };
    },
    // Only raw values exist in the fixture; of the render options only FORMULA makes a difference.
    async getValues(_id, range, render) {
      return { range, values: slice(range, render === 'FORMULA') };
    },
    async batchGetValues(_id, ranges, render) {
      return { valueRanges: ranges.map((range) => ({ range, values: slice(range, render === 'FORMULA') })) };
    },
    async deleteSheet(_id, sheetId) {
      const tab = bySheetId(sheetId);
      order.splice(order.indexOf(tab), 1);
      tabs.delete(tab.title);
      return {};
    },
    async getGrid(_id, range, { validation = true } = {}) {
      const { tab, r1, c1, r2, c2 } = tabFor(range);
      const lastRow = r1 === null ? tab.values.length + 25 : r2 + 1;
      const rowData = [];
      for (let r = r1 ?? 0; r < lastRow; r++) {
        const width = c1 === null || c1 === undefined ? Math.max(16, tab.values[r]?.length || 0) : c2 + 1;
        const values = [];
        for (let c = c1 ?? 0; c < width; c++) values.push(cellData(tab, r, c, validation));
        rowData.push({ values });
      }
      return rowData;
    },
    async updateValues(_id, range, values) {
      const { tab, r1, c1 } = tabFor(range);
      const text = String(values[0][0]);
      const iso = text.match(/^\d{4}-\d{2}-\d{2}$/);
      if (text.startsWith('=')) {
        // A formula: kept as a formula; its result is unknown here.
        setValue(tab, r1, c1, '', false);
        tab.formulas[`${r1},${c1}`] = text;
      } else if (iso) setValue(tab, r1, c1, isoToSerial(text), true);
      else if (text.trim() !== '' && !Number.isNaN(Number(text))) setValue(tab, r1, c1, Number(text), false);
      else setValue(tab, r1, c1, text, false);
      return {};
    },
    async updateValuesRaw(_id, range, values) {
      const { tab, r1, c1 } = tabFor(range);
      setValue(tab, r1, c1, values[0][0], false);
      return {};
    },
    async batchUpdateValues(_id, data, valueInputOption = 'RAW') {
      for (const { range, values } of data) {
        const { tab, r1, c1 } = tabFor(range);
        const value = values[0][0];
        if (valueInputOption === 'USER_ENTERED' && String(value).startsWith('=')) {
          setValue(tab, r1, c1, '', false);
          tab.formulas[`${r1},${c1}`] = value; // A formula; its result is unknown here.
          continue;
        }
        // Column A of a year tab holds dates (in Sheets the cell's date format does this).
        setValue(tab, r1, c1, value, c1 === 0 && typeof value === 'number');
      }
      return {};
    },
    async batchClearValues(_id, ranges) {
      for (const range of ranges) {
        const { tab, r1, c1, r2, c2 } = tabFor(range);
        if (r1 === null) continue;
        for (let r = r1; r <= Math.min(r2, tab.values.length - 1); r++) {
          for (let c = c1; c <= c2; c++) {
            if (tab.values[r]?.[c] !== undefined || tab.formulas[`${r},${c}`]) setValue(tab, r, c, '', false);
          }
        }
      }
      return {};
    },
    async insertRows(_id, sheetId, startIndex, count = 1) {
      shiftRows(bySheetId(sheetId).title, startIndex, count);
      return {};
    },
    async deleteRows(_id, sheetId, startIndex, count = 1) {
      shiftRows(bySheetId(sheetId).title, startIndex + count, -count);
      return {};
    },
    async duplicateSheet(_id, sourceSheetId, newSheetName, index) {
      const source = bySheetId(sourceSheetId);
      const copy = {
        ...source,
        title: newSheetName,
        sheetId: Math.max(...order.map((t) => t.sheetId)) + 1,
        values: source.values.map((row) => [...row]),
        formulas: { ...source.formulas },
        dates: new Set(source.dates),
      };
      order.splice(index, 0, copy);
      tabs.set(newSheetName, copy);
      return copy.sheetId;
    },
    async clearValues(_id, range) {
      const { tab, r1, c1 } = tabFor(range);
      setValue(tab, r1, c1, '', false);
      return {};
    },
  };
  // window.__fixtureFail = 'insertRows' (or any method name): its next call fails, like a lost connection.
  // window.__fixtureCalls counts the calls per method (e.g. to check how many reads something needs).
  window.__fixtureCalls = {};
  for (const [name, method] of Object.entries(fixtureApi)) {
    fixtureApi[name] = async (...args) => {
      window.__fixtureCalls[name] = (window.__fixtureCalls[name] || 0) + 1;
      if (window.__fixtureFail === name) {
        window.__fixtureFail = null;
        throw new TypeError('Failed to fetch (fixture)');
      }
      return method(...args);
    };
  }
  return fixtureApi;
}
