/**
 * Chart kinds by renderer (Round 13): the kinds `CartesianChart` draws over one x axis.
 * The card uses it to know whether a chart will draw its own control row (Group by on
 * the left, the zoom hint and Reset zoom on the right) or the card must draw Group by.
 */
import type { ChartKind } from '../schema';

export const CARTESIAN_KINDS: ReadonlySet<ChartKind> = new Set<ChartKind>(['bar', 'grouped_bar', 'stacked_bar', 'line', 'area']);
