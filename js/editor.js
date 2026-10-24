// Editing on the main page: change an entry's date, category, description or amounts; insert an empty
// entry between two rows; add a record through a dialog; create a missing year tab.
//
// Every write first checks that the row in Google Sheets is still what the page shows, so a change made
// meanwhile (by the other person, or directly in Sheets) is never overwritten. Rows go where the sheet's
// rules put them (budget.js: placeEntry / rowsToDelete): sorted by date, one blank row between months.

import { quoteTab } from './sheets.js';
import { parseYearTab, placeEntry, rowsToDelete, staysInPlace, moneyColumn, CARRY_ROW } from './budget.js';
import { cannotCreate, confirmCreate, createYearTab } from './yeartabs.js';
import { isoToSerial, isoToBg, bgToIso, serialToIso } from './dates.js';
import { el, columnLetter, placeFloating, openDialog, dialogButton, confirmDialog, touchInput } from './ui.js';
import { icon, categoryIcon } from './icons.js';
import { openDatePopup, closeDatePopup, todayIso } from './calendar.js';
import { PEOPLE, categoryStyle } from './config.js';
import { evaluateAmount, createKeypad, createResultLine, useKeypad, keypadOnly } from './keypad.js';

const INPUT_COLUMNS = 9; // A..I
const DATE_COLUMN = 0;
const CATEGORY_COLUMN = 1;
const DESCRIPTION_COLUMN = 2;
const MONEY_FIELDS = [['paid', 'Paid'], ['personal', 'Personal'], ['cashIn', 'Cash in']];

