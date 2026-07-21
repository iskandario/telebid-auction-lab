import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventSource } from 'eventsource';
import { io, type Socket } from 'socket.io-client';
import { evaluateHypotheses, type RecoveryEvidence, type ScenarioEvidence } from './verdicts.js';

type AuctionKind = 'DIRECT' | 'REVERSE';
type Transport = 'polling' | 'sse' | 'websocket';

interface AuctionSnapshot {
  id: string;
  kind: AuctionKind;
  currentPrice: number;
  minStep: number;
  version: number;
}

interface AuctionEvent {
  eventId: string;
  auctionId: string;
  aggregateVersion: number;
  type: string;
  serverTimestamp: string;
  payload: Record<string, unknown>;
}

interface NotificationView {
  sequence: string;
  notificationId: string;
  recipientId: string;
  auctionId: string;
  eventId: string;
  aggregateVersion: number;
  kind: string;
  createdAt: string;
}

type SyncResponse =
  | { mode: 'snapshot'; serverVersion: number; snapshot: AuctionSnapshot; estimatedBytes: number }
  | { mode: 'events'; serverVersion: number; events: AuctionEvent[]; estimatedBytes: number };

interface EventRow {
  runId: string;
  auctionKind: AuctionKind;
  transport: Transport;
  eventId: string;
  eventType: string;
  aggregateVersion: number;
  serverTimestamp: string;
  receivedAt: string;
  latencyMs: number;
  bytes: number;
  duplicate: number;
  gap: number;
}

interface CollectorSummary {
  transport: Transport;
  received: number;
  missing: number;
  duplicates: number;
  gaps: number;
  bytes: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  maxLatencyMs: number | null;
  finalVersion: number;
}

