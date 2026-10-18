// Main page: sign in, choose a spreadsheet, show the entries of a chosen period (read-only for now),
// kept in sync with Google Sheets.

import { isConfigured, initAuth, signIn, signOut, dropToken, getAccessToken, fetchUserEmail } from './auth.js';
import {
  ApiError, parseSpreadsheetId, quoteTab, getSpreadsheet, getValues, batchGetValues, spreadsheetUrl,
  batchUpdateValues, batchClearValues, insertRows, deleteRows, duplicateSheet,
} from './sheets.js';
import { createEditor } from './editor.js';
import { isYearTab, parseYearTab, identifyPerson, toEur } from './budget.js';
import { isoToBg } from './dates.js';
import { fixtureRequested, loadFixtureApi, showFixtureBanner } from './fixture.js';
import { storage, SHEET_KEY, TAB_KEY } from './storage.js';
import { $, el, showError, setUpPage, withLoading, showSessionBanner } from './ui.js';
import { icon, categoryIcon } from './icons.js';
import { startSync, PAST_YEARS_MS } from './sync.js';
import { PeriodPicker } from './period.js';
import { DEFAULT_SPREADSHEET_URL, PEOPLE, BGN_PER_EUR, CATEGORIES, categoryStyle, badgeColours } from './config.js';

const ORDER_KEY = 'bs.order'; // Order of the month cards.
const ENTRY_ORDER_KEY = 'bs.entryOrder'; // Order of the entries inside each card.
const VIEWS = ['view-message', 'view-signin', 'view-pick', 'view-sheet'];

// Replaced by the fixture in development (?fixture).
let api = { getSpreadsheet, getValues, batchGetValues, batchUpdateValues, batchClearValues, insertRows, deleteRows, duplicateSheet };
let editor = null; // Editing and adding entries (editor.js).
let categoryList = []; // From the sheet's List tab (the Category dropdown).
const rowInfo = new WeakMap(); // Entry row element -> { year, entry }
const zoneInfo = new WeakMap(); // "+" element -> { year, row, date }
let spreadsheet = null; // { id, meta }
let yearTitles = []; // Newest first.
let data = null; // { period, years: [parsed, oldest first], latest: parsed }
let picker = null;
let sync = null; // From startSync(): syncNow(), renew().
let loading = false;
let me = null; // Entry of PEOPLE for the signed-in account, or null.

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
}

function showMessage(text) {
  $('message-text').textContent = text;
  show('view-message');
}

function personName(person) {
  return el('span', `pname person-${person.key}`, person.name);
}

// Runs an async action with the loading overlay, routing expired sessions back to the sign-in view.
async function run(action, { overlay = true } = {}) {
  if (overlay) showError(null);
  try {
    await (overlay ? withLoading(action) : action());
  } catch (err) {
    if (err.status === 401) {
      dropToken();
      // With data on screen, keep it and ask to sign in again; otherwise show the sign-in card.
      if (sync && data) {
        showSessionBanner(sync.renew);
      } else {
        $('user').hidden = true;
        show('view-signin');
      }
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      showError(new Error('This Google account has no access to that spreadsheet (or Sheets access was not granted).'));
    } else if (err instanceof ApiError && err.status === 404) {
      showError(new Error('Spreadsheet not found. Check the URL.'));
    } else {
      showError(err);
    }
    console.error(err);
  }
}

async function start() {
  setUpPage();
  showOrder();

  if (fixtureRequested()) {
    showFixtureBanner();
    await run(async () => {
      api = await loadFixtureApi();
      $('user-email').textContent = 'Fixture data';
      $('user').hidden = false;
      await openSpreadsheet('fixture');
    });
    return;
  }
  if (!isConfigured()) {
    showMessage('No Google client ID is configured yet. Follow SETUP.md step 3, then put the Client ID into js/config.js.');
    return;
  }
  try {
    await initAuth();
  } catch (err) {
    showMessage(err.message);
    return;
  }
  if (getAccessToken()) await run(afterSignIn);
  else show('view-signin');
}

async function afterSignIn() {
  const email = await fetchUserEmail();
  me = await identifyPerson(email);
  const who = $('user-email');
  who.replaceChildren();
  if (me) who.append(personName(me), el('span', 'email', ` · ${email}`));
  else who.textContent = email;
  $('user').hidden = false;
  const id = storage.local.get(SHEET_KEY) || parseSpreadsheetId(DEFAULT_SPREADSHEET_URL);
  if (id) await openSpreadsheet(id);
  else showPicker();
}

