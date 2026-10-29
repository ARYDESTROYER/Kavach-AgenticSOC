/**
 * Compile-time pins of the hand-written contract mirrors to the generated OpenAPI
 * contract (Round 14 SPEC §7.4). Type-only and imported by nothing: it costs the
 * bundle nothing, and `tsc --noEmit` (the Type check gate) fails here the moment a
 * backend model gains, loses or renames a field, or changes a vocabulary, while its
 * mirror in `types-audit.ts`, `types-dashboards.ts`, `types-rules.ts`,
 * `types-runbooks.ts` or `types.ts` was not updated with it.
 *
 * How to read a failure: the line names the mirror and the schema. Run
 * `npm run gen:types` first (the generated file must match the backend, which
 * `npm run check:types` proves), then update the mirror until the pin holds.
 *
 * What is pinned: the field names of every mirror that has a schema of the same name
 * (both directions), the parameter names of the query mirrors, and every closed
 * vocabulary (a literal union) a mirror declares. What is not: field value types,
 * because the mirrors are deliberately more precise than the schema where the schema
 * is a free-form object (`attached_reason`, `steps`, a lookup `table`). The
 * `round14-client.test.ts` contract test checks the other half at runtime: that every
 * such mirror is pinned here, and that every client call names a real path, method,
 * parameter and body field.
 */
import type { components, paths } from './api-types.gen';
import type {
  AuditActorType,
  AuditCategory,
  AuditChange,
  AuditClient,
  AuditCount,
  AuditCountQuery,
  AuditCountRelation,
  AuditOutcome,
  AuditPage,
  AuditPageQuery,
  AuditRecord,
  AuditRecordQuery,
  AuditRetention,
  AuditScope,
  AuditTarget,
  AuditTargetType,
} from './types-audit';
import type {
  BreakdownBucket,
  BreakdownField,
  BreakdownKind,
  BreakdownStatusGroup,
  DashboardWindow,
  MetricsBreakdown,
  MetricsBreakdownBucket,
  MetricsBreakdownGroup,
  MetricsBreakdownOther,
  MetricsBreakdownQuery,
} from './types-dashboards';
import type {
  RuleCaseOutcomes,
  RuleCaseRow,
  RuleSectionStatus,
  RuleSeverityPoint,
  RuleSeveritySeries,
  RuleSuiteDefinition,
  RuleSummary,
  RuleSummaryAlerts,
  RuleSummaryAnalystPolicy,
  RuleSummaryCases,
  RuleSummaryDefinition,
  RuleSummaryQuery,
  RuleSummarySource,
  RuleSummaryTopList,
  RuleSummaryTuning,
  RuleSummaryWindow,
  RuleTopRow,
  SeverityLevel,
} from './types-rules';
import type {
  AiCallEstimate,
  AppliesWhen,
  CaseRunbooks,
  DecisionOption,
  LookupResult,
  LookupResultStatus,
  LookupRunMode,
  LookupTemplate,
  LookupTool,
  MatchCriterion,
  MatchExplanation,
  MatchPreview,
  MatchPreviewCase,
  MatchPreviewCounts,
  MatchPreviewNearMiss,
  MatchPreviewOther,
  MatchedCriterion,
  MissedCriterion,
  PhaseId,
  RunAttachedBy,
  RunStatus,
  RunbookAppliesTo,
  RunbookAttachBody,
  RunbookAttachResult,
  RunbookCandidate,
  RunbookCandidates,
  RunbookDefinition,
  RunbookDetail,
  RunbookDiscardResult,
  RunbookDraftBody,
  RunbookEntityType,
  RunbookIssue,
  RunbookLibrary,
  RunbookLibraryQuery,
  RunbookLookupTestBody,
  RunbookMetrics,
  RunbookMetricsCohort,
  RunbookMetricsPhaseRow,
  RunbookMetricsRecentRun,
  RunbookMetricsRunbookRow,
  RunbookMetricsStepRow,
  RunbookMigratedFrom,
  RunbookMigrationNotice,
  RunbookOrigin,
  RunbookProgress,
  RunbookPublishBody,
  RunbookRef,
  RunbookRejectBody,
  RunbookReviewNote,
  RunbookRevisionBody,
  RunbookRun,
  RunbookRunUpdate,
  RunbookSourceBody,
  RunbookState,
  RunbookStep,
  RunbookStepDraftResult,
  RunbookStepUpdate,
  RunbookSuggestion,
  RunbookSummary,
  RunbookValidation,
  RunbookVerdict,
  RunbookVersionBody,
  RunbookVersionDoc,
  RunbookVersionListItem,
  RunbookVersionState,
  StepApprovalBody,
  StepDraftConfirmBody,
  StepEvidence,
  StepEvidenceRule,
  StepKind,
  StepState,
  StepStatus,
} from './types-runbooks';
import type {
  BackgroundJobKind,
  BackgroundJobParamsByKind,
  BackgroundJobSubmit,
  Case,
  CaseLifecycleInput,
  CaseLifecycleParams,
  DashboardLayout,
} from './types';
import type { AuditExportJobParams } from './types-audit';
import type { UnifiedLogsQuery } from '@/soc/UnifiedLogs.api';
import type { BulkCloseInput } from '@/soc/pages/casedetail/BulkCloseDialog';

