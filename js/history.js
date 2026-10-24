// Undo and redo of the changes made in this app: on the main page (editor.js) and on the raw data page,
// including creating a year tab. The list is kept for this browser tab (sessionStorage), so it carries
// over between the two pages, and is forgotten when signing out or opening another spreadsheet.
//
// Each change is stored as what a row held before and after it (whole rows, formulas as formulas).
// Undoing finds the row again by its content (rows may have been added or removed meanwhile) and puts the
// old content back. If the row was changed in Google Sheets since, nothing is done and that step is dropped;
// a step that fails before changing anything (no connection, sign-in ran out) stays, to try again.
//
// Steps (op):
//   edit   { fromTitle, toTitle, from, to, row, toRow?, fromAbove?, inPlace? }  a row's content changed;
//          main-page date changes may move it (inPlace: the raw page, where nothing moves)
//   add    { title, cells, row, above, plain? }   a row was added (below the row `above`)
//   delete { title, cells, row, above, plain? }   a row was removed (plain: just that row; otherwise as on
//          the main page, with its month's blank row if the month became empty)
//   tab    { title, snapshot }                    a year tab was created (undo deletes it while unchanged)

import { quoteTab } from './sheets.js';
import { parseYearTab, placeEntry, rowsToDelete, staysInPlace, isYearTab, CARRY_ROW } from './budget.js';
import { serialToIso } from './dates.js';
import { columnLetter } from './ui.js';
import { createYearTab } from './yeartabs.js';

const KEY = 'bs.history';
const MAX_STEPS = 50;
// API calls that change the spreadsheet (see step: a step that failed before any of these stays listed).
const WRITES = new Set(['batchUpdateValues', 'batchClearValues', 'insertRows', 'deleteRows', 'deleteSheet', 'duplicateSheet', 'updateValues', 'updateValuesRaw', 'clearValues']);

// The step can't be done as recorded: the sheet changed in the meantime.
class Conflict extends Error {}

// Rows compare without trailing empty cells.
export function trimRow(row) {
  const out = (row || []).map((v) => v ?? '');
  while (out.length && out.at(-1) === '') out.pop();
  return out;
}
const same = (a, b) => JSON.stringify(trimRow(a)) === JSON.stringify(trimRow(b));

function readState() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the history just doesn't survive going to the other page.
  }
}

