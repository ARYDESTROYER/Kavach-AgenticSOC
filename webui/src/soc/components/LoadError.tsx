/**
 * LoadError — the ONE reusable "this surface failed to load" panel.
 *
 * Round-5 W0-B B5: promotes the inline `LoadError` of the old catalog page (since Round 14
 * the Runbooks library, `pages/Runbooks.tsx`, and `pages/Personas.tsx`, both of which use
 * this component) into a shared component so every page that fetches data shows the same
 * destructive alert + Retry affordance instead of re-rolling the markup. The Codemod wave
 * (CM6) migrates the ~25 hand-rolled copies onto this.
 *
 * The `error` is coerced through `errorMessage()` (built on `ApiError`) and rendered as
 * PLAIN text (#9) — the backend `detail` can carry operator-/log-derived strings, so it
 * is never treated as HTML.
 *
 * Props:
 *   - `error`   — the caught value (any shape); coerced to a message.
 *   - `title`   — the alert heading (e.g. "Couldn't load cases").
 *   - `onRetry` — optional; when provided a Retry button is shown that calls it (pair it
 *     with `useAsync().reload`). Omit it for a non-retryable failure.
 *   - `fallback`/`className`/`retryLabel` — presentational overrides.
 */
import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { errorMessage } from '@/lib/errorMessage';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';

export interface LoadErrorProps {
  error: unknown;
  title: string;
  onRetry?: () => void;
  fallback?: string;
  retryLabel?: string;
  className?: string;
}

export const LoadError: React.FC<LoadErrorProps> = ({
  error,
  title,
  onRetry,
  fallback,
  retryLabel = 'Retry',
  className,
}) => (
  <Alert variant="destructive" className={className}>
    <AlertTriangle aria-hidden />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="space-y-2">
      <p className="break-words">{errorMessage(error, fallback)}</p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden />
          {retryLabel}
        </Button>
      ) : null}
    </AlertDescription>
  </Alert>
);

LoadError.displayName = 'LoadError';
