import bob from "../bob/oxlint.config.ts";

export default {
  ...bob,
  ignorePatterns: [...bob.ignorePatterns, "dist/**"],
  jsPlugins: [{ name: "anti-slop", specifier: "../bob/tools/oxlint/anti-slop/index.ts" }],
};
