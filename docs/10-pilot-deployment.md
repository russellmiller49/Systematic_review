# Pilot deployment runbook (Railway)

This runbook deploys Synthesis for a small, trusted test group using:

- one Railway Node service for Next.js and its API routes;
- one Railway PostgreSQL service;
- one persistent Railway volume for full-text PDFs;
- HTTPS on a Railway-provided domain;
- invitation-only signup after the initial owner is allowlisted.

This shape is intentional. AI extraction may hold a request open for several minutes, and the
current full-text storage driver writes to local disk. Keep the web service at one replica while
it uses a single attached volume.

## Live pilot

- URL: `https://synthesis-production-07a3.up.railway.app`
- Railway project: `synthesis-pilot`
- Web service: `synthesis`
- Region: US West
- AI: disabled until a provider API key is added
- Deployment source: local CLI upload; updates are not yet connected to a Git remote

## 1. Preflight

From the repository root:

```bash
npm ci
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

Never copy the local `.env` into Railway. Generate a new production `AUTH_SECRET`, use the
managed database reference, and add an AI key only if the pilot should exercise AI features.

## 2. Authenticate and provision

The CLI can be run without a global install:

```bash
npx -y @railway/cli@latest login
npx -y @railway/cli@latest init --name synthesis-pilot
npx -y @railway/cli@latest add --service synthesis
npx -y @railway/cli@latest add --database postgres
```

Set the web-service variables. Replace `owner@example.com` with the initial owner's real email.
The single quotes around the database reference prevent the local shell from expanding it.

```bash
npx -y @railway/cli@latest variable set \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  AUTH_TRUST_HOST=true \
  STORAGE_DIR=/data \
  PILOT_EMAIL_ALLOWLIST=owner@example.com \
  AI_PROVIDER=anthropic \
  --service synthesis --skip-deploys

openssl rand -base64 32 | \
  npx -y @railway/cli@latest variable set AUTH_SECRET --stdin \
    --service synthesis --skip-deploys
```

If AI is enabled, set exactly one provider key through stdin so it is not placed in shell
history. Otherwise leave all provider keys unset; the AI UI and endpoints remain disabled.

```bash
read -s ANTHROPIC_KEY
printf '%s' "$ANTHROPIC_KEY" | \
  npx -y @railway/cli@latest variable set ANTHROPIC_API_KEY --stdin \
    --service synthesis --skip-deploys
unset ANTHROPIC_KEY
```

Link the web service and attach its persistent file volume:

```bash
npx -y @railway/cli@latest service link synthesis
npx -y @railway/cli@latest volume add --mount-path /data
```

## 3. Deploy

```bash
npx -y @railway/cli@latest up --service synthesis
npx -y @railway/cli@latest domain --service synthesis
```

`railway.toml` makes every deployment run, in order:

1. `prisma migrate deploy`;
2. the idempotent production bootstrap for built-in risk-of-bias tools;
3. `next start`, with `/api/health` required to return `200` before traffic is switched.

Do **not** run `npm run db:seed` on the pilot database. That command is for the disposable local
demo and resets its target database.

## 4. Verify the live app

Replace the hostname below with the generated domain:

```bash
curl --fail --show-error https://YOUR-DOMAIN/api/health
curl --fail --show-error --head https://YOUR-DOMAIN/
```

Then complete this browser smoke test:

1. Register with the allowlisted owner email and a unique password of at least 10 characters.
2. Create the organization and pilot project.
3. Import a tiny citation file, create assignments, and make one screening decision.
4. Upload and reopen a small PDF to prove the `/data` volume is working.
5. On the organization dashboard, create a **Member / beta tester** invitation and copy the
   generated link.
6. Open the link in a private browser, create the tester account with the invited email, accept
   the invitation, create a project, and confirm the tester is that project's Owner.
7. In Project Settings, create a project invitation for another role and confirm that accepting
   it grants only the assigned project access.

## 5. Pilot operations

- Enable daily backups for both the PostgreSQL volume and the web-service file volume in each
  service's **Backups** tab. Take a manual backup before schema changes.
- Keep one web replica while using local-volume storage.
- Set a Railway usage limit/alert and review memory, CPU, disk, and egress after the first week.
- Use an organization invitation for independent beta testers who should create their own
  projects. Use a Project Settings invitation for collaborators joining a specific review.
  Both links are shown only once; share them privately.
- To disable new account creation after everyone has joined, keep `PILOT_EMAIL_ALLOWLIST` set to
  the owner's email and revoke unused organization and project invitations.
- Leave real patient data and other regulated data out of this pilot. This MVP has not been
  established as a HIPAA-compliant deployment.

## 6. Deploy updates and roll back

After the normal verification loop:

```bash
npx -y @railway/cli@latest up --service synthesis
```

If an application deploy is bad, use Railway's deployment history to redeploy the last healthy
image. If a migration changes data, restore the matching database and file-volume backups as a
pair; rolling back only the container does not reverse a database migration.
