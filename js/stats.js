// Statistics page: how much was spent, by whom and on what, in a chosen period.
// Opened from the main page with its period (stats.html?from=…&to=…&kind=…; a month card passes its month).
// One row of choices above the widgets: period, whose spending (both together or what one person paid, see
// budget.js spending()), how a period that isn't over yet is compared, and currency (lev ↔ euro at the
// fixed rate). Read-only; kept in sync like the other pages.
//
// Comparisons (the "vs" switch; every widget compares with the same one):
//   Last period – the period just before (September for October, 2025 for 2026).
//   Usual       – the same period in the earlier years with data (October 2022–2025): their average, or
//                 their median, which one exceptional year doesn't pull up.
//   While the shown period isn't over, "Up to today" compares only as many days of each (1–25 October with
//   1–25 September); "Whole periods" compares with them in full.

import { isConfigured, initAuth, signIn, dropToken, getAccessToken, watchIdle, IDLE_MS } from './auth.js';
import { ApiError, quoteTab, getSpreadsheet, batchGetValues, spreadsheetUrl } from './sheets.js';
import { isYearTab, parseYearTab, spending, convert } from './budget.js';
import { isoToBg } from './dates.js';
import { fixtureRequested, loadFixtureApi, showFixtureBanner } from './fixture.js';
import {
  storage, SHEET_KEY,
} from './storage.js';
import { $, el, showError, setUpPage, withLoading, showSessionBanner, touchInput, openDialog } from './ui.js';
import { icon, categoryIcon } from './icons.js';
import { startSync, PAST_YEARS_MS } from './sync.js';
import { PeriodPicker, monthPeriod, yearPeriod, todayIso, shift, periodQuery, periodFromQuery } from './period.js';
import { addDays, addMonths, daysBetween, monthStart, monthTitle, weekStart, shortMonth, toIso } from './calendar.js';
import { PEOPLE, BGN_PER_EUR, categoryKey, categoryStyle, CHART_COLOURS, OTHER_CHART_COLOUR, COMPARE_COLOURS, LINE_OVER_COLUMNS } from './config.js';
import { gauge, donut, stackedColumns, lineChart } from './charts.js';

const VIEWS = ['view-message', 'view-signin', 'view-stats'];
const WHO = [{ key: 'combined', name: 'Combined' }, ...PEOPLE];
const META_INTERVAL_MS = 30_000;

let api = { getSpreadsheet, batchGetValues };
let fixture = false;
let spreadsheetId = null;
let meta = null;
let yearTitles = []; // Newest first.
let picker = null;
let sync = null;
let busy = false; // Reading from Google Sheets; syncing waits.
let metaReadAt = 0;
// Years read so far: title -> { parsed, signature, fetchedAt }.
const cache = new Map();

// The switches start at their defaults every time the page opens (they're not remembered).
let currency = 'EUR';
let who = 'combined';
let compareMode = 'today'; // 'today' (up to today) | 'whole' (whole periods)
let compareWith = 'last'; // What everything is compared with: 'last' | 'mean' | 'median' (BASES)
let detailIndex = null; // Columns: 0, 1 or 2 (most detailed first); null: the most detailed that fits.

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
}

function showMessage(text) {
  $('message-text').textContent = text;
  show('view-message');
}

async function run(action, { overlay = true } = {}) {
  if (overlay) showError(null);
  try {
    await (overlay ? withLoading(action) : action());
  } catch (err) {
    if (err.status === 401) {
      dropToken();
      // With the statistics on screen, keep them and ask to sign in again; otherwise show the sign-in card.
      if (sync) showSessionBanner(sync.renew);
      else showSignIn(false);
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      showError(new Error('This Google account has no access to that spreadsheet.'));
    } else {
      showError(err);
    }
    console.error(err);
  }
}

