import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { writeManagedConfig } from "./managed-config.js";
import { BobError } from "../sdk/errors.js";
import type { BobManagedMcpServer } from "../sdk/types.js";
import { isRecord, isString, type JsonObject } from "../utils/type-guards.js";

const MAX_BYTES = 1024 * 1024;

const MARKER = "$bobGatewayManagedMcp";

/** Snapshot before any await. Only the two supported ACP server shapes are translated. */
export function serializeManagedMcp(servers: BobManagedMcpServer[] | undefined, disableMcp?: boolean): string | undefined {
  if (servers === undefined) return undefined;

  try {
    if (!Array.isArray(servers) || servers.length > 128 || disableMcp === true) throw new Error();
    const entries: [string, JsonObject][] = [];
    const names = new Set<string>();

    for (const input of servers) {
      if (!isRecord(input)) throw new Error();
      const server = { ...input };

      if (!validName(server.name) || names.has(server.name)) throw new Error();
      names.add(server.name);
      const disabledTools = server.disabledTools === undefined ? [] : stringList(server.disabledTools, true);
      const approval: JsonObject = server.alwaysAllow === undefined ? {} : { alwaysAllow: stringList(server.alwaysAllow, true) };
      let config: JsonObject;

      if ("type" in server) {
        if (server.type !== "http" || Object.keys(server).some((key) => !["name", "type", "url", "headers", "disabledTools", "alwaysAllow"].includes(key))) throw new Error();

        if (!validString(server.url)) throw new Error();
        const url = new URL(server.url);

        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
        config = { url: server.url, headers: pairs(server.headers, "header"), disabledTools, ...approval };
      } else {
        if (Object.keys(server).some((key) => !["name", "command", "args", "env", "disabledTools", "alwaysAllow"].includes(key))) throw new Error();

        if (!validString(server.command) || !isAbsolute(server.command)) throw new Error();
        config = { command: server.command, args: stringList(server.args), env: pairs(server.env, "env"), disabledTools, ...approval };
      }

      entries.push([server.name, config]);
    }

    const mcpServers = Object.fromEntries(entries);
    const text = JSON.stringify({ [MARKER]: { version: 1, sha256: digest(JSON.stringify(mcpServers)) }, mcpServers }, null, 2) + "\n";

    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();

    return text;
  } catch { throw new BobError("configuration_invalid"); }
}

/** Persistent, explicitly managed configuration. Never cleans up caller files.
 * The application must exclude other writers/Bob workers for this workspace. */
export function writeManagedMcp(workspace: string, text: string | undefined): void {
  writeManagedConfig(workspace, "mcp.json", text, (previous) => {
    const existing: unknown = JSON.parse(previous);

    return isRecord(existing) && Object.keys(existing).length === 2 && isRecord(existing.mcpServers)
      && isRecord(existing[MARKER]) && existing[MARKER].version === 1
      && existing[MARKER].sha256 === digest(JSON.stringify(existing.mcpServers));
  });
}

function pairs<T>(value: T, kind: "env" | "header"): JsonObject {
  if (!Array.isArray(value) || value.length > 1024) throw new Error();
  const seen = new Set<string>();

  const entries = value.map((input) => {
    if (!isRecord(input)) throw new Error();
    const pair = { ...input };

    if (Object.keys(pair).some((key) => key !== "name" && key !== "value") || !validString(pair.name)
      || !isString(pair.value) || pair.value.includes("\0")) throw new Error();

    if (kind === "env" ? pair.name.includes("=") : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair.name) || /[\r\n]/.test(pair.value)) throw new Error();
    const key = kind === "header" ? pair.name.toLowerCase() : pair.name;

    if (seen.has(key)) throw new Error();
    seen.add(key);

    return [pair.name, pair.value];
  });

  return Object.fromEntries(entries);
}

function stringList<T>(value: T, names = false): string[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error();

  const result = value.map((item) => {
    if (!isString(item) || item.includes("\0") || (names && !validName(item))) throw new Error();

    return item;
  });

  if (names && new Set(result).size !== result.length) throw new Error();

  return result;
}

function validName<T>(value: T): value is T & string {
  return validString(value) && value.length <= 256 && !["__proto__", "constructor", "prototype"].includes(value) && !/[\r\n]/.test(value);
}

function validString<T>(value: T): value is T & string { return isString(value) && value.trim().length > 0 && !value.includes("\0"); }

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
