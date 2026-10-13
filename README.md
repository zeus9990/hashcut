# Team Tasks

A small task manager for your organisation, running entirely on Cloudflare (Workers + D1, free tier is enough).

- Members sign in with a username and password, see their tasks grouped by urgency (Overdue / Today / Next 7 days / Later), and tick tasks done or not done.
- Admins get **All tasks** (filter by team or person, assign, edit, delete) and **People** (add accounts, set team, reset passwords, deactivate).
- Assigning a task to several people (or a whole team) creates one task per person, each with its own done status.

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

## Run locally

```bash
cp .dev.vars.example .dev.vars   # contains SETUP_KEY for local use
npm run db:local
npm run dev
```

## Customise

- Organisation name and suggested team names: top of `public/app.js` (`ORG`, `DEFAULT_TEAMS`).
- Colours and fonts: `public/style.css` (variables at the top).
- Session length and login rate limit: top of `src/worker.js`.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 and a per-user salt; they are never stored in plain text.
- Sessions are random tokens in an HttpOnly, Secure, SameSite=Strict cookie; only a hash of the token is stored. Resetting a password or deactivating someone signs them out everywhere.
- Every admin action is checked on the server, not just hidden in the interface.
- Login is rate limited (8 failed attempts per username and IP per 15 minutes).
- Responses carry a strict Content-Security-Policy (`public/_headers`).
- For extra protection, add Cloudflare Access or a WAF rate-limiting rule in front of the site.
