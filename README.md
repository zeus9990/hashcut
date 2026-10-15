# Team Tasks

A small task manager for your organisation, running entirely on Cloudflare (Workers + D1, free tier is enough).

- Members sign in with a username and password and see their own tasks. Each task has three states: **To do**, **In progress** and **Done**, changed with one tap.
- **Priority:** admins can mark a task as priority. It shows a pulsing red tag and is pinned to the top of the person's list under "Priority - do these first". The WhatsApp message also says it is a priority.
- **Blockers:** a person can tap "Report a blocker" on a task and describe what is holding it up. Admins see a "Blocked" tag, the note, who wrote it and when, plus an alert strip on All tasks. Anyone involved can mark it resolved.
- Admins get **My tasks** (a private to-do list of their own), **All tasks** (filter by team, person, priority or blocked; see who is working on what; assign, edit, delete), **People** (add accounts, WhatsApp numbers, reset passwords, deactivate or delete) and **Teams** (add, rename, delete).
- After assigning a task, admins get a **WhatsApp** button per person that opens WhatsApp with the message ready to send. Open tasks in All tasks also have a WhatsApp reminder button (it switches to a "how can I help" message when the task is blocked). It uses your normal WhatsApp, so it is free; you press send yourself.
- Admins do not belong to a team and cannot be assigned tasks.
- Animated background, completion ring, count-up numbers, entrance animations and a confetti burst when a task is finished. Animations switch off for people who have "reduce motion" turned on.
- Works on phones and desktops (bottom navigation and bottom-sheet dialogs on mobile) with a sun/moon night-mode switch.

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

## Updating an existing deployment

Push the new code, then run each migration you have not run yet, in order, once each in the D1 console
(Storage & Databases > D1 > team-tasks-db > Console), or from VS Code:

```bash
npx wrangler d1 execute team-tasks-db --remote --file=migrations/004_priority_and_blockers.sql
```

1. `migrations/002_teams.sql` - the Teams list.
2. `migrations/003_in_progress_and_phone.sql` - the In progress status and WhatsApp numbers. Existing tasks are kept.
3. `migrations/004_priority_and_blockers.sql` - priority tags and blocker notes. Existing tasks are kept.

The files contain no comments, so you can paste them straight into the console. If the console rejects several statements
at once, run them one at a time in order. Run the migration before opening the new version of the site.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # contains SETUP_KEY for local use
npm run db:local
npm run dev
```

## Customise

- Organisation name: top of `public/app.js` (`ORG`). Team names are managed in the app under **Teams**.
- Colours and fonts: `public/style.css` (variables at the top).
- Session length and login rate limit: top of `src/worker.js`.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 and a per-user salt; they are never stored in plain text.
- Sessions are random tokens in an HttpOnly, Secure, SameSite=Strict cookie; only a hash of the token is stored. Resetting a password or deactivating someone signs them out everywhere.
- Every admin action is checked on the server, not just hidden in the interface.
- Login is rate limited (8 failed attempts per username and IP per 15 minutes).
- Responses carry a strict Content-Security-Policy (`public/_headers`).
- For extra protection, add Cloudflare Access or a WAF rate-limiting rule in front of the site.