async function start() {
  setUpPage();
  setUpChoices();
  fixture = fixtureRequested();
  if (fixture) {
    showFixtureBanner();
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
    sync?.pause();
    picker?.close();
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
  metaReadAt = Date.now();
  readYearTitles();
  if (!yearTitles.length) throw new Error('This spreadsheet has no year tabs (tabs named like "2026").');
  $('btn-sheets').href = fixture ? '#' : spreadsheetUrl(spreadsheetId);
  show('view-stats');
  if (!picker) {
    picker = new PeriodPicker({
      years: () => yearTitles.map(Number),
      period: periodFromQuery(new URLSearchParams(location.search)) || monthPeriod(todayIso()),
      onChange: (period) => {
        rememberPeriod(period);
        showChoices();
        run(() => load(period));
      },
    });
  }
  picker.followYears(); // ("All time" covers the year tabs there are.)
  rememberPeriod(picker.period);
  showChoices();
  await load(picker.period);
  sync?.resume();
  sync ??= startSync(syncNow, { offline: fixture });
}

// The period stays in the address, so reloading the page (or going back to it) shows it again.
function rememberPeriod(period) {
  history.replaceState(null, '', `stats.html?${periodQuery(period)}`);
}

function readYearTitles() {
  yearTitles = meta.sheets.map((s) => s.properties.title).filter(isYearTab).sort((a, b) => b.localeCompare(a));
}

// Re-reads the tab list (year tabs can be added or deleted in Google Sheets). Returns true if it changed.
async function reloadMeta() {
  meta = await api.getSpreadsheet(spreadsheetId);
  metaReadAt = Date.now();
  const before = yearTitles.join();
  readYearTitles();
  for (const title of cache.keys()) if (!yearTitles.includes(title)) cache.delete(title);
  if (yearTitles.join() === before) return false;
  picker.followYears();
  return true;
}

// ---- Data ----

// The period's years and every earlier one (the usual amounts come from all earlier years).
function titlesFor(period) {
  return yearTitles.filter((t) => t <= period.to.slice(0, 4));
}

// Reads the given year tabs; returns the titles whose content changed.
async function fetchYears(titles) {
  if (!titles.length) return [];
  const result = await api.batchGetValues(spreadsheetId, titles.map(quoteTab), 'UNFORMATTED_VALUE');
  const changed = [];
  titles.forEach((title, i) => {
    const values = result.valueRanges[i].values || [];
    const signature = JSON.stringify(values);
    const old = cache.get(title);
    if (old?.signature === signature) {
      old.fetchedAt = Date.now();
    } else {
      cache.set(title, { parsed: parseYearTab(title, values), signature, fetchedAt: Date.now() });
      changed.push(title);
    }
  });
  return changed;
}

async function load(period) {
  busy = true;
  try {
    await fetchYears(titlesFor(period).filter((t) => !cache.has(t)));
  } finally {
    busy = false;
  }
  if (picker.period === period) render();
}

// The current year every time; older years once they're a minute old (they rarely change).
async function syncNow() {
  if (busy || !picker || $('view-stats').hidden) return false;
  busy = true;
  try {
    let tabsChanged = Date.now() - metaReadAt >= META_INTERVAL_MS && (await reloadMeta());
    const due = () => {
      const now = Date.now();
      return titlesFor(picker.period).filter((t) => t === yearTitles[0] || now - (cache.get(t)?.fetchedAt || 0) >= PAST_YEARS_MS);
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
    if (changed.length || tabsChanged) render();
  } finally {
    busy = false;
  }
  return true;
}

// Every entry of the read years as { date, key (category), name, amounts: { combined, <person>… }, entry,
// tab } in the chosen currency. Carry-overs are left out (they move last year's balance, not spending).
function spendingRows() {
  const rows = [];
  for (const title of titlesFor(picker.period)) {
    const year = cache.get(title)?.parsed;
    if (!year) continue;
    for (const block of year.blocks) {
      for (const entry of block.entries) {
        // An entry whose date is text counts in its month.
        const date = entry.date || (block.month ? `${block.month}-01` : null);
        if (!date) continue;
        const spent = spending(entry);
        const amounts = {};
        for (const [key, amount] of Object.entries(spent)) amounts[key] = convert(amount, year.year, currency);
        rows.push({ date, key: categoryKey(entry.category), name: entry.category, amounts, entry, tab: title });
      }
    }
  }
  return rows;
}

const minIso = (a, b) => (a < b ? a : b);
const maxIso = (a, b) => (a > b ? a : b);
const between = (rows, from, to) => rows.filter((r) => r.date >= from && r.date <= to);
const sum = (rows, key = who) => rows.reduce((total, r) => total + r.amounts[key], 0);

// Sums for everyone ({ combined, <person>… }) over the dates from..to.
function totals(rows, from, to) {
  const inRange = between(rows, from, to);
  return Object.fromEntries(WHO.map((w) => [w.key, sum(inRange, w.key)]));
}

// Per category: [{ key, name, value, colour }], largest first (categories that add up to nothing left out,
// unless keepZero).
function categoryTotals(rows, keepZero = false) {
  const byKey = new Map();
  for (const row of rows) {
    const item = byKey.get(row.key) || { key: row.key, name: '', value: 0 };
    item.name ||= row.name.trim();
    item.value += row.amounts[who];
    byKey.set(row.key, item);
  }
  return [...byKey.values()]
    .filter((c) => keepZero || Math.abs(c.value) >= 0.005)
    .map((c) => ({ ...c, name: c.name || 'No category', colour: CHART_COLOURS[c.key] || OTHER_CHART_COLOUR }))
    .sort((a, b) => b.value - a.value);
}

// ---- Comparisons ----

// Whether the period has started but isn't over (only then do "Up to today" and "Whole periods" differ).
function ongoing(period) {
  const today = todayIso();
  return period.from <= today && today < period.to;
}

// The same day `n` years earlier (29 February becomes 1 March).
function yearsEarlier(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return toIso(new Date(Date.UTC(y - n, m - 1, d)));
}

// The period `n` years before: the same month or year, otherwise the same dates.
function periodYearsBefore(period, n) {
  if (period.kind === 'month') return monthPeriod(yearsEarlier(period.from, n));
  if (period.kind === 'year') return yearPeriod(Number(period.from.slice(0, 4)) - n);
  const from = yearsEarlier(period.from, n);
  return { from, to: addDays(from, daysBetween(period.from, period.to)), kind: period.kind };
}

// What the widgets compare (see the top of the file), for everyone at once:
//   current  { from, to, totals }  the shown period (up to today, if that's chosen and it isn't over)
//   days     how many of its days are compared (null: all of them)
//   last     { from, to, totals } | null
//   mean     { periods: [{ from, to }], totals (averages) } | null     usual: the average…
//   median   { periods: [{ from, to }], totals (medians) } | null      …or the median of the earlier years
// (The median isn't pulled up by one exceptional year, e.g. the year a car was bought.)
function comparisons(period, rows) {
  const today = todayIso();
  const cut = compareMode === 'today' && ongoing(period) ? daysBetween(period.from, today) + 1 : null;
  const part = (p) => ({ from: p.from, to: cut ? minIso(p.to, addDays(p.from, cut - 1)) : p.to });
  const withTotals = (range) => ({ ...range, totals: totals(rows, range.from, range.to) });
  const current = withTotals(part(period));
  if (period.kind === 'all' || period.from > today) return { current, days: cut, last: null, mean: null, median: null };

  const firstDay = `${yearTitles.at(-1)}-01-01`; // Nothing is recorded before the oldest year tab.
  const previous = shift(period, -1);
  const last = previous.from >= firstDay ? withTotals(part(previous)) : null;
  const earlier = [];
  for (let n = 1; ; n++) {
    const p = periodYearsBefore(period, n);
    if (p.from < firstDay) break;
    earlier.push(part(p));
  }
  if (!earlier.length) return { current, days: cut, last, mean: null, median: null };
  const each = earlier.map((r) => totals(rows, r.from, r.to));
  const usual = (of) => ({ periods: earlier, totals: Object.fromEntries(WHO.map((w) => [w.key, of(each.map((t) => t[w.key]))])) });
  return { current, days: cut, last, mean: usual(mean), median: usual(median) };
}

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;

// The middle value (of an even number: the average of the two in the middle).
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// What the widgets compare with (the "vs" switch): names for switch, captions and explanations.
const BASES = {
  last: { switch: 'Last period', caption: 'Last period' },
  mean: { switch: 'Usual (Avg)', caption: 'Usual (avg)', how: 'average' },
  median: { switch: 'Usual (Med)', caption: 'Usual (med)', how: 'median' },
};

// "October in 2022–2025", "2022–2025", "the same dates in 2025" (of BASES.mean / median)
function usualText(period, usual) {
  const years = usual.periods.map((p) => Number(p.from.slice(0, 4)));
  const span = years.length > 1 ? `${Math.min(...years)}–${Math.max(...years)}` : String(years[0]);
  if (period.kind === 'month') return `${monthTitle(period.from).split(' ')[0]} in ${span}`;
  if (period.kind === 'year') return span;
  return `the same dates in ${span}`;
}

// "+12%" / "−8%" / "±0%" between two amounts, or null when there's nothing to compare with.
function change(now, before) {
  if (!(before > 0)) return null;
  return Math.round(((now - before) / before) * 100);
}

// ---- Formatting ----

const SYMBOL = { EUR: '€', BGN: 'лв' };

function money(amount) {
  const text = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  return `${text} ${SYMBOL[currency]}`;
}

// 1.57K €, 936 €, 17.7 €
function compactMoney(amount) {
  return `${compact(amount)} ${SYMBOL[currency]}`;
}

function compact(amount) {
  // (en-US writes thousands as "K"; en-GB as "k".)
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 }).format(amount);
}

// 01.09 – 25.09.2026 (the year once when both days are in the same year)
function rangeText(from, to) {
  if (from === to) return isoToBg(from);
  return from.slice(0, 4) === to.slice(0, 4) ? `${isoToBg(from).slice(0, 5)} – ${isoToBg(to)}` : `${isoToBg(from)} – ${isoToBg(to)}`;
}

function percent(part, whole) {
  return `${Math.round((part / whole) * 100)}%`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The selected person's name in their colour, or "Combined".
function whoLabel(key = who) {
  const person = PEOPLE.find((p) => p.key === key);
  return person ? el('span', `pname person-${person.key}`, person.name) : document.createTextNode('Combined');
}

// Whose spending a widget shows (next to its title).
function whoTag() {
  const tag = el('span', 'widget-who');
  tag.append(whoLabel());
  return tag;
}

function widgetHead(title, ...tools) {
  const head = el('div', 'widget-head');
  head.append(el('h3', null, title), ...tools);
  return head;
}

// A category's badge (its icon in the sheet's colour), ringed in its chart colour.
function categoryBadge(category, className = 'cat-badge small') {
  const badge = el('span', `${className} chart-ring`);
  const style = categoryStyle(category.name);
  if (style) {
    badge.style.setProperty('--cat', style.badge);
    badge.style.setProperty('--cat-ink', style.ink);
  }
  badge.style.setProperty('--c-light', category.colour[0]);
  badge.style.setProperty('--c-dark', category.colour[1]);
  badge.append(categoryIcon(style));
  return badge;
}

// A small switch of a few choices (like the person switch): [[value, label]…].
function segmented(choices, current, onPick, label) {
  const group = el('div', 'seg seg-inline seg-small');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const [value, text] of choices) {
    const item = el('button', `seg-item${value === current ? ' active' : ''}`, text);
    item.type = 'button';
    item.setAttribute('role', 'radio');
    item.setAttribute('aria-checked', String(value === current));
    item.addEventListener('click', () => onPick(value));
    group.append(item);
  }
  return group;
}

