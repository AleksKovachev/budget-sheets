// Raw data page: a year tab as a grid, edited like Google Sheets.
// - Locked: cells with formulas, and the frozen header rows (totals) of year tabs.
// - Dates show as dd.mm.yyyy, are accepted in many short forms, and have a calendar popup.
// - Cells with a dropdown in Sheets get the same choices (the app's own list, opens on one click).
// - Rows are coloured by category like in the sheet; rows can be inserted and deleted from the row number.
// - The grid re-reads the tab regularly (the current year often, older years about once a minute).

import { isConfigured, initAuth, signIn, dropToken, getAccessToken, watchIdle, IDLE_MS } from './auth.js';
import {
  ApiError, quoteTab, getSpreadsheet, getGrid, batchGetValues,
  updateValues, updateValuesRaw, clearValues, insertRows, deleteRows, batchUpdateValues, batchClearValues, duplicateSheet,
  spreadsheetUrl,
} from './sheets.js';
import { serialToBg, bgToIso, isoToBg, isoToSerial } from './dates.js';
import { isYearTab, CARRY_ROW } from './budget.js';
import { fixtureRequested, loadFixtureApi, showFixtureBanner } from './fixture.js';
import { storage, SHEET_KEY, TAB_KEY } from './storage.js';
import {
  $, el, showError, columnLetter, setUpPage, withLoading, showSessionBanner, openDialog, dialogButton, touchInput,
} from './ui.js';
import { cannotCreate, confirmCreate, createYearTab } from './yeartabs.js';
import { icon, categoryIcon } from './icons.js';
import { startSync, SYNC_INTERVAL_MS, PAST_YEARS_MS } from './sync.js';
import { openDatePopup, closeDatePopup } from './calendar.js';
import { categoryStyle } from './config.js';

const MAX_ROWS = 1000;
const EXTRA_ROWS = 20; // Empty rows shown below the data, so they can be typed into.
const MIN_COLUMNS = 9; // A..I: all input columns of a year tab.
const MAX_COLUMN_PX = 320;
const CATEGORY_COLUMN = 1; // B
const COLOURED_COLUMNS = 9; // A..I are coloured by category, as in the sheet.
const FOCUS_KEY = 'bs.tableFocus';
const VIEWS = ['view-message', 'view-signin', 'view-raw'];
// Phones (portrait, or landscape with little height): tighter grid, one-line header rows.
const compactQuery = window.matchMedia('(max-width: 600px), (max-height: 500px)');

let api = {
  getSpreadsheet, getGrid, batchGetValues, updateValues, updateValuesRaw, clearValues, insertRows, deleteRows,
  batchUpdateValues, batchClearValues, duplicateSheet,
};
const ROW_CLIPBOARD_KEY = 'bs.rowClipboard';
let fixture = false;
let spreadsheetId = null;
let meta = null;
let yearTitles = []; // Newest first.
let tab = null;
let cells = []; // cells[r][c]: see toCell()
let validations = new Map(); // 'r,c' -> { options: [...] } or { date: true } (from the last full load)
let dataRows = 0;
let editing = null; // { td, r, c, control, original }
let busy = false; // A save or load is running; syncing waits.
let sync = null;
let selectedRow = null; // 0-based row marked across the grid (tap its number or a cell in it).

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
}

function showMessage(text) {
  $('message-text').textContent = text;
  show('view-message');
}

function setStatus(text) {
  $('status').textContent = text;
}

async function run(action, { overlay = true } = {}) {
  if (overlay) showError(null);
  try {
    await (overlay ? withLoading(action) : action());
  } catch (err) {
    if (err.status === 401) {
      dropToken();
      // With the table on screen, keep it and ask to sign in again; otherwise show the sign-in card.
      if (sync) showSessionBanner(sync.renew);
      else showSignIn(false);
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      showError(new Error('This Google account has no access to that spreadsheet, or isn\'t allowed to edit it.'));
    } else {
      showError(err);
    }
    console.error(err);
  }
}

async function start() {
  setUpPage();
  setUpFocusMode();
  fixture = fixtureRequested();
  if (fixture) {
    showFixtureBanner();
    for (const link of [$('home'), $('back')]) link.href = 'index.html?fixture';
    $('hint').textContent = 'Fixture data: edits only change a copy in memory.';
    await run(async () => {
      api = await loadFixtureApi();
      spreadsheetId = 'fixture';
      await open();
    });
    return;
  }
  if (!isConfigured()) {
    showMessage('No Google client ID is configured yet (see SETUP.md).');
    return;
  }
  let ended;
  try {
    ended = await initAuth();
  } catch (err) {
    showMessage(err.message);
    return;
  }
  // (The default spreadsheet is opened, and remembered, by the main page.)
  spreadsheetId = storage.local.get(SHEET_KEY);
  if (!spreadsheetId) {
    showMessage('No spreadsheet has been chosen yet. Open the main page (Budget Sheets, top left) first.');
    return;
  }
  watchIdle((idle) => {
    closePopups();
    if (editing) cancelEdit();
    sync?.pause();
    showError(null);
    showSignIn(idle);
  });
  if (getAccessToken()) await run(open);
  else showSignIn(ended === 'idle');
}

function showSignIn(idle) {
  $('signin-note').hidden = !idle;
  $('signin-note').textContent = idle ? `Signed out after ${IDLE_MS / 60_000} minutes without use.` : '';
  show('view-signin');
}

