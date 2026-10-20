import type { RequestInfo } from "@ivy/kernel";
import { compact, type SessionEvent } from "@ivy/protocol";

type StepEvent = Extract<SessionEvent, { type: "step" }>;

/**
 * One line per model call, printed when it returns. Only what changes per call; static
 * state (model, effort, tools, capabilities) is in the status bar and /status.
 *
 * "step 1 · 5 msgs · context block · end_turn · in 50 out 20 · cache read 3.2k write 120 · 1.5s"
 */
export function formatCall(e: StepEvent, request?: RequestInfo): string {
  const u = e.usage;
  const read = u.cacheRead;
  const write = u.cacheWrite;
  const parts = [`step ${e.step}`];
  if (request) {
    parts.push(`${request.messages} msgs`);
    if (request.hasContext) parts.push(`context ${request.contextMode}`);
  }
  parts.push(e.stopReason ?? "?", `in ${compact(u.input)} out ${compact(u.output)}`);
  if (read > 0 || write > 0) parts.push(`cache read ${compact(read)} write ${compact(write)}`);
  parts.push(`${(e.latencyMs / 1000).toFixed(1)}s`);
  if (request && !sameModel(request.model, e.model)) parts.push(`served by ${e.model}`);
  return parts.join(" · ") + (e.traceFile ? `\n  trace: ${e.traceFile}` : "");
}

/**
 * Proxies often report a model without its routing prefix ("vendor/model-a" → "model-a");
 * that is the same model, not a switch.
 */
function sameModel(requested: string, served: string): boolean {
  return (
    requested === served || requested.endsWith(`/${served}`) || served.endsWith(`/${requested}`)
  );
}
