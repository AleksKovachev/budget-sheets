// Calendar shared by the period picker and the date popup of date cells.
// Three views: days of a month (weeks start on Monday), months of a year, and years of a decade.
// Clicking the title goes up a level (month → year → decade); picking a month or year goes back down,
// unless the caller handles the pick itself (e.g. the period picker's "Months" mode).
// Dates are ISO strings ('YYYY-MM-DD'); arithmetic in UTC so daylight saving never shifts a day.

import { el, placeFloating, touchInput } from './ui.js';
import { icon } from './icons.js';
import { isoToBg, bgToIso } from './dates.js';

const DAY = 86_400_000;
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const toIso = (date) => date.toISOString().slice(0, 10);
export const addDays = (iso, n) => toIso(new Date(toDate(iso).getTime() + n * DAY));
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);

export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  return toIso(new Date(Date.UTC(y, m, 0)));
}

export function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  return toIso(new Date(Date.UTC(y, m - 1 + n, 1)));
}

// Same day one year earlier (29 Feb becomes 1 Mar).
export function yearBefore(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return toIso(new Date(Date.UTC(y - 1, m - 1, d)));
}

export function monthTitle(iso) {
  return toDate(iso).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Fixed three-letter names (browsers differ, e.g. "Sep" vs "Sept").
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortMonth(iso) {
  return SHORT_MONTHS[Number(iso.slice(5, 7)) - 1];
}

// Monday of the week containing the day.
export function weekStart(iso) {
  return addDays(iso, -((toDate(iso).getUTCDay() + 6) % 7));
}

function navButton(name, title, onClick) {
  const button = el('button', 'icon-button');
  button.type = 'button';
  button.title = title;
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

// state: { view: 'days' | 'months' | 'years', shown: first day of the month shown } (changed by navigation).
// options (all optional):
//   dayClasses(day), pickDay(day), hoverDay(day), leaveDays()
//   monthClasses(firstOfMonth), pickMonth(firstOfMonth)   default: open that month's days
//   yearClasses(year), pickYear(year)                     default: open that year's months
//   topView: highest view the title may open ('years' by default)
// redraw(): called after navigation; it should call calendarView() again.
export function calendarView(state, options, redraw) {
  const year = Number(state.shown.slice(0, 4));
  const decade = Math.floor(year / 10) * 10;
  const wrap = el('div', 'calendar');

  const step = { days: (n) => addMonths(state.shown, n), months: (n) => addMonths(state.shown, 12 * n), years: (n) => addMonths(state.shown, 120 * n) }[state.view];
  const titleText = { days: monthTitle(state.shown), months: String(year), years: `${decade} – ${decade + 9}` }[state.view];
  const levels = ['days', 'months', 'years'];
  const up = levels[levels.indexOf(state.view) + 1];
  const canGoUp = up && levels.indexOf(up) <= levels.indexOf(options.topView || 'years');

  const title = el('button', 'cal-title', titleText);
  title.type = 'button';
  if (canGoUp) {
    title.title = up === 'months' ? 'Show the months of this year' : 'Show the years';
    title.addEventListener('click', () => { state.view = up; redraw(); });
  } else {
    title.disabled = true;
  }
  const head = el('div', 'cal-head');
  head.append(
    navButton('chevronLeft', 'Back', () => { state.shown = step(-1); redraw(); }),
    title,
    navButton('chevronRight', 'Forward', () => { state.shown = step(1); redraw(); }),
  );

  let grid;
  if (state.view === 'days') {
    grid = el('div', 'cal-grid days');
    for (const name of WEEKDAYS) grid.append(el('span', 'cal-weekday', name));
    const start = weekStart(state.shown);
    const today = todayIso();
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const cell = el('button', 'cal-day', String(Number(day.slice(8))));
      cell.type = 'button';
      cell.dataset.day = day;
      if (day.slice(0, 7) !== state.shown.slice(0, 7)) cell.classList.add('outside');
      if (i % 7 >= 5) cell.classList.add('weekend');
      if (day === today) cell.classList.add('today');
      cell.classList.add(...(options.dayClasses?.(day) || []));
      cell.addEventListener('click', () => options.pickDay?.(day));
      if (options.hoverDay) cell.addEventListener('pointerenter', () => options.hoverDay(day));
      grid.append(cell);
    }
    if (options.leaveDays) grid.addEventListener('pointerleave', () => options.leaveDays());
  } else if (state.view === 'months') {
    grid = el('div', 'cal-grid months');
    const thisMonth = monthStart(todayIso());
    for (let m = 0; m < 12; m++) {
      const first = `${year}-${String(m + 1).padStart(2, '0')}-01`;
      const cell = el('button', 'cal-day cal-cell', shortMonth(first));
      cell.type = 'button';
      cell.dataset.month = first;
      if (first === thisMonth) cell.classList.add('today');
      cell.classList.add(...(options.monthClasses?.(first) || []));
      cell.addEventListener('click', () => {
        if (options.pickMonth) options.pickMonth(first);
        else { state.view = 'days'; state.shown = first; redraw(); }
      });
      grid.append(cell);
    }
  } else {
    grid = el('div', 'cal-grid years');
    const thisYear = Number(todayIso().slice(0, 4));
    for (let y = decade; y < decade + 10; y++) {
      const cell = el('button', 'cal-day cal-cell', String(y));
      cell.type = 'button';
      cell.dataset.year = y;
      if (y === thisYear) cell.classList.add('today');
      cell.classList.add(...(options.yearClasses?.(y) || []));
      cell.addEventListener('click', () => {
        if (options.pickYear) options.pickYear(y);
        else { state.view = 'months'; state.shown = `${y}-${state.shown.slice(5, 7)}-01`; redraw(); }
      });
      grid.append(cell);
    }
  }
  wrap.append(head, grid);
  return wrap;
}

// Highlight for a range [lo, hi] of ISO dates: days inside are "in-range", the ends are "edge".
export function rangeClasses(day, lo, hi) {
  const classes = [];
  if (lo && day >= lo && day <= hi) classes.push('in-range');
  if (day === lo || day === hi) classes.push('edge');
  return classes;
}

// ---- Date popup: one date, shown next to an element (used by date cells) ----

let openPopup = null;
let openAnchor = null;

export function closeDatePopup() {
  openPopup?.remove();
  openAnchor?.classList.remove('is-open');
  openPopup = null;
  openAnchor = null;
}

// anchor: element to show next to (marked "is-open" meanwhile). value: ISO date or null.
// onPick(iso) when a day is chosen; onClear() (optional) adds a "Clear" button that empties the date.
// typed: true adds a text field on top for typing the date (dd.mm.yyyy and the short forms); Enter applies.
export function openDatePopup({ anchor, value, onPick, onClear, typed = false }) {
  closeDatePopup();
  const popup = el('div', 'date-popup');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Choose a date');
  const state = { view: 'days', shown: monthStart(value || todayIso()) };
  let shownValue = value; // Highlighted day (follows what is typed).
  const pick = (iso) => { closeDatePopup(); onPick(iso); };

  let input = null;
  if (typed) {
    input = el('input', 'date-input');
    input.value = value ? isoToBg(value) : '';
    input.placeholder = 'dd.mm.yyyy';
    input.setAttribute('aria-label', 'Date (day.month.year)');
    input.addEventListener('input', () => {
      const iso = bgToIso(input.value);
      input.classList.toggle('invalid', Boolean(input.value.trim()) && !iso);
      if (iso) {
        shownValue = iso;
        state.view = 'days';
        state.shown = monthStart(iso);
        drawCalendar();
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const iso = bgToIso(input.value);
      if (iso) pick(iso);
      else input.classList.add('invalid');
    });
  }

  const calendarSlot = el('div');
  const drawCalendar = () => {
    calendarSlot.replaceChildren(calendarView(state, {
      dayClasses: (day) => (day === shownValue ? ['edge'] : []),
      monthClasses: (first) => (shownValue && first === monthStart(shownValue) ? ['edge'] : []),
      yearClasses: (y) => (shownValue && y === Number(shownValue.slice(0, 4)) ? ['edge'] : []),
      pickDay: pick,
    }, drawCalendar));
  };
  drawCalendar();

  const footer = el('div', 'cal-presets');
  const today = el('button', 'chip', 'Today');
  today.type = 'button';
  today.addEventListener('click', () => pick(todayIso()));
  footer.append(today);
  if (onClear && value) {
    const clear = el('button', 'chip', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => { closeDatePopup(); onClear(); });
    footer.append(clear);
  }
  popup.append(...(input ? [input] : []), calendarSlot, footer);
  popup.addEventListener('click', (event) => event.stopPropagation());
  popup.addEventListener('pointerdown', (event) => event.stopPropagation());
  placeFloating(popup, anchor);
  openPopup = popup;
  openAnchor = anchor;
  anchor.classList.add('is-open');
  // Ready for typing with a keyboard; by finger the calendar is what's used, so no on-screen keyboard
  // (it would cover the calendar). Tapping the field still allows typing.
  if (input && !touchInput()) {
    input.focus();
    input.select();
  }
}

document.addEventListener('pointerdown', () => closeDatePopup());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDatePopup();
});
