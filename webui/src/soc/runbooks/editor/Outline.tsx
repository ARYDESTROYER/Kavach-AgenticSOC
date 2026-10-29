/**
 * The editor's outline (Round 14, SPEC §4.10.12, C11 A): "Runbook details", then each phase
 * with its steps, as an accessible tree (`role="tree"`, arrow keys, Enter selects). Steps
 * reorder by drag or by Alt+Up and Alt+Down, and focus stays on the moved step. "Add step"
 * (by kind) and "Add phase" are menus in the outline header, so the tree holds tree items
 * only; after one adds a step the editor moves focus to the new step, so the menu does not
 * take focus back. A step with problems carries a mark and the words "has problems" for
 * assistive technology. The selected item is marked by a bar and weight as well as a tint,
 * so it shows in forced colours too.
 *
 * Step titles are operator text and are rendered as plain text (#9).
 */
import * as React from 'react';
import { ChevronDown, CircleAlert, CirclePlus, FileText, GripVertical, Plus } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { PhaseId, RunbookDefinition, StepKind } from '@/lib/types-runbooks';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

import { KIND_ICON } from '../shared/chips';
import { KIND_HELP, KIND_LABEL, PHASE_LABEL, PHASE_ORDER, RUNBOOK_LIMITS, STEP_KINDS, countNoun } from '../shared/labels';

export const DETAILS_ID = '__details__';

/**
 * The selected item: a tint, a 2px bar at its start and medium weight, so the selection
 * never rests on colour alone; in forced colours (where the tint and bar are dropped) it
 * keeps an outline.
 */
const SELECTED =
  'bg-primary/10 font-medium text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))] forced-colors:outline forced-colors:outline-1';

export interface OutlineProps {
  defn: RunbookDefinition;
  selected: string;
  onSelect: (id: string) => void;
  readOnly: boolean;
  /** Step ids that hold a shown problem; the details item uses {@link DETAILS_ID}. */
  problems: ReadonlySet<string>;
  onAddStep?: (kind: StepKind) => void;
  onAddPhase?: (phase: PhaseId) => void;
  onMove?: (stepId: string, direction: -1 | 1) => void;
  onDrop?: (stepId: string, beforeId: string | null, phase: PhaseId) => void;
  /**
   * Called once the Add step or Add phase menu has closed after a choice (the menu then does
   * not take focus back), so the editor can move focus to the new step. A menu keeps focus
   * trapped until it has fully closed, so focus can only move from here.
   */
  onAddedMenuClosed?: () => void;
  className?: string;
}

interface Row {
  key: string;
  kind: 'details' | 'phase' | 'step';
  level: 1 | 2;
  phase?: PhaseId;
}

