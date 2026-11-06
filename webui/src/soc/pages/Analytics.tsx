/**
 * Analytics: the host of the three Analytics pages the navigation opens (Round 14, SPEC
 * §4.9 and D25, one name per page):
 *
 *   `#/metrics`       Metrics (Operational, Performance and Posture tabs)
 *   `#/effectiveness` Agent effectiveness (agent health and observed outcomes)
 *   `#/cost`          Cost (the LLM spend ledger)
 *
 * Each page carries its own header, titled by its navigation label, with the Analytics
 * time range and one refresh beside the title. The Analytics navigation group is the
 * switcher between them; there is no second tab strip repeating it. The range picked on
 * one page is kept for the others in the session (`useAnalyticsWindow`).
 *
 * The route passes `tab`: the registry renders `<Analytics tab="effectiveness" />` and
 * `<Analytics tab="cost" />` for the two leaf pages, and the Metrics route passes its own
 * tab through. An older deep link (`#/metrics?tab=effectiveness`, or an in-app navigation
 * to Metrics with `tab: 'cost'`) still opens the page it names.
 *
 * SECURITY (#9): the header copy is static operator-facing text; every data value renders
 * as plain text inside the pages.
 */
import { useNavigateOptional, type Navigate } from '@/soc/router';

import { AgentEffectivenessPage } from './AgentEffectiveness';
import Cost from './Cost';
import Metrics from './Metrics';

export interface AnalyticsProps {
  onNavigate?: Navigate;
  /** The page or Metrics tab from the route (`effectiveness`, `cost`, or a Metrics tab). */
  tab?: string;
}

export default function Analytics({ onNavigate, tab }: AnalyticsProps = {}) {
  // The host resolves navigate once (a prop wins, for tests). The hook is called
  // unconditionally (rules of hooks), then an explicit prop wins.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  if (tab === 'cost') return <Cost onNavigate={navigate} />;
  if (tab === 'effectiveness') return <AgentEffectivenessPage onNavigate={navigate} />;
  return <Metrics onNavigate={navigate} tab={tab} onTabChange={(next) => navigate('metrics', { tab: next })} />;
}