// ---- Choices: whose spending, comparing, currency ----

function setUpChoices() {
  const group = $('person');
  for (const w of WHO) {
    const item = el('button', `seg-item${w.key === 'combined' ? '' : ` person-${w.key}`}`, w.name);
    item.type = 'button';
    item.dataset.key = w.key;
    item.setAttribute('role', 'radio');
    item.addEventListener('click', () => {
      who = w.key;
      choiceChanged();
    });
    group.append(item);
  }
  $('btn-compare').addEventListener('click', () => {
    compareMode = compareMode === 'today' ? 'whole' : 'today';
    choiceChanged();
  });
  $('btn-currency').addEventListener('click', () => {
    currency = currency === 'EUR' ? 'BGN' : 'EUR';
    choiceChanged();
  });
  showChoices();
}

function choiceChanged() {
  showChoices();
  if (picker && cache.size) render();
}

function showChoices() {
  for (const item of $('person').children) {
    const active = item.dataset.key === who;
    item.classList.toggle('active', active);
    item.setAttribute('aria-checked', String(active));
  }

  const usualTip = (how) => `the ${how} of the same period in the earlier years`;
  const vs = segmented(Object.entries(BASES).map(([base, names]) => [base, names.switch]), compareWith, (base) => {
    compareWith = base;
    choiceChanged();
  }, 'Compare with');
  vs.children[0].title = 'Compare with the period just before';
  vs.children[1].title = `Compare with the usual amount: ${usualTip('average')}`;
  vs.children[2].title = `Compare with the usual amount: ${usualTip('median')} (one exceptional year, like a car bought, doesn't pull it up)`;
  $('compare-with').replaceChildren(vs);

  const compare = $('btn-compare');
  const toToday = compareMode === 'today';
  compare.replaceChildren(icon('calendar'), el('span', null, toToday ? 'Up to today' : 'Whole periods'));
  // Only a period that isn't over yet can be compared either way.
  compare.disabled = Boolean(picker) && !ongoing(picker.period);
  compare.title = compare.disabled
    ? 'This period is over, so it is compared with whole periods.'
    : toToday
      ? 'This period isn\'t over yet: it is compared with as many days of the others. Click to compare with them in full.'
      : 'This period isn\'t over yet, and it is compared with the others in full. Click to compare only as many days of them.';
  compare.setAttribute('aria-label', compare.title);

  const button = $('btn-currency');
  const euro = currency === 'EUR';
  button.replaceChildren(el('span', 'currency-code', currency));
  button.title = `Amounts in ${euro ? 'euro (EUR)' : 'leva (BGN)'}. Click for ${euro ? 'leva (BGN)' : 'euro (EUR)'}; 1 EUR = ${BGN_PER_EUR} BGN.`;
  button.setAttribute('aria-label', button.title);
}

// ---- Widgets ----

function render() {
  const period = picker.period;
  const rows = spendingRows();
  const compared = comparisons(period, rows);
  renderDashboard(period, compared);
  renderCategories(period, rows, compared);
  renderTimeline(period, rows, compared);
  renderCompare(period, rows, compared);
  renderReport(period, rows, compared);
  $('stats-note').textContent = 'How amounts are counted: Combined is everything paid, including cash in. '
    + 'A person\'s amount is what they actually paid: everything in their "Paid" and "Cash in" columns, in full '
    + '("Personal" is already part of "Paid"). Carry-overs from the year before are left out. '
    + `Leva and euro are converted at the fixed rate 1 EUR = ${BGN_PER_EUR} BGN.`;
}

// Tooltip lines comparing `now` with all three (last period, usual average, usual median), for `key`.
function comparisonTips(compared, key, now) {
  const lines = [];
  for (const [base, { caption }] of Object.entries(BASES)) {
    const other = compared[base];
    if (!other) continue;
    const d = change(now, other.totals[key]);
    lines.push(`${caption}: ${money(other.totals[key])}${d === null ? '' : ` (${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}%)`}`);
  }
  return lines;
}

// "Last period: 01.09 – 30.09.2026." / "Usual (median): the median of October in 2022–2025."
function baseText(period, compared) {
  const base = compared[compareWith];
  if (compareWith === 'last') return `Last period: ${rangeText(base.from, base.to)}.`;
  const { how } = BASES[compareWith];
  return `Usual (${how}): the ${how} of ${usualText(period, base)}.`;
}

// Dashboard: one gauge each for both of you together and for each person, compared with the last period
// or the usual amount (the "vs" switch above).
function renderDashboard(period, compared) {
  const box = $('w-dashboard');
  const base = compared[compareWith];

  const gauges = el('div', 'gauges');
  for (const w of WHO) {
    const spent = compared.current.totals[w.key];
    const before = base ? base.totals[w.key] : null;
    const diff = before === null ? null : change(spent, before);
    const item = el('div', 'gauge');
    const label = el('div', 'gauge-label');
    label.append(w.key === 'combined' ? 'Total spent' : whoLabel(w.key));
    item.append(gauge(diff === null ? null : spent / before), label, el('div', 'gauge-value', compactMoney(spent)));
    if (diff !== null) {
      // (The line below says what it's compared with.)
      const text = diff === 0 ? 'The same' : `${Math.abs(diff)}% ${diff > 0 ? 'above' : 'below'}`;
      item.append(el('div', 'gauge-sub', text), el('div', 'gauge-sub muted', `${BASES[compareWith].caption} ${compactMoney(before)}`));
    }
    // The tooltip compares with all three, whichever the gauges show.
    item.title = [`${w.key === 'combined' ? 'Total spent' : w.name}: ${money(spent)}`, ...comparisonTips(compared, w.key, spent)].join('\n');
    gauges.append(item);
  }

  let note;
  if (period.from > todayIso()) note = 'This period has not started yet.';
  else if (!base) note = `There is no ${compareWith === 'last' ? 'earlier period' : 'earlier year'} to compare with, so the gauges show no needle.`;
  else note = baseText(period, compared);
  if (base && compared.days) note += ` Only the first ${plural(compared.days, 'day')} of each are compared, as this period isn't over yet.`;
  if (base) note += ' Green: below 90%, orange: 90–110%, red: above 110%.';
  box.replaceChildren(widgetHead('Dashboard'), gauges, el('p', 'widget-note muted', note));
}

// Categories picked in the donut or the list (their amounts add up in the middle of the donut).
let picked = new Set();
// A click outside the card lets go of them (a click inside it that misses a small donut piece doesn't).
let clearPicked = null;
document.addEventListener('click', (event) => {
  if (!event.target.closest?.('#w-categories')) clearPicked?.();
});

