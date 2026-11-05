import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAuth, userOwnerId } from './auth';

const URL_ = 'https://example-project.supabase.co';
const userId = '5f0c8c6e-2b8e-4d55-9a0a-0a3f9e2d7c11';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const auth = createAuth({ url: URL_, jwks: JSON.stringify({ keys: [jwk] }) });
  const sign = (claims: Record<string, unknown> = {}, { issuer = `${URL_}/auth/v1`, expires = '1h' } = {}) =>
    new SignJWT({ role: 'authenticated', email: 'ada@example.com', ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setSubject(userId).setIssuer(issuer).setAudience('authenticated')
      .setIssuedAt().setExpirationTime(expires).sign(privateKey);
  return { auth, sign };
}

describe('Supabase sign-in tokens', () => {
  it('accepts a valid token and namespaces the owner id', async () => {
    const { auth, sign } = await setup();
    const user = await auth.verify(await sign());
    expect(user).toEqual({ id: userId, email: 'ada@example.com' });
    expect(userOwnerId(user!)).toBe(`user:${userId}`);
  });

  it('rejects expired, foreign, anonymous and tampered tokens', async () => {
    const { auth, sign } = await setup();
    expect(await auth.verify(await sign({}, { expires: '-1m' }))).toBeNull();
    expect(await auth.verify(await sign({}, { issuer: 'https://evil.supabase.co/auth/v1' }))).toBeNull();
    expect(await auth.verify(await sign({ role: 'anon' }))).toBeNull();
    const token = await sign();
    expect(await auth.verify(token.slice(0, -4) + 'AAAA')).toBeNull();
    expect(await auth.verify('not a token')).toBeNull();
  });

  it('is off without a Supabase URL', async () => {
    const auth = createAuth({});
    expect(auth.configured).toBe(false);
    expect(await auth.verify('anything')).toBeNull();
  });
});
