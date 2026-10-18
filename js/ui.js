// Small DOM helpers shared by the pages: theme, pinned top bar, loading overlay, back-to-top, phone view.

import { storage } from './storage.js';
import { icon } from './icons.js';
import { signInEndedText } from './auth.js';

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// True when the last tap came from a finger or a pen (phones, tablets) rather than a mouse. Used to skip the
// on-screen keyboard where the app has its own input (calendar, amount keypad). Decided by the tap itself:
// screen-type checks aren't reliable (phones with a pen can report a mouse-like pointer).
let lastPointerType = window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
document.addEventListener('pointerdown', (event) => { lastPointerType = event.pointerType || 'mouse'; }, true);
export const touchInput = () => lastPointerType !== 'mouse';

export function showError(err) {
  const box = $('error');
  box.textContent = err ? err.message || String(err) : '';
  box.hidden = !err;
}

// ---- Floating popups (calendars, pickers) ----

// Shows `node` next to `anchor`: below it, or above when there's no room, always inside the screen.
// Fixed position; placed inside the anchor's dialog when there is one, so it shows above the dialog.
export function placeFloating(node, anchor) {
  const container = anchor.closest('dialog') || document.body;
  node.classList.add('floating');
  container.append(node);
  const rect = anchor.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth;
  const viewHeight = window.innerHeight;
  const width = Math.min(node.offsetWidth, viewWidth - 16);
  const height = node.offsetHeight;
  const left = Math.min(Math.max(8, rect.left), viewWidth - width - 8);
  const below = rect.bottom + 4 + height <= viewHeight;
  // Below or above the anchor; either way never past the bottom or top of the screen.
  const top = Math.max(8, Math.min(below ? rect.bottom + 4 : rect.top - height - 4, viewHeight - height - 8));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

// ---- Dialogs (native <dialog>: dims the page, traps focus, Esc closes) ----

// Opens a dialog with a title and an X button. Returns { dialog, body, foot, close(value) }.
// onClose(value) runs once it's closed ('cancel' for X, Esc or a click outside).
export function openDialog({ title, className = '', onClose } = {}) {
  const dialog = el('dialog', `modal ${className}`.trim());
  const head = el('div', 'modal-head');
  const close = el('button', 'icon-button modal-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  close.append(icon('close'));
  head.append(el('h2', null, title), close);
  const body = el('div', 'modal-body');
  const foot = el('div', 'modal-foot');
  dialog.append(head, body, foot);
  document.body.append(dialog);

  // Closing is done here, not in the dialog's "close" event: some browsers don't fire that event
  // reliably (seen in the app's test browser), which would leave the caller waiting forever.
  let closed = false;
  const finish = (value) => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close(value);
    dialog.remove();
    onClose?.(value);
  };

  close.addEventListener('click', () => finish('cancel'));
  // A click on the dimmed area around the dialog (the dialog element itself, not its content) closes it.
  dialog.addEventListener('pointerdown', (event) => {
    if (event.target === dialog) finish('cancel');
  });
  // Esc: closes a popup open inside the dialog (calendar, list) if there is one, otherwise the dialog.
  let keepOpen = false;
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') keepOpen = Boolean(dialog.querySelector('.floating'));
  }, true);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (keepOpen) keepOpen = false;
    else finish('cancel');
  });
  // Phones: once the on-screen keyboard is up, keep the field being typed into visible.
  dialog.addEventListener('focusin', (event) => {
    setTimeout(() => event.target.scrollIntoView?.({ block: 'nearest' }), 300);
  });
  dialog.showModal();
  return { dialog, body, foot, close: finish };
}

export function dialogButton(label, className, onClick) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

// Yes/no question. Resolves true if confirmed.
export function confirmDialog({ title, message, confirm = 'OK', cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    let answer = false;
    const { body, foot, close } = openDialog({ title, className: 'confirm', onClose: () => resolve(answer) });
    for (const paragraph of [].concat(message)) body.append(el('p', null, paragraph));
    const yes = dialogButton(confirm, 'primary', () => { answer = true; close('ok'); });
    foot.append(dialogButton(cancel, null, () => close('cancel')), yes);
    yes.focus();
  });
}

