// Creating a year tab in the spreadsheet (from the main page when a date needs it, or from the raw data
// page's "New…" year). Layout: SHEET_LAYOUT.md, "New year tab".

import { quoteTab } from './sheets.js';
import { summaryColumn, moneyColumn, CARRY_ROW } from './budget.js';
import { isoToSerial } from './dates.js';
import { columnLetter, confirmDialog } from './ui.js';

// Why a tab for this year can't be created, or null if it can. years: existing year tabs, newest first.
export function cannotCreate(yearText, years) {
  if (!/^\d{4}$/.test(yearText)) return 'Enter a year with four digits, e.g. 2027.';
  if (years.includes(yearText)) return `There already is a ${yearText} tab.`;
  if (years.length && Number(yearText) < Number(years[0])) {
    return `Only years after ${years[0]} can be added: a new tab carries the balance over from the newest year.`;
  }
  return null;
}

export function confirmCreate(yearText, latest) {
  return confirmDialog({
    title: `Create the ${yearText} tab?`,
    message: [
      `The spreadsheet has no tab for ${yearText} yet. This creates one in Google Sheets.`,
      `It gets the same layout as ${latest} (headers, totals, formatting, dropdowns, colours), without its entries, and a carry-over row that takes the balance at the end of ${latest}.`,
    ],
    confirm: `Create ${yearText}`,
  });
}

// Copies the newest year's tab, clears its entries and sets up the carry-over row like 2023–2025:
// A4 = 1 January, C4 = "From <previous>", cash-in formulas taking the previous tab's "Owes the other".
// source: the newest tab's sheet properties; sourceHeader: its row 1.
export async function createYearTab({ api, spreadsheetId, yearText, source, sourceHeader }) {
  const owes = summaryColumn(sourceHeader, 'owes');
  if (owes < 0) throw new Error(`Could not find the "Owes the other" column in ${source.title}.`);

  await api.duplicateSheet(spreadsheetId, source.sheetId, yearText, source.index);
  const t = quoteTab(yearText);
  const s = quoteTab(source.title);
  const O = columnLetter(owes);
  const lastRow = source.gridProperties?.rowCount || 2000;
  const cell = (column) => `${t}!${columnLetter(column)}${CARRY_ROW}`;
  // Entries and notes below the carry-over row; leftovers of the source's own helper cells in A2:J3
  // (e.g. 2026's lev→euro conversion) and its currency column P; the carry-over row itself.
  await api.batchClearValues(spreadsheetId, [`${t}!A5:Z${lastRow}`, `${t}!A2:J3`, `${t}!P1:P3`, `${t}!A4:Z4`]);
  await api.batchUpdateValues(spreadsheetId, [
    { range: cell(0), values: [[isoToSerial(`${yearText}-01-01`)]] },
    { range: cell(2), values: [[`From ${source.title}`]] },
  ], 'RAW');
  // Aleks's cash-in gets what Iliyana owed, Iliyana's what Aleks owed (row 2 = Aleks, row 3 = Iliyana).
  await api.batchUpdateValues(spreadsheetId, [
    { range: cell(moneyColumn(0, 'cashIn')), values: [[`=IF(${s}!${O}3 > 0, ${s}!${O}3, )`]] },
    { range: cell(moneyColumn(1, 'cashIn')), values: [[`=IF(${s}!${O}2 > 0, ${s}!${O}2, )`]] },
  ], 'USER_ENTERED');
}
