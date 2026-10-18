// Amounts: a small calculator. Fields accept sums like "12.40+3,60", "3×4.5" or "100/3"; on phones (and
// narrow windows) the app shows its own keypad instead of the phone's keyboard.

import { el } from './ui.js';

// Phones and tablets get the keypad instead of the system keyboard; narrow windows show it too (handy
// for testing), but there the computer's keyboard keeps working.
const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
const narrowQuery = window.matchMedia('(max-width: 600px)');
export const useKeypad = () => touchQuery.matches || narrowQuery.matches;
// On touch screens the amount fields don't open the system keyboard at all (the keypad replaces it).
export const keypadOnly = () => touchQuery.matches;

// '' -> null; a number or a sum with + − × ÷ (also - * / x and decimal commas) -> its value rounded to
// cents; anything else -> NaN. A small parser, no eval().
export function evaluateAmount(text) {
  const source = String(text)
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/[−–]/g, '-')
    .replace(/[×xX]/g, '*')
    .replace(/÷/g, '/');
  if (source === '') return null;
  let i = 0;
  const peek = () => source[i];
  function number() {
    const match = source.slice(i).match(/^\d+(\.\d*)?|^\.\d+/);
    if (!match) throw new Error('number expected');
    i += match[0].length;
    return Number(match[0]);
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') {
      i++;
      const value = sum();
      if (peek() !== ')') throw new Error(') expected');
      i++;
      return value;
    }
    return number();
  }
  function product() {
    let value = factor();
    while (peek() === '*' || peek() === '/') {
      const op = source[i++];
      const right = factor();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const op = source[i++];
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }
  try {
    const value = sum();
    if (i !== source.length || !Number.isFinite(value)) return NaN;
    return Math.round(value * 100) / 100;
  } catch {
    return NaN;
  }
}

// True if the text is a calculation (not just a number), so a result is worth showing.
export function isCalculation(text) {
  return /\d\s*[-+−×x*/÷]\s*[\d.(]/.test(String(text).replace(/,/g, '.'));
}

const KEYS = [
  ['7', '8', '9', '÷'],
  ['4', '5', '6', '×'],
  ['1', '2', '3', '−'],
  ['.', '0', '⌫', '+'],
  ['C', '='],
];

// Keypad for the amount fields (.amount-input) inside `container`; it types into the one that last had the
// focus (fields may be replaced, e.g. when switching person). Returns its element, placed by the caller.
export function createKeypad(container) {
  const pad = el('div', 'keypad');
  pad.setAttribute('aria-label', 'Number keypad');
  let target = null;
  container.addEventListener('focusin', (event) => {
    if (event.target.classList?.contains('amount-input')) target = event.target;
  });

  for (const row of KEYS) {
    for (const key of row) {
      const button = el('button', `key${/[÷×−+]/.test(key) ? ' op' : ''}${key === '=' ? ' equals' : ''}${key === 'C' ? ' clear' : ''}`, key);
      button.type = 'button';
      button.setAttribute('aria-label', { '⌫': 'Delete', C: 'Clear', '=': 'Calculate', '÷': 'Divide', '×': 'Multiply', '−': 'Minus', '+': 'Plus' }[key] || key);
      // Keep the focus (and the caret) in the field.
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (!target?.isConnected) target = container.querySelector('.amount-input');
        if (target) press(target, key);
      });
      pad.append(button);
    }
  }
  return pad;
}

function press(input, key) {
  if (key === 'C') {
    input.value = '';
  } else if (key === '⌫') {
    input.value = input.value.slice(0, -1);
  } else if (key === '=') {
    const value = evaluateAmount(input.value);
    if (value !== null && !Number.isNaN(value)) input.value = String(value);
  } else {
    input.value += key;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// A line that shows "= 15.80" while the focused amount field holds a calculation (or says what's wrong).
export function createResultLine(container) {
  const line = el('div', 'amount-result');
  line.setAttribute('aria-live', 'polite');
  const update = (input) => {
    if (!input?.classList?.contains('amount-input') || !isCalculation(input.value)) {
      line.textContent = '';
      return;
    }
    const value = evaluateAmount(input.value);
    line.textContent = Number.isNaN(value) ? 'Not a complete calculation yet' : `= ${value.toFixed(2)}`;
  };
  container.addEventListener('input', (event) => update(event.target));
  container.addEventListener('focusin', (event) => update(event.target));
  return line;
}
