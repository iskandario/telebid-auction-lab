import type {
  AuctionEventEnvelope,
  AuctionSnapshot,
  RecoveryStrategy,
  SyncResponse,
} from '../common/domain.types';

export function selectRecovery(
  strategy: RecoveryStrategy,
  snapshot: AuctionSnapshot,
  events: AuctionEventEnvelope[],
  sinceVersion: number,
): SyncResponse {
  const serverVersion = snapshot.version;
  const continuous =
    sinceVersion === serverVersion ||
    (events.length > 0 &&
      events[0]?.aggregateVersion === sinceVersion + 1 &&
      events.at(-1)?.aggregateVersion === serverVersion);

  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const eventsBytes = Buffer.byteLength(JSON.stringify(events));

  if (strategy === 'snapshot') {
    return {
      mode: 'snapshot',
      strategy,
      reason: 'forced-snapshot',
      serverVersion,
      estimatedBytes: snapshotBytes,
      snapshot,
    };
  }

  if (!continuous) {
    return {
      mode: 'snapshot',
      strategy,
      reason: 'journal-gap-fallback',
      serverVersion,
      estimatedBytes: snapshotBytes,
      snapshot,
    };
  }

  if (strategy === 'replay' || eventsBytes <= snapshotBytes) {
    return {
      mode: 'events',
      strategy,
      reason: strategy === 'replay' ? 'forced-replay' : 'hybrid-events-smaller',
      serverVersion,
      estimatedBytes: eventsBytes,
      events,
    };
  }

  return {
    mode: 'snapshot',
    strategy,
    reason: 'hybrid-snapshot-smaller',
    serverVersion,
    estimatedBytes: snapshotBytes,
    snapshot,
  };
}
