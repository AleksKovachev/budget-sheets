// Period picker: a button showing the selected period (with ‹ › to step back and forth) that opens a
// panel with four ways of choosing:
//   Custom range – click the first day, then the last
//   Weeks        – hover shows the week (Monday–Sunday), click picks it
//   Months       – the months of a year
//   Years        – the years of a decade
// plus quick presets. Clicking the calendar title goes up (month → year → decade), handy for old records.
// Periods are { from, to, kind, label } with ISO dates; kind decides how ‹ › step: 'week', 'month',
// 'year', 'days' (same length) or 'all' (no stepping).

import { $, el } from './ui.js';
import { icon } from './icons.js';
import { isoToBg } from './dates.js';
import {
  addDays, addMonths, daysBetween, monthStart, monthEnd, monthTitle, todayIso, yearBefore, weekStart,
  calendarView, rangeClasses,
} from './calendar.js';

export { todayIso };

const MODES = [['custom', 'Custom range'], ['weeks', 'Weeks'], ['months', 'Months'], ['years', 'Years']];

export function monthPeriod(iso) {
  const from = monthStart(iso);
  return { from, to: monthEnd(from), kind: 'month', label: monthTitle(from) };
}

export function yearPeriod(year) {
  return { from: `${year}-01-01`, to: `${year}-12-31`, kind: 'year', label: String(year) };
}

function weekPeriod(iso) {
  const from = weekStart(iso);
  return customPeriod(from, addDays(from, 6), 'week');
}

function customPeriod(from, to, kind = 'days') {
  const label = from === to ? isoToBg(from) : `${isoToBg(from)} – ${isoToBg(to)}`;
  return { from, to, kind, label };
}

// One step back (-1) or forward (+1), keeping the kind of period.
function shift(period, direction) {
  if (period.kind === 'month') return monthPeriod(addMonths(period.from, direction));
  if (period.kind === 'year') return yearPeriod(Number(period.from.slice(0, 4)) + direction);
  if (period.kind === 'week') return weekPeriod(addDays(period.from, 7 * direction));
  const length = daysBetween(period.from, period.to) + 1;
  return customPeriod(addDays(period.from, length * direction), addDays(period.to, length * direction));
}

