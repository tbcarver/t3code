import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { useNavigate, useParams } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const WARNING_AT_PERCENT = 20;
const ERROR_AT_PERCENT = 5;

/** Which subscription account a provider instance is signed in to. */
interface AccountIdentity {
  readonly driver: ServerProvider["driver"];
  readonly email: string | undefined;
  readonly credentialFingerprint: string | undefined;
}

// The chip unmounts on the Settings and Usage pages, where the footer shows only Back.
// Module scope keeps the last open thread's account across them, so coming back to a
// route without a thread (home) still shows the account being worked with.
let lastOpenIdentity: AccountIdentity | undefined;

function normalizedEmail(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

/** The provider instance, looking in the thread's own environment first. */
function providerOf(
  configs: ReturnType<typeof useServerConfigs>,
  instanceId: ProviderInstanceId,
  environmentId: EnvironmentId | null,
): ServerProvider | undefined {
  const own =
    environmentId === null
      ? undefined
      : configs
          .get(environmentId)
          ?.providers.find((provider) => provider.instanceId === instanceId);
  if (own) return own;
  for (const config of configs.values()) {
    const found = config.providers.find((provider) => provider.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

function identityOf(provider: ServerProvider): AccountIdentity {
  return {
    driver: provider.driver,
    email: normalizedEmail(provider.auth.email),
    credentialFingerprint: provider.usageLimits?.credentialFingerprint,
  };
}

/** The email names the account; a credential fingerprint stands in when none is reported. */
function accountFor(
  accounts: readonly LimitAccount[],
  identity: AccountIdentity,
): LimitAccount | undefined {
  return accounts.find(
    (account) =>
      account.driver === identity.driver &&
      (identity.email !== undefined
        ? normalizedEmail(account.email) === identity.email
        : identity.credentialFingerprint !== undefined &&
          account.limits.credentialFingerprint === identity.credentialFingerprint),
  );
}

/** The session window when the provider has one, else whichever window has the least left. */
function chipWindow(pool: LimitPool): LimitPoolWindow | null {
  const session = pool.windows.find((window) => window.kind === "session");
  if (session) return session;
  let lowest: LimitPoolWindow | null = null;
  for (const window of pool.windows) {
    if (lowest === null || window.remainingPercent < lowest.remainingPercent) lowest = window;
  }
  return lowest;
}

/**
 * The session quota left for the account the open thread runs on, in the free space of
 * the sidebar footer row. The thread picks the account: its provider instance's signed-in
 * email, matched to the Usage page's merged accounts, so the number is that one account's
 * own reading (the Usage page's, from the freshest read of it across every environment)
 * and never an average over accounts the thread does not use.
 * Reads data the app already has; repaints at most once a minute on the shared clock.
 */
export const SidebarUsageChip = memo(function SidebarUsageChip() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const draftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const thread = useThreadShell(threadRef);
  // A new session has no thread yet: its provider is the one picked in the composer.
  const draftProvider = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getComposerDraft(draftId)?.activeProvider ?? null),
  );
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.environmentId ?? null),
  );
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const now = Date.parse(`${useNowMinute()}:00.000Z`);

  const threadEnvironmentId = thread?.environmentId ?? null;
  const threadInstanceId = thread?.providerInstanceId ?? thread?.modelSelection.instanceId ?? null;
  const identity = useMemo(() => {
    const provider =
      threadRef !== null
        ? threadInstanceId === null
          ? undefined
          : providerOf(serverConfigs, threadInstanceId, threadEnvironmentId)
        : draftProvider === null
          ? undefined
          : providerOf(serverConfigs, draftProvider, draftEnvironmentId);
    return provider ? identityOf(provider) : undefined;
  }, [
    draftEnvironmentId,
    draftProvider,
    serverConfigs,
    threadEnvironmentId,
    threadInstanceId,
    threadRef,
  ]);
  useEffect(() => {
    if (identity !== undefined) lastOpenIdentity = identity;
  }, [identity]);

  const accounts = useMemo(() => collectLimitAccounts(presentations), [presentations]);
  const openUsage = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  // With a thread open, only its own account counts: another account's number would read
  // as this thread's. Without one, use the last open thread's account, then the first
  // account signed in on this machine.
  const wantedIdentity = threadRef !== null ? identity : (identity ?? lastOpenIdentity);
  const account =
    threadRef !== null && wantedIdentity === undefined
      ? undefined
      : wantedIdentity === undefined
        ? accounts.find((candidate) =>
            candidate.environments.some((entry) => entry.environmentId === primaryEnvironmentId),
          )
        : accountFor(accounts, wantedIdentity);
  const pool = useMemo(
    () => (account ? collectLimitPools([account], now)[0] : undefined),
    [account, now],
  );
  const window = pool ? chipWindow(pool) : null;
  if (account === undefined || pool === undefined || window === null) return null;

  const remaining = window.remainingPercent;
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={`${label} ${window.label}: ${remaining}% left`}
              className="w-auto"
              onClick={openUsage}
            >
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={label}
                indicatorBackground="var(--sidebar)"
                className="size-4"
                iconClassName="size-4"
              />
              <span
                className={
                  remaining <= ERROR_AT_PERCENT
                    ? "tabular-nums text-error"
                    : remaining <= WARNING_AT_PERCENT
                      ? "tabular-nums text-warning"
                      : "tabular-nums"
                }
              >
                {remaining}%
              </span>
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">
              {account.email ? `${label} · ${account.email}` : label}
            </span>
            {pool.windows.map((entry) => {
              const resetAt = entry.resets[0]?.at;
              return (
                <span key={entry.id} className="tabular-nums">
                  {entry.label}: {entry.remainingPercent}% left
                  {resetAt === undefined
                    ? ""
                    : resetAt <= now
                      ? " · resets now"
                      : ` · resets in ${formatDuration(resetAt - now)}`}
                </span>
              );
            })}
          </div>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});
