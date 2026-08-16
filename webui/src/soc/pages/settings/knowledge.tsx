/**
 * Knowledge & threat context settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `KnowledgeSection` + `RagControls`.
 * RAG retrieval config, the per-case threat-context panel, and deep-links to the
 * corpus and response-playbook management pages.
 */
import { Bot, FileText, Library, Scale, ShieldAlert } from 'lucide-react';

import type {
  PrecedentConfig,
  PrecedentPromotionConfig,
  PrecedentWindowConfig,
  RagConfig,
  ThreatContextConfig,
  UnconfirmedPrecedentConfig,
} from '@/lib/types';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { SettingsGrid, SettingsCard, type SettingsTOCItem } from '@/soc/components/SettingsGrid';
import { Field } from '@/soc/components/Field';
import { HelpTip } from '@/soc/components/HelpTip';

import { SectionShell, NumPref, SwitchPref, type NavigateFn, type SecProps } from './primitives';

const KNOWLEDGE_TOC: SettingsTOCItem[] = [
  { anchor: 'knowledge-rag', label: 'Retrieval (RAG)', icon: Library },
  { anchor: 'knowledge-promotion', label: 'Precedent promotion', icon: Scale },
  { anchor: 'knowledge-precedent', label: 'Unconfirmed precedent', icon: Bot },
  { anchor: 'knowledge-threat', label: 'Threat context', icon: ShieldAlert },
  { anchor: 'knowledge-corpus', label: 'Corpus', icon: FileText },
];

/** Backend defaults for `RagConfig.unconfirmed_precedent` (mirrors `config.py`). */
const PRECEDENT_GUARD_DEFAULTS: Required<UnconfirmedPrecedentConfig> = {
  min_confidence: 0.8,
  min_recurrence: 3,
  max_age_days: 30,
  max_context_share: 0.34,
  rank_penalty: 0.5,
  max_items: 50,
};

/**
 * Analyst-confirmed precedent PROMOTION — the feature's own opt-in.
 *
 * It has to be here rather than in the generic Advanced form because the schema
 * describes it as a nested object, and the generic renderer can only DESCRIBE structured
 * fields ("edit in its dedicated section"). Without this card that section did not
 * exist, so the switch was reachable only through the raw API.
 *
 * Turning it on changes WHAT THE INVESTIGATOR IS TOLD: it is handed a code-computed count
 * of the analyst-confirmed outcomes for the exact detection rule under investigation,
 * instead of inferring institutional history from a handful of retrieved snippets. It is
 * evidence, never authority — the verdict stays the model's and the deterministic policy
 * still decides the outcome — and the copy says so, because an operator must be able to
 * tell "we told it more" from "we let it close more".
 */
