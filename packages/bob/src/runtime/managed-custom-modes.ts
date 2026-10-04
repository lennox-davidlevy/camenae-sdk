import { createHash } from "node:crypto";
import { BobError } from "../sdk/errors.js";
import type { BobCustomMode, BobModeGroup, BobToolGroup } from "../sdk/types.js";
import { isRecord, isString } from "../utils/type-guards.js";
import { writeManagedConfig } from "./managed-config.js";

const TOOL_GROUPS: readonly BobToolGroup[] = ["read", "edit", "execute", "browser", "mcp", "skill", "todo", "artifact", "subtask", "subagent", "mode", "workflow"];

const MARKER = "$camenaeManagedCustomModes";

/** Snapshot and validate before startup awaits; only native mode definitions. */
export function serializeCustomModes<T>(modes: T): string | undefined {
  if (modes === undefined) return undefined;

  try {
    if (!Array.isArray(modes) || modes.length > 128) throw new Error();
    const slugs = new Set<string>();

    const customModes = modes.map((input) => {
      if (!isRecord(input)) throw new Error();
      const mode = { ...input };

      if (Object.keys(mode).some((key) => !["slug", "name", "roleDefinition", "description", "whenToUse", "customInstructions", "groups"].includes(key))) throw new Error();

      if (!isString(mode.slug) || !/^[a-zA-Z0-9-]{1,64}$/.test(mode.slug)
        || ["agent", "plan", "ask"].includes(mode.slug) || slugs.has(mode.slug)) throw new Error();
      slugs.add(mode.slug);

      const result: BobCustomMode = { slug: mode.slug, name: text(mode.name, true, 256),
        roleDefinition: text(mode.roleDefinition, true, 65536), groups: groups(mode.groups) };

      for (const key of ["description", "whenToUse", "customInstructions"] as const) {
        if (mode[key] !== undefined) result[key] = text(mode[key], false, 65536);
      }

      return result;
    });

    const sha256 = createHash("sha256").update(JSON.stringify(customModes)).digest("hex");

    // JSON is valid YAML. Escape non-ASCII code units so Bob's pre-parse Unicode
    // punctuation cleanup cannot alter instructions or break JSON quotes.
    const serialized = JSON.stringify({ [MARKER]: { version: 1, sha256 }, customModes }, null, 2)
      .replace(/[\u0080-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";

    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error();

    return serialized;
  } catch { throw new BobError("configuration_invalid"); }
}

export function writeCustomModes(workspace: string, serialized: string | undefined): void {
  writeManagedConfig(workspace, "custom_modes.yaml", serialized, (previous) => {
    const existing: unknown = JSON.parse(previous);

    // Exact bytes: unmanaged files, changed definitions/markers, extra fields,
    // and formatting edits are all refused. This is not a tamper-proof boundary.
    return isRecord(existing) && Array.isArray(existing.customModes)
      && serializeCustomModes(existing.customModes) === previous;
  });
}

function text<T>(value: T, required: boolean, maximum: number): string {
  if (!isString(value) || value.length > maximum || value.includes("\0") || (required && !value.trim())) throw new Error();

  return value;
}

function groups<T>(value: T): BobModeGroup[] {
  if (value === undefined) return [];

  if (!Array.isArray(value) || value.length > TOOL_GROUPS.length) throw new Error();
  const seen = new Set<string>();

  return value.map((entry) => {
    const name = Array.isArray(entry) ? entry[0] : entry;

    if (!TOOL_GROUPS.includes(name) || seen.has(name)) throw new Error();
    seen.add(name);

    if (!Array.isArray(entry)) return name;

    if (entry.length !== 2 || !isRecord(entry[1]) || Object.keys(entry[1]).some((key) => key !== "fileRegex")) throw new Error();
    const fileRegex = text(entry[1].fileRegex, true, 4096);
    void new RegExp(fileRegex);

    return [name, { fileRegex }];
  });
}
