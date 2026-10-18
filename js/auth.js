// Google sign-in via Google Identity Services (token model, browser only).
// Access tokens live ~1 hour; they are kept in sessionStorage so a reload doesn't force a new sign-in.

import { CLIENT_ID, SCOPES } from './config.js';
import { storage } from './storage.js';

const TOKEN_KEY = 'bs.token';
const EMAIL_KEY = 'bs.email';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let token = null; // { access_token, expires_at }

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

export async function initAuth() {
  await waitForGis();
  try {
    const saved = JSON.parse(storage.session.get(TOKEN_KEY));
    if (saved && saved.expires_at > Date.now() + 60_000) token = saved;
  } catch {
    // No usable saved token.
  }
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
        token = { access_token: resp.access_token, expires_at: Date.now() + Number(resp.expires_in) * 1000 };
        storage.session.set(TOKEN_KEY, JSON.stringify(token));
        resolve();
      },
      error_callback: (err) => reject(new Error(err.message || `Sign-in failed (${err.type}).`)),
    });
    const hint = storage.local.get(EMAIL_KEY);
    client.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: '' });
  });
}

export function signOut() {
  token = null;
  storage.session.remove(TOKEN_KEY);
  storage.local.remove(EMAIL_KEY);
}

export function dropToken() {
  token = null;
  storage.session.remove(TOKEN_KEY);
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
