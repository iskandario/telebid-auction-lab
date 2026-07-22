import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const runtimeDirectory = '.telebid';
const pinggyPidPath = `${runtimeDirectory}/pinggy.pid`;
const pinggyLogPath = `${runtimeDirectory}/pinggy.log`;
const pinggyKeyPath = `${runtimeDirectory}/pinggy-key`;
const pinggyKnownHostsPath = `${runtimeDirectory}/known_hosts`;

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

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForPublic(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(`${url}/health`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

function stopManagedPinggy() {
  if (!existsSync(pinggyPidPath)) return;
  const pid = Number(readFileSync(pinggyPidPath, 'utf8'));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
  unlinkSync(pinggyPidPath);
}

async function startPinggy() {
  mkdirSync(runtimeDirectory, { recursive: true });
  stopManagedPinggy();
  if (!existsSync(pinggyKeyPath)) {
    const key = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', pinggyKeyPath], {
      stdio: 'inherit',
    });
    if (key.status !== 0) throw new Error('Не удалось создать временный SSH-ключ для HTTPS-туннеля');
  }

  const log = openSync(pinggyLogPath, 'w');
  const tunnel = spawn(
    'ssh',
    [
      '-p',
      '443',
      '-i',
      pinggyKeyPath,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${pinggyKnownHostsPath}`,
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ExitOnForwardFailure=yes',
      '-R0:localhost:4173',
      'a.pinggy.io',
    ],
    { detached: true, stdio: ['ignore', log, log] },
  );
  closeSync(log);
  writeFileSync(pinggyPidPath, `${tunnel.pid}\n`, 'utf8');
  tunnel.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const output = existsSync(pinggyLogPath) ? readFileSync(pinggyLogPath, 'utf8') : '';
    const urls = [...output.matchAll(/https:\/\/[a-z0-9-]+(?:\.run\.pinggy-free\.link|\.free\.pinggy\.net)/gi)];
    const url = urls[0]?.[0];
    if (url && (await waitForPublic(url, 15_000))) return url;
    try {
      process.kill(tunnel.pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  stopManagedPinggy();
  throw new Error(`Резервный HTTPS-туннель не запустился. Лог: ${pinggyLogPath}`);
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
mkdirSync(runtimeDirectory, { recursive: true });
stopManagedPinggy();
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
let tunnelProvider = configuredUrl ? 'configured' : 'cloudflare';
if (!publicUrl) {
  const tunnelDeadline = Date.now() + 60_000;
  while (!publicUrl && Date.now() < tunnelDeadline) {
    const logs = docker(['compose', '--profile', 'telegram', 'logs', '--no-color', 'cloudflared'], { capture: true, allowFailure: true });
    publicUrl = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? '';
    if (!publicUrl) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (publicUrl && !(await waitForPublic(publicUrl, 15_000))) publicUrl = '';
if (!publicUrl) {
  process.stdout.write('Cloudflare недоступен из этой сети, переключаюсь на резервный HTTPS-туннель…\n');
  docker(['compose', '--profile', 'telegram', 'stop', 'cloudflared'], { allowFailure: true });
  publicUrl = await startPinggy();
  tunnelProvider = 'pinggy';
}

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
process.stdout.write(`Туннель: ${tunnelProvider}\n`);
process.stdout.write(`Локально: http://localhost:4173\n`);
process.stdout.write(`Логи: npm run telegram:logs\n`);
process.stdout.write(`Остановить: npm run telegram:down\n`);

try {
  execFileSync('open', [`https://t.me/${bot.username}`], { stdio: 'ignore' });
} catch {}
