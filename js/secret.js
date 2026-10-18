// The default spreadsheet's address is published only encrypted (config.js, DEFAULT_SPREADSHEET), once per
// person, with a key made from that person's email address. After signing in, the app knows the email
// and can decrypt it; the public page alone doesn't show which spreadsheet it is.
// (The real protection is still Google's sharing: only accounts the spreadsheet is shared with can open it.)

const SALT = 'budget-sheets/default-spreadsheet';
const ITERATIONS = 250_000;

async function keyFor(email) {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(email.trim().toLowerCase()), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// -> base64 text (a random 12-byte IV followed by the encrypted text)
export async function encryptFor(email, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(email), new TextEncoder().encode(text));
  const packed = new Uint8Array(iv.length + data.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(data), iv.length);
  return btoa(String.fromCharCode(...packed));
}

// -> the text, or null if it can't be decrypted with this email (wrong person, damaged text)
export async function decryptFor(email, packedText) {
  try {
    const packed = Uint8Array.from(atob(packedText), (c) => c.charCodeAt(0));
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, await keyFor(email), packed.slice(12));
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
}