const API_URL = process.env.API_URL ?? 'http://localhost:8080';
const BID_COUNT = positiveInteger(process.env.BID_COUNT, 24);
const CONCURRENCY = positiveInteger(process.env.CONCURRENCY, 4);
const POLL_INTERVAL_MS = positiveInteger(process.env.POLL_INTERVAL_MS, 250);
const SETTLE_MS = positiveInteger(process.env.SETTLE_MS, 1500);
const datasetDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../datasets');

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, durationMs));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init?.method ?? 'GET'} ${path}: HTTP ${response.status} ${body}`);
  }
  return response.json() as Promise<T>;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] ?? null;
}

class EventCollector {
  readonly rows: EventRow[] = [];
  readonly eventIds = new Set<string>();
  lastVersion: number;
  duplicates = 0;
  gaps = 0;
  bytes = 0;

  constructor(
    readonly transport: Transport,
    private readonly runId: string,
    private readonly auctionKind: AuctionKind,
    initialVersion: number,
  ) {
    this.lastVersion = initialVersion;
  }

  accept(event: AuctionEvent, bytes = JSON.stringify(event).length): void {
    const duplicate = this.eventIds.has(event.eventId) || event.aggregateVersion <= this.lastVersion;
    const gap = !duplicate && event.aggregateVersion > this.lastVersion + 1;
    if (duplicate) this.duplicates += 1;
    if (gap) this.gaps += 1;
    this.bytes += bytes;
    if (!duplicate) {
      this.eventIds.add(event.eventId);
      this.lastVersion = event.aggregateVersion;
    }

    const receivedAt = new Date();
    this.rows.push({
      runId: this.runId,
      auctionKind: this.auctionKind,
      transport: this.transport,
      eventId: event.eventId,
      eventType: event.type,
      aggregateVersion: event.aggregateVersion,
      serverTimestamp: event.serverTimestamp,
      receivedAt: receivedAt.toISOString(),
      latencyMs: Math.max(0, receivedAt.getTime() - Date.parse(event.serverTimestamp)),
      bytes,
      duplicate: duplicate ? 1 : 0,
      gap: gap ? 1 : 0,
    });
  }

  summary(authoritativeEvents: AuctionEvent[]): CollectorSummary {
    const expectedIds = new Set(authoritativeEvents.map((event) => event.eventId));
    const missing = [...expectedIds].filter((eventId) => !this.eventIds.has(eventId)).length;
    const latencies = this.rows.filter((row) => !row.duplicate).map((row) => row.latencyMs);
    return {
      transport: this.transport,
      received: this.eventIds.size,
      missing,
      duplicates: this.duplicates,
      gaps: this.gaps,
      bytes: this.bytes,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
      finalVersion: this.lastVersion,
    };
  }
}

interface Observer {
  collector: EventCollector;
  stop(): Promise<void>;
}

async function createPollingObserver(
  auction: AuctionSnapshot,
  runId: string,
): Promise<Observer> {
  const collector = new EventCollector('polling', runId, auction.kind, auction.version);
  let running = true;
  let requestRunning = false;

  const poll = async () => {
    if (!running || requestRunning) return;
    requestRunning = true;
    try {
      const response = await request<SyncResponse>(
        `/auctions/${auction.id}/sync?sinceVersion=${collector.lastVersion}&strategy=replay`,
      );
      collector.bytes += response.estimatedBytes;
      if (response.mode === 'events') response.events.forEach((event) => collector.accept(event, 0));
      else collector.lastVersion = response.snapshot.version;
    } finally {
      requestRunning = false;
    }
  };

  await poll();
  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  return {
    collector,
    async stop() {
      clearInterval(timer);
      while (requestRunning) await wait(10);
      await poll();
      running = false;
    },
  };
}

async function createSseObserver(auction: AuctionSnapshot, runId: string): Promise<Observer> {
  const collector = new EventCollector('sse', runId, auction.kind, auction.version);
  const source = new EventSource(`${API_URL}/auctions/${auction.id}/events?sinceVersion=${auction.version}`);
  const types = ['AUCTION_CREATED', 'BID_ACCEPTED', 'AUCTION_EXTENDED', 'AUCTION_CLOSED'];
  types.forEach((type) => {
    source.addEventListener(type, (message) => {
      const data = String((message as MessageEvent).data);
      collector.accept(JSON.parse(data) as AuctionEvent, data.length);
    });
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error('SSE connection timeout')), 5000);
    source.onopen = () => {
      clearTimeout(timeout);
      resolveOpen();
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        clearTimeout(timeout);
        rejectOpen(new Error('SSE connection closed'));
      }
    };
  });
  return {
    collector,
    async stop() {
      source.close();
    },
  };
}

async function createWebSocketObserver(auction: AuctionSnapshot, runId: string): Promise<Observer> {
  const collector = new EventCollector('websocket', runId, auction.kind, auction.version);
  const socket: Socket = io(`${API_URL}/sync`, { transports: ['websocket'], reconnection: false });
  let syncing = true;
  const buffered: AuctionEvent[] = [];

  socket.on('auction:event', (event: AuctionEvent) => {
    if (syncing) buffered.push(event);
    else collector.accept(event);
  });
  socket.on('sync:payload', ({ payload }: { payload: SyncResponse }) => {
    collector.bytes += payload.estimatedBytes;
    if (payload.mode === 'events') payload.events.forEach((event) => collector.accept(event, 0));
    else collector.lastVersion = payload.snapshot.version;
  });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('WebSocket connection timeout')), 5000);
    socket.on('connect', () => {
      socket.emit('subscribe:auction', {
        auctionId: auction.id,
        lastAppliedVersion: auction.version,
        strategy: 'replay',
        requestId: crypto.randomUUID(),
      });
    });
    socket.on('sync:complete', () => {
      buffered
        .splice(0)
        .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
        .forEach((event) => collector.accept(event));
      syncing = false;
      clearTimeout(timeout);
      resolveReady();
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
  });
  await ready;
  return {
    collector,
    async stop() {
      socket.disconnect();
    },
  };
}

async function createAuction(kind: AuctionKind, runId: string): Promise<AuctionSnapshot> {
  return request<AuctionSnapshot>('/auctions', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      title: `[experiment ${runId}] ${kind === 'DIRECT' ? 'Слот блогера' : 'Кампания бренда'}`,
      description: 'Автоматически создано TypeScript-генератором нагрузки',
      ownerId: kind === 'DIRECT' ? 'experiment-blogger' : 'experiment-advertiser',
      startingPrice: kind === 'DIRECT' ? 10_000 : 100_000,
      minStep: 500,
      durationSeconds: 90,
      antiSnipingWindowSec: 0,
      extensionSec: 0,
    }),
  });
}

async function submitBids(auction: AuctionSnapshot): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  const jobs = Array.from({ length: BID_COUNT }, (_, index) => {
    const sequence = index + 1;
    const amount =
      auction.kind === 'DIRECT'
        ? auction.currentPrice + sequence * auction.minStep
        : auction.currentPrice - sequence * auction.minStep;
    return async () => {
      try {
        await request(`/auctions/${auction.id}/bids`, {
          method: 'POST',
          body: JSON.stringify({
            participantId: `load-bidder-${index % Math.max(3, CONCURRENCY)}`,
            amount,
            commandId: crypto.randomUUID(),
          }),
        });
        accepted += 1;
      } catch {
        rejected += 1;
      }
    };
  });

  for (let offset = 0; offset < jobs.length; offset += CONCURRENCY) {
    await Promise.all(jobs.slice(offset, offset + CONCURRENCY).map((job) => job()));
    await wait(15);
  }
  return { accepted, rejected };
}

async function auditNotifications(
  auctionId: string,
  authoritativeEvents: AuctionEvent[],
): Promise<{
  total: number;
  duplicates: number;
  orphaned: number;
  afterCursorCount: number;
  p95LatencyMs: number | null;
}> {
  const eventVersions = new Set(authoritativeEvents.map((event) => event.aggregateVersion));
  const recipientResults = await Promise.all(
    Array.from({ length: Math.max(3, CONCURRENCY) }, async (_, index) => {
      const recipientId = `load-bidder-${index}`;
      const initial = await request<NotificationView[]>(`/notifications/${recipientId}?afterSequence=0`);
      const cursor = initial.reduce(
        (maximum, notification) => Math.max(maximum, Number(notification.sequence)),
        0,
      );
      const afterCursor = await request<NotificationView[]>(
        `/notifications/${recipientId}?afterSequence=${cursor}`,
      );
      return { initial, afterCursor };
    }),
  );
  const notifications = recipientResults
    .flatMap((result) => result.initial)
    .filter((notification) => notification.auctionId === auctionId);
  const afterCursorCount = recipientResults
    .flatMap((result) => result.afterCursor)
    .filter((notification) => notification.auctionId === auctionId).length;
  const unique = new Set<string>();
  let duplicates = 0;
  let orphaned = 0;
  const latencies: number[] = [];
  notifications.forEach((notification) => {
    if (unique.has(notification.notificationId)) duplicates += 1;
    unique.add(notification.notificationId);
    if (!eventVersions.has(notification.aggregateVersion)) orphaned += 1;
    const event = authoritativeEvents.find((candidate) => candidate.eventId === notification.eventId);
    if (event) latencies.push(Math.max(0, Date.parse(notification.createdAt) - Date.parse(event.serverTimestamp)));
  });
  return {
    total: notifications.length,
    duplicates,
    orphaned,
    afterCursorCount,
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

function responseVersion(response: SyncResponse): number {
  return response.mode === 'snapshot'
    ? response.snapshot.version
    : (response.events.at(-1)?.aggregateVersion ?? response.serverVersion);
}

async function auditRecovery(
  auctionId: string,
  initialVersion: number,
  finalVersion: number,
): Promise<RecoveryEvidence> {
  const versionDistance = finalVersion - initialVersion;
  const sinceVersion = Math.max(initialVersion, finalVersion - Math.max(1, Math.ceil(versionDistance / 2)));
  const [snapshot, replay, hybrid] = await Promise.all([
    request<SyncResponse>(`/auctions/${auctionId}/sync?sinceVersion=${sinceVersion}&strategy=snapshot`),
    request<SyncResponse>(`/auctions/${auctionId}/sync?sinceVersion=${sinceVersion}&strategy=replay`),
    request<SyncResponse>(`/auctions/${auctionId}/sync?sinceVersion=${sinceVersion}&strategy=hybrid`),
  ]);
  const replayEvents = replay.mode === 'events' ? replay.events : [];
  const replayContinuous =
    replay.mode === 'events' &&
    replayEvents.every(
      (event, index) => event.aggregateVersion === sinceVersion + index + 1,
    ) &&
    (replayEvents.at(-1)?.aggregateVersion ?? sinceVersion) === finalVersion;
  const expectedHybridMode = replay.estimatedBytes <= snapshot.estimatedBytes ? 'events' : 'snapshot';
  return {
    sinceVersion,
    serverVersion: finalVersion,
    snapshotBytes: snapshot.estimatedBytes,
    replayBytes: replay.estimatedBytes,
    hybridBytes: hybrid.estimatedBytes,
    hybridMode: hybrid.mode,
    expectedHybridMode,
    sameFinalVersion:
      responseVersion(snapshot) === finalVersion &&
      responseVersion(replay) === finalVersion &&
      responseVersion(hybrid) === finalVersion,
    replayContinuous,
  };
}

async function runScenario(kind: AuctionKind, runId: string) {
  const auction = await createAuction(kind, runId);
  const observers = await Promise.all([
    createPollingObserver(auction, runId),
    createSseObserver(auction, runId),
    createWebSocketObserver(auction, runId),
  ]);
  const commands = await submitBids(auction);
  await wait(SETTLE_MS);
  await Promise.all(observers.map((observer) => observer.stop()));

  const authoritative = await request<SyncResponse>(
    `/auctions/${auction.id}/sync?sinceVersion=${auction.version}&strategy=replay`,
  );
  if (authoritative.mode !== 'events') throw new Error('Authoritative replay unexpectedly returned snapshot');
  const notifications = await auditNotifications(auction.id, authoritative.events);
  const recovery = await auditRecovery(auction.id, auction.version, authoritative.serverVersion);

  return {
    auctionId: auction.id,
    kind,
    commands,
    authoritativeEventCount: authoritative.events.length,
    transports: observers.map((observer) => observer.collector.summary(authoritative.events)),
    notifications,
    recovery,
    rows: observers.flatMap((observer) => observer.collector.rows),
  };
}

function toCsv(rows: EventRow[]): string {
  const columns: Array<keyof EventRow> = [
    'runId',
    'auctionKind',
    'transport',
    'eventId',
    'eventType',
    'aggregateVersion',
    'serverTimestamp',
    'receivedAt',
    'latencyMs',
    'bytes',
    'duplicate',
    'gap',
  ];
  const escape = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  return [columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n');
}

function toMarkdownReport(
  runId: string,
  verdicts: ReturnType<typeof evaluateHypotheses>,
  scenarios: ScenarioEvidence[],
): string {
  const verdictRows = verdicts.map(
    (verdict) =>
      `| ${verdict.id} | ${verdict.title} | ${verdict.passed ? 'PASS' : 'FAIL'} | ${verdict.evidence} |`,
  );
  const transportRows = scenarios.flatMap((scenario) =>
    scenario.transports.map(
      (item) =>
        `| ${scenario.kind} | ${item.transport} | ${item.p50LatencyMs ?? '—'} | ${item.p95LatencyMs ?? '—'} | ${item.missing} | ${item.gaps} | ${item.bytes} |`,
    ),
  );
  return [
    '# Отчёт автоматической проверки гипотез',
    '',
    `Запуск: \`${runId}\``,
    '',
    '## Вердикты',
    '',
    '| ID | Гипотеза | Результат | Наблюдение |',
    '| --- | --- | --- | --- |',
    ...verdictRows,
    '',
    '## Метрики транспортов',
    '',
    '| Аукцион | Транспорт | p50, мс | p95, мс | Пропущено | Разрывы версий | Байт |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...transportRows,
    '',
    'Один запуск является пилотной проверкой. Для выводов НИР эксперимент повторяется сериями с разной нагрузкой и сетевыми условиями.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
  process.stdout.write(`TeleBid transport experiment ${runId}\nAPI: ${API_URL}\n`);
  const scenarios = [];
  for (const kind of ['DIRECT', 'REVERSE'] as const) {
    process.stdout.write(`Running ${kind} scenario…\n`);
    scenarios.push(await runScenario(kind, runId));
  }

  await mkdir(datasetDirectory, { recursive: true });
  const rows = scenarios.flatMap((scenario) => scenario.rows);
  const scenarioEvidence: ScenarioEvidence[] = scenarios.map(({ rows: ignoredRows, auctionId: ignoredAuctionId, ...scenario }) => scenario);
  const verdicts = evaluateHypotheses(scenarioEvidence);
  const summary = {
    runId,
    configuration: {
      apiUrl: API_URL,
      bidCount: BID_COUNT,
      concurrency: CONCURRENCY,
      pollIntervalMs: POLL_INTERVAL_MS,
      settleMs: SETTLE_MS,
    },
    verdicts,
    scenarios: scenarios.map(({ rows: ignoredRows, ...scenario }) => scenario),
  };
  const csvPath = resolve(datasetDirectory, `${runId}-events.csv`);
  const summaryPath = resolve(datasetDirectory, `${runId}-summary.json`);
  const reportPath = resolve(datasetDirectory, `${runId}-hypothesis-report.md`);
  await Promise.all([
    writeFile(csvPath, `${toCsv(rows)}\n`, 'utf8'),
    writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    writeFile(reportPath, toMarkdownReport(runId, verdicts, scenarioEvidence), 'utf8'),
  ]);
  process.stdout.write('\nHypothesis verdicts:\n');
  verdicts.forEach((verdict) => {
    process.stdout.write(`${verdict.passed ? 'PASS' : 'FAIL'} ${verdict.id}: ${verdict.title}\n`);
  });
  process.stdout.write(`\nSaved:\n${csvPath}\n${summaryPath}\n${reportPath}\n`);
  if (verdicts.some((verdict) => !verdict.passed)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
