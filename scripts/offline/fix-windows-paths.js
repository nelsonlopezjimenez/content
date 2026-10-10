// rari builds on Windows can leak OS path separators into URL fields
// (e.g. "/en-US/curriculum/core\\css-layout/"), which breaks navigation such
// as the curriculum module tabs. Normalize those fields to forward slashes.
//
// Usage: node scripts/offline/fix-windows-paths.js [build-dir]

import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || "build";
const PATH_KEYS = new Set(["url", "slug", "mdn_url", "uri"]);

function fix(value) {
  if (Array.isArray(value)) {
    // Not .some(): every element must be visited.
    return value.map(fix).includes(true);
  }
  if (value && typeof value === "object") {
    let changed = false;
    for (const key of Object.keys(value)) {
      if (PATH_KEYS.has(key) && typeof value[key] === "string") {
        if (value[key].includes("\\")) {
          value[key] = value[key].replaceAll("\\", "/").replace(/\/{2,}/g, "/");
          changed = true;
        }
      } else if (fix(value[key])) {
        changed = true;
      }
    }
    return changed;
  }
  return false;
}

let files = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "index.json") {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      if (fix(json)) {
        fs.writeFileSync(p, JSON.stringify(json));
        files++;
      }
    }
  }
};
walk(ROOT);
console.log(`Normalized path separators in ${files} files`);
