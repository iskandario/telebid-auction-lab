import { ConfigService } from '@nestjs/config';
import { TelegramApiService } from './telegram-api.service';

describe('TelegramApiService simulated delivery', () => {
  it('fails the first attempt and delivers the retry', async () => {
    const values: Record<string, string> = {
      TELEGRAM_DELIVERY_MODE: 'simulated',
      TELEGRAM_SIMULATED_LATENCY_MS: '0',
      TELEGRAM_SIMULATED_FAIL_FIRST_ATTEMPT: 'true',
    };
    const config = {
      get: (key: string) => values[key],
    } as ConfigService;
    const service = new TelegramApiService(config);
    const payload = { chat_id: 506911, text: 'Ваша ставка перебита' };

    await expect(service.sendMessage(payload)).rejects.toThrow('transient failure');
    await expect(service.sendMessage(payload)).resolves.toMatchObject({
      message_id: 1,
      chat: { id: 506911, type: 'private' },
    });
  });
});
