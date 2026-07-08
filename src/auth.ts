import fs from "node:fs";
import { OAUTH_TOKEN_ENV, OAUTH_TOKEN_FILE } from "./config.js";

/**
 * Pure token-selection logic: env value wins over the file value; either must be
 * non-empty after trimming; otherwise throw a clear, actionable error. Pure so
 * the precedence is directly unit-testable without touching the filesystem.
 */
export function pickToken(
  envValue: string | undefined,
  fileValue: string | null,
): string {
  if (envValue && envValue.trim().length > 0) return envValue.trim();
  if (fileValue && fileValue.trim().length > 0) return fileValue.trim();
  throw new Error(
    `No Claude OAuth token found. Export ${OAUTH_TOKEN_ENV} or run \`npm run setup-auth\` to create ${OAUTH_TOKEN_FILE}.`,
  );
}

/** Read the token file if present; null on any read error (missing/unreadable). */
function readTokenFile(): string | null {
  try {
    return fs.readFileSync(OAUTH_TOKEN_FILE, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the subscription OAuth token: `CLAUDE_CODE_OAUTH_TOKEN` env var first,
 * then the `.bench-config/oauth-token` file. Throws if neither is available.
 */
export function resolveOAuthToken(): string {
  return pickToken(process.env[OAUTH_TOKEN_ENV], readTokenFile());
}

/** Non-throwing check used by preflight to fail fast with a friendly message. */
export function hasOAuthToken(): boolean {
  try {
    resolveOAuthToken();
    return true;
  } catch {
    return false;
  }
}
