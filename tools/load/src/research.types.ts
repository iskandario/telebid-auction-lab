export type AuctionKind = 'DIRECT' | 'REVERSE';
export type Transport = 'polling' | 'sse' | 'websocket';
export type RecoveryStrategy = 'snapshot' | 'replay' | 'hybrid';

export interface AuctionSnapshot {
  id: string;
  kind: AuctionKind;
  currentPrice: number;
  minStep: number;
  leaderId: string | null;
  version: number;
}

export interface AuctionEvent {
  eventId: string;
  auctionId: string;
  aggregateVersion: number;
  type: string;
  serverTimestamp: string;
  correlationId: string;
  payload: Record<string, unknown>;
}

export interface NotificationView {
  sequence: string;
  notificationId: string;
  recipientId: string;
  auctionId: string;
  eventId: string;
  aggregateVersion: number;
  kind: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  telegramStatus: string;
  telegramDeliveredAt: string | null;
  telegramAttempts: number;
  telegramLastError: string | null;
}

export type SyncResponse =
  | {
      mode: 'snapshot';
      serverVersion: number;
      snapshot: AuctionSnapshot;
      estimatedBytes: number;
    }
  | {
      mode: 'events';
      serverVersion: number;
      events: AuctionEvent[];
      estimatedBytes: number;
    };

export interface ScenarioConfig {
  name: string;
  clientsPerTransport: number;
  bidCount: number;
  concurrency: number;
  commandIntervalMs: number;
  pollIntervalMs: number;
  networkLatencyMs: number;
  networkJitterMs: number;
  disconnectAfterFraction: number | null;
  disconnectDurationMs: number;
  duplicateRate: number;
  recoveryStrategy: RecoveryStrategy;
  convergenceTimeoutMs: number;
}

export interface TrialConfig extends ScenarioConfig {
  runId: string;
  trialId: string;
  auctionKind: AuctionKind;
  repetition: number;
  seed: number;
}

export interface EventRow {
  runId: string;
  trialId: string;
  scenario: string;
  repetition: number;
  auctionKind: AuctionKind;
  clientId: string;
  transport: Transport;
  eventId: string;
  eventType: string;
  aggregateVersion: number;
  serverTimestamp: string;
  receivedAt: string;
  latencyMs: number;
  payloadBytes: number;
  duplicateDelivery: number;
  observedVersionGap: number;
}

export interface CommandRow {
  runId: string;
  trialId: string;
  scenario: string;
  repetition: number;
  auctionKind: AuctionKind;
  commandId: string;
  attempt: number;
  participantId: string;
  amount: number;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  httpStatus: number;
  accepted: number;
  idempotentReplay: number;
  responseVersion: number | null;
  errorCode: string;
}

export interface NotificationRow {
  runId: string;
  trialId: string;
  scenario: string;
  repetition: number;
  auctionKind: AuctionKind;
  recipientId: string;
  notificationId: string;
  sequence: string;
  kind: string;
  aggregateVersion: number;
  source: 'live' | 'replay';
  createdAt: string;
  receivedAt: string;
  latencyMs: number;
  stateVersionAtReceipt: number;
  displayedAt: string | null;
  displayLatencyMs: number | null;
  duplicateDelivery: number;
  causalOrderViolation: number;
}

export interface ClientSummary {
  clientId: string;
  transport: Transport;
  received: number;
  missing: number;
  duplicateDeliveries: number;
  observedVersionGaps: number;
  payloadBytes: number;
  requests: number;
  failedRequests: number;
  reconnects: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  maxLatencyMs: number | null;
  finalVersion: number;
  converged: boolean;
  recoveryMs: number | null;
}

export interface TransportSummary {
  transport: Transport;
  clientCount: number;
  convergedClients: number;
  staleClients: number;
  missingEvents: number;
  duplicateDeliveries: number;
  clientsWithObservedGaps: number;
  payloadBytes: number;
  payloadBytesPerClient: number;
  requests: number;
  failedRequests: number;
  reconnects: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  maxLatencyMs: number | null;
  p95RecoveryMs: number | null;
}

export interface NotificationEvidence {
  total: number;
  duplicates: number;
  orphaned: number;
  afterCursorCount: number;
  p95LatencyMs: number | null;
  telegramDelivered: number;
  telegramPending: number;
  telegramFailed: number;
  telegramSkipped: number;
  telegramRetried: number;
  p95TelegramDeliveryMs: number | null;
  miniAppRecipientId: string;
  miniAppExpected: number;
  miniAppReceived: number;
  miniAppMissing: number;
  miniAppLive: number;
  miniAppReplayed: number;
  miniAppDuplicates: number;
  miniAppCausalViolations: number;
  p95MiniAppLatencyMs: number | null;
  p95MiniAppDisplayLatencyMs: number | null;
}

export interface RecoveryEvidence {
  sinceVersion: number;
  serverVersion: number;
  snapshotBytes: number;
  replayBytes: number;
  hybridBytes: number;
  hybridMode: 'snapshot' | 'events';
  expectedHybridMode: 'snapshot' | 'events';
  sameFinalVersion: boolean;
  replayContinuous: boolean;
}

export interface TrialResult {
  config: TrialConfig;
  auctionId: string;
  durationMs: number;
  acceptedCommands: number;
  rejectedCommands: number;
  duplicateAttempts: number;
  idempotentReplays: number;
  duplicateCommandEffects: number;
  expectedWinnerId: string;
  actualWinnerId: string | null;
  expectedPrice: number;
  actualPrice: number;
  winnerCorrect: boolean;
  authoritativeEventCount: number;
  eventSequenceContinuous: boolean;
  transports: TransportSummary[];
  clients: ClientSummary[];
  notifications: NotificationEvidence;
  recovery: RecoveryEvidence;
  eventRows: EventRow[];
  commandRows: CommandRow[];
  notificationRows: NotificationRow[];
}

export interface DescriptiveStatistics {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
  standardDeviation: number | null;
  meanCi95Low: number | null;
  meanCi95High: number | null;
}

export interface AggregateSummary {
  scenario: string;
  auctionKind: AuctionKind;
  transport: Transport;
  trials: number;
  clientCount: number;
  winnerCorrectRate: number;
  convergedClientRate: number;
  missingEventRate: number;
  latencyMs: DescriptiveStatistics;
  recoveryMs: DescriptiveStatistics;
  payloadBytesPerClient: DescriptiveStatistics;
}

export interface HypothesisVerdict {
  id: 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
  title: string;
  status: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE';
  criterion: string;
  evidence: string;
}