// ctx: api, spreadsheetId(), meta() (current tab list), reloadMeta(), changed() (labels changed).
export function createHistory(ctx) {
  const id = () => ctx.spreadsheetId();
  const sheetIdOf = (title) => ctx.meta().sheets.find((s) => s.properties.title === title)?.properties.sheetId;
  // ctx.api, noting whether a step has changed anything yet.
  let wrote = false;
  const api = new Proxy({}, {
    get: (_, name) => (...args) => {
      if (WRITES.has(name)) wrote = true;
      return ctx.api[name](...args);
    },
  });

  function state() {
    const saved = readState();
    return saved && saved.id === id() ? saved : { id: id(), done: [], undone: [] };
  }

  function record(label, op) {
    if (!id()) return; // Signed out meanwhile: there's no list to add to.
    const s = state();
    s.done.push({ label, op });
    if (s.done.length > MAX_STEPS) s.done.shift();
    s.undone = [];
    writeState(s);
    ctx.changed?.();
  }

  function labels() {
    const s = state();
    return { undo: s.done.at(-1)?.label ?? null, redo: s.undone.at(-1)?.label ?? null };
  }

  function clear() {
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    ctx.changed?.();
  }

  // ---- Reading and writing ----

  // Every row of a tab, formulas as formulas (for comparing and restoring rows exactly).
  async function readTab(title) {
    const result = await api.batchGetValues(id(), [quoteTab(title)], 'FORMULA');
    return result.valueRanges[0].values || [];
  }

  // Rows first..last (1-based), formulas as formulas.
  async function readRows(title, first, last) {
    const result = await api.batchGetValues(id(), [`${quoteTab(title)}!${first}:${last}`], 'FORMULA');
    const values = result.valueRanges[0].values || [];
    return Array.from({ length: last - first + 1 }, (_, i) => trimRow(values[i]));
  }

  // Writes a row's cells where they differ from `before`: formulas as formulas, everything else exactly.
  async function writeRow(title, row, cells, before = []) {
    const width = Math.max(cells.length, before.length);
    const raw = [];
    const formulas = [];
    const clears = [];
    for (let c = 0; c < width; c++) {
      const value = cells[c] ?? '';
      if (value === (before[c] ?? '')) continue;
      const range = `${quoteTab(title)}!${columnLetter(c)}${row}`;
      if (value === '') clears.push(range);
      else if (typeof value === 'string' && value.startsWith('=')) formulas.push({ range, values: [[value]] });
      else raw.push({ range, values: [[value]] });
    }
    if (raw.length) await api.batchUpdateValues(id(), raw, 'RAW');
    if (formulas.length) await api.batchUpdateValues(id(), formulas, 'USER_ENTERED');
    if (clears.length) await api.batchClearValues(id(), clears);
  }

  // Inserts one empty row at `row` (1-based), formatted like the entry above it, or like the row below
  // when there's no entry above (a month's blank row, the header).
  async function insertRow(title, values, row) {
    const above = trimRow(values[row - 2]);
    const fromAbove = row - 1 > CARRY_ROW && above.length > 0;
    await api.insertRows(id(), sheetIdOf(title), row - 1, 1, fromAbove);
  }

  // The row holding exactly `cells`: `hint` if it still does, otherwise the nearest such row. An empty
  // row only counts at `hint` itself: empty rows are everywhere (e.g. the blank row between months).
  function locate(values, cells, hint) {
    if (same(values[hint - 1], cells)) return hint;
    let best = null;
    if (trimRow(cells).length) {
      for (let r = CARRY_ROW; r <= Math.max(values.length, hint); r++) {
        if (same(values[r - 1], cells) && (best === null || Math.abs(r - hint) < Math.abs(best - hint))) best = r;
      }
    }
    if (best === null) throw new Conflict('That row was changed or removed in Google Sheets in the meantime, so this step can\'t be done.');
    return best;
  }
  // (Placing entries parses the rows as read with formulas: placement needs only the dates and which rows
  // are blank, which formulas don't change.)

  // Puts `cells` right below the row `above` (looked for near row - 1), back where it was even among
  // entries of the same day. Returns the row, or null if `above` isn't found.
  async function insertBelow(title, values, above, row, cells) {
    if (!above) return null;
    let at;
    try { at = locate(values, above, row - 1) + 1; } catch { return null; }
    await insertRow(title, values, at);
    await writeRow(title, at, cells);
    return at;
  }

  // Adds an entry where its date puts it (as Add record does); values: the tab as it is now. Returns the row.
  async function addByDate(title, values, cells) {
    const parsed = parseYearTab(title, values);
    const place = placeEntry(parsed, serialToIso(cells[0]));
    if (place.insert) {
      await api.insertRows(id(), sheetIdOf(title), place.row - 1, place.insert, parsed.rows.find((r) => r.rowNumber === place.row - 1)?.kind === 'entry');
    }
    await writeRow(title, place.row, cells);
    return place.row;
  }

  // Removes the row holding `cells`: just that row (plain), or with its month's blank row if the month
  // becomes empty. Returns { row, above, start, count } (above: null when more than the row went).
  async function removeRow(title, cells, hint, plain) {
    const values = await readTab(title);
    const at = locate(values, cells, hint);
    const removal = plain ? { start: at, count: 1 } : rowsToDelete(parseYearTab(title, values), at);
    await api.deleteRows(id(), sheetIdOf(title), removal.start - 1, removal.count);
    return { row: at, above: removal.count === 1 ? trimRow(values[at - 2]) : null, ...removal };
  }

  const tabExists = (title) => sheetIdOf(title) !== undefined; // (A sheetId can be 0.)
  function needTab(title) {
    if (!tabExists(title)) throw new Conflict(`The ${title} tab doesn't exist anymore.`);
  }

  // ---- The steps ----

  // A row's content goes from `from` (fromTitle) to `to` (toTitle); a date change moves it like on the
  // main page (to the row below `above` if given). Returns the row it ends up in.
  async function applyEdit({ fromTitle, toTitle, from, to, row, toRow, above, inPlace }) {
    needTab(fromTitle);
    needTab(toTitle);
    const values = await readTab(fromTitle);
    const at = locate(values, from, row);
    const dateChanged = to[0] !== from[0];
    if (inPlace || (fromTitle === toTitle && (!dateChanged || typeof to[0] !== 'number'))) {
      await writeRow(fromTitle, at, to, trimRow(values[at - 1]));
      return at;
    }
    if (fromTitle === toTitle) {
      const parsed = parseYearTab(fromTitle, values);
      const entry = parsed.entries.find((e) => e.rowNumber === at);
      if (entry && staysInPlace(parsed, entry, serialToIso(to[0]))) {
        await writeRow(fromTitle, at, to, trimRow(values[at - 1]));
        return at;
      }
    }
    // Add at the new place first, then remove the old row (as when changing a date on the main page).
    const target = fromTitle === toTitle ? values : await readTab(toTitle);
    let newRow = await insertBelow(toTitle, target, above, toRow ?? row, to);
    if (newRow === null) newRow = await addByDate(toTitle, target, to);
    const old = fromTitle === toTitle && newRow <= at ? at + 1 : at;
    const gone = await removeRow(fromTitle, from, old, false);
    return fromTitle === toTitle && gone.start < newRow ? newRow - gone.count : newRow;
  }

  // Adds a row: below the row it was below (`above`); otherwise at its old row (plain) or by its date.
  async function applyAdd({ title, cells, row, above, plain }) {
    needTab(title);
    const values = await readTab(title);
    const at = await insertBelow(title, values, above, row, cells);
    if (at !== null) return at;
    if (plain || typeof cells[0] !== 'number') {
      await insertRow(title, values, row);
      await writeRow(title, row, cells);
      return row;
    }
    return addByDate(title, values, cells);
  }

  // Undo of creating a tab: deletes it, but only while it's exactly as it was made and no other tab's
  // formulas refer to it (they would turn into #REF!).
  async function removeTab(op) {
    needTab(op.title);
    const now = await readTab(op.title);
    const rows = Math.max(now.length, op.snapshot.length);
    for (let r = 0; r < rows; r++) {
      if (!same(now[r], op.snapshot[r])) throw new Conflict(`The ${op.title} tab has been changed since it was created (e.g. records added), so it isn't deleted.`);
    }
    const others = ctx.meta().sheets.map((s) => s.properties.title).filter((t) => t !== op.title);
    const result = await api.batchGetValues(id(), others.map(quoteTab), 'FORMULA');
    const reference = quoteTab(op.title) + '!';
    others.forEach((title, i) => {
      const used = (result.valueRanges[i].values || []).some((row) => row.some((v) => typeof v === 'string' && v.startsWith('=') && v.includes(reference)));
      if (used) throw new Conflict(`Formulas in the ${title} tab refer to the ${op.title} tab, so it isn't deleted.`);
    });
    await api.deleteSheet(id(), sheetIdOf(op.title));
  }

  // Redo of creating a tab: makes it again from the newest year tab, as "New…" does.
  async function makeTab(op) {
    if (tabExists(op.title)) throw new Conflict(`There already is a ${op.title} tab.`);
    const years = ctx.meta().sheets.map((s) => s.properties).filter((p) => isYearTab(p.title)).sort((a, b) => b.title.localeCompare(a.title));
    const source = years[0];
    if (!source || Number(source.title) >= Number(op.title)) throw new Conflict(`The ${op.title} tab can't be made again: it would no longer be the newest year.`);
    const header = await api.batchGetValues(id(), [`${quoteTab(source.title)}!A1:Z1`], 'FORMATTED_VALUE');
    await createYearTab({ api, spreadsheetId: id(), yearText: op.title, source, sourceHeader: header.valueRanges[0].values?.[0] || [] });
    await ctx.reloadMeta();
    op.snapshot = await readTab(op.title);
  }

  // One step back (undo) or forward (redo). Returns the tabs it touched, or throws:
  //  - the sheet changed meanwhile (Conflict), or it failed halfway: the step is taken off the list;
  //  - it failed before changing anything (no connection, sign-in ran out): it stays, to try again.
  async function step(back) {
    const item = (back ? state().done : state().undone).at(-1);
    if (!item) return null;
    const { op } = item;
    wrote = false;
    try {
      await ctx.reloadMeta();
      if (op.kind === 'tab') {
        if (back) await removeTab(op);
        else await makeTab(op);
        await ctx.reloadMeta();
      } else if (op.kind === 'edit') {
        // Back: to its old place (below the row it was below); forward: as the change itself did.
        const landed = await applyEdit(back
          ? { fromTitle: op.toTitle, toTitle: op.fromTitle, from: op.to, to: op.from, row: op.toRow ?? op.row, toRow: op.row, above: op.fromAbove, inPlace: op.inPlace }
          : { fromTitle: op.fromTitle, toTitle: op.toTitle, from: op.from, to: op.to, row: op.row, inPlace: op.inPlace });
        if (back) op.row = landed;
        else op.toRow = landed;
      } else if ((op.kind === 'add') === back) {
        const gone = await removeRow(op.title, op.cells, op.row, op.plain); // Undo an add, redo a delete.
        op.row = gone.row;
        op.above = gone.above;
      } else {
        op.row = await applyAdd(op); // Undo a delete, redo an add.
      }
    } catch (err) {
      if (!(err instanceof Conflict) && !wrote) throw err; // Nothing changed: the step stays listed.
      move(back, null);
      const what = `Couldn't ${back ? 'undo' : 'redo'} "${item.label}"`;
      throw new Error(wrote
        ? `${what} completely (${err.message}). Part of it may have been done: please check the sheet.`
        : `${what}: ${err.message}`);
    }
    move(back, item);
    return { titles: [...new Set([op.title, op.fromTitle, op.toTitle].filter(Boolean))], tabs: op.kind === 'tab' };
  }

  // Takes the step off its list and puts `item` (with its updated row hints) on the other one, or drops it.
  function move(back, item) {
    const s = state();
    (back ? s.done : s.undone).pop();
    if (item) (back ? s.undone : s.done).push(item);
    writeState(s);
    ctx.changed?.();
  }

  return { record, labels, clear, step, readRows, readTab };
}
