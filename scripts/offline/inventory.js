// Inventory every external URL referenced in the content and classify it by
// how it is used, so we know what breaks when the server runs offline.
//
// Usage: node scripts/offline/inventory.js [--out=offline]
// Writes <out>/inventory.json (every occurrence) and <out>/summary.json.

import fs from "node:fs";
import path from "node:path";

const ROOT = "files";
const OUT =
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "offline";

const PLACEHOLDER_HOST =
  /(^|\.)((not-|another-|cool)?example\.(com|org|net)|exammple\.com|[abc]\.com|other\.com|evil(-domain)?\.com|thirdparty\.com|some-site\.net|other_origin\.com|[a-z]+\.other|auth\.provider\.com|very\.badssl\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|test|invalid|example|local|website|someurl|github)$|^(93\.184\.215\.14|\[::1\]|192\.168\.|10\.)/i;

// Hosts whose URLs are usually dynamic services (APIs, players, trackers),
// not files we can mirror.
const DYNAMIC_HOST =
  /^(api\.|.*\.api\.|jsonplaceholder\.typicode\.com$|httpbin\.org$|www\.youtube\.com$|youtube\.com$|youtu\.be$|player\.vimeo\.com$|maps\.googleapis\.com$|www\.google-analytics\.com$)/;

const STATIC_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|ogv|ogg|oga|mp3|wav|flac|m4a|aac|opus|vtt|srt|ttml|woff2?|ttf|otf|eot|css|m?js|json|wasm|txt|xml|csv|glb|gltf|bin|obj|mtl|hdr|ktx2?|basis|dds|pdf|zip|webmanifest|mpd|m3u8|ts|m4s|m4v|mov|avi|mkv)$/i;

// Hosts that only serve static files, even when the path has no extension.
const STATIC_HOST =
  /^(dummyimage\.com|mermaid\.ink|fonts\.gstatic\.com|fonts\.googleapis\.com)$/;

// Resource-loading positions inside code samples (HTML/CSS/JS/SVG).
const LOADING_CONTEXT =
  /(\bsrc|\bsrcset|\bposter|\bdata|\bhref|\bxlink:href|\baction|\bmanifest)\s*=\s*["']?$|url\(\s*["']?$|@import\s+(url\()?\s*["']?$|\b(fetch|import|importScripts|Worker|SharedWorker|Audio|EventSource|WebSocket|loadImage|load|open|register|addModule|FontFace|sendBeacon|setAttribute\([^)]*,)\s*\(?\s*["'`]?$|\bfrom\s+["']$|\.(src|href|srcset|poster)\s*=\s*["'`]$/;

const URL_RE = /https?:\/\/[^\s"'<>`)\]}|\\]+/g;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".md")) yield p;
  }
}

function classify({ url, before, inFence, fenceLang, line }) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { kind: "invalid" };
  }
  if (PLACEHOLDER_HOST.test(host)) return { kind: "placeholder", host };

  const isStaticPath = STATIC_EXT.test(new URL(url).pathname);
  const isFonts = host === "fonts.googleapis.com";
  const isStaticHost =
    STATIC_HOST.test(host) &&
    !url.includes("${") &&
    new URL(url).pathname.length > 1;
  const dynamic = DYNAMIC_HOST.test(host);

  if (inFence) {
    if (LOADING_CONTEXT.test(before) || isFonts) {
      return {
        kind: "sample-resource",
        host,
        downloadable: !dynamic && (isStaticPath || isStaticHost),
        fenceLang,
      };
    }
    return { kind: "code-text", host, fenceLang };
  }

  if (/\{\{\s*EmbedYouTube/i.test(line)) return { kind: "embed-video", host };
  if (
    /!\[[^\]]*\]\($/.test(before) ||
    /<(img|video|audio|source|track|iframe|object|embed)\b[^>]*\b(src|data|poster)=["']$/i.test(
      before,
    )
  ) {
    return {
      kind: "page-media",
      host,
      downloadable: !dynamic && (isStaticPath || isStaticHost),
    };
  }
  return { kind: "link", host };
}

const occurrences = [];
const macros = {};
const MACRO_RE =
  /\{\{\s*(EmbedYouTube|EmbedGHLiveSample|LiveSampleLink|EmbedLiveSample|InteractiveExample)\s*\(([^)]*)\)/g;

for (const file of walk(ROOT)) {
  const rel = file.split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  let inFence = false;
  let fenceLang = "";
  let fenceMarker = "";
  text.split(/\r?\n/).forEach((line, i) => {
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w-]*)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
        fenceLang = fence[2];
        return;
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
        return;
      }
    }
    for (const m of line.matchAll(MACRO_RE)) {
      (macros[m[1]] ??= []).push({ file: rel, line: i + 1, args: m[2] });
    }
    for (const m of line.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?'*_]+$/, "");
      const before = line.slice(0, m.index);
      occurrences.push({
        file: rel,
        line: i + 1,
        url,
        ...classify({ url, before, inFence, fenceLang, line }),
      });
    }
  });
}

const summary = { byKind: {}, topHostsByKind: {}, macros: {} };
for (const o of occurrences) {
  summary.byKind[o.kind] = (summary.byKind[o.kind] ?? 0) + 1;
  const hosts = (summary.topHostsByKind[o.kind] ??= {});
  hosts[o.host] = (hosts[o.host] ?? 0) + 1;
}
for (const [kind, hosts] of Object.entries(summary.topHostsByKind)) {
  summary.topHostsByKind[kind] = Object.fromEntries(
    Object.entries(hosts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40),
  );
}
for (const [name, uses] of Object.entries(macros)) {
  summary.macros[name] = {
    uses: uses.length,
    files: new Set(uses.map((u) => u.file)).size,
  };
}
const downloadable = [
  ...new Set(occurrences.filter((o) => o.downloadable).map((o) => o.url)),
].sort();
summary.uniqueDownloadableUrls = downloadable.length;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, "inventory.json"),
  JSON.stringify({ occurrences, macros }, null, 1),
);
fs.writeFileSync(
  path.join(OUT, "summary.json"),
  JSON.stringify(summary, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "download-list.txt"),
  downloadable.join("\n") + "\n",
);
console.log(
  JSON.stringify(
    {
      byKind: summary.byKind,
      macros: summary.macros,
      uniqueDownloadableUrls: downloadable.length,
    },
    null,
    2,
  ),
);
