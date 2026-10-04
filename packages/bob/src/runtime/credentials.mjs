import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export function apiKeyFromEnvironment() {
  const value = process.env.BOB_API_KEY;

  return isString(value) && value.trim() ? value : undefined;
}

export async function loadApiKey() {
  const inherited = apiKeyFromEnvironment();

  if (inherited) return inherited;
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");

  if (!isAbsolute(configHome)) throw new Error("Bob Gateway configuration home must be absolute");
  const path = join(configHome, "bob-gateway", "config.json");

  try {
    if (process.platform !== "win32") {
      const parentPath = dirname(path);
      const [parent, canonicalParent] = await Promise.all([lstat(parentPath), realpath(parentPath)]);

      if (!parent.isDirectory() || parent.isSymbolicLink() || canonicalParent !== parentPath || (parent.mode & 0o077) !== 0) throw new Error("unsafe");
    }

    const handle = await open(path, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
    let content;

    try {
      const metadata = await handle.stat();

      if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new Error("unsafe");
      content = await handle.readFile();
    } finally {
      await handle.close();
    }

    const parsed = JSON.parse(content.toString("utf8"));

    if (Object.prototype.toString.call(parsed) !== "[object Object]" || Object.keys(parsed).length !== 1 ||
        !isString(parsed.apiKey) || !parsed.apiKey.trim()) throw new Error("schema");

    return parsed.apiKey;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Unable to load Bob Gateway configuration");
  }
}

function isString(value) { return Object.prototype.toString.call(value) === "[object String]"; }