export class PeriodPicker {
  // years: () => list of years with data (newest first). onChange(period) is called on every change.
  // period: the one to start with (default: this month).
  constructor({ years, onChange, period = monthPeriod(todayIso()) }) {
    this.years = years;
    this.onChange = onChange;
    this.period = period;
    this.mode = 'custom';
    this.cal = { view: 'days', shown: monthStart(this.period.to) };
    this.anchor = null; // First clicked day while picking a custom range.
    this.hover = null; // Day under the mouse (custom range end, or a day of the hovered week).

    this.button = $('period-btn');
    this.panel = $('period-panel');
    $('period-prev').replaceChildren(icon('chevronLeft'));
    $('period-next').replaceChildren(icon('chevronRight'));
    $('period-prev').addEventListener('click', () => this.set(shift(this.period, -1)));
    $('period-next').addEventListener('click', () => this.set(shift(this.period, 1)));
    this.button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.panel.hidden) this.open();
      else this.close();
    });
    this.panel.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
    this.updateButton();
  }

  set(period) {
    this.period = period;
    this.anchor = null;
    this.updateButton();
    this.close();
    this.onChange(period);
  }

  // Shows `period` without calling onChange (e.g. after signing out, when there's nothing to load).
  reset(period) {
    this.period = period;
    this.anchor = null;
    this.close();
    this.updateButton();
  }

  updateButton() {
    this.button.replaceChildren(icon('calendar'), el('span', null, this.period.label));
    const canStep = this.period.kind !== 'all';
    $('period-prev').disabled = !canStep;
    $('period-next').disabled = !canStep;
  }

  open() {
    this.setMode('custom', false);
    this.panel.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.render();
  }

  close() {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.anchor = null;
    this.hover = null;
  }

  setMode(mode, redraw = true) {
    this.mode = mode;
    this.anchor = null;
    this.hover = null;
    this.cal = { view: mode === 'months' ? 'months' : mode === 'years' ? 'years' : 'days', shown: monthStart(this.period.to) };
    if (redraw) this.render();
  }

  // Days highlighted: the custom range being picked, the hovered week, or the selected period.
  dayRange() {
    if (this.mode === 'custom' && this.anchor) {
      const other = this.hover || this.anchor;
      return this.anchor <= other ? [this.anchor, other] : [other, this.anchor];
    }
    if (this.mode === 'weeks' && this.hover) {
      const from = weekStart(this.hover);
      return [from, addDays(from, 6)];
    }
    return [this.period.from, this.period.to];
  }

  calendarOptions() {
    const days = {
      dayClasses: (day) => rangeClasses(day, ...this.dayRange()),
      hoverDay: (day) => {
        if (this.mode === 'weeks' || this.anchor) {
          this.hover = day;
          this.paintDays();
        }
      },
      leaveDays: () => {
        if (this.mode === 'weeks') {
          this.hover = null;
          this.paintDays();
        }
      },
      pickDay: (day) => (this.mode === 'weeks' ? this.set(weekPeriod(day)) : this.pickCustom(day)),
    };
    const fromMonth = monthStart(this.period.from);
    const toMonth = monthStart(this.period.to);
    const fromYear = Number(this.period.from.slice(0, 4));
    const toYear = Number(this.period.to.slice(0, 4));
    const highlight = {
      monthClasses: (first) => rangeClasses(first, fromMonth, toMonth),
      yearClasses: (y) => rangeClasses(String(y), String(fromYear), String(toYear)),
    };
    if (this.mode === 'months') return { ...days, ...highlight, pickMonth: (first) => this.set(monthPeriod(first)) };
    if (this.mode === 'years') return { ...days, ...highlight, topView: 'years', pickYear: (y) => this.set(yearPeriod(y)) };
    return { ...days, ...highlight }; // Custom range and weeks: months/years only navigate.
  }

  render() {
    const tabs = el('div', 'seg');
    tabs.setAttribute('role', 'tablist');
    for (const [mode, label] of MODES) {
      const tab = el('button', 'seg-item', label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(mode === this.mode));
      if (mode === this.mode) tab.classList.add('active');
      tab.addEventListener('click', () => this.setMode(mode));
      tabs.append(tab);
    }

    const calendar = calendarView(this.cal, this.calendarOptions(), () => this.render());

    const hints = {
      custom: this.anchor ? `From ${isoToBg(this.anchor)}: now click the last day` : 'Click the first day, then the last day',
      weeks: 'Click a week',
      months: 'Click a month',
      years: 'Click a year',
    };
    const hint = el('div', 'cal-hint muted', this.cal.view === 'days' || this.mode === 'months' || this.mode === 'years' ? hints[this.mode] : 'Click a month to see its days');
    hint.id = 'cal-hint';

    const today = todayIso();
    const presets = el('div', 'cal-presets');
    const chips = [
      ['This week', () => weekPeriod(today)],
      ['This month', () => monthPeriod(today)],
      ['This year', () => yearPeriod(Number(today.slice(0, 4)))],
      ['7 days', () => customPeriod(addDays(today, -6), today)],
      ['30 days', () => customPeriod(addDays(today, -29), today)],
      ['90 days', () => customPeriod(addDays(today, -89), today)],
      ['12 months', () => customPeriod(addDays(yearBefore(today), 1), today)],
      ['All', () => this.allPeriod()],
    ];
    for (const [label, make] of chips) presets.append(this.chip(label, make));

    this.panel.replaceChildren(tabs, calendar, hint, presets);
  }

  chip(label, make) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    const period = make();
    if (period.from === this.period.from && period.to === this.period.to) chip.classList.add('active');
    chip.addEventListener('click', () => this.set(period));
    return chip;
  }

  allPeriod() {
    const years = this.years();
    const first = years.at(-1) ?? Number(todayIso().slice(0, 4));
    const last = years[0] ?? first;
    return { from: `${first}-01-01`, to: `${last}-12-31`, kind: 'all', label: 'All time' };
  }

  // "All time" covers the year tabs there are now (call when tabs were added or deleted, or when a saved
  // period is restored). Returns true if the shown period changed (without calling onChange).
  followYears() {
    if (this.period.kind !== 'all') return false;
    const all = this.allPeriod();
    if (all.from === this.period.from && all.to === this.period.to) return false;
    this.period = all;
    this.updateButton();
    return true;
  }

  pickCustom(day) {
    if (!this.anchor) {
      this.anchor = day;
      this.hover = day;
      this.render();
      return;
    }
    const [from, to] = this.anchor <= day ? [this.anchor, day] : [day, this.anchor];
    // A whole calendar month picked by hand still steps month by month.
    if (from === monthStart(from) && to === monthEnd(from)) this.set(monthPeriod(from));
    else this.set(customPeriod(from, to));
  }

  // Updates the day highlight (custom range end, hovered week) without rebuilding the calendar.
  paintDays() {
    const [lo, hi] = this.dayRange();
    for (const cell of this.panel.querySelectorAll('.cal-day[data-day]')) {
      const classes = rangeClasses(cell.dataset.day, lo, hi);
      cell.classList.toggle('in-range', classes.includes('in-range'));
      cell.classList.toggle('edge', classes.includes('edge'));
    }
  }
}
