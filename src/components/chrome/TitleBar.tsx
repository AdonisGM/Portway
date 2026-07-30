import { WindowControls } from './WindowControls'

/**
 * Custom window chrome. Not in the handoff — the mock is a card and was never
 * drawn with a titlebar — so it is built from the same tokens as everything
 * else and kept deliberately quiet.
 *
 * The brand block is 194px wide with a right hairline so it continues the
 * sidebar's column line; the mock's brand row (SSH Client.dc.html:35-38) moved
 * up here, which is why Sidebar no longer draws one.
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
        className="flex w-nav flex-none items-center gap-2.25 border-r border-w06 px-4"
      >
        <div className="size-4.5 flex-none rounded-chip bg-accent" />
        <span className="text-body font-semibold tracking-brand">Portway</span>
      </div>

      {/* Drag surface. Double-click to maximise comes free with the attribute. */}
      <div data-tauri-drag-region className="flex-1" />

      <WindowControls />
    </div>
  )
}
