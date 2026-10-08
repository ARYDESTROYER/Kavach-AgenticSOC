/**
 * ShortcutSheet — the Ctrl/Cmd+/ keyboard shortcut reference (SPEC §10.4a).
 *
 * INTERFACE STUB (orchestrator). WP-I2b owns and replaces the body; keep the props.
 */
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

export interface ShortcutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}
