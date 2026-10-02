import { useEffect, useRef, useState } from 'react'

export type MenuItem = { label: string; shortcut?: string; action?: () => void; disabled?: boolean; checked?: boolean; submenu?: MenuItem[] } | 'divider'

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// Shortcuts are written the Mac way ("⇧⌘N"); other platforms show Ctrl for ⌘ and Alt for ⌥.
export function shortcutLabel(shortcut?: string) {
  if (!shortcut || isMac) return shortcut
  return shortcut.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+').replace('⌥', 'Alt+').replace('⌫', 'Backspace')
}

export function MenuBar({ menus }: { menus: { title: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [open])
  return (
    <div ref={ref} style={{ display: 'flex' }}>
      {menus.map(menu => (
        <div key={menu.title} className={`menu ${open === menu.title ? 'open' : ''}`} onPointerEnter={() => open && setOpen(menu.title)}>
          <button onClick={() => setOpen(open === menu.title ? null : menu.title)}>{menu.title}</button>
          {open === menu.title && (
            <div className="menu-list">
              {menu.items.map((item, index) => item === 'divider' ? <hr key={index} /> : (
                <button key={item.label} disabled={item.disabled} onClick={() => { setOpen(null); item.action?.() }}><span>{item.checked ? '✓ ' : ''}{item.label}</span><kbd>{shortcutLabel(item.shortcut)}</kbd></button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function Items({ items, close, flip = false }: { items: MenuItem[]; close: () => void; flip?: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  return <>{items.map((item, index) => item === 'divider' ? <hr key={index} /> : (
    <div key={item.label} className="sub" onPointerEnter={() => setOpen(item.submenu ? item.label : null)}>
      <button disabled={item.disabled} onClick={() => { if (item.submenu) { setOpen(item.label); return } close(); item.action?.() }}><span>{item.checked ? '✓ ' : ''}{item.label}</span><kbd>{item.submenu ? '›' : shortcutLabel(item.shortcut)}</kbd></button>
      {item.submenu && open === item.label && !item.disabled && <div className={`menu-list submenu ${flip ? 'flip' : ''}`}><Items items={item.submenu} close={close} flip={flip} /></div>}
    </div>
  ))}</>
}

// A right-click menu at the pointer, kept on screen, closed by clicking elsewhere, Escape, or choosing an item.
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [flip, setFlip] = useState(false)
  useEffect(() => {
    const box = ref.current!.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4))
    setPosition({ left, top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) })
    setFlip(left + box.width * 2 > window.innerWidth)
    const close = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', onClose); window.removeEventListener('resize', onClose) }
  }, [x, y, onClose])
  return <div ref={ref} className="menu-list context" style={position} onContextMenu={e => e.preventDefault()} onPointerDown={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}><Items items={items} close={onClose} flip={flip} /></div>
}
