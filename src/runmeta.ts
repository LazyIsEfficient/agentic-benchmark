import { HORIZON_MS } from "./config.js";

/** Fixed width = digit count of HORIZON_MS, so every key zero-pads identically. */
const REVKEY_WIDTH = String(HORIZON_MS).length;

/**
 * Reverse-time key: `HORIZON_MS - epochMs`, zero-padded to a fixed width. A newer
 * run yields a SMALLER key, so a plain ascending lexical sort of folder names
 * lists the newest run first. Fixed width keeps the lexical order numerically
 * correct. Pure.
 */
export function revTimeKey(epochMs: number): string {
  const value = Math.max(0, HORIZON_MS - epochMs);
  return String(value).padStart(REVKEY_WIDTH, "0");
}

/** Filesystem-safe UTC stamp: `2026-07-08T15-30-00Z` (colons/ms stripped). */
export function isoStamp(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

/** First 8 hex chars of the run GUID — a short, readable folder discriminator. */
export function shortId(runId: string): string {
  return runId.replace(/-/g, "").slice(0, 8);
}

/**
 * Per-execution folder name: `<revkey>__<iso>__<short8>`. The reverse-time key
 * leads so ascending sort = newest-first; the human ISO stamp and short GUID
 * follow for readability. The full GUID lives in report.json / report.md.
 */
export function buildRunFolderName(runId: string, epochMs: number): string {
  return `${revTimeKey(epochMs)}__${isoStamp(epochMs)}__${shortId(runId)}`;
}