type S = components['schemas'];

/** True when `A` and `B` are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Fails to compile unless `T` is `true`. */
type Expect<T extends true> = T;
/** The mirror `M` has exactly the fields of schema `K`. */
type SameFields<M, K extends keyof S> = Equal<keyof M, keyof S[K]>;
/** The query parameter names of `GET <P>`. */
type GetQuery<P extends keyof paths> = paths[P] extends { get: { parameters: { query?: infer Q } } }
  ? NonNullable<Q>
  : never;
/** The declared field names of `T`, without an index signature (`[key: string]: unknown`). */
type KnownKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};
/** The schema type of a property, without `null` and `undefined`. */
type Field<K extends keyof S, F extends keyof S[K]> = NonNullable<S[K][F]>;

/** Field names: every mirror with a schema of the same name, in both directions. */
export type MirrorFieldPins = [
  // types-audit.ts
  Expect<SameFields<AuditClient, 'AuditClient'>>,
  Expect<SameFields<AuditTarget, 'AuditTarget'>>,
  Expect<SameFields<AuditChange, 'AuditChange'>>,
  Expect<SameFields<AuditRecord, 'AuditRecord'>>,
  Expect<SameFields<AuditRetention, 'AuditRetention'>>,
  Expect<SameFields<AuditPage, 'AuditPage'>>,
  Expect<SameFields<AuditCount, 'AuditCount'>>,
  // types-dashboards.ts
  Expect<SameFields<MetricsBreakdownGroup, 'MetricsBreakdownGroup'>>,
  Expect<SameFields<MetricsBreakdownOther, 'MetricsBreakdownOther'>>,
  Expect<SameFields<MetricsBreakdownBucket, 'MetricsBreakdownBucket'>>,
  Expect<SameFields<MetricsBreakdown, 'MetricsBreakdown'>>,
  // types-rules.ts
  Expect<SameFields<RuleSummaryWindow, 'RuleSummaryWindow'>>,
  Expect<SameFields<RuleSeverityPoint, 'RuleSeverityPoint'>>,
  Expect<SameFields<RuleSeveritySeries, 'RuleSeveritySeries'>>,
  Expect<SameFields<RuleSummarySource, 'RuleSummarySource'>>,
  Expect<SameFields<RuleSummaryAlerts, 'RuleSummaryAlerts'>>,
  Expect<SameFields<RuleTopRow, 'RuleTopRow'>>,
  Expect<SameFields<RuleSummaryTopList, 'RuleSummaryTopList'>>,
  Expect<SameFields<RuleCaseOutcomes, 'RuleCaseOutcomes'>>,
  Expect<SameFields<RuleCaseRow, 'RuleCaseRow'>>,
  Expect<SameFields<RuleSummaryCases, 'RuleSummaryCases'>>,
  Expect<SameFields<RuleSuiteDefinition, 'RuleSuiteDefinition'>>,
  Expect<SameFields<RuleSummaryDefinition, 'RuleSummaryDefinition'>>,
  Expect<SameFields<RuleSummaryTuning, 'RuleSummaryTuning'>>,
  Expect<SameFields<RuleSummaryAnalystPolicy, 'RuleSummaryAnalystPolicy'>>,
  Expect<SameFields<RuleSummary, 'RuleSummary'>>,
  // types-runbooks.ts: the definition
  Expect<SameFields<AppliesWhen, 'AppliesWhen'>>,
  Expect<SameFields<LookupTemplate, 'LookupTemplate'>>,
  Expect<SameFields<DecisionOption, 'DecisionOption'>>,
  Expect<SameFields<RunbookStep, 'RunbookStep'>>,
  Expect<SameFields<RunbookDefinition, 'RunbookDefinition'>>,
  Expect<SameFields<MatchedCriterion, 'MatchedCriterion'>>,
  Expect<SameFields<MissedCriterion, 'MissedCriterion'>>,
  Expect<SameFields<MatchExplanation, 'MatchExplanation'>>,
  // types-runbooks.ts: runs
  Expect<SameFields<LookupResult, 'LookupResult'>>,
  Expect<SameFields<StepEvidence, 'StepEvidence'>>,
  Expect<SameFields<StepState, 'StepState'>>,
  Expect<SameFields<RunbookRun, 'RunbookRun'>>,
  Expect<SameFields<RunbookProgress, 'RunbookProgress'>>,
  // types-runbooks.ts: responses
  Expect<SameFields<RunbookRef, 'RunbookRef'>>,
  Expect<SameFields<RunbookAppliesTo, 'RunbookAppliesTo'>>,
  Expect<SameFields<RunbookMigratedFrom, 'RunbookMigratedFrom'>>,
  Expect<SameFields<RunbookSummary, 'RunbookSummary'>>,
  Expect<SameFields<RunbookReviewNote, 'RunbookReviewNote'>>,
  Expect<SameFields<RunbookVersionDoc, 'RunbookVersionDoc'>>,
  Expect<SameFields<RunbookVersionListItem, 'RunbookVersionListItem'>>,
  Expect<SameFields<RunbookDetail, 'RunbookDetail'>>,
  Expect<SameFields<RunbookMigrationNotice, 'RunbookMigrationNotice'>>,
  Expect<SameFields<RunbookLibrary, 'RunbookLibrary'>>,
  Expect<SameFields<RunbookIssue, 'RunbookIssue'>>,
  Expect<SameFields<RunbookValidation, 'RunbookValidation'>>,
  Expect<SameFields<MatchPreviewCase, 'MatchPreviewCase'>>,
  Expect<SameFields<MatchPreviewOther, 'MatchPreviewOther'>>,
  Expect<SameFields<MatchPreviewNearMiss, 'MatchPreviewNearMiss'>>,
  Expect<SameFields<MatchPreviewCounts, 'MatchPreviewCounts'>>,
  Expect<SameFields<MatchPreview, 'MatchPreview'>>,
  Expect<SameFields<RunbookMetricsRunbookRow, 'RunbookMetricsRunbookRow'>>,
  Expect<SameFields<RunbookMetricsPhaseRow, 'RunbookMetricsPhaseRow'>>,
  Expect<SameFields<RunbookMetricsStepRow, 'RunbookMetricsStepRow'>>,
  Expect<SameFields<RunbookMetricsCohort, 'RunbookMetricsCohort'>>,
  Expect<SameFields<RunbookMetricsRecentRun, 'RunbookMetricsRecentRun'>>,
  Expect<SameFields<RunbookMetrics, 'RunbookMetrics'>>,
  Expect<SameFields<CaseRunbooks, 'CaseRunbooks'>>,
  Expect<SameFields<RunbookCandidate, 'RunbookCandidate'>>,
  Expect<SameFields<RunbookCandidates, 'RunbookCandidates'>>,
  Expect<SameFields<RunbookDiscardResult, 'RunbookDiscardResult'>>,
  Expect<SameFields<RunbookAttachResult, 'RunbookAttachResult'>>,
  Expect<SameFields<RunbookRunUpdate, 'RunbookRunUpdate'>>,
  Expect<SameFields<RunbookSuggestion, 'RunbookSuggestion'>>,
  Expect<SameFields<RunbookStepDraftResult, 'RunbookStepDraftResult'>>,
  Expect<Equal<keyof AiCallEstimate, keyof Field<'RunbookSuggestion', 'estimate'>>>,
  // types-runbooks.ts: request bodies
  Expect<SameFields<RunbookSourceBody, 'RunbookSourceBody'>>,
  Expect<SameFields<RunbookDraftBody, 'RunbookDraftBody'>>,
  Expect<SameFields<RunbookVersionBody, 'RunbookVersionBody'>>,
  Expect<SameFields<RunbookPublishBody, 'RunbookPublishBody'>>,
  Expect<SameFields<RunbookRejectBody, 'RunbookRejectBody'>>,
  Expect<SameFields<RunbookRevisionBody, 'RunbookRevisionBody'>>,
  Expect<SameFields<RunbookAttachBody, 'RunbookAttachBody'>>,
  Expect<SameFields<RunbookStepUpdate, 'RunbookStepUpdate'>>,
  Expect<SameFields<StepApprovalBody, 'StepApprovalBody'>>,
  Expect<SameFields<StepDraftConfirmBody, 'StepDraftConfirmBody'>>,
  Expect<SameFields<RunbookLookupTestBody, 'RunbookLookupTestBody'>>,
];

