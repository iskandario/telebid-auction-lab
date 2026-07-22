import { createHash } from 'node:crypto';
import { EventSource } from 'eventsource';
import { io, type Socket } from 'socket.io-client';
import { percentile } from './statistics.js';
import type {
  AuctionEvent,
  AuctionKind,
  AuctionSnapshot,
  ClientSummary,
  CommandRow,
  EventRow,
  NotificationEvidence,
  NotificationRow,
  NotificationView,
  RecoveryEvidence,
  SyncResponse,
  Transport,
  TransportSummary,
  TrialConfig,
  TrialResult,
} from './research.types.js';
import { ToxiproxyController } from './toxiproxy.js';

interface CommandResult {
  auction: AuctionSnapshot;
  events: AuctionEvent[];
  idempotentReplay: boolean;
}

interface JsonResponse<T> {
  data: T;
  bytes: number;
  status: number;
}

interface ExperimentEnvironment {
  controlApiUrl: string;
  observerApiUrl: string;
}

interface CommandPlan {
  commandId: string;
  participantId: string;
  amount: number;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
  }
}

class ExperimentApi {
  constructor(private readonly environment: ExperimentEnvironment) {}

  createAuction(config: TrialConfig, ownerId: string): Promise<AuctionSnapshot> {
    const startingPrice = config.auctionKind === 'DIRECT' ? 10_000 : 100_000 + config.bidCount * 1_000;
    return this.request<AuctionSnapshot>(this.environment.controlApiUrl, '/auctions', {
      method: 'POST',
      headers: this.identityHeaders(ownerId),
      body: JSON.stringify({
        kind: config.auctionKind,
        title: `[research ${config.trialId}] ${config.auctionKind === 'DIRECT' ? 'Рекламный слот' : 'Рекламная кампания'}`,
        description: 'Изолированный прогон экспериментального стенда TeleBid',
        startingPrice,
        minStep: 500,
        durationSeconds: 120,
        antiSnipingWindowSec: 0,
        extensionSec: 0,
      }),
    }).then((response) => response.data);
  }

  placeBid(auctionId: string, command: CommandPlan): Promise<JsonResponse<CommandResult>> {
    return this.request<CommandResult>(this.environment.controlApiUrl, `/auctions/${auctionId}/bids`, {
      method: 'POST',
      headers: this.identityHeaders(command.participantId),
      body: JSON.stringify({ amount: command.amount, commandId: command.commandId }),
    });
  }

  closeAuction(auctionId: string, ownerId: string): Promise<AuctionSnapshot> {
    return this.request<AuctionSnapshot>(
      this.environment.controlApiUrl,
      `/auctions/${auctionId}/close?force=true`,
      { method: 'POST', headers: this.identityHeaders(ownerId) },
    ).then((response) => response.data);
  }

  getAuction(auctionId: string): Promise<AuctionSnapshot> {
    return this.request<AuctionSnapshot>(this.environment.controlApiUrl, `/auctions/${auctionId}`).then(
      (response) => response.data,
    );
  }

  syncControl(
    auctionId: string,
    sinceVersion: number,
    strategy: 'snapshot' | 'replay' | 'hybrid',
  ): Promise<JsonResponse<SyncResponse>> {
    return this.request<SyncResponse>(
      this.environment.controlApiUrl,
      `/auctions/${auctionId}/sync?sinceVersion=${sinceVersion}&strategy=${strategy}`,
    );
  }

  syncObserved(
    auctionId: string,
    sinceVersion: number,
    strategy: 'snapshot' | 'replay' | 'hybrid',
  ): Promise<JsonResponse<SyncResponse>> {
    return this.request<SyncResponse>(
      this.environment.observerApiUrl,
      `/auctions/${auctionId}/sync?sinceVersion=${sinceVersion}&strategy=${strategy}`,
    );
  }

  listNotifications(recipientId: string, afterSequence: string): Promise<NotificationView[]> {
    return this.request<NotificationView[]>(
      this.environment.controlApiUrl,
      `/notifications/${encodeURIComponent(recipientId)}?afterSequence=${afterSequence}`,
      { headers: this.identityHeaders(recipientId) },
    ).then((response) => response.data);
  }

  observerUrl(path: string): string {
    return `${this.environment.observerApiUrl}${path}`;
  }

  private identityHeaders(identity: string): Record<string, string> {
    return {
      'x-demo-user': identity,
      'x-demo-name': identity,
    };
  }

  private async request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<JsonResponse<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    const body = await response.text();
    if (!response.ok) throw new HttpRequestError(response.status, body);
    return {
      data: (body ? JSON.parse(body) : undefined) as T,
      bytes: Buffer.byteLength(body),
      status: response.status,
    };
  }
}

