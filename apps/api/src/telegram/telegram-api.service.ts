import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TelegramApiResponse,
  TelegramBotProfile,
  TelegramMessageResult,
} from './telegram.types';

@Injectable()
export class TelegramApiService {
  private profile: TelegramBotProfile | null = null;
  private simulatedMessageId = 0;
  private readonly simulatedAttempts = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('TELEGRAM_BOT_TOKEN'));
  }

  isDeliveryConfigured(): boolean {
    return this.deliveryMode() === 'simulated' || this.isConfigured();
  }

  async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new ServiceUnavailableException('TELEGRAM_BOT_TOKEN не настроен');

    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new Error(body.description ?? `Telegram API ${method}: HTTP ${response.status}`);
    }
    return body.result;
  }

  async getProfile(): Promise<TelegramBotProfile> {
    if (this.profile) return this.profile;
    const profile = await this.call<{
      id: number;
      username: string;
      first_name: string;
    }>('getMe');
    this.profile = {
      id: profile.id,
      username: profile.username,
      firstName: profile.first_name,
    };
    return this.profile;
  }

  sendMessage(payload: Record<string, unknown>): Promise<TelegramMessageResult> {
    if (this.deliveryMode() === 'simulated') return this.simulateSendMessage(payload);
    return this.call<TelegramMessageResult>('sendMessage', payload);
  }

  async getMenuButtonUrl(): Promise<string | null> {
    const button = await this.call<{ type: string; web_app?: { url?: string } }>('getChatMenuButton');
    return button.web_app?.url ?? null;
  }

  private deliveryMode(): 'disabled' | 'live' | 'simulated' {
    const configured = this.config.get<string>('TELEGRAM_DELIVERY_MODE');
    if (configured === 'simulated') return 'simulated';
    if (configured === 'disabled') return 'disabled';
    return this.isConfigured() ? 'live' : 'disabled';
  }

  private async simulateSendMessage(
    payload: Record<string, unknown>,
  ): Promise<TelegramMessageResult> {
    const latencyMs = Math.max(
      0,
      Number(this.config.get<string>('TELEGRAM_SIMULATED_LATENCY_MS') ?? 25),
    );
    if (latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    const key = JSON.stringify([payload.chat_id, payload.text]);
    const attempt = (this.simulatedAttempts.get(key) ?? 0) + 1;
    this.simulatedAttempts.set(key, attempt);
    const failFirstAttempt =
      this.config.get<string>('TELEGRAM_SIMULATED_FAIL_FIRST_ATTEMPT') === 'true';
    if (failFirstAttempt && attempt === 1) {
      throw new Error('Simulated Telegram Bot API transient failure');
    }

    this.simulatedMessageId += 1;
    return {
      message_id: this.simulatedMessageId,
      chat: {
        id: Number(payload.chat_id),
        type: 'private',
      },
    };
  }
}
