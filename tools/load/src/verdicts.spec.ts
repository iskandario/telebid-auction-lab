import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateHypotheses, type ScenarioEvidence } from './verdicts.js';

function passingScenario(kind: 'DIRECT' | 'REVERSE'): ScenarioEvidence {
  return {
    kind,
    commands: { accepted: 4, rejected: 2 },
    authoritativeEventCount: 4,
    transports: [
      { transport: 'polling', received: 4, missing: 0, duplicates: 0, gaps: 0, bytes: 900, p50LatencyMs: 120, p95LatencyMs: 220, maxLatencyMs: 230, finalVersion: 5 },
      { transport: 'sse', received: 4, missing: 0, duplicates: 0, gaps: 0, bytes: 700, p50LatencyMs: 8, p95LatencyMs: 16, maxLatencyMs: 20, finalVersion: 5 },
      { transport: 'websocket', received: 4, missing: 0, duplicates: 0, gaps: 0, bytes: 680, p50LatencyMs: 5, p95LatencyMs: 12, maxLatencyMs: 15, finalVersion: 5 },
    ],
    notifications: { total: 7, duplicates: 0, orphaned: 0, afterCursorCount: 0, p95LatencyMs: 2 },
    recovery: {
      sinceVersion: 3,
      serverVersion: 5,
      snapshotBytes: 400,
      replayBytes: 300,
      hybridBytes: 300,
      hybridMode: 'events',
      expectedHybridMode: 'events',
      sameFinalVersion: true,
      replayContinuous: true,
    },
  };
}

describe('hypothesis evaluator', () => {
  it('passes all hypotheses for consistent measurements', () => {
    const verdicts = evaluateHypotheses([passingScenario('DIRECT'), passingScenario('REVERSE')]);
    assert.equal(verdicts.length, 4);
    assert.ok(verdicts.every((verdict) => verdict.passed));
  });

  it('rejects notification hypothesis when an orphan appears', () => {
    const scenario = passingScenario('DIRECT');
    scenario.notifications.orphaned = 1;
    const verdict = evaluateHypotheses([scenario]).find((item) => item.id === 'H4');
    assert.equal(verdict?.passed, false);
  });
});