// Expenses by category for the whole period: a donut and the list, compared with the last period and the
// usual amount.
function renderCategories(period, rows, compared) {
  const box = $('w-categories');
  const current = between(rows, period.from, period.to);
  const categories = categoryTotals(current);
  const total = sum(current);

  const top = el('div', 'cat-top');
  const headline = el('div', 'cat-total');
  headline.append(el('span', 'muted', period.label), el('strong', null, money(total)));
  top.append(headline, comparisonLines(period, compared));

  // The donut and the shares: only categories with spending (one made up of refunds is listed, not drawn).
  const positive = categories.filter((c) => c.value > 0);
  const positiveTotal = positive.reduce((s, c) => s + c.value, 0);
  const { svg, segments } = donut(positive.map((c) => ({ key: c.key, value: c.value, colour: c.colour })));
  const centre = el('div', 'donut-centre');
  const ring = el('div', 'donut');
  ring.append(svg, centre);

  const list = el('ul', 'cat-list');
  const items = new Map();
  for (const c of categories) {
    const li = el('li', 'cat-item');
    li.tabIndex = 0;
    const share = c.value > 0 ? percent(c.value, positiveTotal) : '';
    li.append(categoryBadge(c), el('span', 'cat-name', c.name), el('span', 'cat-share muted', share), el('span', 'cat-amount', money(c.value)));
    items.set(c.key, li);
    list.append(li);
  }

  // Pointing at a category (while none is picked) previews it. A click or tap adds it to the picked ones
  // or takes it out again; Ctrl+click picks only it.
  for (const key of [...picked]) if (!items.has(key)) picked.delete(key);
  let preview = null;
  const update = () => {
    const keys = preview ? new Set([preview]) : picked;
    const chosen = categories.filter((c) => keys.has(c.key));
    for (const [k, path] of segments) path.classList.toggle('dim', keys.size > 0 && !keys.has(k));
    for (const [k, li] of items) li.classList.toggle('active', picked.has(k));
    const label = el('span', 'muted');
    if (!chosen.length) {
      label.textContent = categories.length ? 'All categories' : 'Nothing spent';
      centre.replaceChildren(label, el('strong', null, compactMoney(total)));
      return;
    }
    const value = chosen.reduce((s, c) => s + c.value, 0);
    label.textContent = chosen.length === 1 ? chosen[0].name : `${chosen.length} categories`;
    const share = value > 0 && positiveTotal > 0 ? percent(value, positiveTotal) : '';
    centre.replaceChildren(label, el('strong', null, compactMoney(value)), el('span', 'muted', share));
  };
  const pick = (key, event) => {
    if ((event.ctrlKey || event.metaKey) && !touchInput()) {
      picked = new Set([key]);
    } else if (picked.has(key)) {
      picked.delete(key);
    } else {
      picked.add(key);
    }
    preview = null;
    update();
  };
  const endPreview = () => {
    if (preview === null) return;
    preview = null;
    update();
  };
  const bind = (node, key) => {
    node.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse' || picked.size) return;
      preview = key;
      update();
    });
    node.addEventListener('pointerleave', endPreview);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      pick(key, event);
    });
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      pick(key, event);
    });
  };
  for (const [key, li] of items) bind(li, key);
  for (const [key, path] of segments) bind(path, key);
  // A press that turns into dragging gets no pointerleave: end the preview anyway.
  for (const type of ['pointercancel', 'pointerleave']) ring.addEventListener(type, endPreview);
  ring.addEventListener('dragstart', (event) => event.preventDefault());
  clearPicked = () => {
    if (!picked.size) return;
    picked = new Set();
    update();
  };
  update();

  box.replaceChildren(widgetHead('Expenses by category', whoTag()), top, ring, list);
}

// "↑ +12%" in the colour of more or less spending (diff: from change()).
function deltaPill(diff) {
  const delta = el('span', `delta${diff > 0 ? ' delta-up' : diff < 0 ? ' delta-down' : ''}`);
  if (diff === null) {
    delta.textContent = 'nothing then';
  } else {
    if (diff) delta.append(icon(diff > 0 ? 'arrowUpSmall' : 'arrowDownSmall'));
    delta.append(`${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}%`);
  }
  return delta;
}

// Lines like "vs 01.09 – 25.09.2026  ↑ +12%" for the last period and the usual amount.
function comparisonLines(period, compared) {
  const box = el('div', 'cat-compare');
  const base = compared[compareWith];
  if (!base) return box;
  const now = compared.current.totals[who];
  const before = base.totals[who];
  const row = el('div', 'compare-line');
  const delta = deltaPill(change(now, before));
  const label = compareWith === 'last' ? `vs ${rangeText(base.from, base.to)}` : `vs ${BASES[compareWith].caption.toLowerCase()}`;
  row.append(el('span', 'muted', label), delta);
  // The tooltip: all three comparisons, and what they are.
  const days = compared.days ? ` Only the first ${plural(compared.days, 'day')} of each are compared.` : '';
  row.title = [`Now: ${money(now)}`, ...comparisonTips(compared, who, now), `${baseText(period, compared)}${days}`].join('\n');
  box.append(row);
  return box;
}

// ---- Expenses over time: per sub-period, as detailed as picked: stacked columns, a line of the totals or both ----

const UNIT_NAMES = { day: 'Day', week: 'Week', '2weeks': '2 weeks', month: 'Month', quarter: 'Quarter', year: 'Year' };
const UNIT_TEXT = {
  day: 'Per day',
  week: 'Per week (Monday to Sunday)',
  '2weeks': 'Per two weeks (from a Monday)',
  month: 'Per month',
  quarter: 'Per quarter',
  year: 'Per year',
};
const pad = (n) => String(n).padStart(2, '0');

// The levels of detail offered for a period, most detailed first. (Under a week: only days. A week: no
// calendar weeks, which would make one column.)
function unitChoices(period) {
  const days = daysBetween(period.from, period.to) + 1;
  if (days < 7) return ['day'];
  if (days === 7) return ['day', 'days'];
  if (days <= 31) return ['day', 'days', 'week'];
  if (days <= 366) return ['week', '2weeks', 'month'];
  return ['month', 'quarter', 'year'];
}

// A level picked in a switch (index: its place there), on a period that may offer fewer levels.
const pickedUnit = (choices, index) => choices[Math.min(index, choices.length - 1)];

// The period cut into pieces of about `size` days, whose lengths differ by one day at most (so that no
// short piece at the end looks like a drop in spending).
function evenPieces(period, size) {
  const days = daysBetween(period.from, period.to) + 1;
  const count = Math.ceil(days / size);
  const pieces = [];
  let from = period.from;
  for (let i = 0; i < count; i++) {
    const length = Math.floor(days / count) + (i < days % count ? 1 : 0);
    const to = addDays(from, length - 1);
    pieces.push({ from, to, start: from });
    from = addDays(to, 1);
  }
  return pieces;
}

const PIECE_DAYS = 4;

// "3–4 days" (or "4 days"): how long the pieces of the 'days' level are in this period.
function pieceLength(period) {
  const lengths = evenPieces(period, PIECE_DAYS).map((b) => daysBetween(b.from, b.to) + 1);
  const [few, many] = [Math.min(...lengths), Math.max(...lengths)];
  return `${few === many ? few : `${few}–${many}`} days`;
}

const unitName = (period, unit) => (unit === 'days' ? pieceLength(period) : UNIT_NAMES[unit]);
const unitText = (period, unit) => (unit === 'days' ? `Per ${pieceLength(period)}` : UNIT_TEXT[unit]);

// The switch of the levels offered for the period (nothing, when there's only one).
function detailSwitch(period, unit, onPick) {
  const choices = unitChoices(period);
  if (choices.length < 2) return el('span');
  return segmented(choices.map((u) => [u, unitName(period, u)]), unit, (u) => onPick(choices.indexOf(u)), 'How detailed');
}