// ctx (from app.js): api, spreadsheetId(), meta(), reloadMeta(), yearTitles() (newest first),
// cached(title) -> { parsed, values }, refresh(titles), me(), categories(), busy(on), showError(err), notice(text)
export function createEditor(ctx) {
  const id = () => ctx.spreadsheetId();
  const sheetIdOf = (title) => ctx.meta().sheets.find((s) => s.properties.title === title)?.properties.sheetId;
  const cellRange = (title, row, column) => `${quoteTab(title)}!${columnLetter(column)}${row}`;

  // ---- Reading and writing rows ----

  async function freshValues(title) {
    const result = await ctx.api.batchGetValues(id(), [quoteTab(title)], 'UNFORMATTED_VALUE');
    return result.valueRanges[0].values || [];
  }

  function rowCells(values, rowNumber) {
    return Array.from({ length: INPUT_COLUMNS }, (_, c) => values[rowNumber - 1]?.[c] ?? '');
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Throws (and refreshes the page) if the row changed in Sheets since the page showed it.
  async function checkUnchanged(title, rowNumber) {
    const fresh = await freshValues(title);
    if (!same(rowCells(ctx.cached(title).values, rowNumber), rowCells(fresh, rowNumber))) {
      await ctx.refresh([title]);
      throw new Error('This entry was changed in Google Sheets in the meantime. Nothing was saved; the page now shows the new values.');
    }
    return fresh;
  }

  // cells: [[column, value]]; null or '' empties the cell. Values are written exactly (RAW).
  async function writeCells(title, rowNumber, cells) {
    const writes = [];
    const clears = [];
    for (const [column, value] of cells) {
      const range = cellRange(title, rowNumber, column);
      if (value === null || value === '') clears.push(range);
      else writes.push({ range, values: [[value]] });
    }
    if (writes.length) await ctx.api.batchUpdateValues(id(), writes, 'RAW');
    if (clears.length) await ctx.api.batchClearValues(id(), clears);
  }

  // Inserts empty rows at a 1-based row, taking the formatting of the entry row next to it.
  async function insertRowsAt(title, parsed, row, count) {
    const above = parsed.rows.find((r) => r.rowNumber === row - 1);
    await ctx.api.insertRows(id(), sheetIdOf(title), row - 1, count, above?.kind === 'entry');
  }

  // Adds an entry (A..I values, date in A) where it belongs; returns the placement.
  async function addRow(title, iso, values) {
    const parsed = parseYearTab(title, await freshValues(title));
    const place = placeEntry(parsed, iso);
    if (place.insert) await insertRowsAt(title, parsed, place.row, place.insert);
    await writeCells(title, place.row, values.map((v, c) => [c, v]).filter(([, v]) => v !== '' && v !== null));
    return place;
  }

  // Runs a change with syncing paused and the page dimmed, then shows the result; errors are shown on the page.
  async function change(titles, action) {
    ctx.busy(true);
    try {
      await ctx.withLoading(async () => {
        await action();
        await ctx.refresh(titles);
      });
    } catch (err) {
      ctx.showError(err);
      console.error(err);
    } finally {
      ctx.busy(false);
    }
  }

  // ---- Year tabs ----

  // Makes sure a tab exists for the year; asks before creating one. Resolves false if cancelled.
  // The tab list is read again first: tabs may have been added or deleted in Google Sheets.
  async function ensureYearTab(yearText) {
    await ctx.reloadMeta();
    const years = ctx.yearTitles();
    if (years.includes(yearText)) return true;
    const problem = cannotCreate(yearText, years);
    if (problem) throw new Error(`There is no ${yearText} tab. ${problem}`);
    if (!(await confirmCreate(yearText, years[0]))) return false;
    const source = ctx.meta().sheets.find((s) => s.properties.title === years[0]).properties;
    await createYearTab({
      api: ctx.api,
      spreadsheetId: id(),
      yearText,
      source,
      sourceHeader: (await freshValues(years[0]))[0],
    });
    await ctx.reloadMeta();
    ctx.notice(`Created the ${yearText} tab in Google Sheets.`);
    return true;
  }

  // ---- Editing an entry ----

  async function setDate(year, entry, iso) {
    const title = year.title;
    const target = iso.slice(0, 4);
    await change([title, target], async () => {
      const fresh = await checkUnchanged(title, entry.rowNumber);
      const before = rowCells(fresh, entry.rowNumber);
      const moved = [...before];
      moved[DATE_COLUMN] = isoToSerial(iso);
      const op = { kind: 'edit', fromTitle: title, toTitle: target, from: before, to: moved, row: entry.rowNumber };
      if (target === title && staysInPlace(year, entry, iso)) {
        await writeCells(title, entry.rowNumber, [[DATE_COLUMN, isoToSerial(iso)]]);
        record('Change date', { ...op, toRow: entry.rowNumber });
        return;
      }
      if (!(await ensureYearTab(target))) return;
      const extra = (fresh[entry.rowNumber - 1] || []).slice(INPUT_COLUMNS).some((v) => v !== '' && v !== null);
      if (extra && !(await confirmDialog({
        title: 'Move this entry?',
        message: `Row ${entry.rowNumber} also has something to the right of the entry (after column I). The new date moves the entry to another row; that extra content is removed with the old row.`,
        confirm: 'Move it',
      }))) return;

      // Add at the new place first, then remove the old row: if anything fails, nothing is lost.
      const values = rowCells(fresh, entry.rowNumber);
      values[DATE_COLUMN] = isoToSerial(iso);
      const placed = await addRow(target, iso, values);
      let oldRow = entry.rowNumber;
      if (target === title && placed.insert && placed.row <= oldRow) oldRow += placed.insert;
      const after = await freshValues(title);
      if (!same(rowCells(after, oldRow), rowCells(fresh, entry.rowNumber))) {
        throw new Error(`The entry was added on ${isoToBg(iso)}, but its old row changed meanwhile, so it wasn't removed. Please check row ${oldRow} of ${title}.`);
      }
      const removal = rowsToDelete(parseYearTab(title, after), oldRow);
      await ctx.api.deleteRows(id(), sheetIdOf(title), removal.start - 1, removal.count);
      // Undo puts it back below the row it was below (unless its month's blank row went too).
      const fromAbove = removal.count === 1 ? rowCells(fresh, entry.rowNumber - 1) : null;
      record('Change date', { ...op, toRow: placed.row, fromAbove });
    });
  }

  // Deletes an entry's row (and its month's blank row if the month becomes empty), after asking.
  async function deleteEntry(year, entry) {
    const amounts = PEOPLE.flatMap((p) => MONEY_FIELDS
      .filter(([f]) => entry.money[p.key][f])
      .map(([f, label]) => `${p.name} ${label.toLowerCase()} ${entry.money[p.key][f]}`));
    const what = [entry.date ? isoToBg(entry.date) : null, entry.category, entry.description, amounts.join(', ')].filter(Boolean).join(' · ');
    if (!(await confirmDialog({ title: 'Delete this entry?', message: [what || '(empty entry)', 'Its row is removed from Google Sheets.'], confirm: 'Delete' }))) return;
    await change([year.title], async () => {
      const fresh = await checkUnchanged(year.title, entry.rowNumber);
      const extra = (fresh[entry.rowNumber - 1] || []).slice(INPUT_COLUMNS).some((v) => v !== '' && v !== null);
      if (extra && !(await confirmDialog({
        title: 'Delete the whole row?',
        message: `Row ${entry.rowNumber} also has something to the right of the entry (after column I); it is deleted with the row.`,
        confirm: 'Delete',
      }))) return;
      const removal = rowsToDelete(parseYearTab(year.title, fresh), entry.rowNumber);
      await ctx.api.deleteRows(id(), sheetIdOf(year.title), removal.start - 1, removal.count);
      record('Delete record', {
        kind: 'delete',
        title: year.title,
        cells: rowCells(fresh, entry.rowNumber),
        row: entry.rowNumber,
        above: removal.count === 1 ? rowCells(fresh, entry.rowNumber - 1) : null,
      });
    });
  }

  // Entry menu (right-click, or press and hold on a phone). gaps: { above, below } -> { row, date } for
  // inserting an empty record on that side of the entry as it is shown.
  function openEntryMenu(anchor, year, entry, gaps) {
    if (entry.kind === 'carry') return;
    const menu = el('div', 'menu');
    menu.setAttribute('role', 'menu');
    menu.append(el('div', 'menu-title', [entry.date ? isoToBg(entry.date) : '', entry.description || entry.category].filter(Boolean).join(' · ')));
    const item = (label, iconName, className, action) => {
      const button = el('button', `menu-item ${className}`.trim());
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.append(icon(iconName), el('span', null, label));
      button.addEventListener('click', () => {
        closePopup();
        action();
      });
      menu.append(button);
      return button;
    };
    const first = item('Insert empty record above', 'rowAbove', '', () => insertEmpty(year, gaps.above.row, gaps.above.date));
    item('Insert empty record below', 'rowBelow', '', () => insertEmpty(year, gaps.below.row, gaps.below.date));
    menu.append(el('div', 'menu-sep'));
    item('Delete entry', 'trash', 'danger', () => deleteEntry(year, entry));
    showPopup(menu, anchor);
    first.focus();
  }

  async function setCells(year, entry, cells) {
    await change([year.title], async () => {
      const fresh = await checkUnchanged(year.title, entry.rowNumber);
      await writeCells(year.title, entry.rowNumber, cells);
      const before = rowCells(fresh, entry.rowNumber);
      const after = [...before];
      for (const [column, value] of cells) after[column] = value ?? '';
      record(editLabel(cells.map(([c]) => c)), { kind: 'edit', fromTitle: year.title, toTitle: year.title, from: before, to: after, row: entry.rowNumber });
    });
  }

  // Inserts an empty entry (dated like its neighbour) before the 1-based row `row`.
  async function insertEmpty(year, row, iso) {
    await change([year.title], async () => {
      const fresh = await freshValues(year.title);
      const shown = ctx.cached(year.title).values;
      // The rows on both sides must still be where the page shows them.
      if (!same(rowCells(shown, row - 1), rowCells(fresh, row - 1)) || !same(rowCells(shown, row), rowCells(fresh, row))) {
        await ctx.refresh([year.title]);
        throw new Error('The sheet changed in the meantime. Nothing was inserted; the page now shows the new rows.');
      }
      const parsed = parseYearTab(year.title, fresh);
      await insertRowsAt(year.title, parsed, row, 1);
      await writeCells(year.title, row, [[DATE_COLUMN, isoToSerial(iso)]]);
      const cells = Array(INPUT_COLUMNS).fill('');
      cells[DATE_COLUMN] = isoToSerial(iso);
      record('Insert empty record', { kind: 'add', title: year.title, cells, row, above: rowCells(fresh, row - 1) });
    });
  }

  // ---- Undo and redo (changes made in this app, during this visit) ----
  // Each change is kept as what a row held before and after it. Undoing finds that row again by its
  // content (other rows may have been added or removed meanwhile) and puts the old content back; if the
  // row was changed in Google Sheets since, nothing is done and that step is dropped.

  const MAX_HISTORY = 50;
  const done = []; // { label, op }
  const undone = [];
  const historyChanged = () => ctx.historyChanged?.();

  function record(label, op) {
    done.push({ label, op });
    if (done.length > MAX_HISTORY) done.shift();
    undone.length = 0;
    historyChanged();
  }

  function editLabel(columns) {
    if (columns.includes(DATE_COLUMN)) return 'Change date';
    if (columns.includes(CATEGORY_COLUMN)) return 'Change category';
    if (columns.includes(DESCRIPTION_COLUMN)) return 'Change description';
    return 'Change amounts';
  }

  // The row holding exactly `cells` (A..I): `hint` if it still does, otherwise the nearest such row.
  function locate(values, cells, hint) {
    if (same(rowCells(values, hint), cells)) return hint;
    let best = null;
    for (let r = CARRY_ROW; r <= values.length; r++) { // (Row 4 too: an entry can be right below it.)
      if (same(rowCells(values, r), cells) && (best === null || Math.abs(r - hint) < Math.abs(best - hint))) best = r;
    }
    if (best === null) throw new Error('That record was changed or removed in Google Sheets in the meantime, so this step can\'t be done.');
    return best;
  }

  // Puts `cells` back right below the row it used to be below (`above`, looked for near row - 1), so it
  // returns to its old place even among entries of the same day. Returns the row, or null if not found.
  async function insertBelow(title, fresh, above, row, cells) {
    if (!above) return null;
    let at;
    try { at = locate(fresh, above, row - 1) + 1; } catch { return null; }
    await insertRowsAt(title, parseYearTab(title, fresh), at, 1);
    await writeCells(title, at, cells.map((v, c) => [c, v]).filter(([, v]) => v !== ''));
    return at;
  }

  // An entry's content goes from `from` (in fromTitle) to `to` (in toTitle), moving rows if the date needs
  // it; `above` (optional): the row it should end up below. Returns the row it ends up in (a hint for the
  // way back).
  async function applyEdit({ fromTitle, toTitle, from, to, row, above, toRow }) {
    const fresh = await freshValues(fromTitle);
    const at = locate(fresh, from, row);
    const iso = typeof to[DATE_COLUMN] === 'number' ? serialToIso(to[DATE_COLUMN]) : null;
    if (fromTitle === toTitle) {
      const parsed = parseYearTab(fromTitle, fresh);
      const entry = parsed.entries.find((e) => e.rowNumber === at);
      if (!iso || !entry || to[DATE_COLUMN] === from[DATE_COLUMN] || staysInPlace(parsed, entry, iso)) {
        await writeCells(fromTitle, at, to.map((v, c) => [c, v]).filter(([c]) => to[c] !== from[c]));
        return at;
      }
    }
    if (!(await ensureYearTab(toTitle))) throw new Error('Cancelled.');
    // Add at the new place first, then remove the old row (as when changing a date).
    const target = toTitle === fromTitle ? fresh : await freshValues(toTitle);
    let newRow = await insertBelow(toTitle, target, above, toRow ?? row, to);
    if (newRow === null) newRow = (await addRow(toTitle, iso, to)).row;
    const after = await freshValues(fromTitle);
    const oldRow = toTitle === fromTitle && newRow <= at ? at + 1 : at;
    const removal = rowsToDelete(parseYearTab(fromTitle, after), locate(after, from, oldRow));
    await ctx.api.deleteRows(id(), sheetIdOf(fromTitle), removal.start - 1, removal.count);
    return toTitle === fromTitle && removal.start < newRow ? newRow - removal.count : newRow;
  }

  // Adds an entry: right below the row it was below before (`above`), otherwise where its date puts it.
  async function applyAdd({ title, cells, row, above }) {
    if (!(await ensureYearTab(title))) throw new Error('Cancelled.');
    const fresh = await freshValues(title);
    const at = await insertBelow(title, fresh, above, row, cells);
    return at ?? (await addRow(title, serialToIso(cells[DATE_COLUMN]), cells)).row;
  }

  // Removes an entry's row (and its month's blank row if the month empties). Returns where it was.
  async function applyRemove({ title, cells, row }) {
    const fresh = await freshValues(title);
    const at = locate(fresh, cells, row);
    const removal = rowsToDelete(parseYearTab(title, fresh), at);
    await ctx.api.deleteRows(id(), sheetIdOf(title), removal.start - 1, removal.count);
    // Only a single row can go back exactly where it was; with the month's blank row it's placed by date.
    return { row: at, above: removal.count === 1 ? rowCells(fresh, at - 1) : null };
  }

  // Runs one step backwards (undo) or forwards (redo); the ops are kept up to date with row hints.
  async function step(back) {
    const from = back ? done : undone;
    const to = back ? undone : done;
    const item = from.pop();
    if (!item) return;
    historyChanged();
    const { op } = item;
    const titles = [op.title, op.fromTitle, op.toTitle].filter(Boolean);
    let ok = false;
    await change([...new Set(titles)], async () => {
      try {
        if (op.kind === 'edit') {
          // Back: to its old place (below the row it was below); forward: where the date puts it.
          const swapped = back
            ? { fromTitle: op.toTitle, toTitle: op.fromTitle, from: op.to, to: op.from, row: op.toRow ?? op.row, toRow: op.row, above: op.fromAbove }
            : { fromTitle: op.fromTitle, toTitle: op.toTitle, from: op.from, to: op.to, row: op.row };
          const landed = await applyEdit(swapped);
          if (back) op.row = landed;
          else op.toRow = landed;
        } else if ((op.kind === 'add') === back) {
          const gone = await applyRemove(op); // Undo an add, or redo a delete.
          op.row = gone.row;
          op.above = gone.above;
        } else {
          op.row = await applyAdd(op); // Undo a delete, or redo an add.
        }
        ok = true;
      } catch (err) {
        throw new Error(`Couldn't ${back ? 'undo' : 'redo'} "${item.label}": ${err.message}`);
      }
    });
    if (ok) to.push(item);
    historyChanged();
  }

  const undo = () => step(true);
  const redo = () => step(false);
  const history = () => ({ undo: done.at(-1)?.label ?? null, redo: undone.at(-1)?.label ?? null });
  function clearHistory() {
    done.length = 0;
    undone.length = 0;
    historyChanged();
  }

  // ---- Popups for editing ----

  let popup = null;
  function closePopup() {
    popup?.node.remove();
    popup?.anchor.classList.remove('is-open');
    popup = null;
  }
  function showPopup(node, anchor) {
    closePopup();
    closeDatePopup();
    node.addEventListener('pointerdown', (event) => event.stopPropagation());
    node.addEventListener('click', (event) => event.stopPropagation());
    placeFloating(node, anchor);
    anchor.classList.add('is-open');
    popup = { node, anchor };
  }
  document.addEventListener('pointerdown', () => closePopup());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && popup) {
      event.stopPropagation();
      closePopup();
    }
  });

  // Category list with each category's badge and name; onPick(name).
  function openCategoryPicker(anchor, current, onPick) {
    const list = el('div', 'choice-list');
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    const options = ctx.categories();
    const wanted = String(current || '').trim().toLowerCase();
    for (const option of options) {
      const item = el('div', 'choice');
      item.setAttribute('role', 'option');
      item.append(categoryBadge(option, 'small'), el('span', null, option));
      if (option.trim().toLowerCase() === wanted) item.classList.add('selected');
      item.addEventListener('click', () => {
        closePopup();
        onPick(option);
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
    // As wide as the names need; in the Add record dialog at least as wide as its field.
    if (anchor.classList.contains('category-button')) list.style.minWidth = `${anchor.offsetWidth}px`;
    showPopup(list, anchor);
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    list.focus();
  }

  // Amounts of one person at a time (tabs to switch person); saves all changed fields.
  function openAmounts(anchor, entry, startPerson, onSave) {
    const panel = el('div', 'amount-popup');
    let person = startPerson;
    const values = Object.fromEntries(PEOPLE.map((p) => [p.key, Object.fromEntries(MONEY_FIELDS.map(([f]) => [f, entry.money[p.key][f] ? String(entry.money[p.key][f]) : '']))]));
    const tabs = personTabs(person, (key) => { saveFields(); person = key; drawFields(); });
    const fields = el('div', 'amount-fields');
    const error = el('div', 'form-error');
    let inputs = {};
    const saveFields = () => {
      for (const [f] of MONEY_FIELDS) values[person][f] = inputs[f].value;
    };
    const drawFields = () => {
      fields.replaceChildren();
      inputs = {};
      for (const [f, label] of MONEY_FIELDS) {
        const input = amountInput(values[person][f]);
        inputs[f] = input;
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
        const wrap = el('label', `field person-${person}`);
        wrap.append(el('span', null, label), input);
        fields.append(wrap);
      }
      inputs.paid.focus();
    };
    const save = () => {
      saveFields();
      const cells = [];
      for (const p of PEOPLE) {
        for (const [f] of MONEY_FIELDS) {
          const amount = parseAmount(values[p.key][f]);
          if (Number.isNaN(amount)) {
            error.textContent = `${p.name}: "${values[p.key][f]}" is not an amount.`;
            return;
          }
          const before = entry.money[p.key][f] || null;
          if ((amount || null) !== before) cells.push([moneyColumn(PEOPLE.indexOf(p), f), amount]);
        }
      }
      closePopup();
      if (cells.length) onSave(cells);
    };
    const buttons = el('div', 'popup-buttons');
    buttons.append(dialogButton('Cancel', null, closePopup), dialogButton('Save', 'primary', save));
    buttons.prepend(createResultLine(panel));
    panel.append(tabs.node, fields, ...(useKeypad() ? [createKeypad(panel)] : []), error, buttons);
    drawFields(); // Before placing, so the popup's full height is known.
    showPopup(panel, anchor);
    inputs.paid.focus();
  }

  function editDescription(descLine, year, entry) {
    const original = entry.description;
    const input = el('input', 'inline-input');
    input.value = original;
    input.setAttribute('aria-label', 'Description');
    const span = descLine.querySelector('.desc');
    descLine.classList.add('editing');
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = input.value;
      input.replaceWith(span);
      descLine.classList.remove('editing');
      if (save && text.trim() !== original) setCells(year, entry, [[DESCRIPTION_COLUMN, text.trim() || null]]);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Click on a part of an entry row: which part decides what is edited.
  function editEntry(target, year, entry) {
    if (entry.kind === 'carry') {
      ctx.notice('The carry-over row is calculated by the sheet from last year\'s balance; it can\'t be edited.');
      return;
    }
    const dateCell = target.closest('.date');
    if (dateCell) {
      openDatePopup({
        anchor: dateCell,
        value: entry.date,
        typed: true,
        onPick: (iso) => { if (iso !== entry.date) setDate(year, entry, iso); },
      });
      return;
    }
    const categoryPart = target.closest('.cat-badge, .cat');
    if (categoryPart) {
      openCategoryPicker(categoryPart, entry.category, (name) => {
        if (name !== entry.category) setCells(year, entry, [[CATEGORY_COLUMN, name]]);
      });
      return;
    }
    const desc = target.closest('.desc');
    if (desc) {
      editDescription(desc.closest('.desc-line'), year, entry);
      return;
    }
    const who = target.closest('.who');
    const amounts = target.closest('.amounts');
    if (who || amounts) {
      const person = who?.dataset.person || amounts.querySelector('.who:not(:empty)')?.dataset.person || ctx.me()?.key || PEOPLE[0].key;
      openAmounts(who || amounts, entry, person, (cells) => setCells(year, entry, cells));
    }
  }

  // ---- Add record dialog ----

  // date: ISO date to start with (default today), e.g. from a month card's "+".
  function openAddDialog({ date = todayIso() } = {}) {
    const me = ctx.me() || PEOPLE[0];
    let person = me.key;
    let category = '';
    const { body, foot, close } = openDialog({ title: 'Add record', className: 'add-dialog', onClose: () => { closePopup(); closeDatePopup(); } });

    // Date: text (dd.mm.yyyy and short forms) + calendar.
    const dateInput = el('input');
    dateInput.value = isoToBg(date);
    dateInput.placeholder = 'dd.mm.yyyy';
    dateInput.inputMode = 'numeric';
    const calendarButton = el('button', 'icon-button field-icon');
    calendarButton.type = 'button';
    calendarButton.title = 'Pick a date';
    calendarButton.append(icon('calendar'));
    // By finger, the field opens the calendar (with its own field for typing) instead of the keyboard.
    const openCalendar = () => openDatePopup({
      anchor: dateInput,
      value: bgToIso(dateInput.value),
      typed: touchInput(),
      onPick: (iso) => {
        dateInput.value = isoToBg(iso);
        if (!touchInput()) dateInput.focus();
      },
    });
    calendarButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openCalendar();
    });
    dateInput.addEventListener('pointerdown', () => { dateInput.readOnly = touchInput(); });
    dateInput.addEventListener('click', (event) => {
      if (!dateInput.readOnly) return;
      event.stopPropagation();
      dateInput.blur();
      openCalendar();
    });
    const dateRow = el('div', 'input-with-icon');
    dateRow.append(dateInput, calendarButton);

    // Category: button that opens the list with icons.
    const categoryButton = el('button', 'category-button');
    categoryButton.type = 'button';
    const drawCategory = () => {
      categoryButton.replaceChildren(
        ...(category ? [categoryBadge(category, 'small'), el('span', null, category)] : [el('span', 'muted', 'Choose a category')]),
        el('span', 'caret', '▾'),
      );
    };
    drawCategory();
    categoryButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openCategoryPicker(categoryButton, category, (name) => { category = name; drawCategory(); description.focus(); });
    });

    const description = el('input');
    description.placeholder = 'e.g. Lidl, rent, dog food…';

    // Who paid, and the three amounts.
    const amountInputs = {};
    const amountFields = el('div', 'amount-fields');
    for (const [f, label] of MONEY_FIELDS) {
      amountInputs[f] = amountInput('');
      const wrap = el('label', 'field');
      wrap.append(el('span', null, label), amountInputs[f]);
      amountFields.append(wrap);
    }
    const colourAmounts = () => amountFields.querySelectorAll('.field').forEach((f) => { f.className = `field person-${person}`; });
    const tabs = personTabs(person, (key) => { person = key; colourAmounts(); });
    colourAmounts();

    const error = el('div', 'form-error');
    error.setAttribute('role', 'alert');
    // Keypad (phones): shown while an amount field has the focus.
    const pad = useKeypad() ? createKeypad(body) : null;
    if (pad) {
      pad.hidden = true;
      body.addEventListener('focusin', (event) => {
        const wasHidden = pad.hidden;
        pad.hidden = !event.target.classList.contains('amount-input');
        // Phones: the dialog scrolls so the whole keypad is in view (it sits near the bottom).
        if (wasHidden && !pad.hidden) setTimeout(() => pad.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
      });
    }
    body.append(
      formField('Date', dateRow),
      formField('Category', categoryButton),
      formField('Description', description),
      formField('Who', tabs.node),
      amountFields,
      ...(pad ? [pad] : []),
      el('p', 'muted form-hint', 'Paid: shared 50/50 · Personal: the part of "Paid" that was only for this person · Cash in: money given to the other person. Amounts can be calculations, e.g. 12.40+3.60.'),
      error,
    );

    const add = dialogButton('Add record', 'primary', async () => {
      const iso = bgToIso(dateInput.value);
      if (!iso) return fail('Enter the date as day, month, year, e.g. 18.10.2026 or 18.10.26.');
      if (!category) return fail('Choose a category.');
      const money = {};
      for (const [f] of MONEY_FIELDS) {
        money[f] = parseAmount(amountInputs[f].value);
        if (Number.isNaN(money[f])) return fail(`"${amountInputs[f].value}" is not an amount.`);
      }
      if (!money.paid && !money.cashIn) return fail('Enter an amount in "Paid" or "Cash in".');
      if (money.personal && money.personal > (money.paid || 0)) return fail('"Personal" is part of "Paid", so it can\'t be larger.');

      const values = Array(INPUT_COLUMNS).fill('');
      values[DATE_COLUMN] = isoToSerial(iso);
      values[CATEGORY_COLUMN] = category;
      values[DESCRIPTION_COLUMN] = description.value.trim();
      const p = PEOPLE.findIndex((x) => x.key === person);
      for (const [f] of MONEY_FIELDS) if (money[f]) values[moneyColumn(p, f)] = money[f];

      add.disabled = true;
      add.textContent = 'Adding…';
      ctx.busy(true);
      try {
        const title = iso.slice(0, 4);
        if (!(await ensureYearTab(title))) return;
        const placed = await addRow(title, iso, values);
        record('Add record', { kind: 'add', title, cells: values, row: placed.row, above: null });
        await ctx.refresh([title]);
        close('added');
        ctx.notice(`Added: ${isoToBg(iso)} · ${category}${values[DESCRIPTION_COLUMN] ? ` · ${values[DESCRIPTION_COLUMN]}` : ''}`);
      } catch (err) {
        console.error(err);
        fail(err.message || String(err));
      } finally {
        ctx.busy(false);
        add.disabled = false;
        add.textContent = 'Add record';
      }
    });
    foot.append(createResultLine(body), dialogButton('Cancel', null, () => close('cancel')), add);
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
        event.preventDefault();
        add.click();
      }
    });
    function fail(message) {
      error.textContent = message;
      return null;
    }
    // By finger nothing gets the focus, so no on-screen keyboard covers the dialog.
    if (touchInput()) document.activeElement?.blur();
    else dateInput.focus();
  }

  return { editEntry, insertEmpty, deleteEntry, openAddDialog, openEntryMenu, closePopup, undo, redo, history, clearHistory };
}

