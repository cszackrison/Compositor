import { useRef, useState, type ReactNode } from 'react'
import type { MenuItem } from './Menu'

// The menu bar as one full-screen list: a menu's items, then a submenu's, with Back to step out.
export function PhoneMenu({ menus, onClose }: { menus: { title: string; items: MenuItem[] }[]; onClose: () => void }) {
  const [stack, setStack] = useState<{ title: string; items: MenuItem[] }[]>([])
  const top = stack.at(-1)
  return (
    <div className="phone-menu">
      <header>
        <button className="icon" onClick={() => top ? setStack(stack.slice(0, -1)) : onClose()}>{top ? '‹ Back' : 'Close'}</button>
        <span>{top?.title ?? 'Menu'}</span>
        <span style={{ width: 64 }} />
      </header>
      <div className="phone-menu-list">
        {!top && menus.map(menu => <button key={menu.title} onClick={() => setStack([menu])}><span>{menu.title}</span><span className="muted">›</span></button>)}
        {top?.items.map((item, index) => item === 'divider' ? <hr key={index} /> :
          <button key={item.label} disabled={item.disabled} onClick={() => { if (item.submenu) { setStack([...stack, { title: item.label, items: item.submenu }]); return } onClose(); item.action?.() }}>
            <span>{item.checked ? '✓ ' : ''}{item.label}</span><span className="muted">{item.submenu ? '›' : ''}</span>
          </button>)}
      </div>
    </div>
  )
}

// A sheet that comes up from the bottom over the canvas, half or nearly full height. Its handle drags it: up for full, down for
// half, and down again to close.
export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [full, setFull] = useState(false)
  const [offset, setOffset] = useState(0)
  const start = useRef<number | null>(null), moved = useRef(false)
  const end = (dy: number) => {
    start.current = null
    moved.current = Math.abs(dy) > 6
    setOffset(0)
    if (dy > 70) { if (full) setFull(false); else onClose() }
    else if (dy < -50) setFull(true)
  }
  return (
    <div className={`sheet ${full ? 'full' : ''}`} style={offset ? { transform: `translateY(${Math.max(full ? 0 : -120, offset)}px)` } : undefined}>
      <div className="sheet-handle" onPointerDown={e => { start.current = e.clientY; (e.target as Element).setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (start.current !== null) setOffset(e.clientY - start.current) }}
        onPointerUp={e => { if (start.current !== null) end(e.clientY - start.current) }} onPointerCancel={() => end(0)}
        onClick={() => { if (!moved.current) setFull(!full) }}><span /></div>
      <div className="sheet-body">{children}</div>
    </div>
  )
}
