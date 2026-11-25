/**
 * The audit inspector's JSON tree (Round 14 SPEC §4.5.2). It moved to
 * `soc/components/JsonTree.tsx` (Round 16 SPEC §4.5 WP14), which the case records share;
 * this module re-exports it so existing imports keep working.
 */
export { JsonTree, type JsonTreeProps } from '@/soc/components/JsonTree';