function PrecedentPromotionControls({ prefs, update }: SecProps) {
  const precedent: PrecedentConfig = prefs.precedent || {};
  const promotion: PrecedentPromotionConfig = precedent.promotion || {};
  const window: PrecedentWindowConfig = precedent.window || {};
  const rag: RagConfig = prefs.rag || {};
  // Promotion reads the resolved-case corpus, so it cannot work without it.
  const canEnable = (rag.enabled ?? true) && (rag.use_resolved_cases ?? true);
  const on = Boolean(promotion.enabled);

  const setPrecedent = (patch: Partial<PrecedentConfig>) =>
    update({ precedent: { ...precedent, ...patch } });
  const setPromotion = (patch: Partial<PrecedentPromotionConfig>) =>
    setPrecedent({ promotion: { ...promotion, ...patch } });
  const setWindow = (patch: Partial<PrecedentWindowConfig>) =>
    setPrecedent({ window: { ...window, ...patch } });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Off by default</Badge>
        <Badge variant="outline">Evidence, not authority</Badge>
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        For a detection whose alerts carry no request, payload or execution context, an
        investigation has nothing to verify a single instance against — so it routes to a
        human however many of its cases an analyst has confirmed benign. Promotion tells
        the investigator, as a{' '}
        <span className="font-medium text-foreground">count computed in code</span>, how
        many analyst-confirmed outcomes exist for that exact rule. The verdict still comes
        from the model and the deterministic policy still decides the outcome.
      </p>

      <SwitchPref
        label="Promote analyst-confirmed precedent"
        help={
          canEnable
            ? 'Requires an exact rule-identity match, a unanimous confirmed history, the minimum count below, and a matching precedent actually retrieved for the case.'
            : 'Unavailable while retrieval or the resolved-case precedent source is turned off.'
        }
        checked={on}
        disabled={!canEnable}
        onChange={(v) => setPromotion({ enabled: v })}
      />
      <NumPref
        label="Minimum confirmed outcomes"
        help="How many analyst-confirmed benign outcomes a rule needs before its history is promoted."
        value={promotion.min_confirmed ?? 25}
        min={1}
        step={1}
        disabled={!canEnable || !on}
        onChange={(v) => setPromotion({ min_confirmed: v })}
      />
      <NumPref
        label="Relevance floor"
        help="A secondary floor on the retrieval rank score. Rule identity is the authoritative gate — this only filters weak matches, and the score is not comparable across backends."
        value={promotion.min_similarity ?? 0.5}
        min={0}
        max={1}
        step={0.05}
        disabled={!canEnable || !on}
        onChange={(v) => setPromotion({ min_similarity: v })}
      />
      <NumPref
        label="Conflicting outcomes allowed"
        help="How many analyst-confirmed TRUE positives a rule may carry and still be promoted. 0 means a rule the analysts disagree about is never promoted."
        value={promotion.max_conflicting ?? 0}
        min={0}
        step={1}
        disabled={!canEnable || !on}
        onChange={(v) => setPromotion({ max_conflicting: v })}
      />
      <SwitchPref
        label="Share the precedent window across rules"
        help="On: the bounded projection window is filled round-robin per detection rule, so one rule's bulk confirmation cannot evict every other rule's precedent. Off restores a flat newest-first window."
        checked={window.stratify_by_rule ?? true}
        onChange={(v) => setWindow({ stratify_by_rule: v })}
      />
    </div>
  );
}

/**
 * The LOWER-TRUST precedent tier and its compounding guards.
 *
 * Deliberately its own card, not another switch in the retrieval list: turning this on
 * changes WHAT KIND OF EVIDENCE the investigator reads. The confirmed tier is analyst
 * ground truth; this one is the agent's own unreviewed auto-closes — prior MODEL
 * JUDGEMENTS. An operator has to be able to see that distinction without reading the
 * backend, so the card states it, the switch is off by default, and the guards stay
 * visible (but inert) whenever the tier is off.
 */
