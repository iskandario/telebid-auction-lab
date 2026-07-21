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

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('TELEGRAM_BOT_TOKEN'));
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
    return this.call<TelegramMessageResult>('sendMessage', payload);
  }

  async getMenuButtonUrl(): Promise<string | null> {
    const button = await this.call<{ type: string; web_app?: { url?: string } }>('getChatMenuButton');
    return button.web_app?.url ?? null;
  }
}
