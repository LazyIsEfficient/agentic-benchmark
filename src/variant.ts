import type { VariantManifest } from "./types.js";

/** The `type` values a manifest may declare. */
const VALID_TYPES = ["claude-md", "bundle"] as const;

/**
 * Parse + validate a `prompts/<name>/variant.json` payload into a fully-defaulted
 * VariantManifest. Applies defaults (`type:"claude-md"`, `claudeMd:"CLAUDE.md"`,
 * `configDir:"claude"`, `install:"copy"`) and rejects malformed input.
 * Pure/unit-testable.
 *
 * An ABSENT manifest is handled by the caller (defaults to claude-md); this
 * function validates a manifest that IS present.
 */
export function parseVariantManifest(json: unknown): VariantManifest {
  if (typeof json !== "object" || json === null) {
    throw new Error("variant.json must be a JSON object.");
  }
  const obj = json as Record<string, unknown>;

  const type = obj["type"] ?? "claude-md";
  if (type !== "claude-md" && type !== "bundle") {
    throw new Error(
      `variant.json "type" must be one of ${VALID_TYPES.join(" | ")}, got ${JSON.stringify(type)}.`,
    );
  }

  const str = (key: string, fallback: string): string => {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`variant.json "${key}" must be a non-empty string if present.`);
    }
    return v;
  };

  const install = obj["install"] ?? "copy";
  if (install !== "copy" && install !== "setup") {
    throw new Error(
      `variant.json "install" must be one of copy | setup, got ${JSON.stringify(install)}.`,
    );
  }

  const setupCommand = obj["setupCommand"];
  if (
    setupCommand !== undefined &&
    (typeof setupCommand !== "string" || setupCommand.trim().length === 0)
  ) {
    throw new Error(`variant.json "setupCommand" must be a non-empty string if present.`);
  }
  if (install === "setup" && setupCommand === undefined) {
    throw new Error(`variant.json "install":"setup" requires a "setupCommand".`);
  }

  const description = obj["description"];
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`variant.json "description" must be a string if present.`);
  }

  return {
    type,
    claudeMd: str("claudeMd", "CLAUDE.md"),
    configDir: str("configDir", "claude"),
    install,
    ...(setupCommand !== undefined ? { setupCommand } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}
