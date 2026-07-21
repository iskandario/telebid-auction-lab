import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, getAuction, listNotifications, syncAuction } from './api';
import {
  applyAuctionEvent,
  type AuctionEventEnvelope,
  type AuctionSnapshot,
  type ClientMetrics,
  type NotificationView,
  type RecoveryStrategy,
  type SyncResponse,
  type Transport,
} from './domain';
import { telegramSocketAuth } from './telegram';

const initialMetrics: ClientMetrics = {
  eventLatencyMs: null,
  notificationLatencyMs: null,
  recoveryTimeMs: null,
  gapCount: 0,
  duplicateCount: 0,
  duplicateNotificationCount: 0,
  causalOrderViolationCount: 0,
  lastRecoveryMode: '—',
};

export function useAuctionLab(
  auctionId: string | null,
  participantId: string,
  transport: Transport,
  strategy: RecoveryStrategy,
) {
  const [auction, setAuction] = useState<AuctionSnapshot | null>(null);
  const [events, setEvents] = useState<AuctionEventEnvelope[]>([]);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [metrics, setMetrics] = useState<ClientMetrics>(initialMetrics);
  const [status, setStatus] = useState<'connecting' | 'live' | 'recovering' | 'offline'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);

  const versionRef = useRef(0);
  const notificationCursorRef = useRef('0');
  const appliedEventIds = useRef(new Set<string>());
  const notificationIds = useRef(new Set<string>());
  const pendingNotifications = useRef<NotificationView[]>([]);
  const syncingRef = useRef(false);
  const recoveryRunningRef = useRef(false);
  const reconnectStartedRef = useRef<number | null>(null);
  const recoverRef = useRef<() => Promise<void>>(async () => undefined);

  const displayNotification = useCallback((notification: NotificationView) => {
    setNotifications((current) => [notification, ...current].slice(0, 40));
    setMetrics((current) => ({
      ...current,
      notificationLatencyMs: Math.max(0, Date.now() - Date.parse(notification.createdAt)),
    }));
  }, []);

  const publishNotification = useCallback((notification: NotificationView) => {
    if (notificationIds.current.has(notification.notificationId)) {
      setMetrics((current) => ({
        ...current,
        duplicateNotificationCount: current.duplicateNotificationCount + 1,
      }));
      return;
    }

    notificationIds.current.add(notification.notificationId);
    notificationCursorRef.current = String(
      Math.max(Number(notificationCursorRef.current), Number(notification.sequence)),
    );

    if (notification.aggregateVersion > versionRef.current) {
      pendingNotifications.current.push(notification);
      if (!syncingRef.current) {
        setMetrics((current) => ({
          ...current,
          causalOrderViolationCount: current.causalOrderViolationCount + 1,
        }));
      }
      return;
    }

    displayNotification(notification);
  }, [displayNotification]);

  const flushNotifications = useCallback(() => {
    const ready = pendingNotifications.current.filter(
      (notification) => notification.aggregateVersion <= versionRef.current,
    );
    pendingNotifications.current = pendingNotifications.current.filter(
      (notification) => notification.aggregateVersion > versionRef.current,
    );
    ready
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .forEach(displayNotification);
  }, [displayNotification]);

  const applyEvent = useCallback(
    (event: AuctionEventEnvelope) => {
      if (appliedEventIds.current.has(event.eventId) || event.aggregateVersion <= versionRef.current) {
        setMetrics((current) => ({ ...current, duplicateCount: current.duplicateCount + 1 }));
        return;
      }
      if (versionRef.current > 0 && event.aggregateVersion !== versionRef.current + 1) {
        setMetrics((current) => ({ ...current, gapCount: current.gapCount + 1 }));
        void recoverRef.current();
        return;
      }

      versionRef.current = event.aggregateVersion;
      appliedEventIds.current.add(event.eventId);
      setAuction((current) => applyAuctionEvent(current, event));
      setEvents((current) => [event, ...current].slice(0, 40));
      setMetrics((current) => ({
        ...current,
        eventLatencyMs: Math.max(0, Date.now() - Date.parse(event.serverTimestamp)),
      }));
      flushNotifications();
    },
    [flushNotifications],
  );

  const applySync = useCallback(
    (response: SyncResponse) => {
      syncingRef.current = true;
      if (response.mode === 'snapshot') {
        versionRef.current = response.snapshot.version;
        setAuction(response.snapshot);
      } else {
        [...response.events]
          .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
          .forEach(applyEvent);
      }
      setMetrics((current) => ({
        ...current,
        lastRecoveryMode: `${response.mode}: ${response.reason}`,
      }));
      flushNotifications();
    },
    [applyEvent, flushNotifications],
  );

  const recover = useCallback(async () => {
    if (!auctionId || recoveryRunningRef.current) return;
    recoveryRunningRef.current = true;
    syncingRef.current = true;
    setStatus('recovering');
    try {
      const response = await syncAuction(auctionId, versionRef.current, strategy);
      applySync(response);
      if (reconnectStartedRef.current !== null) {
        const reconnectStarted = reconnectStartedRef.current;
        setMetrics((current) => ({
          ...current,
          recoveryTimeMs: Date.now() - reconnectStarted,
        }));
        reconnectStartedRef.current = null;
      }
      setStatus('live');
      setError(null);
    } catch (cause) {
      setStatus('offline');
      setError(cause instanceof Error ? cause.message : 'Ошибка восстановления');
    } finally {
      syncingRef.current = false;
      recoveryRunningRef.current = false;
    }
  }, [applySync, auctionId, strategy]);
  recoverRef.current = recover;

  const pullNotifications = useCallback(async () => {
    if (!participantId) return;
    const items = await listNotifications(participantId, notificationCursorRef.current);
    items.forEach(publishNotification);
  }, [participantId, publishNotification]);

  useEffect(() => {
    versionRef.current = 0;
    notificationCursorRef.current = '0';
    appliedEventIds.current.clear();
    notificationIds.current.clear();
    pendingNotifications.current = [];
    setAuction(null);
    setEvents([]);
    setNotifications([]);
    setMetrics(initialMetrics);
  }, [auctionId, participantId]);

  useEffect(() => {
    if (!auctionId || suspended) {
      if (suspended) setStatus('offline');
      return;
    }

    let disposed = false;
    const cleanups: Array<() => void> = [];
    setStatus('connecting');

    const start = async () => {
      try {
        if (versionRef.current === 0) {
          const initial = await getAuction(auctionId);
          if (disposed) return;
          versionRef.current = initial.version;
          setAuction(initial);
        } else {
          await recover();
        }
        await pullNotifications();
        if (disposed) return;

        if (transport === 'polling') {
          setStatus('live');
          const auctionTimer = window.setInterval(() => void recover(), 1000);
          const notificationTimer = window.setInterval(() => void pullNotifications(), 1000);
          cleanups.push(() => window.clearInterval(auctionTimer));
          cleanups.push(() => window.clearInterval(notificationTimer));
          return;
        }

        if (transport === 'sse') {
          const eventSource = new EventSource(
            `${API_URL}/auctions/${auctionId}/events?sinceVersion=${versionRef.current}`,
          );
          const auctionHandler = (message: Event) => applyEvent(JSON.parse((message as MessageEvent).data));
          ['AUCTION_CREATED', 'BID_ACCEPTED', 'AUCTION_EXTENDED', 'AUCTION_CLOSED'].forEach((type) =>
            eventSource.addEventListener(type, auctionHandler),
          );
          eventSource.onopen = () => setStatus('live');
          eventSource.onerror = () => setStatus('recovering');
          const notificationTimer = window.setInterval(() => void pullNotifications(), 1000);
          cleanups.push(() => eventSource.close());
          cleanups.push(() => window.clearInterval(notificationTimer));
          return;
        }

        const socket: Socket = io(`${API_URL}/sync`, {
          transports: ['websocket'],
          reconnection: true,
          auth: telegramSocketAuth(),
        });
        const bufferedEvents: AuctionEventEnvelope[] = [];
        socket.on('connect', () => {
          syncingRef.current = true;
          setStatus('recovering');
          socket.emit('subscribe:auction', {
            auctionId,
            lastAppliedVersion: versionRef.current,
            strategy,
            requestId: crypto.randomUUID(),
          });
          socket.emit('subscribe:notifications', {
            recipientId: participantId,
            afterSequence: notificationCursorRef.current,
          });
        });
        socket.on('sync:begin', () => {
          syncingRef.current = true;
        });
        socket.on('sync:payload', ({ payload }: { payload: SyncResponse }) => applySync(payload));
        socket.on('sync:complete', () => {
          bufferedEvents
            .splice(0)
            .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
            .forEach(applyEvent);
          syncingRef.current = false;
          if (reconnectStartedRef.current !== null) {
            const reconnectStarted = reconnectStartedRef.current;
            setMetrics((current) => ({
              ...current,
              recoveryTimeMs: Date.now() - reconnectStarted,
            }));
            reconnectStartedRef.current = null;
          }
          setStatus('live');
        });
        socket.on('auction:event', (event: AuctionEventEnvelope) => {
          if (syncingRef.current) bufferedEvents.push(event);
          else applyEvent(event);
        });
        socket.on('notifications:sync', ({ notifications: items }: { notifications: NotificationView[] }) =>
          items.forEach(publishNotification),
        );
        socket.on('notification:event', publishNotification);
        socket.on('auth:error', ({ message }: { message: string }) => setError(message));
        socket.on('disconnect', () => setStatus('recovering'));
        cleanups.push(() => socket.disconnect());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось подключиться');
        setStatus('offline');
      }
    };

    void start();
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [
    applyEvent,
    applySync,
    auctionId,
    participantId,
    publishNotification,
    pullNotifications,
    recover,
    strategy,
    suspended,
    transport,
  ]);

  const disconnectFor = useCallback((durationMs: number) => {
    reconnectStartedRef.current = Date.now();
    setSuspended(true);
    window.setTimeout(() => setSuspended(false), durationMs);
  }, []);

  return {
    auction,
    events,
    notifications,
    metrics,
    status,
    error,
    suspended,
    disconnectFor,
    refresh: recover,
  };
}
