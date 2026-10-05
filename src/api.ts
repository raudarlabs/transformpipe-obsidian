import { requestUrl, type RequestUrlResponse } from 'obsidian';
import type { Auth } from './auth.ts';

/*
 * TransformPipe's public API, the parts this plugin uses. Every call goes through `requestUrl`,
 * Obsidian's own, which works on the phone as well as the desktop and is not subject to the
 * renderer's CORS — the API sends no CORS headers, and a plugin is not a web page.
 */

export interface Share {
  mode: 'private' | 'link' | 'people';
  url: string | null;
  expires_at: string | null;
  views: number;
  has_password: boolean;
}

export interface RemoteDocument {
  id: string;
  name: string;
  size: number;
  words: number;
  created_at: string;
  updated_at: string | null;
  share: Share;
}

export interface Usage {
  email: string | null;
  bytes: number;
  documents: number;
  limits: { bytes: number; documents: number };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    private readonly auth: Auth,
    private readonly host: () => string
  ) {}

  /** One request, signed in; a 401 refreshes once and asks again. */
  private async call(
    path: string,
    init: { method?: string; body?: string; contentType?: string } = {},
    retried = false
  ): Promise<RequestUrlResponse> {
    const token = this.auth.accessToken;

    if (!token) {
      throw new ApiError('Sign in to TransformPipe first, in the plugin’s settings.', 401);
    }

    const response = await requestUrl({
      url: `${this.host()}/api/v1${path}`,
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}` },
      contentType: init.contentType,
      body: init.body,
      throw: false,
    });

    if (response.status === 401 && !retried && (await this.auth.refresh())) {
      return this.call(path, init, true);
    }

    if (response.status === 401) {
      throw new ApiError('The sign-in has ended. Sign in to TransformPipe again, in the plugin’s settings.', 401);
    }

    if (response.status >= 400) {
      // The API says what went wrong in a sentence; that sentence is the best message there is.
      let said = '';

      try {
        const body = response.json as { error?: unknown } | null;

        said = typeof body?.error === 'string' ? body.error : '';
      } catch {
        said = '';
      }

      throw new ApiError(said || `TransformPipe answered ${response.status}`, response.status);
    }

    return response;
  }

  async publish(name: string, markdown: string, share: 'link' | null): Promise<RemoteDocument> {
    const query = new URLSearchParams({ name });

    if (share) {
      query.set('share', share);
    }

    const response = await this.call(`/documents?${query}`, {
      method: 'POST',
      contentType: 'text/markdown; charset=utf-8',
      body: markdown,
    });

    return (response.json as { document: RemoteDocument }).document;
  }

  /** New text, same document and link. */
  async update(id: string, name: string, markdown: string): Promise<{ document: RemoteDocument; changed: boolean }> {
    const response = await this.call(`/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify({ markdown, name }),
    });

    return response.json as { document: RemoteDocument; changed: boolean };
  }

  async get(id: string): Promise<RemoteDocument> {
    return ((await this.call(`/documents/${encodeURIComponent(id)}`)).json as { document: RemoteDocument }).document;
  }

  async share(id: string, body: { mode: 'private' | 'link' | 'people'; emails?: string[] }): Promise<Share & { notified?: string[] }> {
    const response = await this.call(`/documents/${encodeURIComponent(id)}/share`, {
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    return response.json as Share & { notified?: string[] };
  }

  async download(id: string, format: 'docx' | 'pdf'): Promise<ArrayBuffer> {
    return (await this.call(`/documents/${encodeURIComponent(id)}.${format}`)).arrayBuffer;
  }

  async usage(): Promise<Usage> {
    return (await this.call('/usage')).json as Usage;
  }
}
