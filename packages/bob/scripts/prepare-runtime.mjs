import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { correctBobEntrypoint } from "./bob-acp-always-allow.mjs";
import { correctBobUsage } from "./bob-acp-usage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const manifest = JSON.parse(readFileSync(join(root, "runtime/compatibility.json"), "utf8"));

const archive = process.argv[2];

if (!archive || process.argv.length !== 3) throw new Error("Usage: bun run runtime:prepare <approved-bobshell-archive>");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const archiveBytes = readFileSync(archive);

if (digest(archiveBytes) !== manifest.bob.archiveSha256) throw new Error("Bob archive checksum mismatch");

const runtime = join(root, "runtime");

mkdirSync(runtime, { recursive: true });

const staging = mkdtempSync(join(runtime, ".staging-"));

try {
  // Extract the exact bytes verified above, not a caller path that could change.
  const approvedArchive = join(staging, ".approved.tgz");
  writeFileSync(approvedArchive, archiveBytes, { flag: "wx", mode: 0o600 });
  execFileSync("tar", ["-xf", approvedArchive, "--strip-components=1", "-C", staging]);
  rmSync(approvedArchive);
  const metadata = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));

  if (metadata.version !== manifest.bob.version || metadata.releaseCommit !== manifest.bob.releaseCommit ||
      digest(readFileSync(join(staging, "dist/bob.js"))) !== manifest.bob.entrypointSha256) {
    throw new Error("Bob runtime identity mismatch");
  }

  if (manifest.bob.correction) {
    const entrypoint = join(staging, "dist/bob.js");
    writeFileSync(entrypoint, correctBobEntrypoint(readFileSync(entrypoint), manifest.bob));
  }

  if (manifest.bob.usageCorrection) {
    const entrypoint = join(staging, "dist/bob.js");
    writeFileSync(entrypoint, correctBobUsage(readFileSync(entrypoint), manifest.bob));
  }

  rmSync(join(runtime, "bob"), { recursive: true, force: true });
  renameSync(staging, join(runtime, "bob"));
  console.log(`Prepared private Bob ${manifest.bob.version} runtime with ${[manifest.bob.correction?.id, manifest.bob.usageCorrection?.id].filter(Boolean).join(", ")}.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
