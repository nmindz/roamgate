import type { IDisposable, Terminal } from "@xterm/xterm";
import {
  decodePngBase64,
  placementRects,
  TerminalGraphicsStore,
} from "./terminalGraphics";

/**
 * Canvas layered over xterm's `.xterm-screen` that paints Kitty-graphics
 * placements pushed by the bridge. The cell size comes from the screen
 * element divided by cols/rows, the same source the mouse-cell math uses, so
 * font scaling is picked up through the resize observer.
 */
export class TerminalGraphicsOverlay {
  readonly store: TerminalGraphicsStore<ImageBitmap>;
  private readonly canvas = document.createElement("canvas");
  private readonly screen: Element | null;
  private readonly subscriptions: IDisposable[];
  private readonly resizeObserver: ResizeObserver | null;
  private frame = 0;
  private painted = false;
  private disposed = false;

  constructor(private readonly term: Terminal) {
    this.store = new TerminalGraphicsStore(decodePngBase64, () =>
      this.schedule(),
    );
    this.canvas.className = "terminal-graphics-overlay";
    this.canvas.setAttribute("aria-hidden", "true");
    this.screen = term.element?.querySelector(".xterm-screen") ?? null;
    this.screen?.appendChild(this.canvas);
    this.subscriptions = [
      term.onResize(() => this.schedule()),
      term.onScroll(() => this.schedule()),
    ];
    this.resizeObserver = this.screen
      ? new ResizeObserver(() => this.schedule())
      : null;
    if (this.screen) this.resizeObserver?.observe(this.screen);
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.resizeObserver?.disconnect();
    this.store.clear();
    this.canvas.remove();
  }

  private schedule(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const { term, canvas, screen, store } = this;
    if (this.disposed || !screen) return;
    const bounds = screen.getBoundingClientRect();
    const ctx = store.placements.length > 0 ? canvas.getContext("2d") : null;
    if (!ctx || term.cols <= 0 || term.rows <= 0 || bounds.width <= 0) {
      if (this.painted) {
        canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        this.painted = false;
      }
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    // Assigning the size clears the bitmap, so no separate clear is needed.
    canvas.width = Math.round(bounds.width * dpr);
    canvas.height = Math.round(bounds.height * dpr);
    canvas.style.width = `${bounds.width}px`;
    canvas.style.height = `${bounds.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = {
      width: bounds.width / term.cols,
      height: bounds.height / term.rows,
    };
    const buffer = term.buffer.active;
    const scrollRows = buffer.baseY - buffer.viewportY;
    for (const placement of store.placements) {
      const image = store.image(placement.asset);
      if (!image) continue;
      const rects = placementRects(
        placement,
        cell,
        store.graphicsCell,
        image,
        scrollRows,
      );
      if (!rects) continue;
      ctx.drawImage(
        image,
        rects.sx,
        rects.sy,
        rects.sw,
        rects.sh,
        rects.dx,
        rects.dy,
        rects.dw,
        rects.dh,
      );
    }
    this.painted = true;
  }
}
