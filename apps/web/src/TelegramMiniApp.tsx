import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  createAuction,
  getTelegramSession,
  listAuctions,
  listNotifications,
  placeBid,
  publishAuction,
  type TelegramSession,
} from './api';
import type { AuctionKind, AuctionSnapshot, NotificationView } from './domain';
import {
  demoIdentities,
  getDemoIdentity,
  initializeTelegram,
  isInsideTelegram,
  setDemoIdentity,
  telegramHaptic,
  telegramWebApp,
} from './telegram';
import { useAuctionLab } from './useAuctionLab';
import './telegram-mini-app.css';

type MainView = 'market' | 'mine' | 'notifications';

interface CreateFormState {
  kind: AuctionKind;
  title: string;
  description: string;
  category: string;
  placementFormat: string;
  placementAt: string;
  channelUsername: string;
  channelSubscribers: string;
  startingPrice: string;
  minStep: string;
  durationMinutes: string;
}

const categories = ['Технологии', 'Финансы', 'Образование', 'Lifestyle', 'Игры', 'Бизнес'];

const initialCreateForm: CreateFormState = {
  kind: 'DIRECT',
  title: '',
  description: '',
  category: 'Технологии',
  placementFormat: 'Нативный пост на 24 часа',
  placementAt: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 16),
  channelUsername: '',
  channelSubscribers: '25000',
  startingPrice: '15000',
  minStep: '1000',
  durationMinutes: '60',
};

