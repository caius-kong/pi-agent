// Resolve a runtime dependency of the extension under test.
//
// Where the dep lives depends on how pi was installed: an npm-style install
// beside the running node binary (`<prefix>/lib/node_modules`) or a pnpm global
// store whose directory names carry a build hash and are rebuilt at will.
// Pinning either one makes the suite fail the next time the package manager
// reshuffles, so both are tried and the npm layout wins when present: that is
// the copy the running agent actually loads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NPM_ROOTS = [
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
  "/opt/homebrew/lib/node_modules",
  "/usr/local/lib/node_modules",
  path.join(os.homedir(), ".pi", "agent", "npm", "node_modules"),
];

const PNPM_GLOBAL = path.join(os.homedir(), "Library", "pnpm", "global", "v11");

function fromNpmRoots(inner) {
  for (const root of NPM_ROOTS) {
    const candidates = [
      path.join(root, inner),
      path.join(root, "@earendil-works", "pi-coding-agent", "node_modules", inner),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function fromPnpmStore(prefix, inner) {
  let entries = [];
  try { entries = fs.readdirSync(PNPM_GLOBAL); } catch { return null; }
  for (const entry of entries) {
    const store = path.join(PNPM_GLOBAL, entry, "node_modules", ".pnpm");
    let names = [];
    try { names = fs.readdirSync(store); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const candidate = path.join(store, name, "node_modules", inner);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveDep(prefix, inner) {
  const found = fromNpmRoots(inner) ?? fromPnpmStore(prefix, inner);
  if (found) return found;
  throw new Error(
    `Cannot locate ${prefix}: not in an npm global root (${NPM_ROOTS.join(", ")}) nor in the pnpm store`,
  );
}
