# Team Tasks

A small task manager for your organisation, running entirely on Cloudflare (Workers + D1, free tier is enough).

- Members sign in with a username and password and see their own tasks. Each task has three states: **To do**, **In progress** and **Done**, changed with one tap.
- **Priority levels:** admins can mark a task as **1st, 2nd or 3rd priority**. Each level has its own coloured tag (1st pulses red), and priority tasks are pinned to the top of the person's list in that order. The WhatsApp message names the level. Admins can filter All tasks by level.
- **Repeating tasks:** admins can make a task repeat **every day, every weekday (Mon-Fri) or every week**, with an optional due time. A fresh copy appears in the person's list automatically each time it is due, tagged "Daily" / "Weekdays" / "Weekly". The **Repeating** tab lists every schedule with Edit, Pause/Resume and Delete. Copies already created are kept if a schedule is deleted.
- **Sheets & materials:** every person (members and admins) has a **Sheets** tab to save the links they work with: Google Sheets, Excel online / SharePoint, Drive folders, docs. Each link has a name, optional group and note; you can pin favourites, search, filter by group, copy the link and open it in one tap. Links are private to each person. Excel files themselves are not uploaded; the link to them is saved.
- **Profile photos:** anyone can add or change their photo from the avatar menu (it is shrunk to a small square in the browser before upload). Admins can remove anyone's photo.
- **Blockers:** a person can tap "Report a blocker" on a task and describe what is holding it up. Admins see a "Blocked" tag, the note, who wrote it and when, plus an alert strip on All tasks. Anyone involved can mark it resolved.
- Admins get **My tasks** (a private to-do list of their own), **All tasks** (filter by team, person, priority or blocked; see who is working on what; assign, edit, delete), **People** (add accounts, WhatsApp numbers, reset passwords, deactivate or delete) and **Teams** (add, rename, delete).
- After assigning a task, admins get a **WhatsApp** button per person that opens WhatsApp with the message ready to send. Open tasks in All tasks also have a WhatsApp reminder button (it switches to a "how can I help" message when the task is blocked). It uses your normal WhatsApp, so it is free; you press send yourself.
- Admins do not belong to a team and cannot be assigned tasks.
- **Live updates:** changes appear on everyone's screen within about a second, with no refresh. A member starts a task and the admin sees it; an admin assigns a task and the member sees it, with a short toast and a brief highlight. A small "Live" light in the header shows the connection is on.
- Night mode is the default (anyone can switch to day mode and it is remembered).
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

## Repeating tasks, time zone and the scheduled job

A scheduled job runs every 30 minutes (`triggers.crons` in `wrangler.jsonc`) and creates the day's copies of any repeating tasks that are due.
It is also checked whenever a task list is loaded, so nothing is missed if the job is delayed. Each schedule creates at most one copy per day.

"Today" and due times follow one organisation-wide time zone, set by `TIMEZONE` in `wrangler.jsonc` (default `Asia/Kolkata`).
Change it to any IANA name, for example `Europe/London` or `America/New_York`, and redeploy. A schedule created after its due time for the day starts the next day.

## How live updates work

Each signed-in browser keeps a small WebSocket connection to one Cloudflare Durable Object (`Realtime` in `src/worker.js`).
When something changes, the server sends only a tiny "something changed" signal, optionally with a short message, to the
people who should hear about it (the assignee and admins). Each browser then re-fetches its own data through the normal,
permission-checked API, so nobody can see tasks they are not allowed to see. The object uses WebSocket Hibernation: the
connections stay open while it sleeps, so an idle team uses almost no compute. Deactivating a person, resetting a
password or changing someone's role closes their connection and signs them out.

It runs on the Workers Free plan (Durable Objects are limited to SQLite-backed ones there). No SQL migration is needed:
`wrangler.jsonc` declares the object and the deploy creates it. If you merge `wrangler.jsonc` by hand, keep these two blocks:

```jsonc
"durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "Realtime" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Realtime"] }],
```

## Updating an existing deployment

**Run the new migration first, then push the code.** Migrations only add tables and columns, so the older version of the site keeps working in between.
Run each migration you have not run yet, in order, once each in the D1 console (Storage & Databases > D1 > team-tasks-db > Console), or from VS Code:

```bash
npx wrangler d1 execute team-tasks-db --remote --file=migrations/005_repeating_sheets_photos.sql
```

1. `migrations/002_teams.sql` - the Teams list.
2. `migrations/003_in_progress_and_phone.sql` - the In progress status and WhatsApp numbers.
3. `migrations/004_priority_and_blockers.sql` - priority tags and blocker notes.
4. `migrations/005_repeating_sheets_photos.sql` - repeating tasks, saved sheets and profile photos.

Existing tasks are kept. Tasks you already marked "priority" become **1st priority**.
The files contain no comments, so you can paste them straight into the console. If the console rejects several statements at once, run them one at a time in order.

If you merge `wrangler.jsonc` by hand (keep your own `database_id`), make sure it contains:

```jsonc
"vars": { "TIMEZONE": "Asia/Kolkata" },
"triggers": { "crons": ["*/30 * * * *"] },
"durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "Realtime" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Realtime"] }],
```

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
- Responses carry a strict Content-Security-Policy (`public/_headers`). It allows `wss:` connections so live updates work in every browser.
- The live connection checks the session cookie and the site's origin before it opens.
- For extra protection, add Cloudflare Access or a WAF rate-limiting rule in front of the site.
