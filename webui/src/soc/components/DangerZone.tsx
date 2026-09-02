/**
 * DangerZone — tiered platform-reset controls (Round 4, Wave 5, request #7).
 *
 * Three INDEPENDENT, escalating "GitHub danger-zone" cards, each with its own
 * type-to-confirm dialog:
 *
 *   1. Reset cases & logs        (type `RESET CASES`)   — keeps sources/secrets/settings
 *   2. Reset sources + logs      (type `RESET SOURCES`) — also drops sources + cursors
 *   3. Factory reset             (type `FACTORY RESET`) — wipes state → restarts into OOBE
 *
 * The whole surface is gated behind `<Can resource="users" action="manage">` (the
 * `super_admin`/admin grant that mirrors the backend `require_admin` on
 * `POST /api/jobs` with kind `tiered_reset`). The server ALSO enforces a step-up /
 * fresh-auth window;
 * a 401 `reauth_required` from the reset call transparently pops the globally
 * registered `ReauthDialog` and retries once (see `DangerZone.api.ts`).
 *
 * SAFETY grammar:
 *   - The destructive button ARMS only when the operator has typed the EXACT
 *     per-scope phrase (trimmed byte-match) — belt-and-braces over the server's own
 *     confirm validation, so a fat-fingered scope can never wipe more than typed.
 *   - Each card spells out, in plain copy, WHAT CLEARS and WHAT IS KEPT — and every
 *     tier keeps env-provided secrets (enforced server-side, §6.6).
 *   - On success the dialog shows a receipt of exactly what was cleared.
 *
 * SECURITY (#9): the server `cleared[]` receipt is rendered as plain, escaped React
 * text (never markup). Nothing here implies the reset runs `decide()` (#3) or touches
 * the read-only log key (#1) — it only destroys the suite's OWN mgmt state.
 *
 * INTEGRATOR NOTE: mount `<DangerZone />` in Settings → Experimental / Organization,
 * super_admin-gated. It self-gates with `<Can>` (renders nothing without the grant),
 * so a bare mount is safe; the enclosing section header/RBAC filter still applies.
 */
import * as React from 'react';
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/ui/dialog';
import { Can } from './Can';
import { cn } from '@/lib/cn';
import {
  RESET_CONFIRM_PHRASE,
  type ResetScope,
} from '@/soc/DangerZone.api';
import { ApiError } from '@/lib/api';
import { SectionTitle } from '@/soc/pages/settings/primitives';
import { api } from '@/lib/api';
import { useNavigateOptional } from '@/soc/router';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';

/* --------------------------------------------------------------- copy ------- */

interface TierCopy {
  scope: ResetScope;
  /** The card title / CTA label. */
  title: string;
  /** One-line card description. */
  summary: string;
  /** What this tier CLEARS (plain-text bullets). */
  clears: string[];
  /** What this tier KEEPS (plain-text bullets). */
  keeps: string[];
  /** Extra consequence warning shown in the confirm dialog (optional). */
  caution?: string;
}

/**
 * The three tiers, authored verbatim from the backend reset contract
 * (`routes_reset.py` / `engine/reset.py` / PROPOSAL §6.6). Kept as data so each card
 * renders identically and the confirm dialog can reuse the same copy.
 */
const TIERS: TierCopy[] = [
  {
    scope: 'cases',
    title: 'Reset cases & logs',
    summary: 'Clear every case and its working data, keeping your sources and settings.',
    clears: [
      'All cases, campaigns and baselines',
      'Per-case collaboration, ordinary inbox items and activity',
      'Frozen replay fixtures and the raw records they hold',
      'LLM Batch records and live-tail log buffers',
    ],
    keeps: [
      'Sources',
      'Secrets',
      'Users and settings',
      'Knowledge base (RAG)',
      'Durable application Jobs and their Inbox progress',
    ],
  },
  {
    scope: 'sources',
    title: 'Reset sources + logs',
    summary: 'Everything above, plus remove all configured sources and their polling cursors.',
    clears: [
      'Everything in “Reset cases & logs”',
      'All configured sources',
      'Polling cursors and per-source connector secrets',
    ],
    keeps: [
      'Global secrets (env)',
      'Users and settings',
      'First-run setup',
      'Durable application Jobs and their Inbox progress',
    ],
    caution:
      'After this, no sources are connected — you will need to re-add them from the wizard or Sources page.',
  },
  {
    scope: 'factory',
    title: 'Factory reset',
    summary: 'Wipe all suite state and restart into first-run setup (OOBE).',
    clears: [
      'All state (cases, sources, users, settings, branding)',
      'Personalisation, historical Jobs, personal Inbox and export artifacts',
      'LLM Batch records and the previous audit log',
      'The setup flag → the app restarts into the first-run wizard',
    ],
    keeps: [
      'Environment-provided secrets (ES / LLM keys, database URL)',
      'One identity-free operational reset receipt in the new audit lineage',
    ],
    caution:
      'This signs everyone out and restarts the suite into first-run setup (OOBE). Personal Inbox history is erased; a minimal system receipt records only the reset outcome. Environment secrets remain so you can immediately create the admin account. This cannot be undone.',
  },
];

/* --------------------------------------------------- confirm dialog --------- */

interface ResetDialogProps {
  tier: TierCopy | null;
  onClose: () => void;
  onAccepted: () => void;
}