function unitStart(iso, unit) {
  if (unit === 'day') return iso;
  if (unit === 'week' || unit === '2weeks') return weekStart(iso);
  if (unit === 'month') return monthStart(iso);
  if (unit === 'quarter') return `${iso.slice(0, 4)}-${pad(Math.floor((Number(iso.slice(5, 7)) - 1) / 3) * 3 + 1)}-01`;
  return `${iso.slice(0, 4)}-01-01`;
}

function nextStart(start, unit) {
  if (unit === 'day') return addDays(start, 1);
  if (unit === 'week') return addDays(start, 7);
  if (unit === '2weeks') return addDays(start, 14);
  return addMonths(start, { month: 1, quarter: 3, year: 12 }[unit]);
}

// Sub-periods of `unit` covering the period (the first and last cut to it).
function makeBins(period, unit) {
  if (unit === 'days') return evenPieces(period, PIECE_DAYS);
  const bins = [];
  for (let s = unitStart(period.from, unit); s <= period.to; s = nextStart(s, unit)) {
    bins.push({ from: maxIso(s, period.from), to: minIso(addDays(nextStart(s, unit), -1), period.to), start: s });
  }
  return bins;
}

function binLabels(bin, unit, manyYears) {
  const [y, m, d] = bin.start.split('-');
  const yy = `'${y.slice(2)}`;
  switch (unit) {
    case 'day': return { axis: `${Number(d)} ${shortMonth(bin.start)}`, title: isoToBg(bin.from) };
    case 'days':
    case 'week':
    case '2weeks': return { axis: `${Number(bin.from.slice(8))} ${shortMonth(bin.from)}`, title: rangeText(bin.from, bin.to) };
    case 'month': return { axis: manyYears ? `${shortMonth(bin.start)} ${yy}` : shortMonth(bin.start), title: monthTitle(bin.start) };
    case 'quarter': {
      const q = `Q${Math.floor((Number(m) - 1) / 3) + 1}`;
      return { axis: manyYears ? `${q} ${yy}` : q, title: `${q} ${y} (${rangeText(bin.from, bin.to)})` };
    }
    default: return { axis: y, title: y };
  }
}

// Narrowest column (with its gap) before the chart scrolls sideways; wider for fingers.
const minSlot = () => (window.matchMedia('(pointer: coarse)').matches ? 14 : 8);

const TIMELINE_VIEWS = [['columns', 'Bars'], ['line', 'Graph'], ['both', 'Both']];
let timelineView = 'columns';
let timelineTable = false; // Shown as a table instead of the chart.
let timelineWidth = 0;
let timelineData = null; // { period, rows } of the last render, for redrawing at another width.

// The level of detail: the one picked (detailIndex), otherwise the most detailed that fits the width.
function chosenUnit(period, width) {
  const choices = unitChoices(period);
  if (detailIndex !== null) return pickedUnit(choices, detailIndex);
  return choices.find((u) => makeBins(period, u).length * minSlot() <= width - 50) || choices.at(-1);
}

// The button that switches a widget between its chart and a table.
function tableSwitch(active, onClick) {
  const toggle = el('button', `icon-button${active ? ' active' : ''}`);
  toggle.type = 'button';
  toggle.append(icon('table'));
  toggle.title = active ? 'Show as a chart' : 'Show as a table';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-pressed', String(active));
  toggle.addEventListener('click', onClick);
  return toggle;
}

function renderTimeline(period, rows, compared) {
  timelineData = { period, rows };
  const box = $('w-timeline');
  const host = el('div', 'timeline-host');
  const toggle = tableSwitch(timelineTable, () => {
    timelineTable = !timelineTable;
    renderTimeline(period, rows, compared);
  });
  const top = el('div', 'cat-top');
  const headline = el('div', 'cat-total');
  headline.append(el('span', 'muted', period.label), el('strong', null, money(sum(between(rows, period.from, period.to)))));
  top.append(headline, comparisonLines(period, compared));
  // The level of detail sits in the header, left of the table switch (drawTimeline fills it).
  const detail = el('span', 'timeline-detail');
  // (A table is the same with any of the views.)
  const view = timelineTable ? el('span') : segmented(TIMELINE_VIEWS, timelineView, (value) => {
    timelineView = value;
    renderTimeline(period, rows, compared);
  }, 'How to draw it');
  box.replaceChildren(widgetHead('Expenses over time', whoTag(), view, detail, toggle), top, el('div', 'widget-sub muted timeline-unit'), host);
  timelineWidth = host.clientWidth;
  drawTimeline(host, period, rows);
}

// The dates the columns cover: the period, but one that isn't over yet only up to today (or up to its
// latest entry, if one is dated later), so the columns use the whole width.
function shownRange(period, rows) {
  const today = todayIso();
  if (!ongoing(period)) return period;
  const latest = rows.reduce((last, r) => maxIso(last, r.date), today);
  return { ...period, to: minIso(period.to, latest) };
}

// A line over the columns of the sub-periods `bins`: the totals of the smallest sub-period offered, each
// at the place of its middle day along the columns.
function finestPoints(range, bins, rows) {
  return makeBins(range, unitChoices(range)[0]).map((piece) => {
    const middle = addDays(piece.from, Math.floor(daysBetween(piece.from, piece.to) / 2));
    const i = bins.findIndex((bin) => middle <= bin.to);
    const days = daysBetween(bins[i].from, bins[i].to) + 1;
    return { at: i + (daysBetween(bins[i].from, middle) + 0.5) / days, value: sum(between(rows, piece.from, piece.to)) };
  });
}

