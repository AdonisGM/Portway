import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Pan and zoom for the tunnel map.
 *
 * Everything here is a transform on one stage element — the diagram is laid out
 * once at its natural size and then moved and scaled as a whole, rather than
 * every node recomputing where it is. That is what keeps the toolbar and the
 * legend outside it: they are siblings of the stage, so they never scale with
 * the thing they are controls for.
 */

const MIN_ZOOM = 0.45
const MAX_ZOOM = 2
/** What one notch of the wheel does, in and out. */
const WHEEL_IN = 1.08
const WHEEL_OUT = 0.93
/** What the toolbar's − and + do. */
const STEP = 0.15
/** Breathing room left around the diagram when fitting it to the canvas. */
const FIT_PADDING = 32

const clamp = (zoom: number) => Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM)

export interface Stage {
  w: number
  h: number
}

export function useMapView(
  canvasRef: React.RefObject<HTMLDivElement | null>,
  stage: Stage,
) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)

  /**
   * Zoom and pan are also kept in refs, and every change writes both.
   *
   * Not a cache — a correctness fix, twice over. A wheel notch is one of a burst
   * that all arrive before React re-renders, so an updater reading state would
   * see the same pre-burst zoom eight times and each notch would compute its pan
   * from a value seven notches out of date. And the two cannot be nested — a
   * `setPan` inside a `setZoom` updater is a side effect inside a function React
   * is entitled to call more than once, which StrictMode does, applying the pan
   * correction twice per notch and throwing the diagram off screen.
   */
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  zoomRef.current = zoom
  panRef.current = pan

  /** Both, together, from the refs — see above. */
  const apply = useCallback((next: number, p: { x: number; y: number }) => {
    zoomRef.current = next
    panRef.current = p
    setZoom(next)
    setPan(p)
  }, [])

  /**
   * Zooming about a point, which is the only kind worth having: whatever is
   * under the cursor has to stay under it, or the diagram slides away from what
   * you were looking at every time you touch the wheel.
   *
   * `pan = c - (c - pan) * k` is that, rearranged — the vector from the anchor
   * to the current origin scales by the same factor the stage does.
   */
  const zoomAbout = useCallback(
    (factor: number, cx: number, cy: number) => {
      const current = zoomRef.current
      const next = clamp(current * factor)
      // Clamping can swallow the change entirely; scaling the pan by a factor
      // the zoom did not take would drift the diagram for nothing.
      if (next === current) return
      const k = next / current
      const p = panRef.current
      apply(next, { x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k })
    },
    [apply],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Without this the canvas scrolls its ancestor instead, and on a trackpad
      // the whole screen slides while you are trying to zoom one diagram.
      e.preventDefault()
      const box = canvasRef.current?.getBoundingClientRect()
      if (!box) return
      zoomAbout(
        e.deltaY < 0 ? WHEEL_IN : WHEEL_OUT,
        e.clientX - box.left,
        e.clientY - box.top,
      )
    },
    [canvasRef, zoomAbout],
  )

  /**
   * Drag to pan, from the background only. Listeners go on the window rather
   * than the canvas so a fast drag that leaves the element keeps panning, and
   * releasing outside it still ends the drag.
   */
  const onPointerDown = useCallback(
    (e: React.MouseEvent) => {
      // A click that started on a node or a line is that thing's click.
      if (e.currentTarget !== e.target) return
      e.preventDefault()
      setPanning(true)

      const startX = e.clientX
      const startY = e.clientY
      const from = { ...panRef.current }

      const move = (m: MouseEvent) => {
        setPan({ x: from.x + (m.clientX - startX), y: from.y + (m.clientY - startY) })
      }
      const up = () => {
        setPanning(false)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [],
  )

  // The buttons zoom about the middle of the canvas, which is the only anchor
  // a keypress has — there is no cursor to keep something under.
  const zoomBy = useCallback(
    (delta: number) => {
      const box = canvasRef.current?.getBoundingClientRect()
      const cx = (box?.width ?? 0) / 2
      const cy = (box?.height ?? 0) / 2
      const current = zoomRef.current
      const next = clamp(current + delta)
      if (next === current) return
      const k = next / current
      const p = panRef.current
      apply(next, { x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k })
    },
    [apply, canvasRef],
  )

  const reset = useCallback(() => apply(1, { x: 0, y: 0 }), [apply])

  /**
   * Frame the whole diagram. Computed from the canvas and the stage rather than
   * the handoff's fixed `0.78 at (96, 40)`, which is the right answer only for
   * the one stage size the mock ever has.
   */
  const fit = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect()
    if (!box || stage.w === 0 || stage.h === 0) return
    // Never past 1:1. Fitting is for a diagram too big to see at once; blowing
    // a small one up to fill the canvas makes three tunnels look like a poster
    // and leaves nowhere to zoom in to.
    const next = clamp(
      Math.min(
        1,
        (box.width - FIT_PADDING * 2) / stage.w,
        (box.height - FIT_PADDING * 2) / stage.h,
      ),
    )
    apply(next, {
      x: (box.width - stage.w * next) / 2,
      y: (box.height - stage.h * next) / 2,
    })
  }, [apply, canvasRef, stage.w, stage.h])

  // Framed once, when the canvas first has a size and something to show. Not on
  // every change: re-fitting under someone who has just panned somewhere is the
  // diagram overruling them.
  const framed = useRef(false)
  useEffect(() => {
    if (framed.current || stage.w === 0) return
    if (!canvasRef.current?.getBoundingClientRect().width) return
    framed.current = true
    fit()
  }, [canvasRef, fit, stage.w])

  return {
    zoom,
    pan,
    panning,
    onWheel,
    onPointerDown,
    zoomIn: () => zoomBy(STEP),
    zoomOut: () => zoomBy(-STEP),
    fit,
    reset,
  }
}
