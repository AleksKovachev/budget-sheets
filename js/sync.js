// Regular re-reading of Google Sheets, with a countdown button in the top bar.
// Sheets can't notify a web page about changes, so pages ask for the data again every few seconds
// (and right away when the page comes back into view). Hidden pages don't sync.
// Google's limit is 60 read requests per minute per user, so 5 s leaves room for everything else.
// Only the current year changes often; older years are re-read about once a minute (PAST_YEARS_MS).
//
// Google sign-ins last one hour. The button shows when the sign-in is about to run out or has run out
// (a page can't renew it on its own: Google needs a click), and clicking it renews the sign-in.

import { $, el, showSessionBanner, hideSessionBanner } from './ui.js';
import { getAccessToken, secondsLeft, signIn } from './auth.js';

export const SYNC_INTERVAL_MS = 5000;
export const PAST_YEARS_MS = 60_000;
const RENEW_WARNING_S = 5 * 60;

// run() does one sync (it throws on failure; a 401 means signed out). It may return false to mean
// "skipped, try again soon" (e.g. while saving). interval() gives the current wait between syncs.
// offline: true for the development fixture, which needs no sign-in.
export function startSync(run, { interval = () => SYNC_INTERVAL_MS, offline = false } = {}) {
  const button = $('btn-sync');
  const ring = createRing();
  const label = el('span', 'sync-seconds');
  button.replaceChildren(ring.svg, label);
  button.hidden = false;

  let due = Date.now() + interval();
  let running = false;
  let lastOk = null;
  let lastError = null;

  const signedIn = () => offline || Boolean(getAccessToken());

  async function renew() {
    await signIn();
    hideSessionBanner();
    lastError = null;
    await syncNow();
  }

  async function syncNow() {
    if (running || document.visibilityState !== 'visible') return;
    if (!signedIn()) {
      showSessionBanner(renew);
      return;
    }
    running = true;
    let done = true;
    try {
      done = (await run()) !== false;
      if (done) {
        lastOk = new Date();
        lastError = null;
      }
    } catch (err) {
      console.error(err);
      lastError = err;
      if (err.status === 401) showSessionBanner(renew);
    } finally {
      running = false;
      due = Date.now() + (done ? interval() : 1000);
    }
  }

  function tick() {
    const hidden = document.visibilityState !== 'visible';
    const left = Math.max(0, due - Date.now());
    const expired = !signedIn();
    const expiring = !offline && !expired && secondsLeft() < RENEW_WARNING_S;
    button.classList.toggle('busy', running);
    button.classList.toggle('expired', expired || lastError?.status === 401);
    button.classList.toggle('failed', Boolean(lastError) && lastError.status !== 401);
    button.classList.toggle('expiring', expiring);
    ring.set(running || expired ? 1 : 1 - left / interval());
    label.textContent = expired ? '!' : running ? '…' : hidden ? '–' : String(Math.ceil(left / 1000));

    let title;
    if (expired) title = 'Your Google sign-in has run out (it lasts one hour). Click to sign in again.';
    else if (expiring) title = 'Your Google sign-in runs out in a few minutes. Click to renew it.';
    else if (running) title = 'Syncing with Google Sheets…';
    else if (lastError) title = `The last sync failed: ${lastError.message}. Click to try again.`;
    else title = `Next sync with Google Sheets. Click to sync now.${lastOk ? ` Last synced at ${lastOk.toLocaleTimeString('en-GB')}.` : ''}`;
    if (button.title !== title) button.title = title; // Changing it every second makes the tooltip flicker.
    if (expired) showSessionBanner(renew);
    if (!running && !hidden && !expired && left === 0) syncNow();
  }

  setInterval(tick, 200);
  // A click is the only moment a page may ask Google for a new sign-in.
  button.addEventListener('click', () => (!signedIn() || (!offline && secondsLeft() < RENEW_WARNING_S) ? renew() : syncNow()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('focus', syncNow);
  tick();
  // reschedule(): call when interval() changes (e.g. another year was opened).
  return { syncNow, renew, reschedule: () => { due = Math.min(due, Date.now() + interval()); } };
}

function createRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sync-ring');
  const track = document.createElementNS(ns, 'circle');
  const bar = document.createElementNS(ns, 'circle');
  for (const c of [track, bar]) {
    c.setAttribute('cx', '12');
    c.setAttribute('cy', '12');
    c.setAttribute('r', '9');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '2.5');
  }
  track.setAttribute('class', 'sync-track');
  bar.setAttribute('class', 'sync-bar');
  const length = 2 * Math.PI * 9;
  bar.setAttribute('stroke-dasharray', String(length));
  bar.setAttribute('transform', 'rotate(-90 12 12)');
  svg.append(track, bar);
  return {
    svg,
    set(fraction) {
      bar.setAttribute('stroke-dashoffset', String(length * (1 - Math.min(1, Math.max(0, fraction)))));
    },
  };
}
