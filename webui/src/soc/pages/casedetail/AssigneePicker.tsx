/**
 * AssigneePicker: the case owner picker, rendered in the header's owner popover, the
 * owner's one editable home (Round 15, SPEC D8.2). It moved here from the Collaboration
 * tab, which no longer has an owner picker (D8.3).
 *
 * SECURITY (#9): the assignee string and user names are UNTRUSTED, rendered as plain
 * text. #3-safe: assigning never changes the case decision.
 */
import * as React from 'react';
import { LoaderCircle, Save } from 'lucide-react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';

import { Input } from '@/ui/input';
import { Button } from '@/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/ui/select';

import type { PickableUser } from '@/soc/pages/CaseDetail.api';

/**
 * The Radix Select value for an assignee picker. Binds to the ACTUAL assignee so the
 * trigger reflects it instead of a false "Unassigned": the known user's CANONICAL
 * username (so it matches a SelectItem exactly even when the stored value differs in
 * case), else the free-text value (rendered as a selectable item), else the
 * "__unassigned__" sentinel when there is no assignee.
 */
export function assigneeSelectValue(current: string, users: PickableUser[]): string {
  const trimmed = (current || '').trim();
  if (!trimmed) return '__unassigned__';
  const matched = users.find((u) => u.username.toLowerCase() === trimmed.toLowerCase());
  return matched?.username ?? trimmed;
}

/** An assignee picker over the known users (with a free-text fallback when the user
 *  store is empty / auth is off). Saves via api.caseAssign + bubbles the updated case
 *  through `onAssigned`. The assignee string is UNTRUSTED → rendered plain. */
export const AssigneePicker: React.FC<{
  c: Case;
  users: PickableUser[];
  canWrite: boolean;
  onAssigned: (next: Case) => void;
}> = ({ c, users, canWrite, onAssigned }) => {
  const current = (c.assignee || '').trim();
  const [free, setFree] = React.useState(current);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setFree(c.assignee || ''), [c.assignee]);

  const save = React.useCallback(
    async (value: string) => {
      setSaving(true);
      try {
        const next = await api.caseAssign(c.case_id, value.trim());
        onAssigned(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save the assignee.');
      } finally {
        setSaving(false);
      }
    },
    [c.case_id, onAssigned],
  );

  // When we have a user list, use a Select; otherwise a free-text input + Save.
  if (users.length) {
    const known = users.some((u) => u.username.toLowerCase() === current.toLowerCase());
    const selectValue = assigneeSelectValue(current, users);
    return (
      <div className="flex items-center gap-2">
        <Select
          value={selectValue}
          disabled={!canWrite || saving}
          onValueChange={(v) => void save(v === '__unassigned__' ? '' : v)}
        >
          <SelectTrigger className="h-9 w-full" aria-label="Assignee">
            <SelectValue placeholder="Unassigned" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unassigned__">Unassigned</SelectItem>
            {/* If the current assignee is a free-text id not in the user list, keep it
                selectable so it isn't silently lost. UNTRUSTED → plain text. */}
            {current && !known ? <SelectItem value={current}>{current}</SelectItem> : null}
            {users.map((u) => (
              <SelectItem key={u.username} value={u.username}>
                {/* UNTRUSTED username: plain text. */}
                {u.username}
                {u.role ? ` · ${u.role}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving ? (
          <LoaderCircle
            className="h-4 w-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
            role="status"
            aria-label="Saving the assignee"
          />
        ) : null}
      </div>
    );
  }

  const dirty = free.trim() !== current;
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Unassigned. Type to assign…"
        value={free}
        disabled={!canWrite}
        onChange={(e) => setFree(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty) void save(free);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!canWrite || !dirty || saving}
        onClick={() => void save(free)}
      >
        {saving ? (
          <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Save className="h-4 w-4" aria-hidden />
        )}
        Save
      </Button>
    </div>
  );
};

export default AssigneePicker;
