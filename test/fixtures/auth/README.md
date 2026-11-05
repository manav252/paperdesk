# Test-only sign-in keys

`test-signing-key.json` signs fake Supabase access tokens in the browser tests, and `test-jwks.json` is its public
half, which only the local test API (started by Playwright) is told to trust through `SUPABASE_JWKS`. Production
verifies tokens against the Supabase project's own published keys and never reads these files. Do not reuse them.