class EventCollector {
  readonly rows: EventRow[] = [];
  readonly eventIds = new Set<string>();
  lastVersion: number;
  duplicateDeliveries = 0;
  observedVersionGaps = 0;
  payloadBytes = 0;
  requests = 0;
  failedRequests = 0;
  reconnects = 0;
  private connections = 0;
  private recoveryStartedAt: number | null = null;
  private recoveryTargetVersion: number | null = null;
  private recoveredAt: number | null = null;

  constructor(
    readonly transport: Transport,
    readonly clientId: string,
    private readonly config: TrialConfig,
    initialVersion: number,
  ) {
    this.lastVersion = initialVersion;
  }

  accept(event: AuctionEvent, payloadBytes = Buffer.byteLength(JSON.stringify(event))): void {
    const duplicate = this.eventIds.has(event.eventId) || event.aggregateVersion <= this.lastVersion;
    const gap = !duplicate && event.aggregateVersion > this.lastVersion + 1;
    if (duplicate) this.duplicateDeliveries += 1;
    if (gap) this.observedVersionGaps += 1;
    this.payloadBytes += payloadBytes;
    if (!duplicate) {
      this.eventIds.add(event.eventId);
      this.lastVersion = event.aggregateVersion;
    }

    const receivedAt = new Date();
    this.rows.push({
      runId: this.config.runId,
      trialId: this.config.trialId,
      scenario: this.config.name,
      repetition: this.config.repetition,
      auctionKind: this.config.auctionKind,
      clientId: this.clientId,
      transport: this.transport,
      eventId: event.eventId,
      eventType: event.type,
      aggregateVersion: event.aggregateVersion,
      serverTimestamp: event.serverTimestamp,
      receivedAt: receivedAt.toISOString(),
      latencyMs: Math.max(0, receivedAt.getTime() - Date.parse(event.serverTimestamp)),
      payloadBytes,
      duplicateDelivery: duplicate ? 1 : 0,
      observedVersionGap: gap ? 1 : 0,
    });
    this.checkRecovery(receivedAt.getTime());
  }

  applySnapshot(snapshot: AuctionSnapshot, payloadBytes: number): void {
    this.payloadBytes += payloadBytes;
    this.lastVersion = Math.max(this.lastVersion, snapshot.version);
    this.checkRecovery(Date.now());
  }

  addPayloadBytes(bytes: number): void {
    this.payloadBytes += bytes;
  }

  recordRequest(): void {
    this.requests += 1;
  }

  recordFailure(): void {
    this.failedRequests += 1;
  }

  recordConnection(): void {
    this.connections += 1;
    if (this.connections > 1) this.reconnects += 1;
  }

  beginRecovery(targetVersion: number, startedAt: number): void {
    this.recoveryTargetVersion = targetVersion;
    this.recoveryStartedAt = startedAt;
    this.recoveredAt = null;
    this.checkRecovery(Date.now());
  }

  hasConverged(targetVersion: number): boolean {
    return this.lastVersion >= targetVersion;
  }

  summary(authoritativeEvents: AuctionEvent[], finalVersion: number): ClientSummary {
    const expectedIds = new Set(authoritativeEvents.map((event) => event.eventId));
    const missing = [...expectedIds].filter((eventId) => !this.eventIds.has(eventId)).length;
    const latencies = this.rows.filter((row) => !row.duplicateDelivery).map((row) => row.latencyMs);
    return {
      clientId: this.clientId,
      transport: this.transport,
      received: this.eventIds.size,
      missing,
      duplicateDeliveries: this.duplicateDeliveries,
      observedVersionGaps: this.observedVersionGaps,
      payloadBytes: this.payloadBytes,
      requests: this.requests,
      failedRequests: this.failedRequests,
      reconnects: this.reconnects,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
      finalVersion: this.lastVersion,
      converged: this.lastVersion === finalVersion,
      recoveryMs:
        this.recoveryStartedAt !== null && this.recoveredAt !== null
          ? Math.max(0, this.recoveredAt - this.recoveryStartedAt)
          : null,
    };
  }

  private checkRecovery(now: number): void {
    if (
      this.recoveryStartedAt !== null &&
      this.recoveryTargetVersion !== null &&
      this.recoveredAt === null &&
      this.lastVersion >= this.recoveryTargetVersion
    ) {
      this.recoveredAt = now;
    }
  }
}