function UnconfirmedPrecedentControls({ prefs, update }: SecProps) {
  const rag: RagConfig = prefs.rag || {};
  const guards: UnconfirmedPrecedentConfig = rag.unconfirmed_precedent || {};
  const ragEnabled = rag.enabled ?? true;
  // A sub-tier of the precedent corpus, never an independent source: the backend
  // requires `use_resolved_cases`, so the UI must not imply it can stand alone.
  const precedentOn = rag.use_resolved_cases ?? true;
  const tierOn = Boolean(rag.use_unconfirmed_resolved_cases);
  const canEnable = ragEnabled && precedentOn;
  const guardsDisabled = !canEnable || !tierOn;

  const setRag = (patch: Partial<RagConfig>) => update({ rag: { ...rag, ...patch } });
  const setGuard = (patch: Partial<UnconfirmedPrecedentConfig>) =>
    setRag({ unconfirmed_precedent: { ...guards, ...patch } });
  const guard = <K extends keyof UnconfirmedPrecedentConfig>(key: K): number =>
    (guards[key] as number | undefined) ?? PRECEDENT_GUARD_DEFAULTS[key];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">Lower trust</Badge>
        <Badge variant="secondary">Off by default</Badge>
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        Resolved-case precedent normally comes from{' '}
        <span className="font-medium text-foreground">analyst-confirmed outcomes only</span>. This
        option additionally feeds the agent{' '}
        <span className="font-medium text-foreground">its own prior model judgements</span> — cases
        the agent auto-closed that no human ever reviewed. They are labelled as a separate,
        weaker tier, are always outranked by analyst-confirmed precedent, and never become
        analyst ground truth: threshold tuning and every other confirmed-evidence consumer
        ignore them entirely.
      </p>

      <SwitchPref
        label="Learn from unreviewed agent closes"
        help={
          canEnable
            ? 'Indexes the agent’s own auto-closed verdicts as a distinct, lower-trust precedent tier. It never changes how a case is closed or escalated — that stays deterministic.'
            : 'Requires retrieval and the resolved-case precedent source above to be enabled.'
        }
        checked={tierOn}
        disabled={!canEnable}
        onChange={(v) => setRag({ use_unconfirmed_resolved_cases: v })}
      />

      <div className={cn('space-y-3', guardsDisabled && 'opacity-60')}>
        <p className="text-xs leading-relaxed text-muted-foreground">
          These bounds compound. They exist to stop one unreviewed close becoming quotable
          precedent, and to stop a retrieval being dominated by an echo of the model’s own
          output.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumPref
            label="Minimum model confidence"
            help="0–1. A low-confidence auto-close is the judgement most likely to be wrong. A floor, never a warrant."
            value={guard('min_confidence')}
            step={0.05}
            min={0}
            max={1}
            disabled={guardsDisabled}
            onChange={(v) => setGuard({ min_confidence: v })}
          />
          <NumPref
            label="Minimum recurrence"
            help="How often the same detection pattern must have closed the same way before any of them is indexed. 1 disables this guard."
            value={guard('min_recurrence')}
            step={1}
            min={1}
            max={1000}
            disabled={guardsDisabled}
            onChange={(v) => setGuard({ min_recurrence: v })}
          />
          <NumPref
            label="Age-out (days)"
            help="Unconfirmed precedent is provisional and decays. Enforced at projection AND at retrieval, so stored chunks go quiet on schedule."
            value={guard('max_age_days')}
            step={1}
            min={1}
            max={3650}
            disabled={guardsDisabled}
            onChange={(v) => setGuard({ max_age_days: v })}
          />
          <NumPref
            label="Maximum context share"
            help="0–1. The hard cap on the fraction of one retrieval that may be the model’s own prior output. 0 blocks it entirely."
            value={guard('max_context_share')}
            step={0.01}
            min={0}
            max={1}
            disabled={guardsDisabled}
            onChange={(v) => setGuard({ max_context_share: v })}
          />
          <NumPref
            label="Rank penalty"
            help="0–1 multiplier demoting an unconfirmed chunk in the blended ranking. Confirmed precedent outranks it unconditionally regardless."
            value={guard('rank_penalty')}
            step={0.05}
            min={0}
            max={1}
            disabled={guardsDisabled}
            onChange={(v) => setGuard({ rank_penalty: v })}
          />
          <NumPref
            label="Maximum items"
            help="Bound on how many unconfirmed precedents the automatic projection may hold at all."
            value={guard('max_items')}
            step={1}
            min={0}
            max={1000}
            disabled={guardsDisabled}
            onChange={(v) => setGuard({ max_items: v })}
          />
        </div>
      </div>
    </div>
  );
}

/** RAG retrieval toggles (also reused by the Advanced › Suppression card). */
export function RagControls({ prefs, update }: SecProps) {
  const r = prefs.rag || {};
  const set = (patch: Partial<typeof r>) => update({ rag: { ...r, ...patch } });
  return (
    <div className="space-y-4">
      <SwitchPref label="RAG enabled" checked={r.enabled ?? true} onChange={(v) => set({ enabled: v })} />
      <div className={cn('grid gap-4 sm:grid-cols-2', !(r.enabled ?? true) && 'opacity-60')}>
        <NumPref label="Top K" value={r.top_k} disabled={!(r.enabled ?? true)} onChange={(v) => set({ top_k: v })} />
        <NumPref label="Minimum score" value={r.min_score} step={0.05} disabled={!(r.enabled ?? true)} onChange={(v) => set({ min_score: v })} />
      </div>
      <div className={cn('space-y-2', !(r.enabled ?? true) && 'opacity-60')}>
        <SwitchPref label="Use runbooks" checked={r.use_runbooks ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_runbooks: v })} />
        <SwitchPref label="Use MITRE" checked={r.use_mitre ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_mitre: v })} />
        <SwitchPref label="Use resolved cases" checked={r.use_resolved_cases ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_resolved_cases: v })} />
        <SwitchPref label="Use threat intel" checked={r.use_threat_context ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_threat_context: v })} />
      </div>
    </div>
  );
}

