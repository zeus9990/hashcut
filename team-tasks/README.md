# Team Tasks

A small task manager for your organisation, running entirely on Cloudflare (Workers + D1, free tier is enough).

- Members sign in with a username and password, see their tasks grouped by urgency (Overdue / Today / Next 7 days / Later), and tick tasks done or not done.
- Admins get:
  - **My tasks**: their own private to-do list (**Add my task**). These notes are never shown to members or in All tasks.
  - **All tasks**: filter by team or person, assign, edit, delete. Only team members can be assigned tasks, never admins.
  - **People**: add accounts, reset passwords, edit, **Deactivate / Reactivate**, and **Delete**.
  - **Teams**: add, rename or delete teams. Renaming updates everyone in the team. Admins do not belong to a team.
  - **Settings**: change the organisation name and upload a logo (shown in the header, on the sign-in page, and as the browser tab icon).
- Everyone, including admins, can switch between day and night mode. The choice is remembered per browser, and the first visit follows the device setting.
- Assigning a task to several people (or a whole team) creates one task per person, each with its own done status.

### Deactivate vs Delete

- **Deactivate** blocks sign-in and signs the person out everywhere, but keeps their tasks and history. You can reactivate them at any time.
- **Delete** only appears once an account is deactivated. It removes the person **and all of their tasks** permanently.

## Deploy (about 10 minutes)

You need Node.js 18+ and a free Cloudflare account.

```bash
npm install
npx wrangler login

# 1. Create the database, then copy the printed database_id into wrangler.jsonc
npx wrangler d1 create team-tasks-db

# 2. Create the tables
npm run db:remote

# 3. Deploy
npm run deploy

# 4. Set the one-time setup key (choose any long random string)
npx wrangler secret put SETUP_KEY
```

Open the URL Wrangler prints (`https://team-tasks.<your-subdomain>.workers.dev`). The first visit shows **Create the first admin**; enter your SETUP_KEY and your details. After that, use **People > Add person** to create accounts for everyone and share their passwords privately.

You can attach your own domain under Workers & Pages > team-tasks > Settings > Domains & Routes.

## Updating an existing install

If you deployed an earlier version, copy the new files over your project and run:

```bash
npm run db:remote   # safe to repeat: adds the new tables, keeps all your data
npm run deploy
```

Team names already used by your people are turned into teams automatically. For local testing run `npm run db:local` instead, then `npm run dev`.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # contains SETUP_KEY for local use
npm run db:local
npm run dev
```

## Customise

- Organisation name and logo: the **Settings** tab in the app (no code change needed). Teams: the **Teams** tab.
- Colours and fonts: `public/style.css` (variables at the top; night mode colours are in the `data-theme='dark'` block).
- Session length and login rate limit: top of `src/worker.js`.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 and a per-user salt; they are never stored in plain text.
- Sessions are random tokens in an HttpOnly, Secure, SameSite=Strict cookie; only a hash of the token is stored. Resetting a password or deactivating someone signs them out everywhere.
- Every admin action is checked on the server, not just hidden in the interface. Logos are limited to PNG, JPEG or WebP (no SVG) and are size-checked on the server.
- Login is rate limited (8 failed attempts per username and IP per 15 minutes).
- Responses carry a strict Content-Security-Policy (`public/_headers`).
- For extra protection, add Cloudflare Access or a WAF rate-limiting rule in front of the site.
