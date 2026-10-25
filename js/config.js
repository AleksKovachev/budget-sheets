// OAuth client ID from Google Cloud (SETUP.md, step 3). Not a secret: it is visible in the page anyway.
export const CLIENT_ID = '685009826048-l3cq1q0iukvd9ihm1lkpnc7ua3gav8an.apps.googleusercontent.com';

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

// Spreadsheet opened when none has been chosen in this browser yet (new device, incognito): its URL,
// encrypted once per person with a key made from their email address (js/secret.js), so the public page
// doesn't show it. Made with dev/default-sheet.html: { aleks: '…', iliyana: '…' }.
// Empty: the app asks for a spreadsheet URL. Only accounts the spreadsheet is shared with can open it anyway.
export const DEFAULT_SPREADSHEET = {
  aleks: 'FFVCyTlDi2MPHk1sNNMjgVJVNQRv1ifhyOVxVOZo8sOVMIrlbZACNF+pQW7accsRDCznJBoxIcgJejoAVn0zzia91kvwL/laqP00ef73c7OZ4cJ7/tVe5vNG1HdrV49NExh4tobL7IRCmJEIAGULgmOVrcc=',
  iliyana: 'X5QPi031mzPprFEfWGi04RhLgyv4B0zw3jpzYG1q3DBF54IuRGKBJP5Z8tIzf16YEg8xXHbHpFcS2NgVxMsrNQc3deddtN+/tb+ThB1en/DXUoOlQx0I8eHjhNScomjSTG0xY4YPe2yQLo8MBR87r3qqiVA=',
};

// The two people, in the column order of the year tabs (SHEET_LAYOUT.md).
// Emails are stored as SHA-256 hashes of the lower-case address, so the public page doesn't reveal them.
export const PEOPLE = [
  {
    key: 'aleks',
    name: 'Aleks',
    emailSha256: 'b27c9243e46ad6a2056ea8dc806858e907867a97d6213908ba4050cd41f734cd',
  },
  {
    key: 'iliyana',
    name: 'Iliyana',
    emailSha256: 'da79eb71e53a45f0bf94fbb6f2433fe36aa9c0b156143dd1e78e942a966caa11',
  },
];

// Category colours (same as the conditional formatting in the sheet) and icons (js/icons.js).
// Keys are compared ignoring case, emoji and extra spaces. A category missing here gets a grey tag icon.
// `image` (optional): a picture with its own colours used instead of the icon (an exception to the
// one-colour rule); `icon` stays as the fallback.
export const CATEGORIES = {
  'wedding': { color: '#8e7cc3', icon: 'rings' },
  'groceries': { color: '#b7e1cd', icon: 'bag' },
  'restaurants/fast food': { color: '#fff2cc', icon: 'utensils' },
  'car': { color: '#f4cccc', icon: 'car' },
  'travel': { color: '#fce5cd', icon: 'suitcase' },
  'rent': { color: '#e6b8af', icon: 'key' },
  'bills': { color: '#ead1dc', icon: 'receipt' },
  'fashion': { color: '#d9d2e9', icon: 'shirt' },
  'health and beauty': { color: '#d0e0e3', icon: 'heart' },
  'home': { color: '#efefef', icon: 'house' },
  'electronics': { color: '#d1fdbd', icon: 'laptop' },
  'pharmacy': { color: '#c9daf8', icon: 'pill' },
  // Our Cavalier King Charles Spaniel, drawn by Aleks (assets/icons/cavalier.svg, 5 colours).
  'dog': { color: '#e4d1a5', icon: 'paw', image: new URL('../assets/icons/cavalier.svg', import.meta.url).href },
  'gifts': { color: '#ccfffd', icon: 'gift' },
  'others': { color: '#ffdaff', icon: 'dots' },
};

// A category name as the key above ("Wedding 💍 " -> "wedding").
export function categoryKey(name) {
  return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}/ ]/gu, '').replace(/\s+/g, ' ').trim();
}

export function categoryStyle(name) {
  const style = CATEGORIES[categoryKey(name)];
  return style ? { ...style, ...badgeColours(style.color) } : null;
}

// Colours of the categories in charts: [light theme, dark theme]. Stronger versions of the sheet's colours
// (those are too pale for thin bars), each category keeping its colour on every chart and period.
// Fifteen colours can't all be told apart (least of all with colour blindness), so the charts always name
// the category too (list, tooltip, legend); the frequent ones (first nine) are the most distinct.
export const CHART_COLOURS = {
  'groceries': ['#1baf7a', '#199e70'],
  'restaurants/fast food': ['#eda100', '#c98500'],
  'dog': ['#8d5a2b', '#a2693a'],
  'bills': ['#e87ba4', '#d55181'],
  'car': ['#e34948', '#e66767'],
  'home': ['#7d7d78', '#8f8f89'],
  'gifts': ['#0f9fc0', '#1a9cba'],
  'others': ['#9c6ade', '#9c74dc'],
  'health and beauty': ['#8f9a1e', '#929c22'],
  'travel': ['#eb6834', '#d95926'],
  'pharmacy': ['#2a78d6', '#3987e5'],
  'wedding': ['#6250d6', '#7d6fe0'],
  'fashion': ['#c45bb8', '#b968c9'],
  'electronics': ['#008300', '#1f9a1f'],
  'rent': ['#9c4a3a', '#b5604f'],
};
// Categories the app doesn't know, and entries without a category.
export const OTHER_CHART_COLOUR = ['#55554f', '#6e6e68'];

// Badge colours from a category colour: a lighter tint for the circle and a darker, more saturated shade
// of the same hue for the icon (greys stay grey).
export function badgeColours(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round((h * 60 + 360) % 360);
  const tint = (v) => Math.round((v + (1 - v) * 0.4) * 255);
  const badge = `rgb(${tint(r)} ${tint(g)} ${tint(b)})`;
  const ink = s < 0.08 ? 'hsl(0 0% 30%)' : `hsl(${h} ${Math.round(Math.min(85, Math.max(50, s * 100)))}% 30%)`;
  return { badge, ink };
}

// Bulgaria switched from lev to euro on 1 January 2026. Tabs before that year are in BGN.
export const EURO_FROM_YEAR = 2026;
export const BGN_PER_EUR = 1.95583;
