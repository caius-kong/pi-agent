import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig, registerAgentLoop } from "./controller.mjs";

// pi-ai is pi's dependency, not this checkout's, and its "./api/*" export is out of reach
// of an extension's resolver (pi resolves extension imports through its own virtual-module
// map), so the module is imported by path. The path is looked up from pi's package rather
// than assumed: as a sibling of it (pnpm store, npm/bun hoist), else inside its node_modules.
function typesafeSystemOne() {
  const relative = join("pi-ai", "dist", "api", "typesafe-system-one.lazy.js");
  const candidates = [
    join(getPackageDir(), "..", relative),
    join(getPackageDir(), "node_modules", "@earendil-works", relative),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`typesafe-system-one module not found: neither ${candidates.join(" nor ")} exists`);
  return found;
}

export default function (pi: ExtensionAPI) {
  registerAgentLoop(pi, {
    getConfig: () => readConfig(join(getAgentDir(), "settings.json")),
    loadTypesafeProvider: () => import(pathToFileURL(typesafeSystemOne()).href),
  });
}