class MiniAppNotificationCollector {
  readonly rows: NotificationRow[] = [];
  private readonly notificationIds = new Set<string>();
  private readonly pendingRows: NotificationRow[] = [];
  private stateVersion: number;
  private notificationCursor = '0';
  private syncing = true;
  duplicateDeliveries = 0;
  causalOrderViolations = 0;

  constructor(
    readonly recipientId: string,
    private readonly config: TrialConfig,
    initialVersion: number,
  ) {
    this.stateVersion = initialVersion;
  }

  beginSync(): void {
    this.syncing = true;
  }

  completeSync(): void {
    this.syncing = false;
    this.flush();
  }

  applyStateVersion(version: number): void {
    this.stateVersion = Math.max(this.stateVersion, version);
    this.flush();
  }

  accept(notification: NotificationView, source: 'live' | 'replay'): void {
    const duplicate = this.notificationIds.has(notification.notificationId);
    if (duplicate) this.duplicateDeliveries += 1;
    const causalViolation =
      !duplicate && !this.syncing && notification.aggregateVersion > this.stateVersion;
    if (causalViolation) this.causalOrderViolations += 1;
    this.notificationCursor = String(
      Math.max(Number(this.notificationCursor), Number(notification.sequence)),
    );

    const receivedAt = new Date();
    const row: NotificationRow = {
      runId: this.config.runId,
      trialId: this.config.trialId,
      scenario: this.config.name,
      repetition: this.config.repetition,
      auctionKind: this.config.auctionKind,
      recipientId: this.recipientId,
      notificationId: notification.notificationId,
      sequence: notification.sequence,
      kind: notification.kind,
      aggregateVersion: notification.aggregateVersion,
      source,
      createdAt: notification.createdAt,
      receivedAt: receivedAt.toISOString(),
      latencyMs: Math.max(0, receivedAt.getTime() - Date.parse(notification.createdAt)),
      stateVersionAtReceipt: this.stateVersion,
      displayedAt: null,
      displayLatencyMs: null,
      duplicateDelivery: duplicate ? 1 : 0,
      causalOrderViolation: causalViolation ? 1 : 0,
    };
    this.rows.push(row);
    if (duplicate) return;

    this.notificationIds.add(notification.notificationId);
    if (notification.aggregateVersion <= this.stateVersion) this.display(row);
    else this.pendingRows.push(row);
  }

  cursor(): string {
    return this.notificationCursor;
  }

  version(): number {
    return this.stateVersion;
  }

  hasReceived(expected: NotificationView[]): boolean {
    return expected.every((notification) => this.notificationIds.has(notification.notificationId));
  }

  summary(expected: NotificationView[]): Pick<
    NotificationEvidence,
    | 'miniAppRecipientId'
    | 'miniAppExpected'
    | 'miniAppReceived'
    | 'miniAppMissing'
    | 'miniAppLive'
    | 'miniAppReplayed'
    | 'miniAppDuplicates'
    | 'miniAppCausalViolations'
    | 'p95MiniAppLatencyMs'
    | 'p95MiniAppDisplayLatencyMs'
  > {
    const expectedIds = new Set(expected.map((notification) => notification.notificationId));
    const uniqueRows = this.rows.filter((row) => !row.duplicateDelivery);
    const receivedExpected = uniqueRows.filter((row) => expectedIds.has(row.notificationId));
    return {
      miniAppRecipientId: this.recipientId,
      miniAppExpected: expected.length,
      miniAppReceived: receivedExpected.length,
      miniAppMissing: expected.filter(
        (notification) => !this.notificationIds.has(notification.notificationId),
      ).length,
      miniAppLive: receivedExpected.filter((row) => row.source === 'live').length,
      miniAppReplayed: receivedExpected.filter((row) => row.source === 'replay').length,
      miniAppDuplicates: this.duplicateDeliveries,
      miniAppCausalViolations: this.causalOrderViolations,
      p95MiniAppLatencyMs: percentile(
        receivedExpected.map((row) => row.latencyMs),
        0.95,
      ),
      p95MiniAppDisplayLatencyMs: percentile(
        receivedExpected
          .map((row) => row.displayLatencyMs)
          .filter((value): value is number => value !== null),
        0.95,
      ),
    };
  }

  private flush(): void {
    const ready = this.pendingRows.filter((row) => row.aggregateVersion <= this.stateVersion);
    ready.forEach((row) => this.display(row));
    for (let index = this.pendingRows.length - 1; index >= 0; index -= 1) {
      if (this.pendingRows[index]!.aggregateVersion <= this.stateVersion) {
        this.pendingRows.splice(index, 1);
      }
    }
  }

  private display(row: NotificationRow): void {
    if (row.displayedAt) return;
    const displayedAt = new Date();
    row.displayedAt = displayedAt.toISOString();
    row.displayLatencyMs = Math.max(0, displayedAt.getTime() - Date.parse(row.createdAt));
  }
}

