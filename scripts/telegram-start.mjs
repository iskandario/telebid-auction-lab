import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  process.stderr.write('Создан файл .env. Вставьте TELEGRAM_BOT_TOKEN из BotFather и повторите npm run telegram.\n');
  process.exit(1);
}

process.loadEnvFile?.('.env');
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token || token.includes('replace_with') || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  process.stderr.write('Укажите настоящий TELEGRAM_BOT_TOKEN в файле .env.\n');
  process.exit(1);
}
process.env.ALLOW_DEMO_AUTH = 'false';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Сервис не запустился: ${url}`);
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.description ?? `Telegram API ${method}`);
  return body.result;
}

const configuredUrl = process.env.MINI_APP_URL?.trim();
if (configuredUrl && !configuredUrl.startsWith('https://')) {
  throw new Error('MINI_APP_URL должен начинаться с https://');
}
process.stdout.write(`Запускаю TeleBid, PostgreSQL и ${configuredUrl ? 'приложение' : 'HTTPS-туннель'}…\n`);
docker(['compose', '--profile', 'telegram', 'rm', '-sf', 'cloudflared'], { allowFailure: true });
docker([
  'compose',
  ...(configuredUrl ? [] : ['--profile', 'telegram']),
  'up',
  '--build',
  '-d',
  'postgres',
  'api',
  'web',
  ...(configuredUrl ? [] : ['cloudflared']),
]);
await waitFor('http://localhost:8080/health', 60_000);

let publicUrl = configuredUrl ?? '';
if (!publicUrl) {
  const tunnelDeadline = Date.now() + 60_000;
  while (!publicUrl && Date.now() < tunnelDeadline) {
    const logs = docker(['compose', '--profile', 'telegram', 'logs', '--no-color', 'cloudflared'], { capture: true, allowFailure: true });
    publicUrl = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? '';
    if (!publicUrl) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (!publicUrl) throw new Error('Cloudflare Tunnel не выдал публичный HTTPS URL');

const bot = await telegram('getMe');
await telegram('setChatMenuButton', {
  menu_button: {
    type: 'web_app',
    text: 'Открыть TeleBid',
    web_app: { url: publicUrl },
  },
});
await telegram('setMyCommands', {
  commands: [
    { command: 'start', description: 'Открыть TeleBid' },
    { command: 'app', description: 'Открыть аукционы' },
    { command: 'help', description: 'Как работает сервис' },
  ],
});
await telegram('setMyShortDescription', {
  short_description: 'Аукционы рекламных слотов и тендеры брендов в Telegram',
}).catch(() => undefined);

process.stdout.write(`\nTeleBid готов.\n`);
process.stdout.write(`Бот: https://t.me/${bot.username}\n`);
process.stdout.write(`Mini App: ${publicUrl}\n`);
process.stdout.write(`Локально: http://localhost:4173\n`);
process.stdout.write(`Логи: npm run telegram:logs\n`);
process.stdout.write(`Остановить: npm run telegram:down\n`);

try {
  execFileSync('open', [`https://t.me/${bot.username}`], { stdio: 'ignore' });
} catch {}