export function Outline({
  defn,
  selected,
  onSelect,
  readOnly,
  problems,
  onAddStep,
  onAddPhase,
  onMove,
  onDrop,
  onAddedMenuClosed,
  className,
}: OutlineProps) {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<PhaseId>>(new Set());
  const [focusKey, setFocusKey] = React.useState<string>(selected);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  const itemRefs = React.useRef(new Map<string, HTMLElement>());
  const pendingFocus = React.useRef<string | null>(null);
  // An Add step or Add phase choice hands focus to the new step (the editor moves it), so the
  // menu must not return focus to its trigger as it closes.
  const added = React.useRef(false);
  const keepFocusAway = (event: Event) => {
    if (!added.current) return;
    added.current = false;
    event.preventDefault();
    onAddedMenuClosed?.();
  };

  const rows: Row[] = React.useMemo(() => {
    const out: Row[] = [{ key: DETAILS_ID, kind: 'details', level: 1 }];
    for (const phase of defn.phases) {
      out.push({ key: `phase:${phase}`, kind: 'phase', level: 1, phase });
      if (!collapsed.has(phase)) {
        for (const step of defn.steps.filter((s) => s.phase === phase)) {
          out.push({ key: step.id, kind: 'step', level: 2, phase });
        }
      }
    }
    return out;
  }, [defn.phases, defn.steps, collapsed]);

  // Keep the roving tab stop on an item that exists.
  const activeKey = rows.some((r) => r.key === focusKey) ? focusKey : rows.some((r) => r.key === selected) ? selected : DETAILS_ID;

  React.useEffect(() => {
    if (pendingFocus.current) {
      const el = itemRefs.current.get(pendingFocus.current);
      pendingFocus.current = null;
      el?.focus();
    }
  });

  const focusRow = (key: string) => {
    setFocusKey(key);
    itemRefs.current.get(key)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, row: Row) => {
    const index = rows.findIndex((r) => r.key === row.key);
    if (event.altKey && row.kind === 'step' && !readOnly && onMove && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      pendingFocus.current = row.key;
      setFocusKey(row.key);
      onMove(row.key, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (index < rows.length - 1) focusRow(rows[index + 1].key);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (index > 0) focusRow(rows[index - 1].key);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(rows[0].key);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows[rows.length - 1].key);
        break;
      case 'ArrowRight':
        if (row.kind === 'phase' && row.phase) {
          event.preventDefault();
          if (collapsed.has(row.phase)) {
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(row.phase as PhaseId);
              return next;
            });
          } else if (rows[index + 1]?.kind === 'step') {
            focusRow(rows[index + 1].key);
          }
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.kind === 'step' && row.phase) focusRow(`phase:${row.phase}`);
        else if (row.kind === 'phase' && row.phase && !collapsed.has(row.phase)) {
          setCollapsed((prev) => new Set(prev).add(row.phase as PhaseId));
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(row);
        break;
      default:
        break;
    }
  };

  const toggle = (phase: PhaseId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });

  const activate = (row: Row) => {
    setFocusKey(row.key);
    if (row.kind === 'phase') {
      if (row.phase) toggle(row.phase);
      return;
    }
    onSelect(row.key);
  };

  const usedPhases = new Set(defn.phases);
  const freePhases = PHASE_ORDER.filter((p) => !usedPhases.has(p));
  const full = defn.steps.length >= RUNBOOK_LIMITS.steps;

  const register = (key: string) => (el: HTMLElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  };

  const dragProps = (row: Row) => {
    if (readOnly || !onDrop) return {};
    const target = row.kind === 'step' ? row.key : row.kind === 'phase' ? `phase:${row.phase}` : null;
    // A step sits inside its phase item, so a step stops its drag events there: one drop is
    // one move (before that step), never a second one to the end of the phase.
    const own = (e: React.DragEvent) => {
      if (row.kind === 'step') e.stopPropagation();
    };
    return {
      onDragOver: (e: React.DragEvent) => {
        own(e);
        if (!dragging || !target || target === dragging) return;
        e.preventDefault();
        setDropTarget(target);
      },
      onDragLeave: (e: React.DragEvent) => {
        own(e);
        setDropTarget((t) => (t === target ? null : t));
      },
      onDrop: (e: React.DragEvent) => {
        own(e);
        e.preventDefault();
        const id = dragging;
        setDragging(null);
        setDropTarget(null);
        if (!id || !row.phase) return;
        pendingFocus.current = id;
        setFocusKey(id);
        // Dropped on a phase: the end of that phase; on a step: just before it.
        onDrop(id, row.kind === 'step' ? row.key : null, row.phase);
      },
    };
  };

  return (
    <nav aria-label="Runbook outline" className={cn('surface-panel min-w-0 p-2', className)} data-runbook-outline="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1 pt-1.5">
        <h2 className="text-sm font-semibold text-foreground">Outline</h2>
        <span className="text-sm tabular-nums text-muted-foreground">
          {countNoun(defn.phases.length, 'phase')} · {countNoun(defn.steps.length, 'step')}
        </span>
        {!readOnly && onAddStep ? (
          <div className="ml-auto flex items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="h-8 px-2" disabled={full}>
                  <Plus aria-hidden />
                  Add step
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72" onCloseAutoFocus={keepFocusAway}>
                <DropdownMenuLabel>Step kind</DropdownMenuLabel>
                {STEP_KINDS.map((kind) => {
                  const Icon = KIND_ICON[kind];
                  return (
                    <DropdownMenuItem
                      key={kind}
                      className="items-start"
                      onSelect={() => {
                        added.current = true;
                        onAddStep(kind);
                      }}
                    >
                      <Icon className="mt-0.5 h-4 w-4" aria-hidden />
                      <span>
                        <span className="block font-medium">{KIND_LABEL[kind]}</span>
                        <span className="block text-xs text-muted-foreground">{KIND_HELP[kind]}</span>
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {onAddPhase && freePhases.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2" disabled={full}>
                    <CirclePlus aria-hidden />
                    Add phase
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={keepFocusAway}>
                  <DropdownMenuLabel>Phase</DropdownMenuLabel>
                  {freePhases.map((phase) => (
                    <DropdownMenuItem
                      key={phase}
                      onSelect={() => {
                        added.current = true;
                        onAddPhase(phase);
                      }}
                    >
                      {PHASE_LABEL[phase]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </div>
      {!readOnly && onMove ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">Drag a step, or press Alt with the arrow keys, to move it.</p>
      ) : null}
      <div role="tree" aria-label="Phases and steps" className="mt-1 space-y-0.5">
        <div
          role="treeitem"
          aria-level={1}
          aria-selected={selected === DETAILS_ID}
          tabIndex={activeKey === DETAILS_ID ? 0 : -1}
          ref={register(DETAILS_ID)}
          onKeyDown={(e) => onKeyDown(e, rows[0])}
          onClick={() => activate(rows[0])}
          onFocus={() => setFocusKey(DETAILS_ID)}
          data-outline-item="details"
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selected === DETAILS_ID ? SELECTED : 'text-secondary-foreground hover:bg-muted',
          )}
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">Runbook details</span>
          {problems.has(DETAILS_ID) ? <ProblemMark /> : null}
        </div>
        {defn.phases.map((phase) => {
          const steps = defn.steps.filter((s) => s.phase === phase);
          const phaseKey = `phase:${phase}`;
          const phaseRow: Row = { key: phaseKey, kind: 'phase', level: 1, phase };
          const isCollapsed = collapsed.has(phase);
          return (
            <div
              key={phase}
              role="treeitem"
              aria-level={1}
              aria-expanded={!isCollapsed}
              aria-selected={false}
              aria-label={`${PHASE_LABEL[phase]}, ${countNoun(steps.length, 'step')}`}
              tabIndex={activeKey === phaseKey ? 0 : -1}
              ref={register(phaseKey)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget) onKeyDown(e, phaseRow);
              }}
              onFocus={(e) => {
                if (e.target === e.currentTarget) setFocusKey(phaseKey);
              }}
              onClick={() => {
                setFocusKey(phaseKey);
                toggle(phase);
              }}
              // The focus ring goes on the phase's own header row, not around the phase and
              // all of its steps, so it is clear which item has focus.
              className="cursor-pointer rounded-sm outline-none [&:focus-visible>div:first-child]:ring-2 [&:focus-visible>div:first-child]:ring-ring"
              data-outline-phase={phase}
              {...dragProps(phaseRow)}
            >
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-sm px-2 pb-1 pt-2',
                  dropTarget === phaseKey && 'bg-primary/10',
                )}
              >
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                    isCollapsed && '-rotate-90',
                  )}
                />
                <span className="text-sm font-semibold text-foreground">{PHASE_LABEL[phase]}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{steps.length.toLocaleString()}</span>
              </div>
              {isCollapsed ? null : (
                <div role="group" className="space-y-0.5">
                  {steps.map((step) => {
                    const Icon = KIND_ICON[step.kind];
                    const number = defn.steps.findIndex((s) => s.id === step.id) + 1;
                    const isSelected = selected === step.id;
                    const stepRow: Row = { key: step.id, kind: 'step', level: 2, phase };
                    const hasProblem = problems.has(step.id);
                    return (
                      <div
                        key={step.id}
                        role="treeitem"
                        aria-level={2}
                        aria-selected={isSelected}
                        tabIndex={activeKey === step.id ? 0 : -1}
                        ref={register(step.id)}
                        draggable={!readOnly && !!onDrop}
                        onDragStart={(e) => {
                          setDragging(step.id);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', step.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          onKeyDown(e, stepRow);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          activate(stepRow);
                        }}
                        onFocus={(e) => {
                          e.stopPropagation();
                          setFocusKey(step.id);
                        }}
                        data-outline-step={step.id}
                        className={cn(
                          'group flex cursor-pointer items-start gap-1.5 rounded-sm px-1 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isSelected ? SELECTED : 'text-secondary-foreground hover:bg-muted',
                          dropTarget === step.id && 'shadow-[inset_0_2px_0_0_hsl(var(--primary))]',
                          dragging === step.id && 'opacity-60',
                        )}
                        {...dragProps(stepRow)}
                      >
                        {readOnly ? (
                          <span className="w-3.5 shrink-0" aria-hidden />
                        ) : (
                          <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                        )}
                        <Icon
                          className={cn('mt-0.5 size-3.5 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
                          <span className="tabular-nums text-muted-foreground">{number} </span>
                          {step.title.trim() ? step.title : <span className="italic text-muted-foreground">Untitled step</span>}
                          <span className="sr-only">, {KIND_LABEL[step.kind]}</span>
                          {step.required ? null : <span className="ml-1.5 text-xs text-muted-foreground">Optional</span>}
                        </span>
                        {hasProblem ? <ProblemMark /> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function ProblemMark() {
  return (
    <span className="inline-flex shrink-0 items-center text-critical-text" data-outline-problem="">
      <CircleAlert className="mt-0.5 size-3.5" aria-hidden />
      <span className="sr-only">, has problems</span>
    </span>
  );
}
