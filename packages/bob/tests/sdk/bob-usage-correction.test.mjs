import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { correctBobUsage } from "../../scripts/bob-acp-usage.mjs";

// The installed behavior smoke cannot detect a preparation guard accidentally
// accepting drifted dependency bytes or applying the correction twice.
it("refuses unexpected usage-patch input, double application, and unreviewed pins", () => {
  const bob = JSON.parse(readFileSync(new URL("../../runtime/compatibility.json", import.meta.url), "utf8")).bob;
  const prepared = readFileSync(new URL("../../runtime/bob/dist/bob.js", import.meta.url));

  for (const input of [Buffer.from("unexpected dependency"), prepared]) {
    expect(() => correctBobUsage(input, bob)).toThrow("exact permission-corrected entrypoint");
  }

  for (const changed of [
    { ...bob, version: "2.0.6" }, { ...bob, releaseCommit: "different" },
    { ...bob, correction: undefined }, { ...bob, correction: { ...bob.correction, entrypointSha256: "different" } },
    { ...bob, usageCorrection: undefined },
    { ...bob, usageCorrection: { ...bob.usageCorrection, id: "different" } },
    { ...bob, usageCorrection: { ...bob.usageCorrection, entrypointSha256: "different" } },
  ]) expect(() => correctBobUsage(prepared, changed)).toThrow("Review the Bob usage correction");
});
