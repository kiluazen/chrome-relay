// Docs build — markdown in docs-src/ → static pages in public/docs/.
//
// Source of truth is markdown. Each page emits TWICE:
//   public/docs/<slug>/index.html   — humans (site shell, sidebar, palette)
//   public/docs/<slug>.md           — agents (raw markdown, no chrome)
// plus the agent-discovery surface at the root:
//   public/llms.txt                 — index of the .md twins
//   public/llms-full.txt            — every doc concatenated
//   public/sitemap.xml              — landing pages + docs pages
//
// No framework. `marked` renders GFM; the shell below is the same palette
// and wallpaper as the landing page. Run: node build-docs.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "docs-src");
const OUT = join(ROOT, "public");
const SITE = "https://chrome-relay.kushalsm.com";

marked.setOptions({ gfm: true });

// ---------------------------------------------------------------------------
// Load pages

function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) throw new Error("missing frontmatter");
  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

const pages = readdirSync(SRC)
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const raw = readFileSync(join(SRC, file), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const slug = file.replace(/\.md$/, "");
    if (!meta.title || !meta.description || !meta.nav || meta.order === undefined) {
      throw new Error(`${file}: frontmatter needs title, description, nav, order`);
    }
    return { slug, body, order: Number(meta.order), ...meta };
  })
  .sort((a, b) => a.order - b.order);

// ---------------------------------------------------------------------------
// Shell

const css = `
:root {
  color-scheme: light;
  --paper: #f7f3e8; --ink: #181818; --muted: #58544c; --line: #d6d0c2;
  --panel: #fffdf6; --green: #1f7a4d; --green-soft: #e6f2eb;
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body {
  margin: 0; color: var(--ink); line-height: 1.6; font-size: 16px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.bg-art {
  position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background: url('/bg.jpg') center/cover no-repeat;
  opacity: 0.12; filter: saturate(0.25) contrast(0.4) brightness(1.7);
}
a { color: inherit; }
.nav {
  width: min(1240px, calc(100% - 56px)); margin: 0 auto;
  display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 0;
}
.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; font-weight: 750; }
.brand img { width: 32px; height: 32px; border-radius: 8px; }
.nav-links { display: flex; gap: 18px; font-size: 14.5px; }
.nav-links a { text-decoration: none; color: var(--muted); font-weight: 550; }
.nav-links a:hover { color: var(--ink); }
.layout {
  width: min(1240px, calc(100% - 56px)); margin: 0 auto;
  display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 48px; padding: 12px 0 90px;
}
.sidebar { position: sticky; top: 24px; align-self: start; font-size: 14px; }
.sidebar a {
  display: block; padding: 5px 10px; text-decoration: none; color: var(--muted);
  border-left: 2px solid transparent; border-radius: 0 6px 6px 0;
}
.sidebar a:hover { color: var(--ink); }
.sidebar a.active { color: var(--green); border-left-color: var(--green); background: var(--green-soft); font-weight: 600; }
.sidebar .group { margin: 14px 0 4px; padding-left: 10px; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); opacity: 0.75; }
main { max-width: 760px; min-width: 0; }
main h1 { font-size: 34px; line-height: 1.15; letter-spacing: -0.02em; margin: 10px 0 6px; }
.page-desc { color: var(--muted); margin: 0 0 28px; font-size: 17px; }
main h2 { font-size: 22px; margin: 42px 0 10px; letter-spacing: -0.01em; }
main h3 { font-size: 17px; margin: 28px 0 8px; }
main p, main li { color: #2a2722; }
main hr { border: 0; border-top: 1px solid var(--line); margin: 36px 0; }
code {
  font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 0.86em;
  background: #ece7d9; padding: 2px 6px; border-radius: 5px;
}
pre {
  background: #14120e; color: #e8e2d6; border-radius: 10px;
  padding: 16px 18px; overflow-x: auto; font-size: 13.5px; line-height: 1.55;
  border: 1px solid #2a2620;
}
pre code { background: none; padding: 0; font-size: inherit; color: inherit; }
table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14.5px; }
th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 8px 10px; border-bottom: 2px solid var(--ink); }
td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
td:first-child code, td:first-child { white-space: nowrap; }
td:first-child { font-weight: 600; }
blockquote {
  margin: 18px 0; padding: 12px 18px; border-left: 3px solid var(--green);
  background: var(--green-soft); border-radius: 0 8px 8px 0;
}
blockquote p { margin: 0; }
.md-link { margin-top: 56px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.md-link a { color: var(--green); }
.pager { display: flex; justify-content: space-between; gap: 16px; margin-top: 40px; font-size: 14.5px; }
.pager a { text-decoration: none; color: var(--green); font-weight: 600; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.footer { width: min(1240px, calc(100% - 56px)); margin: 0 auto; display: flex; justify-content: space-between; padding: 26px 0 40px; font-size: 14px; color: var(--muted); border-top: 1px solid var(--line); }
.footer a { color: var(--muted); }
@media (max-width: 880px) {
  .layout { grid-template-columns: 1fr; gap: 8px; }
  .sidebar { position: static; display: flex; flex-wrap: wrap; gap: 2px 6px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .sidebar .group { display: none; }
  .sidebar a { border-left: 0; border-radius: 6px; }
}
`;

// Sidebar groups by order ranges. Keep in sync with docs-src frontmatter.
const GROUPS = [
  { label: "Start", min: 0, max: 9 },
  { label: "Concepts", min: 10, max: 19 },
  { label: "Reference", min: 20, max: 29 },
  { label: "Positioning", min: 30, max: 39 }
];

