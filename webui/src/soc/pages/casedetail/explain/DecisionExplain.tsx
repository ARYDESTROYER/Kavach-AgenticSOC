/**
 * The decision explainer (Round 16 SPEC §4.5 WP11; research explainability R3, R4, D1,
 * D8; competitors R3).
 *
 * Wraps the AI verdict chip. The hover line states how the deterministic policy compared
 * the verdict, confidence and risk with the auto-close bars, both conditions with the
 * real numbers; the click panel holds the comparison table, the recorded decision, a
 * "policy changed since" note and "Why was this investigated?" (the auto-forward gate's
 * own sentence). The thresholds come from the case's decision span, read once on first
 * open: the gate recorded at decision time when the span carries one, otherwise today's
 * policy, labelled as such. Until it is read, the hover states the case's own recorded
 * decision and numbers.
 *
 * SECURITY (#9): the forwarding sentence is our own deterministic copy and renders as a
 * text node. #3: nothing here decides; the stored risk is never presented as the reason a
 * case was investigated.
 */
import * as React from 'react';

import { ExplainTrigger } from '@/design-system/explain';
import { api } from '@/lib/api';
import { explainDecision } from '@/lib/explain/decision';
import type { Case } from '@/lib/types';
import { getTimeline, type DecisionPayload } from '@/soc/pages/CaseDetail.api';

import { TODAY_SETTINGS, routingScoreLine, type RoutingReading } from './routing';

export interface DecisionExplainProps {
  caseRecord: Case;
  children: React.ReactNode;
  /**
   * A sentence that leads the hover line and the panel's notes, for example while an AI
   * run is under way: "Previous verdict. The running investigation replaces it." (WP16).
   */
  note?: string | null;
}

/**
 * `GET /api/cases/{id}/forwarding`: which deterministic gate sent the case to the AI,
 * walked again with today's settings, and the routing score with its terms.
 */
interface ForwardingReading extends RoutingReading {
  gate?: string;
  forwarded?: boolean;
  sentence?: string;
}

async function loadDecision(caseId: string): Promise<DecisionPayload | null> {
  const timeline = await getTimeline(caseId);
  const spans = (timeline?.spans ?? []).filter((s) => s.kind === 'decision');
  const span = spans[spans.length - 1];
  const payload = span?.payload_ref;
  return payload && typeof payload === 'object' ? (payload as DecisionPayload) : null;
}

async function loadForwarding(caseId: string): Promise<ForwardingReading | null> {
  const reading = await api.get<ForwardingReading>(`cases/${encodeURIComponent(caseId)}/forwarding`);
  return reading && typeof reading === 'object' ? reading : null;
}

export const DecisionExplain: React.FC<DecisionExplainProps> = ({ caseRecord, children, note = null }) => {
  const caseId = caseRecord?.case_id ?? '';
  const [payload, setPayload] = React.useState<DecisionPayload | null>(null);
  const [forwarding, setForwarding] = React.useState<ForwardingReading | null>(null);
  const [read, setRead] = React.useState<'idle' | 'loading' | 'done' | 'failed'>('idle');
  const requested = React.useRef<string | null>(null);

  React.useEffect(() => {
    setPayload(null);
    setForwarding(null);
    setRead('idle');
    requested.current = null;
  }, [caseId]);

  const explanation = React.useMemo(() => {
    const decided = caseRecord ? explainDecision(caseRecord, payload) : null;
    // A lead note (an AI run under way) opens the hover line and the panel's notes.
    const lead = note?.trim() || null;
    const base = decided && lead ? { ...decided, summary: `${lead} ${decided.summary}`, caveats: [lead, ...decided.caveats] } : decided;
    // While the decision record is read, or after it failed, the panel says so instead of
    // showing "Not known" without a reason.
    const reading =
      read === 'loading'
        ? 'Reading the decision record.'
        : read === 'failed'
          ? 'The decision record could not be read, so the auto-close thresholds are not shown.'
          : null;
    return base && reading ? { ...base, caveats: [...base.caveats, reading] } : base;
  }, [caseRecord, payload, read, note]);

  const onOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open || !caseId || requested.current === caseId) return;
      requested.current = caseId;
      const forCase = caseId;
      setRead('loading');
      void loadDecision(forCase)
        .then((next) => {
          if (requested.current !== forCase) return;
          setPayload(next);
          setRead('done');
        })
        .catch(() => {
          if (requested.current === forCase) setRead('failed');
        });
      void loadForwarding(forCase)
        .then((next) => {
          if (requested.current === forCase) setForwarding(next);
        })
        .catch(() => undefined);
    },
    [caseId],
  );

  const sentence = typeof forwarding?.sentence === 'string' ? forwarding.sentence.trim() : '';
  const routing = routingScoreLine(forwarding);
  const detail = sentence ? (
    <div className="space-y-1 text-xs" data-testid="decision-why-investigated">
      <p className="font-medium text-muted-foreground">Why was this investigated?</p>
      <p className="leading-relaxed text-foreground/90">{sentence}</p>
      {routing ? (
        <p className="break-words font-mono text-foreground/90" data-testid="decision-routing-score">
          {routing}
        </p>
      ) : null}
      <p className="leading-relaxed text-muted-foreground">{TODAY_SETTINGS}</p>
    </div>
  ) : null;

  return (
    <ExplainTrigger explanation={explanation} onOpenChange={onOpenChange} detail={detail}>
      {children}
    </ExplainTrigger>
  );
};
