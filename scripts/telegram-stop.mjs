import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

for (const pidPath of ['.telebid/tunnel-watch.pid', '.telebid/tunnel.pid', '.telebid/pinggy.pid']) {
  if (existsSync(pidPath)) {
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
}

execFileSync('docker', ['compose', '--profile', 'telegram', 'down'], { stdio: 'inherit' });