interface Observer {
  collector: EventCollector;
  stop(): Promise<void>;
}

interface MiniAppNotificationObserver {
  collector: MiniAppNotificationCollector;
  stop(): Promise<void>;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function createPollingObserver(
  api: ExperimentApi,
  auction: AuctionSnapshot,
  config: TrialConfig,
  clientId: string,
): Promise<Observer> {
  const collector = new EventCollector('polling', clientId, config, auction.version);
  let running = true;
  let requestRunning = false;

  const poll = async (): Promise<void> => {
    if (!running || requestRunning) return;
    requestRunning = true;
    collector.recordRequest();
    try {
      const response = await api.syncObserved(
        auction.id,
        collector.lastVersion,
        config.recoveryStrategy,
      );
      collector.addPayloadBytes(response.bytes);
      if (response.data.mode === 'events') {
        response.data.events.forEach((event) => collector.accept(event, 0));
      } else {
        collector.applySnapshot(response.data.snapshot, 0);
      }
    } catch {
      collector.recordFailure();
    } finally {
      requestRunning = false;
    }
  };

  await poll();
  const timer = setInterval(() => void poll(), config.pollIntervalMs);
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

async function createSseObserver(
  api: ExperimentApi,
  auction: AuctionSnapshot,
  config: TrialConfig,
  clientId: string,
): Promise<Observer> {
  const collector = new EventCollector('sse', clientId, config, auction.version);
  const source = new EventSource(
    api.observerUrl(`/auctions/${auction.id}/events?sinceVersion=${auction.version}`),
  );
  const types = ['AUCTION_CREATED', 'BID_ACCEPTED', 'AUCTION_EXTENDED', 'AUCTION_CLOSED'];
  types.forEach((type) => {
    source.addEventListener(type, (message) => {
      const data = String((message as MessageEvent).data);
      collector.accept(JSON.parse(data) as AuctionEvent, Buffer.byteLength(data));
    });
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    let opened = false;
    const timeout = setTimeout(() => rejectOpen(new Error(`SSE timeout: ${clientId}`)), 15_000);
    source.onopen = () => {
      collector.recordConnection();
      collector.recordRequest();
      if (!opened) {
        opened = true;
        clearTimeout(timeout);
        resolveOpen();
      }
    };
    source.onerror = () => {
      collector.recordFailure();
    };
  });

  return {
    collector,
    async stop() {
      source.close();
    },
  };
}

async function createWebSocketObserver(
  api: ExperimentApi,
  auction: AuctionSnapshot,
  config: TrialConfig,
  clientId: string,
): Promise<Observer> {
  const collector = new EventCollector('websocket', clientId, config, auction.version);
  const socket: Socket = io(api.observerUrl('/sync'), {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 500,
    timeout: 10_000,
  });
  let syncing = true;
  let firstSyncCompleted = false;
  let buffered: AuctionEvent[] = [];

  socket.on('connect', () => {
    collector.recordConnection();
    collector.recordRequest();
    syncing = true;
    buffered = [];
    socket.emit('subscribe:auction', {
      auctionId: auction.id,
      lastAppliedVersion: collector.lastVersion,
      strategy: config.recoveryStrategy,
      requestId: crypto.randomUUID(),
    });
  });
  socket.on('auction:event', (event: AuctionEvent) => {
    if (syncing) buffered.push(event);
    else collector.accept(event);
  });
  socket.on('sync:payload', ({ payload }: { payload: SyncResponse }) => {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    collector.addPayloadBytes(bytes);
    if (payload.mode === 'events') payload.events.forEach((event) => collector.accept(event, 0));
    else collector.applySnapshot(payload.snapshot, 0);
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`WebSocket timeout: ${clientId}`)), 15_000);
    socket.on('sync:complete', () => {
      buffered
        .splice(0)
        .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
        .forEach((event) => collector.accept(event));
      syncing = false;
      if (!firstSyncCompleted) {
        firstSyncCompleted = true;
        clearTimeout(timeout);
        resolveReady();
      }
    });
    socket.on('connect_error', () => {
      collector.recordFailure();
    });
  });

  return {
    collector,
    async stop() {
      socket.disconnect();
    },
  };
}

