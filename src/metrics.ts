import type { CallMetrics, ClaudeUsage } from "./types.js";

/** Placeholder for an absent metric — never render `undefined`/`NaN`. */
export const NA = "—";

/** ms → "12.3s", or `—` when absent. */
export function fmtSeconds(ms: number | undefined): string {
  return ms === undefined ? NA : `${(ms / 1000).toFixed(1)}s`;
}

/** token count → "45.2k", or `—` when absent. */
export function fmtTokens(n: number | undefined): string {
  return n === undefined ? NA : `${(n / 1000).toFixed(1)}k`;
}

/** USD → "$0.1234", or `—` when absent. */
export function fmtCost(usd: number | undefined): string {
  return usd === undefined ? NA : `$${usd.toFixed(4)}`;
}

/** integer → string, or `—` when absent. */
export function fmtInt(n: number | undefined): string {
  return n === undefined ? NA : String(n);
}

/**
 * Compact one-line summary of an executor call for the console, e.g.
 * `[exec 78.4s, $0.1234, 45.2k in / 3.1k out, 12 turns]`. Wall-clock is always
 * shown; optional fields are appended only when present.
 */
export function formatExecLine(m: CallMetrics): string {
  const parts = [`exec ${fmtSeconds(m.wallMs)}`];
  if (m.costUsd !== undefined) parts.push(fmtCost(m.costUsd));
  if (m.usage) {
    parts.push(`${fmtTokens(m.usage.inputTokens)} in / ${fmtTokens(m.usage.outputTokens)} out`);
  }
  if (m.numTurns !== undefined) parts.push(`${m.numTurns} turns`);
  return `[${parts.join(", ")}]`;
}

/** Coerce an unknown to a finite number, or undefined. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Coerce an unknown to a finite number, defaulting to 0 (for usage sub-fields). */
function num0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Map a claude `type:"result"` event (snake_case) into CallMetrics (camelCase).
 * `wallMs` is host-measured and always present; every CLI-derived field is
 * optional and degrades to undefined when absent. Pure — no I/O, never throws.
 */
export function parseCallMetrics(
  resultEvent: unknown,
  wallMs: number,
): CallMetrics {
  const metrics: CallMetrics = { wallMs };
  if (typeof resultEvent !== "object" || resultEvent === null) return metrics;
  const e = resultEvent as Record<string, unknown>;

  const durationMs = num(e["duration_ms"]);
  const apiMs = num(e["duration_api_ms"]);
  const numTurns = num(e["num_turns"]);
  const costUsd = num(e["total_cost_usd"]);
  if (durationMs !== undefined) metrics.durationMs = durationMs;
  if (apiMs !== undefined) metrics.apiMs = apiMs;
  if (numTurns !== undefined) metrics.numTurns = numTurns;
  if (costUsd !== undefined) metrics.costUsd = costUsd;

  const usage = e["usage"];
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    const parsed: ClaudeUsage = {
      inputTokens: num0(u["input_tokens"]),
      outputTokens: num0(u["output_tokens"]),
      cacheReadTokens: num0(u["cache_read_input_tokens"]),
      cacheCreateTokens: num0(u["cache_creation_input_tokens"]),
    };
    metrics.usage = parsed;
  }

  return metrics;
}

/**
 * Extract the LAST `type:"result"` object from a stream-json (NDJSON) blob.
 * Returns null if none is found or all lines are malformed. Pure.
 */
export function extractLastResultEvent(ndjson: string): unknown {
  const lines = ndjson.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>)["type"] === "result"
    ) {
      return parsed;
    }
  }
  return null;
}
