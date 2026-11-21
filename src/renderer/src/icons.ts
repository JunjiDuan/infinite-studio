const svg = (body: string, size = 16, sw = 1.5) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  logo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 8.5c-1.9 0-3 1.4-3 3.5s1.1 3.5 3 3.5c3.5 0 7.5-7 11-7 1.9 0 3 1.4 3 3.5s-1.1 3.5-3 3.5c-3.5 0-7.5-7-11-7z"/></svg>`,
  logoLarge: `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 8.5c-1.9 0-3 1.4-3 3.5s1.1 3.5 3 3.5c3.5 0 7.5-7 11-7 1.9 0 3 1.4 3 3.5s-1.1 3.5-3 3.5c-3.5 0-7.5-7-11-7z"/></svg>`,
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>', 14, 1.6),
  files: svg('<path d="M3 2.5h6l3.5 3.5v7.5H3z"/><path d="M9 2.5V6h3.5"/>', 18, 1.4),
  git: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>', 18, 1.4),
  gitSmall: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>', 12, 1.6),
  sliders: svg('<path d="M2.5 4.5h11M2.5 11.5h11"/><circle cx="6" cy="4.5" r="1.7"/><circle cx="10" cy="11.5" r="1.7"/>', 18, 1.4),
  focus: svg('<path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/>', 18, 1.4),
  chevron: svg('<path d="M6 4l4 4-4 4"/>', 12, 1.6),
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>', 14, 1.5),
  folder: svg('<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>', 14, 1.5),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 12, 1.6),
  minimize: svg('<path d="M3 8h10"/>', 14, 1.2),
  maximize: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>', 14, 1.2),
  winClose: svg('<path d="M4 4l8 8M12 4l-8 8"/>', 14, 1.2),
  newFile: svg('<path d="M3.5 2.5h5l3 3v8h-8z"/><path d="M8.5 2.5v3h3M7.5 8v4M5.5 10h4"/>', 14, 1.4),
  newFolder: svg('<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/><path d="M8 7.5v3.5M6.25 9.25h3.5"/>', 14, 1.4),
  replaceAll: svg('<path d="M2.5 4h6M2.5 7h4"/><path d="M9.5 9.5h4l-1.5-1.5M13.5 12.5h-4l1.5 1.5"/>', 14, 1.4),
  collapse: svg('<path d="M4.5 6l3.5-3 3.5 3M4.5 10l3.5 3 3.5-3"/>', 14, 1.4),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>', 12, 1.4)
}
