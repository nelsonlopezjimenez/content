// Package only what the offline server needs at runtime into a tarball that
// can be handed out and run with plain Node (no npm install, no internet).
//
// Usage: node scripts/offline/pack.js [--out=offline/mdn-offline.tar.gz] [--skip-videos]
//
// Left out: git history (repo and mirrored repos), Markdown sources (only
// _redirects.txt is read), build metadata the server never reads, rebuild-only
// inputs (offline/sources, inventory), dev dependencies and source maps.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ??
  fallback;
const OUT = path.resolve(REPO, arg("out", "offline/mdn-offline.tar.gz"));
const SKIP_VIDEOS = process.argv.includes("--skip-videos");

// Packages the server imports; their dependency closure is added below.
const RUNTIME_ROOTS = ["express", "compression", "cookie-parser", "he"];
// The only Fred files used on the server, plus its client assets.
const FRED_FILES = [
  "package.json",
  "build/env.js",
  "build/render.js",
  "vendor/yari/libs/play",
  "out",
];

const list = [];
const add = (rel, { skip = () => false } = {}) => {
  const abs = path.join(REPO, rel);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat || skip(rel)) return;
  if (stat.isFile()) return list.push(rel.split(path.sep).join("/"));
  for (const name of fs.readdirSync(abs)) add(path.join(rel, name), { skip });
};

// Server code. package.json makes Node treat the scripts as ES modules.
add("package.json");
add("scripts/offline/server.js");
add("scripts/offline/download.js");
add("offline/START-HERE.txt");

// Redirects are the only thing read from the Markdown sources.
for (const locale of fs.readdirSync(path.join(REPO, "files"))) {
  add(path.join("files", locale, "_redirects.txt"));
}

add("build", {
  skip: (rel) => /(^|[\\/])(metadata\.json|contributors\.txt)$/.test(rel),
});

add("offline/manifest.json");
add("offline/mirror", {
  skip: (rel) =>
    /[\\/]\.git([\\/]|$)/.test(rel) ||
    (SKIP_VIDEOS && /^offline[\\/]mirror[\\/]archive\.org/.test(rel)),
});

// node_modules: dependency closure of the runtime roots, resolved the way
// Node does (nested node_modules first, then the top level).
const seen = new Set();
function addPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(path.dirname(dir))) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(REPO, candidate, "package.json"))) {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      add(candidate, { skip: (rel) => rel.endsWith(".map") });
      const pkg = JSON.parse(
        fs.readFileSync(path.join(REPO, candidate, "package.json"), "utf8"),
      );
      for (const dep of Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
      })) {
        addPackage(dep, candidate);
      }
      return;
    }
    if (dir === "" || dir === ".") break;
  }
  const isOptional = name === "supports-color";
  if (!isOptional) throw new Error(`Cannot resolve ${name} from ${fromDir}`);
}
for (const root of RUNTIME_ROOTS) addPackage(root, "");
for (const file of FRED_FILES) {
  add(path.join("node_modules", "@mdn", "fred", file), {
    skip: (rel) => rel.endsWith(".map"),
  });
}

fs.writeFileSync(
  path.join(REPO, "offline", "START-HERE.txt"),
  `MDN offline
===========

Requirements: Node.js 24 or newer (tested with 24.13). No internet access or npm install needed.

Start the server from this folder:

    node scripts/offline/server.js

Then open http://localhost:5042/ in a browser. Code examples run on a second
port (5043); both must be free. To use other ports:

    PORT=8000 PLAY_PORT=8001 node scripts/offline/server.js        (macOS/Linux)
    $env:PORT=8000; $env:PLAY_PORT=8001; node scripts/offline/server.js   (PowerShell)

Stop the server with Ctrl+C.
`,
);
if (!list.includes("offline/START-HERE.txt"))
  list.push("offline/START-HERE.txt");

const listFile = `${OUT}.files.txt`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(listFile, list.join("\n") + "\n");
console.log(`Packing ${list.length} files…`);
// Relative paths: GNU tar on Windows reads "C:..." as a remote host.
execFileSync(
  "tar",
  ["-czf", path.relative(REPO, OUT), "-T", path.relative(REPO, listFile)],
  { cwd: REPO, stdio: "inherit" },
);
fs.rmSync(listFile);
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(0);
console.log(`Wrote ${path.relative(REPO, OUT)} (${mb} MB)`);