function formatMoney(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} ₽`;
}

function compactNumber(value: number | null): string {
  if (!value) return '—';
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatPlacement(value: string | null): string {
  if (!value) return 'Дата по договорённости';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function useCountdown(endsAt: string): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Date.parse(endsAt) - now);
  if (!remaining) return 'завершён';
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return hours ? `${hours} ч ${minutes} мин` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function Avatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  if (photoUrl) return <img className="tg-avatar" src={photoUrl} alt="" />;
  return <span className="tg-avatar tg-avatar--fallback">{name.slice(0, 1).toUpperCase()}</span>;
}

function AuctionCard({ auction, onOpen }: { auction: AuctionSnapshot; onOpen: () => void }) {
  const remaining = useCountdown(auction.endsAt);
  const direct = auction.kind === 'DIRECT';
  return (
    <button className="tg-auction-card" type="button" onClick={onOpen}>
      <div className="tg-card-head">
        <div className={`tg-channel-mark ${direct ? '' : 'tg-channel-mark--brief'}`}>
          {direct ? 'TG' : 'AD'}
        </div>
        <div className="tg-card-owner">
          <strong>{auction.channelTitle || auction.ownerDisplayName}</strong>
          <span>{direct ? `${compactNumber(auction.channelSubscribers)} подписчиков` : 'Заявка рекламодателя'}</span>
        </div>
        <span className={`tg-kind ${direct ? '' : 'tg-kind--reverse'}`}>{direct ? 'СЛОТ' : 'ТЕНДЕР'}</span>
      </div>
      <h3>{auction.title}</h3>
      <p>{auction.description}</p>
      <div className="tg-tags">
        <span>{auction.category}</span>
        <span>{auction.placementFormat}</span>
      </div>
      <div className="tg-card-bottom">
        <div>
          <small>{direct ? 'Текущая ставка' : 'Лучшая цена'}</small>
          <strong>{formatMoney(auction.currentPrice)}</strong>
        </div>
        <div className="tg-card-time">
          <small>до конца</small>
          <strong>{remaining}</strong>
        </div>
      </div>
    </button>
  );
}

function EmptyState({ view }: { view: MainView }) {
  return (
    <div className="tg-empty">
      <span>{view === 'notifications' ? '🔔' : '📭'}</span>
      <h3>{view === 'notifications' ? 'Пока тихо' : 'Здесь пока нет торгов'}</h3>
      <p>{view === 'notifications' ? 'События ставок и результаты появятся здесь и в чате с ботом.' : 'Создайте первый рекламный слот или тендер.'}</p>
    </div>
  );
}

export function TelegramMiniApp() {
  const [session, setSession] = useState<TelegramSession | null>(null);
  const [auctions, setAuctions] = useState<AuctionSnapshot[]>([]);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [view, setView] = useState<MainView>('market');
  const [marketKind, setMarketKind] = useState<AuctionKind>('DIRECT');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(initialCreateForm);
  const [bidAmount, setBidAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const participantId = session?.user.id ?? getDemoIdentity().id;
  const live = useAuctionLab(selectedId, participantId, 'websocket', 'hybrid');
  const selectedFromList = auctions.find((auction) => auction.id === selectedId) ?? null;
  const selected = live.auction ?? selectedFromList;

  const reload = useCallback(async () => {
    const [nextSession, nextAuctions] = await Promise.all([getTelegramSession(), listAuctions()]);
    setSession(nextSession);
    setAuctions(nextAuctions);
    const requestedId = new URLSearchParams(window.location.search).get('auctionId');
    if (requestedId && nextAuctions.some((auction) => auction.id === requestedId)) setSelectedId(requestedId);
  }, []);

  useEffect(() => {
    initializeTelegram();
    reload().catch((cause: Error) => setError(cause.message));
  }, [reload]);

  useEffect(() => {
    if (!session) return;
    listNotifications(session.user.id, '0')
      .then((items) => setNotifications(items.slice().reverse()))
      .catch(() => undefined);
  }, [session, live.notifications.length]);

  useEffect(() => {
    if (!selected) return;
    const suggested = selected.kind === 'DIRECT'
      ? selected.currentPrice + selected.minStep
      : Math.max(selected.minStep, selected.currentPrice - selected.minStep);
    setBidAmount(String(suggested));
  }, [selected?.id, selected?.currentPrice, selected?.kind, selected?.minStep]);

  const visibleAuctions = useMemo(() => {
    if (view === 'mine') {
      return auctions.filter((auction) => auction.ownerId === participantId || auction.leaderId === participantId);
    }
    return auctions.filter((auction) => auction.kind === marketKind);
  }, [auctions, marketKind, participantId, view]);

  const submitBid = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await placeBid(selected.id, participantId, Number(bidAmount));
      await live.refresh();
      setAuctions(await listAuctions());
      telegramHaptic('success');
      setNotice(selected.kind === 'DIRECT' ? 'Ставка принята. Сейчас вы лидируете.' : 'Предложение принято. Сейчас ваша цена лучшая.');
      window.setTimeout(() => setNotice(null), 2600);
    } catch (cause) {
      telegramHaptic('error');
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить ставку');
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createAuction({
        kind: createForm.kind,
        title: createForm.title,
        description: createForm.description,
        category: createForm.category,
        placementFormat: createForm.placementFormat,
        placementAt: new Date(createForm.placementAt).toISOString(),
        channelUsername: createForm.kind === 'DIRECT' ? createForm.channelUsername : undefined,
        channelTitle: createForm.kind === 'DIRECT' ? createForm.channelUsername.replace(/^@/, '') : undefined,
        channelSubscribers: Number(createForm.channelSubscribers),
        startingPrice: Number(createForm.startingPrice),
        minStep: Number(createForm.minStep),
        durationSeconds: Number(createForm.durationMinutes) * 60,
        antiSnipingWindowSec: 15,
        extensionSec: 30,
      });
      setAuctions((current) => [created, ...current]);
      setCreateOpen(false);
      setCreateForm({ ...initialCreateForm, kind: createForm.kind });
      setSelectedId(created.id);
      telegramHaptic('success');
    } catch (cause) {
      telegramHaptic('error');
      setError(cause instanceof Error ? cause.message : 'Не удалось создать торги');
    } finally {
      setBusy(false);
    }
  };

  const publishSelected = async () => {
    if (!selected?.channelUsername) {
      setError('Сначала укажите публичный @username канала');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await publishAuction(selected.id, selected.channelUsername);
      setAuctions((current) => current.map((auction) => auction.id === updated.id ? updated : auction));
      telegramHaptic('success');
      setNotice('Карточка аукциона опубликована в канале.');
      window.setTimeout(() => setNotice(null), 2600);
    } catch (cause) {
      telegramHaptic('error');
      setError(cause instanceof Error ? cause.message : 'Не удалось опубликовать лот');
    } finally {
      setBusy(false);
    }
  };

  const switchDemoUser = (id: string) => {
    const identity = demoIdentities.find((item) => item.id === id);
    if (!identity) return;
    setDemoIdentity(identity);
    window.location.reload();
  };

  const openBot = () => {
    if (!session?.botUsername) return;
    const url = `https://t.me/${session.botUsername}`;
    const telegram = telegramWebApp();
    if (telegram?.openTelegramLink) telegram.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="tg-app">
      <header className="tg-header">
        <div className="tg-brand"><span>TB</span><div><strong>TeleBid</strong><small>реклама через торги</small></div></div>
        <div className="tg-account">
          <div><strong>{session?.user.displayName ?? 'Подключение…'}</strong><span>{session?.user.source === 'telegram' ? 'Telegram ID подтверждён' : 'Demo mode'}</span></div>
          <Avatar name={session?.user.displayName ?? 'T'} photoUrl={session?.user.photoUrl} />
        </div>
      </header>

      {!isInsideTelegram() && (
        <div className="tg-demo-bar">
          <span>Просмотр от лица</span>
          <select value={getDemoIdentity().id} onChange={(event) => switchDemoUser(event.target.value)}>
            {demoIdentities.map((identity) => <option key={identity.id} value={identity.id}>{identity.name}</option>)}
          </select>
        </div>
      )}

      <main className="tg-main">
        {error && !selected && !createOpen && <div className="tg-error tg-error--global">{error}</div>}
        {view === 'market' && (
          <>
            <section className="tg-hero">
              <div><span className="tg-live-dot" /> LIVE MARKET</div>
              <h1>Реклама в Telegram<br />по честной цене</h1>
              <p>Каналы продают свободные размещения. Бренды публикуют тендеры. Цена формируется в торгах.</p>
              <div className="tg-hero-stats">
                <span><strong>{auctions.filter((item) => item.status === 'ACTIVE').length}</strong> активных торгов</span>
                <span><strong>{auctions.filter((item) => item.kind === 'DIRECT').length}</strong> рекламных слотов</span>
              </div>
            </section>

            <div className="tg-market-switch">
              <button className={marketKind === 'DIRECT' ? 'active' : ''} onClick={() => setMarketKind('DIRECT')}><span>Рекламные слоты</span><small>ставки растут</small></button>
              <button className={marketKind === 'REVERSE' ? 'active' : ''} onClick={() => setMarketKind('REVERSE')}><span>Тендеры брендов</span><small>цена снижается</small></button>
            </div>
          </>
        )}

        {view === 'mine' && <div className="tg-page-title"><span>МОИ ТОРГИ</span><h1>Созданные и активные</h1><p>Лоты, которыми вы управляете, и аукционы, где ваша ставка лидирует.</p></div>}
        {view === 'notifications' && <div className="tg-page-title"><span>ЦЕНТР СОБЫТИЙ</span><h1>Уведомления</h1><p>Эти события сохраняются на сервере и дублируются ботом, даже когда Mini App закрыт.</p></div>}

        {view !== 'notifications' && (
          <section className="tg-feed">
            <div className="tg-feed-heading"><strong>{view === 'mine' ? 'Ваши аукционы' : marketKind === 'DIRECT' ? 'Свободные размещения' : 'Открытые рекламные кампании'}</strong><span>{visibleAuctions.length}</span></div>
            {visibleAuctions.length ? visibleAuctions.map((auction) => <AuctionCard key={auction.id} auction={auction} onOpen={() => { telegramHaptic('light'); setSelectedId(auction.id); }} />) : <EmptyState view={view} />}
          </section>
        )}

        {view === 'notifications' && (
          <section className="tg-notification-feed">
            {notifications.length ? notifications.map((notification) => (
              <button key={notification.notificationId} onClick={() => setSelectedId(notification.auctionId)}>
                <span className={`tg-notification-icon tg-notification-icon--${notification.kind.toLowerCase()}`}>{notification.kind === 'AUCTION_WON' ? '★' : '↗'}</span>
                <div><strong>{notification.message}</strong><small>{notification.telegramStatus === 'DELIVERED' ? 'Доставлено в чат с ботом' : 'Сохранено в Mini App'} · {new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(notification.createdAt))}</small></div>
              </button>
            )) : <EmptyState view="notifications" />}
          </section>
        )}

        <a className="tg-research-card" href="/?mode=lab">
          <div><span>ARCHITECTURE LAB</span><strong>Почему победитель и уведомления не теряются?</strong><p>Открыть воспроизводимый эксперимент с конкурентными ставками, reconnect и повторными запросами.</p></div><b>→</b>
        </a>
      </main>

      <button className="tg-create-button" onClick={() => setCreateOpen(true)} aria-label="Создать торги">+</button>

      <nav className="tg-bottom-nav">
        <button className={view === 'market' ? 'active' : ''} onClick={() => setView('market')}><span>⌂</span><small>Рынок</small></button>
        <button className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')}><span>▣</span><small>Мои</small></button>
        <button className={view === 'notifications' ? 'active' : ''} onClick={() => setView('notifications')}><span>♢</span><small>События</small>{notifications.length > 0 && <i>{Math.min(9, notifications.length)}</i>}</button>
        <button onClick={openBot}><span>◉</span><small>Бот</small></button>
      </nav>

      {selected && (
        <div className="tg-overlay" onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <article className="tg-sheet">
            <div className="tg-sheet-handle" />
            <button className="tg-sheet-close" onClick={() => setSelectedId(null)}>×</button>
            <div className="tg-detail-owner"><div className="tg-channel-mark">{selected.kind === 'DIRECT' ? 'TG' : 'AD'}</div><div><strong>{selected.channelTitle || selected.ownerDisplayName}</strong><span>{selected.channelUsername || 'Telegram advertiser'}</span></div><i className={`tg-sync tg-sync--${live.status}`}>{live.status === 'live' ? 'live' : live.status}</i></div>
            <span className="tg-detail-kind">{selected.kind === 'DIRECT' ? 'РЕКЛАМНЫЙ СЛОТ · ПРЯМОЙ АУКЦИОН' : 'БРИФ БРЕНДА · ОБРАТНЫЙ АУКЦИОН'}</span>
            <h2>{selected.title}</h2>
            <p>{selected.description}</p>
            <div className="tg-detail-grid">
              <div><small>Формат</small><strong>{selected.placementFormat}</strong></div>
              <div><small>Размещение</small><strong>{formatPlacement(selected.placementAt)}</strong></div>
              <div><small>Аудитория</small><strong>{compactNumber(selected.channelSubscribers)}</strong></div>
              <div><small>Категория</small><strong>{selected.category}</strong></div>
            </div>
            <div className="tg-live-price"><div><small>{selected.kind === 'DIRECT' ? 'Текущая ставка' : 'Лучшая цена'}</small><strong>{formatMoney(selected.currentPrice)}</strong></div><div><small>Версия состояния</small><strong>v{selected.version}</strong></div></div>
            {selected.leaderId && <div className="tg-leader"><span>{selected.leaderId === participantId ? 'Вы сейчас лидируете' : 'В торгах уже есть лидер'}</span><small>При новой ставке предыдущий лидер получит уведомление от бота.</small></div>}

            {selected.ownerId !== participantId ? (
              <div className="tg-bid-box">
                <label>{selected.kind === 'DIRECT' ? 'Ваша ставка' : 'Ваша цена'}<div><input type="number" value={bidAmount} onChange={(event) => setBidAmount(event.target.value)} /><span>₽</span></div></label>
                <button disabled={busy || selected.status !== 'ACTIVE'} onClick={() => void submitBid()}>{busy ? 'Отправляем…' : selected.kind === 'DIRECT' ? 'Повысить ставку' : 'Предложить дешевле'}</button>
                <small>Шаг {formatMoney(selected.minStep)}. Одинаковый запрос не может изменить торги дважды.</small>
              </div>
            ) : (
              <div className="tg-owner-actions">
                <strong>Вы управляете этими торгами</strong>
                {selected.kind === 'DIRECT' && <button disabled={busy || Boolean(selected.publishedMessageId)} onClick={() => void publishSelected()}>{selected.publishedMessageId ? 'Опубликовано в канале ✓' : 'Опубликовать карточку в канале'}</button>}
                <small>Для публикации добавьте бота администратором канала с правом отправки сообщений.</small>
              </div>
            )}
            {(error || live.error) && <div className="tg-error">{error || live.error}</div>}
          </article>
        </div>
      )}

      {createOpen && (
        <div className="tg-overlay tg-overlay--create">
          <form className="tg-sheet tg-create-sheet" onSubmit={submitCreate}>
            <div className="tg-sheet-handle" />
            <button type="button" className="tg-sheet-close" onClick={() => setCreateOpen(false)}>×</button>
            <span className="tg-detail-kind">СОЗДАТЬ НОВЫЕ ТОРГИ</span>
            <h2>{createForm.kind === 'DIRECT' ? 'Продать рекламный слот' : 'Найти канал для кампании'}</h2>
            <div className="tg-create-kind">
              <button type="button" className={createForm.kind === 'DIRECT' ? 'active' : ''} onClick={() => setCreateForm((current) => ({ ...current, kind: 'DIRECT' }))}><strong>Слот канала</strong><small>побеждает максимальная ставка</small></button>
              <button type="button" className={createForm.kind === 'REVERSE' ? 'active' : ''} onClick={() => setCreateForm((current) => ({ ...current, kind: 'REVERSE' }))}><strong>Тендер бренда</strong><small>побеждает минимальная цена</small></button>
            </div>
            <label>Название<input required minLength={3} value={createForm.title} onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))} placeholder={createForm.kind === 'DIRECT' ? 'Нативный пост в TechFlow' : 'Запуск приложения: ищем канал'} /></label>
            <label>Описание<textarea required minLength={3} value={createForm.description} onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))} placeholder="Аудитория, требования к креативу и условия размещения" /></label>
            <div className="tg-form-row"><label>Категория<select value={createForm.category} onChange={(event) => setCreateForm((current) => ({ ...current, category: event.target.value }))}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>Формат<input value={createForm.placementFormat} onChange={(event) => setCreateForm((current) => ({ ...current, placementFormat: event.target.value }))} /></label></div>
            {createForm.kind === 'DIRECT' && <div className="tg-form-row"><label>Канал<input required value={createForm.channelUsername} onChange={(event) => setCreateForm((current) => ({ ...current, channelUsername: event.target.value }))} placeholder="@channel" /></label><label>Подписчики<input type="number" min="0" value={createForm.channelSubscribers} onChange={(event) => setCreateForm((current) => ({ ...current, channelSubscribers: event.target.value }))} /></label></div>}
            <label>Дата размещения<input type="datetime-local" required value={createForm.placementAt} onChange={(event) => setCreateForm((current) => ({ ...current, placementAt: event.target.value }))} /></label>
            <div className="tg-form-row"><label>{createForm.kind === 'DIRECT' ? 'Стартовая цена' : 'Максимальный бюджет'}<input type="number" min="1" required value={createForm.startingPrice} onChange={(event) => setCreateForm((current) => ({ ...current, startingPrice: event.target.value }))} /></label><label>Шаг торгов<input type="number" min="1" required value={createForm.minStep} onChange={(event) => setCreateForm((current) => ({ ...current, minStep: event.target.value }))} /></label></div>
            <label>Длительность, минут<input type="number" min="1" max="1440" required value={createForm.durationMinutes} onChange={(event) => setCreateForm((current) => ({ ...current, durationMinutes: event.target.value }))} /></label>
            <button className="tg-submit-create" disabled={busy}>{busy ? 'Создаём…' : 'Запустить торги'}</button>
            {error && <div className="tg-error">{error}</div>}
          </form>
        </div>
      )}

      {notice && <div className="tg-toast">✓ {notice}</div>}
    </div>
  );
}
