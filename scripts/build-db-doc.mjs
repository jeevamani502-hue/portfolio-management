/**
 * Builds a standalone HTML page from a Markdown document in docs/.
 *
 *   node scripts/build-db-doc.mjs                      # docs/DATABASE.md -> docs/DATABASE.html
 *   node scripts/build-db-doc.mjs docs/DEPLOY-ORACLE.md   # -> docs/DEPLOY-ORACLE.html
 *
 * The Markdown is the source of truth; the HTML is a standalone page (no
 * external assets) that can be opened from disk, emailed or hosted anywhere.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcArg = process.argv[2] ?? 'docs/DATABASE.md';
const src = join(root, srcArg);
const out = join(root, process.argv[3] ?? srcArg.replace(/\.md$/i, '.html'));
const srcName = srcArg.split('\\').join('/');

// marked is fetched on demand by npx; nothing to install in the repo. The
// Markdown goes in on stdin so a space in the repo path cannot break the call.
const markdown = readFileSync(src, 'utf8');
const body = execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['-y', 'marked@15', '--gfm'],
  { encoding: 'utf8', input: markdown, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' },
);

const title = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? 'AdviSha database').trim();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:light dark;--fg:#1f2328;--bg:#ffffff;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--accent:#0969da;--star:#9a6700}
  @media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#30363d;--code:#161b22;--accent:#4493f8;--star:#d29922}}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:1000px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:28px;margin:0 0 8px;border-bottom:1px solid var(--line);padding-bottom:10px}
  h2{font-size:21px;margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
  h3{font-size:17px;margin:24px 0 8px}
  p{margin:0 0 12px}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  table{border-collapse:collapse;width:100%;margin:12px 0 20px;font-size:14px}
  th,td{border:1px solid var(--line);padding:8px 10px;vertical-align:top;text-align:left}
  th{background:var(--code)}
  td:first-child{white-space:nowrap;width:1%}
  tr:has(td:first-child strong){background:color-mix(in srgb,var(--star) 8%,transparent)}
  code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
  pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:12px 14px;overflow-x:auto}
  pre code{background:none;padding:0}
  hr{border:0;border-top:1px solid var(--line);margin:28px 0}
  .note{color:var(--muted);font-size:13px;margin-top:40px;border-top:1px solid var(--line);padding-top:12px}
</style>
</head>
<body>
<main>
${body}
<p class="note">Generated from <code>${srcName}</code> by <code>scripts/build-db-doc.mjs</code>. Edit the Markdown and rebuild rather than editing this file.</p>
</main>
</body>
</html>
`;

writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