async function open() {
  meta = await api.getSpreadsheet(spreadsheetId);
  $('sheet-title').textContent = `Raw data · ${meta.properties.title}`;
  show('view-raw');

  fillYears();
  const wanted = new URLSearchParams(location.search).get('tab') || storage.local.get(TAB_KEY);
  const first = yearTitles.includes(wanted) ? wanted : yearTitles[0];
  $('tab-select').value = first;
  await loadTab(first);
  // The current year can change any moment; older years only when fixing something.
  sync?.resume();
  sync ??= startSync(syncNow, { interval: () => (tab === yearTitles[0] ? SYNC_INTERVAL_MS : PAST_YEARS_MS), offline: fixture });
}

// The year dropdown: "New…" at the top (it adds the next year), a separator line, then the year tabs,
// newest first (the other tabs are edited in Google Sheets).
const NEW_YEAR = '__new';
function fillYears() {
  yearTitles = meta.sheets.map((s) => s.properties.title).filter(isYearTab).sort((a, b) => b.localeCompare(a));
  const select = $('tab-select');
  const create = el('option', null, 'New…');
  create.value = NEW_YEAR;
  // (Phones show their own list, which leaves the line out.)
  select.replaceChildren(create, el('hr'), ...yearTitles.map((t) => el('option', null, t)));
  select.value = tab && yearTitles.includes(tab) ? tab : yearTitles[0];
}

// Re-reads the tab list (tabs can be added or deleted in Google Sheets). Returns true if it changed;
// if the open year is gone, opens the newest one.
let metaReadAt = 0;
const META_INTERVAL_MS = 30_000;
async function reloadMeta() {
  meta = await api.getSpreadsheet(spreadsheetId);
  metaReadAt = Date.now();
  const before = yearTitles.join();
  fillYears();
  if (yearTitles.join() === before) return false;
  if (!yearTitles.includes(tab)) {
    showError(new Error(`The ${tab} tab was deleted in Google Sheets; showing ${yearTitles[0]}.`));
    $('tab-select').value = yearTitles[0];
    await loadTab(yearTitles[0]);
  }
  return true;
}

// "New…" in the year dropdown: asks for the year, then creates its tab like the main page does.
async function newYearTab() {
  $('tab-select').value = tab; // Until the new tab exists.
  await reloadMeta();
  const suggested = String(Number(yearTitles[0]) + 1);
  const yearText = await askYear(suggested);
  if (!yearText) return;
  if (!(await confirmCreate(yearText, yearTitles[0]))) return;
  await withLoading(async () => {
    const source = meta.sheets.find((s) => s.properties.title === yearTitles[0]).properties;
    const values = await api.batchGetValues(spreadsheetId, [`${quoteTab(source.title)}!A1:Z1`], 'FORMATTED_VALUE');
    await createYearTab({ api, spreadsheetId, yearText, source, sourceHeader: values.valueRanges[0].values?.[0] || [] });
    await reloadMeta();
    $('tab-select').value = yearText;
    await loadTab(yearText);
  });
  setStatus(`Created the ${yearText} tab in Google Sheets.`);
}

// Small dialog asking for a year; resolves the year text, or null if cancelled.
function askYear(suggested) {
  return new Promise((resolve) => {
    let result = null;
    const { body, foot, close } = openDialog({ title: 'New year tab', className: 'confirm', onClose: () => resolve(result) });
    const input = el('input');
    input.value = suggested;
    input.inputMode = 'numeric';
    input.maxLength = 4;
    const error = el('div', 'form-error');
    const label = el('label', 'form-field');
    label.append(el('span', 'form-label', 'Year'), input);
    body.append(label, error);
    const ok = () => {
      const problem = cannotCreate(input.value.trim(), yearTitles);
      if (problem) {
        error.textContent = problem;
        return;
      }
      result = input.value.trim();
      close('ok');
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        ok();
      }
    });
    foot.append(dialogButton('Cancel', null, () => close('cancel')), dialogButton('Continue', 'primary', ok));
    input.focus();
    input.select();
  });
}

function sheetProps() {
  return meta.sheets.find((s) => s.properties.title === tab)?.properties;
}

function frozenRows() {
  return sheetProps()?.gridProperties?.frozenRowCount || 0;
}

// ---- Cell model ----

function toCell(data, validation) {
  const entered = data?.userEnteredValue;
  const effective = data?.effectiveValue;
  const isFormula = entered?.formulaValue !== undefined;
  const type = data?.effectiveFormat?.numberFormat?.type;
  const isDate = type === 'DATE' || type === 'DATE_TIME' || Boolean(validation?.date);
  const serial = typeof effective?.numberValue === 'number' ? effective.numberValue : null;
  const shown = isDate && serial !== null ? serialToBg(serial) : data?.formattedValue ?? '';
  return {
    shown, // What the grid shows (dates as dd.mm.yyyy).
    formula: isFormula ? entered.formulaValue : null,
    isDate,
    isNumber: serial !== null && !isDate,
    options: validation?.options || null,
    signature: JSON.stringify(entered ?? null), // To detect changes made elsewhere.
  };
}

const EMPTY = toCell(null, null);

function cellAt(r, c) {
  return cells[r]?.[c] || (validations.has(`${r},${c}`) ? toCell(null, validations.get(`${r},${c}`)) : EMPTY);
}

// Header rows of a year tab hold only totals and formulas: locked as a whole.
function isLocked(r, c) {
  return Boolean(cellAt(r, c).formula) || (isYearTab(tab) && r < frozenRows());
}

