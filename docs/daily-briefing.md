# Daily briefing (Today page)

Each morning, the first time the app opens after 5 am, the **Today** page lists at most three things to study (within a daily minute budget, 45 by default), and why. It ranks from three inputs:

- **Google Calendar**: exams, deadlines and classes in the next 14 days, from every calendar you show in Google Calendar.
- **Todoist**: tasks with a due date in the same window count as deadlines.
- **Your measured memory** of each topic (`src/core/retention.ts`, from quiz checks and practice, never from how sure you felt), projected to the exam day, plus recent confident misses (`src/core/calibration.ts`).

The ranking is plain code (`src/core/briefing.ts`). The cheap model slot only writes the short opening note; with no model configured a plain fallback note is used. Nothing is written to Google Calendar or Todoist unless you click **Add to Todoist** or **Block time** on an item.

## Connect Google Calendar (one time, about 5 minutes)

Socrates signs in with your own Google OAuth client, so no shared secret is shipped with the app.

1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project (any name, e.g. "Socrates").
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience): user type **External**, fill in the app name and your email.
4. **Audience**: click **Publish app** (to "In production"). You will see an "unverified app" warning when signing in, which is expected for a personal client. If you leave it in "Testing" instead, add your Google account as a test user, and note that Google expires the sign-in after 7 days in that mode.
5. **Clients → Create client**: application type **Desktop app**. Copy the client ID and client secret.
6. In Socrates: **Settings → Keys**, paste them into "Google OAuth client ID" and "Google OAuth client secret".
7. On the **Today** page click **Sign in with Google**. Your browser opens; approve the calendar access; come back to the app.

Scopes requested: your calendar list (read), events (read and write, used only by **Block time**), and your email address (to show which account is connected).

The refresh token is stored next to `auth.json` in `google-calendar.json` (file mode 0600, never synced). **Disconnect** on the Today page revokes it at Google and deletes the file.

## Connect Todoist

Todoist → Settings → Integrations → Developer → copy the API token, then paste it into **Settings → Keys → Todoist**. The free plan works. Study tasks are added to your Inbox.

## Matching events to your sessions

Each event's course is guessed from its title (a course code like `MATH201`, or the title without words like "lecture" or "exam"). Sessions whose title shares a word with the course are linked automatically. Use **Link sessions** next to an event to pick the right ones; the choice is remembered for every event of that course (`briefing/courses.json` in the data folder).

## Files

| Path (data folder) | What |
| --- | --- |
| `briefing/<YYYY-MM-DD>.json` | That day's briefing, so reopening the app shows the same one |
| `briefing/courses.json` | Your course → session links |
| `briefing/prefs.json` | Daily minute budget |
