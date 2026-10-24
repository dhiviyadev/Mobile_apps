/**
 * Original card artwork, drawn as inline SVG at runtime (no image downloads).
 */

function isoCube(cx: number, cy: number, s: number, top: string, left: string, right: string): string {
  const h = s / 2;
  return (
    `<polygon points="${cx},${cy - h} ${cx + s},${cy} ${cx},${cy + h} ${cx - s},${cy}" fill="${top}"/>` +
    `<polygon points="${cx - s},${cy} ${cx},${cy + h} ${cx},${cy + h + s} ${cx - s},${cy + s}" fill="${left}"/>` +
    `<polygon points="${cx + s},${cy} ${cx},${cy + h} ${cx},${cy + h + s} ${cx + s},${cy + s}" fill="${right}"/>`
  );
}

/** Floating voxel island with a tree and a pond. */
export function voxelArt(): string {
  const s = 22;
  const cubes: string[] = [];
  const grass = ['#7be08f', '#4fa863', '#3d8a50'];
  const water = ['#6fd3ff', '#3aa0d8', '#2b84b8'];
  const sand = ['#f3dc9a', '#c9b06d', '#b09756'];
  // 4x4 island, back-to-front so nearer cubes overlap.
  const layout = [
    ['g', 'g', 'g', 's'],
    ['g', 'g', 'w', 's'],
    ['g', 'w', 'w', 'g'],
    ['s', 'g', 'g', 'g'],
  ];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const t = layout[row][col];
      const c = t === 'g' ? grass : t === 'w' ? water : sand;
      const x = 160 + (col - row) * s;
      const y = 92 + (col + row) * (s / 2) + (t === 'w' ? 4 : 0);
      cubes.push(isoCube(x, y, s, c[0], c[1], c[2]));
    }
  }
  // Tree: trunk + leaves on the back-left tile.
  const tx = 160 + (0 - 0) * s;
  const ty = 92 - s;
  cubes.push(isoCube(tx, ty, s * 0.5, '#a0714a', '#7a5233', '#684429'));
  cubes.push(isoCube(tx, ty - s * 0.5, s * 0.5, '#a0714a', '#7a5233', '#684429'));
  cubes.push(isoCube(tx, ty - s * 1.3, s * 0.9, '#9df07a', '#5fb84a', '#4b9a3a'));
  // Floating block being "placed".
  cubes.push(`<g class="float-cube">${isoCube(232, 44, 14, '#ffd166', '#d9a93f', '#c28f2b')}</g>`);
  return `<svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><radialGradient id="vglow" cx="50%" cy="60%" r="60%"><stop offset="0" stop-color="#bff7c9" stop-opacity=".45"/><stop offset="1" stop-color="#bff7c9" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="160" cy="130" rx="130" ry="70" fill="url(#vglow)"/>
    ${cubes.join('')}
    <g fill="#ffffff" opacity=".85"><rect x="40" y="36" width="34" height="10" rx="5"/><rect x="56" y="28" width="22" height="10" rx="5"/><rect x="250" y="120" width="30" height="9" rx="4.5"/></g>
  </svg>`;
}

/** Angular arena cover blocks, a crosshair and tracer lines. */
export function arenaArt(): string {
  const s = 20;
  const cubes: string[] = [];
  const wall = ['#ffd0b8', '#e08a63', '#c7704b'];
  const dark = ['#8b7bd8', '#5b4fa6', '#4a3f8c'];
  const floor = ['#3b335f', '#2c2550', '#251f45'];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      cubes.push(isoCube(160 + (col - row) * s, 70 + (col + row) * (s / 2), s, floor[0], floor[1], floor[2]));
    }
  }
  const raised: [number, number, number, string[]][] = [
    [0, 0, 2, dark],
    [4, 1, 1, wall],
    [1, 3, 1, wall],
    [3, 3, 2, dark],
    [2, 2, 1, wall],
  ];
  for (const [col, row, height, c] of raised) {
    for (let k = 1; k <= height; k++) {
      cubes.push(isoCube(160 + (col - row) * s, 70 + (col + row) * (s / 2) - k * s, s, c[0], c[1], c[2]));
    }
  }
  return `<svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><radialGradient id="aglow" cx="50%" cy="55%" r="60%"><stop offset="0" stop-color="#ffb38f" stop-opacity=".45"/><stop offset="1" stop-color="#ffb38f" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="160" cy="120" rx="140" ry="75" fill="url(#aglow)"/>
    ${cubes.join('')}
    <g stroke="#fff4c2" stroke-width="2.5" stroke-linecap="round" opacity=".9">
      <line x1="40" y1="150" x2="120" y2="96" class="tracer"/>
      <line x1="290" y1="40" x2="214" y2="80" class="tracer t2"/>
    </g>
    <g class="crosshair" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round">
      <circle cx="252" cy="140" r="16"/><line x1="252" y1="116" x2="252" y2="128"/><line x1="252" y1="152" x2="252" y2="164"/>
      <line x1="228" y1="140" x2="240" y2="140"/><line x1="264" y1="140" x2="276" y2="140"/>
    </g>
  </svg>`;
}

export const ICONS = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 14h.01M15 14h.01"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  wifiOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.3-1.6M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 11 5.1M12 20h.01"/></svg>',
  // Install app / instructions (InstallSheet, PlatformNotices).
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M7 10H5v11h14V10h-2"/></svg>',
  plusSquare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>',
  kebab: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
};

/** The hub's cube mark (same geometry as public/icon.svg). */
export const CUBE_MARK =
  '<svg viewBox="0 0 128 128" aria-hidden="true"><polygon points="64,26 98,46 64,66 30,46" fill="#5fd17a"/><polygon points="30,46 64,66 64,106 30,86" fill="#2fb3a6"/><polygon points="98,46 64,66 64,106 98,86" fill="#ff7a45"/></svg>';