// Dropdowns (a fixed list, or a range such as List!A2:A50) and date checks, from the sheet's data validation.
async function readValidations(rowData) {
  const map = new Map();
  const ranges = new Map(); // range -> [keys]
  rowData.forEach((row, r) => (row.values || []).forEach((data, c) => {
    const condition = data?.dataValidation?.condition;
    const key = `${r},${c}`;
    if (condition?.type === 'ONE_OF_LIST') {
      map.set(key, { options: (condition.values || []).map((v) => v.userEnteredValue) });
    } else if (condition?.type === 'ONE_OF_RANGE') {
      const range = String(condition.values?.[0]?.userEnteredValue || '').replace(/^=/, '');
      if (!ranges.has(range)) ranges.set(range, []);
      ranges.get(range).push(key);
    } else if (condition?.type === 'DATE_IS_VALID' || /DATEVALUE/i.test(condition?.values?.[0]?.userEnteredValue || '')) {
      map.set(key, { date: true });
    }
  }));
  if (ranges.size) {
    const list = [...ranges.keys()];
    const result = await api.batchGetValues(spreadsheetId, list, 'FORMATTED_VALUE');
    list.forEach((range, i) => {
      const options = (result.valueRanges[i].values || []).flat().map(String).filter((v) => v.trim() !== '');
      for (const key of ranges.get(range)) map.set(key, { options });
    });
  }
  return map;
}

function buildCells(rowData) {
  const out = [];
  let lastRow = 0;
  rowData.forEach((row, r) => {
    out[r] = (row.values || []).map((data, c) => toCell(data, validations.get(`${r},${c}`) || null));
    if (out[r].some((cell) => cell.shown !== '' || cell.formula)) lastRow = r + 1;
  });
  return { cells: out, dataRows: lastRow };
}

// ---- Loading and rendering ----

async function loadTab(title) {
  closePopups();
  if (title !== tab) selectedRow = null;
  tab = title;
  storage.local.set(TAB_KEY, title);
  history.replaceState(null, '', `?tab=${encodeURIComponent(title)}${fixture ? '&fixture' : ''}`);
  $('btn-sheets').href = fixture ? '#' : spreadsheetUrl(spreadsheetId, sheetProps()?.sheetId);
  await reloadTab();
  sync?.reschedule();
}

// Reads the whole tab again (values and dropdowns) and redraws it.
async function reloadTab() {
  const title = tab;
  setStatus('Loading…');
  busy = true;
  try {
    const rowData = await api.getGrid(spreadsheetId, quoteTab(title));
    if (tab !== title) return; // Another tab was chosen meanwhile.
    validations = await readValidations(rowData);
    ({ cells, dataRows } = buildCells(rowData));
    renderGrid();
  } finally {
    busy = false;
  }
}

function displayText(r, c) {
  const cell = cellAt(r, c);
  return $('render').value === 'FORMULA' && cell.formula ? cell.formula : cell.shown;
}

// The "Owes the other" column (found by its header in row 1, old spelling "Owns" too): results red and bold.
function owesColumn() {
  return (cells[0] || []).findIndex((cell) => /ow[ne]s the other/i.test(cell.shown));
}

// Category colour of a data row of a year tab (as the sheet's conditional formatting does).
function rowColour(r) {
  if (!isYearTab(tab) || r < frozenRows()) return null;
  const category = cellAt(r, CATEGORY_COLUMN).shown;
  // Like the sheet's rule AND($A4<>"", $B4=""): a date without a category (e.g. the carry-over row) is grey.
  if (!category) return cellAt(r, 0).shown ? '#999999' : null;
  return categoryStyle(category)?.color || null;
}

function decorate(td, r, c) {
  const cell = cellAt(r, c);
  td.replaceChildren(el('span', 'cell-text', displayText(r, c)));
  td.className = '';
  td.removeAttribute('title');
  const colour = c < COLOURED_COLUMNS ? rowColour(r) : null;
  if (colour) {
    td.classList.add('cat-row');
    td.style.setProperty('--rowcat', colour);
  } else {
    td.style.removeProperty('--rowcat');
  }
  if (cell.isNumber) td.classList.add('num');
  if (r > 0 && r < frozenRows() && c === owesColumn()) td.classList.add('owes');
  if (isLocked(r, c)) {
    td.classList.add('locked');
    if (cell.formula) td.classList.add('formula');
    td.title = cell.formula ? 'Formula: change it in Google Sheets' : 'Header row: locked';
    return;
  }
  td.classList.add('editable');
  if (cell.options) td.classList.add('list');
  if (cell.isDate) {
    td.classList.add('date');
    const button = el('button', 'cell-cal');
    button.type = 'button';
    button.title = 'Pick a date';
    button.tabIndex = -1;
    button.append(icon('calendar'));
    td.append(button);
  }
}

// Column widths from the content, capped so one long text can't stretch the table.
// Header rows wrap on large screens (only their longest word counts) and stay on one line on phones.
function measureColumns(rows, columns) {
  const context = document.createElement('canvas').getContext('2d');
  context.font = `14px ${getComputedStyle(document.body).fontFamily}`;
  const textWidth = (text) => context.measureText(text).width;
  const frozen = frozenRows();
  const wrapHeaders = !compactQuery.matches;
  const widths = [];
  for (let c = 0; c < columns; c++) {
    let width = textWidth(columnLetter(c));
    for (let r = 0; r < rows; r++) {
      const text = displayText(r, c);
      if (!text) continue;
      const w = r < frozen && wrapHeaders ? Math.max(...text.split(/\s+/).map(textWidth)) : textWidth(text);
      width = Math.max(width, w);
    }
    let extra = compactQuery.matches ? 14 : 22; // padding, border, and a little room for font differences
    if ([frozen, frozen + 1, frozen + 2].some((r) => cellAt(r, c).isDate)) extra += 24;
    if (cellAt(frozen + 1, c).options) extra += 14;
    widths.push(Math.min(MAX_COLUMN_PX, Math.max(40, Math.ceil(width + extra))));
  }
  return widths;
}

