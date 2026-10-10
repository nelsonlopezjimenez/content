// Mirror the static resources found by inventory.js so they can be served
// offline. Layout: <out>/mirror/<host>/<path>, i.e. the original URL with the
// scheme stripped, so a single prefix rewrite (https://host/… -> /_mirror/host/…)
// is enough to point pages at the local copy.
//
// Usage: node scripts/offline/download.js [--out=offline] [--max-mb=100]
//          [--skip-clone] [--only=all|assets|bcd] [--build=build]
// BCD data needs `npm run build` first (queries are read from build/).
// Writes <out>/manifest.json: { url: { path, status, bytes, contentType, error } }

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ??
  fallback;
const OUT = arg("out", "offline");
const MAX_BYTES = Number(arg("max-mb", 100)) * 1024 * 1024;
const MIRROR = path.join(OUT, "mirror");

// A modern browser UA makes Google Fonts return woff2 with unicode-range.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// mdn.github.io/<repo>/ is GitHub Pages for github.com/mdn/<repo>; cloning is
// the only way to get whole demos (EmbedGHLiveSample, linked example pages).
const GH_PAGES_BRANCH = {
  "voice-change-o-matic": "gh-pages",
  "voice-change-o-matic-float-data": "gh-pages",
  "webextensions-examples": "gh-pages",
};

export function localPathFor(url) {
  // Raw files from mdn/<repo> on GitHub are already in the cloned repos.
  const gh = url.match(
    /^https?:\/\/(?:github\.com\/mdn\/([\w.-]+)\/(?:blob|raw)|raw\.githubusercontent\.com\/mdn\/([\w.-]+))\/(?:refs\/heads\/)?main\/([^?#]+)/,
  );
  if (gh) {
    return path.posix.join(
      "mdn.github.io",
      gh[1] ?? gh[2],
      decodeURIComponent(gh[3]),
    );
  }

  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith("/")) p += "index.html";
  if (u.search) {
    // Keep query-string variants distinct but stable.
    const ext = path.extname(p);
    p = `${p.slice(0, p.length - ext.length)}__${sha1(u.search)}${ext}`;
  }
  // Windows paths are limited to 260 characters; shorten huge segments
  // (e.g. mermaid.ink encodes the whole diagram in the path).
  p = p
    .replace(/[<>:"|?*]/g, "_")
    .split("/")
    .map((seg) => (seg.length > 80 ? `${seg.slice(0, 30)}_${sha1(seg)}` : seg))
    .join("/");
  return path.posix.join(u.hostname.toLowerCase(), p);
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
}

// Some hosts fail under Node's fetch (stricter TLS chain checks) or only work
// over plain HTTP; curl is a more forgiving fallback.
function curlTo(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const candidate of [url, url.replace(/^https:/, "http:")]) {
    try {
      execFileSync(
        "curl",
        [
          "-sSfL",
          "-m",
          "300",
          "--max-filesize",
          String(MAX_BYTES),
          "-A",
          UA,
          "-o",
          dest,
          candidate,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      return {
        status: "ok",
        bytes: fs.statSync(dest).size,
        via: `curl ${candidate}`,
      };
    } catch {
      fs.rmSync(dest, { force: true });
    }
  }
  throw new Error("fetch and curl failed");
}

// Site sections that live outside this repo (/curriculum/, /about, /community…),
// built with `npm run offline:build-extras`. rari rejects CRLF front matter,
// so never let git convert line endings here.
function cloneContentSources() {
  for (const repo of ["curriculum", "generic-content"]) {
    const dest = path.join(OUT, "sources", repo);
    if (fs.existsSync(path.join(dest, ".git"))) continue;
    console.log(`clone  ${repo} (content source)`);
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "clone",
        "--depth=1",
        `https://github.com/mdn/${repo}.git`,
        dest,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    execFileSync("git", ["-C", dest, "config", "core.autocrlf", "false"]);
  }
}

function cloneMdnRepos(inventory) {
  const repos = new Set();
  for (const o of inventory.occurrences) {
    const m = o.url.match(/^https?:\/\/mdn\.github\.io\/([\w.-]+)/);
    if (m) repos.add(m[1]);
  }
  for (const m of inventory.macros.EmbedGHLiveSample ?? []) {
    repos.add(m.args.match(/["']([^/"']+)/)[1]);
  }
  for (const repo of [...repos].sort()) {
    const dest = path.join(MIRROR, "mdn.github.io", repo);
    if (fs.existsSync(path.join(dest, ".git"))) {
      console.log(`clone  ${repo}: already present`);
      continue;
    }
    const branch = GH_PAGES_BRANCH[repo];
    console.log(`clone  ${repo}${branch ? ` (${branch})` : ""}`);
    try {
      execFileSync(
        "git",
        [
          "clone",
          "--depth=1",
          "--single-branch",
          ...(branch ? ["--branch", branch] : []),
          `https://github.com/mdn/${repo}.git`,
          dest,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    } catch (e) {
      console.error(`clone  ${repo} FAILED: ${e.message}`);
    }
  }
}

async function fetchTo(url, dest) {
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) {
    await res.body?.cancel();
    return { status: "too-large", bytes: len };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return { status: "too-large", bytes: buf.length };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return {
    status: "ok",
    bytes: buf.length,
    contentType: res.headers.get("content-type"),
    body: buf,
  };
}

// Google Fonts CSS points at fonts.gstatic.com; mirror those files too and
// make the CSS reference them relatively so it works under any prefix.
async function mirrorFontCss(cssPath, manifest) {
  let css = fs.readFileSync(cssPath, "utf8");
  const urls = [
    ...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) ?? []),
  ];
  for (const fontUrl of urls) {
    const rel = localPathFor(fontUrl);
    const dest = path.join(MIRROR, rel);
    if (!fs.existsSync(dest)) {
      try {
        const { body, ...r } = await fetchTo(fontUrl, dest);
        manifest[fontUrl] = { path: rel, ...r, via: "font-css" };
      } catch (e) {
        manifest[fontUrl] = { path: rel, status: "error", error: e.message };
        continue;
      }
    }
    const relFromCss = path
      .relative(path.dirname(cssPath), dest)
      .split(path.sep)
      .join("/");
    css = css.split(fontUrl).join(relFromCss);
  }
  fs.writeFileSync(cssPath, css);
}

// Browser compatibility tables are fetched client-side from the BCD API.
// Collect every query used by the built pages and download only the
// top-most ones; the offline server slices sub-features out of those.
export const BCD_HOST = "https://bcd.developer.mozilla.org";
export const BCD_PREFIX = "/bcd/api/v0/current/";

function collectBcdRoots(buildDir) {
  const queries = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "index.json") {
        const json = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const section of json.doc?.body ?? []) {
          if (section.type !== "browser_compatibility") continue;
          [section.value?.query].flat().forEach((q) => q && queries.add(q));
        }
      }
    }
  };
  walk(buildDir);
  return [...queries].filter((q) => {
    const parts = q.split(".");
    return !parts.some((_, i) => i && queries.has(parts.slice(0, i).join(".")));
  });
}

async function downloadBcd(buildDir) {
  const roots = collectBcdRoots(buildDir);
  console.log(`bcd    ${roots.length} root queries`);
  let ok = 0;
  const failed = [];
  const queue = [...roots];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let q; (q = queue.shift());) {
        const url = `${BCD_HOST}${BCD_PREFIX}${q}.json`;
        const dest = path.join(MIRROR, localPathFor(url));
        if (fs.existsSync(dest)) {
          ok++;
          continue;
        }
        try {
          await fetchTo(url, dest);
          ok++;
        } catch (e) {
          failed.push(`${q}: ${e.message}`);
        }
      }
    }),
  );
  console.log(`bcd    ok: ${ok}, failed: ${failed.length}`);
  failed.forEach((f) => console.log(`bcd    FAILED ${f}`));
}