/** Query parameter names of the reads the lazy clients make. */
export type QueryPins = [
  Expect<Equal<keyof AuditPageQuery, keyof GetQuery<'/api/audit'>>>,
  Expect<Equal<keyof AuditCountQuery, keyof GetQuery<'/api/audit/count'>>>,
  Expect<Equal<keyof AuditRecordQuery, keyof GetQuery<'/api/audit/records/{record_id}'>>>,
  Expect<Equal<keyof MetricsBreakdownQuery, keyof GetQuery<'/api/metrics/breakdown'>>>,
  Expect<Equal<keyof RuleSummaryQuery, keyof GetQuery<'/api/rules/summary'>>>,
  // The Logs page's exact rule and severity filters (§4.6.1): an unknown query key is
  // ignored by the server, so a renamed parameter would silently stop filtering.
  Expect<Equal<keyof UnifiedLogsQuery, keyof GetQuery<'/api/logs'>>>,
  // `shape=v1` (the old list shape, kept for one release) is never asked for by the Console.
  Expect<Equal<keyof RunbookLibraryQuery, Exclude<keyof GetQuery<'/api/runbooks'>, 'shape'>>>,
];

/** Every closed vocabulary a mirror declares equals the backend's. */
export type VocabularyPins = [
  // Audit
  Expect<Equal<AuditOutcome, Field<'AuditRecord', 'outcome'>>>,
  Expect<Equal<AuditActorType, Field<'AuditRecord', 'actor_type'>>>,
  Expect<Equal<AuditCategory, Field<'AuditRecord', 'category'>>>,
  Expect<Equal<AuditTargetType, Field<'AuditTarget', 'type'>>>,
  Expect<Equal<AuditClient['ip_source'], Field<'AuditClient', 'ip_source'>>>,
  Expect<Equal<AuditCountRelation, Field<'AuditPage', 'total_relation'>>>,
  Expect<Equal<AuditCountRelation, Field<'AuditCount', 'relation'>>>,
  Expect<Equal<AuditScope, NonNullable<GetQuery<'/api/audit'>['scope']>>>,
  Expect<Equal<NonNullable<AuditPageQuery['order']>, NonNullable<GetQuery<'/api/audit'>['order']>>>,
  // Dashboards
  Expect<Equal<BreakdownKind, Field<'MetricsBreakdown', 'kind'>>>,
  Expect<Equal<BreakdownField, Field<'MetricsBreakdown', 'by'>>>,
  Expect<Equal<BreakdownField, NonNullable<GetQuery<'/api/metrics/breakdown'>['by']>>>,
  Expect<Equal<BreakdownBucket, Field<'MetricsBreakdown', 'bucket'>>>,
  Expect<Equal<BreakdownStatusGroup, Field<'MetricsBreakdown', 'status_group'>>>,
  Expect<Equal<DashboardWindow, Field<'DashboardLayoutIn', 'default_window'>>>,
  Expect<Equal<NonNullable<DashboardLayout['default_window']>, Field<'DashboardLayoutIn', 'default_window'>>>,
  // Rule summary
  Expect<Equal<RuleSectionStatus, Field<'RuleSummaryAlerts', 'status'>>>,
  Expect<Equal<RuleSectionStatus, Field<'RuleSummaryCases', 'status'>>>,
  Expect<Equal<SeverityLevel, Field<'RuleSeveritySeries', 'levels'>[number]>>,
  Expect<Equal<NonNullable<RuleSummaryDefinition['kind']>, Field<'RuleSummaryDefinition', 'kind'>>>,
  // Runbooks
  Expect<Equal<StepKind, Field<'RunbookStep', 'kind'>>>,
  Expect<Equal<PhaseId, Field<'RunbookStep', 'phase'>>>,
  Expect<Equal<StepEvidenceRule, Field<'RunbookStep', 'evidence'>>>,
  Expect<Equal<RunbookEntityType, Field<'AppliesWhen', 'entity_types'>[number]>>,
  Expect<Equal<RunbookVerdict, Field<'AppliesWhen', 'verdicts'>[number]>>,
  Expect<Equal<SeverityLevel, Field<'AppliesWhen', 'severity_at_least'>>>,
  Expect<Equal<LookupTool, Field<'LookupTemplate', 'tool'>>>,
  Expect<Equal<LookupRunMode, Field<'LookupTemplate', 'run'>>>,
  Expect<Equal<MatchCriterion, Field<'MatchedCriterion', 'criterion'>>>,
  Expect<Equal<MatchCriterion, Field<'MissedCriterion', 'criterion'>>>,
  Expect<Equal<LookupResultStatus, Field<'LookupResult', 'status'>>>,
  Expect<Equal<NonNullable<LookupResult['table_kind']>, Field<'LookupResult', 'table_kind'>>>,
  Expect<Equal<StepEvidence['kind'], Field<'StepEvidence', 'kind'>>>,
  Expect<Equal<StepStatus, Field<'StepState', 'status'>>>,
  Expect<Equal<StepStatus, Field<'RunbookStepUpdate', 'status'>>>,
  Expect<Equal<StepApprovalBody['decision'], Field<'StepApprovalBody', 'decision'>>>,
  Expect<Equal<RunAttachedBy, Field<'RunbookRun', 'attached_by'>>>,
  Expect<Equal<RunStatus, Field<'RunbookRun', 'status'>>>,
  Expect<Equal<RunbookOrigin, Field<'RunbookSummary', 'origin'>>>,
  Expect<Equal<RunbookState, Field<'RunbookSummary', 'state'>>>,
  Expect<Equal<RunbookState, NonNullable<GetQuery<'/api/runbooks'>['state']>>>,
  Expect<Equal<RunbookOrigin, NonNullable<GetQuery<'/api/runbooks'>['origin']>>>,
  Expect<Equal<RunbookVersionState, Field<'RunbookVersionDoc', 'state'>>>,
  Expect<Equal<RunbookCandidate['group'], Field<'RunbookCandidate', 'group'>>>,
  // Jobs
  Expect<Equal<BackgroundJobKind, S['JobKind']>>,
];

