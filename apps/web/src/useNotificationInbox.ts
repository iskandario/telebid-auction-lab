import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, listNotifications } from './api';
import type { NotificationView } from './domain';
import { telegramSocketAuth } from './telegram';

type InboxStatus = 'connecting' | 'live' | 'offline';

export function useNotificationInbox(recipientId: string | null) {
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [status, setStatus] = useState<InboxStatus>('connecting');
  const cursorRef = useRef('0');

  const merge = useCallback((items: NotificationView[]) => {
    if (!items.length) return;
    cursorRef.current = String(
      Math.max(Number(cursorRef.current), ...items.map((item) => Number(item.sequence))),
    );
    setNotifications((current) => {
      const byId = new Map(current.map((item) => [item.notificationId, item]));
      items.forEach((item) => byId.set(item.notificationId, item));
      return [...byId.values()]
        .sort((left, right) => Number(right.sequence) - Number(left.sequence))
        .slice(0, 200);
    });
  }, []);

  useEffect(() => {
    cursorRef.current = '0';
    setNotifications([]);
    if (!recipientId) {
      setStatus('offline');
      return;
    }

    let disposed = false;
    let socket: Socket | null = null;
    const refresh = async () => {
      try {
        const items = await listNotifications(recipientId, '0');
        if (!disposed) merge(items);
      } catch {
        if (!disposed) setStatus('offline');
      }
    };

    void refresh();
    socket = io(`${API_URL}/sync`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 250,
      reconnectionDelayMax: 2_000,
      auth: telegramSocketAuth(),
    });
    socket.on('connect', () => {
      setStatus('connecting');
      socket?.emit('subscribe:notifications', {
        recipientId,
        afterSequence: cursorRef.current,
      });
    });
    socket.on(
      'notifications:sync',
      ({ notifications: items }: { notifications: NotificationView[] }) => {
        merge(items);
        setStatus('live');
      },
    );
    socket.on('notification:event', (notification: NotificationView) => merge([notification]));
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));

    const refreshTimer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      socket?.disconnect();
    };
  }, [merge, recipientId]);

  return { notifications, status };
}