async function createMiniAppNotificationObserver(
  api: ExperimentApi,
  auction: AuctionSnapshot,
  config: TrialConfig,
  recipientId: string,
): Promise<MiniAppNotificationObserver> {
  const collector = new MiniAppNotificationCollector(recipientId, config, auction.version);
  const socket: Socket = io(api.observerUrl('/sync'), {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 500,
    timeout: 10_000,
    auth: {
      demoUserId: recipientId,
      demoDisplayName: `Research Mini App ${recipientId}`,
    },
  });
  let bufferedEvents: AuctionEvent[] = [];
  let syncing = true;
  let firstAuctionSync = false;
  let firstNotificationSync = false;

  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error('Mini App notification observer timeout')),
      15_000,
    );
    const resolveIfReady = () => {
      if (!firstAuctionSync || !firstNotificationSync) return;
      clearTimeout(timeout);
      resolveReady();
    };

    socket.on('connect', () => {
      collector.beginSync();
      syncing = true;
      bufferedEvents = [];
      socket.emit('subscribe:auction', {
        auctionId: auction.id,
        lastAppliedVersion: collector.version(),
        strategy: config.recoveryStrategy,
        requestId: crypto.randomUUID(),
      });
      socket.emit('subscribe:notifications', {
        recipientId,
        afterSequence: collector.cursor(),
      });
    });
    socket.on('auction:event', (event: AuctionEvent) => {
      if (syncing) bufferedEvents.push(event);
      else collector.applyStateVersion(event.aggregateVersion);
    });
    socket.on('sync:payload', ({ payload }: { payload: SyncResponse }) => {
      if (payload.mode === 'snapshot') collector.applyStateVersion(payload.snapshot.version);
      else payload.events.forEach((event) => collector.applyStateVersion(event.aggregateVersion));
    });
    socket.on('sync:complete', () => {
      bufferedEvents
        .splice(0)
        .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
        .forEach((event) => collector.applyStateVersion(event.aggregateVersion));
      syncing = false;
      collector.completeSync();
      firstAuctionSync = true;
      resolveIfReady();
    });
    socket.on(
      'notifications:sync',
      ({ notifications }: { notifications: NotificationView[] }) => {
        notifications.forEach((notification) => collector.accept(notification, 'replay'));
        firstNotificationSync = true;
        resolveIfReady();
      },
    );
    socket.on('notification:event', (notification: NotificationView) => {
      collector.accept(notification, 'live');
    });
    socket.on('auth:error', ({ message }: { message: string }) => {
      clearTimeout(timeout);
      rejectReady(new Error(message));
    });
    socket.on('connect_error', (error) => {
      if (!firstAuctionSync || !firstNotificationSync) {
        clearTimeout(timeout);
        rejectReady(error);
      }
    });
  });

  return {
    collector,
    async stop() {
      socket.disconnect();
    },
  };
}

async function createObservers(
  api: ExperimentApi,
  auction: AuctionSnapshot,
  config: TrialConfig,
): Promise<Observer[]> {
  const factories = {
    polling: createPollingObserver,
    sse: createSseObserver,
    websocket: createWebSocketObserver,
  } as const;
  const tasks: Array<Promise<Observer>> = [];
  (Object.keys(factories) as Transport[]).forEach((transport) => {
    for (let index = 1; index <= config.clientsPerTransport; index += 1) {
      const clientId = `${transport}-${String(index).padStart(2, '0')}`;
      tasks.push(factories[transport](api, auction, config, clientId));
    }
  });
  return Promise.all(tasks);
}

