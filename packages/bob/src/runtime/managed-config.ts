import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BobError } from "../sdk/errors.js";

/** Internal startup-only writer. The caller must exclude other writers/workers. */
export function writeManagedConfig(workspace: string, filename: "mcp.json" | "custom_modes.yaml", text: string | undefined, owns: (previous: string) => boolean): void {
  if (text === undefined) return;
  let temporary: string | undefined;

  try {
    const directory = join(workspace, ".bob");

    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }

    const identity = lstatSync(directory);

    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error();
    const target = join(directory, filename);
    const previous = readConfig(target);

    if (previous !== undefined && !owns(previous)) throw new Error();
    temporary = join(directory, `.gateway-config-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);

    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }

    const current = lstatSync(directory);

    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || readConfig(target) !== previous) throw new Error();

    if (previous === undefined) linkSync(temporary, target);
    else { renameSync(temporary, target); temporary = undefined; }
  } catch { throw new BobError("configuration_invalid"); }
  finally { if (temporary) { try { unlinkSync(temporary); } catch { /* do not mask the primary configuration error */ } } }
}

function readConfig(path: string): string | undefined {
  let fd: number;

  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error();

    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function hasCode<T>(error: T, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
