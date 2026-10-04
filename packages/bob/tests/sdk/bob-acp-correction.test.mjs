import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctBobEntrypoint } from "../../scripts/bob-acp-always-allow.mjs";

const bob = JSON.parse(readFileSync(new URL("../../runtime/compatibility.json", import.meta.url), "utf8")).bob;

describe("Bob correction maintenance guard", () => {
  it("rejects changed input, already-corrected input, and unreviewed version/hash changes", () => {
    expect(() => correctBobEntrypoint(Buffer.from("unexpected dependency"), bob)).toThrow("exact original entrypoint");
    const prepared = readFileSync(new URL("../../runtime/bob/dist/bob.js", import.meta.url));
    expect(() => correctBobEntrypoint(prepared, bob)).toThrow("exact original entrypoint");

    for (const changed of [
      { ...bob, version: "2.0.6" }, { ...bob, releaseCommit: "different" },
      { ...bob, entrypointSha256: "different" }, { ...bob, correction: undefined },
      { ...bob, correction: { ...bob.correction, entrypointSha256: "different" } },
    ]) expect(() => correctBobEntrypoint(prepared, changed)).toThrow("Review the Bob ACP correction");
  });
});
