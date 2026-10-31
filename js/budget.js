// Reads year tabs into entries and totals. Layout: SHEET_LAYOUT.md.
// Input is the tab's values as the Sheets API returns them with UNFORMATTED_VALUE + SERIAL_NUMBER dates.

import { PEOPLE, EURO_FROM_YEAR, BGN_PER_EUR } from './config.js';
import { serialToIso, isoToBg } from './dates.js';

export const CARRY_ROW = 4; // First row after the frozen header; carry-over from the previous year.
const INPUT_COLUMNS = 9; // A..I
// Row 1 headers of A..I. Alternatives separated by |: the sheet's original spellings and corrected ones.
const EXPECTED_HEADERS = [
  'date', 'category|catgory', 'additional information|aditional information',
  'paid by aleks', 'personal aleks', 'aleks cash in',
  'paid by iliyana', 'personal iliyana', 'iliyana cash in',
];

function headerMatches(actual, expected) {
  return expected.split('|').includes(actual);
}

// Summary columns (row 1 header -> field), also accepting the corrected "Owes the other".
const SUMMARY_HEADERS = {
  shared: 'total price',
  half: 'half price',
  cashIn: 'cash in total',
  owes: 'owes the other|owns the other',
};
const MONEY_FIELDS = ['paid', 'personal', 'cashIn'];

// Column index (0-based) of a person's money field: D,E,F for the first person, G,H,I for the second.
export function moneyColumn(personIndex, field) {
  return 3 + personIndex * 3 + MONEY_FIELDS.indexOf(field);
}

export function isYearTab(title) {
  return /^\d{4}$/.test(title.trim());
}

export function currencyOf(year) {
  return year >= EURO_FROM_YEAR ? 'EUR' : 'BGN';
}

export function toEur(amount, year) {
  return year >= EURO_FROM_YEAR ? amount : amount / BGN_PER_EUR;
}

// An amount from the `year` tab in the given currency ('EUR' or 'BGN'), at the fixed rate.
export function convert(amount, year, currency) {
  if (currency === currencyOf(year)) return amount;
  return currency === 'EUR' ? amount / BGN_PER_EUR : amount * BGN_PER_EUR;
}

