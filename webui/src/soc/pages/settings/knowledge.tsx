/**
 * Knowledge & threat context settings section (Round-5 Sett-A decomposition; Round 14
 * grouped panels).
 *
 * Retrieval (RAG) for investigations, analyst-confirmed precedent promotion, the
 * lower-trust unconfirmed precedent tier, the per-case threat context panel, and rows
 * that open the knowledge corpus and the Runbooks settings. Runbooks in retrieval has one
 * editor, the Runbooks section (`runbooks.rag_corpus`); Retrieval shows its state and
 * links there.
 */
import type {
  PrecedentConfig,
  PrecedentPromotionConfig,
  PrecedentWindowConfig,
  RagConfig,
  ThreatContextConfig,
  UnconfirmedPrecedentConfig,
} from '@/lib/types';

import { Badge } from '@/ui/badge';

import {
  NumPref,
  SettingRow,
  SettingsGroup,
  SettingsSection,
  type NavigateFn,
  type SecProps,
} from './primitives';
import { runbooksConfig } from './runbooks';

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
 * Analyst-confirmed precedent PROMOTION, the feature's own opt-in.
 *
 * It has to be here rather than in the generic Advanced form because the schema
 * describes it as a nested object, and the generic renderer can only DESCRIBE structured
 * fields ("edit in its dedicated section"). Without this card that section did not
 * exist, so the switch was reachable only through the raw API.
 *
 * Turning it on changes WHAT THE INVESTIGATOR IS TOLD: it is handed a code-computed count
 * of the analyst-confirmed outcomes for the exact detection rule under investigation,
 * instead of inferring institutional history from a handful of retrieved snippets. It is
 * evidence, never authority, the verdict stays the model's and the deterministic policy
 * still decides the outcome, and the copy says so, because an operator must be able to
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
    <SettingsGroup
      id="knowledge-promotion"
      title="Analyst-confirmed precedent promotion"
      caption="Tell the investigator, as a count computed in code, how much analyst-confirmed history exists for the exact detection rule it is looking at."
    >
      <SettingRow variant="block">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Off by default</Badge>
          <Badge variant="outline">Evidence, not authority</Badge>
        </div>
        <p className="mt-2 max-w-[42rem] text-sm text-muted-foreground">
          For a detection whose alerts carry no request, payload or execution context, an
          investigation has nothing to verify a single instance against, so it routes to a
          person however many of its cases an analyst has confirmed benign. Promotion tells
          the investigator, as a{' '}
          <span className="font-medium text-foreground">count computed in code</span>, how
          many analyst-confirmed outcomes exist for that exact rule. The verdict still comes
          from the model and the deterministic policy still decides the outcome.
        </p>
      </SettingRow>
      <SettingRow
        variant="switch"
        label="Promote analyst-confirmed precedent"
        help={
          canEnable
            ? 'Requires an exact rule-identity match, a unanimous confirmed history, the minimum count below, and a matching precedent actually retrieved for the case.'
            : 'Unavailable while retrieval or the resolved-case precedent source is turned off.'
        }
        checked={on}
        disabled={!canEnable}
        onCheckedChange={(v) => setPromotion({ enabled: v })}
      />
      <SettingRow variant="field" controlWidth="8rem">
        <NumPref
          label="Minimum confirmed outcomes"
          help="How many analyst-confirmed benign outcomes a rule needs before its history is promoted."
          value={promotion.min_confirmed ?? 25}
          min={1}
          step={1}
          disabled={!canEnable || !on}
          onChange={(v) => setPromotion({ min_confirmed: v })}
        />
      </SettingRow>
      <SettingRow variant="field" controlWidth="8rem">
        <NumPref
          label="Relevance floor"
          help="A secondary floor on the retrieval rank score. Rule identity is the real gate; this only filters weak matches, and the score is not comparable across backends."
          value={promotion.min_similarity ?? 0.5}
          min={0}
          max={1}
          step={0.05}
          disabled={!canEnable || !on}
          onChange={(v) => setPromotion({ min_similarity: v })}
        />
      </SettingRow>
      <SettingRow variant="field" controlWidth="8rem">
        <NumPref
          label="Conflicting outcomes allowed"
          help="How many analyst-confirmed true positives a rule may carry and still be promoted. 0 means a rule the analysts disagree about is never promoted."
          value={promotion.max_conflicting ?? 0}
          min={0}
          step={1}
          disabled={!canEnable || !on}
          onChange={(v) => setPromotion({ max_conflicting: v })}
        />
      </SettingRow>
      <SettingRow
        variant="switch"
        label="Share the precedent window fairly"
        help="On: the window is filled round-robin across detection rules and then confirmed outcomes, and no single bulk confirmation may take more than half of it; over-cap cases wait at the back rather than being dropped. Off restores a flat newest-first window."
        checked={window.stratify_by_rule ?? true}
        onCheckedChange={(v) => setWindow({ stratify_by_rule: v })}
      />
    </SettingsGroup>
  );
}

