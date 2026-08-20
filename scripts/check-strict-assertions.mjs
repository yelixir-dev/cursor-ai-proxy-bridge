#!/usr/bin/env node
/* global console, process */
// Deterministic strict-type assertion gate over the task-changed TypeScript tree.
//
// Scans every currently changed (vs HEAD) or untracked TypeScript file for:
//   - non-null expressions            `expr!`
//   - definite-assignment assertions  `field!: T`
//   - explicit any                    `any` in a type position
//   - suppression comments            @ts-ignore / @ts-expect-error / @ts-nocheck / eslint-disable
//
// Inherited HEAD debt is excluded solely by comparing the current working tree
// against HEAD: only changed/untracked files are scanned. No timing, no network.
// Optional path-prefix arguments scope the scan (e.g. `src/benchmark tests/`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const TS_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;

function listTaskChangedFiles(scope) {
  const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  const deleted = new Set(
    execFileSync('git', ['status', '--porcelain=v1', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter((entry) => entry.startsWith(' D') || entry.startsWith('D '))
      .map((entry) => entry.slice(3)),
  );
  const inScope = (path) => scope.length === 0 || scope.some((prefix) => path.startsWith(prefix));
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])]
    .filter(
      (path) => path !== '' && TS_EXTENSIONS.test(path) && !deleted.has(path) && inScope(path),
    )
    .sort();
}

function scanFile(path) {
  const counts = { nonNullExpressions: 0, definiteAssignment: 0, explicitAny: 0, suppressions: 0 };
  const findings = [];
  const source = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (ts.isNonNullExpression(node)) {
      counts.nonNullExpressions += 1;
      findings.push(
        `${path}:${line + 1}:${character + 1} non-null expression \`${node.getText(sf)}\``,
      );
    }
    if (
      (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.exclamationToken
    ) {
      counts.definiteAssignment += 1;
      findings.push(`${path}:${line + 1}:${character + 1} definite-assignment assertion`);
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      counts.explicitAny += 1;
      findings.push(`${path}:${line + 1}:${character + 1} explicit any`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const comments = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  scanner.setText(source);
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      comments.push({ text: scanner.getTokenText(), pos: scanner.getTokenFullStart() });
    }
    token = scanner.scan();
  }
  for (const range of comments) {
    const suppressed = [
      ['@ts-ignore', /@ts-ignore/],
      ['@ts-expect-error', /@ts-expect-error/],
      ['@ts-nocheck', /@ts-nocheck/],
      ['eslint-disable', /eslint-disable/],
    ].filter(([, pattern]) => pattern.test(range.text));
    if (suppressed.length > 0) {
      counts.suppressions += 1;
      const { line, character } = sf.getLineAndCharacterOfPosition(range.pos);
      findings.push(
        `${path}:${line + 1}:${character + 1} suppression comment (${suppressed.map(([name]) => name).join(', ')})`,
      );
    }
  }
  return { counts, findings };
}

const files = listTaskChangedFiles(process.argv.slice(2));
const totals = { nonNullExpressions: 0, definiteAssignment: 0, explicitAny: 0, suppressions: 0 };
const allFindings = [];
for (const path of files) {
  const { counts, findings } = scanFile(path);
  for (const key of Object.keys(totals)) totals[key] += counts[key];
  allFindings.push(...findings);
}

console.log(`strict-assertion gate: scanned ${files.length} changed/untracked TypeScript files`);
console.log(
  `non-null expressions: ${totals.nonNullExpressions}, definite-assignment assertions: ${totals.definiteAssignment}, explicit any: ${totals.explicitAny}, suppressions: ${totals.suppressions}`,
);
if (allFindings.length > 0) {
  console.error(allFindings.join('\n'));
  process.exitCode = 1;
} else {
  console.log('strict-assertion gate: PASS');
}
