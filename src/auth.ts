import { type App, requestUrl, type RequestUrlResponse } from 'obsidian';
import { challengeFor, randomToken } from './pkce.ts';

/*
 * Signing in to TransformPipe from Obsidian.
 *
 * The ordinary OAuth flow a connector uses, with Obsidian as the app the browser comes back to:
 * the plugin opens TransformPipe's sign-in in the browser, the person approves, and the browser
 * hands the code back through `obsidian://transformpipe-auth`, which this plugin listens on. The
 * client id is a fixed one the server knows (`transformpipe-obsidian`), so nothing registers.
 *
 * The tokens live in Obsidian's SecretStorage — the system keychain — and never in data.json,
 * which sits in the vault and travels with it to every place the vault is synced.
 */

export const CLIENT_ID = 'transformpipe-obsidian';
export const REDIRECT_URI = 'obsidian://transformpipe-auth';
export const PROTOCOL_ACTION = 'transformpipe-auth';

/*
 * The sign-in in progress, kept outside memory as well.
 *
 * On a phone the browser takes the screen while the person approves, and the system is free to
 * unload Obsidian behind it. The app that wakes up to `obsidian://transformpipe-auth` was then a
 * fresh one with no idea a sign-in had started, and refused the code it was handed — which is how
 * signing in from a phone failed. The state and the PKCE verifier are worth nothing after the code
 * is exchanged, and nothing without the code, so they wait in Obsidian's own local storage for ten
 * minutes rather than in the plugin's memory alone.
 */
const PENDING_KEY = 'transformpipe-sign-in';
const PENDING_FOR_MS = 10 * 60 * 1000;

interface Kept {
  state: string;
  verifier: string;
  host: string;
  at: number;
}

const SECRET_ACCESS = 'transformpipe-access-token';
const SECRET_REFRESH = 'transformpipe-refresh-token';

/** What the token endpoint answers, or null when the body is not JSON at all. */
interface Tokens {
  access_token?: string;
  refresh_token?: string;
  error_description?: string;
}

function tokensOf(answer: RequestUrlResponse): Tokens | null {
  try {
    return answer.json as Tokens | null;
  } catch {
    return null;
  }
}

interface Pending {
  state: string;
  verifier: string;
  host: string;
  resolve: (ok: boolean) => void;
}

/** A verifier and its challenge, worked out before anybody presses Sign in. */
interface Ready {
  verifier: string;
  challenge: string;
}

export class Auth {
  private pending: Pending | null = null;
  private ready: Ready | null = null;

  constructor(
    private readonly app: App,
    private readonly host: () => string
  ) {}

  /** Whether this Obsidian can keep a secret at all: SecretStorage arrived in 1.11.4. */
  get supported(): boolean {
    return typeof this.app.secretStorage?.getSecret === 'function';
  }

  get accessToken(): string | null {
    return this.supported ? this.app.secretStorage.getSecret(SECRET_ACCESS) || null : null;
  }

  get signedIn(): boolean {
    return Boolean(this.accessToken);
  }

  private store(access: string, refresh: string | null) {
    this.app.secretStorage.setSecret(SECRET_ACCESS, access);
    // SecretStorage has no delete; an empty string is what "none" is.
    this.app.secretStorage.setSecret(SECRET_REFRESH, refresh ?? '');
  }

  /*
   * The PKCE challenge, made ahead of time.
   *
   * Hashing is asynchronous, and on an iPhone that is the whole problem: the system lets a page
   * open the browser only while it is still handling the tap, and an `await` before `window.open`
   * ends that. Obsidian on iOS then opened nothing — the Sign in button just sat there — while every
   * desktop, which has no such rule, worked. So the challenge is computed when the plugin loads and
   * again after each use, and the tap itself does nothing that waits.
   */
  async prepare(): Promise<void> {
    if (this.ready) {
      return;
    }

    const verifier = randomToken();

    this.ready = { verifier, challenge: await challengeFor(verifier) };
  }

