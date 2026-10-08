import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  formatResetsIn,
  remainingPercent,
  usageLimitsMeterWindow,
  windowExpired,
} from "@t3tools/shared/usageLimits";
import { useNavigate, useParams } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";

const WARNING_AT_PERCENT = 20;
const ERROR_AT_PERCENT = 5;

interface ProviderTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

// The chip unmounts on the Settings and Usage pages, where the footer shows only Back.
// Module scope keeps the last open thread's provider across them, so coming back to a
// route without a thread (home, a new draft) still shows the provider being worked with.
let lastOpenThreadProvider: ProviderTarget | null = null;

function findProvider(
  configs: ReturnType<typeof useServerConfigs>,
  target: ProviderTarget,
): ServerProvider | undefined {
  return configs
    .get(target.environmentId)
    ?.providers.find((provider) => provider.instanceId === target.instanceId);
}

/**
 * The session quota left on the provider of the thread that is open, in the free space
 * of the sidebar footer row. It reads the same per-instance snapshot the composer's
 * /usage-limits does, so it adds no requests, and repaints at most once a minute on the
 * shared clock. A reading whose window has rolled over shows a dash, never its number.
 * Click opens the Usage page; the tooltip lists every window with its reset.
 */
export const SidebarUsageChip = memo(function SidebarUsageChip() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const thread = useThreadShell(threadRef);
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const now = Date.parse(`${useNowMinute()}:00.000Z`);

  const threadEnvironmentId = thread?.environmentId ?? null;
  const threadInstanceId =
    thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId ?? null;
  const threadTarget = useMemo<ProviderTarget | null>(
    () =>
      threadEnvironmentId !== null && threadInstanceId !== null
        ? { environmentId: threadEnvironmentId, instanceId: threadInstanceId }
        : null,
    [threadEnvironmentId, threadInstanceId],
  );
  useEffect(() => {
    if (threadTarget !== null) lastOpenThreadProvider = threadTarget;
  }, [threadTarget]);

  const openUsage = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  // With a thread open, only its own provider counts: another provider's number would
  // read as this thread's. Without one, fall back to the last open thread's provider,
  // then to the first provider on this machine that reports a quota.
  let provider: ServerProvider | undefined;
  if (threadRef !== null) {
    provider = threadTarget !== null ? findProvider(serverConfigs, threadTarget) : undefined;
  } else {
    provider =
      lastOpenThreadProvider !== null
        ? findProvider(serverConfigs, lastOpenThreadProvider)
        : undefined;
    if (provider === undefined && primaryEnvironmentId !== null) {
      provider = serverConfigs
        .get(primaryEnvironmentId)
        ?.providers.find((candidate) => usageLimitsMeterWindow(candidate.usageLimits) !== null);
    }
  }

  const window = provider ? usageLimitsMeterWindow(provider.usageLimits) : null;
  if (provider === undefined || window === null) return null;

  const stale = windowExpired(window, now);
  const remaining = remainingPercent(window);
  const providerLabel = provider.displayName?.trim() || String(provider.driver);
  const fillColor = stale
    ? "transparent"
    : remaining <= ERROR_AT_PERCENT
      ? "var(--color-error)"
      : remaining <= WARNING_AT_PERCENT
        ? "var(--color-warning)"
        : barColor(provider.driver);
  const windows = provider.usageLimits?.windows ?? [];

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={openUsage}
              aria-label={
                stale
                  ? `${providerLabel} ${window.label} reading expired`
                  : `${providerLabel} ${window.label}: ${remaining}% left`
              }
              className="relative flex h-7 min-w-16 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md bg-sidebar-control-surface px-2 text-xs text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2"
            />
          }
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 opacity-35"
            style={{ width: stale ? 0 : `${remaining}%`, backgroundColor: fillColor }}
          />
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={providerLabel}
            indicatorBackground="var(--sidebar)"
            className="relative size-4 shrink-0"
            iconClassName="size-3.5 text-foreground/80"
          />
          <span className="relative font-semibold tabular-nums">
            {stale ? "–" : `${remaining}%`}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{providerLabel}</span>
            {windows.map((entry) => {
              const entryStale = windowExpired(entry, now);
              const resets = entryStale ? null : formatResetsIn(entry, now);
              const state = entryStale ? "reading expired" : `${remainingPercent(entry)}% left`;
              return (
                <span key={entry.id} className="tabular-nums">
                  {entry.label}: {state}
                  {resets ? ` · ${resets}` : ""}
                </span>
              );
            })}
          </div>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});
