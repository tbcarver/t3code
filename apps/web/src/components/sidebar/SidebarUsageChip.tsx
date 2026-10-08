import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { useNavigate, useParams } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const WARNING_AT_PERCENT = 20;
const ERROR_AT_PERCENT = 5;

type Driver = ServerProvider["driver"];

// The chip unmounts on the Settings and Usage pages, where the footer shows only Back.
// Module scope keeps the last open thread's provider across them, so coming back to a
// route without a thread (home) still shows the provider being worked with.
let lastOpenDriver: Driver | undefined;

/** The driver of a provider instance, looking in the thread's own environment first. */
function driverOf(
  configs: ReturnType<typeof useServerConfigs>,
  instanceId: ProviderInstanceId,
  environmentId: EnvironmentId | null,
): Driver | undefined {
  const own =
    environmentId === null
      ? undefined
      : configs
          .get(environmentId)
          ?.providers.find((provider) => provider.instanceId === instanceId);
  if (own) return own.driver;
  for (const config of configs.values()) {
    const found = config.providers.find((provider) => provider.instanceId === instanceId);
    if (found) return found.driver;
  }
  return undefined;
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
 * The session quota left for the provider of the thread that is open, in the free space of
 * the sidebar footer row. The thread only picks the provider: the number is the Usage
 * page's own, merged across every connected environment from its freshest reads, so it
 * never differs from that page or jumps as you move between threads on different servers.
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
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const now = Date.parse(`${useNowMinute()}:00.000Z`);

  const threadEnvironmentId = thread?.environmentId ?? null;
  const threadInstanceId =
    thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId ?? null;
  const driver = useMemo(() => {
    if (threadRef !== null) {
      return threadInstanceId === null
        ? undefined
        : driverOf(serverConfigs, threadInstanceId, threadEnvironmentId);
    }
    return draftProvider === null
      ? undefined
      : driverOf(serverConfigs, draftProvider, draftEnvironmentId);
  }, [
    draftEnvironmentId,
    draftProvider,
    serverConfigs,
    threadEnvironmentId,
    threadInstanceId,
    threadRef,
  ]);
  useEffect(() => {
    if (driver !== undefined) lastOpenDriver = driver;
  }, [driver]);

  const pools = useMemo(
    () => collectLimitPools(collectLimitAccounts(presentations), now),
    [presentations, now],
  );
  const openUsage = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  // With a thread open, only its own provider counts: another provider's number would
  // read as this thread's. Without one, use the last open thread's provider, then the
  // first provider that reports a quota.
  const wantedDriver = threadRef !== null ? driver : (driver ?? lastOpenDriver);
  const pool =
    threadRef !== null && wantedDriver === undefined
      ? undefined
      : wantedDriver === undefined
        ? pools[0]
        : pools.find((candidate) => candidate.driver === wantedDriver);
  const window = pool ? chipWindow(pool) : null;
  if (pool === undefined || window === null) return null;

  const remaining = window.remainingPercent;
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);

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
            <span className="font-medium">{label}</span>
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
