interface ProxyDescription {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
}

interface ToxiproxyOptions {
  apiUrl: string;
  proxyName: string;
  listen: string;
  upstream: string;
}

export class ToxiproxyController {
  constructor(private readonly options: ToxiproxyOptions) {}

  async verify(): Promise<string> {
    const response = await fetch(`${this.options.apiUrl}/version`);
    if (!response.ok) throw new Error(`Toxiproxy /version: HTTP ${response.status}`);
    const body = (await response.text()).trim();
    try {
      const parsed = JSON.parse(body) as { version?: string };
      return parsed.version ?? body;
    } catch {
      return body;
    }
  }

  async configure(latencyMs: number, jitterMs: number): Promise<void> {
    await this.request('/populate', {
      method: 'POST',
      body: JSON.stringify([
        {
          name: this.options.proxyName,
          listen: this.options.listen,
          upstream: this.options.upstream,
          enabled: true,
        },
      ]),
    });
    await this.request('/reset', { method: 'POST' });
    if (latencyMs > 0 || jitterMs > 0) {
      await this.request(`/proxies/${this.options.proxyName}/toxics`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'telebid_downstream_latency',
          type: 'latency',
          stream: 'downstream',
          toxicity: 1,
          attributes: { latency: latencyMs, jitter: jitterMs },
        }),
      });
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const current = await this.request<ProxyDescription>(`/proxies/${this.options.proxyName}`);
    await this.request(`/proxies/${this.options.proxyName}`, {
      method: 'POST',
      body: JSON.stringify({
        name: current.name,
        listen: current.listen,
        upstream: current.upstream,
        enabled,
      }),
    });
  }

  async reset(): Promise<void> {
    await this.request('/reset', { method: 'POST' });
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.options.apiUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`Toxiproxy ${init?.method ?? 'GET'} ${path}: HTTP ${response.status} ${await response.text()}`);
    }
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }
}
