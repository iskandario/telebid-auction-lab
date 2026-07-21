import { UnauthorizedException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TelegramIdentity } from './telegram.types';

interface InitDataUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

@Injectable()
export class TelegramAuthService {
  constructor(private readonly config: ConfigService) {}

  resolve(
    authorization?: string,
    demoUserId?: string,
    demoDisplayName?: string,
  ): TelegramIdentity {
    const initData = authorization?.startsWith('tma ') ? authorization.slice(4) : '';
    if (initData) return this.validate(initData);

    const allowDemo = this.config.get<string>('ALLOW_DEMO_AUTH') !== 'false';
    if (!allowDemo || !demoUserId) {
      throw new UnauthorizedException('Откройте приложение через Telegram');
    }

    let displayName = demoDisplayName?.trim() || demoUserId;
    try {
      displayName = decodeURIComponent(displayName);
    } catch {}
    return {
      id: demoUserId,
      firstName: displayName,
      displayName,
      source: 'demo',
    };
  }

  validate(initData: string): TelegramIdentity {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) throw new UnauthorizedException('TELEGRAM_BOT_TOKEN не настроен');

    const parameters = new URLSearchParams(initData);
    const receivedHash = parameters.get('hash');
    if (!receivedHash) throw new UnauthorizedException('Telegram hash отсутствует');
    parameters.delete('hash');

    const dataCheckString = [...parameters.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
    const received = Buffer.from(receivedHash, 'hex');
    const calculated = Buffer.from(calculatedHash, 'hex');
    if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) {
      throw new UnauthorizedException('Подпись Telegram недействительна');
    }

    const authDate = Number(parameters.get('auth_date'));
    const maxAgeSeconds = Number(this.config.get<string>('TELEGRAM_AUTH_MAX_AGE_SECONDS') ?? 86400);
    if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) {
      throw new UnauthorizedException('Сессия Telegram устарела');
    }

    const rawUser = parameters.get('user');
    if (!rawUser) throw new UnauthorizedException('Telegram user отсутствует');
    let user: InitDataUser;
    try {
      user = JSON.parse(rawUser) as InitDataUser;
    } catch {
      throw new UnauthorizedException('Telegram user повреждён');
    }

    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return {
      id: String(user.id),
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      photoUrl: user.photo_url,
      displayName,
      source: 'telegram',
    };
  }
}
