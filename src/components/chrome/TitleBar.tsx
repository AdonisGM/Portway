import type { ReactNode } from 'react'
import { isMac } from '@/lib/platform'
import { BrandMark } from './BrandMark'
import { WindowControls } from './WindowControls'

/**
 * Custom window chrome. Not in the handoff — the mock is a card and was never
 * drawn with a titlebar — so it is built from the same tokens as everything
 * else and kept deliberately quiet.
 *
 * The brand block is 214px wide with a right hairline so it continues the
 * sidebar's column line; the mock's brand row (SSH Client.dc.html:35-38) moved
 * up here, which is why Sidebar no longer draws one.
 *
 * Two frames, one bar. Windows gets the caption buttons drawn here, because
 * tauri.conf.json sets decorations:false. macOS instead keeps its real frame
 * (tauri.macos.conf.json: decorations:true + titleBarStyle:Overlay), so the
 * system draws the traffic lights over our content at the top left and we draw
 * nothing on the right. The 214px brand block is load-bearing — it continues
 * the sidebar hairline — so the lights are cleared with a left inset inside it
 * rather than by widening it, and the accent dot steps aside for them: three
 * coloured circles are already the brand mark's job in that corner.
 *
 * `subject` names what this particular window is showing. The main window has
 * no answer — it shows everything — but a session window is one connection and
 * nothing else, and after the tab strip went away this bar is the only place
 * left that says which server you are typing at.
 */
export function TitleBar({ subject }: { subject?: ReactNode }) {
  return (
    // The drag attribute deliberately sits on the two inert areas below, never
    // on this bar: Tauri claims mousedown for anything inside a drag region, so
    // a wrapping attribute here silently eats every caption-button click and
    // turns it into a window drag instead.
    <div className="flex h-titlebar flex-none items-stretch border-b border-w06 bg-nav">
      <div
        data-tauri-drag-region
        className={`flex w-nav flex-none items-center gap-2.25 border-r border-w06 ${
          isMac ? 'pl-lights pr-4' : 'px-4'
        }`}
      >
        {!isMac && <BrandMark className="size-4.5 flex-none" />}
        {/* Same reason as the subject below: the word is not a control, and
            grabbing the app's own name is the most natural place to drag. */}
        <span className="pointer-events-none text-body font-semibold tracking-brand select-none">
          Portway
        </span>
      </div>

      {/* Drag surface. Double-click to maximise comes free with the attribute,
          and the subject rides inside it so the whole bar stays draggable —
          text is not a control, and a strip of it that refuses to move the
          window would be a dead patch in the middle of one that does. */}
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center px-4">
        {/* Tauri reads the attribute off the exact element under the pointer,
            so anything drawn on top of a drag region has to let the pointer
            through or it becomes a dead patch in the middle of a bar that
            otherwise moves the window. */}
        <div className="pointer-events-none flex min-w-0 items-center gap-2.25 select-none">
          {subject}
        </div>
      </div>

      {!isMac && <WindowControls />}
    </div>
  )
}
