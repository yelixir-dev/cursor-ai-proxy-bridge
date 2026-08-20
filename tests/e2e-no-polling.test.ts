import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function containsSetTimeout(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === 'setTimeout'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

describe('pinned E2E cleanup synchronization', () => {
  it('contains no timer-driven polling loop and retains the abort quiescence barrier', async () => {
    // Given: the executable E2E harness syntax tree.
    const paths = [
      'scripts/e2e-smoke.mjs',
      'scripts/e2e/http.mjs',
      'scripts/e2e/scenarios-streaming.mjs',
      'scripts/e2e/server.mjs',
    ];
    const source = (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');
    const file = ts.createSourceFile('e2e-modules.mjs', source, ts.ScriptTarget.Latest, true);
    const timerLoops: string[] = [];
    let quiescenceBarrierCalls = 0;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)) &&
        containsSetTimeout(node.statement)
      ) {
        timerLoops.push(node.getText(file));
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'triggerAndAwaitAbortQuiescence'
      ) {
        quiescenceBarrierCalls += 1;
      }
      ts.forEachChild(node, visit);
    };

    // When: process-cleanup synchronization constructs are enumerated.
    visit(file);

    // Then: cleanup uses one event barrier and no timer-driven polling loop.
    expect(timerLoops).toEqual([]);
    expect(quiescenceBarrierCalls).toBe(1);
  });
});
