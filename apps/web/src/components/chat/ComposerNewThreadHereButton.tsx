import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { SquarePenIcon } from "lucide-react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import type { Thread } from "../../types";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Same as the thread menu's "New thread on <branch>", shown only for worktree threads. */
export function ComposerNewThreadHereButton({ thread }: { thread: Thread | undefined }) {
  const handleNewThread = useNewThreadHandler();
  if (!thread?.worktreePath || !thread.branch) return null;
  const label = `New thread on ${thread.branch}`;
  const startThread = async () => {
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        envMode: "worktree",
        startFromOrigin: false,
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void startThread()}
            aria-label={label}
          />
        }
      >
        <SquarePenIcon />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
