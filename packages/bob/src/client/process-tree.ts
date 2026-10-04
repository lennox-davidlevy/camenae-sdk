import { execFileSync } from "node:child_process";

interface ProcessIdentity { pid: number; parent: number; group: number; started: string }

/** No command lines or environments are inspected: only OS process identities. */
export function ownedProcessTree(rootPid: number, previous: ReadonlyMap<number, string> = new Map()): Map<number, string> {
  const processes = snapshot();
  const owned = new Map<number, string>();

  for (const process of processes) {
    if (process.pid === rootPid || process.group === rootPid || previous.get(process.pid) === process.started) owned.set(process.pid, process.started);
  }

  let changed = true;

  while (changed) {
    changed = false;

    for (const process of processes) {
      if (owned.has(process.parent) && !owned.has(process.pid)) { owned.set(process.pid, process.started); changed = true; }
    }
  }

  return owned;
}

export function signalOwnedProcesses(owned: ReadonlyMap<number, string>, signal: NodeJS.Signals): void {
  for (const process of snapshot()) {
    if (owned.get(process.pid) !== process.started) continue;

    try { globalThis.process.kill(process.pid, signal); } catch { /* process exited since snapshot */ }
  }
}

function snapshot(): ProcessIdentity[] {
  const result = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });

  return result.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);

    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4] }] : [];
  });
}
