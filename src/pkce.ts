/*
 * PKCE (RFC 7636) and the state that ties a sign-in to the request that started it.
 *
 * The plugin is a public client — it runs on somebody's device and cannot keep a secret — so the
 * code that comes back through `obsidian://` is worth nothing without the verifier made here, and
 * an app that claimed the same scheme and caught the code could not use it.
 */

const base64url = (bytes: Uint8Array): string => {
  let text = '';

  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }

  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** 32 random bytes as base64url: 43 characters, inside the 43–128 the RFC allows. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return base64url(new Uint8Array(digest));
}
