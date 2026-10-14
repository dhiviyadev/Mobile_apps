/** Hard-coded SVG icons for in-game buttons (original, simple strokes). */
const svg = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;

export const GAME_ICONS = {
  jump: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  crouch: svg('<path d="M12 5v14M5 12l7 7 7-7"/>'),
  pickaxe: svg('<path d="M14 4c3 0 6 3 6 6M4 20l9-9M9 5c4-2 8-1 10 1M13 11l-2-2"/>'),
  place: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12v9M12 12l8-4.5M12 12L4 7.5"/>'),
  menu: svg('<path d="M9 5v14M15 5v14"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  fire: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  aim: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>'),
  reload: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>'),
  swap: svg('<path d="M7 7h12l-3-3M17 17H5l3 3"/>'),
  melee: svg('<path d="M5 19l9-9M14 4l6 6-4 1-3-3z"/>'),
  scoreboard: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  sprint: svg('<path d="M13 4l-2 6h5l-6 10 2-7H7z"/>', true),
};
