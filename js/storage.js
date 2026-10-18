// Browser storage that never throws (private windows and blocked storage just behave as empty).

export const SHEET_KEY = 'bs.spreadsheetId'; // Spreadsheet chosen in this browser.
export const TAB_KEY = 'bs.tab'; // Last opened tab.

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
