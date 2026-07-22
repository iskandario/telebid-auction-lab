import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const runtimeDirectory = '.telebid';
const tunnelLogPath = `${runtimeDirectory}/tunnel.log`;
const publicUrlPath = `${runtimeDirectory}/public-url`;
const runOnce = process.env.TELEBID_WATCH_ONCE === 'true';

process.loadEnvFile?.('.env');
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  process.stderr.write('Tunnel watcher: TELEGRAM_BOT_TOKEN не настроен.\n');
  process.exit(1);
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function normalizeUrl(value) {
  return new URL(value).toString();
}

function latestRunlocalUrl() {
  if (!existsSync(tunnelLogPath)) return '';
  const output = readFileSync(tunnelLogPath, 'utf8');
  const url = [...output.matchAll(/https:\/\/[a-z0-9-]+\.runlocal\.eu/gi)].at(-1)?.[0];
  return url ? normalizeUrl(url) : '';
}

async function latestNgrokUrl() {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return '';
    const body = await response.json();
    const url = body.tunnels?.find((tunnel) => tunnel.proto === 'https')?.public_url;
    return url ? normalizeUrl(url) : '';
  } catch {
    return '';
  }
}

async function latestTunnelUrl() {
  return (await latestNgrokUrl()) || latestRunlocalUrl();
}

async function isTeleBidReachable(url) {
  try {
    const response = await fetch(new URL('health', url), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === 'ok' && body.service === 'telebid-api';
  } catch {
    return false;
  }
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.description ?? `Telegram API ${method}`);
  return body.result;
}

async function updateMenuButton(url) {
  await telegram('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Открыть TeleBid',
      web_app: { url },
    },
  });
  const menu = await telegram('getChatMenuButton');
  const installedUrl = menu.web_app?.url ? normalizeUrl(menu.web_app.url) : '';
  if (installedUrl !== url) throw new Error('Telegram не подтвердил новый URL Mini App');
}

let activeUrl = '';
let synchronized = false;
do {
  try {
    const nextUrl = await latestTunnelUrl();
    if (nextUrl && nextUrl !== activeUrl && (await isTeleBidReachable(nextUrl))) {
      await updateMenuButton(nextUrl);
      writeFileSync(publicUrlPath, `${nextUrl}\n`, 'utf8');
      activeUrl = nextUrl;
      synchronized = true;
      process.stdout.write(`${new Date().toISOString()} Mini App URL: ${nextUrl}\n`);
    }
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} Tunnel watcher: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!runOnce) await delay(2000);
} while (!runOnce);

if (runOnce && !synchronized) {
  process.stderr.write('Tunnel watcher: живой адрес TeleBid не найден.\n');
  process.exitCode = 1;
}
