import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { db } from '../db/connection';

// ---------------------------------------------------------------------------
// engine/oauth.ts — OAuth 2.0 client management and token operations
// ---------------------------------------------------------------------------

export interface OAuthClient {
  client_id: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  is_active: boolean;
  created_at: string;
}

export interface OAuthClientWithSecret extends OAuthClient {
  client_secret: string; // raw — returned ONCE at creation, never stored
}

// ---------------------------------------------------------------------------
// Client management
// ---------------------------------------------------------------------------

export async function createOAuthClient(name: string): Promise<OAuthClientWithSecret> {
  const client_id = 'luca_' + crypto.randomBytes(12).toString('hex');
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const client_secret_hash = await bcrypt.hash(rawSecret, 10);

  await db('oauth_clients').insert({
    client_id,
    client_secret_hash,
    name,
    redirect_uris: ['https://claude.ai/', 'https://claude.com/'],
    scopes: ['ledger:read', 'ledger:write'],
    is_active: true,
  });

  const client = await db('oauth_clients')
    .where('client_id', client_id)
    .first<OAuthClient>();

  return { ...client, client_secret: rawSecret };
}

/**
 * RFC 7591 — Dynamic Client Registration.
 * Creates a client on behalf of a self-registering OAuth client (e.g. Claude's MCP connector).
 * Public clients (token_endpoint_auth_method: "none") have no client_secret.
 */
export async function registerDynamicClient(opts: {
  name: string;
  redirectUris: string[];
  scopes: string[];
  isPublic: boolean;
}): Promise<{ client_id: string; client_secret?: string }> {
  const client_id = 'luca_' + crypto.randomBytes(12).toString('hex');

  let rawSecret: string | undefined;
  let client_secret_hash: string | null = null;

  if (!opts.isPublic) {
    rawSecret = crypto.randomBytes(32).toString('hex');
    client_secret_hash = await bcrypt.hash(rawSecret, 10);
  }

  await db('oauth_clients').insert({
    client_id,
    client_secret_hash,   // null for public clients
    name: opts.name,
    redirect_uris: opts.redirectUris,
    scopes: opts.scopes,
    is_active: true,
  });

  return { client_id, ...(rawSecret !== undefined ? { client_secret: rawSecret } : {}) };
}

export async function listOAuthClients(): Promise<OAuthClient[]> {
  return db('oauth_clients')
    .select('client_id', 'name', 'redirect_uris', 'scopes', 'is_active', 'created_at')
    .orderBy('created_at', 'desc');
}

export async function revokeOAuthClient(clientId: string): Promise<boolean> {
  const n = await db('oauth_clients')
    .where('client_id', clientId)
    .update({ is_active: false });
  return n > 0;
}

export async function findOAuthClient(
  clientId: string,
): Promise<(OAuthClient & { client_secret_hash: string }) | null> {
  const row = await db('oauth_clients').where('client_id', clientId).first();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function createAuthorizationCode(opts: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): Promise<string> {
  const code = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db('oauth_authorization_codes').insert({
    code,
    client_id: opts.clientId,
    user_id: opts.userId,
    redirect_uri: opts.redirectUri,
    scopes: opts.scopes,
    code_challenge: opts.codeChallenge ?? null,
    code_challenge_method: opts.codeChallengeMethod ?? null,
    expires_at: expiresAt,
    used: false,
  });

  return code;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export async function exchangeCodeForToken(opts: {
  code: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
  redirectUri: string;
}): Promise<string> {
  const row = await db('oauth_authorization_codes')
    .where('code', opts.code)
    .where('client_id', opts.clientId)
    .where('used', false)
    .where('expires_at', '>', new Date())
    .first();

  if (!row) throw new Error('Invalid or expired authorization code');

  // Verify PKCE challenge if it was set
  if (row.code_challenge) {
    if (!opts.codeVerifier) throw new Error('code_verifier is required');
    const computed = crypto
      .createHash('sha256')
      .update(opts.codeVerifier)
      .digest('base64url');
    if (computed !== row.code_challenge) throw new Error('code_verifier mismatch');
  }

  // Verify client secret if provided (not required for public PKCE clients)
  if (opts.clientSecret) {
    const client = await db('oauth_clients').where('client_id', opts.clientId).first();
    if (!client) throw new Error('Client not found');
    const valid = await bcrypt.compare(opts.clientSecret, client.client_secret_hash);
    if (!valid) throw new Error('Invalid client_secret');
  }

  // Consume the authorization code
  await db('oauth_authorization_codes').where('code', opts.code).update({ used: true });

  // Issue a Bearer token — store only the SHA-256 hash, return the raw value
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  await db('oauth_access_tokens').insert({
    token_hash: tokenHash,
    client_id: opts.clientId,
    user_id: row.user_id,
    scopes: row.scopes,
    expires_at: null, // long-lived connector tokens
    is_revoked: false,
  });

  return rawToken;
}

// ---------------------------------------------------------------------------
// Token validation — called on every MCP request
// ---------------------------------------------------------------------------

export async function validateAccessToken(
  rawToken: string,
): Promise<{ userId: string; scopes: string[] } | null> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const row = await db('oauth_access_tokens')
    .where('token_hash', tokenHash)
    .where('is_revoked', false)
    .first();

  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Fire-and-forget last_used_at update
  db('oauth_access_tokens')
    .where('token_hash', tokenHash)
    .update({ last_used_at: new Date() })
    .catch(() => {/* ignore */});

  return { userId: row.user_id, scopes: row.scopes as string[] };
}