function createCommandPlans(auction: AuctionSnapshot, config: TrialConfig): CommandPlan[] {
  const participantBase = 800_000_000 + (config.seed % 100_000) * 100;
  return Array.from({ length: config.bidCount }, (_, index) => ({
    commandId: deterministicUuid(`${config.seed}:command:${index + 1}`),
    participantId: String(participantBase + index + 1),
    amount:
      auction.kind === 'DIRECT'
        ? auction.currentPrice + (index + 1) * auction.minStep
        : auction.currentPrice - (index + 1) * auction.minStep,
  }));
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function executeCommand(
  api: ExperimentApi,
  auctionId: string,
  config: TrialConfig,
  command: CommandPlan,
  attempt: number,
): Promise<CommandRow> {
  const startedAt = new Date();
  try {
    const response = await api.placeBid(auctionId, command);
    const completedAt = new Date();
    return {
      runId: config.runId,
      trialId: config.trialId,
      scenario: config.name,
      repetition: config.repetition,
      auctionKind: config.auctionKind,
      commandId: command.commandId,
      attempt,
      participantId: command.participantId,
      amount: command.amount,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      httpStatus: response.status,
      accepted: 1,
      idempotentReplay: response.data.idempotentReplay ? 1 : 0,
      responseVersion: response.data.auction.version,
      errorCode: '',
    };
  } catch (error) {
    const completedAt = new Date();
    const requestError = error instanceof HttpRequestError ? error : null;
    return {
      runId: config.runId,
      trialId: config.trialId,
      scenario: config.name,
      repetition: config.repetition,
      auctionKind: config.auctionKind,
      commandId: command.commandId,
      attempt,
      participantId: command.participantId,
      amount: command.amount,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      httpStatus: requestError?.status ?? 0,
      accepted: 0,
      idempotentReplay: 0,
      responseVersion: null,
      errorCode: requestError?.body ?? (error instanceof Error ? error.message : String(error)),
    };
  }
}

async function executeSegment(
  api: ExperimentApi,
  auctionId: string,
  config: TrialConfig,
  commands: CommandPlan[],
): Promise<CommandRow[]> {
  const rows: CommandRow[] = [];
  for (let offset = 0; offset < commands.length; offset += config.concurrency) {
    rows.push(
      ...(await Promise.all(
        commands
          .slice(offset, offset + config.concurrency)
          .map((command) => executeCommand(api, auctionId, config, command, 1)),
      )),
    );
    if (config.commandIntervalMs > 0) await wait(config.commandIntervalMs);
  }
  return rows;
}

async function executeDuplicates(
  api: ExperimentApi,
  auctionId: string,
  config: TrialConfig,
  commands: CommandPlan[],
  originalRows: CommandRow[],
): Promise<CommandRow[]> {
  const acceptedIds = new Set(
    originalRows.filter((row) => row.accepted && !row.idempotentReplay).map((row) => row.commandId),
  );
  const acceptedCommands = commands.filter((command) => acceptedIds.has(command.commandId));
  const count = Math.min(acceptedCommands.length, Math.ceil(acceptedCommands.length * config.duplicateRate));
  return Promise.all(
    acceptedCommands
      .slice(Math.max(0, acceptedCommands.length - count))
      .map((command) => executeCommand(api, auctionId, config, command, 2)),
  );
}

async function waitForConvergence(
  collectors: EventCollector[],
  targetVersion: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collectors.every((collector) => collector.hasConverged(targetVersion))) return;
    await wait(25);
  }
}

function aggregateTransport(
  transport: Transport,
  clients: ClientSummary[],
  eventRows: EventRow[],
): TransportSummary {
  const selected = clients.filter((client) => client.transport === transport);
  const latencies = eventRows
    .filter((row) => row.transport === transport && !row.duplicateDelivery)
    .map((row) => row.latencyMs);
  const recovery = selected.map((client) => client.recoveryMs).filter((value): value is number => value !== null);
  const payloadBytes = selected.reduce((sum, client) => sum + client.payloadBytes, 0);
  return {
    transport,
    clientCount: selected.length,
    convergedClients: selected.filter((client) => client.converged).length,
    staleClients: selected.filter((client) => !client.converged).length,
    missingEvents: selected.reduce((sum, client) => sum + client.missing, 0),
    duplicateDeliveries: selected.reduce((sum, client) => sum + client.duplicateDeliveries, 0),
    clientsWithObservedGaps: selected.filter((client) => client.observedVersionGaps > 0).length,
    payloadBytes,
    payloadBytesPerClient: selected.length ? Math.round(payloadBytes / selected.length) : 0,
    requests: selected.reduce((sum, client) => sum + client.requests, 0),
    failedRequests: selected.reduce((sum, client) => sum + client.failedRequests, 0),
    reconnects: selected.reduce((sum, client) => sum + client.reconnects, 0),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
    p95RecoveryMs: percentile(recovery, 0.95),
  };
}