function showPicker() {
  $('sheet-url').value = '';
  show('view-pick');
  $('sheet-url').focus();
}

async function openSpreadsheet(id) {
  const meta = await api.getSpreadsheet(id);
  spreadsheet = { id, meta };
  if (id !== 'fixture') storage.local.set(SHEET_KEY, id);

  $('sheet-title').textContent = meta.properties.title;
  $('sheet-meta').textContent = `Locale ${meta.properties.locale} · ${meta.properties.timeZone}`;
  show('view-sheet');

  yearTitles = meta.sheets.map((s) => s.properties.title).filter(isYearTab).sort((a, b) => b.localeCompare(a));
  if (!yearTitles.length) {
    showError(new Error('This spreadsheet has no year tabs (tabs named like "2026").'));
    return;
  }
  if (!picker) {
    picker = new PeriodPicker({
      years: () => yearTitles.map(Number),
      onChange: (period) => run(() => load(period)),
    });
    sync = startSync(syncNow, { offline: id === 'fixture' });
  }
  editor ??= createEditor({
    api,
    spreadsheetId: () => spreadsheet.id,
    meta: () => spreadsheet.meta,
    reloadMeta,
    yearTitles: () => yearTitles,
    cached: (title) => cache.get(title),
    refresh,
    me: () => me,
    categories: () => categoryList,
    busy: (on) => { loading = on; },
    withLoading,
    showError: (err) => {
      showError(err);
      $('error').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    notice: (text) => { $('notice').textContent = text; },
  });
  await load(picker.period);
  await loadCategories();
  $('btn-add').hidden = false;
}

// Categories as in the sheet's dropdown (List!A2:A50); falls back to the ones the app knows.
async function loadCategories() {
  try {
    const result = await api.batchGetValues(spreadsheet.id, ['List!A2:A50'], 'FORMATTED_VALUE');
    categoryList = (result.valueRanges[0].values || []).flat().map(String).filter((v) => v.trim() !== '');
  } catch (err) {
    console.error(err);
    categoryList = [];
  }
  if (!categoryList.length) categoryList = Object.keys(CATEGORIES).map((k) => k.replace(/^./, (c) => c.toUpperCase()));
}

// Re-reads the list of tabs (they can be added or deleted in Google Sheets). Returns true if the year tabs
// changed; years that are gone are forgotten.
let metaReadAt = 0;
const META_INTERVAL_MS = 30_000;
async function reloadMeta() {
  spreadsheet.meta = await api.getSpreadsheet(spreadsheet.id);
  metaReadAt = Date.now();
  const before = yearTitles.join();
  yearTitles = spreadsheet.meta.sheets.map((s) => s.properties.title).filter(isYearTab).sort((a, b) => b.localeCompare(a));
  for (const title of cache.keys()) if (!yearTitles.includes(title)) cache.delete(title);
  return yearTitles.join() !== before;
}

// After a change: re-reads the given years (and any the period now needs) and redraws.
async function refresh(titles) {
  const existing = titles.filter((t) => yearTitles.includes(t));
  await fetchYears(existing);
  if (!data) return;
  const missing = titlesFor(data.period).filter((t) => !cache.has(t));
  if (missing.length) await fetchYears(missing);
  showPeriod(data.period);
}

function sheetIdOf(title) {
  return spreadsheet.meta.sheets.find((s) => s.properties.title === title)?.properties.sheetId;
}

// Year tabs the period touches, oldest first (only years that exist).
function yearsFor(period) {
  const first = Number(period.from.slice(0, 4));
  const last = Number(period.to.slice(0, 4));
  return yearTitles.filter((t) => Number(t) >= first && Number(t) <= last).reverse();
}

// Years read so far: title -> { parsed, signature, fetchedAt }. Switching periods reuses them, so only
// years never read before make the page wait; syncing keeps them fresh.
const cache = new Map();

// The years the period needs, plus the newest year (for the current balance).
function titlesFor(period) {
  return [...new Set([...yearsFor(period), yearTitles[0]])];
}

// Reads the given year tabs; returns the titles whose content changed.
async function fetchYears(titles) {
  if (!titles.length) return [];
  const result = await api.batchGetValues(spreadsheet.id, titles.map(quoteTab), 'UNFORMATTED_VALUE');
  const changed = [];
  titles.forEach((title, i) => {
    const values = result.valueRanges[i].values || [];
    const signature = JSON.stringify(values);
    const old = cache.get(title);
    if (old?.signature === signature) {
      old.fetchedAt = Date.now();
    } else {
      cache.set(title, { parsed: parseYearTab(title, values), values, signature, fetchedAt: Date.now() });
      changed.push(title);
    }
  });
  return changed;
}

// Shows a period: reads only the years not read yet (with the loading overlay), then draws from the cache.
async function load(period) {
  const missing = titlesFor(period).filter((t) => !cache.has(t));
  loading = true;
  try {
    await fetchYears(missing);
  } finally {
    loading = false;
  }
  if (picker.period !== period) return; // The period changed meanwhile.
  showPeriod(period);
}

function showPeriod(period, { updated = false } = {}) {
  const inPeriod = yearsFor(period);
  data = { period, years: inPeriod.map((t) => cache.get(t).parsed), latest: cache.get(yearTitles[0]).parsed };

  const linkTab = inPeriod.at(-1) || yearTitles[0];
  storage.local.set(TAB_KEY, linkTab);
  $('btn-raw').href = `raw.html?tab=${encodeURIComponent(linkTab)}${fixtureRequested() ? '&fixture' : ''}`;
  $('btn-sheets').href = spreadsheet.id === 'fixture' ? '#' : spreadsheetUrl(spreadsheet.id, sheetIdOf(linkTab));

  render();
  $('notice').textContent = updated ? `Updated from Google Sheets at ${new Date().toLocaleTimeString('en-GB')}` : '';
}

// The current year every time; older years once they're a minute old (they rarely change).
// Throws on failure (startSync shows it, and a 401 as "sign in again").
async function syncNow() {
  if (loading || !spreadsheet || !data) return false;
  // The tab list every 30 s (a year tab may have been added or deleted in Google Sheets).
  let tabsChanged = Date.now() - metaReadAt >= META_INTERVAL_MS && (await reloadMeta());
  const due = () => {
    const now = Date.now();
    return titlesFor(data.period).filter((t) => t === yearTitles[0] || now - (cache.get(t)?.fetchedAt || 0) >= PAST_YEARS_MS);
  };
  let changed;
  try {
    changed = await fetchYears(due());
  } catch (err) {
    // A tab read a moment ago is gone ("Unable to parse range"): read the tab list and try once more.
    if (!(err instanceof ApiError) || err.status !== 400) throw err;
    tabsChanged = (await reloadMeta()) || tabsChanged;
    changed = await fetchYears(due());
  }
  if ((changed.length || tabsChanged) && data) showPeriod(data.period, { updated: true });
  return true;
}

// ---- Period filtering ----

function inPeriod(entry, block) {
  const { from, to } = data.period;
  if (entry.date) return entry.date >= from && entry.date <= to;
  // Undated (broken date) entries belong to their month block.
  return Boolean(block?.month) && block.month >= from.slice(0, 7) && block.month <= to.slice(0, 7);
}

// Month cards for the period: [{ year, block, entries }], oldest first.
function periodBlocks() {
  const out = [];
  for (const year of data.years) {
    for (const block of year.blocks) {
      const entries = block.entries.filter((e) => inPeriod(e, block));
      if (entries.length) out.push({ year, block, entries });
    }
  }
  return out;
}

// One currency if every year in the period has the same one, otherwise everything in euro.
function periodCurrency() {
  const currencies = new Set(data.years.map((y) => y.currency));
  return currencies.size === 1 ? [...currencies][0] : 'EUR';
}

// ---- Rendering ----

function money(amount, currency) {
  const text = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  return currency === 'EUR' ? `${text} €` : `${text} лв`;
}

function monthName(month) {
  if (!month) return 'Unknown month';
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function render() {
  renderBalance(data.latest);
  renderTotals();
  renderProblems();
  renderMonths();
}

function renderBalance(year) {
  // The sheet's own result is shown; the app's calculation is only used to detect differences.
  const [a, b] = PEOPLE;
  const aOwes = year.sheetSummary?.[a.key]?.owes ?? year.totals[a.key].owes;
  const box = $('balance');
  box.replaceChildren(el('span', 'muted', `Current balance (${year.title})`));
  const line = el('strong');
  if (Math.abs(aOwes) < 0.005) {
    line.textContent = 'All square';
  } else {
    const [debtor, creditor] = aOwes > 0 ? [a, b] : [b, a];
    line.append(personName(debtor), ' owes ', personName(creditor), ` ${money(Math.abs(aOwes), year.currency)}`);
  }
  box.append(line);
}

// Totals of the entries in the period. Carry-overs are left out: they only move last year's balance forward.
function renderTotals() {
  const currency = periodCurrency();
  const sums = PEOPLE.map(() => ({ shared: 0, cashIn: 0 }));
  for (const { year, entries } of periodBlocks()) {
    const convert = (amount) => (currency === 'EUR' ? toEur(amount, year.year) : amount);
    for (const entry of entries) {
      PEOPLE.forEach((p, i) => {
        const m = entry.money[p.key];
        sums[i].shared += convert(m.paid - m.personal);
        sums[i].cashIn += convert(m.cashIn);
      });
    }
  }

  const table = $('totals');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  head.append(el('th', null, data.period.label), ...PEOPLE.map((p) => {
    const th = el('th');
    th.append(personName(p));
    return th;
  }));
  const body = table.createTBody();
  const rows = [
    ['Shared paid', sums.map((s) => s.shared)],
    ['Half', sums.map((s) => s.shared / 2)],
    ['Cash in', sums.map((s) => s.cashIn)],
  ];
  for (const [label, values] of rows) {
    const tr = body.insertRow();
    tr.append(el('th', null, label), ...PEOPLE.map((p, i) => el('td', `person-${p.key}`, money(values[i], currency))));
  }
  const mixed = new Set(data.years.map((y) => y.currency)).size > 1;
  const note = $('totals-note');
  note.textContent = `Carry-overs not counted.${mixed ? ` Leva converted at 1 € = ${BGN_PER_EUR} лв.` : ''}`;
  note.hidden = false;
}

function renderProblems() {
  const several = data.years.length > 1;
  const prefix = (year) => (several ? `${year.title}, ` : '');
  const items = [];
  for (const year of data.years) {
    if (year.layoutProblem) items.push({ bad: true, text: `${prefix(year)}${year.layoutProblem}` });
    for (const p of year.tabProblems) items.push({ bad: p.code === 'balance-mismatch', text: `${prefix(year)}${p.text}` });
  }
  for (const { year, entries } of periodBlocks()) {
    for (const e of entries) {
      if (!e.problems.length) continue;
      const what = `${e.category || 'no category'}, ${e.description || '—'}`;
      items.push({ text: `${prefix(year)}Row ${e.rowNumber} (${what}): ${e.problems.map((p) => p.text).join('; ')}` });
    }
  }
  $('problems').hidden = !items.length;
  $('problems-summary').textContent = `${items.length} thing${items.length === 1 ? '' : 's'} to check`;
  $('problems-list').replaceChildren(...items.map((item) => el('li', item.bad ? 'bad' : null, item.text)));
}

function renderMonths() {
  hidePopover();
  const cards = [];
  for (const year of data.years) {
    // The carry-over belongs before January, when the period includes 1 January.
    const jan1 = `${year.title}-01-01`;
    if (year.carry && data.period.from <= jan1 && data.period.to >= jan1) cards.push(carryCard(year));
    for (const item of periodBlocks().filter((b) => b.year === year)) cards.push(monthCard(item));
  }
  if (newestFirst()) cards.reverse();
  $('months').replaceChildren(...cards);
  $('empty').hidden = cards.length > 0;
  markClippedDescriptions();
}

// addDate (optional): shows a "+" in the header that opens Add record with that date.
function card(className, title, meta, addDate) {
  const section = el('section', className);
  const sticky = el('div', 'month-sticky');
  const inner = el('div', 'month-sticky-inner');
  const head = el('div', 'month-head');
  const heading = el('div', 'month-title');
  heading.append(el('h3', null, title));
  if (addDate) {
    const add = el('button', 'icon-button card-add');
    add.type = 'button';
    add.title = `Add a record to ${title}`;
    add.setAttribute('aria-label', add.title);
    add.append(icon('plus'));
    add.addEventListener('click', () => editor?.openAddDialog({ date: addDate }));
    heading.append(add);
  }
  head.append(heading, el('span', 'muted', meta));
  inner.append(head, columnHeader());
  sticky.append(inner);
  const list = el('div', 'entries');
  section.append(sticky, list);
  return { section, list };
}

function columnHeader() {
  const row = el('div', 'entry entry-head');
  const amounts = el('span', 'amounts');
  amounts.append(...PEOPLE.map((p) => el('span', `who wide person-${p.key}`, p.name)), el('span', 'who narrow', 'Amount'));
  // Entry order inside the cards: one setting for all cards, switchable from any of them.
  const date = el('span', 'date-head');
  const sort = el('button', 'sort-button');
  sort.type = 'button';
  const newest = newestEntriesFirst();
  sort.append(icon(newest ? 'sortDown' : 'sortUp'));
  sort.title = newest ? 'Newest entries first. Click for oldest first.' : 'Oldest entries first. Click for newest first.';
  sort.setAttribute('aria-label', sort.title);
  sort.addEventListener('click', () => {
    storage.local.set(ENTRY_ORDER_KEY, newestEntriesFirst() ? 'oldest' : 'newest');
    renderMonths();
  });
  date.append(el('span', null, 'Date'), sort);
  row.append(date, el('span', null, 'Description'), amounts);
  return row;
}

function newestEntriesFirst() {
  return storage.local.get(ENTRY_ORDER_KEY) === 'newest';
}

function monthCard({ year, block, entries }) {
  const shared = entries.reduce((sum, e) => sum + PEOPLE.reduce((s, p) => s + e.money[p.key].paid - e.money[p.key].personal, 0), 0);
  const partial = entries.length < block.entries.length ? ` of ${block.entries.length}` : '';
  const meta = `${entries.length}${partial} entries · shared ${money(shared, year.currency)}`;
  // "+" in the header: Add record, dated today if today is in this month, else the month's last entry.
  const lastDate = block.entries.at(-1)?.date;
  const today = new Date();
  const todayMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const addDate = todayMonth === block.month
    ? `${todayMonth}-${String(today.getDate()).padStart(2, '0')}`
    : lastDate || `${block.month}-01`;
  const { section, list } = card('month', monthName(block.month), meta, addDate);
  const newest = newestEntriesFirst();
  const ordered = newest ? [...entries].reverse() : entries;
  const n = entries.length;
  ordered.forEach((entry, j) => {
    const row = entryRow(entry, year);
    // Gaps (in sheet order) above and below the row as shown: with newest first the order is reversed.
    const above = newest ? n - j : j;
    const below = newest ? n - j - 1 : j + 1;
    rowInfo.get(row).gaps = { above: gapInsert(block, entries, above), below: gapInsert(block, entries, below) };
    // "+" at the row's top-left corner: inserts an empty entry between it and the row above.
    row.append(addZone(year, block, entries, above, 'top'));
    if (j === n - 1) row.append(addZone(year, block, entries, below, 'bottom'));
    list.append(row);
  });
  return section;
}

// Where to insert an empty entry for the gap before entries[g] in sheet order (g = n: after the last).
// It gets the date of the entry above it in the sheet (or of the first one), so it stays in place when sorted.
function gapInsert(block, entries, g) {
  const n = entries.length;
  return {
    row: g < n ? entries[g].rowNumber : entries[n - 1].rowNumber + 1,
    date: (g > 0 ? entries[g - 1].date : entries[0].date) || `${block.month}-01`,
  };
}

function addZone(year, block, entries, g, edge) {
  const button = el('button', `add-zone ${edge}`);
  button.type = 'button';
  button.title = 'Insert an empty entry here';
  button.setAttribute('aria-label', 'Insert an empty entry here');
  button.append(icon('plus'));
  zoneInfo.set(button, { year, ...gapInsert(block, entries, g) });
  return button;
}

function carryCard(year) {
  const { section, list } = card('month carry-card', `Carried over from ${year.year - 1}`, 'Balance at the end of last year');
  list.append(entryRow(year.carry, year));
  return section;
}

function dateCell(entry) {
  const cell = el('span', 'date');
  if (!entry.date) {
    cell.textContent = '—'; // Text dates are listed under "things to check".
    return cell;
  }
  const [d, m, y] = isoToBg(entry.date).split('.');
  cell.append(el('span', 'dm', `${d}.${m}.`), el('span', 'yr', y));
  return cell;
}

// Round badge in the category's colour (as in the sheet) with a single-colour icon.
function categoryBadge(entry) {
  const style = entry.kind === 'carry' ? { icon: 'sync', ...badgeColours('#b5dcc0') } : categoryStyle(entry.category);
  const badge = el('span', 'cat-badge');
  if (style) {
    badge.style.setProperty('--cat', style.badge);
    badge.style.setProperty('--cat-ink', style.ink);
  }
  badge.title = entry.category || (entry.kind === 'carry' ? 'Carry-over' : 'No category');
  badge.append(categoryIcon(style));
  return badge;
}

function amountLine(className, text, label) {
  const line = el('span', `amt-line ${className}`, text);
  if (label) line.append(el('span', 'amt-label', label));
  return line;
}

function entryRow(entry, year) {
  const { currency } = year;
  const row = el('div', entry.problems.length ? 'entry warn' : 'entry');
  if (entry.problems.length) row.title = entry.problems.map((p) => p.text).join('\n');
  if (entry.kind !== 'carry') row.classList.add('editable');
  rowInfo.set(row, { year, entry });

  const what = el('span', 'what');
  const text = el('span', 'what-text');
  const descLine = el('span', 'desc-line');
  const more = el('button', 'more', 'i');
  more.type = 'button';
  more.hidden = true;
  more.setAttribute('aria-label', 'Show the full description');
  descLine.append(el('span', 'desc', entry.description || '—'), more);
  const category = entry.category || (entry.kind === 'carry' ? 'Carry-over' : 'No category');
  text.append(el('span', 'cat', category), descLine);
  what.append(categoryBadge(entry), text);

  const amounts = el('span', 'amounts');
  for (const person of PEOPLE) {
    const m = entry.money[person.key];
    const cell = el('span', `who person-${person.key}`);
    cell.dataset.name = person.name;
    cell.dataset.person = person.key;
    if (m.paid) cell.append(amountLine('amt-paid', money(m.paid, currency)));
    if (m.personal) cell.append(amountLine('amt-personal', `−${money(m.personal, currency)}`, 'personal'));
    if (m.cashIn) cell.append(amountLine('amt-cash', money(m.cashIn, currency), 'cash in'));
    amounts.append(cell);
  }

  row.append(dateCell(entry), what, amounts);
  // Red ✕ on the right edge (computers, on hover): deletes the entry after asking.
  if (entry.kind !== 'carry') {
    const remove = el('button', 'delete-x');
    remove.type = 'button';
    remove.title = 'Delete this entry';
    remove.setAttribute('aria-label', 'Delete this entry');
    remove.append(icon('close'));
    row.append(remove);
  }
  return row;
}

// ---- Long descriptions: "i" button + popup ----

// Shows the "i" button only on descriptions that don't fit on one line.
function markClippedDescriptions() {
  const lines = $('months').querySelectorAll('.desc-line');
  for (const line of lines) line.lastChild.hidden = true;
  for (const line of lines) {
    const desc = line.firstChild;
    line.lastChild.hidden = desc.scrollWidth <= desc.clientWidth;
  }
}

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(markClippedDescriptions);
}).observe($('months'));

