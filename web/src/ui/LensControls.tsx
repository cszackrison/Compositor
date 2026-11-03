import type { ReactNode } from 'react'
import { Slider } from './Inspector'
import { Segmented } from './FilterLayerEditor'
import { type LensSettings, bokehShapes, lensEffects, normalizedLens, starPointChoices } from '../editor/lensEffects'

const Help = ({ title, children }: { title: string; children: ReactNode }) => <div title={title} style={{ display: 'contents' }}>{children}</div>

// Lens Effects' settings (FilterSheet.swift's lensEffectsControls): which effect, then its own.
export function LensControls({ settings, onChange }: { settings: Partial<LensSettings> | Record<string, unknown>; onChange: (s: LensSettings) => void }) {
  const l = normalizedLens(settings as Partial<LensSettings>), set = (c: Partial<LensSettings>) => onChange({ ...l, ...c })
  const percent = (label: string, key: keyof LensSettings, min: number, max: number, help?: string, digits = 0) => {
    const slider = <Slider label={label} value={l[key] as number} min={min} max={max} digits={digits} suffix="%" onChange={v => set({ [key]: v })} />
    return help ? <Help key={key} title={help}>{slider}</Help> : <span key={key} style={{ display: 'contents' }}>{slider}</span>
  }
  const angle = (key: 'starAngle' | 'prismAngle', help?: string) => <Help title={help ?? ''}><Slider label="Angle" value={l[key]} min={-180} max={180} suffix="°" onChange={v => set({ [key]: v })} /></Help>
  return <>
    <div className="row"><span className="muted">Effect</span><select value={l.effect} onChange={e => set({ effect: e.target.value as LensSettings['effect'] })}>{lensEffects.map(e => <option key={e}>{e}</option>)}</select><span /></div>
    {l.effect === 'Anamorphic Flare' && <>
      {percent('Amount', 'flareAmount', 0, 100)}
      {percent('Length', 'flareLength', 1, 100, 'How far the streaks reach across the picture')}
      {percent('Threshold', 'threshold', 50, 100, 'How bright a light has to be to flare; near 100, only the biggest, brightest spots')}
      {percent('Blue', 'flareBlue', 0, 100, 'How far the lens’s coatings turn each streak blue along its length; none keeps the light’s own color')}
    </>}
    {l.effect === 'Starburst' && <>
      {percent('Amount', 'starAmount', 0, 100)}
      {percent('Length', 'starLength', 2, 40, 'How far the spikes reach')}
      {percent('Threshold', 'threshold', 50, 100, 'How bright a light has to be to sparkle; near 100, only the biggest, brightest spots')}
      {angle('starAngle')}
      <Segmented label="Points" options={starPointChoices.map(String)} value={String(l.starPoints)} title="How many spikes each light has, as the lens’s aperture blades make them" onChange={v => set({ starPoints: +v })} />
    </>}
    {l.effect === 'Mist' && <>
      {percent('Strength', 'mistStrength', 0, 100, 'How much light scatters: a soft halo around bright areas, and gently lifted shadows')}
      {percent('Size', 'mistSize', 0, 100, 'How far the light spreads')}
    </>}
    {l.effect === 'Prism' && <>
      {percent('Amount', 'prismAmount', 0, 100)}
      <Help title="How many times the picture echoes, each fainter"><Slider label="Copies" value={l.prismCopies} min={1} max={8} onChange={v => set({ prismCopies: Math.round(v) })} /></Help>
      {percent('Offset', 'prismOffset', 0, 50, 'How far apart the copies are')}
      {angle('prismAngle', 'Which way the copies step')}
      {percent('Blur', 'prismBlur', 0, 100, 'Soften the copies, more the farther they’re pushed')}
      {percent('Fringe', 'prismFringe', 0, 100, 'Split each copy’s red and blue apart, as glass does; 0 keeps the copies crisp')}
      <Segmented label="Direction" options={['One Way', 'Both Ways']} value={l.prismBothWays ? 'Both Ways' : 'One Way'} title="Copies to one side of the picture, or out to both" onChange={v => set({ prismBothWays: v === 'Both Ways' })} />
    </>}
    {l.effect === 'Bokeh' && <>
      {percent('Size', 'bokehRadius', 0.5, 6, 'How far out of focus: the size of each disc', 1)}
      {percent('Brightness', 'bokehBrightness', 0, 100, 'How brightly lights open into discs')}
      {percent('Ring', 'bokehRing', 0, 100, 'Light gathered at each disc’s rim, as some lenses draw it')}
      <div className="row" title="The aperture’s shape: round wide open, a hexagon of blades, an anamorphic oval, or a cat’s eye toward the edges"><span className="muted">Shape</span><select value={l.bokehShape} onChange={e => set({ bokehShape: e.target.value as LensSettings['bokehShape'] })}>{bokehShapes.map(s => <option key={s}>{s}</option>)}</select><span /></div>
    </>}
  </>
}