// How much each person actually paid for an entry, in its tab's currency: { [person key]: amount, combined: amount }.
// A person's amount: their paid and their cash in, both in full (personal is a part of paid, so it adds
// nothing). Together: everything paid plus cash in.
export function spending(entry) {
  const result = { combined: 0 };
  for (const person of PEOPLE) {
    result[person.key] = entry.money[person.key].paid + entry.money[person.key].cashIn;
    result.combined += result[person.key];
  }
  return result;
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function checkHeaders(headerRow) {
  const actual = EXPECTED_HEADERS.map((_, i) => String(headerRow[i] ?? '').trim().toLowerCase());
  const wrong = EXPECTED_HEADERS.filter((h, i) => !headerMatches(actual[i], h));
  const names = EXPECTED_HEADERS.map((h) => h.split('|')[0]).join(', ');
  return wrong.length ? `Unexpected headers in row 1 (expected: ${names}).` : null;
}

function parseEntry(rowNumber, cells, year) {
  const problems = [];
  const rawDate = cells[0];
  let date = null;
  if (typeof rawDate === 'number') date = serialToIso(rawDate);
  else if (!isEmpty(rawDate)) problems.push({ code: 'invalid-date', text: `Date is text "${rawDate}", not a date` });

  const money = {};
  let hasAmount = false;
  PEOPLE.forEach((person, p) => {
    money[person.key] = {};
    for (const field of MONEY_FIELDS) {
      const value = cells[moneyColumn(p, field)];
      let amount = 0;
      if (typeof value === 'number') {
        amount = value;
        hasAmount = true;
      } else if (!isEmpty(value)) {
        // SUM() ignores text, so the sheet counts it as 0 too.
        problems.push({ code: 'bad-amount', text: `Amount "${value}" is text, not a number` });
      }
      money[person.key][field] = amount;
    }
  });

  return {
    kind: 'entry',
    rowNumber,
    year,
    date,
    rawDate: rawDate ?? '',
    category: String(cells[1] ?? '').trim(),
    description: String(cells[2] ?? '').trim(),
    money,
    hasAmount,
    problems,
  };
}

// Per person: shared total (paid - personal), half of it, cash in, and what they owe the other.
// Mirrors the sheet's formulas in L2:O3.
export function computeTotals(entries) {
  const totals = {};
  for (const person of PEOPLE) totals[person.key] = { shared: 0, half: 0, cashIn: 0, owes: 0 };
  for (const entry of entries) {
    for (const person of PEOPLE) {
      const m = entry.money[person.key];
      totals[person.key].shared += m.paid - m.personal;
      totals[person.key].cashIn += m.cashIn;
    }
  }
  const [a, b] = PEOPLE.map((p) => totals[p.key]);
  a.half = a.shared / 2;
  b.half = b.shared / 2;
  a.owes = b.half - a.half - a.cashIn + b.cashIn;
  b.owes = -a.owes;
  return totals;
}

// Reads L2:O3 (located by the row-1 headers) as computed by Sheets.
function readSheetSummary(values) {
  const header = (values[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const col = (names) => header.findIndex((h) => headerMatches(h, names));
  const fields = Object.fromEntries(Object.entries(SUMMARY_HEADERS).map(([field, names]) => [field, col(names)]));
  if (fields.owes < 0) return null;
  const summary = {};
  PEOPLE.forEach((person, p) => {
    const row = values[1 + p] || [];
    summary[person.key] = {};
    for (const [key, c] of Object.entries(fields)) {
      summary[person.key][key] = typeof row[c] === 'number' ? row[c] : null;
    }
  });
  return summary;
}

// '2026-03' -> '03.2026'
function monthBg(month) {
  return `${month.slice(5)}.${month.slice(0, 4)}`;
}

function majority(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  let best = null;
  for (const [item, n] of counts) if (best === null || n > counts.get(best)) best = item;
  return best;
}

// Groups entries into month blocks (separated by blank rows) and flags rows that look misplaced.
function checkOrder(rows, year, tabProblems) {
  const blocks = [];
  let current = null;
  let blankRun = 0;
  for (const row of rows) {
    if (row.kind === 'blank') {
      blankRun++;
      current = null;
      continue;
    }
    if (row.kind !== 'entry') continue;
    if (blankRun > 1 && blocks.length) {
      tabProblems.push({ code: 'extra-blank', rowNumber: row.rowNumber, text: `${blankRun} blank rows before row ${row.rowNumber} (expected 1)` });
    }
    blankRun = 0;
    if (!current) {
      current = { entries: [] };
      blocks.push(current);
    }
    current.entries.push(row);
  }

  let previousDate = null;
  let previousMonth = null;
  for (const block of blocks) {
    block.month = majority(block.entries.filter((e) => e.date).map((e) => e.date.slice(0, 7)));
    const first = block.entries[0].rowNumber;
    const last = block.entries.at(-1).rowNumber;
    if (block.month && previousMonth && block.month <= previousMonth) {
      tabProblems.push({
        code: 'month-order',
        rowNumber: first,
        text: block.month === previousMonth
          ? `Rows ${first}–${last}: second block for ${monthBg(block.month)} (extra blank row inside the month?)`
          : `Rows ${first}–${last}: month ${monthBg(block.month)} comes after ${monthBg(previousMonth)}`,
      });
    }
    if (block.month) previousMonth = block.month;

    for (const entry of block.entries) {
      if (!entry.category) entry.problems.push({ code: 'no-category', text: 'No category' });
      if (!entry.hasAmount) entry.problems.push({ code: 'no-amount', text: 'No amount' });
      if (!entry.date) continue;
      const misplaced = Number(entry.date.slice(0, 4)) !== year || (block.month && entry.date.slice(0, 7) !== block.month);
      if (Number(entry.date.slice(0, 4)) !== year) {
        entry.problems.push({ code: 'wrong-year', text: `Date ${isoToBg(entry.date)} is not in ${year}` });
      } else if (block.month && entry.date.slice(0, 7) !== block.month) {
        entry.problems.push({ code: 'wrong-month', text: `Date ${isoToBg(entry.date)} is in the block for ${monthBg(block.month)}` });
      }
      if (misplaced) continue; // Don't let a wrong date make the following rows look out of order.
      if (previousDate && entry.date < previousDate) {
        entry.problems.push({ code: 'out-of-order', text: `Date ${isoToBg(entry.date)} is earlier than the row above (${isoToBg(previousDate)})` });
      }
      previousDate = entry.date;
    }
  }
  return blocks;
}

export function parseYearTab(title, values) {
  const year = Number(title);
  const tabProblems = [];
  const layoutProblem = checkHeaders(values[0] || []);

  const rows = [];
  for (let i = CARRY_ROW - 1; i < values.length; i++) {
    const cells = (values[i] || []).slice(0, INPUT_COLUMNS);
    const rowNumber = i + 1;
    if (cells.every(isEmpty)) rows.push({ kind: 'blank', rowNumber });
    else rows.push(parseEntry(rowNumber, cells, year));
  }
  while (rows.length && rows.at(-1).kind === 'blank') rows.pop();

  // Row 4 without a category is the carry-over (2022, the first year, starts with a normal entry).
  let carry = null;
  if (rows[0]?.kind === 'entry' && rows[0].rowNumber === CARRY_ROW && !rows[0].category) {
    carry = rows[0];
    carry.kind = 'carry';
  }

  const blocks = checkOrder(rows, year, tabProblems);
  const entries = rows.filter((r) => r.kind === 'entry');
  const counted = carry ? [carry, ...entries] : entries;
  const totals = computeTotals(counted);
  const sheetSummary = readSheetSummary(values);

  if (sheetSummary) {
    for (const person of PEOPLE) {
      const fromSheet = sheetSummary[person.key].owes;
      if (fromSheet !== null && Math.abs(fromSheet - totals[person.key].owes) > 0.005) {
        tabProblems.push({
          code: 'balance-mismatch',
          text: `${person.name}: the app calculates ${totals[person.key].owes.toFixed(2)}, the sheet shows ${fromSheet.toFixed(2)}`,
        });
      }
    }
  } else {
    tabProblems.push({ code: 'no-summary', text: 'Could not find the "Owes the other" column in row 1' });
  }

  return {
    title,
    year,
    values, // As read: what the page shows comes from these (editing checks against them).
    currency: currencyOf(year),
    layoutProblem,
    rows,
    carry,
    entries,
    blocks,
    totals,
    sheetSummary,
    tabProblems,
  };
}

// ---- Where entries go (rules agreed for the sheet) ----
// Months are blocks of rows with one blank row between them; entries inside a month are sorted by date.

// Where a new entry dated `iso` goes in a parsed year tab. Returns { row, insert }:
//   row     1-based row the entry is written to;
//   insert  how many empty rows to insert at `row` first: 0 = the row is already free (after the data),
//           1 = inside an existing month, 2 = a new month before others (the entry, then a blank row).
export function placeEntry(year, iso) {
  const month = iso.slice(0, 7);
  const blocks = year.blocks.filter((b) => b.month);
  const lastRow = year.rows.length ? year.rows.at(-1).rowNumber : CARRY_ROW - 1;

  const sameMonth = blocks.find((b) => b.month === month);
  if (sameMonth) {
    // After the last entry that isn't later (entries on the same day keep their order), else first.
    let after = null;
    for (const entry of sameMonth.entries) if (entry.date && entry.date <= iso) after = entry;
    const row = after ? after.rowNumber + 1 : sameMonth.entries[0].rowNumber;
    return { row, insert: row > lastRow ? 0 : 1 };
  }

  const laterMonth = blocks.find((b) => b.month > month);
  if (laterMonth) return { row: laterMonth.entries[0].rowNumber, insert: 2 };
  // After all months: the first entry right below the carry-over, otherwise one blank row, then the entry.
  if (!blocks.length) return { row: Math.max(lastRow + 1, CARRY_ROW + 1), insert: 0 };
  return { row: lastRow + 2, insert: 0 };
}

// Rows to delete to remove an entry; a month left empty also loses one blank separator row.
// Returns { start, count } (1-based first row, number of rows).
export function rowsToDelete(year, rowNumber) {
  const block = year.blocks.find((b) => b.entries.some((e) => e.rowNumber === rowNumber));
  if (!block || block.entries.length > 1) return { start: rowNumber, count: 1 };
  const kindAt = (r) => year.rows.find((row) => row.rowNumber === r)?.kind;
  if (kindAt(rowNumber + 1) === 'blank') return { start: rowNumber, count: 2 };
  if (kindAt(rowNumber - 1) === 'blank') return { start: rowNumber - 1, count: 2 };
  return { start: rowNumber, count: 1 };
}

// Whether an entry can simply get a new date without moving: same month, still between its neighbours.
export function staysInPlace(year, entry, iso) {
  const block = year.blocks.find((b) => b.entries.includes(entry));
  if (!block || !block.month || iso.slice(0, 7) !== block.month || Number(iso.slice(0, 4)) !== year.year) return false;
  const i = block.entries.indexOf(entry);
  const prev = block.entries[i - 1]?.date;
  const next = block.entries[i + 1]?.date;
  return (!prev || prev <= iso) && (!next || iso <= next);
}

// 0-based column of a summary field ('owes', 'shared', …) from a tab's header row.
export function summaryColumn(headerRow, field) {
  const header = (headerRow || []).map((h) => String(h ?? '').trim().toLowerCase());
  return header.findIndex((h) => headerMatches(h, SUMMARY_HEADERS[field]));
}

export async function identifyPerson(email) {
  if (!email || !crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return PEOPLE.find((p) => p.emailSha256 === hex) || null;
}
