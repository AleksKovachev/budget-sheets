// Single-colour line icons (24×24, drawn with currentColor), so they follow the text colour and theme.

const PATHS = {
  // Interface
  sun: '<circle cx="12" cy="12" r="4.6" fill="currentColor" stroke="none"/><path stroke-width="2.2" d="M12 1.8v2.4M12 19.8v2.4M4.8 4.8l1.7 1.7M17.5 17.5l1.7 1.7M1.8 12h2.4M19.8 12h2.4M4.8 19.2l1.7-1.7M17.5 6.5l1.7-1.7"/>',
  moon: '<path fill="currentColor" stroke="none" d="M20.6 14.6A8.8 8.8 0 1 1 9.4 3.4a7 7 0 0 0 11.2 11.2z"/>',
  // Pin tilted 45°: filled when the top bar is pinned, outlined and crossed out when it isn't.
  pin: '<g transform="rotate(45 12 12)"><path fill="currentColor" d="M8.5 2.5h7l-1.2 6.5 3.7 3.8H6l3.7-3.8z"/><path stroke-width="2" d="M12 12.8v8.7"/></g>',
  // Same pin, outlined, pulled up: the needle is shorter and its tip stays where it was.
  pinOff: '<g transform="rotate(45 12 12)"><path transform="translate(0 3.6)" d="M8.5 2.5h7l-1.2 6.5 3.7 3.8H6l3.7-3.8z"/><path stroke-width="2" d="M12 16.4v5.1"/></g>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  // Solid arrow: stays readable on the half-transparent "back to top" button.
  arrowUp: '<path fill="currentColor" stroke-width="1.2" d="M12 3 20.5 12H15v9H9v-9H3.5z"/>',
  // Card order: up arrow first = oldest first; down arrow first = newest first.
  order: '<path d="M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5"/>',
  orderReverse: '<path d="M7 20V4M3.5 16.5 7 20l3.5-3.5M17 4v16M13.5 7.5 17 4l3.5 3.5"/>',
  // Entry order inside the cards (like a sorted column): up = oldest first, down = newest first.
  sortUp: '<path fill="currentColor" stroke-width="1.4" d="M12 4.5 19 13h-4.2v6.5H9.2V13H5z"/>',
  sortDown: '<path fill="currentColor" stroke-width="1.4" d="M12 19.5 19 11h-4.2V4.5H9.2V11H5z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sync: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>', // (sync, mirrored)
  close: '<path stroke-width="2.2" d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path stroke-width="2.4" d="M12 5v14M5 12h14"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  // Change spreadsheet: a sheet with a circular arrow.
  swapSheet: '<rect x="3.5" y="3.5" width="12" height="15" rx="1.5"/><path d="M6.5 8h6M6.5 11.5h6M6.5 15h3"/><path d="M20.5 13.5a4.5 4.5 0 0 1-7.6 3.3"/><path d="M20.8 9.8v3.9h-3.9"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15"/>',
  rowAbove: '<rect x="3.5" y="13" width="17" height="7" rx="1.5"/><path d="M12 3v7M8.5 6.5h7"/>',
  rowBelow: '<rect x="3.5" y="4" width="17" height="7" rx="1.5"/><path d="M12 14v7M8.5 17.5h7"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
  paste: '<path d="M9 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15"/><rect x="9" y="2.5" width="6" height="4" rx="1" fill="currentColor"/><path d="M9 12h6M9 16h4"/>',
  eraser: '<path d="M7.5 20.5 3.3 16.3a1.5 1.5 0 0 1 0-2.1l9.9-9.9a1.5 1.5 0 0 1 2.1 0l5.4 5.4a1.5 1.5 0 0 1 0 2.1l-8.8 8.7z"/><path fill="currentColor" stroke="none" d="M3.3 16.3a1.5 1.5 0 0 1 0-2.1l4.6-4.6 7.5 7.5-3.9 3.4H7.5z"/><path d="M12 20.5h8.5"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4h5v2.5"/><path d="M6 6.5 7 20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13.5"/><path d="M10 10.5v6.5M14 10.5v6.5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  // Categories. One colour only; fills (F = fill="currentColor" stroke="none") where they make a shape easier to recognise.
  rings: '<circle cx="8.5" cy="14.5" r="5"/><circle cx="15.5" cy="14.5" r="5"/><path fill="currentColor" stroke="none" d="M12 2.5 14.6 5.6 12 8.6 9.4 5.6z"/>',
  bag: '<path fill="currentColor" stroke="none" d="M5 8.2h14l-1.1 12.3a1 1 0 0 1-1 .9H7.1a1 1 0 0 1-1-.9z"/><path d="M8.8 10.5V7a3.2 3.2 0 0 1 6.4 0v3.5"/>',
  utensils: '<path d="M6 3v5a2 2 0 0 0 4 0V3M8 10v11M8 3v4"/><path fill="currentColor" d="M17 21V3c-2.2 1.3-3 4-3 7h3"/>',
  car: '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M2 15.6v-2.4c0-.9.6-1.6 1.4-1.8L6.2 11l2.4-3.4A2.2 2.2 0 0 1 10.4 6.7h5a2.2 2.2 0 0 1 1.6.7l3 3.6 1.2.4c.7.2 1.1.8 1.1 1.5v2.7a1 1 0 0 1-1 1h-1.1a2.8 2.8 0 0 0-5.4 0H9.2a2.8 2.8 0 0 0-5.4 0H3a1 1 0 0 1-1-1zM9.6 8.4 7.9 10.9h4V8.4zM13.4 8.4v2.5h4.6l-1.9-2.2a.9.9 0 0 0-.7-.3z"/><circle fill="currentColor" stroke="none" cx="6.5" cy="17" r="2.2"/><circle fill="currentColor" stroke="none" cx="17.2" cy="17" r="2.2"/>',
  suitcase: '<rect x="3.5" y="8" width="17" height="12" rx="2" fill="currentColor" stroke="none"/><path d="M9 8V5.5h6V8"/>',
  key: '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M7.5 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 1 0 0-8.8zM7.5 10.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 1 1 0-3.2z"/><path d="M11.4 12H21M18 12v3.2M21 12v3.2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  shirt: '<path fill="currentColor" stroke="none" d="M8.3 3.6 3 6.8l2.2 4.4 2.6-1.1V20a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1v-9.9l2.6 1.1L21 6.8l-5.3-3.2a3.7 3.7 0 0 1-7.4 0z"/>',
  heart: '<path fill="currentColor" stroke="none" d="M12 20.5s-8.2-4.9-8.2-11a4.6 4.6 0 0 1 8.2-2.8 4.6 4.6 0 0 1 8.2 2.8c0 6.1-8.2 11-8.2 11z"/>',
  house: '<path d="M3 11.2 12 3.8l9 7.4"/><path fill="currentColor" stroke="none" fill-rule="evenodd" d="M5.2 10.4 12 4.9l6.8 5.5V20a1 1 0 0 1-1 1H6.2a1 1 0 0 1-1-1zM10.2 21v-5.6h3.6V21z"/>',
  laptop: '<rect x="4.8" y="5" width="14.4" height="10" rx="1.2" fill="currentColor" stroke="none"/><path d="M2.5 19h19"/>',
  // Capsule at 45°, one half filled.
  pill: '<g transform="rotate(-45 12 12)"><rect x="2.5" y="8.2" width="19" height="7.6" rx="3.8"/><path fill="currentColor" stroke="none" d="M12 8.2H6.3a3.8 3.8 0 0 0 0 7.6H12z"/></g>',
  // Paw: four oval toes leaning outwards and a main pad that is wide and lobed at the bottom.
  paw: '<g fill="currentColor" stroke="none"><path d="M12 11.2c2.3 0 3.7 1.7 4.9 3.5 1 1.4 2.4 2.3 2.4 4 0 1.8-1.4 2.9-3.1 2.9-1.5 0-2.5-.8-4.2-.8s-2.7.8-4.2.8c-1.7 0-3.1-1.1-3.1-2.9 0-1.7 1.4-2.6 2.4-4 1.2-1.8 2.6-3.5 4.9-3.5z"/><ellipse cx="4.6" cy="10.4" rx="1.9" ry="2.5" transform="rotate(-24 4.6 10.4)"/><ellipse cx="8.9" cy="5.6" rx="2" ry="2.7" transform="rotate(-8 8.9 5.6)"/><ellipse cx="15.1" cy="5.6" rx="2" ry="2.7" transform="rotate(8 15.1 5.6)"/><ellipse cx="19.4" cy="10.4" rx="1.9" ry="2.5" transform="rotate(24 19.4 10.4)"/></g>',
  // Dog in profile, facing right: body, legs, head with ear and snout; tail as a line.
  // Cavalier King Charles Spaniel sitting, from the front: long ears, white blaze and muzzle, white chest,
  // front paws. (Not used by a category yet.)
  dog: '<g fill="currentColor" stroke="none"><path d="M8.4 3.9C6 3.6 4.5 5.7 4.2 8.5c-.3 2.4.4 3.6.1 5.2-.3 1.5.3 3 1.6 3.6 1.4.6 2.4-.4 2.7-1.9.3-1.7-.1-2.7.3-4.4l.4-3.4z"/><path d="M15.6 3.9c2.4-.3 3.9 1.8 4.2 4.6.3 2.4-.4 3.6-.1 5.2.3 1.5-.3 3-1.6 3.6-1.4.6-2.4-.4-2.7-1.9-.3-1.7.1-2.7-.3-4.4l-.4-3.4z"/><path fill-rule="evenodd" d="M8.3 7.8c0-2.7 1.6-4.5 3.7-4.5s3.7 1.8 3.7 4.5v2.3c0 2.5-1.6 4.1-3.7 4.1s-3.7-1.6-3.7-4.1zM11.6 3.5h.8l.5 5.6c1.3.2 2.1 1.1 2.1 2.3 0 1.4-1.3 2.3-3 2.3s-3-.9-3-2.3c0-1.2.8-2.1 2.1-2.3zM10.1 8A.55.55 0 1 0 10.1 9.1.55.55 0 1 0 10.1 8zM13.9 8A.55.55 0 1 0 13.9 9.1.55.55 0 1 0 13.9 8z"/><ellipse cx="12" cy="10.9" rx="1.15" ry=".85"/><path fill-rule="evenodd" d="M8 13.2c-1.8 1.7-2.8 4.3-2.8 6.9 0 .8.6 1.3 1.4 1.3h10.8c.8 0 1.4-.5 1.4-1.3 0-2.6-1-5.2-2.8-6.9-1 1-2.4 1.6-4 1.6s-3-.6-4-1.6zM9.4 15.3c.9.5 1.7.7 2.6.7s1.7-.2 2.6-.7c.2 1.7-.6 3.3-1.4 4.6L12 21l-1.2-1.1c-.8-1.3-1.6-2.9-1.4-4.6zM9.2 19.2h.6v2.2h-.6zM14.2 19.2h.6v2.2h-.6z"/></g>',
  // Cavalier King Charles Spaniel lying down (alternative), after a reference picture: face turned to the
  // viewer with closed eyes, white blaze and muzzle, floppy ears marked off by thin lines, chin on the front
  // paws; the body behind with the hind leg and the tail.
  dogLying: '<g fill="currentColor" stroke="none">'
    // Body (behind): gap along the right ear, hind-leg line, tail line.
    + '<path fill-rule="evenodd" d="M9.5 9C12 6 16.5 5 20 6.4c2.5 1 3.6 3.6 3.4 6.6-.1 2.8-1 5-2.4 6H10zM13.6 7.1c2 .9 2.8 3.3 2.7 6.1-.1 1.6.1 2.7.2 3.6l-.5.2c-.2-.9-.3-2.1-.2-3.8.1-2.6-.6-4.6-2.4-5.6zM17 9.6c3.2-.4 5.1 2.2 4.6 5.6l-.7-.1c.3-3-1.3-4.9-4-4.8zM22 12.2c.3 2.2-.2 4.3-1.2 5.8l.5.3c1.1-1.7 1.6-3.9 1.3-6.2z"/>'
    // Head: blaze running into the muzzle (dark cheeks around it), closed eyes.
    + '<path fill-rule="evenodd" d="M4.4 10.6c0-2.7 1.7-4.2 3.8-4.2s3.8 1.5 3.8 4.2V14c0 2.5-1.7 4.1-3.8 4.1S4.4 16.5 4.4 14zM7.95 6.6h.5l.35 5.7c1.1.3 1.75 1.05 1.75 2.05 0 1.25-1 2.05-2.35 2.05s-2.35-.8-2.35-2.05c0-1 .65-1.75 1.75-2.05zM5.6 10.2c.5.6 1.3.6 1.8 0l.3.5c-.7.8-1.7.8-2.4 0zM8.75 10.2c.5.6 1.3.6 1.8 0l.3.5c-.7.8-1.7.8-2.4 0z"/>'
    // Ears: wide, flaring out at the bottom with wavy fur, each with a thin line along the face.
    + '<path fill-rule="evenodd" d="M5.4 7.2C2.9 7 1 9 .8 12c-.1 1.6.3 2.6-.1 3.8-.3 1 .3 2 1.4 2.2 1 .2 1.4-.6 2.2-.4 1.2.3 1.8-.4 1.8-1.8zM5 7.8c-.8 2-.8 5.4 0 8.4l-.5.1c-.9-3-.9-6.4 0-8.6z"/>'
    + '<path fill-rule="evenodd" d="M11 7.2c2.5-.2 4.4 1.8 4.6 4.8.1 1.6-.3 2.6.1 3.8.3 1-.3 2-1.4 2.2-1 .2-1.4-.6-2.2-.4-1.2.3-1.8-.4-1.8-1.8zM11.4 7.8c.8 2 .8 5.4 0 8.4l.5.1c.9-3 .9-6.4 0-8.6z"/>'
    // Nose, front paws with toes.
    + '<ellipse cx="8.2" cy="13.4" rx="1" ry=".75"/>'
    + '<path fill-rule="evenodd" d="M2 17.9h4.4a1.05 1.05 0 0 1 0 2.1H2a1.05 1.05 0 0 1 0-2.1zM10 17.9h4.4a1.05 1.05 0 0 1 0 2.1H10a1.05 1.05 0 0 1 0-2.1zM2.2 18.35h.35v1.2H2.2zM3.1 18.35h.35v1.2H3.1zM13.85 18.35h.35v1.2h-.35zM12.95 18.35h.35v1.2h-.35z"/>'
    + '</g><path stroke-width=".75" d="M8.2 14.1v.7M7.4 15.1c.5.4 1.1.4 1.6 0"/>',
  // Cavalier King Charles Spaniel, face only (alternative).
  dogFace: '<g fill="currentColor" stroke="none"><path d="M7.6 5.6C4.6 5.4 2.6 8 2.4 11.4c-.2 3.7.6 7.2 2.8 8.3 1.9.9 3.1-1 3.1-3.6V8.2z"/><path d="M16.4 5.6c3-.2 5 2.4 5.2 5.8.2 3.7-.6 7.2-2.8 8.3-1.9.9-3.1-1-3.1-3.6V8.2z"/><path fill-rule="evenodd" d="M6.8 10c0-3.4 2.3-5.6 5.2-5.6s5.2 2.2 5.2 5.6v3.8c0 3.6-2.3 5.8-5.2 5.8s-5.2-2.2-5.2-5.8zM11.5 4.5h1l.5 6.3c1.6.2 2.6 1.5 2.6 3 0 1.9-1.6 3.2-3.6 3.2s-3.6-1.3-3.6-3.2c0-1.5 1-2.8 2.6-3zM9.6 9.4A.95.95 0 1 0 9.6 11.3.95.95 0 1 0 9.6 9.4zM14.4 9.4A.95.95 0 1 0 14.4 11.3.95.95 0 1 0 14.4 9.4z"/><ellipse cx="12" cy="13.5" rx="1.4" ry="1.05"/></g><path stroke-width="1.2" d="M12 14.5v1.1M10.7 16c.8.5 1.8.5 2.6 0"/>',
  // Box with the ribbon gap closed at the bottom, lid, and a large bow.
  gift: '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M4 11h16v8.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9.9 11v8h4.2v-8z"/><rect x="3" y="7.5" width="18" height="2.8" rx="1"/><path stroke-width="2" d="M12 7.5C10.6 2.3 4.6 2.4 5.8 6.6c.3 1 1.6 1 6.2.9M12 7.5c1.4-5.2 7.4-5.1 6.2-.9-.3 1-1.6 1-6.2.9"/>',
  dots: '<g fill="currentColor" stroke="none"><circle cx="5.5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18.5" cy="12" r="2"/></g>',
  tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8-9-9z"/><circle cx="8" cy="9" r="1.4"/>',
};

export const ICON_NAMES = Object.keys(PATHS);

// The icon of a category (from categoryStyle()): its own picture if it has one, otherwise the line icon.
export function categoryIcon(style, className = 'icon') {
  if (style?.image) {
    const img = document.createElement('img');
    img.src = style.image;
    img.className = className;
    img.alt = '';
    img.decoding = 'async';
    return img;
  }
  return icon(style?.icon || 'tag', className);
}

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = PATHS[name] || PATHS.tag; // Static strings defined above, never user data.
  return svg;
}
