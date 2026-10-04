import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const root = fileURLToPath(new URL("../", import.meta.url));

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

try {
  const current = parseVersion(metadata.version);

  const suggestions = {
    patch: `${current[0]}.${current[1]}.${current[2] + 1}`,
    minor: `${current[0]}.${current[1] + 1}.0`,
    major: `${current[0] + 1}.0.0`,
  };

  if (process.argv.length > 3) throw new Error("Usage: npm run release -- [patch|minor|major|X.Y.Z]");
  let choice = process.argv[2];
  console.log(`Current version: ${metadata.version}`);

  if (choice === undefined) {
    console.log(`patch: ${suggestions.patch} | minor: ${suggestions.minor} | major: ${suggestions.major}`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });

    try {
      choice = (await prompt.question(`Release version [${suggestions.patch}] (or q to cancel): `)).trim() || "patch";
    } finally { prompt.close(); }
  }

  if (choice === "q") {
    console.log("Release cancelled; no files changed.");
  } else {
    const version = Object.hasOwn(suggestions, choice) ? suggestions[choice] : choice;
    const next = parseVersion(version);
    const difference = next.map((value, index) => value - current[index]).find((value) => value !== 0);

    if (difference === undefined || difference < 0) throw new Error("Choose a version newer than the current version.");
    const artifact = `artifacts/${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;

    if (existsSync(new URL(`../${artifact}`, import.meta.url))) throw new Error(`Archive already exists: ${artifact}`);
    console.log(`Releasing ${metadata.version} → ${version} locally (no tests, commit, tag, or publish).`);
    execFileSync("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts", "--workspaces=false"], { cwd: root, stdio: "inherit" });
    mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });

    try {
      const workspaceRoot = new URL("../../../", import.meta.url);

      if (existsSync(new URL("bun.lock", workspaceRoot))) {
        execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: workspaceRoot, stdio: "inherit" });
      }

      execFileSync("npm", ["pack", "--pack-destination", "artifacts"], { cwd: root, stdio: "inherit" });
    } catch {
      throw new Error(`Packaging failed; version remains ${version}. Fix the failure, then retry: npm pack --pack-destination artifacts`);
    }

    console.log(`Created ${artifact}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release failed");
  process.exitCode = 1;
}

function parseVersion(version) {
  if (Object.prototype.toString.call(version) !== "[object String]" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Use a stable version such as 0.2.1 (X.Y.Z).");
  }

  const parts = version.split(".").map(Number);

  if (parts.some((part) => !Number.isSafeInteger(part) || part >= Number.MAX_SAFE_INTEGER)) throw new Error("Version number is too large.");

  return parts;
}