function renderGrid() {
  const wrap = document.querySelector('.grid-wrap');
  const scroll = { top: wrap.scrollTop, left: wrap.scrollLeft };
  const props = sheetProps()?.gridProperties;
  const dataColumns = Math.max(0, ...cells.slice(0, dataRows).map((row) => {
    let last = 0;
    (row || []).forEach((cell, c) => { if (cell.shown !== '' || cell.formula) last = c + 1; });
    return last;
  }));
  let rows = Math.min(MAX_ROWS, dataRows + EXTRA_ROWS);
  let columns = Math.max(dataColumns, MIN_COLUMNS);
  if (props) {
    rows = Math.min(rows, props.rowCount);
    columns = Math.min(columns, props.columnCount);
  }

  // Fixed column widths: editing a cell never changes the layout.
  const widths = measureColumns(rows, columns);
  const numberWidth = compactQuery.matches ? 34 : 48;
  const table = $('grid');
  table.classList.toggle('compact', compactQuery.matches);
  table.replaceChildren();
  const colgroup = el('colgroup');
  for (const w of [numberWidth, ...widths]) {
    const col = el('col');
    col.style.width = `${w}px`;
    colgroup.append(col);
  }
  table.append(colgroup);
  const tableWidth = numberWidth + widths.reduce((a, b) => a + b, 0);
  table.style.width = `${tableWidth}px`;
  // The page's buttons line up with the table's right edge (table + borders + vertical scrollbar).
  document.documentElement.style.setProperty('--content-w', `${tableWidth + 2 + scrollbarWidth()}px`);

  // The column letters and the rows frozen in Google Sheets form the table head, which sticks to the
  // top as one block: no per-row offsets, so no seams or size changes while scrolling.
  const thead = table.createTHead();
  const letters = thead.insertRow();
  letters.className = 'letters';
  letters.append(el('th', 'corner'));
  for (let c = 0; c < columns; c++) letters.append(el('th', null, columnLetter(c)));

  const frozen = Math.min(frozenRows(), rows);
  const body = table.createTBody();
  for (let r = 0; r < rows; r++) {
    const tr = r < frozen ? thead.insertRow() : body.insertRow();
    if (r < frozen) tr.className = r === frozen - 1 ? 'frozen frozen-last' : 'frozen';
    else if (r === selectedRow) tr.className = 'selected';
    const number = el('th', 'row-number', String(r + 1));
    number.dataset.r = r;
    number.title = 'Row options (insert, copy, paste, clear, delete): click, right-click, or press and hold the row';
    tr.append(number);
    for (let c = 0; c < columns; c++) {
      const td = tr.insertCell();
      td.dataset.r = r;
      td.dataset.c = c;
      decorate(td, r, c);
    }
  }
  wrap.scrollTop = scroll.top;
  wrap.scrollLeft = scroll.left;
  const cut = dataRows > MAX_ROWS ? ` · showing the first ${MAX_ROWS}` : '';
  setStatus(`${dataRows} rows with data${cut}`);
}

let scrollbarPx = null;
function scrollbarWidth() {
  if (scrollbarPx === null) {
    const probe = el('div');
    probe.style.cssText = 'position:absolute;top:-999px;width:100px;height:100px;overflow:scroll';
    document.body.append(probe);
    scrollbarPx = probe.offsetWidth - probe.clientWidth;
    probe.remove();
  }
  return scrollbarPx;
}

function tdAt(r, c) {
  return $('grid').querySelector(`td[data-r="${r}"][data-c="${c}"]`);
}

// ---- Popups: dropdown choices, row menu ----

let popup = null;
let popupAnchor = null; // Cell or row number the popup belongs to (shown as "open").

function closePopups() {
  popup?.remove();
  popupAnchor?.classList.remove('is-open');
  popup = null;
  popupAnchor = null;
  closeDatePopup();
}

// Places a popup below (or above) an element, inside the screen.
function placePopup(node, anchor) {
  popupAnchor = anchor;
  anchor.classList.add('is-open');
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth;
  const left = Math.min(Math.max(8, rect.left), viewWidth - node.offsetWidth - 8);
  const below = rect.bottom + 4 + node.offsetHeight <= window.innerHeight;
  const top = below ? rect.bottom + 4 : Math.max(8, rect.top - node.offsetHeight - 4);
  node.style.left = `${left + window.scrollX}px`;
  node.style.top = `${top + window.scrollY}px`;
  node.addEventListener('pointerdown', (event) => event.stopPropagation());
  popup = node;
}

document.addEventListener('pointerdown', () => {
  if (popup) closePopups();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && popup) closePopups();
});

// Dropdown cell: the sheet's choices with category colours; one click opens it.
function openChoices(td, r, c) {
  closePopups();
  const cell = cellAt(r, c);
  const current = matchOption(cell.options, cell.shown) ?? cell.shown;
  const list = el('div', 'choice-list');
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  const choices = ['', ...cell.options];
  if (current && !cell.options.includes(current)) choices.splice(1, 0, current); // Value not in the list: keep it.

  for (const option of choices) {
    const item = el('div', 'choice');
    item.setAttribute('role', 'option');
    item.dataset.value = option;
    const style = categoryStyle(option);
    const badge = el('span', 'cat-badge small');
    badge.style.setProperty('--cat', style?.badge || 'transparent');
    if (style) badge.style.setProperty('--cat-ink', style.ink);
    if (style) badge.append(categoryIcon(style));
    item.append(badge, el('span', null, option || '(empty)'));
    if (option === current) item.classList.add('selected');
    item.addEventListener('click', () => {
      closePopups();
      if (option !== current) run(() => saveCell(r, c, option));
    });
    list.append(item);
  }
  list.addEventListener('keydown', (event) => {
    const items = [...list.children];
    let index = items.findIndex((i) => i.classList.contains('active'));
    if (index < 0) index = items.findIndex((i) => i.classList.contains('selected'));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      index = Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((i, n) => i.classList.toggle('active', n === index));
      items[index].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault();
      items[index].click();
    }
  });
  placePopup(list, td);
  list.style.minWidth = `${td.offsetWidth}px`;
  list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  list.focus();
}

