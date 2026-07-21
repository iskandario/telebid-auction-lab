const url = process.env.API_URL ?? 'http://localhost:8080';
const deadline = Date.now() + 90_000;

process.stdout.write(`Waiting for ${url}/health`);
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${url}/health`);
    if (response.ok) {
      process.stdout.write(' ready\n');
      process.exit(0);
    }
  } catch {
    // The API container is still starting.
  }
  process.stdout.write('.');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

process.stderr.write(`\nAPI did not become ready within 90 seconds. Run: docker compose logs api\n`);
process.exit(1);
