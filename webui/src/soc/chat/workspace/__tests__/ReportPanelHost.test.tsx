/**
 * ReportPanelHost and the geometry hook's per-viewer preferences (SPEC §10.1, §10.6,
 * §10.9): the split separator is the Case Manager idiom — a 9 px handle around a 1 px
 * hairline, `role="separator"` with value attributes, ←/→ in 16 px steps (Shift 32),
 * Home/End, double-click to reset, pointer drag that persists on release — and the
 * overlay hosts the same lazy panel in a Sheet. The rail-collapsed choice and the panel
 * width persist in localStorage and fail soft when storage throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('../../report/ReportPanel', async () => {
  const React = await import('react');
  const ReportPanel = (props: { mode: string; onClose: () => void }) =>
    React.createElement(
      'section',
      { 'data-testid': 'report-panel', 'data-mode': props.mode },
      React.createElement('h2', null, 'Report'),
      React.createElement('button', { type: 'button', onClick: props.onClose }, 'Close report'),
    );
  return { default: ReportPanel };
});

import { ReportOverlay, ReportSplit } from '../ReportPanelHost';
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, SPLIT_HANDLE_PX, useChatGeometry } from '../useChatGeometry';

function renderSplit(width = 360, maxWidth = 440) {
  const onResize = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ReportSplit width={width} maxWidth={maxWidth} onResize={onResize} onClose={onClose} conversationId="c-1" reportId="r-1" />,
  );
  return { ...view, onResize, onClose, separator: screen.getByRole('separator', { name: 'Resize report panel' }) };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReportSplit', () => {
  it('is a 9 px focusable separator with value attributes around a hairline', async () => {
    const { separator } = renderSplit();
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuemin', String(PANEL_MIN));
    expect(separator).toHaveAttribute('aria-valuemax', '440');
    expect(separator).toHaveAttribute('aria-valuenow', '360');
    expect(separator.style.width).toBe(`${SPLIT_HANDLE_PX}px`);
    expect(separator.querySelector('span')).toHaveClass('w-px');
    expect(await screen.findByTestId('report-panel')).toHaveAttribute('data-mode', 'split');
  });

  it('resizes from the keyboard in 16 px steps (Shift 32), Home/End and double-click, persisting each', () => {
    const { separator, onResize } = renderSplit();
    // The panel is on the right: moving the separator left widens it.
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(separator, { key: 'Home' });
    fireEvent.keyDown(separator, { key: 'End' });
    fireEvent.doubleClick(separator);
    expect(onResize.mock.calls).toEqual([
      [376, true],
      [328, true],
      [PANEL_MIN, true],
      [440, true],
      [PANEL_DEFAULT, true],
    ]);
    // Other keys are left alone.
    onResize.mockClear();
    fireEvent.keyDown(separator, { key: 'a' });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('drags with the pointer, clamps to the allowed range, and persists on release', () => {
    // jsdom has no PointerEvent: a MouseEvent carries button/clientX, plus the pointer id.
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const { separator, onResize } = renderSplit(360, 440);
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 960 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 700 });
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 700 });
    expect(onResize.mock.calls[0]).toEqual([400, false]);
    // Clamped to maxWidth while dragging.
    expect(onResize.mock.calls[1]).toEqual([440, false]);
    // Release persists the current width.
    expect(onResize.mock.calls.at(-1)).toEqual([360, true]);
  });
});

describe('ReportOverlay', () => {
  it('hosts the panel in a dialog that its own close button dismisses', async () => {
    const onOpenChange = vi.fn();
    render(<ReportOverlay open onOpenChange={onOpenChange} conversationId="c-1" reportId="r-1" />);
    const dialog = await screen.findByRole('dialog', { name: 'Report' });
    expect(await screen.findByTestId('report-panel')).toHaveAttribute('data-mode', 'overlay');
    // The Sheet's duplicate X is hidden in favour of the panel's own control.
    expect(dialog.className).toContain("[&>button[aria-label='Close']]:hidden");
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('useChatGeometry preferences', () => {
  it('persists the collapsed rail and the panel width per viewer', () => {
    const first = renderHook(() => useChatGeometry(false));
    act(() => first.result.current.setRailCollapsed(true));
    act(() => first.result.current.setPanelWidth(410, false));
    expect(window.localStorage.getItem('soc.chat.reportPanelWidth')).toBeNull();
    act(() => first.result.current.setPanelWidth(999, true));
    expect(window.localStorage.getItem('soc.chat.railCollapsed')).toBe('1');
    expect(window.localStorage.getItem('soc.chat.reportPanelWidth')).toBe(String(PANEL_MAX));
    first.unmount();

    const second = renderHook(() => useChatGeometry(false));
    expect(second.result.current.railCollapsed).toBe(true);
    expect(second.result.current.panelWidth).toBe(PANEL_MAX);
    act(() => second.result.current.setRailCollapsed(false));
    expect(window.localStorage.getItem('soc.chat.railCollapsed')).toBeNull();
  });

  it('works without storage (private mode, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useChatGeometry(true));
    expect(result.current.panelWidth).toBe(PANEL_DEFAULT);
    expect(result.current.railCollapsed).toBe(false);
    act(() => result.current.setPanelWidth(400, true));
    expect(result.current.panelWidth).toBe(400);
  });

  it('derives the zones from the measured frame width', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 900, height: 600 }));
    const { result } = renderHook(() => useChatGeometry(true));
    act(() => result.current.frameRef(document.createElement('div')));
    // 900 − 49 (strip) − 369 (panel + handle) < 640: the panel overlays.
    expect(result.current).toMatchObject({ frameWidth: 900, rail: 'strip', panel: 'overlay' });
  });
});