function drawTimeline(host, period, rows) {
  const width = host.clientWidth;
  const current = between(rows, period.from, period.to);
  const range = shownRange(period, current);
  const unit = chosenUnit(range, width);
  const box = host.parentElement;
  box.querySelector('.timeline-detail').replaceChildren(detailSwitch(range, unit, (index) => {
    detailIndex = index;
    drawTimeline(host, period, rows);
  }));
  const finest = unitChoices(range)[0];
  const lineText = timelineView === 'both' && unit !== finest && !timelineTable ? `; the line per ${UNIT_NAMES[finest].toLowerCase()}` : '';
  box.querySelector('.timeline-unit').textContent = unitText(range, unit) + (range.to !== period.to ? `, up to ${isoToBg(range.to)}` : '') + lineText;

  const categories = categoryTotals(current);
  if (!categories.length) {
    host.replaceChildren(el('p', 'widget-empty muted', 'Nothing spent in this period.'));
    return;
  }
  const bins = makeBins(range, unit);
  const manyYears = range.from.slice(0, 4) !== range.to.slice(0, 4);
  for (const bin of bins) {
    Object.assign(bin, binLabels(bin, unit, manyYears));
    bin.values = new Map();
    for (const row of between(current, bin.from, bin.to)) bin.values.set(row.key, (bin.values.get(row.key) || 0) + row.amounts[who]);
    bin.total = [...bin.values.values()].reduce((s, v) => s + v, 0);
  }

  if (timelineTable) {
    host.replaceChildren(timelineTableView(bins, categories));
    return;
  }

  const height = window.matchMedia('(max-width: 600px)').matches ? 210 : 260;
  const chart = stackedColumns({
    width,
    height,
    bins: bins.map((b) => ({ label: b.axis, values: b.values })),
    categories,
    axisText: compact,
    minSlot: minSlot(),
    columns: timelineView !== 'line',
    line: {
      columns: null,
      line: { colour: COMPARE_COLOURS.current, area: true },
      // (Already the smallest: the line runs over the tops of the columns.)
      both: { colour: LINE_OVER_COLUMNS, halo: true, points: unit === finest ? null : finestPoints(range, bins, current) },
    }[timelineView],
  });
  // The value axis stays put; the columns scroll sideways when they don't fit.
  const frame = el('div', 'timeline-chart');
  const scroller = el('div', `timeline-scroll${chart.scrolls ? ' scrolls' : ''}`);
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'img');
  scroller.setAttribute('aria-label', `Expenses ${unitText(range, unit).toLowerCase()}; the table view lists every amount.`);
  scroller.append(chart.plot);
  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  frame.append(chart.axis, scroller, tip);

  let tipBin = null; // Bin shown in the tooltip.
  const showBin = (i) => {
    tipBin = i;
    chart.band(i);
    if (i === null) {
      tip.hidden = true;
      return;
    }
    const bin = bins[i];
    const parts = categories.map((c) => ({ c, v: bin.values.get(c.key) || 0 })).filter((p) => Math.abs(p.v) >= 0.005).sort((a, b) => b.v - a.v);
    const totalLine = el('div', 'tip-total');
    totalLine.append(el('strong', null, money(bin.total)));
    tip.replaceChildren(el('div', 'tip-title', bin.title), totalLine);
    if (parts.length) {
      // Badge, name, amount: the amounts line up after the longest name.
      const grid = el('div', 'tip-grid');
      for (const { c, v } of parts) grid.append(categoryBadge(c, 'cat-badge tiny'), el('span', 'tip-name', c.name), el('span', 'tip-value', money(v)));
      tip.append(grid);
    } else {
      tip.append(el('div', 'muted', 'Nothing spent'));
    }
    tip.hidden = false;
    // Beside the column, on whichever side has room.
    const x = chart.axis.width.baseVal.value + chart.centreOf(i) - scroller.scrollLeft;
    const w = tip.offsetWidth;
    const left = x + 14 + w <= frame.clientWidth ? x + 14 : x - 14 - w;
    tip.style.left = `${Math.max(0, Math.min(left, frame.clientWidth - w))}px`;
  };
  const binFromEvent = (event) => chart.binAt(event.clientX - chart.plot.getBoundingClientRect().left);
  // Mouse: follows the pointer; when the columns don't fit, dragging scrolls them (there's no scrollbar).
  // Finger: a tap shows that column (it stays until a tap elsewhere); sliding sideways moves along the
  // columns, unless they don't fit (then sliding scrolls them).
  let drag = null; // { x, left, moved } while the mouse drags the columns.
  scroller.addEventListener('pointermove', (event) => {
    if (drag) {
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) > 3 && !drag.moved) {
        drag.moved = true;
        showBin(null);
      }
      if (drag.moved) scroller.scrollLeft = drag.left - dx;
      return;
    }
    if (event.pointerType === 'mouse' || (event.buttons && !chart.scrolls)) showBin(binFromEvent(event));
  });
  scroller.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    closeChartTips('timeline');
    showBin(binFromEvent(event));
    if (event.pointerType === 'mouse' && event.button === 0 && chart.scrolls) {
      drag = { x: event.clientX, left: scroller.scrollLeft, moved: false };
      try { scroller.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
      scroller.classList.add('dragging');
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    scroller.addEventListener(type, () => {
      drag = null;
      scroller.classList.remove('dragging');
    });
  }
  scroller.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !drag) showBin(null);
  });
  scroller.addEventListener('scroll', () => showBin(null), { passive: true });
  scroller.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step) {
      event.preventDefault();
      showBin(Math.min(bins.length - 1, Math.max(0, (tipBin ?? (step > 0 ? -1 : bins.length)) + step)));
    } else if (event.key === 'Escape') {
      showBin(null);
    }
  });
  scroller.addEventListener('blur', () => showBin(null));
  chartTips.set('timeline', () => showBin(null));

  const legend = el('ul', 'chart-legend');
  for (const c of categories) {
    const item = el('li');
    const swatch = el('span', 'legend-swatch series-bg');
    swatch.style.setProperty('--c-light', c.colour[0]);
    swatch.style.setProperty('--c-dark', c.colour[1]);
    item.append(swatch, c.name);
    legend.append(item);
  }
  // (A line alone has one colour; the tooltip names its categories.)
  host.replaceChildren(...(timelineView === 'line' ? [frame] : [frame, legend]));
  // Columns that don't fit start at the newest ones while the period isn't over, otherwise at its start.
  if (chart.scrolls && ongoing(period)) scroller.scrollLeft = scroller.scrollWidth;
}

// The same numbers as a table: one row per sub-period with spending, its categories largest first.
function timelineTableView(bins, categories) {
  const table = el('table', 'stats-table');
  const head = table.createTHead().insertRow();
  head.append(el('th', null, 'Period'), el('th', 'num', 'Total'), el('th', null, 'Categories'));
  const body = table.createTBody();
  for (const bin of bins) {
    if (Math.abs(bin.total) < 0.005 && !bin.values.size) continue;
    const tr = body.insertRow();
    const parts = categories
      .map((c) => ({ c, v: bin.values.get(c.key) || 0 }))
      .filter((p) => Math.abs(p.v) >= 0.005)
      .sort((a, b) => b.v - a.v)
      .map((p) => `${p.c.name} ${money(p.v)}`);
    tr.append(el('td', null, bin.title), el('td', 'num', money(bin.total)), el('td', 'muted', parts.join(', ')));
  }
  const wrap = el('div', 'stats-table-wrap');
  wrap.append(table);
  return wrap;
}

// A tap anywhere else closes a chart's tooltip (the charts stop their own taps, and close the others').
const chartTips = new Map(); // Chart name -> closes its tooltip.
function closeChartTips(except) {
  for (const [name, close] of chartTips) if (name !== except) close();
}
document.addEventListener('pointerdown', () => closeChartTips());

// Redraw the columns when the widget's width changes (turning the phone, resizing the window).
new ResizeObserver(() => {
  const host = document.querySelector('#w-timeline .timeline-host');
  if (!host || !timelineData || host.clientWidth === timelineWidth) return;
  timelineWidth = host.clientWidth;
  drawTimeline(host, timelineData.period, timelineData.rows);
}).observe($('w-timeline'));

// ---- Line charts ----

const lineRedraws = new Map(); // Chart name -> { host, width, draw } for redrawing at another width.

function drawOnWidth(name, host, draw) {
  lineRedraws.set(name, { host, width: host.clientWidth, draw });
  draw();
}

const lineResize = new ResizeObserver(() => {
  for (const item of lineRedraws.values()) {
    if (!item.host.isConnected || item.host.clientWidth === item.width) continue;
    item.width = item.host.clientWidth;
    item.draw();
  }
});
lineResize.observe($('w-compare'));

const lineHeight = () => (window.matchMedia('(max-width: 600px)').matches ? 190 : 220);