let popoverButton = null;
let popoverPinned = false;

function showPopover(button, pinned) {
  const popover = $('popover');
  popover.textContent = button.parentElement.firstChild.textContent;
  popover.hidden = false;
  const rect = button.getBoundingClientRect();
  const pageWidth = document.documentElement.clientWidth;
  const left = Math.max(8, Math.min(rect.right - popover.offsetWidth, pageWidth - popover.offsetWidth - 8));
  popover.style.left = `${left + window.scrollX}px`;
  popover.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popoverButton = button;
  popoverPinned = pinned;
}

function hidePopover() {
  $('popover').hidden = true;
  popoverButton = null;
  popoverPinned = false;
}

$('months').addEventListener('click', (event) => {
  const button = event.target.closest('.more');
  if (button) {
    event.stopPropagation();
    if (popoverButton === button && popoverPinned) hidePopover();
    else showPopover(button, true);
    return;
  }
  if (!editor) return;
  // "+" between rows: insert an empty entry.
  const removeButton = event.target.closest('.delete-x');
  if (removeButton) {
    event.stopPropagation();
    const { year, entry } = rowInfo.get(removeButton.closest('.entry'));
    editor.deleteEntry(year, entry);
    return;
  }
  const zone = event.target.closest('.add-zone');
  if (zone) {
    event.stopPropagation();
    const { year, row, date } = zoneInfo.get(zone);
    editor.insertEmpty(year, row, date);
    return;
  }
  // A click on a part of an entry edits that part (date, category, description, amounts).
  const rowElement = event.target.closest('.entries .entry');
  const info = rowElement && rowInfo.get(rowElement);
  if (info && !event.target.closest('input')) {
    event.stopPropagation();
    editor.editEntry(event.target, info.year, info.entry);
  }
});