async function main() {
  const only = arg("only", "all");
  if (only === "all" || only === "bcd") {
    await downloadBcd(arg("build", "build"));
    if (only === "bcd") return;
  }
  const inventory = JSON.parse(
    fs.readFileSync(path.join(OUT, "inventory.json"), "utf8"),
  );
  const urls = fs
    .readFileSync(path.join(OUT, "download-list.txt"), "utf8")
    .split("\n")
    .filter(Boolean);

  if (!process.argv.includes("--skip-clone")) {
    cloneMdnRepos(inventory);
    cloneContentSources();
  }

  const manifestPath = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : {};

  for (const url of urls) {
    const rel = localPathFor(url);
    const dest = path.join(MIRROR, rel);
    if (fs.existsSync(dest)) {
      if (manifest[url]?.status !== "ok") {
        manifest[url] = { path: rel, status: "ok", via: "clone-or-cache" };
      }
      continue;
    }
    try {
      let r;
      try {
        const { body, ...rest } = await fetchTo(url, dest);
        r = rest;
      } catch (e) {
        if (e.message !== "fetch failed") throw e;
        r = curlTo(url, dest);
      }
      manifest[url] = { path: rel, ...r };
      if (
        r.status === "ok" &&
        new URL(url).hostname === "fonts.googleapis.com"
      ) {
        await mirrorFontCss(dest, manifest);
      }
    } catch (e) {
      manifest[url] = { path: rel, status: "error", error: e.message };
    }
    console.log(`${manifest[url].status.padEnd(9)} ${url}`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  const counts = {};
  for (const v of Object.values(manifest))
    counts[v.status] = (counts[v.status] ?? 0) + 1;
  console.log(counts);
}

if (import.meta.main) {
  await main();
}
