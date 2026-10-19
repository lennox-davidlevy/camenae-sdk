import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import esbuild from "esbuild";
import { acpDiagnosticsPlugin } from "./scripts/acp-diagnostics.mjs";
import { mcpCleanupPlugin } from "./scripts/mcp-cleanup.mjs";

const builtins = new Set(
	builtinModules.map((name) => name.replace(/^node:/, "")),
);

const external = [...builtins].flatMap((name) => [name, `node:${name}`]);

const require = createRequire(import.meta.url);

const compatibility = JSON.parse(readFileSync("runtime/compatibility.json", "utf8"));

const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));

for (const [name, version] of Object.entries(compatibility.dependencies)) {
	if (packageMetadata.dependencies[name] !== version) throw new Error(`Runtime dependency must match compatibility manifest: ${name}`);
}

let bobDigest;

try { bobDigest = createHash("sha256").update(readFileSync("runtime/bob/dist/bob.js")).digest("hex"); }
catch { throw new Error("Prepare the approved Bob artifact with bun run runtime:prepare before building or packing."); }

if (bobDigest !== (compatibility.bob.usageCorrection?.entrypointSha256 ?? compatibility.bob.correction?.entrypointSha256 ?? compatibility.bob.entrypointSha256)) throw new Error("Private Bob runtime checksum mismatch; prepare the approved runtime and corrections before building");

// Dist is wholly generated. A clean output tree prevents retired CLI/server
// bundles or stale declaration files from leaking into an SDK archive.
rmSync("dist", { recursive: true, force: true });

await buildBundle();

buildDeclarations();

mkdirSync("dist/licenses", { recursive: true });

copyFileSync("licenses/opencode-MIT.txt", "dist/licenses/opencode-MIT.txt");

for (const dependency of ["effect", "acorn"]) {
	copyFileSync(join(dirname(require.resolve(`${dependency}/package.json`)), "LICENSE"), `dist/licenses/${dependency}-LICENSE`);
}

async function buildBundle() {
	const result = await esbuild.build({
		entryPoints: ["src/sdk/index.ts", "src/sdk/mcp-gate.ts", "src/sdk/code-mode.ts"],
		bundle: true,
		format: "esm",
		metafile: true,
		outdir: "dist/sdk",
		splitting: true,
		outExtension: { ".js": ".mjs" },
		chunkNames: "chunks/[name]-[hash]",
		platform: "node",
		target: "node22",
		banner: { js: 'import { createRequire as __gatewayCreateRequire } from "node:module"; const require = __gatewayCreateRequire(import.meta.url);' },
		external,
		plugins: [acpDiagnosticsPlugin, mcpCleanupPlugin, {
			name: "bundle-yaml-esm",
			setup(build) {
				build.onResolve({ filter: /^yaml$/ }, () => ({ path: join(dirname(require.resolve("yaml/package.json")), "browser/index.js") }));
			},
		}],
		logLevel: "info",
	});

	if (Object.keys(result.metafile.outputs).length === 0) throw new Error("Could not inspect SDK bundle output");

	const unexpectedExternalImports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
		.filter(({ external: isExternal }) => isExternal)
		.map(({ path }) => path)
		.filter((path) => !builtins.has(path.replace(/^node:/, "")));

	if (unexpectedExternalImports.length > 0) {
		throw new Error(`SDK bundle has unbundled non-Node runtime imports: ${unexpectedExternalImports.join(", ")}`);
	}
}

function buildDeclarations() {
	const temporaryOutput = "dist/.declarations";
	rmSync(temporaryOutput, { recursive: true, force: true });
	execFileSync(process.execPath, [
		require.resolve("typescript/bin/tsc"),
		"-p",
		"tsconfig.json",
		"--emitDeclarationOnly",
		"--declarationMap",
		"false",
		"--outDir",
		temporaryOutput,
	], { stdio: "inherit" });
	mkdirSync("dist/sdk", { recursive: true });

	for (const name of ["index.d.ts", "bob.d.ts", "errors.d.ts", "types.d.ts", "mcp-gate.d.ts", "code-mode.d.ts"]) {
		copyFileSync(`${temporaryOutput}/sdk/${name}`, `dist/sdk/${name}`);
	}

	rmSync(temporaryOutput, { recursive: true, force: true });
}