$('btn-add').addEventListener('click', () => editor?.openAddDialog());

// Entry menu (delete…): right-click on a computer, press and hold on a phone.
let lastMenuAt = 0;
function openMenuFor(rowElement) {
  const info = rowInfo.get(rowElement);
  if (!editor || !info || info.entry.kind === 'carry') return false;
  if (Date.now() - lastMenuAt < 800) return true; // Long press and the browser's own context menu event.
  lastMenuAt = Date.now();
  editor.openEntryMenu(rowElement.querySelector('.what') || rowElement, info.year, info.entry, info.gaps);
  return true;
}
$('months').addEventListener('contextmenu', (event) => {
  const rowElement = event.target.closest('.entries .entry');
  if (rowElement && openMenuFor(rowElement)) event.preventDefault();
});
let pressTimer = 0;
let pressStart = null;
$('months').addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return;
  const rowElement = event.target.closest('.entries .entry.editable');
  if (!rowElement) return;
  pressStart = { x: event.clientX, y: event.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (openMenuFor(rowElement)) suppressNextClick = true;
  }, 550);
});
$('months').addEventListener('pointermove', (event) => {
  if (pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) clearTimeout(pressTimer);
});
for (const type of ['pointerup', 'pointercancel']) $('months').addEventListener(type, () => clearTimeout(pressTimer));
let suppressNextClick = false;
// The click that ends a long press must not also start editing.
$('months').addEventListener('click', (event) => {
  if (!suppressNextClick) return;
  suppressNextClick = false;
  event.stopImmediatePropagation();
}, true);
$('months').addEventListener('pointerover', (event) => {
  const button = event.target.closest('.more');
  if (button && event.pointerType === 'mouse' && !popoverPinned) showPopover(button, false);
});
$('months').addEventListener('pointerout', (event) => {
  if (event.target.closest('.more') && event.pointerType === 'mouse' && !popoverPinned) hidePopover();
});
document.addEventListener('click', (event) => {
  if (!$('popover').contains(event.target)) hidePopover();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hidePopover();
});