function sidebar(activeSlug) {
  let html = "";
  for (const g of GROUPS) {
    const members = pages.filter((p) => p.order >= g.min && p.order <= g.max);
    if (members.length === 0) continue;
    html += `<div class="group">${g.label}</div>`;
    for (const p of members) {
      const href = p.slug === "index" ? "/docs/" : `/docs/${p.slug}/`;
      html += `<a href="${href}"${p.slug === activeSlug ? ' class="active"' : ""}>${p.nav}</a>`;
    }
  }
  return html;
}

function pager(i) {
  const prev = pages[i - 1];
  const next = pages[i + 1];
  const link = (p, label) =>
    `<a href="${p.slug === "index" ? "/docs/" : `/docs/${p.slug}/`}">${label} ${p.nav}</a>`;
  return `<div class="pager"><span>${prev ? link(prev, "←") : ""}</span><span>${next ? link(next, "") + " →".replace(" ", "") : ""}</span></div>`
    .replace("</a> →", " →</a>");
}

function shell(page, i) {
  const url = page.slug === "index" ? `${SITE}/docs/` : `${SITE}/docs/${page.slug}/`;
  const mdUrl = page.slug === "index" ? `${SITE}/docs/index.md` : `${SITE}/docs/${page.slug}.md`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${page.title} | Chrome Relay</title>
<meta name="description" content="${page.description}" />
<meta property="og:title" content="${page.title} | Chrome Relay" />
<meta property="og:description" content="${page.description}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${url}" />
<link rel="canonical" href="${url}" />
<link rel="alternate" type="text/markdown" href="${mdUrl}" title="Markdown version" />
<link rel="icon" type="image/png" href="/icon-128.png" />
<style>${css}</style>
</head>
<body>
<div class="bg-art" aria-hidden="true"></div>
<nav class="nav" aria-label="Primary">
  <a class="brand" href="/"><img src="/icon-128.png" alt="" /><span>Chrome Relay</span></a>
  <div class="nav-links">
    <a href="/docs/">Docs</a>
    <a href="https://github.com/kiluazen/chrome-relay">GitHub</a>
    <a href="https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb">Chrome Web Store</a>
  </div>
</nav>
<div class="layout">
  <aside class="sidebar" aria-label="Docs">${sidebar(page.slug)}</aside>
  <main>
    <h1>${page.title}</h1>
    <p class="page-desc">${page.description}</p>
    ${marked.parse(page.body)}
    ${pager(i)}
    <p class="md-link">Agents: this page as <a href="${mdUrl}">plain markdown</a> · all docs in <a href="/llms.txt">/llms.txt</a></p>
  </main>
</div>
<footer class="footer">
  <a href="https://kushalsm.com">kushalsm.com</a>
  <div><a href="/privacy/">Privacy</a> · <a href="/support/">Support</a></div>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Emit

let fullTxt = `# Chrome Relay — full documentation\n# ${SITE}\n\n`;
const llmsLines = [
  "# Chrome Relay",
  "",
  "> A local bridge between coding agents and the user's real Chrome — the session that already has cookies, SSO, extensions, and localhost. CLI → localhost HTTP → native messaging host → Chrome extension → CDP. Nothing leaves the machine.",
  "",
  "## Docs"
];

pages.forEach((page, i) => {
  const dir = page.slug === "index" ? join(OUT, "docs") : join(OUT, "docs", page.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), shell(page, i));

  const mdOut = `# ${page.title}\n\n> ${page.description}\n\n${page.body}`;
  writeFileSync(join(OUT, "docs", `${page.slug}.md`), mdOut);

  const mdUrl = `${SITE}/docs/${page.slug}.md`;
  llmsLines.push(`- [${page.title}](${mdUrl}): ${page.description}`);
  fullTxt += `\n\n---\n\n${mdOut}`;
});

llmsLines.push(
  "",
  "## Install",
  `- [Agent skill](${SITE}/skill.md): the playbook agents load to drive Chrome Relay`,
  "- CLI: `pnpm add -g chrome-relay && chrome-relay install`",
  "- Extension: https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb"
);
writeFileSync(join(OUT, "llms.txt"), llmsLines.join("\n") + "\n");
writeFileSync(join(OUT, "llms-full.txt"), fullTxt);

// Skill twin at the root — agents fetch /skill.md directly.
const skill = readFileSync(join(ROOT, "..", "skills", "chrome-relay", "SKILL.md"), "utf8")
  .replace(/<!--[\s\S]*?-->\n*/, ""); // drop the mirror banner
writeFileSync(join(OUT, "skill.md"), skill);

// Sitemap: landing pages + docs.
const staticUrls = ["/", "/privacy/", "/support/", "/terms/", "/docs/"];
const docUrls = pages.filter((p) => p.slug !== "index").map((p) => `/docs/${p.slug}/`);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticUrls, ...docUrls]
  .map((u) => `  <url>\n    <loc>${SITE}${u}</loc>\n  </url>`)
  .join("\n")}\n</urlset>\n`;
writeFileSync(join(OUT, "sitemap.xml"), sitemap);

// robots.txt — allow everything, point at the sitemap.
writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`built ${pages.length} pages → public/docs/, llms.txt, llms-full.txt, skill.md, sitemap.xml, robots.txt`);