/** The Round 14 fields `types.ts` mirrors on existing models. */
export type ExistingModelPins = [
  Expect<Equal<Extract<KnownKeys<Case>, 'runbook_id' | 'runbook_version'>, Extract<keyof S['Case'], 'runbook_id' | 'runbook_version'>>>,
  Expect<Equal<Extract<KnownKeys<DashboardLayout>, 'default_window' | 'derived_from'>, 'default_window' | 'derived_from'>>,
  Expect<Equal<Extract<keyof S['DashboardLayoutIn'], 'default_window' | 'derived_from'>, 'default_window' | 'derived_from'>>,
];

/**
 * The job params `tsc` checks on a submit. `JobSubmit.params` is a free object in the
 * schema, so these mirrors are compared with `routes_jobs.py` at runtime
 * (`round14-client.test.ts`); here the submit type is pinned to them.
 */
export type JobParamsPins = [
  Expect<Equal<Exclude<keyof BackgroundJobParamsByKind, BackgroundJobKind>, never>>,
  Expect<Equal<BackgroundJobSubmit<'case_lifecycle'>['params'], CaseLifecycleParams>>,
  Expect<Equal<BackgroundJobSubmit<'audit_export'>['params'], AuditExportJobParams>>,
  Expect<Equal<BackgroundJobSubmit<'tiered_reset'>['params'], Record<string, unknown>>>,
  // A bulk helper's input never carries the selection or a single-case field.
  Expect<Equal<Extract<keyof CaseLifecycleInput, 'case_ids' | 'require_open_steps_reason'>, never>>,
  Expect<Equal<keyof CaseLifecycleInput, Exclude<keyof CaseLifecycleParams, 'case_ids'>>>,
  // The bulk close and resolve dialog's input is a `case_lifecycle` input: Cases and
  // Case Manager spread it into the job's params, and a spread field escapes the
  // excess property check, so a field the strict server model refuses (for example
  // `require_open_steps_reason`) must fail here instead of turning the job into a 422.
  Expect<Equal<Exclude<keyof BulkCloseInput, keyof CaseLifecycleInput>, never>>,
  Expect<BulkCloseInput extends CaseLifecycleInput ? true : false>,
];
