/**
 * Page-level access for the Console pages a role may reach by a typed or shared URL
 * although the navigation does not offer them (Round 14 second acceptance pass,
 * roles-02, roles-04, roles-05 and roles-11).
 *
 * The navigation, the command palette and chat app help hide a page whose grant the
 * viewer lacks, but a link or a typed hash still opens it. Without this guard such a page
 * mounts, sends reads the server refuses (each refusal writes an Access denied audit row
 * and a console error) and then calls the refusal a load failure with a Retry that can
 * never work. Behind `PageAccess` nothing mounts without the grant, so none of the
 * page's reads is sent, and the viewer gets the page's title and one plain refusal.
 *
 * When the grants themselves could not be loaded, every check answers no although the
 * role may hold the grant. That is a load failure, not a refusal: the page says the
 * permissions could not be loaded and offers a Retry that loads them again, never "You do
 * not have access", which would send a person who holds the grant away for good.
 *
 * Outside the auth shell (an embedding or a spec with no provider) every grant is held,
 * as `hasPermission` answers when auth is off; the server checks every read again.
 */
import * as React from 'react';

import { useOptionalAuth, type AuthContextValue } from '@/soc/auth';
import { Unauthorized } from '@/soc/components/Can';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';

const ALLOW_ALL = (): boolean => true;
const NO_RELOAD = async (): Promise<void> => undefined;

/** The load-failure line a gated surface shows while the viewer's grants are unknown. */
export const GRANTS_UNKNOWN_TITLE = 'Your permissions could not be loaded.';

/**
 * True when the signed-in viewer's grants failed to load, so a denied check says nothing
 * about the role. It follows the auth context's documented contract for `hasPermission`:
 * with auth on, a signed-in viewer whose grants were read cleanly with RBAC off is allowed
 * everything, and one whose grants could not be read is denied everything (super admin
 * excepted). RBAC reported off together with a denial is therefore exactly the failed read.
 */
export function grantsUnknown(auth: AuthContextValue | null): boolean {
  if (!auth?.authEnabled || !auth.isAuthenticated || auth.rbacEnabled) return false;
  return !auth.hasPermission('cases', 'read');
}

/**
 * True for a refusal from the server (HTTP 403: the role does not hold the grant the read
 * needs). The Console reads the grants at sign-in, so a grant removed later is first
 * learned from a refusal like this one. Duck-typed on `status`, as `ApiError` carries it,
 * so a caller needs no import of the client's error class.
 */
export function isPermissionRefusal(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 403;
}

export interface PageGrants {
  /** The viewer's permission check (allow-all outside the auth shell). */
  can: (resource: string, action: string) => boolean;
  /** The grants could not be loaded, so `can` answers no for every grant (see above). */
  unknown: boolean;
  /** Load the grants again (no-op outside the auth shell). */
  reload: () => Promise<void>;
}

/** The viewer's grants, whether they are known, and a way to load them again. */
export function usePageGrants(): PageGrants {
  const auth = useOptionalAuth();
  const can = auth?.hasPermission ?? ALLOW_ALL;
  const unknown = grantsUnknown(auth);
  const refresh = auth?.refresh;
  const reload = React.useMemo(
    () =>
      refresh
        ? async () => {
            await refresh();
          }
        : NO_RELOAD,
    [refresh],
  );
  return React.useMemo(() => ({ can, unknown, reload }), [can, unknown, reload]);
}

/**
 * The viewer's permission check, or allow-all outside the auth shell (an embedding or a
 * spec with no provider). The server checks every request again.
 */
export function usePermission(): (resource: string, action: string) => boolean {
  return useOptionalAuth()?.hasPermission ?? ALLOW_ALL;
}

/**
 * The load-failure line for a surface whose grants are unknown: what failed, and a Retry
 * that loads the grants again. While the read is in flight the Retry is not offered twice.
 */
export function GrantsUnknownNotice({
  onRetry,
  fallback = 'Try again to load this page.',
  className,
}: {
  onRetry: () => Promise<void>;
  fallback?: string;
  className?: string;
}) {
  const [retrying, setRetrying] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const retry = React.useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    void onRetry().finally(() => {
      if (alive.current) setRetrying(false);
    });
  }, [onRetry, retrying]);
  return (
    <div data-testid="grants-unknown" aria-busy={retrying || undefined} className={className}>
      <LoadError title={GRANTS_UNKNOWN_TITLE} error={null} fallback={fallback} onRetry={retry} />
    </div>
  );
}

export interface PageAccessProps {
  /** The grant the page's reads need. */
  resource: string;
  action: string;
  /** The page's title, kept as its `h1` on the refusal. */
  title: string;
  /** The refusal, one plain sentence ("You do not have access to metrics."). */
  message: string;
  children: React.ReactNode;
}

/**
 * Render the page only with its grant; otherwise its title and a plain refusal, or, while
 * the grants are unknown, its title and the load failure with a Retry.
 */
export function PageAccess({ resource, action, title, message, children }: PageAccessProps) {
  const { can, unknown, reload } = usePageGrants();
  if (can(resource, action)) return <>{children}</>;
  return (
    <PageContainer variant="wide">
      <PageHeader title={title} />
      {unknown ? (
        <GrantsUnknownNotice onRetry={reload} />
      ) : (
        <div data-testid="page-access-refused">
          <Unauthorized message={message} />
        </div>
      )}
    </PageContainer>
  );
}
