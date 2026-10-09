/**
 * ReportPanelHost — the third zone (chat revamp SPEC §10.1, §10.6, §10.9).
 *
 * Hosts the reports package's lazy `ReportPanel` either as a docked split column with
 * a resizable separator (the Case Manager split idiom: a 9 px transparent handle around
 * a centred 1 px hairline, `role="separator"` with value attributes, ←/→ in 16 px
 * steps, Shift for 32 px, Home/End, double-click to reset, pointer drag; the width
 * persists per viewer) or, when the conversation
 * would drop below 640 px, as an overlay Sheet that moves focus to the panel heading
 * and returns it on close. Split mode never moves focus.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { LoadingState } from '@/design-system/loading';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { PANEL_DEFAULT, PANEL_MIN, SPLIT_HANDLE_PX } from './useChatGeometry';
import { useOpenerFocus } from './useOpenerFocus';

const ReportPanel = React.lazy(() => import('../report/ReportPanel'));

const KEY_STEP = 16;

interface PanelSource {
  conversationId: string | null;
  reportId: string | null;
  onCountChange?: (count: number) => void;
}

function PanelFallback() {
  return <LoadingState layout="panel" label="Loading report" className="h-full" />;
}

export interface ReportSplitProps extends PanelSource {
  width: number;
  /** The widest the panel may grow while the conversation keeps 640 px. */
  maxWidth: number;
  onResize: (width: number, persist: boolean) => void;
  onClose: () => void;
}

/** The docked split: separator + panel column. */
export function ReportSplit({ width, maxWidth, onResize, onClose, conversationId, reportId, onCountChange }: ReportSplitProps) {
  const dragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const widthRef = React.useRef(width);
  widthRef.current = width;
  const [dragging, setDragging] = React.useState(false);
  const max = Math.max(PANEL_MIN, Math.round(maxWidth));
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(PANEL_MIN, value)));

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? KEY_STEP * 2 : KEY_STEP;
    let next: number | null = null;
    // The panel sits on the right: moving the separator left widens it.
    if (event.key === 'ArrowLeft') next = width + step;
    if (event.key === 'ArrowRight') next = width - step;
    if (event.key === 'Home') next = PANEL_MIN;
    if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    onResize(clamp(next), true);
  };

  return (
    <>
      {/* ARIA's focusable separator is a value widget (aria-valuenow + arrow keys);
          jsx-a11y classifies the role as static despite that spec. */}
      {/* eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role */}
      <button type="button" role="separator"
        aria-label="Resize report panel"
        aria-orientation="vertical"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={max}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        title="Drag to resize the report. Use Left and Right arrow keys for precise adjustment."
        data-testid="report-panel-divider"
        onKeyDown={onKeyDown}
        onDoubleClick={() => onResize(clamp(PANEL_DEFAULT), true)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: widthRef.current };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          onResize(clamp(drag.startWidth - (event.clientX - drag.startX)), false);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          setDragging(false);
          onResize(widthRef.current, true);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        // The handle is the hit target (9 px, the Case Manager split); only the centred
        // hairline is drawn.
        style={{ width: SPLIT_HANDLE_PX }}
        className="group relative flex h-full shrink-0 cursor-col-resize touch-none items-stretch justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          className={cn(
            'h-full w-px bg-border transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary motion-reduce:transition-none',
            dragging && 'w-0.5 bg-primary',
          )}
          aria-hidden
        />
      </button>
      <aside className={cn('flex min-h-0 shrink-0 flex-col', dragging && 'select-none')} style={{ width }} aria-label="Report">
        <React.Suspense fallback={<PanelFallback />}>
          <ReportPanel
            mode="split"
            conversationId={conversationId}
            reportId={reportId}
            onClose={onClose}
            onCountChange={onCountChange}
          />
        </React.Suspense>
      </aside>
    </>
  );
}

export interface ReportOverlayProps extends PanelSource {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The overlay Sheet: focus moves to the panel heading and returns to the control that
 * opened it on close (SPEC §10.9). The Sheet has no Radix trigger (it opens from the
 * toolbar), so the opener is recorded here rather than left to Radix (→ `<body>`).
 */
export function ReportOverlay({ open, onOpenChange, conversationId, reportId, onCountChange }: ReportOverlayProps) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const opener = useOpenerFocus();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={contentRef}
        side="right"
        size="default"
        // The panel has its own close control; hide the Sheet's duplicate X.
        className="gap-0 p-0 [&>button[aria-label='Close']]:hidden"
        onOpenAutoFocus={(event) => {
          opener.capture();
          // Not the first button: the panel moves focus to its own heading once it has
          // loaded (SPEC §10.9); until then the dialog itself holds focus.
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={opener.restore}
      >
        <SheetTitle className="sr-only">Report</SheetTitle>
        <SheetDescription className="sr-only">This conversation's report: its items, notes and summary.</SheetDescription>
        <React.Suspense fallback={<PanelFallback />}>
          <ReportPanel
            mode="overlay"
            conversationId={conversationId}
            reportId={reportId}
            onClose={() => onOpenChange(false)}
            onCountChange={onCountChange}
          />
        </React.Suspense>
      </SheetContent>
    </Sheet>
  );
}