// Dropdown value matching what the cell shows (ignoring case and spaces at the ends).
function matchOption(options, value) {
  const wanted = String(value).trim().toLowerCase();
  return options.find((o) => o.trim().toLowerCase() === wanted);
}

// Row number menu: insert above / below, copy / paste / clear, delete (most used first).
function openRowMenu(th, r) {
  closePopups();
  // Rows 1-4 of a year tab (headers and carry-over) keep their place and content: nothing is inserted
  // above row 5, and they can't be pasted over, cleared or deleted.
  const firstEntryIndex = CARRY_ROW; // 0-based index of row 5
  const isEntryRow = r >= firstEntryIndex;
  const hasContent = rowHasContent(r);
  const clipboard = readRowClipboard();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const item = (label, iconName, enabled, action, note) => {
    const button = el('button', 'menu-item');
    button.type = 'button';
    button.append(icon(iconName), el('span', null, label));
    if (note) button.title = note;
    button.disabled = !enabled;
    button.addEventListener('click', () => {
      closePopups();
      run(action);
    });
    menu.append(button);
  };
  menu.append(el('div', 'menu-title', `Row ${r + 1}`));
  item('Insert row above', 'rowAbove', isEntryRow, () => insertRow(r, r));
  item('Insert row below', 'rowBelow', r >= firstEntryIndex - 1, () => insertRow(r, r + 1));
  menu.append(el('div', 'menu-sep'));
  item('Copy row', 'copy', isEntryRow && hasContent, () => copyRow(r));
  item('Paste row', 'paste', isEntryRow && Boolean(clipboard), () => pasteRow(r), clipboard ? `Copied from ${clipboard.from}` : 'Copy a row first');
  item('Clear row', 'eraser', isEntryRow && hasContent, () => clearRow(r));
  menu.append(el('div', 'menu-sep'));
  item('Delete row', 'trash', isEntryRow && r < dataRows, () => deleteRow(r));
  placePopup(menu, th);
}

// ---- Row copy / paste / clear (columns A–I, the entry's own cells; formulas are never copied or overwritten) ----

function rowHasContent(r) {
  return Array.from({ length: MIN_COLUMNS }, (_, c) => cellAt(r, c)).some((cell) => cell.shown !== '' && !cell.formula);
}

function readRowClipboard() {
  try {
    return JSON.parse(storage.local.get(ROW_CLIPBOARD_KEY));
  } catch {
    return null;
  }
}

async function copyRow(r) {
  const values = Array.from({ length: MIN_COLUMNS }, (_, c) => {
    const cell = cellAt(r, c);
    return cell.formula || cell.shown === '' ? null : JSON.parse(cell.signature); // The value as entered.
  });
  const shown = Array.from({ length: MIN_COLUMNS }, (_, c) => (cellAt(r, c).formula ? '' : cellAt(r, c).shown));
  storage.local.set(ROW_CLIPBOARD_KEY, JSON.stringify({ values, shown, from: `${tab}, row ${r + 1}` }));
  // Also as text, so it can be pasted into Google Sheets or elsewhere.
  try {
    await navigator.clipboard.writeText(shown.join('\t'));
  } catch {
    // The system clipboard isn't available everywhere; pasting inside the app still works.
  }
  setStatus(`Copied row ${r + 1}`);
}

function enteredToValue(entered) {
  if (!entered) return null;
  if ('numberValue' in entered) return entered.numberValue;
  if ('boolValue' in entered) return entered.boolValue;
  if ('stringValue' in entered) return entered.stringValue;
  return null; // Formulas and errors are not pasted.
}

// Re-reads one row from Sheets and redraws it.
async function refreshRowFromSheet(r) {
  const lastColumn = columnLetter(Math.max(MIN_COLUMNS, ...cells.map((row) => row?.length || 0)) - 1);
  const [row] = await api.getGrid(spreadsheetId, `${quoteTab(tab)}!A${r + 1}:${lastColumn}${r + 1}`, { validation: false });
  const width = Math.max(row?.values?.length || 0, cells[r]?.length || 0);
  for (let c = 0; c < width; c++) updateCellFrom(r, c, row?.values?.[c]);
  refreshRow(r);
}

async function pasteRow(r) {
  const clipboard = readRowClipboard();
  if (!clipboard) return;
  if (rowHasContent(r) && !window.confirm(`Replace row ${r + 1}?\n\nNow: ${rowSummary(r)}\nPaste: ${clipboard.shown.filter(Boolean).join(' · ')}`)) return;
  busy = true;
  try {
    if (!(await rowUnchanged(r))) {
      await refreshRowFromSheet(r);
      throw new Error(`Row ${r + 1} was changed in Google Sheets in the meantime. Nothing was pasted; it now shows the new values.`);
    }
    const writes = [];
    const clears = [];
    for (let c = 0; c < MIN_COLUMNS; c++) {
      const target = cellAt(r, c);
      if (target.formula) continue; // Never overwrite a formula.
      const range = `${quoteTab(tab)}!${columnLetter(c)}${r + 1}`;
      const value = enteredToValue(clipboard.values[c]);
      if (value === null) {
        if (target.shown !== '') clears.push(range);
      } else {
        writes.push({ range, values: [[value]] });
      }
    }
    if (writes.length) await api.batchUpdateValues(spreadsheetId, writes, 'RAW');
    if (clears.length) await api.batchClearValues(spreadsheetId, clears);
    await refreshRowFromSheet(r);
  } finally {
    busy = false;
  }
  setStatus(`Pasted into row ${r + 1}`);
  flash(r, 0, 'saved');
}

