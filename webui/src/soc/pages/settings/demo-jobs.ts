/**
 * Why a Job submitter is disabled in Demo Mode (Round 16 B49). Durable jobs never run in
 * Demo Mode: the server refuses them (`409`), so each submitter on the setup and
 * administration pages is disabled with one of these plain reasons and sends nothing.
 */

/** Settings, Data export. */
export const DEMO_EXPORT_REASON =
  'Data exports are not available in Demo Mode. Turn Demo Mode off to export.';

/** Every other Job submitter: the storage apply, the resets, the Knowledge jobs. */
export const DEMO_JOB_REASON =
  'Background jobs are not available in Demo Mode. Turn Demo Mode off to run this.';
