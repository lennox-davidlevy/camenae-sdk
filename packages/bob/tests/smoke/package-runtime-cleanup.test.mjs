import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("closes a late successful runtime when its concurrent sibling fails startup", () => {
  const root = mkdtempSync(join(tmpdir(), "bob-smoke-failure-"));
  const receipt = join(root, "closed");

  // Substitute only the external SDK dependency; execute the actual smoke script.
  const sdk = `
    import { writeFileSync } from 'node:fs';
    let attempts = 0;
    export const Bob = { async start(options) {
      if (++attempts === 1) throw new Error('startup failure probe');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { workspace: options.workspace, async close() { writeFileSync(${JSON.stringify(receipt)}, 'closed'); } };
    } };
  `;

  try {
    const dependency = join(root, "node_modules", "@camenae", "bob");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "@camenae/bob", type: "module", exports: "./index.mjs" }));
    writeFileSync(join(dependency, "index.mjs"), sdk);
    // Resolve the fixture SDK through an ordinary installed-package boundary.
    copyFileSync(fileURLToPath(new URL("./fixtures/package-runtime-consumer.mjs", import.meta.url)), join(root, "consumer.mjs"));
    expect(() => execFileSync(process.execPath, [
      join(root, "consumer.mjs"),
    ], { cwd: root, env: { ...process.env, BOB_GATEWAY_LIVE_SMOKE: "0", BOB_API_KEY: undefined }, timeout: 5_000, stdio: "pipe" })).toThrow("startup failure probe");
    expect(readFileSync(receipt, "utf8")).toBe("closed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