// Bar above the content when the Google sign-in has run out; the page and its data stay as they are.
export function showSessionBanner(onSignIn) {
  if ($('session-banner')) return;
  const bar = el('div', 'session-banner');
  bar.id = 'session-banner';
  bar.setAttribute('role', 'alert');
  const button = el('button', 'primary', 'Sign in again');
  button.type = 'button';
  button.addEventListener('click', () => onSignIn().catch((err) => showError(err)));
  bar.append(el('span', null, signInEndedText()), button);
  document.querySelector('main')?.prepend(bar);
}

export function hideSessionBanner() {
  $('session-banner')?.remove();
}

// 0 -> A, 25 -> Z, 26 -> AA
export function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Puts an icon in front of an element's text (buttons and links with data-icon="name").
function decorateIcons() {
  for (const node of document.querySelectorAll('[data-icon]')) {
    if (!node.querySelector('svg')) node.prepend(icon(node.dataset.icon));
  }
}

// ---- Theme (dark by default; the <head> script applies the saved one before the page draws) ----

const THEME_KEY = 'bs.theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  const button = $('btn-theme');
  if (button) {
    const dark = document.documentElement.dataset.theme === 'dark';
    button.replaceChildren(icon(dark ? 'sun' : 'moon'));
    button.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  }
}

function setUpThemeSwitch() {
  applyTheme(storage.local.get(THEME_KEY));
  $('btn-theme')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storage.local.set(THEME_KEY, next);
    applyTheme(next);
  });
  // Keeps the phone frame and other open pages in step.
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY) applyTheme(event.newValue);
  });
}

// ---- Top bar: sticks to the top unless unpinned ----

const PIN_KEY = 'bs.pinned';

function setUpPin() {
  const bar = document.querySelector('.topbar');
  const button = $('btn-pin');
  if (!bar || !button) return;
  const apply = (pinned) => {
    button.replaceChildren(icon(pinned ? 'pin' : 'pinOff'));
    document.body.classList.toggle('topbar-unpinned', !pinned);
    button.classList.toggle('active', pinned);
    button.title = pinned ? 'Top bar stays visible. Click to let it scroll away.' : 'Click to keep the top bar visible.';
    button.setAttribute('aria-pressed', String(pinned));
    updateOffset();
  };
  // Sticky elements further down (month headers) sit just below the pinned bar.
  const updateOffset = () => {
    const pinned = !document.body.classList.contains('topbar-unpinned');
    document.documentElement.style.setProperty('--topbar-h', pinned ? `${bar.offsetHeight}px` : '0px');
  };
  new ResizeObserver(updateOffset).observe(bar);
  button.addEventListener('click', () => {
    const pinned = document.body.classList.contains('topbar-unpinned');
    storage.local.set(PIN_KEY, pinned ? '1' : '0');
    apply(pinned);
  });
  apply(storage.local.get(PIN_KEY) !== '0');
}

// ---- Loading overlay: dims the page while the app waits for Google Sheets ----

let pending = 0;
let showTimer = 0;

function overlay() {
  let node = $('loading');
  if (!node) {
    node = el('div', 'loading');
    node.id = 'loading';
    node.hidden = true;
    const box = el('div', 'loading-box');
    box.append(el('div', 'spinner'), el('div', null, 'Loading…'));
    node.append(box);
    document.body.append(node);
  }
  return node;
}

// Runs fn() with the overlay shown (after a short delay, so quick requests don't flicker).
export async function withLoading(fn) {
  if (pending++ === 0) showTimer = setTimeout(() => { overlay().hidden = false; }, 150);
  try {
    return await fn();
  } finally {
    if (--pending === 0) {
      clearTimeout(showTimer);
      overlay().hidden = true;
    }
  }
}

// ---- Back to top ----

