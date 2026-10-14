// Download/extract helpers shared by the host (Windows Terminal pre-download) and the guest (toolchains).
// Node built-ins only, so it stays small in both bundles (the CLI and the guest runtime).

const USER_AGENT = 'windows-development-sandbox';

/** fetch with retries (the sandbox network can take a few seconds to come up) and a timeout per attempt. */
export async function fetchRetry(
  url: string,
  init: RequestInit = {},
  attempts = 5,
  timeoutMs = 60000,
): Promise<Response> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      });
      if (response.ok) return response;
      last = new Error('HTTP ' + response.status + ' for ' + url);
      if (response.status === 404) break;
    } catch (e) {
      last = e;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Small lookups fail fast (2 tries, 20 s each) so an offline boot falls back to cached versions quickly. */
export async function fetchJson<T>(url: string): Promise<T> {
  return (await (await fetchRetry(url, { headers: { Accept: 'application/json' } }, 2, 20000)).json()) as T;
}
export async function fetchText(url: string): Promise<string> {
  return await (await fetchRetry(url)).text();
}
