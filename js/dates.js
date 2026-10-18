// Dates: the sheet stores day serials (days since 1899-12-30); the app shows and accepts dd.mm.yyyy.

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86_400_000;

export function serialToIso(serial) {
  return new Date(EPOCH + Math.floor(serial) * DAY).toISOString().slice(0, 10);
}

export function isoToSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);
}

// '2026-10-17' -> '17.10.2026'
export function isoToBg(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function serialToBg(serial) {
  return isoToBg(serialToIso(serial));
}

// Day, month, year in that order: day and month with 1 or 2 digits, year with 2 or 4 (yy = 20yy),
// separated by . , - or /  ('17.10.2026', '7.1.26', '07/10/26', '7-10-2026', …) -> '2026-10-17'.
// null if it isn't a real date in that form.
export function bgToIso(text) {
  const match = String(text).trim().match(/^(\d{1,2})[.,\-/](\d{1,2})[.,\-/](\d{2}|\d{4})\.?$/);
  if (!match) return null;
  const [d, m] = match.slice(1, 3).map(Number);
  const y = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
