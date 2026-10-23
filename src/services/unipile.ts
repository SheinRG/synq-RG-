// Thin client for the Unipile REST API (v1). Only the calls this project needs.
// Docs: https://developer.unipile.com/docs/api-usage

export interface UnipileProfile {
  provider_id: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
}

export interface UnipileMessage {
  id: string;
  chat_id: string;
  sender_id?: string;
  text?: string | null;
  timestamp: string;
  /** Unipile uses 0/1 numbers for these flags. */
  is_sender: number | boolean;
  seen?: number | boolean;
  delivered?: number | boolean;
}

export interface ThreadMessage {
  fromLead: boolean;
  text: string;
  at: string;
}

/** The subset of the client the tracker uses. Lets tests swap in a fake. */
export interface UnipileApi {
  getProfile(identifier: string): Promise<UnipileProfile>;
  getRecentMessages(chatId: string, limit?: number): Promise<ThreadMessage[]>;
}

export class UnipileClient implements UnipileApi {
  private baseUrl: string;

  constructor(
    dsn: string,
    private apiKey: string,
    private accountId: string,
  ) {
    const host = dsn.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.baseUrl = `https://${host}/api/v1`;
  }

  /** identifier is the public slug from the profile URL, or a provider id. */
  async getProfile(identifier: string): Promise<UnipileProfile> {
    return this.request<UnipileProfile>(
      `/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(this.accountId)}`,
    );
  }

  /** Newest messages last, so it reads like a transcript. */
  async getRecentMessages(chatId: string, limit = 8): Promise<ThreadMessage[]> {
    const page = await this.request<{ items: UnipileMessage[] }>(
      `/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
    );
    return page.items
      .filter((m) => m.text)
      .map((m) => ({ fromLead: !flag(m.is_sender), text: m.text ?? "", at: m.timestamp }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  async listWebhooks(): Promise<unknown> {
    return this.request("/webhooks");
  }

  async createWebhook(body: {
    request_url: string;
    name: string;
    source: "messaging";
    events: string[];
    account_ids: string[];
    headers: { key: string; value: string }[];
  }): Promise<{ webhook_id: string }> {
    return this.request("/webhooks", { method: "POST", body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { "X-API-KEY": this.apiKey, accept: "application/json", "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Unipile ${init.method ?? "GET"} ${path} failed: ${res.status} ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

/** linkedin.com/in/priya-sharma-123/ -> priya-sharma-123 */
export function linkedinSlug(url: string): string | null {
  const match = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url.trim());
  return match ? decodeURIComponent(match[1]) : null;
}

function flag(v: unknown): boolean {
  return v === true || v === 1;
}
