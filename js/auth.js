// Google sign-in via Google Identity Services (token model, browser only).
// Access tokens live 1 hour (Google's limit for pages without a server of their own). The token is kept in
// localStorage, so reopening the site within that hour needs no new sign-in; after IDLE_MS without any
// use (on any of the app's pages), the app signs out by itself.

import { CLIENT_ID, SCOPES } from './config.js';
import { storage, clearViewState } from './storage.js';

const TOKEN_KEY = 'bs.token';
const EMAIL_KEY = 'bs.email';
const ACTIVE_KEY = 'bs.activeAt'; // Last time the app was used (tap, click, key, scroll), shared by its pages.
const ENDED_KEY = 'bs.signinEnded'; // How the last sign-in ended, for the "sign in again" message.
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const IDLE_MS = 10 * 60_000;

let token = null; // { access_token, expires_at, signed_in_at }

export function isConfigured() {
  return Boolean(CLIENT_ID) && !CLIENT_ID.startsWith('PASTE');
}

function waitForGis(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('The Google sign-in library did not load. Check the internet connection or ad blockers.'));
      }
      setTimeout(check, 50);
    })();
  });
}

function readSavedToken() {
  try {
    const saved = JSON.parse(storage.local.get(TOKEN_KEY));
    return saved && saved.expires_at > Date.now() + 60_000 ? saved : null;
  } catch {
    return null;
  }
}

// Throws if the Google library doesn't load. Returns 'idle' when a saved sign-in was dropped because the
// app wasn't used for IDLE_MS (the caller can say so).
export async function initAuth() {
  await waitForGis();
  storage.session.remove(TOKEN_KEY); // (Older versions kept the token per tab.)
  token = readSavedToken();
  if (token && idleFor() > IDLE_MS) {
    signOut();
    return 'idle';
  }
  return null;
}

// Seconds until the current sign-in runs out (0 when signed out).
export function secondsLeft() {
  return token ? Math.max(0, Math.floor((token.expires_at - Date.now()) / 1000)) : 0;
}

export function getAccessToken() {
  if (token && token.expires_at > Date.now() + 30_000) return token.access_token;
  return null;
}

// Must be called from a user gesture (button click), otherwise the popup gets blocked.
export function signIn() {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SHEETS_SCOPE)) {
          return reject(new Error('Access to Google Sheets was not granted. Sign in again and allow it.'));
        }
        const now = Date.now();
        token = { access_token: resp.access_token, expires_at: now + Number(resp.expires_in) * 1000, signed_in_at: now };
        storage.local.set(TOKEN_KEY, JSON.stringify(token));
        storage.local.remove(ENDED_KEY);
        markActive(true);
        resolve();
      },
      error_callback: (err) => reject(new Error(err.message || `Sign-in failed (${err.type}).`)),
    });
    const hint = storage.local.get(EMAIL_KEY);
    client.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: '' });
  });
}

// Signing out (also after IDLE_MS without use) forgets the sign-in and resets the page layout.
export function signOut() {
  token = null;
  storage.local.remove(TOKEN_KEY);
  storage.local.remove(EMAIL_KEY);
  storage.local.remove(ENDED_KEY);
  clearViewState();
}

// Google refused the token (a 401). Remembers whether that happened before the hour was up.
export function dropToken() {
  if (token) {
    const ended = { signedInAt: token.signed_in_at || null, expiresAt: token.expires_at, endedAt: Date.now() };
    storage.local.set(ENDED_KEY, JSON.stringify(ended));
  }
  token = null;
  storage.local.remove(TOKEN_KEY);
}

// Text for the "sign in again" bar: when the sign-in started and whether it ended early.
export function signInEndedText() {
  const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  let ended = null;
  try { ended = JSON.parse(storage.local.get(ENDED_KEY)); } catch { /* none */ }
  if (ended && ended.endedAt < ended.expiresAt - 60_000) {
    const started = ended.signedInAt ? `signed in at ${time(ended.signedInAt)}; ` : '';
    return `Google ended the sign-in at ${time(ended.endedAt)}, before its hour was up (${started}it should have lasted until ${time(ended.expiresAt)}). Syncing and saving are paused.`;
  }
  return 'Your Google sign-in has run out (Google sign-ins last one hour), so syncing and saving are paused.';
}

export async function fetchUserEmail() {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  if (res.status === 401) throw Object.assign(new Error('Session expired.'), { status: 401 });
  if (!res.ok) throw new Error(`Could not read the signed-in account (${res.status}).`);
  const info = await res.json();
  if (info.email) storage.local.set(EMAIL_KEY, info.email);
  return info.email || '(unknown account)';
}

// ---- Signing out after IDLE_MS without use ----

let lastWrite = 0;
function markActive(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < 5000) return; // At most one write every 5 seconds.
  lastWrite = now;
  storage.local.set(ACTIVE_KEY, String(now));
}

function idleFor() {
  return Date.now() - (Number(storage.local.get(ACTIVE_KEY)) || 0);
}

// Watches for use of the page; onIdle() runs once the app (all its open pages together) has not been used
// for IDLE_MS while signed in. The sign-in is already gone by then.
export function watchIdle(onIdle) {
  for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll']) {
    window.addEventListener(type, () => markActive(), { capture: true, passive: true });
  }
  const check = () => {
    if (token && idleFor() > IDLE_MS) {
      signOut();
      onIdle();
    }
  };
  setInterval(check, 10_000);
  // A page coming back into view checks first (it was not used while hidden).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  }, true);
  // Signing in or out on another page of the app (another tab) applies here too.
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY) token = readSavedToken();
  });
  if (token) markActive(true);
}
