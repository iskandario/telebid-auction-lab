import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TrialResult } from './research.types.js';
import { evaluateHypotheses } from './verdicts.js';

function passingTrial(disconnect: boolean): TrialResult {
  return {
    config: {
      runId: 'run',
      trialId: disconnect ? 'reconnect-direct-r1' : 'baseline-direct-r1',
      name: disconnect ? 'reconnect' : 'baseline',
      repetition: 1,
      auctionKind: 'DIRECT',
      seed: 1,
      clientsPerTransport: 2,
      bidCount: 4,
      concurrency: 2,
      commandIntervalMs: 0,
      pollIntervalMs: 250,
      networkLatencyMs: 20,
      networkJitterMs: 5,
      disconnectAfterFraction: disconnect ? 0.5 : null,
      disconnectDurationMs: disconnect ? 300 : 0,
      duplicateRate: 0.25,
      recoveryStrategy: 'replay',
      convergenceTimeoutMs: 5_000,
    },
    auctionId: 'auction',
    durationMs: 100,
    acceptedCommands: 4,
    rejectedCommands: 0,
    duplicateAttempts: 1,
    idempotentReplays: 1,
    duplicateCommandEffects: 0,
    expectedWinnerId: 'winner',
    actualWinnerId: 'winner',
    expectedPrice: 10,
    actualPrice: 10,
    winnerCorrect: true,
    authoritativeEventCount: 4,
    eventSequenceContinuous: true,
    transports: [
      { transport: 'polling', clientCount: 2, convergedClients: 2, staleClients: 0, missingEvents: 0, duplicateDeliveries: 0, clientsWithObservedGaps: 0, payloadBytes: 900, payloadBytesPerClient: 450, requests: 6, failedRequests: 0, reconnects: disconnect ? 2 : 0, p50LatencyMs: 120, p95LatencyMs: 220, maxLatencyMs: 230, p95RecoveryMs: disconnect ? 500 : null },
      { transport: 'sse', clientCount: 2, convergedClients: 2, staleClients: 0, missingEvents: 0, duplicateDeliveries: 0, clientsWithObservedGaps: 0, payloadBytes: 700, payloadBytesPerClient: 350, requests: 2, failedRequests: 0, reconnects: disconnect ? 2 : 0, p50LatencyMs: 8, p95LatencyMs: 16, maxLatencyMs: 20, p95RecoveryMs: disconnect ? 600 : null },
      { transport: 'websocket', clientCount: 2, convergedClients: 2, staleClients: 0, missingEvents: 0, duplicateDeliveries: 0, clientsWithObservedGaps: 0, payloadBytes: 680, payloadBytesPerClient: 340, requests: 2, failedRequests: 0, reconnects: disconnect ? 2 : 0, p50LatencyMs: 5, p95LatencyMs: 12, maxLatencyMs: 15, p95RecoveryMs: disconnect ? 200 : null },
    ],
    clients: [],
    notifications: {
      total: 7,
      duplicates: 0,
      orphaned: 0,
      afterCursorCount: 0,
      p95LatencyMs: 2,
      telegramDelivered: 7,
      telegramPending: 0,
      telegramFailed: 0,
      telegramSkipped: 0,
      telegramRetried: 7,
      p95TelegramDeliveryMs: 120,
      miniAppRecipientId: '700000001',
      miniAppExpected: 5,
      miniAppReceived: 5,
      miniAppMissing: 0,
      miniAppLive: disconnect ? 3 : 5,
      miniAppReplayed: disconnect ? 2 : 0,
      miniAppDuplicates: 0,
      miniAppCausalViolations: 0,
      p95MiniAppLatencyMs: 20,
      p95MiniAppDisplayLatencyMs: 22,
    },
    recovery: { sinceVersion: 3, serverVersion: 5, snapshotBytes: 400, replayBytes: 300, hybridBytes: 300, hybridMode: 'events', expectedHybridMode: 'events', sameFinalVersion: true, replayContinuous: true },
    eventRows: [],
    commandRows: [],
    notificationRows: [],
  };
}

describe('pilot hypothesis evaluator', () => {
  it('supports all hypotheses for consistent live and reconnect trials', () => {
    const verdicts = evaluateHypotheses([passingTrial(false), passingTrial(true)]);
    assert.equal(verdicts.length, 5);
    assert.ok(verdicts.every((verdict) => verdict.status === 'SUPPORTED'));
  });

  it('rejects trade correctness when a duplicate command changes state twice', () => {
    const trial = passingTrial(false);
    trial.duplicateCommandEffects = 1;
    const verdict = evaluateHypotheses([trial]).find((item) => item.id === 'H1');
    assert.equal(verdict?.status, 'NOT_SUPPORTED');
  });
});
