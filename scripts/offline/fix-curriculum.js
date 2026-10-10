// rari on Windows fails to match curriculum module paths (it compares OS
// paths with "/"), so the built curriculum JSON lacks its structure: a flat
// sidebar, no module groups/breadcrumbs, no module lists on the landing and
// overview pages (the Getting started / Core / Extensions tabs), and no
// prev/next between overview pages. Rebuild those fields from the pages
// themselves. Run after fix-windows-paths.js; a no-op for correct builds.
//
// Usage: node scripts/offline/fix-curriculum.js [build-dir]

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.argv[2] || "build", "en-us", "curriculum");
if (!fs.existsSync(ROOT)) process.exit(0);

const pages = new Map(); // mdn_url -> { file, json }
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "index.json") {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      pages.set(json.doc.mdn_url, { file: p, json });
    }
  }
};
walk(ROOT);

const landing = pages.get("/en-US/curriculum/")?.json.doc;
if (!landing?.sidebar || landing.sidebar.some((e) => e.children)) {
  console.log("Curriculum structure already present, nothing to fix");
  process.exit(0);
}

// Sidebar: "group/" entries own the "group/<module>" entries after them.
const sidebar = [];
const groups = [];
for (const entry of landing.sidebar) {
  const group = groups.find((g) => entry.slug.startsWith(`${g.slug}/`));
  if (group) {
    group.children.push(entry);
  } else if (entry.slug.endsWith("/")) {
    const g = { ...entry, slug: entry.slug.slice(0, -1), children: [] };
    groups.push(g);
    sidebar.push(g);
  } else {
    sidebar.push(entry);
  }
}

const indexEntry = ({ url, title, slug }) => {
  const doc = pages.get(url)?.json.doc;
  return {
    url,
    title,
    slug,
    summary: doc?.summary ?? null,
    topic: doc?.topic ?? null,
  };
};
const groupModules = (g) => g.children.map(indexEntry);
const link = (g) => (g ? { title: g.title, url: g.url } : null);

let fixed = 0;
for (const { file, json } of pages.values()) {
  const doc = json.doc;
  doc.sidebar = sidebar;

  const gi = groups.findIndex((g) => g.url === doc.mdn_url);
  const parent = groups.find((g) =>
    g.children.some((c) => c.url === doc.mdn_url),
  );

  if (doc.mdn_url === "/en-US/curriculum/") {
    doc.modules = groups.map((g) => ({
      ...indexEntry(g),
      children: groupModules(g),
    }));
  } else if (gi !== -1) {
    // Overview page of a group.
    doc.modules = groupModules(groups[gi]);
    doc.prevNext = { prev: link(groups[gi - 1]), next: link(groups[gi + 1]) };
  } else if (parent) {
    // Module page inside a group.
    doc.group = parent.title;
    const [root, ...rest] = doc.parents ?? [];
    if (root && !rest.some((p) => p.uri === parent.url)) {
      doc.parents = [root, { uri: parent.url, title: parent.title }, ...rest];
    }
  }
  json.doc = orderKeys(doc);
  fs.writeFileSync(file, JSON.stringify(json));
  fixed++;
}
console.log(`Rebuilt curriculum structure in ${fixed} pages`);

// Keep rari's field order so output matches a native build.
function orderKeys(doc) {
  const order = [
    "body",
    "locale",
    "mdn_url",
    "native",
    "noIndexing",
    "pageTitle",
    "parents",
    "title",
    "summary",
    "toc",
    "fragments",
    "sidebar",
    "topic",
    "group",
    "modules",
    "prevNext",
    "template",
  ];
  const out = {};
  for (const k of order) if (k in doc) out[k] = doc[k];
  for (const k of Object.keys(doc)) if (!(k in out)) out[k] = doc[k];
  return out;
}
