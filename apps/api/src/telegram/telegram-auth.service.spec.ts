import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { TelegramAuthService } from './telegram-auth.service';

const token = '123456789:test_token';

function signedInitData(): string {
  const parameters = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'query',
    user: JSON.stringify({ id: 506911, first_name: 'Искандар', username: 'iskandario' }),
  });
  const dataCheckString = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  parameters.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return parameters.toString();
}

describe('TelegramAuthService', () => {
  const config = {
    get: (key: string) => ({ TELEGRAM_BOT_TOKEN: token, ALLOW_DEMO_AUTH: 'true' })[key],
  } as ConfigService;
  const service = new TelegramAuthService(config);

  it('validates signed Telegram Mini App data', () => {
    expect(service.validate(signedInitData())).toMatchObject({
      id: '506911',
      displayName: 'Искандар',
      username: 'iskandario',
      source: 'telegram',
    });
  });

  it('rejects tampered Telegram Mini App data', () => {
    const tampered = signedInitData().replace('506911', '506912');
    expect(() => service.validate(tampered)).toThrow('Подпись Telegram недействительна');
  });

  it('allows explicit demo identity in development mode', () => {
    expect(service.resolve(undefined, 'demo-owner', 'Channel owner')).toMatchObject({
      id: 'demo-owner',
      displayName: 'Channel owner',
      source: 'demo',
    });
  });
});