async function clearRow(r) {
  if (!window.confirm(`Clear row ${r + 1}? The row stays, its values are removed.\n\n${rowSummary(r)}`)) return;
  busy = true;
  try {
    if (!(await rowUnchanged(r))) {
      await refreshRowFromSheet(r);
      throw new Error(`Row ${r + 1} was changed in Google Sheets in the meantime. Nothing was cleared; it now shows the new values.`);
    }
    const ranges = [];
    for (let c = 0; c < MIN_COLUMNS; c++) {
      const cell = cellAt(r, c);
      if (!cell.formula && cell.shown !== '') ranges.push(`${quoteTab(tab)}!${columnLetter(c)}${r + 1}`);
    }
    if (ranges.length) await api.batchClearValues(spreadsheetId, ranges);
    await refreshRowFromSheet(r);
  } finally {
    busy = false;
  }
  setStatus(`Cleared row ${r + 1}`);
}

// ---- Editing ----

function beginEdit(td, r, c) {
  closePopups();
  const cell = cellAt(r, c);
  const original = cell.shown;
  const control = el('input');
  control.value = original;
  if (cell.isDate) control.placeholder = 'dd.mm.yyyy';
  const editor = el('div', 'cell-editor');
  editor.append(control);

  control.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishEdit(true);
    } else if (event.key === 'Escape') {
      finishEdit(false);
    }
  });
  control.addEventListener('blur', () => finishEdit(true));

  td.classList.add('editing');
  td.replaceChildren(editor);
  control.focus();
  control.select();
  editing = { td, r, c, control, original };
}

function cancelEdit() {
  if (!editing) return;
  const { td, r, c } = editing;
  editing = null;
  if (td.isConnected) decorate(td, r, c);
}

function finishEdit(save) {
  if (!editing) return;
  const { td, r, c, control, original } = editing;
  editing = null; // Before touching the DOM: removing the input fires blur again.
  const text = control.value;
  decorate(td, r, c);
  if (save && text !== original) run(() => saveCell(r, c, text));
}

// Turns what was entered into the value to write, the way Google Sheets would understand it.
function prepareValue(cell, text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('=')) throw new Error("Formulas can't be entered here. Use Google Sheets for that.");
  if (trimmed === '') return { clear: true };
  // Dropdown values are written exactly (e.g. "Wedding 💍 " keeps its trailing space), so Sheets accepts them.
  if (cell.options && cell.options.includes(text)) return { raw: text };
  const iso = bgToIso(trimmed);
  // In a date cell, write the day number itself: correct whatever the spreadsheet's locale is.
  if (iso && cell.isDate) return { raw: isoToSerial(iso) };
  if (iso) return { typed: iso }; // ISO dates are understood in every locale.
  if (cell.isDate) throw new Error('Enter the date as day, month, year, e.g. 17.10.2026 or 17.10.26 (also with / - or ,).');
  if (/^-?\d+,\d+$/.test(trimmed)) return { typed: trimmed.replace(',', '.') }; // 12,50 -> 12.50
  return { typed: text };
}

// The row's cells as Sheets has them now, compared with what this page shows (to avoid overwriting others' work).
async function rowUnchanged(r) {
  const lastColumn = columnLetter(Math.max(MIN_COLUMNS, ...cells.map((row) => row?.length || 0)) - 1);
  const [now] = await api.getGrid(spreadsheetId, `${quoteTab(tab)}!A${r + 1}:${lastColumn}${r + 1}`, { validation: false });
  const fresh = (now?.values || []).map((data) => toCell(data, null).signature);
  const width = Math.max(fresh.length, cells[r]?.length || 0);
  for (let c = 0; c < width; c++) {
    if ((fresh[c] ?? EMPTY.signature) !== cellAt(r, c).signature) return false;
  }
  return true;
}

async function saveCell(r, c, text) {
  const address = `${columnLetter(c)}${r + 1}`;
  const range = `${quoteTab(tab)}!${address}`;
  const loaded = cellAt(r, c);
  const value = prepareValue(loaded, text);
  const td = tdAt(r, c);

  busy = true;
  td?.classList.add('saving');
  if (td) td.firstChild.textContent = text;
  setStatus(`Saving ${address}…`);
  try {
    // Don't overwrite a change made in Google Sheets after this grid was loaded.
    const [current] = await api.getGrid(spreadsheetId, range, { validation: false });
    if (toCell(current?.values?.[0], null).signature !== loaded.signature) {
      updateCellFrom(r, c, current?.values?.[0]);
      throw new Error(`${address} was changed in Google Sheets in the meantime. Nothing was saved; it now shows the new value.`);
    }

    if (value.clear) await api.clearValues(spreadsheetId, range);
    else if (value.raw !== undefined) await api.updateValuesRaw(spreadsheetId, range, [[value.raw]]);
    else await api.updateValues(spreadsheetId, range, [[value.typed]]);

    // Read back what Sheets made of it.
    const [saved] = await api.getGrid(spreadsheetId, range, { validation: false });
    updateCellFrom(r, c, saved?.values?.[0]);
    setStatus(`Saved ${address}`);
  } finally {
    busy = false;
    refreshRow(r);
    flash(r, c, 'saved');
  }
}

