import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(failBuild = false) {
  const temporary = join(packageRoot, ".tmp");
  mkdirSync(temporary, { recursive: true });
  const workspace = mkdtempSync(join(temporary, "release-"));
  directories.push(workspace);
  const root = join(workspace, "packages/bob");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "release-workspace", private: true, workspaces: ["packages/*"] }));
  copyFileSync(join(packageRoot, "scripts/release.mjs"), join(root, "scripts/release.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@camenae/release-fixture", version: "1.2.3", private: true, type: "module",
    scripts: { prepack: "node build.mjs" }, files: ["built.txt"],
  }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "@camenae/release-fixture", version: "1.2.3", lockfileVersion: 3,
    packages: { "": { name: "@camenae/release-fixture", version: "1.2.3" } },
  }));
  writeFileSync(join(root, "build.mjs"), failBuild ? "process.exit(1);" :
    'import { writeFileSync } from "node:fs"; writeFileSync("built.txt", "built by prepack");');
  const lock = spawnSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
  expect(lock.status, lock.stderr).toBe(0);

  return root;
}

function release(root, args = [], input) {
  return spawnSync(process.execPath, [join(root, "scripts/release.mjs"), ...args], {
    cwd: root, input, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: root, npm_config_cache: join(root, ".npm") },
  });
}

it.each([
  { args: [], input: "\n", expected: "1.2.4" },
  { args: ["minor"], expected: "1.3.0" },
  { args: ["2.4.0"], expected: "2.4.0" },
])("releases $expected through real npm version and prepack", ({ args, input, expected }) => {
  const root = fixture();
  const result = release(root, args, input);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Current version: 1.2.3");

  if (!args.length) expect(result.stdout).toContain("Release version [1.2.4]");
  expect(JSON.parse(readFileSync(join(root, "package.json"))).version).toBe(expected);
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  expect(lock.version).toBe(expected);
  expect(lock.packages[""].version).toBe(expected);
  const frozen = spawnSync("bun", ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"], { cwd: join(root, "../.."), encoding: "utf8", timeout: 30_000 });
  expect(frozen.status, frozen.stderr).toBe(0);
  const archive = join(root, "artifacts", `camenae-release-fixture-${expected}.tgz`);
  expect(existsSync(archive)).toBe(true);
  // Check the actual archive, not just the files the build left in the worktree.
  const built = spawnSync("tar", ["-xOf", archive, "package/built.txt"], { encoding: "utf8" });
  expect(built.status).toBe(0);
  expect(built.stdout).toBe("built by prepack");
  const metadata = spawnSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" });
  expect(metadata.status).toBe(0);
  expect(JSON.parse(metadata.stdout).version).toBe(expected);
});

it.each(["invalid", "1.2.3", "1.0.0", "q"])("leaves version and lockfile unchanged for %s", (choice) => {
  const root = fixture();
  const before = ["package.json", "package-lock.json"].map((name) => readFileSync(join(root, name), "utf8"));
  const result = release(root, [choice]);
  expect(result.status).toBe(choice === "q" ? 0 : 1);
  expect(["package.json", "package-lock.json"].map((name) => readFileSync(join(root, name), "utf8"))).toEqual(before);
  expect(existsSync(join(root, "artifacts"))).toBe(false);
});

it("does not overwrite an existing archive or bump the version when its destination exists", () => {
  const root = fixture();
  mkdirSync(join(root, "artifacts"));
  const archive = join(root, "artifacts/camenae-release-fixture-1.2.4.tgz");
  writeFileSync(archive, "previous archive");
  const result = release(root, ["patch"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Archive already exists");
  expect(readFileSync(archive, "utf8")).toBe("previous archive");
  expect(JSON.parse(readFileSync(join(root, "package.json"))).version).toBe("1.2.3");
});

it("reports packaging failure without pretending the version bump was rolled back", () => {
  const root = fixture(true);
  const result = release(root, ["patch"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("version remains 1.2.4");
  expect(result.stderr).toContain("npm pack --pack-destination artifacts");
  expect(JSON.parse(readFileSync(join(root, "package.json"))).version).toBe("1.2.4");
  expect(existsSync(join(root, "artifacts/camenae-release-fixture-1.2.4.tgz"))).toBe(false);
});