/**
 * A single, reusable type-to-confirm dialog. The confirm button arms ONLY when the
 * trimmed input byte-matches the tier's phrase; the phrase itself is echoed as an
 * `<InlineCode>`-style token so the operator can see exactly what to type.
 */
function ResetDialog({ tier, onClose, onAccepted }: ResetDialogProps) {
  const navigate = useNavigateOptional();
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset the field whenever the target tier changes (open/switch).
  React.useEffect(() => {
    setValue('');
    setBusy(false);
    setError(null);
    jobSubmissionIntentRef.current = null;
  }, [tier?.scope]);

  if (!tier) return null;

  const phrase = RESET_CONFIRM_PHRASE[tier.scope];
  // Arm only on the EXACT (trimmed) phrase — the same byte-match the server enforces.
  const armed = value.trim() === phrase && !busy;

  const submit = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      const params = { scope: tier.scope, confirm: value.trim() };
      const intent = retainJobSubmissionIntent(
        jobSubmissionIntentRef.current,
        'tiered_reset',
        params,
      );
      jobSubmissionIntentRef.current = intent;
      const job = await api.jobs.submit({
        kind: 'tiered_reset',
        idempotency_key: intent.idempotencyKey,
        params,
      });
      jobSubmissionIntentRef.current = null;
      announceJobAccepted(job);
      onAccepted();
      if (tier.scope === 'factory') {
        toast.success('Factory reset job accepted.', {
          description:
            'The server will quiesce work, clear personal state and retain only a sanitized system receipt.',
        });
      } else {
        toast.success(`${tier.title} job accepted.`, {
          description:
            'The destructive operation runs server-side and its durable outcome remains in Inbox.',
          action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
        });
      }
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError) {
        // A cancelled step-up re-auth surfaces the original 401 here.
        setError(
          e.status === 401
            ? 'Re-authentication was required and not completed. Nothing was cleared.'
            : e.message || 'Reset job submission failed.',
        );
      } else {
        setError(e instanceof Error ? e.message : 'Reset job submission failed.');
      }
    }
  };

  const onOpenChange = (next: boolean) => {
    if (!next && !busy) onClose();
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-critical">
            <AlertTriangle className="h-5 w-5" aria-hidden />
            {tier.title}
          </DialogTitle>
          <DialogDescription>{tier.summary}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <ConsequenceList heading="This clears" tone="danger" items={tier.clears} />
            <ConsequenceList heading="This keeps" tone="ok" items={tier.keeps} />
          </div>

          {tier.caution ? (
            <Alert variant="warning">
              <ShieldAlert className="h-4 w-4" aria-hidden />
              <AlertDescription>{tier.caution}</AlertDescription>
            </Alert>
          ) : null}

          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor="danger-confirm">
              Type{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {phrase}
              </code>{' '}
              to confirm
            </Label>
            <Input
              id="danger-confirm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={phrase}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
              autoFocus
            />
          </form>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void submit()} disabled={!armed}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {tier.title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------ small parts --------- */

function ConsequenceList({
  heading,
  tone,
  items,
}: {
  heading: string;
  tone: 'danger' | 'ok';
  items: string[];
}) {
  return (
    <div>
      <p
        className={cn(
          'mb-1.5 text-xs font-semibold uppercase tracking-wide',
          tone === 'danger' ? 'text-critical' : 'text-muted-foreground',
        )}
      >
        {heading}
      </p>
      <ul className="space-y-1 text-xs text-foreground">
        {items.map((it, i) => (
          <li key={`${it}-${i}`} className="flex gap-1.5">
            <span
              aria-hidden
              className={cn(
                'mt-1 inline-block h-1 w-1 shrink-0 rounded-full',
                tone === 'danger' ? 'bg-critical' : 'bg-success',
              )}
            />
            <span className="break-words">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------- the surface ------- */

export interface DangerZoneProps {
  /** Optional className for the outer wrapper (spacing in the host section). */
  className?: string;
}

/**
 * The danger-zone surface: three escalating reset tiers. Self-gated behind the
 * `users:manage` (admin / super_admin) grant — renders nothing without it.
 */
export function DangerZone({ className }: DangerZoneProps) {
  const [pending, setPending] = React.useState<TierCopy | null>(null);

  return (
    <Can resource="users" action="manage">
      <div className={cn('space-y-6', className)} data-testid="danger-zone">
        <SectionTitle
          title="Danger zone"
          sub="Reset Agentic SOC data in explicit tiers. Every action requires an exact confirmation phrase and a fresh sign-in; environment secrets and upstream logs are never touched."
        />

        <div className="divide-y divide-border border-y border-border">
          {TIERS.map((tier) => (
            <section
              key={tier.scope}
              className="space-y-4 py-5"
              aria-labelledby={`reset-${tier.scope}-title`}
              data-settings-tier={tier.scope}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h3 id={`reset-${tier.scope}-title`} className="text-base font-semibold text-foreground">
                    {tier.title}
                  </h3>
                  <p className="max-w-3xl text-sm text-muted-foreground">{tier.summary}</p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setPending(tier)}
                  aria-label={tier.title}
                >
                  {tier.title}
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ConsequenceList heading="This clears" tone="danger" items={tier.clears} />
                <ConsequenceList heading="This keeps" tone="ok" items={tier.keeps} />
              </div>
            </section>
          ))}
        </div>
      </div>

      <ResetDialog
        tier={pending}
        onClose={() => setPending(null)}
        onAccepted={() => {
          setPending(null);
        }}
      />
    </Can>
  );
}

export default DangerZone;