// Inserts an empty row at index `at`, next to row `anchor` (which must still be what this page shows).
async function insertRow(anchor, at) {
  busy = true;
  try {
    if (!(await rowUnchanged(anchor))) {
      await reloadTab();
      throw new Error(`Row ${anchor + 1} was changed in Google Sheets in the meantime. Nothing was inserted; the tab has been reloaded.`);
    }
    // Inserting below copies the formatting and dropdowns of the row above, inserting above those of the row below.
    await api.insertRows(spreadsheetId, sheetProps().sheetId, at, 1, at > anchor);
  } finally {
    busy = false;
  }
  await reloadTab();
  setStatus(`Inserted row ${at + 1}`);
  flash(at, 0, 'saved');
}

function rowSummary(r) {
  return Array.from({ length: MIN_COLUMNS }, (_, c) => cellAt(r, c).shown).filter(Boolean).join(' · ') || '(empty row)';
}

async function deleteRow(r) {
  if (!window.confirm(`Delete row ${r + 1}?\n\n${rowSummary(r)}`)) return;
  busy = true;
  try {
    if (!(await rowUnchanged(r))) {
      await reloadTab();
      throw new Error(`Row ${r + 1} was changed in Google Sheets in the meantime. Nothing was deleted; the tab has been reloaded.`);
    }
    await api.deleteRows(spreadsheetId, sheetProps().sheetId, r, 1);
  } finally {
    busy = false;
  }
  await reloadTab();
  setStatus(`Deleted row ${r + 1}`);
}

function updateCellFrom(r, c, data) {
  while (cells.length <= r) cells.push([]);
  cells[r][c] = toCell(data, validations.get(`${r},${c}`) || null);
}

// Redraws a row (its colour follows the category), except a cell being edited.
function refreshRow(r) {
  for (const td of $('grid').querySelectorAll(`td[data-r="${r}"]`)) {
    if (editing && editing.td === td) continue;
    decorate(td, r, Number(td.dataset.c));
  }
}

function flash(r, c, className) {
  const td = tdAt(r, c);
  if (!td) return;
  td.classList.add(className);
  setTimeout(() => td.classList.remove(className), 2000);
}

// ---- Keeping in sync with Google Sheets ----

// One sync: throws on failure (startSync shows it, and a 401 as "sign in again").
async function syncNow() {
  if (busy || !tab) return false;
  // The tab list every 30 s (a year tab may have been added or deleted in Google Sheets).
  if (Date.now() - metaReadAt >= META_INTERVAL_MS && (await reloadMeta())) return true;
  busy = true;
  try {
    const title = tab;
    let rowData;
    try {
      rowData = await api.getGrid(spreadsheetId, quoteTab(title), { validation: false });
    } catch (err) {
      // The tab was deleted in Google Sheets ("Unable to parse range"): read the tab list again.
      if (!(err instanceof ApiError) || err.status !== 400) throw err;
      busy = false;
      await reloadMeta();
      return true;
    }
    if (tab !== title) return true;
    const fresh = buildCells(rowData);
    if (fresh.dataRows !== dataRows) {
      // Rows were added or removed: redraw everything (and re-read the dropdowns).
      if (editing || popup) {
        cancelEdit();
        closePopups();
        showError(new Error('Rows were added or removed in Google Sheets, so your unsaved edit was discarded.'));
      }
      busy = false;
      await reloadTab();
      setStatus(`Updated from Google Sheets at ${new Date().toLocaleTimeString('en-GB')}`);
      return true;
    }
    let changed = 0;
    const changedRows = new Set();
    const height = Math.max(cells.length, fresh.cells.length);
    for (let r = 0; r < height; r++) {
      const width = Math.max(cells[r]?.length || 0, fresh.cells[r]?.length || 0);
      for (let c = 0; c < width; c++) {
        const before = cells[r]?.[c] || EMPTY;
        const after = fresh.cells[r]?.[c] || EMPTY;
        if (before.signature === after.signature && before.shown === after.shown) continue;
        changed++;
        updateCellFrom(r, c, rowData[r]?.values?.[c]);
        changedRows.add(r);
        if (editing && editing.r === r && editing.c === c) {
          cancelEdit();
          showError(new Error(`${columnLetter(c)}${r + 1} was changed in Google Sheets while you were editing it. Your edit was discarded.`));
        }
        flash(r, c, 'changed');
      }
    }
    for (const r of changedRows) refreshRow(r);
    if (changed) setStatus(`${changed} cell${changed === 1 ? '' : 's'} updated from Google Sheets at ${new Date().toLocaleTimeString('en-GB')}`);
  } finally {
    busy = false;
  }
  return true;
}

// ---- Focus mode: only the table (for phones) ----

function setUpFocusMode() {
  const button = $('btn-focus');
  const apply = (on) => {
    document.body.classList.toggle('table-focus', on);
    button.replaceChildren(icon(on ? 'collapse' : 'expand'), el('span', null, on ? 'Exit focus' : 'Focus'));
    button.title = on ? 'Show the page header and controls again' : 'Show only the table';
  };
  button.addEventListener('click', () => {
    const on = !document.body.classList.contains('table-focus');
    storage.local.set(FOCUS_KEY, on ? '1' : '0');
    apply(on);
  });
  apply(storage.local.get(FOCUS_KEY) === '1');
}

// ---- Events ----