// ---- Small builders ----

function formField(label, control) {
  const wrap = el('div', 'form-field');
  wrap.append(el('span', 'form-label', label), control);
  return wrap;
}

function amountInput(value) {
  const input = el('input', 'amount-input');
  input.value = value;
  // Used by finger: the app's keypad instead of the system keyboard; elsewhere numbers and + − × ÷ by keyboard.
  // Decided again on every tap (before the field gets the focus), in case the input method changed.
  input.inputMode = keypadOnly() ? 'none' : 'decimal';
  input.addEventListener('pointerdown', () => {
    const hasKeypad = Boolean(input.closest('.modal-body, .amount-popup')?.querySelector('.keypad'));
    input.inputMode = keypadOnly() && hasKeypad ? 'none' : 'decimal';
  });
  input.placeholder = '0.00';
  input.autocomplete = 'off';
  input.title = 'An amount, or a calculation such as 12.40+3.60';
  return input;
}

// '' -> null; a number or a calculation -> its value; anything else -> NaN (keypad.js).
const parseAmount = evaluateAmount;

// Person switch (Aleks | Iliyana) in each person's colour.
function personTabs(selected, onChange) {
  const node = el('div', 'seg person-seg');
  node.setAttribute('role', 'tablist');
  for (const person of PEOPLE) {
    const tab = el('button', `seg-item person-${person.key}`, person.name);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.person = person.key;
    const select = () => {
      for (const t of node.children) {
        const on = t.dataset.person === person.key;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      }
      onChange(person.key);
    };
    tab.addEventListener('click', select);
    if (person.key === selected) tab.classList.add('active');
    tab.setAttribute('aria-selected', String(person.key === selected));
    node.append(tab);
  }
  return { node };
}

function categoryBadge(name, size = '') {
  const style = categoryStyle(name);
  const badge = el('span', `cat-badge ${size}`.trim());
  if (style) {
    badge.style.setProperty('--cat', style.badge);
    badge.style.setProperty('--cat-ink', style.ink);
  }
  badge.append(categoryIcon(style));
  return badge;
}
