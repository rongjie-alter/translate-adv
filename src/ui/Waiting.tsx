/**
 * "Waiting 12s — …" line with a live countdown, shared by the bulk and retranslate views.
 */
import { useEffect, useState } from "preact/hooks";

/** What the hooks keep for a pause: `until` is absolute so the countdown survives re-renders. */
export interface WaitState {
  ms: number;
  reason: string;
  until: number;
}

export function waitState(e: { ms: number; reason: string }): WaitState {
  return { ms: e.ms, reason: e.reason, until: Date.now() + e.ms };
}

export function Waiting({ wait }: { wait: WaitState | null }) {
  const [now, setNow] = useState(() => Date.now());
  const until = wait?.until;

  useEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [until]);

  // Once the pause is over the request is in flight; nothing clears `waiting` until the
  // next chunk starts, so hide it here rather than show "Waiting 0s".
  if (!wait || wait.until <= now) return null;
  const secs = Math.ceil((wait.until - now) / 1000);
  return (
    <p class="waiting">
      {wait.reason === "retry" ? `Retrying in ${secs}s` : `Waiting ${secs}s`} — {waitReason(wait.reason)}
    </p>
  );
}

function waitReason(reason: string): string {
  switch (reason) {
    case "rpm":
      return "requests-per-minute limit";
    case "tpm":
      return "tokens-per-minute limit";
    case "rpd":
      return "daily request quota";
    case "backoff":
      return "the endpoint asked us to slow down";
    case "retry":
      return "the last request failed";
    default:
      return reason;
  }
}
