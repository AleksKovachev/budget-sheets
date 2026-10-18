// Browser storage that never throws (private windows and blocked storage just behave as empty).

export const SHEET_KEY = 'bs.spreadsheetId'; // Spreadsheet chosen in this browser.
export const TAB_KEY = 'bs.tab'; // Last opened tab.

// The main page's layout choices: kept until signing out (or the reset button in the top bar).
export const PERIOD_KEY = 'bs.period'; // Shown period.
export const ORDER_KEY = 'bs.order'; // Order of the month cards.
export const ENTRY_ORDER_KEY = 'bs.entryOrder'; // Order of the entries inside each card.
const VIEW_KEYS = [PERIOD_KEY, ORDER_KEY, ENTRY_ORDER_KEY];

export function clearViewState() {
  for (const key of VIEW_KEYS) storage.local.remove(key);
}

function wrap(getStore) {
  return {
    get(key) {
      try { return getStore().getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { getStore().setItem(key, value); } catch { /* ignore */ }
    },
    remove(key) {
      try { getStore().removeItem(key); } catch { /* ignore */ }
    },
  };
}

export const storage = {
  local: wrap(() => window.localStorage),
  session: wrap(() => window.sessionStorage),
};
