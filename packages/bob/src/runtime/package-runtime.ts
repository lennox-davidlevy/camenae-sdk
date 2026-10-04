import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import compatibility from "../../runtime/compatibility.json";
import { isRecord } from "../utils/type-guards.js";
import { loadApiKey } from "./credentials.mjs";

interface PackageRuntimeOptions {
  childEnvironment: NodeJS.ProcessEnv;
  authentication?: "sso";
  autoApprove?: boolean;
  disableMcp?: boolean;
  disableSubagents?: boolean;
}

export interface PackageRuntime {
  args: string[];
  environment: NodeJS.ProcessEnv;
}

/** Resolve only assets installed with this package. There is no host Bob lookup. */
export function verifyPackageRuntime(): string {
  const version = process.versions.node.split(".").map(Number);
  const minimum = compatibility.nodeMinimum.split(".").map(Number);

  if (version[0] < minimum[0] || (version[0] === minimum[0] &&
      (version[1] < minimum[1] || (version[1] === minimum[1] && version[2] < minimum[2])))) throw new Error("Unsupported Node runtime");

  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) throw new Error("Unsupported platform");
  accessSync("/bin/ps", constants.X_OK);
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@camenae/bob/package.json"));
  const bobRoot = join(root, "runtime", "bob");
  const entrypoint = join(bobRoot, "dist", "bob.js");
  const metadata: unknown = JSON.parse(readFileSync(join(bobRoot, "package.json"), "utf8"));

  if (!isRecord(metadata) || metadata.version !== compatibility.bob.version || metadata.releaseCommit !== compatibility.bob.releaseCommit ||
      sha256(entrypoint) !== (compatibility.bob.usageCorrection?.entrypointSha256 ?? compatibility.bob.correction?.entrypointSha256 ?? compatibility.bob.entrypointSha256)) throw new Error("Private Bob runtime identity mismatch");
  const bobRequire = createRequire(entrypoint);

  for (const [name, version] of Object.entries(compatibility.dependencies)) {
    // Resolve the public entry first: some helper packages do not export package.json.
    let directory = dirname(bobRequire.resolve(name));

    while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory) directory = dirname(directory);
    const helper: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

    if (!isRecord(helper) || helper.name !== name || helper.version !== version) throw new Error("Private Bob helper version mismatch");

    if (name === "@officecli/officecli") {
      const binary = join(directory, "vendor", "officecli");
      accessSync(binary, constants.X_OK);

      const accepted = Object.entries(compatibility.officecliSha256)
        .filter(([platform]) => platform === `${process.platform}-${process.arch}` ||
          (process.platform === "linux" && platform === `linux-musl-${process.arch}`))
        .map(([, digest]) => digest);

      if (!accepted.includes(sha256(binary))) throw new Error("Private OfficeCLI checksum mismatch");
    }
  }

  // Optional native packages must actually be installed for this architecture.
  bobRequire.resolve(`@lydell/node-pty-${process.platform}-${process.arch}/package.json`);
  const rg = bobRequire.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/rg`);
  accessSync(rg, constants.X_OK);

  return entrypoint;
}

export async function preparePackageRuntime(options: PackageRuntimeOptions): Promise<PackageRuntime> {
  const entrypoint = verifyPackageRuntime();
  const environment = { ...options.childEnvironment };

  if (options.authentication === "sso") {
    // Bob owns SSO state. Neither key alias nor Gateway config may override it.
    delete environment.BOB_API_KEY;
    delete environment.BOBSHELL_API_KEY;
  } else {
    const inherited = environment.BOB_API_KEY;
    const key = inherited?.trim() ? inherited : await loadApiKey();

    if (!key?.trim()) throw new Error("Bob API key is required");
    environment.BOB_API_KEY = key;
  }

  const autoApprove = options.autoApprove ?? !["0", "false", "no", "off"].includes(options.childEnvironment.BOB_GATEWAY_AUTO_APPROVE?.trim().toLowerCase() ?? "");

  return {
    args: [entrypoint, "acp", "--trust", "--accept-license", ...(autoApprove ? ["--auto-approve"] : []),
      ...(options.disableMcp ? ["--disable-mcp"] : []), ...(options.disableSubagents ? ["--disable-subagents"] : [])],
    environment: {
      ...environment,
      OFFICECLI_SKIP_UPDATE: "1",
      PATH: [dirname(process.execPath), options.childEnvironment.PATH ?? ""].join(delimiter),
    },
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
