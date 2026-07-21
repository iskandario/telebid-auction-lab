import {
  BadRequestException,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuctionSnapshot } from '../common/domain.types';
import { TelegramApiService } from './telegram-api.service';

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { id: number; first_name: string };
    text?: string;
  };
}

interface ChatMember {
  status: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function normalizeChannel(value: string): string {
  const channel = value.trim();
  if (!channel) throw new BadRequestException('Укажите @username канала');
  return channel.startsWith('@') ? channel : `@${channel}`;
}

@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopped = false;
  private updateOffset = 0;

  constructor(
    private readonly api: TelegramApiService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.api.isConfigured()) {
      console.log('TeleBid bot: demo mode, TELEGRAM_BOT_TOKEN is empty');
      return;
    }
    try {
      const profile = await this.api.getProfile();
      await this.api.call<boolean>('deleteWebhook', { drop_pending_updates: false });
      await this.api.call<boolean>('setMyCommands', {
        commands: [
          { command: 'start', description: 'Открыть TeleBid' },
          { command: 'app', description: 'Открыть аукционы' },
          { command: 'help', description: 'Как работает сервис' },
        ],
      });
      const configuredUrl = this.config.get<string>('MINI_APP_URL');
      if (configuredUrl) {
        await this.api.call<boolean>('setChatMenuButton', {
          menu_button: {
            type: 'web_app',
            text: 'Открыть TeleBid',
            web_app: { url: configuredUrl },
          },
        });
      }
      console.log(`TeleBid bot: @${profile.username}`);
      void this.poll();
    } catch (error) {
      console.error(`TeleBid bot startup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  async getMiniAppUrl(): Promise<string | null> {
    return this.config.get<string>('MINI_APP_URL') || this.api.getMenuButtonUrl();
  }

  async publishAuction(
    auction: AuctionSnapshot,
    channelInput: string,
    ownerTelegramId: string,
  ): Promise<{
    chatId: string;
    messageId: string;
    channelUsername: string;
    channelTitle?: string;
  }> {
    if (!/^\d+$/.test(ownerTelegramId)) {
      throw new BadRequestException('Публикацию в канал нужно проверить из Telegram-аккаунта');
    }
    const channel = normalizeChannel(channelInput);
    const profile = await this.api.getProfile();
    const [owner, bot] = await Promise.all([
      this.api.call<ChatMember>('getChatMember', {
        chat_id: channel,
        user_id: Number(ownerTelegramId),
      }),
      this.api.call<ChatMember>('getChatMember', {
        chat_id: channel,
        user_id: profile.id,
      }),
    ]);
    if (!['creator', 'administrator'].includes(owner.status)) {
      throw new BadRequestException('Ваш Telegram-аккаунт должен быть администратором канала');
    }
    if (!['creator', 'administrator'].includes(bot.status)) {
      throw new BadRequestException(`Добавьте @${profile.username} администратором канала с правом публикации`);
    }

    const kind = auction.kind === 'DIRECT' ? 'Рекламный слот' : 'Тендер рекламодателя';
    const priceLabel = auction.kind === 'DIRECT' ? 'Стартовая ставка' : 'Максимальный бюджет';
    const deepLink = `https://t.me/${profile.username}?start=auction_${auction.id}`;
    const message = await this.api.sendMessage({
      chat_id: channel,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: [
        `<b>${kind}: ${escapeHtml(auction.title)}</b>`,
        '',
        escapeHtml(auction.description),
        '',
        `📌 ${escapeHtml(auction.placementFormat)}`,
        `🏷 ${escapeHtml(auction.category)}`,
        `💰 ${priceLabel}: <b>${Math.round(auction.startingPrice).toLocaleString('ru-RU')} ₽</b>`,
        '',
        'Ставки принимаются в TeleBid. Итог торгов определяется сервером автоматически.',
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[{ text: 'Участвовать в торгах', url: deepLink }]],
      },
    });

    return {
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      channelUsername: channel,
      channelTitle: message.chat.title,
    };
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>('getUpdates', {
          offset: this.updateOffset,
          timeout: 25,
          allowed_updates: ['message'],
        });
        for (const update of updates) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        console.error(`TeleBid polling: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text || message.chat.type !== 'private') return;
    const [command, parameter] = message.text.trim().split(/\s+/, 2);
    if (!['/start', '/app', '/help'].some((item) => command?.startsWith(item))) return;

    if (command?.startsWith('/help')) {
      await this.api.sendMessage({
        chat_id: message.chat.id,
        text: 'TeleBid помогает владельцам Telegram-каналов продавать рекламные слоты через аукцион, а рекламодателям проводить обратные тендеры. Бот сообщает о перебитой ставке, победе и завершении торгов.',
      });
      return;
    }

    const miniAppUrl = await this.getMiniAppUrl();
    if (!miniAppUrl) {
      await this.api.sendMessage({
        chat_id: message.chat.id,
        text: 'Mini App ещё не настроен. Запустите проект командой npm run telegram.',
      });
      return;
    }
    const auctionId = parameter?.startsWith('auction_') ? parameter.slice('auction_'.length) : null;
    const url = new URL(miniAppUrl);
    if (auctionId) url.searchParams.set('auctionId', auctionId);
    const firstName = message.from?.first_name ? `, ${message.from.first_name}` : '';
    await this.api.sendMessage({
      chat_id: message.chat.id,
      text: `Привет${firstName}! Здесь каналы продают рекламные слоты, а бренды находят размещения через прозрачные торги.`,
      reply_markup: {
        inline_keyboard: [[{ text: auctionId ? 'Открыть этот аукцион' : 'Открыть TeleBid', web_app: { url: url.toString() } }]],
      },
    });
  }
}
