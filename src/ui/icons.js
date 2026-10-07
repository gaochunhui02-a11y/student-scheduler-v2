// Inline SVG icon set (stroke icons on a 24px grid, currentColor). Static
// strings only — never built from user input.

const wrap = (body, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  plus: wrap('<path d="M12 5v14M5 12h14"/>', 2),
  close: wrap('<path d="M6 6l12 12M18 6 6 18"/>', 2),
  check: wrap('<path d="M20 6.5 9 17.5l-5-5"/>', 2),
  chevronRight: wrap('<path d="m9 5 7 7-7 7"/>'),
  chevronLeft: wrap('<path d="m15 5-7 7 7 7"/>'),
  chevronDown: wrap('<path d="m5 9 7 7 7-7"/>'),
  arrowRight: wrap('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  book: wrap('<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h11.5v14H6a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M4.5 19.5A1.5 1.5 0 0 0 6 21h11.5v-3"/><path d="M8.5 8h5"/>'),
  tasks: wrap('<path d="m4.5 7 1.6 1.6L9 5.8"/><path d="m4.5 13 1.6 1.6L9 11.8"/><path d="M12 7.2h7.5M12 13.2h7.5M12 18.7h7.5M5 18.7h3"/>'),
  grade: wrap('<path d="M12 3.5 4 7.5l8 4 8-4z"/><path d="M7 9.2v4.6c0 1.5 2.2 3 5 3s5-1.5 5-3V9.2"/><path d="M20 7.5v5.5"/>'),
  exam: wrap('<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 3.5h6v2.5H9z"/><path d="m9 13 2 2 4-4.5"/>'),
  calendar: wrap('<rect x="4.5" y="5" width="15" height="14.5" rx="2"/><path d="M4.5 9.5h15M8.5 3v3.5M15.5 3v3.5"/>'),
  semester: wrap('<path d="M4 18.5V9M8 18.5V6M12 18.5v-8M16 18.5V5M20 18.5v-6"/>'),
  clock: wrap('<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/>'),
  pin: wrap('<path d="M9 4h6l-1 5 3 3v1.5H7V12l3-3z"/><path d="M12 13.5V20"/>'),
  lock: wrap('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  unlock: wrap('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2"/>'),
  link: wrap('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  file: wrap('<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4"/>'),
  play: wrap('<path d="M8 5.5v13l11-6.5z"/>'),
  pause: wrap('<path d="M8.5 5.5v13M15.5 5.5v13"/>', 2.2),
  flame: wrap('<path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.4-2.4-5.6-3.8-7.8-.4 1.7-1.3 2.9-2.4 3.4.2-2.7-.9-5.5-3.3-7.4.1 3.1-1.6 5-3 6.9C4.8 11.6 5.5 13 5.5 14.8 5.5 18.4 8.1 21 12 21z"/>'),
  alert: wrap('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17.2v.1"/>'),
  info: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>'),
  sparkle: wrap('<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4"/>'),
  scale: wrap('<path d="M12 4v16M6 20h12"/><path d="M4 8h16"/><path d="m6.5 8-3 6.5a3.2 3.2 0 0 0 6 0zM17.5 8l-3 6.5a3.2 3.2 0 0 0 6 0z"/>'),
  branch: wrap('<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="9" r="2"/><path d="M6.5 7.5v9M17.5 11c0 3.5-11 2-11 5.5"/>'),
  repeat: wrap('<path d="M17 3.5 20 6.5l-3 3"/><path d="M4 11.5v-1a4 4 0 0 1 4-4h12"/><path d="m7 20.5-3-3 3-3"/><path d="M20 12.5v1a4 4 0 0 1-4 4H4"/>'),
  trash: wrap('<path d="M4.5 7h15M10 11v6M14 11v6"/><path d="M6.5 7l1 12.5a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-12.5M9.5 7V4.5h5V7"/>'),
  edit: wrap('<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="m13.5 6.5 4 4"/>'),
  more: wrap('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>', 2),
  target: wrap('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>'),
  board: wrap('<circle cx="6" cy="6.5" r="2.2"/><circle cx="18" cy="6.5" r="2.2"/><circle cx="12" cy="17.5" r="2.2"/><path d="M7.6 8 10.7 15.7M16.4 8 13.3 15.7"/>'),
  location: wrap('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  user: wrap('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5"/>'),
  download: wrap('<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/>'),
  upload: wrap('<path d="M12 15V4m0 0 4 4m-4-4-4 4"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/>'),
  wand: wrap('<path d="m4 20 11-11M14 5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM19 12l.6-1.2L21 10l-1.4-.8L19 8l-.6 1.2L17 10l1.4.8z"/>'),
  search: wrap('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20 15.5 15.5"/>'),
  offline: wrap('<path d="M3 3l18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14 10.3A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.5-2.8M10.5 5.6A15 15 0 0 1 22 9.5"/><path d="M12 20h.01"/>'),
};

// V4 space icons (keys stored in spaces.icon; see spacesModel.SPACE_ICONS).
Object.assign(ICONS, {
  school: ICONS.grade,
  briefcase: wrap('<rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M3.5 12.5h17"/>'),
  home: wrap('<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/>'),
  heart: wrap('<path d="M12 19.5s-7.5-4.4-7.5-9.6A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.3c0 5.2-7.5 9.6-7.5 9.6z"/>'),
  dumbbell: wrap('<path d="M6.5 8v8M17.5 8v8M4 10v4M20 10v4M6.5 12h11"/>'),
  language: wrap('<path d="M4 5.5h9M8.5 4v1.5M6 5.5c.6 3 2.6 5.6 5.5 7M11 5.5c-.7 3.4-2.9 6.2-6 7.5"/><path d="m12.5 20 3.5-8.5 3.5 8.5M13.8 17h4.4"/>'),
  code: wrap('<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>'),
  flask: wrap('<path d="M9.5 3.5h5M10.5 3.5v5.2l-5 8.6A2 2 0 0 0 7.2 20.5h9.6a2 2 0 0 0 1.7-3.2l-5-8.6V3.5"/><path d="M7.6 14.5h8.8"/>'),
  music: wrap('<path d="M9 17.5V5.5l10-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>'),
  leaf: wrap('<path d="M5 19c0-8 5-13.5 14.5-14-.5 9.5-6 14.5-14 14z"/><path d="M5 19c3-4 6-6.5 9.5-8"/>'),
  star: wrap('<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>'),
  circle: wrap('<circle cx="12" cy="12" r="6.5"/>'),
  sliders: wrap('<path d="M5 7h9M18 7h1M5 12h3M12 12h7M5 17h11M20 17h-1"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/>'),
  archive: wrap('<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18.5v-10M10 12.5h4"/>'),
});

export function icon(name) {
  return ICONS[name] || '';
}