function setUpBackToTop() {
  const button = el('button', 'to-top');
  button.type = 'button';
  button.title = 'Back to the top';
  button.setAttribute('aria-label', 'Back to the top');
  button.append(icon('arrowUp'));
  button.hidden = true;
  button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.body.append(button);
  const update = () => { button.hidden = window.scrollY < 400; };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// The "Phone view" switch exists only while developing locally, and not inside the phone frame itself.
function setUpPhoneSwitch() {
  const button = $('btn-phone');
  if (!button || location.hostname !== 'localhost' || window.top !== window) return;
  const page = location.pathname.split('/').pop() || 'index.html';
  button.href = `dev/phone.html?page=${encodeURIComponent(page + location.search)}`;
  button.hidden = false;
  // The icon review page, also only while developing.
  const icons = el('a', 'button', 'Icons');
  icons.href = 'dev/icons.html';
  icons.dataset.icon = 'dots'; // (For the layout; the icons were already added by decorateIcons.)
  icons.prepend(icon('dots'));
  button.after(icons);
}

// ---- Tooltips by finger: press and hold a button (phones have no mouse to hover with) ----

function setUpTouchTips() {
  let timer = 0;
  let start = null;
  let tip = null;
  let shownAt = 0;
  const hide = () => {
    tip?.remove();
    tip = null;
  };
  document.addEventListener('pointerdown', (event) => {
    hide();
    clearTimeout(timer);
    if (event.pointerType === 'mouse') return;
    const target = event.target.closest?.('[title]');
    // Entry rows and the raw grid have their own press-and-hold menu.
    if (!target || !target.title || target.closest('input, textarea, .entries .entry.editable, #grid')) return;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      tip = el('div', 'touch-tip', target.title);
      tip.setAttribute('role', 'tooltip');
      placeFloating(tip, target);
      shownAt = Date.now();
      setTimeout(hide, 4000);
    }, 500);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearTimeout(timer);
  }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => clearTimeout(timer), true);
  window.addEventListener('scroll', hide, { passive: true });
  // Letting go after the tooltip appeared doesn't also press the button, nor open the browser's menu.
  document.addEventListener('click', (event) => {
    if (Date.now() - shownAt < 1500) {
      shownAt = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('contextmenu', (event) => {
    if (tip || Date.now() - shownAt < 1500) event.preventDefault();
  }, true);
}

// ---- "Open in Google Sheets" on Android phones: the phone's own "Open with" choice ----

// An Android "intent" link for the spreadsheet that names no app: Android then asks which app opens it
// (Sheets app, browsers), unless an app was set to always open such links. If nothing can, the normal
// link opens.
function openWithLink(href) {
  const url = new URL(href);
  // The tab (#gid=…) goes in as ?gid=… (Sheets understands both; an intent link can't contain another #).
  const gid = url.hash.match(/gid=(\d+)/)?.[1];
  if (gid) url.searchParams.set('gid', gid);
  url.hash = '';
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;action=android.intent.action.VIEW;`
    + `category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(href)};end`;
}

function setUpSheetsLink() {
  const link = $('btn-sheets');
  if (!link || !/Android/i.test(navigator.userAgent)) return;
  link.addEventListener('click', (event) => {
    const href = link.href;
    if (!href.startsWith('https://docs.google.com/')) return; // (Fixture: no real spreadsheet.)
    event.preventDefault();
    location.href = openWithLink(href);
  });
}

export function setUpPage() {
  // After picking from a dropdown, it shouldn't stay focused (and look different) until clicked elsewhere.
  document.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement) event.target.blur();
  });
  // A dropdown used with the mouse gets no focus ring (also when closed without picking anything);
  // one reached with the keyboard (Tab) does.
  document.addEventListener('pointerdown', (event) => {
    const select = event.target.closest?.('select');
    if (select) select.dataset.pointer = '1';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') document.querySelectorAll('select[data-pointer]').forEach((s) => delete s.dataset.pointer);
  });
  decorateIcons();
  setUpThemeSwitch();
  setUpPin();
  setUpBackToTop();
  setUpPhoneSwitch();
  setUpTouchTips();
  setUpSheetsLink();
}