/**
 * The LOWER-TRUST precedent tier and its compounding guards.
 *
 * Deliberately its own card, not another switch in the retrieval list: turning this on
 * changes WHAT KIND OF EVIDENCE the investigator reads. The confirmed tier is analyst
 * ground truth; this one is the agent's own unreviewed auto-closes, prior MODEL
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

  const guardRow = (
    key: keyof UnconfirmedPrecedentConfig,
    label: string,
    help: string,
    bounds: { min: number; max: number; step: number },
  ) => (
    <SettingRow key={key} variant="field" controlWidth="8rem">
      <NumPref
        label={label}
        help={help}
        value={guard(key)}
        step={bounds.step}
        min={bounds.min}
        max={bounds.max}
        disabled={guardsDisabled}
        onChange={(v) => setGuard({ [key]: v } as Partial<UnconfirmedPrecedentConfig>)}
      />
    </SettingRow>
  );

  return (
    <SettingsGroup
      id="knowledge-precedent"
      title="Unconfirmed precedent (lower trust)"
      caption="Optionally also feed the investigator the agent's own earlier judgements: auto-closed cases no analyst reviewed, as a separate, weaker, bounded tier."
    >
      <SettingRow variant="block">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">Lower trust</Badge>
          <Badge variant="secondary">Off by default</Badge>
        </div>
        <p className="mt-2 max-w-[42rem] text-sm text-muted-foreground">
          Resolved-case precedent normally comes from{' '}
          <span className="font-medium text-foreground">analyst-confirmed outcomes only</span>. This
          option also feeds the agent{' '}
          <span className="font-medium text-foreground">its own prior model judgements</span>: cases
          the agent auto-closed that no person ever reviewed. They are labelled as a separate,
          weaker tier, are always outranked by analyst-confirmed precedent, and never become
          analyst ground truth: threshold tuning and every other confirmed-evidence consumer
          ignores them.
        </p>
      </SettingRow>
      <SettingRow
        variant="switch"
        label="Learn from unreviewed agent closes"
        help={
          canEnable
            ? 'Indexes the agent’s own auto-closed verdicts as a distinct, lower-trust precedent tier. It never changes how a case is closed or escalated; that stays deterministic.'
            : 'Requires retrieval and the resolved-case precedent source above to be enabled.'
        }
        checked={tierOn}
        disabled={!canEnable}
        onCheckedChange={(v) => setRag({ use_unconfirmed_resolved_cases: v })}
      />
      {/* Each disabled field dims itself; the explanation stays at full contrast. */}
      <div className="divide-y divide-border/70">
        <SettingRow variant="block">
          <p className="max-w-[42rem] text-sm text-muted-foreground">
            These bounds compound. They stop one unreviewed close from becoming quotable
            precedent, and stop a retrieval from being dominated by an echo of the model’s own
            output.
          </p>
        </SettingRow>
        {guardRow('min_confidence', 'Minimum model confidence', 'From 0 to 1. A low-confidence auto-close is the judgement most likely to be wrong. A floor, never a warrant.', { min: 0, max: 1, step: 0.05 })}
        {guardRow('min_recurrence', 'Minimum recurrence', 'How often the same detection pattern must have closed the same way before any of them is indexed. 1 turns this guard off.', { min: 1, max: 1000, step: 1 })}
        {guardRow('max_age_days', 'Age-out (days)', 'Unconfirmed precedent is provisional and decays. Enforced when it is stored and when it is retrieved, so stored items go quiet on schedule.', { min: 1, max: 3650, step: 1 })}
        {guardRow('max_context_share', 'Maximum context share', 'From 0 to 1. The cap on the share of one retrieval that may be the model’s own earlier output. 0 blocks it entirely.', { min: 0, max: 1, step: 0.01 })}
        {guardRow('rank_penalty', 'Rank penalty', 'From 0 to 1. A multiplier that demotes an unconfirmed item in the ranking. Confirmed precedent always outranks it.', { min: 0, max: 1, step: 0.05 })}
        {guardRow('max_items', 'Maximum items', 'How many unconfirmed precedents the automatic projection may hold at all.', { min: 0, max: 1000, step: 1 })}
      </div>
    </SettingsGroup>
  );
}

