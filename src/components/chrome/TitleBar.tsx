import { isMac } from '@/lib/platform'
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
 */
export function TitleBar() {
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
        {!isMac && <div className="size-4.5 flex-none rounded-chip bg-accent" />}
        <span className="text-body font-semibold tracking-brand">Portway</span>
      </div>

      {/* Drag surface. Double-click to maximise comes free with the attribute. */}
      <div data-tauri-drag-region className="flex-1" />

      {!isMac && <WindowControls />}
    </div>
  )
}
