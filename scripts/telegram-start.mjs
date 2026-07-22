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
const tunnelPidPath = `${runtimeDirectory}/tunnel.pid`;
const legacyPinggyPidPath = `${runtimeDirectory}/pinggy.pid`;
const tunnelLogPath = `${runtimeDirectory}/tunnel.log`;
const tunnelWatcherPidPath = `${runtimeDirectory}/tunnel-watch.pid`;
const tunnelWatcherLogPath = `${runtimeDirectory}/tunnel-watch.log`;

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

async function isTeleBidReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === 'ok' && body.service === 'telebid-api';
  } catch {
    return false;
  }
}

async function waitForPublic(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTeleBidReachable(new URL('health', `${url.replace(/\/+$/, '')}/`).toString())) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

function stopManagedProcess(pidPath) {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, 'utf8'));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }
  unlinkSync(pidPath);
}

function stopManagedTunnel() {
  stopManagedProcess(tunnelPidPath);
  stopManagedProcess(legacyPinggyPidPath);
}

function latestRunlocalUrl(output) {
  return [...output.matchAll(/https:\/\/[a-z0-9-]+\.runlocal\.eu/gi)].at(-1)?.[0] ?? '';
}

async function latestNgrokUrl() {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return '';
    const body = await response.json();
    return body.tunnels?.find((tunnel) => tunnel.proto === 'https')?.public_url ?? '';
  } catch {
    return '';
  }
}

async function ensureNgrokUrl() {
  let url = await latestNgrokUrl();
  if (url || process.platform !== 'darwin') return url;

  const launchAgentPath = `${process.env.HOME}/Library/LaunchAgents/com.telebid.ngrok.plist`;
  if (!existsSync(launchAgentPath)) return '';

  spawnSync('launchctl', ['kickstart', `gui/${process.getuid()}/com.telebid.ngrok`], {
    stdio: 'ignore',
  });

  const deadline = Date.now() + 15_000;
  while (!url && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    url = await latestNgrokUrl();
  }
  return url;
}

function startTunnelWatcher() {
  stopManagedProcess(tunnelWatcherPidPath);
  const log = openSync(tunnelWatcherLogPath, 'w');
  const watcher = spawn(process.execPath, ['scripts/telegram-tunnel-watch.mjs'], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  writeFileSync(tunnelWatcherPidPath, `${watcher.pid}\n`, 'utf8');
  watcher.unref();
}

async function startRunlocal() {
  mkdirSync(runtimeDirectory, { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    stopManagedTunnel();
    if (attempt > 1) process.stdout.write(`Повторяю подключение к runlocal (${attempt}/3)…\n`);

    const log = openSync(tunnelLogPath, 'w');
    const tunnel = spawn(
      process.platform === 'win32' ? 'node_modules/.bin/runlocal.cmd' : 'node_modules/.bin/runlocal',
      ['4173'],
      { detached: true, stdio: ['ignore', log, log] },
    );
    let tunnelExited = false;
    tunnel.once('error', () => {
      tunnelExited = true;
    });
    tunnel.once('exit', () => {
      tunnelExited = true;
    });
    closeSync(log);
    writeFileSync(tunnelPidPath, `${tunnel.pid}\n`, 'utf8');
    tunnel.unref();

    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const output = existsSync(tunnelLogPath) ? readFileSync(tunnelLogPath, 'utf8') : '';
      const url = latestRunlocalUrl(output);
      if (url && (await waitForPublic(url, 30_000))) return url;
      if (tunnelExited) break;
      try {
        process.kill(tunnel.pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    stopManagedTunnel();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Резервный HTTPS-туннель не запустился. Лог: ${tunnelLogPath}`);
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
const ngrokUrl = configuredUrl ? '' : await ensureNgrokUrl();
const useCloudflare = !configuredUrl && !ngrokUrl;
process.stdout.write(`Запускаю TeleBid, PostgreSQL и ${configuredUrl ? 'приложение' : 'HTTPS-туннель'}…\n`);
mkdirSync(runtimeDirectory, { recursive: true });
stopManagedProcess(tunnelWatcherPidPath);
stopManagedTunnel();
docker(['compose', '--profile', 'telegram', 'rm', '-sf', 'cloudflared'], { allowFailure: true });
docker([
  'compose',
  ...(useCloudflare ? ['--profile', 'telegram'] : []),
  'up',
  '--build',
  '-d',
  'postgres',
  'api',
  'web',
  ...(useCloudflare ? ['cloudflared'] : []),
]);
await waitFor('http://localhost:8080/health', 60_000);

let publicUrl = configuredUrl ?? ngrokUrl;
let tunnelProvider = configuredUrl ? 'configured' : ngrokUrl ? 'ngrok' : 'cloudflare';
if (!publicUrl && useCloudflare) {
  const tunnelDeadline = Date.now() + 60_000;
  while (!publicUrl && Date.now() < tunnelDeadline) {
    const logs = docker(['compose', '--profile', 'telegram', 'logs', '--no-color', 'cloudflared'], { capture: true, allowFailure: true });
    publicUrl = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? '';
    if (!publicUrl) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (publicUrl && !(await waitForPublic(publicUrl, 60_000))) publicUrl = '';
if (!publicUrl && !configuredUrl) {
  const recoveredNgrokUrl = await ensureNgrokUrl();
  if (recoveredNgrokUrl && (await waitForPublic(recoveredNgrokUrl, 60_000))) {
    publicUrl = recoveredNgrokUrl;
    tunnelProvider = 'ngrok';
    docker(['compose', '--profile', 'telegram', 'stop', 'cloudflared'], { allowFailure: true });
  }
}
if (!publicUrl) {
  process.stdout.write('Cloudflare недоступен из этой сети, переключаюсь на runlocal…\n');
  docker(['compose', '--profile', 'telegram', 'stop', 'cloudflared'], { allowFailure: true });
  publicUrl = await startRunlocal();
  tunnelProvider = 'runlocal';
}
publicUrl = new URL(publicUrl).toString();

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
if (['ngrok', 'runlocal'].includes(tunnelProvider)) startTunnelWatcher();

process.stdout.write(`\nTeleBid готов.\n`);
process.stdout.write(`Бот: https://t.me/${bot.username}\n`);
process.stdout.write(`Mini App: ${publicUrl}\n`);
process.stdout.write(`Туннель: ${tunnelProvider}\n`);
if (['ngrok', 'runlocal'].includes(tunnelProvider)) process.stdout.write('Автообновление ссылки: включено\n');
process.stdout.write(`Локально: http://localhost:4173\n`);
process.stdout.write(`Логи: npm run telegram:logs\n`);
process.stdout.write(`Остановить: npm run telegram:down\n`);

try {
  execFileSync('open', [`https://t.me/${bot.username}`], { stdio: 'ignore' });
} catch {}
