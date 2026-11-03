# Deployment setup

The frontend is published by GitLab Pages. A GitHub Actions workflow mirrors the GitHub `main` branch to the GitLab project. Render runs the API and native TeX toolchain; Neon stores project metadata and Cloudflare R2 stores source files and compiled artifacts.

## Manual setup

1. **Create the GitLab project.** In GitLab, choose **New project** → **Create blank project**. Name it `paperdesk` in the existing `skinrondic` namespace, leave **Initialize repository with a README** unchecked, and create it as a public project. Keep the default branch named `main`. Do not create a group. In **Deploy** → **Pages**, enable **Use unique domain** and copy the HTTPS URL shown there; it will be `https://paperdesk-<six-character-id>.gitlab.io/` at the site root.

2. **Create a GitLab repository token.** Open **Settings** → **Access tokens** for the project. Create a project access token with the **Maintainer** role, `write_repository` scope and an expiry date. Copy it once into a password manager; do not put it in a repository file or chat.

3. **Add the GitHub sync secret.** In GitHub, open `manav252/paperdesk` → **Settings** → **Secrets and variables** → **Actions**. Under **Repository secrets**, add `GITLAB_TOKEN` with a token that can push to `manav252/paperdesk`. The sync workflow pushes GitHub `main` to that GitLab project. The destination path is fixed in the workflow, so no repository variable or Actions environment is needed.

4. **Create isolated storage.** In Neon, create a PaperDesk database project and a production branch/database. In **Connect**, copy its pooled connection string for `DATABASE_URL`. In Cloudflare **R2 → Overview**, note the account ID. Create a private bucket named `paperdesk-files`, then create an R2 API token restricted to that bucket with object read and write permissions. Record its Access Key ID and Secret Access Key for the Render variables below. Do not enable public bucket access.

5. **Create the Render service from the blueprint.** In Render, choose **New** → **Blueprint**, connect the GitHub repository `manav252/paperdesk`, and use its `render.yaml`. This creates a new web service named `paperdesk-api`; it must be separate from DocScanner because it runs a different API and compiler. In the service environment, set:

   | Variable | Value source |
   | --- | --- |
   | `DATABASE_URL` | Neon pooled connection string for the PaperDesk database |
   | `R2_ACCOUNT_ID` | Cloudflare account ID |
   | `R2_ACCESS_KEY_ID` | Access Key ID from the bucket-scoped R2 token |
   | `R2_SECRET_ACCESS_KEY` | Secret Access Key from the bucket-scoped R2 token |
   | `R2_BUCKET` | `paperdesk-files` |
   | `PAPERDESK_CORS_ORIGINS` | Exact Pages origin from step 1, with no trailing slash |
   | `ANTHROPIC_API_KEY` | Optional key from the provider dashboard; leave unset to show “Assistant not configured” |

   `ASSISTANT_MODEL` defaults to `claude-haiku-4-5-20251001` in the blueprint and can be changed in Render. Render assigns the API's public HTTPS URL after creating the service; copy the origin only, such as `https://paperdesk-api.onrender.com`.

6. **Set the frontend API URL.** In GitLab, open **Settings** → **CI/CD** → **Variables** and add `VITE_API_URL` with the Render API origin from step 5. This is a public URL, not a secret. Do not add `/api` to the end. The Pages pipeline rejects an empty value, a localhost URL, or a non-HTTPS URL.

7. **Run the first deployment.** Push/merge `main` to GitHub after Part D is authorized. The sync action copies it to GitLab, and the Pages pipeline builds the frontend. If GitLab only displays the unique domain after the first Pages deployment, return to Render and set `PAPERDESK_CORS_ORIGINS` to that exact HTTPS origin (no trailing slash), then redeploy before live testing. CORS accepts only the configured origin in production.

8. **Check the services.** Render's `/api/health` should report `storage.mode: neon-r2`, `storage.ready: true`, and `compilerReady: true`. GitLab Pages should show a successful deployment. Configure the live browser suite with `E2E_BASE_URL` set to the Pages URL and `E2E_API_URL` set to the Render origin.

## What can be reused

- Reuse the existing GitHub account/repository and the `skinrondic` GitLab namespace. The Pages project itself and its repository token are new.
- Reuse the existing Render account, but create a separate PaperDesk Render web service. Do not point the DocScanner service at this blueprint.
- Reuse the Neon and Cloudflare accounts. Create a separate Neon database project (or another fully isolated database with its own connection string) and a new private R2 bucket with a bucket-scoped token. Do not reuse the DocScanner bucket or connection string: PaperDesk stores a separate project table and artifact layout, and separate credentials simplify access control.
- The assistant provider account/key may be reused if desired; its key belongs only in Render's `ANTHROPIC_API_KEY` variable. It is optional.

## Limits and data behavior

The Render free service has a 512 MB memory limit, low CPU allocation, sleeps after inactivity, and has no persistent filesystem. PaperDesk therefore requires Neon and R2 to be configured before production starts. Native TeX compilation is limited to one job at a time, 120 seconds, 448 MB of compiler virtual address space, 10 MB of project source, and 50 MB per generated file. Large documents may exceed the free service limits; a paid Render instance may be needed.

There are no accounts or recovery flow yet. The browser creates a random workspace key and sends it with API requests; projects are scoped to that browser profile and the key is saved in browser storage. Clearing that browser's site data loses access to its server-side workspace. Browser storage remains the offline copy.

The R2 bucket is private and the browser never connects to it directly, so it does not need public access or a browser CORS policy. The API's `PAPERDESK_CORS_ORIGINS` setting controls browser access.