// Marks a row across the grid (not the frozen header rows). toggle: the marked row again unmarks it.
function selectRow(r, { toggle = false } = {}) {
  if (r < frozenRows()) return;
  selectedRow = toggle && selectedRow === r ? null : r;
  for (const tr of $('grid').tBodies[0]?.rows || []) {
    tr.classList.toggle('selected', Number(tr.cells[0]?.dataset.r) === selectedRow);
  }
}

// Row menu: a click on the row number (mouse), a right-click on the row, or pressing and holding the row
// (finger). A tap on the row number by finger only marks the row.
let lastRowMenuAt = 0;
function rowMenuFor(target) {
  const tr = target.closest('#grid tr');
  const number = tr?.querySelector('th.row-number');
  if (!number) return false;
  if (Date.now() - lastRowMenuAt < 800) return true; // Press and hold, and the browser's own menu event.
  lastRowMenuAt = Date.now();
  const r = Number(number.dataset.r);
  selectRow(r);
  openRowMenu(number, r);
  return true;
}
$('grid').addEventListener('contextmenu', (event) => {
  if (event.target.closest('input, select') || !rowMenuFor(event.target)) return;
  event.preventDefault();
});
let pressTimer = 0;
let pressStart = null;
let suppressNextClick = false;
$('grid').addEventListener('pointerdown', (event) => {
  clearTimeout(pressTimer);
  if (event.pointerType === 'mouse' || event.target.closest('input, select, .cell-cal')) return;
  pressStart = { x: event.clientX, y: event.clientY };
  pressTimer = setTimeout(() => {
    if (rowMenuFor(event.target)) suppressNextClick = true;
  }, 550);
});
$('grid').addEventListener('pointermove', (event) => {
  if (pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) clearTimeout(pressTimer);
});
for (const type of ['pointerup', 'pointercancel']) $('grid').addEventListener(type, () => clearTimeout(pressTimer));
// The click that ends a press and hold must not also edit the cell.
$('grid').addEventListener('click', (event) => {
  if (!suppressNextClick) return;
  suppressNextClick = false;
  event.stopImmediatePropagation();
}, true);

$('grid').addEventListener('click', (event) => {
  const number = event.target.closest('th.row-number');
  if (number) {
    event.stopPropagation();
    const r = Number(number.dataset.r);
    if (touchInput()) {
      closePopups(); // An open dropdown or row menu closes, as a tap anywhere else would.
      selectRow(r, { toggle: true });
    } else {
      rowMenuFor(number);
    }
    return;
  }
  const td = event.target.closest('td');
  if (!td || td.classList.contains('editing') || td.classList.contains('saving')) return;
  const r = Number(td.dataset.r);
  const c = Number(td.dataset.c);
  selectRow(r);
  if (!fixture && !getAccessToken()) {
    // Signed out after an hour: editing would fail when saving, so ask to sign in first.
    showSessionBanner(sync.renew);
    return;
  }
  if (isLocked(r, c)) {
    setStatus(`${columnLetter(c)}${r + 1} is locked (${cellAt(r, c).formula ? 'formula' : 'header row'}); change it in Google Sheets.`);
    return;
  }
  const cell = cellAt(r, c);
  if (event.target.closest('.cell-cal')) {
    closePopups();
    openDatePopup({
      anchor: td,
      value: bgToIso(cell.shown),
      onPick: (iso) => run(() => saveCell(r, c, isoToBg(iso))),
      onClear: () => run(() => saveCell(r, c, '')),
    });
  } else if (cell.options) {
    openChoices(td, r, c);
  } else {
    beginEdit(td, r, c);
  }
});

// The mouse wheel scrolls the table from anywhere on the page (nothing else here needs it), Shift + wheel
// sideways. Once the table is at its end, the page itself scrolls as usual.
let wheelGoal = null; // { left, top, at }: where the table is gliding to (successive turns add up)
document.addEventListener('wheel', (event) => {
  const wrap = document.querySelector('.grid-wrap');
  if (!wrap || $('view-raw').hidden || event.ctrlKey) return;
  if (event.target.closest('.grid-wrap, .menu, .choice-list, .date-popup, dialog, select')) return;
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? wrap.clientHeight : 1;
  let dx = event.deltaX * unit;
  let dy = event.deltaY * unit;
  if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
  const maxLeft = wrap.scrollWidth - wrap.clientWidth;
  const maxTop = wrap.scrollHeight - wrap.clientHeight;
  const from = wheelGoal && Date.now() - wheelGoal.at < 300 ? wheelGoal : { left: wrap.scrollLeft, top: wrap.scrollTop };
  const left = Math.min(maxLeft, Math.max(0, from.left + dx));
  const top = Math.min(maxTop, Math.max(0, from.top + dy));
  if (Math.abs(left - from.left) < 1 && Math.abs(top - from.top) < 1) return;
  event.preventDefault();
  wheelGoal = { left, top, at: Date.now() };
  wrap.scrollTo({ left, top, behavior: 'smooth' });
}, { passive: false });

// Clicks inside the grid shouldn't close the popup they just opened.
$('grid').addEventListener('pointerdown', (event) => {
  if (event.target.closest('th.row-number, td.list, .cell-cal')) event.stopPropagation();
});

$('tab-select').addEventListener('change', () => {
  const value = $('tab-select').value;
  if (value === NEW_YEAR) run(newYearTab, { overlay: false });
  else run(() => loadTab(value));
});

$('render').addEventListener('change', () => {
  if (tab) renderGrid();
});

compactQuery.addEventListener('change', () => {
  if (tab) renderGrid();
});

$('btn-signin').addEventListener('click', () =>
  run(async () => {
    await signIn();
    await open();
  }),
);

start();
