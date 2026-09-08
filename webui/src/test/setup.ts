/**
 * Vitest global setup (dev-only — not part of the production bundle).
 *
 * Imports jest-dom matchers (`toBeInTheDocument`, …) and stubs a couple of
 * browser APIs that EUI touches at render time but jsdom does not implement.
 */
import '@testing-library/jest-dom/vitest';

// EUI's responsive hooks read `window.matchMedia`, which jsdom omits.
if (typeof window !== 'undefined' && !window.matchMedia) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Radix UI primitives (DropdownMenu/Select/…) call Pointer Capture + scrollIntoView
// on open; jsdom implements neither, so the menus never open in a test. Stub them as
// no-ops so Radix-driven menus render their content under test. Additive + harmless
// (real browsers provide these).
if (typeof Element !== 'undefined') {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if (!(Element.prototype as any).hasPointerCapture) {
    (Element.prototype as any).hasPointerCapture = () => false;
  }
  if (!(Element.prototype as any).setPointerCapture) {
    (Element.prototype as any).setPointerCapture = () => {};
  }
  if (!(Element.prototype as any).releasePointerCapture) {
    (Element.prototype as any).releasePointerCapture = () => {};
  }
  if (!(Element.prototype as any).scrollIntoView) {
    (Element.prototype as any).scrollIntoView = () => {};
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// jsdom has no layout engine, so Recharts' ResponsiveContainer would otherwise
// measure 0x0 and emit a warning for every chart render. Model only the chart
// wrapper: inherit an explicit pixel dimension from its ancestors (nearly every
// shared chart component sets a truthful inline height) and use a stable desktop
// canvas width when CSS layout would ordinarily provide the remaining dimension.
//
// ONE documented exception: `MultiSeriesTrend fill` deliberately sets no inline
// height — it is `absolute inset-0` and takes the size of a flex cell, which only a
// real layout engine can resolve. The walk below then finds nothing and falls back
// to TEST_CHART_HEIGHT, which is still non-zero, so Recharts stays quiet and
// `npm run test:strict` stays clean. A `fill` chart's HEIGHT is therefore not
// assertable in jsdom at all; assert the wrapper's classes instead.
if (typeof Element !== 'undefined') {
  const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const TEST_CHART_WIDTH = 800;
  const TEST_CHART_HEIGHT = 300;

  const inheritedPixels = (element: HTMLElement, property: 'width' | 'height'): number | undefined => {
    let current: HTMLElement | null = element;
    while (current) {
      const value = current.style[property];
      if (value.endsWith('px')) {
        const pixels = Number.parseFloat(value);
        if (Number.isFinite(pixels) && pixels > 0) return pixels;
      }
      current = current.parentElement;
    }
    return undefined;
  };

  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    const nativeRect = nativeGetBoundingClientRect.call(this);
    if (
      nativeRect.width > 0 ||
      nativeRect.height > 0 ||
      !(this instanceof HTMLElement) ||
      !this.classList.contains('recharts-responsive-container')
    ) {
      return nativeRect;
    }

    const width = inheritedPixels(this, 'width') ?? TEST_CHART_WIDTH;
    const height = inheritedPixels(this, 'height') ?? TEST_CHART_HEIGHT;
    return DOMRect.fromRect({ width, height });
  };
}

// ResizeObserver normally delivers the same nonzero content box after observing.
// Deliver that notification only for the Recharts wrapper this harness models;
// unrelated resize-driven primitives keep the prior no-op behavior instead of
// gaining synthetic state transitions that their focused tests did not request.
if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
  class TestResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      if (
        !(target instanceof HTMLElement) ||
        !target.classList.contains('recharts-responsive-container')
      ) {
        return;
      }
      const contentRect = target.getBoundingClientRect();
      const observedSize = {
        inlineSize: contentRect.width,
        blockSize: contentRect.height,
      } as ResizeObserverSize;
      const entry = {
        target,
        contentRect,
        borderBoxSize: [observedSize],
        contentBoxSize: [observedSize],
        devicePixelContentBoxSize: [observedSize],
      } as unknown as ResizeObserverEntry;
      this.callback([entry], this);
    }

    unobserve(): void {}

    disconnect(): void {}
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ResizeObserver = TestResizeObserver;
}

// jsdom does not implement the 2D canvas context; some EUI widgets call it to
// measure text. Return a permissive stub so they don't throw at render time.
if (typeof HTMLCanvasElement !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      font: '',
      measureText: () => ({ width: 0 }),
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: [] }),
      putImageData: () => {},
      createImageData: () => [],
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      fill: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      arc: () => {},
      fillText: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any) as any;
}