async function auditNotifications(
  api: ExperimentApi,
  auctionId: string,
  recipientIds: string[],
  authoritativeEvents: AuctionEvent[],
  miniAppCollector: MiniAppNotificationCollector,
  timeoutMs: number,
): Promise<NotificationEvidence> {
  const eventVersions = new Set(authoritativeEvents.map((event) => event.aggregateVersion));
  const uniqueRecipientIds = [...new Set(recipientIds)];
  let recipientResults: Array<{
    recipientId: string;
    initial: NotificationView[];
    afterCursor: NotificationView[];
  }> = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    recipientResults = await Promise.all(
      uniqueRecipientIds.map(async (recipientId) => {
        const initial = await api.listNotifications(recipientId, '0');
        const cursor = initial.reduce(
          (maximum, notification) => Math.max(maximum, Number(notification.sequence)),
          0,
        );
        const afterCursor = await api.listNotifications(recipientId, String(cursor));
        return { recipientId, initial, afterCursor };
      }),
    );
    const trialNotifications = recipientResults
      .flatMap((result) => result.initial)
      .filter((notification) => notification.auctionId === auctionId);
    const ownerNotifications = trialNotifications.filter(
      (notification) => notification.recipientId === miniAppCollector.recipientId,
    );
    const terminalDelivery = trialNotifications.every((notification) =>
      ['DELIVERED', 'SKIPPED'].includes(notification.telegramStatus),
    );
    if (
      trialNotifications.length > 0 &&
      terminalDelivery &&
      miniAppCollector.hasReceived(ownerNotifications)
    ) {
      break;
    }
    await wait(25);
  }

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
  const telegramDeliveryLatencies: number[] = [];
  notifications.forEach((notification) => {
    if (unique.has(notification.notificationId)) duplicates += 1;
    unique.add(notification.notificationId);
    if (!eventVersions.has(notification.aggregateVersion)) orphaned += 1;
    const event = authoritativeEvents.find((candidate) => candidate.eventId === notification.eventId);
    if (event) {
      latencies.push(
        Math.max(0, Date.parse(notification.createdAt) - Date.parse(event.serverTimestamp)),
      );
    }
    if (notification.telegramDeliveredAt) {
      telegramDeliveryLatencies.push(
        Math.max(0, Date.parse(notification.telegramDeliveredAt) - Date.parse(notification.createdAt)),
      );
    }
  });
  const ownerNotifications = notifications.filter(
    (notification) => notification.recipientId === miniAppCollector.recipientId,
  );
  return {
    total: notifications.length,
    duplicates,
    orphaned,
    afterCursorCount,
    p95LatencyMs: percentile(latencies, 0.95),
    telegramDelivered: notifications.filter(
      (notification) => notification.telegramStatus === 'DELIVERED',
    ).length,
    telegramPending: notifications.filter(
      (notification) => notification.telegramStatus === 'PENDING',
    ).length,
    telegramFailed: notifications.filter(
      (notification) => notification.telegramStatus === 'FAILED',
    ).length,
    telegramSkipped: notifications.filter(
      (notification) => notification.telegramStatus === 'SKIPPED',
    ).length,
    telegramRetried: notifications.filter((notification) => notification.telegramAttempts > 1)
      .length,
    p95TelegramDeliveryMs: percentile(telegramDeliveryLatencies, 0.95),
    ...miniAppCollector.summary(ownerNotifications),
  };
}

function responseVersion(response: SyncResponse): number {
  return response.mode === 'snapshot'
    ? response.snapshot.version
    : (response.events.at(-1)?.aggregateVersion ?? response.serverVersion);
}

