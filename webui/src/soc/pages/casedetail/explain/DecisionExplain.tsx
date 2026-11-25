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

export interface DecisionExplainProps {
  caseRecord: Case;
  children: React.ReactNode;
}

/** `GET /api/cases/{id}/forwarding`: which deterministic gate sent the case to the AI. */
interface ForwardingReading {
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

export const DecisionExplain: React.FC<DecisionExplainProps> = ({ caseRecord, children }) => {
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
    const base = caseRecord ? explainDecision(caseRecord, payload) : null;
    // While the decision record is read, or after it failed, the panel says so instead of
    // showing "Not known" without a reason.
    const note =
      read === 'loading'
        ? 'Reading the decision record.'
        : read === 'failed'
          ? 'The decision record could not be read, so the auto-close thresholds are not shown.'
          : null;
    return base && note ? { ...base, caveats: [...base.caveats, note] } : base;
  }, [caseRecord, payload, read]);

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
  const detail = sentence ? (
    <div className="space-y-1 text-xs" data-testid="decision-why-investigated">
      <p className="font-medium text-muted-foreground">Why was this investigated?</p>
      <p className="leading-relaxed text-foreground/90">{sentence}</p>
    </div>
  ) : null;

  return (
    <ExplainTrigger explanation={explanation} onOpenChange={onOpenChange} detail={detail}>
      {children}
    </ExplainTrigger>
  );
};
