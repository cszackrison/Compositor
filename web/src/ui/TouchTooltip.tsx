import { useEffect, useState } from 'react'

// Touch has no hover, so a button's tooltip shows while a finger holds it. Lifting after the tooltip appeared doesn't press the
// button, so it's safe to hold one just to see what it is. Layer rows keep their own long press (the layer menu).
export function TouchTooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  useEffect(() => {
    let timer = 0, start: [number, number] | null = null, shown = false
    const clear = () => { clearTimeout(timer); start = null; setTip(null) }
    const down = (event: PointerEvent) => {
      shown = false
      if (event.pointerType !== 'touch') return
      const button = (event.target as Element).closest?.('button[title]') as HTMLElement | null
      if (!button || button.closest('.layer')) return
      start = [event.clientX, event.clientY]
      timer = window.setTimeout(() => {
        const box = button.getBoundingClientRect()
        shown = true
        // Keyboard shortcuts in parentheses mean nothing to a finger.
        setTip({ text: button.title.replace(/ \([^)]*\)$/, ''), x: box.left + box.width / 2, y: box.top })
      }, 450)
    }
    const move = (event: PointerEvent) => { if (start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 12) clear() }
    const up = () => { clearTimeout(timer); start = null; if (shown) setTimeout(() => setTip(null), 600) }
    // The click that follows a held finger is swallowed.
    const click = (event: MouseEvent) => { if (shown) { shown = false; event.preventDefault(); event.stopPropagation() } }
    const menu = (event: Event) => { if (start) event.preventDefault() }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', clear, true)
    window.addEventListener('click', click, true)
    window.addEventListener('contextmenu', menu, true)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', clear, true); window.removeEventListener('click', click, true); window.removeEventListener('contextmenu', menu, true)
    }
  }, [])
  if (!tip) return null
  const left = Math.min(window.innerWidth - 80, Math.max(80, tip.x))
  return <div className="touch-tooltip" style={{ left, top: tip.y }}>{tip.text}</div>
}
