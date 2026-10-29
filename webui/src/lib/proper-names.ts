/**
 * Proper names for machine tokens (Round 14, SPEC §4.9.4: "QRadar" spelled correctly).
 *
 * `humanizeToken` turns a token into sentence case ("qradar" becomes "Qradar"), which
 * misspells product names and acronyms. `properName` looks the token up here first and
 * falls back to `humanizeToken`, so a source type, an ingest transport or a corpus name
 * reads the way its owner writes it. Keys are the lower-case wire tokens.
 *
 * Kept as its own small module (plain data plus one function): the setup wizard is an
 * entry module and imports it, so it adds only these few bytes to first paint.
 */
import { humanizeToken } from './format';

// A Map, not an object literal: a token is source-controlled text, and a lookup must
// never resolve "constructor" or "__proto__" to an inherited property.
const PROPER_NAMES: ReadonlyMap<string, string> = new Map([
  ['qradar', 'QRadar'],
  ['mitre', 'MITRE'],
  ['opensearch', 'OpenSearch'],
  ['crowdstrike', 'CrowdStrike'],
  ['sentinelone', 'SentinelOne'],
  ['hec', 'HEC'],
  ['otlp', 'OTLP'],
  ['nats', 'NATS'],
  ['mqtt', 'MQTT'],
  ['rabbitmq', 'RabbitMQ'],
  ['redis_streams', 'Redis Streams'],
  ['aws_sqs', 'AWS SQS'],
  ['aws_kinesis', 'AWS Kinesis'],
  ['azure_event_hub', 'Azure Event Hub'],
  ['azure_blob', 'Azure Blob'],
  ['gcp_pubsub', 'GCP Pub/Sub'],
  ['s3', 'S3'],
  ['gcs', 'GCS'],
  ['push_http', 'Push HTTP'],
]);

/** The display name of a machine token: its proper name when it has one, else sentence case. */
export function properName(token?: string | null): string {
  if (token) {
    const known = PROPER_NAMES.get(token.trim().toLowerCase());
    if (known) return known;
  }
  return humanizeToken(token);
}
