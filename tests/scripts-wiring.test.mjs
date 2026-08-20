import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_ARGV } from '../scripts/e2e/config.mjs';
import { callsFrom, messageFrom, sseFrames } from '../scripts/e2e/http.mjs';
import { formatTable } from '../scripts/e2e/reporter.mjs';
import { createScenarios, SCENARIO_IDS } from '../scripts/e2e/scenarios.mjs';
import { resolveBundleDir } from '../scripts/protos/bundle.mjs';
import {
  buildDescriptorOutput,
  serializeDescriptorOutput,
} from '../scripts/protos/descriptors.mjs';

function messageType(typeName, fields) {
  function Descriptor() {}
  Descriptor.typeName = typeName;
  Descriptor.fields = { list: () => fields };
  return Descriptor;
}

describe('zero-network script wiring', () => {
  it('constructs all scenarios without triggering requests', () => {
    // Given: inert wiring dependencies with no network surface.
    const context = {
      baseUrl: 'http://invalid.local',
      traceProvenance: {},
      triggerAndAwaitAbortQuiescence: () => Promise.resolve(),
    };

    // When: the scenario registry is assembled without running scenario bodies.
    const scenarios = createScenarios(context);

    // Then: the exact command and 24-scenario registration contract is preserved.
    expect(SERVER_ARGV).toEqual(['dist/index.js']);
    expect(scenarios.map(({ id }) => id)).toEqual(SCENARIO_IDS);
    expect(scenarios).toHaveLength(24);
    expect(scenarios.every(({ run }) => typeof run === 'function')).toBe(true);
  });

  it('parses synthetic OpenAI and SSE output without network access', () => {
    // Given: machine-shaped completion and SSE records.
    const body = { choices: [{ message: { tool_calls: [{ id: 'call-1' }] } }] };
    const stream = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';

    // When: output parsers consume the records.
    const message = messageFrom(body);
    const calls = callsFrom(body);
    const frames = sseFrames(stream);

    // Then: the observable parser contracts remain stable.
    expect(message).toEqual(body.choices[0].message);
    expect(calls).toEqual([{ id: 'call-1' }]);
    expect(frames).toEqual([{ choices: [] }]);
  });

  it('formats the stable report columns', () => {
    // Given: one deterministic result row.
    const rows = [{ name: 'health 200', result: 'PASS', latencyMs: 1250, detail: '' }];

    // When: the report table is rendered.
    const output = formatTable(rows, 'cursor-api');

    // Then: backend, columns, result, and seconds are machine-readable.
    expect(output.split('\n')).toEqual([
      '',
      'Backend: cursor-api',
      'Scenario   | Result | Latency',
      '-----------+--------+----------',
      'health 200 | PASS   |    1.25s',
    ]);
  });

  it('builds a deterministic protobuf artifact from a dry descriptor fixture', () => {
    // Given: two in-memory descriptor types and a fixed extraction timestamp.
    const child = messageType('fixture.Child', [
      { no: 1, name: 'label', localName: 'label', kind: 'scalar', repeated: false, T: 9 },
    ]);
    const root = messageType('fixture.Root', [
      { no: 2, name: 'child', localName: 'child', kind: 'message', repeated: false, T: child },
      { no: 1, name: 'count', localName: 'count', kind: 'scalar', repeated: false, T: 5 },
    ]);
    const types = new Map([
      ['fixture.Root', root],
      ['fixture.Child', child],
    ]);

    // When: extraction runs entirely against the dry fixture.
    const output = buildDescriptorOutput({
      types,
      bundleVersion: 'fixture-1',
      extractedAt: '2026-08-19T00:00:00.000Z',
      roots: ['fixture.Root'],
      services: [],
      selected: new Map([
        ['fixture.Root', ['child', 'count']],
        ['fixture.Child', '*'],
      ]),
      extraRoots: [],
    });

    // Then: sorted descriptors and serialized JSON are byte-deterministic.
    expect(output).toEqual({
      format: 1,
      extractedAt: '2026-08-19T00:00:00.000Z',
      bundleVersion: 'fixture-1',
      clientVersion: 'cli-fixture-1',
      roots: ['fixture.Root'],
      services: [],
      messages: {
        'fixture.Child': {
          fields: [
            {
              no: 1,
              name: 'label',
              localName: 'label',
              kind: 'scalar',
              repeated: false,
              scalar: 9,
            },
          ],
        },
        'fixture.Root': {
          fields: [
            {
              no: 2,
              name: 'child',
              localName: 'child',
              kind: 'message',
              repeated: false,
              message: 'fixture.Child',
            },
            {
              no: 1,
              name: 'count',
              localName: 'count',
              kind: 'scalar',
              repeated: false,
              scalar: 5,
            },
          ],
        },
      },
    });
    expect(serializeDescriptorOutput(output)).toBe(`${JSON.stringify(output, null, 2)}\n`);
    expect(resolveBundleDir(['node', 'extract-protos', './fixture-bundle'], {})).toBe(
      path.resolve('./fixture-bundle'),
    );
  });
});
