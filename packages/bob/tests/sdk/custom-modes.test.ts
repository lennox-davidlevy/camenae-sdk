import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Bob, type BobCustomMode, type BobStartOptions } from "../../src/sdk/index.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function directory() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".tmp", "cm-"));
  roots.push(root);

  return root;
}

const mode = (): BobCustomMode => ({ slug: "assistant", name: "Assistant", roleDefinition: 'Be practical. Preserve “quotes”, café, — and 日本語.',
  customInstructions: "Answer general questions directly.", groups: [["edit", { fileRegex: "\\.md$" }], "read"] });

async function start(root: string, managedCustomModes?: BobCustomMode[]) {
  await mkdir(join(root, "home"), { recursive: true });

  return Bob.start({ workspace: root, credential: { kind: "apiKey", apiKey: "initialize-only" }, managedCustomModes,
    autoApprove: false, disableMcp: true, disableSubagents: true,
    environment: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/config"), XDG_DATA_HOME: join(root, "home/data"), XDG_CACHE_HOME: join(root, "home/cache") } });
}

it("owns only the opted-in mode file, replaces after close, preserves omission, and refuses edits", async () => {
  const root = await directory();
  const file = join(root, ".bob/custom_modes.yaml");
  await (await start(root)).close();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(root, ".bob"), { recursive: true });
  await writeFile(join(root, ".bob/keep.txt"), "CALLER");
  await (await start(root, [mode()])).close();
  const original = await readFile(file, "utf8");
  expect(JSON.parse(original).customModes).toEqual([mode()]);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await (await start(root)).close();
  expect(await readFile(file, "utf8")).toBe(original);
  await (await start(root, [{ ...mode(), roleDefinition: "Replacement role." }])).close();
  expect(JSON.parse(await readFile(file, "utf8")).customModes[0].roleDefinition).toBe("Replacement role.");
  await (await start(root, [])).close();
  expect(JSON.parse(await readFile(file, "utf8")).customModes).toEqual([]);
  const edited = (await readFile(file, "utf8")) + " ";
  await writeFile(file, edited);
  await expect(start(root, [mode()])).rejects.toMatchObject({ code: "configuration_invalid" });
  expect(await readFile(file, "utf8")).toBe(edited);
  await (await start(root)).close();
  expect(await readFile(file, "utf8")).toBe(edited);
  expect(await readFile(join(root, ".bob/keep.txt"), "utf8")).toBe("CALLER");
}, 25_000);

it("snapshots nested worker modes before binding and refuses a competing listener without rewriting", async () => {
  const root = await directory();
  const socketPath = join(root, "s");
  const controller = new AbortController();
  const managedCustomModes = [mode()];
  const worker = Bob.serveOnce({ workspace: root, socketPath, signal: controller.signal, managedCustomModes });
  managedCustomModes[0].roleDefinition = "MUTATED";
  managedCustomModes[0].groups!.push("execute");
  const restricted = managedCustomModes[0].groups![0];

  if (Array.isArray(restricted)) restricted[1].fileRegex = ".*";

  try {
    const file = join(root, ".bob/custom_modes.yaml");
    await expect.poll(() => readFile(file, "utf8").catch(() => "")).not.toBe("");
    const original = await readFile(file, "utf8");
    expect(JSON.parse(original).customModes).toEqual([mode()]);
    await expect(Bob.serveOnce({ workspace: root, socketPath, signal: new AbortController().signal, managedCustomModes: [] })).rejects.toMatchObject({ code: "startup_failed" });
    expect(await readFile(file, "utf8")).toBe(original);
  } finally { controller.abort(); await worker; }
});

it("rejects invalid definitions at both startup boundaries without creating configuration", async () => {
  const root = await directory();

  const invalid = [null, {}, [mode(), mode()], [{ ...mode(), slug: "../bad" }], [{ ...mode(), slug: "agent" }],
    [{ ...mode(), roleDefinition: " " }], [{ ...mode(), unknown: true }], [{ ...mode(), groups: ["shell"] }],
    [{ ...mode(), groups: ["read", "read"] }], [{ ...mode(), groups: [["edit", { fileRegex: "[" }]] }],
    [{ ...mode(), groups: [["edit", { fileRegex: ".*", extra: true }]] }], [{ ...mode(), name: "bad\0name" }],
    [{ ...mode(), roleDefinition: "x".repeat(65537) }]];

  for (const value of invalid) {
    // SAFETY: malformed JavaScript callers must fail at the public API boundary.
    const managedCustomModes = value as BobStartOptions["managedCustomModes"];
    await expect(start(root, managedCustomModes)).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(Bob.serveOnce({ workspace: root, socketPath: join(root, "s"), signal: new AbortController().signal, managedCustomModes })).rejects.toMatchObject({ code: "configuration_invalid" });
  }

  await expect(stat(join(root, ".bob"))).rejects.toMatchObject({ code: "ENOENT" });
  // SAFETY: connect must reject worker-only configuration even from JS callers.
  await expect(Bob.connect({ workspace: root, socketPath: join(root, "s"), credential: { kind: "apiKey", apiKey: "unused" },
    managedCustomModes: [] } as Parameters<typeof Bob.connect>[0])).rejects.toMatchObject({ code: "configuration_invalid" });
});
