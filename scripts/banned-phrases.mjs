#!/usr/bin/env node
/**
 * Financial-safety linter (Architecture doc, section J.2).
 * Fails the build if guarantee-style language appears anywhere in source.
 * This file itself and the docs that define the rule are excluded.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, sep } from 'node:path';

const BANNED = [
  /\bguaranteed\s+(profit|return|target|gain)/i,
  /\bassured\s+returns?\b/i,
  /\bsure\s*-?\s*shot\b/i,
  /\b100\s*%\s*(accurate|accuracy|guaranteed|profitable)/i,
  /\bwill\s+(definitely|surely|certainly)\s+(rise|fall|go\s+up|go\s+down)/i,
  /\brisk\s*-?\s*free\s+(profit|trade|return)/i,
  /\bcan'?t\s+lose\b/i,
];
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.sql', '.md', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const SKIP_FILES = new Set(['banned-phrases.mjs', 'ARCHITECTURE.md', 'SAFETY.md']);

/**
 * Paths whose whole job is to DETECT guarantee-style language, and the docs
 * that define the rule. A validator that matches "assured returns" must
 * necessarily contain the string "assured returns"; flagging it would make
 * the check unable to coexist with its own enforcement.
 *
 * Kept as an explicit, short list rather than a pattern, so adding an
 * exemption is a visible decision in review.
 */
const ENFORCEMENT_PATHS = [
  'src/ai/validator.ts',
  'src/ai/prompts.ts',
  'src/ai/__tests__/validator.test.ts',
];

const isEnforcement = (p) => {
  // Normalise Windows separators so the suffix match works on every platform.
  const norm = p.split(sep).join('/');
  return ENFORCEMENT_PATHS.some((suffix) => norm.endsWith(suffix));
};

const root = process.cwd();
const findings = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!EXTS.has(extname(name)) || SKIP_FILES.has(name)) continue;
    if (isEnforcement(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const re of BANNED) {
        if (re.test(line)) findings.push(`${p}:${i + 1}  ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

walk(root);
if (findings.length) {
  console.error('\nFinancial-safety linter FAILED. Guarantee-style language found:\n');
  findings.forEach((f) => console.error('  ' + f));
  console.error(`\n${findings.length} violation(s).\n`);
  process.exit(1);
}
console.log('Financial-safety linter passed: no guarantee-style language found.');
