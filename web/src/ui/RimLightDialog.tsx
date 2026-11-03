import { Fragment, useRef } from 'react'
import { store } from '../editor/store'
import { job } from '../editor/filters'
import { defaultRimLight, maximumRimLights, nextRimLight, type RimLight, type RimLightSettings } from '../editor/rimLight'
import { FilterDialog } from './FilterDialog'
import { Slider } from './Inspector'
import { ColorSwatch } from './ColorPicker'

// Filter › Rim Light's panel (FilterSheet.swift): Glow, then each light's color, Angle, Strength, Width and Choke, and Add Light up
// to three. Its settings are remembered for the session, as the Mac's are.
let remembered: RimLightSettings = defaultRimLight
export const rimLightJob = (p: RimLightSettings) => job('rimLight', p)

export function RimLightControls({ p, set }: { p: RimLightSettings; set: (changes: Partial<RimLightSettings>) => void }) {
  // The color picker reports after other controls may have moved, so a light's change applies to the settings as they are then.
  const latest = useRef(p)
  latest.current = p
  const change = (index: number, c: Partial<RimLight>) => set({ lights: latest.current.lights.map((l, i) => i === index ? { ...l, ...c } : l) })
  return <>
    <div title="Let the lights glow in the air around the subject, blending them into the background"><Slider label="Glow" value={p.glow} min={0} max={100} onChange={glow => set({ glow })} /></div>
    {p.lights.map((light, i) => <Fragment key={i}>
      <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}><strong>Light {i + 1}</strong>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><ColorSwatch title={`Light ${i + 1}`} value={light.color} onChange={color => change(i, { color })} />{p.lights.length > 1 && <button type="button" title="Remove this light" onClick={() => set({ lights: p.lights.filter((_, j) => j !== i) })}>Remove</button>}</span><span /></div>
      <div title="Where the light comes from, behind the subject: 0° from the right, 90° from above"><Slider label="Angle" value={light.angle} min={-180} max={180} onChange={angle => change(i, { angle })} /></div>
      <Slider label="Strength" value={light.strength} min={0} max={100} onChange={strength => change(i, { strength })} />
      <div title="How far the light wraps around the subject's edges"><Slider label="Width" value={light.width} min={0} max={100} onChange={width => change(i, { width })} /></div>
      <div title="How the light ends on the inside: low feathers it off softly from the edge, high holds it bright and ends it crisply"><Slider label="Choke" value={light.choke} min={0} max={100} onChange={choke => change(i, { choke })} /></div>
    </Fragment>)}
    {p.lights.length < maximumRimLights && <button type="button" style={{ alignSelf: 'flex-start' }} title="Light the subject from another side as well" onClick={() => set({ lights: [...p.lights, nextRimLight(p)] })}>Add Light</button>}
  </>
}

export function RimLightDialog() {
  return <FilterDialog title="Rim Light" initial={remembered} run={rimLightJob} onClose={() => store.set({ panel: null })} onCommit={p => { remembered = p }}>{(p, set) => <RimLightControls p={p} set={set} />}</FilterDialog>
}