// ---- Events ----

$('btn-signin').addEventListener('click', () =>
  run(async () => {
    await signIn();
    await afterSignIn();
  }),
);

$('btn-signout').addEventListener('click', () => {
  signOut();
  spreadsheet = null;
  data = null;
  me = null;
  $('user').hidden = true;
  showError(null);
  show('view-signin');
});

$('form-pick').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = parseSpreadsheetId($('sheet-url').value);
  if (!id) {
    showError(new Error('That does not look like a Google Sheets URL.'));
    return;
  }
  run(() => openSpreadsheet(id));
});

$('btn-change').addEventListener('click', () => {
  storage.local.remove(SHEET_KEY);
  storage.local.remove(TAB_KEY);
  data = null;
  cache.clear();
  showPicker();
});

// Order of the month cards: a toggle between oldest first (like the sheet) and newest first.
function newestFirst() {
  return storage.local.get(ORDER_KEY) === 'newest';
}

function showOrder() {
  const button = $('btn-order');
  const newest = newestFirst();
  button.replaceChildren(icon(newest ? 'orderReverse' : 'order'), el('span', null, newest ? 'Newest first' : 'Oldest first'));
  button.title = `Showing ${newest ? 'newest' : 'oldest'} months first. Click to switch.`;
}

$('btn-order').addEventListener('click', () => {
  storage.local.set(ORDER_KEY, newestFirst() ? 'oldest' : 'newest');
  showOrder();
  if (data) renderMonths();
});

start();
