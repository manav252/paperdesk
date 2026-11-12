import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** A signed-in PaperDesk user, from a verified Supabase access token. */
export type AuthUser = { id: string; email?: string };

/**
 * Projects of signed-in users are stored under `user:<Supabase user id>`. Anonymous browsers use a bare random
 * UUID, so the anonymous header can never name an account's projects (user ids are not secret).
 */
export const userOwnerId = (user: AuthUser) => `user:${user.id}`;

export type AuthConfig = { url: string; jwks?: string; jwtSecret?: string };

/**
 * Verifies Supabase access tokens. New Supabase projects sign tokens with asymmetric keys published at
 * `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, so the server needs no secret; older projects that still use
 * the shared HS256 secret can set SUPABASE_JWT_SECRET instead. SUPABASE_JWKS (inline JSON) is for tests.
 */
export function createAuth(config: Partial<AuthConfig> = {}) {
  const url = (config.url ?? '').replace(/\/+$/, '');
  if (!url) return { configured: false as const, verify: async (_token: string): Promise<AuthUser | null> => null };
  const issuer = `${url}/auth/v1`;
  const secret = config.jwtSecret ? new TextEncoder().encode(config.jwtSecret) : null;
  const keys: JWTVerifyGetKey = config.jwks
    ? createLocalJWKSet(JSON.parse(config.jwks))
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      });
  return {
    configured: true as const,
    async verify(token: string): Promise<AuthUser | null> {
      try {
        const options = { issuer, audience: 'authenticated' };
        const { payload } =
          secret && /"alg"\s*:\s*"HS256"/.test(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())
            ? await jwtVerify(token, secret, options)
            : await jwtVerify(token, keys, options);
        if (typeof payload.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sub) || payload.role === 'anon')
          return null;
        return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
      } catch {
        return null;
      }
    },
  };
}
