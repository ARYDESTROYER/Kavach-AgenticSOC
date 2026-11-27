/**
 * Rules editor components (G6 R4/R6). Config-writer editors + shared threshold-UX
 * primitives for the Round-5 rules-customization wave. Every editor writes a
 * `Preferences` block via deep-merge PUT and NEVER touches `decide()` (#3), never sets
 * a case status, never bills an LLM (#6); all values render plain (#9).
 */
export { EffectiveConfigPreview } from './EffectiveConfigPreview';
export type { EffectiveConfigPreviewProps, EffectiveConfigLine } from './EffectiveConfigPreview';

export { TunerSuggestionChip } from './TunerSuggestionChip';
export type { TunerSuggestionChipProps } from './TunerSuggestionChip';

export { AssetCriticalityEditor, validateCidr } from './AssetCriticalityEditor';
export type { AssetCriticalityEditorProps } from './AssetCriticalityEditor';

export { SlaPolicyEditor } from './SlaPolicyEditor';
export type { SlaPolicyEditorProps } from './SlaPolicyEditor';

export { PriorityMatrixEditor } from './PriorityMatrixEditor';
export type { PriorityMatrixEditorProps } from './PriorityMatrixEditor';

export { SuppressionRuleBuilder } from './SuppressionRuleBuilder';
export type { SuppressionRuleBuilderProps } from './SuppressionRuleBuilder';
export { AnalystPolicyBuilder, isLiveDeclaration } from './AnalystPolicyBuilder';
export type { AnalystPolicyBuilderProps } from './AnalystPolicyBuilder';

export { useConfigEditor } from './useConfigEditor';
export type { ConfigClient, ConfigEditorState } from './useConfigEditor';