  /**
   * Opens the sign-in in the browser; resolves when the code has come back and been exchanged.
   *
   * Not `async`, on purpose: everything up to `window.open` has to run in the same turn as the tap
   * that called it — see `prepare`.
   */
  signIn(): Promise<boolean> {
    if (!this.supported) {
      return Promise.reject(
        new Error('Signing in needs Obsidian 1.11.4 or later, which keeps the sign-in in the system keychain.')
      );
    }

    const ready = this.ready;

    if (!ready) {
      // Not made yet — only possible in the first instant after loading. A desktop opens the
      // browser after a wait without complaint; on a phone the next tap finds it ready.
      return this.prepare().then(() => this.signIn());
    }

    this.ready = null;

    const host = this.host();
    const verifier = ready.verifier;
    const state = randomToken();
    const query = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: ready.challenge,
      code_challenge_method: 'S256',
      scope: 'documents:read documents:write',
      resource: `${host}/api/mcp`,
      state,
    });

    const done = new Promise<boolean>((resolve) => {
      this.pending?.resolve(false);
      this.pending = { state, verifier, host, resolve };
    });

    this.app.saveLocalStorage(PENDING_KEY, { state, verifier, host, at: Date.now() } satisfies Kept);

    window.open(`${host}/api/oauth/authorize?${query}`);

    // The next sign-in's challenge, so a second attempt is as instant as the first.
    void this.prepare();

    return done;
  }

  /** What `obsidian://transformpipe-auth?…` brought back. */
  async handleRedirect(params: Record<string, string>): Promise<{ ok: boolean; message: string }> {
    const pending = this.pending?.state === params.state ? this.pending : this.restore(params.state);

    if (!pending) {
      return { ok: false, message: 'That sign-in was not started here, so it was ignored.' };
    }

    this.pending = null;
    this.app.saveLocalStorage(PENDING_KEY, null);

    if (params.error) {
      pending.resolve(false);

      return { ok: false, message: params.error_description || `Sign-in refused: ${params.error}` };
    }

    const answer = await requestUrl({
      url: `${pending.host}/api/oauth/token`,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code ?? '',
        code_verifier: pending.verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: `${pending.host}/api/mcp`,
      }).toString(),
      throw: false,
    });

    const tokens = tokensOf(answer);

    if (answer.status !== 200 || !tokens?.access_token) {
      pending.resolve(false);

      return { ok: false, message: tokens?.error_description ?? `Sign-in failed (${answer.status})` };
    }

    this.store(tokens.access_token, tokens.refresh_token ?? null);
    pending.resolve(true);

    return { ok: true, message: 'Signed in to TransformPipe.' };
  }

  /** The sign-in this Obsidian started before it was unloaded, if it is this one and still fresh. */
  private restore(state: string | undefined): Pending | null {
    const kept = this.app.loadLocalStorage(PENDING_KEY) as Kept | null;

    if (!kept || !state || kept.state !== state || Date.now() - kept.at > PENDING_FOR_MS) {
      return null;
    }

    return { state: kept.state, verifier: kept.verifier, host: kept.host, resolve: () => undefined };
  }

  /** A new pair for the refresh token, once; false means sign in again. */
  async refresh(): Promise<boolean> {
    const refresh = this.supported ? this.app.secretStorage.getSecret(SECRET_REFRESH) : null;

    if (!refresh) {
      return false;
    }

    const answer = await requestUrl({
      url: `${this.host()}/api/oauth/token`,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: CLIENT_ID,
      }).toString(),
      throw: false,
    });

    const tokens = tokensOf(answer);

    if (answer.status !== 200 || !tokens?.access_token) {
      this.store('', null);

      return false;
    }

    this.store(tokens.access_token, tokens.refresh_token ?? null);

    return true;
  }

  /** Hands the grant back to the server, so it stops working there too, and forgets it here. */
  async signOut(): Promise<void> {
    const refresh = this.supported ? this.app.secretStorage.getSecret(SECRET_REFRESH) : null;

    if (refresh) {
      await requestUrl({
        url: `${this.host()}/api/oauth/revoke`,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({ token: refresh, client_id: CLIENT_ID }).toString(),
        throw: false,
      }).catch(() => undefined);
    }

    if (this.supported) {
      this.store('', null);
    }
  }
}
