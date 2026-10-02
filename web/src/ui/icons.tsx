// Small line icons in the spirit of SF Symbols, drawn at 16 px.
const paths: Record<string, string> = {
  move: 'M8 1v14M1 8h14M8 1 6 3M8 1l2 2M8 15l-2-2M8 15l2-2M1 8l2-2M1 8l2 2M15 8l-2-2M15 8l-2 2',
  marquee: 'M2 2h12v12H2z',
  ellipse: 'M8 2a6 5 0 1 0 0.01 0',
  lasso: 'M3 9c-2-4 3-7 7-6s5 4 2 6-7 1-8 0M4 9l-1 5',
  wand: 'M2 14 10 6M11 1v3M14 4h-3M13 2l-2 2M9 2l1 1M14 8l-1-1',
  brush: 'M13 2 6 9M6 9c-2 0-3 1-3 3s-1 2-2 2c3 1 6 0 6-3z',
  eraser: 'M9 2l5 5-7 7H4L1 11zM5 6l5 5',
  eyedropper: 'M12 2l2 2-2 2-1-1-6 6H3v-2l6-6-1-1 2-2 1 1z',
  hand: 'M5 14c-2-2-3-4-3-6l1-1 2 2V3l1-1 1 1v4V2l1-1 1 1v5V3l1-1 1 1v6V5l1-1 1 1v5c0 3-2 4-4 4z',
  zoom: 'M7 2a5 5 0 1 0 0.01 0M11 11l4 4M5 7h4M7 5v4',
  eye: 'M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5zM8 6a2 2 0 1 0 0.01 0',
  eyeOff: 'M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5zM2 2l12 12',
  plus: 'M2 2h12v12H2zM8 5v6M5 8h6',
  folder: 'M1 4h5l1 1h8v8H1zM10 7v4M8 9h4',
  mask: 'M2 2h12v12H2zM8 5a3 3 0 1 0 0.01 0',
  adjust: 'M8 2a6 6 0 1 0 0.01 0M8 2v12',
  fx: 'M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z',
  trash: 'M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10',
  chevronRight: 'M6 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  swap: 'M3 6h9l-2-2M13 10H4l2 2',
  link: 'M6 10l4-4M5 7 3 9a2 2 0 0 0 3 3l2-2M11 9l2-2a2 2 0 0 0-3-3L8 6',
  clip: 'M4 2v6c0 2 2 3 4 3h5l-2-2M13 11l-2 2',
  heal: 'M3 9l6-6 4 4-6 6zM6 6l4 4M5 11l-2 2M11 5l2-2',
  clone: 'M6 2h4v4l2 2v2H4V8l2-2zM4 12h8v2H4z',
  smear: 'M3 13c2-1 2-3 4-4s4 1 6-2M10 3l3 3',
  gradient: 'M2 3h12v10H2zM5 3v10M8 3v10M11 3v10',
  shape: 'M2 9h6v5H2zM11 2l3.5 6h-7z',
  crop: 'M4 1v11h11M1 4h11v11',
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? ''} /></svg>
}