/** The retrieval group: the switch, its bounds and the sources it may read. */
export function RetrievalGroup({ prefs, update }: SecProps) {
  const r = prefs.rag || {};
  const set = (patch: Partial<typeof r>) => update({ rag: { ...r, ...patch } });
  const on = r.enabled ?? true;
  const runbooksInRetrieval = runbooksConfig(prefs).rag_corpus;
  return (
    <SettingsGroup
      id="knowledge-rag"
      title="Retrieval"
      caption="Hybrid keyword and vector retrieval adds relevant knowledge to an investigation. Imported documents are always fenced as untrusted."
    >
      <SettingRow
        variant="switch"
        label="Retrieval enabled"
        checked={on}
        onCheckedChange={(v) => set({ enabled: v })}
      />
      <div className="divide-y divide-border/70">
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Results per search"
            help="How many items one retrieval returns at most."
            value={r.top_k}
            min={1}
            disabled={!on}
            onChange={(v) => set({ top_k: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Minimum score"
            help="Items scoring below this are left out."
            value={r.min_score}
            step={0.05}
            disabled={!on}
            onChange={(v) => set({ min_score: v })}
          />
        </SettingRow>
        <SettingRow
          variant="switch"
          label="Use MITRE ATT&CK"
          checked={r.use_mitre ?? true}
          disabled={!on}
          onCheckedChange={(v) => set({ use_mitre: v })}
        />
        <SettingRow
          variant="switch"
          label="Use resolved cases"
          checked={r.use_resolved_cases ?? true}
          disabled={!on}
          onCheckedChange={(v) => set({ use_resolved_cases: v })}
        />
        <SettingRow
          variant="switch"
          label="Use threat intelligence"
          checked={r.use_threat_context ?? true}
          disabled={!on}
          onCheckedChange={(v) => set({ use_threat_context: v })}
        />
        <SettingRow
          variant="link"
          label="Published runbooks in retrieval"
          help="Set in the Runbooks section."
          href="#/settings?s=runbooks"
          value={runbooksInRetrieval ? 'On' : 'Off'}
        />
      </div>
    </SettingsGroup>
  );
}

export function KnowledgeSection({
  prefs,
  update,
}: SecProps & { onNavigate?: NavigateFn }) {
  const cfg: ThreatContextConfig = prefs.threat_context || {};
  const set = (patch: Partial<ThreatContextConfig>) =>
    update({ threat_context: { ...cfg, ...patch } });

  return (
    <SettingsSection title="Knowledge & threat context">
      <RetrievalGroup prefs={prefs} update={update} />

      <PrecedentPromotionControls prefs={prefs} update={update} />

      <UnconfirmedPrecedentControls prefs={prefs} update={update} />

      <SettingsGroup
        id="knowledge-threat"
        title="Threat context panel"
        caption="The Threat context tab on each case. A missing enrichment or MITRE lookup leaves its part empty, never an error."
      >
        <SettingRow
          variant="switch"
          label="Threat context panel enabled"
          help="Assemble and show the Threat context tab on each case."
          checked={cfg.enabled ?? true}
          onCheckedChange={(v) => set({ enabled: v })}
        />
        <SettingRow
          variant="switch"
          label="MITRE ATT&CK technique lookup"
          help="Resolve technique ids against the bundled MITRE corpus (name, tactics, link)."
          checked={cfg.mitre_enabled ?? true}
          onCheckedChange={(v) => set({ mitre_enabled: v })}
        />
        <SettingRow
          variant="switch"
          label="Reuse resolved cases"
          help="Index closed and resolved cases so a later triage can find a similar case."
          checked={cfg.reuse_resolved_cases ?? true}
          onCheckedChange={(v) => set({ reuse_resolved_cases: v })}
        />
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref
            label="Malicious score threshold"
            help="An indicator with a reputation score at or above this (0 to 100) is marked malicious."
            value={cfg.ioc_malicious_threshold ?? 50}
            min={0}
            max={100}
            onChange={(v) => set({ ioc_malicious_threshold: v })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="knowledge-corpus" title="Knowledge corpus">
        <SettingRow
          variant="link"
          label="Knowledge corpus"
          help="Imported intelligence, MITRE context and resolved cases."
          href="#/knowledge"
        />
        <SettingRow
          variant="link"
          label="Runbooks"
          help="The procedures attached to cases and given to the agent as guidance."
          href="#/runbooks"
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
