/**
 * "View all fields": every stored field of the case in a searchable JSON tree with Copy
 * and Download (Round 16 SPEC §4.3 WP01 stub; WP14 fills it; cost values withheld
 * without `cost:view`). Until WP14 lands it renders nothing.
 */
import type * as React from 'react';

export interface AllFieldsSheetProps {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AllFieldsSheet: React.FC<AllFieldsSheetProps> = () => null;