// The chart with its tooltip. Mouse: follows the pointer. Finger: a tap shows that position (it stays until
// a tap elsewhere), sliding sideways moves along the chart. fillTip(tip, i) writes the tooltip of a position.
function lineFrame(name, chart, count, label, fillTip) {
  const frame = el('div', 'line-chart');
  frame.tabIndex = 0;
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', label);
  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  frame.append(chart.svg, tip);

  let shown = null;
  const show = (i) => {
    shown = i;
    chart.mark(i);
    if (i === null) {
      tip.hidden = true;
      return;
    }
    fillTip(tip, i);
    tip.hidden = false;
    // Beside the position, on whichever side has room.
    const x = chart.xOf(i);
    const w = tip.offsetWidth;
    const left = x + 14 + w <= frame.clientWidth ? x + 14 : x - 14 - w;
    tip.style.left = `${Math.max(0, Math.min(left, frame.clientWidth - w))}px`;
  };
  const at = (event) => Math.min(count - 1, chart.at(event.clientX - frame.getBoundingClientRect().left));
  frame.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || event.buttons) show(at(event));
  });
  frame.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    closeChartTips(name);
    show(at(event));
  });
  frame.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') show(null);
  });
  frame.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step) {
      event.preventDefault();
      show(Math.min(count - 1, Math.max(0, (shown ?? (step > 0 ? -1 : count)) + step)));
    } else if (event.key === 'Escape') {
      show(null);
    }
  });
  frame.addEventListener('blur', () => show(null));
  chartTips.set(name, () => show(null));
  return frame;
}

// ---- Period to period comparison: the running total of the current period, the one before and the same
// one a year ago, day by day from each period's start ----

// The periods to draw: [{ key, name, short, from, to }]. (Of a whole year, the period before is the same
// as the one a year ago: one line.)
function comparedPeriods(period) {
  const list = [{ key: 'current', name: 'Current period', short: 'Current', from: period.from, to: period.to }];
  if (period.kind === 'all') return list;
  const firstDay = `${yearTitles.at(-1)}-01-01`; // Nothing is recorded before the oldest year tab.
  const previous = shift(period, -1);
  const yearAgo = periodYearsBefore(period, 1);
  const same = previous.from === yearAgo.from && previous.to === yearAgo.to;
  if (previous.from >= firstDay) {
    list.push({ key: 'previous', name: same ? 'Previous period (a year ago)' : 'Previous period', short: 'Previous', from: previous.from, to: previous.to });
  }
  if (!same && yearAgo.from >= firstDay) {
    list.push({ key: 'yearAgo', name: 'Same period a year ago', short: 'A year ago', from: yearAgo.from, to: yearAgo.to });
  }
  return list;
}

// Axis text for each day of the period: every day when it's short; otherwise only the first of each month,
// and only the first of January over more than two years.
function dayLabels(period) {
  const days = daysBetween(period.from, period.to) + 1;
  const manyYears = period.from.slice(0, 4) !== period.to.slice(0, 4);
  const labels = [];
  for (let i = 0; i < days; i++) {
    const iso = addDays(period.from, i);
    const day = Number(iso.slice(8));
    if (days <= 92) labels.push(`${day} ${shortMonth(iso)}`);
    else if (days > 732) labels.push(iso.slice(5) === '01-01' ? iso.slice(0, 4) : '');
    else labels.push(day === 1 ? `${shortMonth(iso)}${manyYears ? ` '${iso.slice(2, 4)}` : ''}` : '');
  }
  return labels;
}

function renderCompare(period, rows, compared) {
  const box = $('w-compare');
  const host = el('div', 'timeline-host');
  const legend = el('ul', 'compare-legend');
  const note = el('p', 'widget-note muted');
  box.replaceChildren(widgetHead('Period to period comparison', whoTag()), host, legend, note);

  const perDay = new Map();
  for (const row of rows) perDay.set(row.date, (perDay.get(row.date) || 0) + row.amounts[who]);
  const current = between(rows, period.from, period.to);
  const lastDay = period.from > todayIso() ? null : shownRange(period, current).to;

  const series = comparedPeriods(period).map((p) => {
    const end = p.key === 'current' ? lastDay : p.to;
    const values = [];
    let running = 0;
    for (let iso = p.from; end && iso <= end; iso = addDays(iso, 1)) {
      running += perDay.get(iso) || 0;
      values.push(running);
    }
    return { ...p, values, colour: COMPARE_COLOURS[p.key] };
  });

  if (!series.some((s) => s.values.some((v) => Math.abs(v) >= 0.005))) {
    host.replaceChildren(el('p', 'widget-empty muted', 'Nothing spent in these periods.'));
    return;
  }

  // The amounts follow "Up to today / Whole periods"; the lines always show the earlier periods in full.
  const cut = compared.days;
  const amountEnd = (s) => (cut ? minIso(s.to, addDays(s.from, cut - 1)) : s.to);
  const amountOf = (s) => sum(between(rows, s.from, amountEnd(s)));
  const now = amountOf(series[0]);
  for (const s of series) {
    const amount = amountOf(s);
    const swatch = el('span', 'legend-swatch series-bg');
    swatch.style.setProperty('--c-light', s.colour[0]);
    swatch.style.setProperty('--c-dark', s.colour[1]);
    const name = el('span', 'compare-name');
    name.append(el('span', null, s.name), el('span', 'muted', rangeText(s.from, amountEnd(s))));
    const item = el('li');
    item.append(swatch, name, el('span', 'compare-amount', money(amount)));
    item.append(s.key === 'current' ? el('span') : deltaPill(change(now, amount)));
    legend.append(item);
  }
  note.textContent = 'Running totals, day by day from the start of each period.'
    + (cut ? ` The amounts cover the first ${plural(cut, 'day')} of each, as this period isn't over yet.` : '');

  const count = Math.max(...series.map((s) => daysBetween(s.from, s.to) + 1));
  const ownLabels = dayLabels(period);
  const labels = Array.from({ length: count }, (_, i) => ownLabels[i] || '');
  drawOnWidth('compare', host, () => {
    const chart = lineChart({
      width: host.clientWidth,
      height: lineHeight(),
      count,
      labels,
      // (The current period on top.)
      lines: [...series].reverse().map((s) => ({ colour: s.colour, values: s.values, area: s.key === 'current' })),
      axisText: compact,
    });
    host.replaceChildren(lineFrame('compare', chart, count, 'Running total of the current period, the period before and the same period a year ago; the list below gives their amounts.', (tip, i) => {
      const grid = el('div', 'tip-grid');
      for (const s of series) {
        if (i >= s.values.length) continue;
        const swatch = el('span', 'legend-swatch series-bg');
        swatch.style.setProperty('--c-light', s.colour[0]);
        swatch.style.setProperty('--c-dark', s.colour[1]);
        grid.append(swatch, el('span', 'tip-name', `${s.short}, ${isoToBg(addDays(s.from, i)).slice(0, 5)}`), el('span', 'tip-value', money(s.values[i])));
      }
      tip.replaceChildren(el('div', 'tip-title', `Day ${i + 1}: spent so far`), grid);
    }));
  });
}

// ---- Expenses report: per category, the shown period and the ones before it, with the records behind
// every amount ----

const REPORT_MAX = 6;
let reportCount = 3; // How many periods to show (fewer when there aren't as many).
let reportPercent = false; // Show how much each amount differs from the period before it.
let reportSort = 'category'; // 'category' (by name) | 'highest' | 'lowest' (by the amount of the newest period)
const REPORT_SORTS = [['category', 'Category'], ['highest', 'Highest first'], ['lowest', 'Lowest first']];

// The shown period and the ones before it, newest first: { label, sub, from, to }. One more than can be
// shown, for the percentages of the last column. (Up to today, the same days of each, as everywhere.)
function reportPeriods(period, compared) {
  const list = [period];
  if (period.kind !== 'all') {
    const firstDay = `${yearTitles.at(-1)}-01-01`; // Nothing is recorded before the oldest year tab.
    for (let p = shift(period, -1); list.length <= REPORT_MAX && p.from >= firstDay; p = shift(p, -1)) list.push(p);
  }
  return list.map((p) => {
    const to = compared.days ? minIso(p.to, addDays(p.from, compared.days - 1)) : p.to;
    const named = p.kind === 'month' || p.kind === 'year';
    return { from: p.from, to, label: named ? p.label : rangeText(p.from, to), sub: named && to !== p.to ? rangeText(p.from, to) : '' };
  });
}

function renderReport(period, rows, compared) {
  const box = $('w-report');
  const counted = rows.filter((r) => Math.abs(r.amounts[who]) >= 0.005);
  const periods = reportPeriods(period, compared).map((p) => ({ ...p, rows: between(counted, p.from, p.to) }));
  const available = Math.min(REPORT_MAX, periods.length);
  const columns = periods.slice(0, Math.min(reportCount, available));

  const tools = [whoTag()];
  if (available > 1) {
    const counts = Array.from({ length: available - 1 }, (_, i) => [i + 2, String(i + 2)]);
    const count = el('span', 'report-count');
    count.append(el('span', 'muted', 'Periods'), segmented(counts, columns.length, (n) => {
      reportCount = n;
      renderReport(period, rows, compared);
    }, 'How many periods'));
    const percentSwitch = el('button', `icon-button report-percent${reportPercent ? ' active' : ''}`, '%');
    percentSwitch.type = 'button';
    percentSwitch.title = reportPercent ? 'Hide the change from the period before' : 'Show the change from the period before';
    percentSwitch.setAttribute('aria-label', percentSwitch.title);
    percentSwitch.setAttribute('aria-pressed', String(reportPercent));
    percentSwitch.addEventListener('click', () => {
      reportPercent = !reportPercent;
      renderReport(period, rows, compared);
    });
    tools.push(count, percentSwitch);
  }
  const sorting = el('span', 'report-count');
  sorting.append(el('span', 'muted', 'Sort'), segmented(REPORT_SORTS, reportSort, (value) => {
    reportSort = value;
    renderReport(period, rows, compared);
  }, 'How to sort the categories'));
  tools.splice(1, 0, sorting);
  const head = widgetHead('Expenses report', ...tools);

  // The same categories whatever the sorting, in the order chosen (equal amounts by name).
  const newest = new Map(categoryTotals(columns[0].rows, true).map((c) => [c.key, c.value]));
  const amountOf = (c) => newest.get(c.key) || 0;
  const sign = { highest: -1, lowest: 1 }[reportSort];
  const categories = categoryTotals(columns.flatMap((c) => c.rows), true)
    .sort((a, b) => (sign ? sign * (amountOf(a) - amountOf(b)) : 0) || a.name.localeCompare(b.name));
  if (!categories.length) {
    box.replaceChildren(head, el('p', 'widget-empty muted', 'Nothing spent in these periods.'));
    return;
  }

  const table = el('table', 'stats-table report-table');
  const headRow = table.createTHead().insertRow();
  headRow.append(el('th', null, 'Category'));
  for (const column of columns) {
    const th = el('th', 'num', column.label);
    if (column.sub) th.append(el('div', 'muted report-sub', column.sub));
    headRow.append(th);
  }

  // The amount of a column (of the rows `of` picks), its change from the period before and, with `onRecords`,
  // the button showing its records.
  const amountCell = (i, of, onRecords) => {
    const picked = of(periods[i].rows);
    const now = sum(picked);
    const line = el('div', 'report-cell');
    if (onRecords && picked.length) {
      const button = el('button', 'icon-button report-records');
      button.type = 'button';
      button.append(icon('records'));
      button.title = `Show the ${plural(picked.length, 'record')}`;
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => onRecords(periods[i], picked));
      line.append(button);
    }
    if (reportPercent && periods[i + 1]) {
      const before = sum(of(periods[i + 1].rows));
      if (before > 0) line.append(deltaPill(change(now, before)));
      else if (now > 0) line.append(el('span', 'delta', 'new'));
    }
    line.append(el('span', picked.length ? null : 'muted', money(now)));
    const td = el('td', `num${i === 0 ? ' report-now' : ''}`);
    td.append(line);
    return td;
  };

  const body = table.createTBody();
  const total = body.insertRow();
  total.className = 'report-total';
  total.append(el('td', null, 'Total'), ...columns.map((_, i) => amountCell(i, (list) => list)));
  for (const category of categories) {
    const tr = body.insertRow();
    const name = el('td');
    const label = el('div', 'report-name');
    // (A long name may wrap after a slash too.)
    label.append(categoryBadge(category), el('span', null, category.name.replaceAll('/', '/​')));
    name.append(label);
    const of = (list) => list.filter((r) => r.key === category.key);
    tr.append(name, ...columns.map((_, i) => amountCell(i, of, (column, picked) => showRecords(category, column, picked))));
  }
  const wrap = el('div', 'stats-table-wrap report-wrap');
  wrap.append(table);

  const parts = [];
  if (reportPercent) parts.push('Percentages: the change from the period before.');
  if (compared.days) parts.push(`Only the first ${plural(compared.days, 'day')} of each are counted, as this period isn't over yet.`);
  box.replaceChildren(head, wrap);
  if (parts.length) box.append(el('p', 'widget-note muted', parts.join(' ')));
}

