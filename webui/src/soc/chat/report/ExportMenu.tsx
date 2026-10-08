/**
 * The report Export menu items (chat revamp SPEC §9.3, §10.6): Markdown, HTML,
 * Print / Save as PDF, CSV (all tables) and JSON, plus the "Defang indicators" toggle.
 *
 * Defanging is ON by default for the human formats (Markdown, HTML, Print) and never
 * applies to CSV or JSON (machine formats round-trip exactly). The choice is a per-viewer
 * convenience remembered in localStorage (best effort; every access is guarded).
 *
 * Rendered inside a `DropdownMenuContent` or a `DropdownMenuSubContent` by the host, so
 * the panel's ⋯ menu ("Export ▸") and the library's Export button share one list.
 */
import * as React from 'react';
import { Braces, FileCode2, FileText, Printer, Table2 } from 'lucide-react';

import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';

import type { ReportExportFormat } from './export/run';

const DEFANG_KEY = 'soc.report.defang';

function readDefang(): boolean {
  try {
    return window.localStorage.getItem(DEFANG_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeDefang(on: boolean): void {
  try {
    window.localStorage.setItem(DEFANG_KEY, on ? 'on' : 'off');
  } catch {
    /* a private window or blocked storage: the default (on) applies next time */
  }
}

/** The viewer's defang preference (default on). */
export function useDefangPreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = React.useState<boolean>(() => readDefang());
  const set = React.useCallback((next: boolean) => {
    setOn(next);
    writeDefang(next);
  }, []);
  return [on, set];
}

const FORMATS: Array<{ format: ReportExportFormat; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { format: 'markdown', label: 'Markdown (.md)', icon: FileText },
  { format: 'html', label: 'HTML (.html)', icon: FileCode2 },
  { format: 'print', label: 'Print / Save as PDF', icon: Printer },
  { format: 'csv', label: 'CSV (all tables)', icon: Table2 },
  { format: 'json', label: 'JSON', icon: Braces },
];

export interface ExportMenuItemsProps {
  onExport: (format: ReportExportFormat, defang: boolean) => void;
  defang: boolean;
  onDefangChange: (on: boolean) => void;
  /** Formats to offer (default all). */
  formats?: readonly ReportExportFormat[];
  disabled?: boolean;
}

/** The format items and the defang toggle. */
export function ExportMenuItems({ onExport, defang, onDefangChange, formats, disabled = false }: ExportMenuItemsProps) {
  const offered = formats ? FORMATS.filter((f) => formats.includes(f.format)) : FORMATS;
  return (
    <>
      {offered.map(({ format, label, icon: Icon }) => (
        <DropdownMenuItem key={format} disabled={disabled} onSelect={() => onExport(format, defang)}>
          <Icon className="size-3.5" aria-hidden />
          {label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={defang}
        onCheckedChange={(c) => onDefangChange(c === true)}
        // Keep the menu open so the toggle reads as a setting, not an action.
        onSelect={(e) => e.preventDefault()}
      >
        Defang indicators (Markdown, HTML, Print)
      </DropdownMenuCheckboxItem>
    </>
  );
}
