// Thin wrapper over the Google Sheets API v4 REST endpoints.

import { getAccessToken } from './auth.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseSpreadsheetId(input) {
  const text = input.trim();
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

// Tab name quoted for A1 notation: My 'tab' -> 'My ''tab'''
export function quoteTab(title) {
  return `'${title.replace(/'/g, "''")}'`;
}

async function call(path, options = {}) {
  const accessToken = getAccessToken();
  if (!accessToken) throw new ApiError(401, 'Not signed in.');
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error.message;
    } catch {
      // Keep statusText.
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export function getSpreadsheet(spreadsheetId) {
  const fields = 'properties(title,locale,timeZone),sheets.properties(sheetId,title,index,hidden,gridProperties)';
  return call(`/${spreadsheetId}?fields=${encodeURIComponent(fields)}`);
}

// render: 'FORMATTED_VALUE' (as displayed), 'UNFORMATTED_VALUE' (raw), or 'FORMULA'.
// dates (ignored for FORMATTED_VALUE): 'SERIAL_NUMBER' (days since 1899-12-30) or 'FORMATTED_STRING'.
export function getValues(spreadsheetId, range, render = 'UNFORMATTED_VALUE', dates = 'SERIAL_NUMBER') {
  const query = new URLSearchParams({ valueRenderOption: render, dateTimeRenderOption: dates });
  return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}?${query}`);
}

// Several ranges in one request; returns valueRanges in the same order.
export function batchGetValues(spreadsheetId, ranges, render = 'UNFORMATTED_VALUE', dates = 'SERIAL_NUMBER') {
  const query = new URLSearchParams({ valueRenderOption: render, dateTimeRenderOption: dates });
  for (const range of ranges) query.append('ranges', range);
  return call(`/${spreadsheetId}/values:batchGet?${query}`);
}

// Cell-level data for one range: what Sheets shows, what was typed (or the formula), number format, dropdowns.
// Returns rowData: [{ values: [{ formattedValue, userEnteredValue, effectiveValue, effectiveFormat, dataValidation }] }].
export async function getGrid(spreadsheetId, range, { validation = true } = {}) {
  const cell = ['formattedValue', 'userEnteredValue', 'effectiveValue', 'effectiveFormat(numberFormat(type))'];
  if (validation) cell.push('dataValidation');
  const fields = `sheets(data(rowData(values(${cell.join(',')}))))`;
  const query = new URLSearchParams({ ranges: range, includeGridData: 'true', fields });
  const result = await call(`/${spreadsheetId}?${query}`);
  return result.sheets?.[0]?.data?.[0]?.rowData || [];
}

// USER_ENTERED: values are interpreted exactly as if typed into Google Sheets (dates, numbers, …).
export function updateValues(spreadsheetId, range, values) {
  const query = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });
  return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}?${query}`, {
    method: 'PUT',
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
}

// RAW: stored exactly as given (a number stays a number, e.g. a date serial in a date-formatted cell).
export function updateValuesRaw(spreadsheetId, range, values) {
  const query = new URLSearchParams({ valueInputOption: 'RAW' });
  return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}?${query}`, {
    method: 'PUT',
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
}

// Writes several cells/ranges in one request. data: [{ range, values }]. RAW keeps values exactly as given.
export function batchUpdateValues(spreadsheetId, data, valueInputOption = 'RAW') {
  return call(`/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption, data: data.map((d) => ({ ...d, majorDimension: 'ROWS' })) }),
  });
}

// Clears the values of several ranges (formatting and dropdowns stay).
export function batchClearValues(spreadsheetId, ranges) {
  return call(`/${spreadsheetId}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges }) });
}

export function batchUpdate(spreadsheetId, requests) {
  return call(`/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
}

// Inserts empty rows at a 0-based row index, like "Insert row" in Sheets: formats, dropdowns and colour
// rules come from the row above (inheritFromBefore) or below, and ranges such as SUM(D4:D1989) grow.
export function insertRows(spreadsheetId, sheetId, startIndex, count = 1, inheritFromBefore = true) {
  return batchUpdate(spreadsheetId, [{
    insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + count }, inheritFromBefore },
  }]);
}

// Deletes rows starting at a 0-based row index, like "Delete row" in Sheets.
export function deleteRows(spreadsheetId, sheetId, startIndex, count = 1) {
  return batchUpdate(spreadsheetId, [{
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + count } },
  }]);
}

// Copies a tab (values, formulas, formatting, dropdowns, colour rules, frozen rows) under a new name at
// position `index`. Returns the new tab's sheetId.
export async function duplicateSheet(spreadsheetId, sourceSheetId, newSheetName, index) {
  const result = await batchUpdate(spreadsheetId, [{
    duplicateSheet: { sourceSheetId, insertSheetIndex: index, newSheetName },
  }]);
  return result.replies[0].duplicateSheet.properties.sheetId;
}

// Deletes a tab (only used to undo creating a year tab, while it's still exactly as it was made).
export function deleteSheet(spreadsheetId, sheetId) {
  return batchUpdate(spreadsheetId, [{ deleteSheet: { sheetId } }]);
}

export function spreadsheetUrl(spreadsheetId, sheetId) {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return sheetId === undefined ? base : `${base}#gid=${sheetId}`;
}

// Removes the values only; formatting, dropdowns and colours stay (like pressing Delete in Sheets).
export function clearValues(spreadsheetId, range) {
  return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, { method: 'POST', body: '{}' });
}