// Where a record is in the spreadsheet: "2026, row 123", a link to that row (the test data has no spreadsheet).
function recordPlace(row) {
  const text = `${row.tab}, row ${row.entry.rowNumber}`;
  if (fixture) return el('span', null, text);
  const sheetId = meta.sheets.find((s) => s.properties.title === row.tab)?.properties.sheetId;
  const link = el('a', null, text);
  link.href = `${spreadsheetUrl(spreadsheetId, sheetId)}&range=A${row.entry.rowNumber}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Open this row in Google Sheets';
  return link;
}

// The records behind an amount, by date: what they were, who paid and which row of the spreadsheet they're in.
function showRecords(category, column, rows) {
  const { body, foot } = openDialog({ title: `${category.name}, ${column.sub || column.label}`, className: 'records-dialog' });
  foot.remove();
  const summary = el('div', 'records-sum');
  summary.append(el('strong', null, `Found ${plural(rows.length, 'record')}`), whoTag(), el('strong', null, money(sum(rows))));
  body.append(summary);

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.entry.rowNumber - b.entry.rowNumber);
  for (const date of new Set(sorted.map((r) => r.date))) {
    const onDate = sorted.filter((r) => r.date === date);
    const group = el('div', 'records-day');
    const dayHead = el('div', 'records-day-head');
    dayHead.append(el('span', null, isoToBg(date)), el('span', null, money(sum(onDate))));
    group.append(dayHead);
    for (const row of onDate) {
      const item = el('div', 'records-item');
      const what = el('div', 'records-what');
      const details = el('div', 'muted records-details');
      // Both together: who paid (and how much, when both did).
      if (who === 'combined') {
        const payers = PEOPLE.filter((p) => Math.abs(row.amounts[p.key]) >= 0.005);
        for (const person of payers) {
          details.append(whoLabel(person.key));
          if (payers.length > 1) details.append(` ${money(row.amounts[person.key])}`);
          details.append(' · ');
        }
      }
      details.append(recordPlace(row));
      if (!row.entry.date) details.append(` · the date in the sheet: "${row.entry.rawDate}"`);
      what.append(el('div', null, row.entry.description || category.name), details);
      item.append(what, el('span', 'records-amount', money(row.amounts[who])));
      group.append(item);
    }
    body.append(group);
  }
}

$('btn-signin').addEventListener('click', () =>
  run(async () => {
    await signIn();
    await open();
  }),
);

start();