export function KnowledgeSection({
  prefs,
  update,
  onNavigate,
}: SecProps & { onNavigate?: NavigateFn }) {
  const cfg: ThreatContextConfig = prefs.threat_context || {};
  const set = (patch: Partial<ThreatContextConfig>) =>
    update({ threat_context: { ...cfg, ...patch } });

  return (
    <SectionShell
      title="Knowledge & threat context"
      sub="Retrieval-augmented context for investigations, the per-case threat-context panel (IOC reputation, MITRE, related cases), and the reusable-knowledge loop."
      toc={KNOWLEDGE_TOC}
    >
      <SettingsGrid>
        <SettingsCard
          anchor="knowledge-rag"
          title="Retrieval (RAG)"
          icon={Library}
          description="Hybrid BM25 + vector retrieval injects relevant knowledge into investigations as a clearly-labelled TRUSTED block."
          wide="full"
        >
          <RagControls prefs={prefs} update={update} />
        </SettingsCard>

        <SettingsCard
          anchor="knowledge-promotion"
          title="Analyst-confirmed precedent promotion"
          icon={Scale}
          description="Tell the investigator, as a computed count, how much analyst-confirmed history exists for the exact detection rule it is looking at. Evidence only — the deterministic policy still decides."
          wide="full"
        >
          <PrecedentPromotionControls prefs={prefs} update={update} />
        </SettingsCard>

        <SettingsCard
          anchor="knowledge-precedent"
          title="Unconfirmed precedent (lower trust)"
          icon={Bot}
          description="Optional, off by default: additionally feed the investigator the agent's OWN prior model judgements — auto-closed cases no analyst reviewed — as a separate, weaker, bounded tier."
          wide="full"
        >
          <UnconfirmedPrecedentControls prefs={prefs} update={update} />
        </SettingsCard>

        <SettingsCard
          anchor="knowledge-threat"
          title="Threat-context panel"
          icon={ShieldAlert}
          description="The Threat context tab on each case. Sections fail open — a missing enrichment or MITRE lookup degrades to empty, never an error."
          wide="full"
        >
          <div className="space-y-3">
            <SwitchPref
              label="Threat-context panel enabled"
              help="Assemble and show the Threat context tab on each case."
              checked={cfg.enabled ?? true}
              onChange={(v) => set({ enabled: v })}
            />
            <SwitchPref
              label="MITRE ATT&CK technique lookup"
              help="Resolve technique ids against the bundled curated MITRE corpus (name, tactics, link)."
              checked={cfg.mitre_enabled ?? true}
              onChange={(v) => set({ mitre_enabled: v })}
            />
            <SwitchPref
              label="Reuse resolved cases"
              help="Auto-index closed/resolved cases into the corpus so future triage can retrieve 'we've seen this before'."
              checked={cfg.reuse_resolved_cases ?? true}
              onChange={(v) => set({ reuse_resolved_cases: v })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="IOC malicious threshold"
                description="Reputation scores at or above this threshold are marked malicious."
                labelAction={
                  <HelpTip text="A reputation score at or above this (0–100) marks an indicator as malicious in the panel." />
                }
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    type="number"
                    min={0}
                    max={100}
                    value={cfg.ioc_malicious_threshold ?? 50}
                    onChange={(e) => set({ ioc_malicious_threshold: Number(e.target.value) })}
                  />
                )}
              </Field>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="knowledge-corpus"
          title="Corpus & procedures"
          icon={FileText}
          description="Manage the RAG knowledge corpus (runbooks, MITRE, imported threat-intel) and the per-cluster playbooks on their dedicated pages."
          wide="full"
        >
          <div className="divide-y divide-border/70 border-y border-border/70 sm:grid sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="flex flex-wrap items-center justify-between gap-3 py-3 sm:pr-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Knowledge corpus</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Runbooks, MITRE context, and imported intelligence.
                </p>
              </div>
              {onNavigate ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('intelligence', { tab: 'knowledge' })}
                >
                  <Library className="h-4 w-4" aria-hidden />
                  Open
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3 sm:pl-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Response playbooks</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Deterministically selected procedures that guide an investigation.
                </p>
              </div>
              {onNavigate ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('intelligence', { tab: 'playbooks' })}
                >
                  <FileText className="h-4 w-4" aria-hidden />
                  Open
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsCard>
      </SettingsGrid>
    </SectionShell>
  );
}
