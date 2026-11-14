// Inline SVG icon set (24x24, stroke based). Use <i data-icon="name"></i> or icon('name').

const P = {
  trading: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  finance: '<rect x="2" y="7" width="20" height="14" rx="2.5"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M2 13h20"/>',
  profile: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.6a6.5 6.5 0 0 1 11.6 0"/>',
  market: '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><path d="M9.5 12.5a2.5 2.5 0 0 0 5 0"/>',
  activities: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/><polyline points="8.5 12.5 11 15 16 9.5"/>',
  claude: '<g stroke="currentColor" stroke-width="2.1" stroke-linecap="round" fill="none"><path d="M12.00 10.40L12.00 1.20M12.89 10.67L16.81 4.87M13.34 11.13L20.55 6.44M13.59 12.14L19.97 12.70M13.41 12.75L21.71 17.16M12.73 13.43L15.81 19.48M12.00 13.60L12.00 22.40M11.30 13.44L8.41 19.37M10.57 12.73L2.29 16.95M10.41 12.14L3.33 12.76M10.64 11.15L3.52 6.70M11.13 10.66L7.43 4.96"/></g>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.2"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/>',
  trades: '<path d="M7 4v16"/><path d="M7 20l-3.2-3.2"/><path d="M7 20l3.2-3.2"/><path d="M17 20V4"/><path d="M17 4l-3.2 3.2"/><path d="M17 4l3.2 3.2"/>',
  insights: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 4.1a4 4 0 0 1 0 7.8"/>',
  hotkeys: '<rect x="2" y="5.5" width="20" height="13" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14.5h9"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  star: '<polygon points="12 2.5 15 8.8 21.8 9.7 16.8 14.5 18 21.3 12 18 6 21.3 7.2 14.5 2.2 9.7 9 8.8"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  caretdown: '<path d="M7 10l5 6 5-6z" fill="currentColor" stroke="none"/>',
  caretup: '<path d="M7 15l5-6 5 6z" fill="currentColor" stroke="none"/>',
  chevleft: '<polyline points="15 18 9 12 15 6"/>',
  chevright: '<polyline points="9 18 15 12 9 6"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><polyline points="12 6.5 12 12 15.5 14"/>',
  dollar: '<circle cx="12" cy="12" r="9.5"/><path d="M14.6 9.4c-.4-.9-1.4-1.4-2.6-1.4-1.6 0-2.8.8-2.8 2 0 3 5.6 1.4 5.6 4.2 0 1.2-1.2 2-2.8 2-1.3 0-2.3-.6-2.7-1.5M12 6.2V8m0 8v1.8"/>',
  arrowupright: '<path d="M8 16L16 8M9 8h7v7"/>',
  arrowdownright: '<path d="M8 8l8 8M16 9v7H9"/>',
  candles: '<path d="M7 3.5v3M7 17.5v3M17 2.5v4M17 14.5v5"/><rect x="4.8" y="6.5" width="4.4" height="11" rx="1"/><rect x="14.8" y="6.5" width="4.4" height="8" rx="1"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  draw: '<path d="M12 3L4.5 20.5M12 3l7.5 17.5M7.5 14.5h9"/><circle cx="12" cy="3.2" r="1.3"/>',
  dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/><path d="M16.5 4.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor"/>',
  arrowright: '<path d="M4 12h16M14 6l6 6-6 6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-3.5L3 10"/><polyline points="3 4 3 10 9 10"/><path d="M4 13a8 8 0 0 0 14.5 3.5L21 14"/><polyline points="21 20 21 14 15 14"/>',
  play: '<polygon points="7 4 19 12 7 20" fill="currentColor"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/>',
  line: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};

export function icon(name, size) {
  const s = size ? ` style="width:${size}px;height:${size}px"` : '';
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${s}>${P[name] || ''}</svg>`;
}

export function hydrate(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((el) => {
    if (el.dataset.done) return;
    el.innerHTML = icon(el.dataset.icon);
    el.dataset.done = '1';
  });
}
