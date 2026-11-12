# Deployment

The web app is published by GitLab Pages and the API runs on Render. A GitHub Actions workflow copies the GitHub
`main` branch to the GitLab project, whose pipeline builds the site. Render builds the API image from
`Dockerfile.api`, which includes TeX Live. Neon (Postgres) stores project data and Cloudflare R2 stores file contents
and compiled PDFs. Supabase handles sign-in.

Every secret below is entered in the hosting dashboards. None belongs in the repository, and nothing secret may be
put in a `VITE_` variable, because those are compiled into the public web app.

## Setup

1. **GitLab project.** Create a blank public project named `paperdesk` with the default branch `main` and no README.
   Under **Deploy → Pages**, enable **Use unique domain** and note the HTTPS URL
   (`https://paperdesk-<id>.gitlab.io`).

2. **GitLab token.** Under **Settings → Access tokens**, create a project access token with the Maintainer role, the
   `write_repository` scope and an expiry date. Keep it in a password manager.

3. **GitHub sync secret.** In the GitHub repository, open **Settings → Secrets and variables → Actions** and add the
   repository secret `GITLAB_TOKEN` with the token from step 2. `.github/workflows/sync-gitlab.yml` pushes `main` to
   GitLab on every push.

4. **Storage.** In Neon, create a database and copy its pooled connection string. In Cloudflare R2, note the account
   ID, create a private bucket named `paperdesk-files`, and create an API token restricted to that bucket with
   object read and write permissions. Do not enable public access to the bucket.

5. **Render service.** Choose **New → Blueprint**, connect the GitHub repository and use its `render.yaml`. In the
   service's environment, set:

   | Variable                                   | Value                                                                                  |
   | ------------------------------------------ | -------------------------------------------------------------------------------------- |
   | `DATABASE_URL`                             | Neon pooled connection string                                                          |
   | `R2_ACCOUNT_ID`                            | Cloudflare account ID                                                                  |
   | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | From the bucket-scoped R2 token                                                        |
   | `R2_BUCKET`                                | `paperdesk-files`                                                                      |
   | `PAPERDESK_CORS_ORIGINS`                   | The Pages origin from step 1, without a trailing slash                                 |
   | `SUPABASE_URL`                             | The Supabase project URL from step 7 (optional; without it there are no accounts)      |
   | `CROSSREF_MAILTO`                          | A contact email sent with citation lookups, as Crossref asks (optional)                |
   | `BREVO_API_KEY`                            | Brevo API key for invitation emails (optional; without it invitations are links only)  |
   | `MAIL_FROM`                                | The verified Brevo sender address invitations come from (needed with `BREVO_API_KEY`)  |
   | `ANTHROPIC_API_KEY`                        | Key for the assistant panel (optional; without it the panel says it is not configured) |

   `ASSISTANT_MODEL` has a default in the blueprint and can be changed. After the service is created, note its
   public origin, for example `https://paperdesk-api-xxxx.onrender.com`.

6. **Web app settings.** In GitLab, open **Settings → CI/CD → Variables** and add `VITE_API_URL` with the Render
   origin from step 5. It is a public URL, not a secret. Leave it unprotected and unmasked so the pipeline can read
   it.

7. **Sign-in (optional).** Create a Supabase project. Under **Authentication → URL Configuration**, set the site
   URL to the Pages URL and add it to the redirect URLs. To offer Google sign-in, create an OAuth client in the
   Google Cloud console with Supabase's callback URL and enter its ID and secret under **Authentication →
   Providers → Google**. Then add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the publishable key) to the
   GitLab CI/CD variables, and `SUPABASE_URL` to Render.

8. **First deployment.** Push `main` to GitHub. The sync workflow copies it to GitLab, the Pages pipeline builds the
   web app, and Render builds and starts the API.

9. **Check.** `<api origin>/api/health` should report `storage.mode: neon-r2`, `storage.ready: true` and
   `compilerReady: true`. The Pages pipeline should be green and the site should compile a template.

## Later deployments

Pushing to `main` on GitHub deploys both parts. If the GitHub sync job is delayed, the site can be updated by
pushing `main` to the GitLab project directly:

```sh
git push https://gitlab.com/<namespace>/paperdesk.git origin/main:main
```

## Limits of the free tiers

- The Render free service has 512 MB of memory and little CPU, sleeps after inactivity, and has no persistent disk.
  The first request after a sleep takes up to a minute, and one compile runs at a time.
- Projects therefore need Neon and R2 in production: files on the service's own disk are lost on every restart.
- Without an account, projects belong to a random key stored in the browser, so they are tied to that browser.
  Signing in moves them to the account.
- The R2 bucket stays private. The browser never talks to it, so it needs no public access or CORS policy; the
  API's `PAPERDESK_CORS_ORIGINS` controls which sites may call the API.