async function auditRecovery(
  api: ExperimentApi,
  auctionId: string,
  initialVersion: number,
  finalVersion: number,
): Promise<RecoveryEvidence> {
  const distance = finalVersion - initialVersion;
  const sinceVersion = Math.max(initialVersion, finalVersion - Math.max(1, Math.ceil(distance / 2)));
  const [snapshotResponse, replayResponse, hybridResponse] = await Promise.all([
    api.syncControl(auctionId, sinceVersion, 'snapshot'),
    api.syncControl(auctionId, sinceVersion, 'replay'),
    api.syncControl(auctionId, sinceVersion, 'hybrid'),
  ]);
  const snapshot = snapshotResponse.data;
  const replay = replayResponse.data;
  const hybrid = hybridResponse.data;
  const replayEvents = replay.mode === 'events' ? replay.events : [];
  const replayContinuous =
    replay.mode === 'events' &&
    replayEvents.every((event, index) => event.aggregateVersion === sinceVersion + index + 1) &&
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

function isEventSequenceContinuous(events: AuctionEvent[], initialVersion: number): boolean {
  return events.every((event, index) => event.aggregateVersion === initialVersion + index + 1);
}

function countDuplicateCommandEffects(events: AuctionEvent[]): number {
  const effects = new Map<string, number>();
  events
    .filter((event) => event.type === 'BID_ACCEPTED')
    .forEach((event) => effects.set(event.correlationId, (effects.get(event.correlationId) ?? 0) + 1));
  return [...effects.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

export async function runTransportTrial(
  config: TrialConfig,
  environment: ExperimentEnvironment,
  toxiproxy: ToxiproxyController,
): Promise<TrialResult> {
  const startedAt = Date.now();
  const api = new ExperimentApi(environment);
  const ownerId = String(700_000_000 + (config.seed % 100_000));
  await toxiproxy.configure(config.networkLatencyMs, config.networkJitterMs);
  const auction = await api.createAuction(config, ownerId);
  const commands = createCommandPlans(auction, config);
  const expected = commands.at(-1)!;
  const observers = await createObservers(api, auction, config);
  const collectors = observers.map((observer) => observer.collector);
  let miniAppObserver: MiniAppNotificationObserver | null = null;
  let originalRows: CommandRow[] = [];
  let duplicateRows: CommandRow[] = [];

  try {
    miniAppObserver = await createMiniAppNotificationObserver(
      api,
      auction,
      config,
      ownerId,
    );

    if (config.disconnectAfterFraction === null || config.disconnectDurationMs <= 0) {
      originalRows = await executeSegment(api, auction.id, config, commands);
      duplicateRows = await executeDuplicates(api, auction.id, config, commands, originalRows);
      await api.closeAuction(auction.id, ownerId);
    } else {
      const splitIndex = Math.max(
        1,
        Math.min(commands.length - 1, Math.round(commands.length * config.disconnectAfterFraction)),
      );
      originalRows.push(...(await executeSegment(api, auction.id, config, commands.slice(0, splitIndex))));
      await toxiproxy.setEnabled(false);
      const disconnectedAt = Date.now();
      originalRows.push(...(await executeSegment(api, auction.id, config, commands.slice(splitIndex))));
      duplicateRows = await executeDuplicates(api, auction.id, config, commands, originalRows);
      const finalWhileDisconnected = await api.closeAuction(auction.id, ownerId);
      const remainingDowntime = Math.max(
        0,
        config.disconnectDurationMs - (Date.now() - disconnectedAt),
      );
      if (remainingDowntime) await wait(remainingDowntime);
      const restoredAt = Date.now();
      collectors.forEach((collector) => collector.beginRecovery(finalWhileDisconnected.version, restoredAt));
      await toxiproxy.setEnabled(true);
      await waitForConvergence(
        collectors,
        finalWhileDisconnected.version,
        config.convergenceTimeoutMs,
      );
    }

    const commandRows = [...originalRows, ...duplicateRows];
    const finalAuction = await api.getAuction(auction.id);
    await waitForConvergence(collectors, finalAuction.version, config.convergenceTimeoutMs);
    await Promise.all(observers.map((observer) => observer.stop()));

    const authoritativeResponse = await api.syncControl(auction.id, auction.version, 'replay');
    if (authoritativeResponse.data.mode !== 'events') {
      throw new Error('Authoritative replay unexpectedly returned a snapshot');
    }
    const authoritativeEvents = authoritativeResponse.data.events;
    const clientSummaries = collectors.map((collector) =>
      collector.summary(authoritativeEvents, finalAuction.version),
    );
    const eventRows = collectors.flatMap((collector) => collector.rows);
    const transports = (['polling', 'sse', 'websocket'] as const).map((transport) =>
      aggregateTransport(transport, clientSummaries, eventRows),
    );
    const acceptedOriginals = commandRows.filter(
      (row) => row.attempt === 1 && row.accepted && !row.idempotentReplay,
    );
    const rejectedOriginals = commandRows.filter((row) => row.attempt === 1 && !row.accepted);
    const notifications = await auditNotifications(
      api,
      auction.id,
      [ownerId, ...new Set(acceptedOriginals.map((row) => row.participantId))],
      authoritativeEvents,
      miniAppObserver.collector,
      config.convergenceTimeoutMs,
    );
    const recovery = await auditRecovery(api, auction.id, auction.version, finalAuction.version);
    await miniAppObserver.stop();

    return {
      config,
      auctionId: auction.id,
      durationMs: Date.now() - startedAt,
      acceptedCommands: acceptedOriginals.length,
      rejectedCommands: rejectedOriginals.length,
      duplicateAttempts: commandRows.filter((row) => row.attempt > 1).length,
      idempotentReplays: commandRows.filter((row) => row.idempotentReplay).length,
      duplicateCommandEffects: countDuplicateCommandEffects(authoritativeEvents),
      expectedWinnerId: expected.participantId,
      actualWinnerId: finalAuction.leaderId,
      expectedPrice: expected.amount,
      actualPrice: finalAuction.currentPrice,
      winnerCorrect:
        finalAuction.leaderId === expected.participantId && finalAuction.currentPrice === expected.amount,
      authoritativeEventCount: authoritativeEvents.length,
      eventSequenceContinuous: isEventSequenceContinuous(authoritativeEvents, auction.version),
      transports,
      clients: clientSummaries,
      notifications,
      recovery,
      eventRows,
      commandRows,
      notificationRows: miniAppObserver.collector.rows,
    };
  } finally {
    if (miniAppObserver) await Promise.allSettled([miniAppObserver.stop()]);
    await Promise.allSettled(observers.map((observer) => observer.stop()));
    await toxiproxy.reset();
  }
}
