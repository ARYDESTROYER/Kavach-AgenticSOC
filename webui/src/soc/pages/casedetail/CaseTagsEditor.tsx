/**
 * CaseTagsEditor: the case's tags and their one editor (Round 15, SPEC D8.2 and D8.4).
 *
 * Tags live in the facts rail now, not on the header's meta row. The section lists the
 * tags as quiet outline chips; a viewer who holds `cases:write` gets an "Edit tags"
 * control that opens a popover with the editor: each tag with its Remove button, a field
 * to add one, and the same refusal rules as before (a tag over the limit is refused as it
 * is typed, never cut; the text stays in the field until the save lands; a full case says
 * so instead of letting Add fail).
 *
 * The popover is controlled by the case workspace so the T shortcut and the "Edit tags"
 * item in Take action can open it, in the rail column or in the Details sheet.
 *
 * SECURITY (#9): tag values are untrusted text, rendered as plain text nodes only.
 * #3: a tag change is the existing `POST /api/cases/{id}/tags`; it never changes status,
 * verdict or disposition.
 */
import * as React from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { CASE_TAG_MAX_COUNT, caseTagError } from '@/lib/tags';
import type { Case } from '@/lib/types';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

import { caseTags } from './caseFacts';

export interface CaseTagsEditorProps {
  c: Case;
  /** The viewer holds `cases:write` and the case on screen is the current one. */
  canTag: boolean;
  /** The authoritative case after a save (queue and detail sync). */
  onCaseChange: (next: Case) => void;
  /** Controlled popover (the T shortcut and Take action open it). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CaseTagsEditor: React.FC<CaseTagsEditorProps> = ({ c, canTag, onCaseChange, open, onOpenChange }) => {
  const tags = caseTags(c);
  const [tagDraft, setTagDraft] = React.useState('');
  const [savingTags, setSavingTags] = React.useState(false);

  const saveTags = React.useCallback(
    async (next: string[]): Promise<boolean> => {
      setSavingTags(true);
      try {
        onCaseChange(await api.caseTags(c.case_id, next));
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save the tags.');
        return false;
      } finally {
        setSavingTags(false);
      }
    },
    [c.case_id, onCaseChange],
  );
  // A tag over the limit is refused here, as it is typed, never cut to fit.
  const tagDraftError = caseTagError(tagDraft);
  const tagErrorId = React.useId();
  // A case holds at most CASE_TAG_MAX_COUNT tags (the server refuses more): at the cap the
  // field says so instead of letting an Add fail.
  const tagsFull = tags.length >= CASE_TAG_MAX_COUNT;
  const tagsFullId = React.useId();

  return (
    <div className="space-y-2" data-testid="case-detail-tags">
      {tags.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag} className="min-w-0 max-w-full">
              <Badge variant="outline" className="max-w-full font-normal">
                <span className="truncate" title={tag}>
                  {tag}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No tags</p>
      )}
      {canTag ? (
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              aria-keyshortcuts="T"
            >
              {tags.length ? <Pencil className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
              {tags.length ? 'Edit tags' : 'Add a tag'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-3">
            <p className="text-sm font-semibold text-foreground">Tags</p>
            {tags.length ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Case tags">
                {tags.map((tag) => (
                  <li key={tag}>
                    <Badge variant="secondary" className="gap-1 pr-0.5">
                      <span className="max-w-[12rem] truncate">{tag}</span>
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        disabled={savingTags}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void saveTags(tags.filter((t) => t !== tag))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No tags yet.</p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = tagDraft.trim();
                if (!value || tagDraftError || tagsFull) return;
                if (tags.includes(value)) {
                  setTagDraft('');
                  return;
                }
                // The text stays in the field until the save lands, so a refused save
                // never loses what was typed.
                void saveTags([...tags, value]).then((saved) => {
                  if (saved) setTagDraft('');
                });
              }}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  placeholder={tagsFull ? undefined : 'Add a tag'}
                  aria-label="New tag"
                  aria-invalid={tagDraftError ? true : undefined}
                  aria-describedby={
                    [tagDraftError ? tagErrorId : null, tagsFull ? tagsFullId : null].filter(Boolean).join(' ') ||
                    undefined
                  }
                  disabled={tagsFull && !tagDraft}
                  className="h-8"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={!tagDraft.trim() || Boolean(tagDraftError) || tagsFull || savingTags}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add
                </Button>
              </div>
              {tagDraftError ? (
                <p id={tagErrorId} role="alert" className="mt-1.5 text-xs font-medium text-critical-text">
                  {tagDraftError}
                </p>
              ) : null}
              {tagsFull ? (
                <p id={tagsFullId} className="mt-1.5 text-xs text-muted-foreground">
                  A case can hold up to {CASE_TAG_MAX_COUNT} tags, and this one has {tags.length}. Remove one to add
                  another.
                </p>
              ) : null}
            </form>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
};

export default CaseTagsEditor;
