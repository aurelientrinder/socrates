# Daily briefing (Today page)

Each morning, the first time the app opens after 5 am, the **Today** page lists at most three things to study (within a daily minute budget, 45 by default), and why. It ranks from three inputs:

- **Google Calendar**: exams in the next 5 weeks, deadlines in the next 14 days and classes this week, from every calendar you show in Google Calendar.
- **Todoist**: tasks with a due date in the same window count as deadlines.
- **Your measured memory** of each topic (`src/core/retention.ts`, from quiz checks and practice, never from how sure you felt), projected to the exam day, plus recent confident misses (`src/core/calibration.ts`).

The ranking is plain code (`src/core/briefing.ts`, `src/core/study-plan.ts`). The cheap model slot only writes the short opening note; with no model configured a plain fallback note is used. Nothing is written to Google Calendar or Todoist unless you click **Add to Todoist** or **Block time** on an item.

## The study plan

Under today's list, the **Study plan** card shows what the app has planned up to each exam, built on its own from your calendar and your measured memory. Today's list is simply the plan's first day.

- **Before an exam**, each linked topic is simulated forward with the same memory model as Progress. It gets a review on the last day before its predicted recall would drop under 90%, so it is still above that on the exam day. Topics you have missed before (or missed while feeling sure) are simulated as shaky and come back more often.
- **Solid-looking topics** that have not been tested for two weeks get one quick check in the last week instead of being trusted.
- **An exam with nothing studied** gets "New material" sessions spread from today up to the day (up to six). An exam with studied topics gets an **exam rehearsal** two days before: exam-style problems with a scenario and several questions, no hints, graded at the end.
- **Tough classes**: a course whose recall averages under 80%, where a quarter or more of reviews slipped, or with a recent confident miss, gets a 10-minute **class prep** on the day of each of its classes this week, on its weakest topics.
- Topics due with no exam attached keep their normal review day.
- Each day stays inside your daily minutes (and at most three sessions). Work that does not fit rolls to the next day; work that cannot fit before its exam is shown on the exam ("Tight") with the minutes missing, so you can raise the daily time.

Each exam row shows its sessions, and recall on the day as things stand versus if you follow the plan.

**It adapts.** The plan is rebuilt every morning from your latest answers, so a topic you miss comes back sooner and one that holds up drops out. The card says what changed since the last plan: planned sessions you did or skipped (skipped ones are spread over the next days), topics that slipped, new exams on your calendar, and reviews dropped because your answers held up. The opening note mentions the most important change.

A session planned for a later day can be done early with **Do now**.

## Connect Google Calendar (one time, about 5 minutes)

Socrates signs in with your own Google OAuth client, so no shared secret is shipped with the app.

1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project (any name, e.g. "Socrates").
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience): user type **External**, fill in the app name and your email.
4. **Audience**: click **Publish app** (to "In production"). You will see an "unverified app" warning when signing in, which is expected for a personal client. If you leave it in "Testing" instead, add your Google account as a test user, and note that Google expires the sign-in after 7 days in that mode.
5. **Clients → Create client**: application type **Desktop app**. Copy the client ID and client secret.
6. In Socrates: **Settings → Keys**, paste them into "Google OAuth client ID" and "Google OAuth client secret".
7. On the **Today** page click **Sign in with Google**. Your browser opens; approve the calendar access; come back to the app.

Scopes requested: your calendar list (read), events on any calendar (read only), the ability to create and write to calendars **Socrates itself made** (nothing else), and your email address (to show which account is connected).

**The "Socrates" calendar.** The first time you click **Block time** (or sync reminders), Socrates creates a calendar named "Socrates" and writes there; your class calendar is never written to. Socrates reads the Socrates calendar back too, so its own study blocks count as busy time when it looks for a free slot. If you signed in before this change, Today shows a one-time **Reconnect** button (reading keeps working until then). If you already made a calendar called "Socrates" by hand, Socrates uses it only if it can write there; otherwise it creates "Socrates (app)".

The refresh token is stored next to `auth.json` in `google-calendar.json` (file mode 0600, never synced). **Disconnect** on the Today page revokes it at Google and deletes the file.

## Connect Todoist

Todoist → Settings → Integrations → Developer → copy the API token, then paste it into **Settings → Keys → Todoist**. The free plan works. Study tasks are added to your Inbox.

## Matching events to your sessions

Each event's course is guessed from its title (a course code like `MATH201`, or the title without words like "lecture" or "exam"). Sessions whose title shares a word with the course are linked automatically. Use **Link sessions** next to an event to pick the right ones; the choice is remembered for every event of that course (`briefing/courses.json` in the data folder).

## The class calendar

**Library → Calendar** shows eight weeks of your calendar as a week grid. Each event is **filed** under a course, marked **not a class**, or **needs a class** (dashed amber). The counter at the top reads "N of M filed", so you can see whether the classifier missed anything.

Click an event, or drag it onto a course in the left rail, to file it. "All N like this" files every event with that title (a repeating class or lab); "Only this one" files just that event (the right choice for an exam). Everything has **Undo**. Your choices are kept in `briefing/course-pins.json`, apart from the course groups, so reading the calendar again or changing a group never undoes them. The study plan and the briefing read a hand-filed exam as that course's exam the next time the briefing is made.

Without Google Calendar connected, the tab shows the events of today's briefing; with it, the events are read at most every ten minutes (or with the refresh button) and kept in `briefing/calendar-window.json`.

**Review.** The "N of M filed" counter opens a review of everything the classifier did: events that need a class (with the class they look like), events set aside as not a class (with the reason: you marked it, you dismissed its course, all-day, or it looks like gym or lunch) and events filed automatically (with the class they went to). Each row has a menu to correct it, and everything has Undo.

**Merging courses.** If the classifier split one course in two, drag one class in the rail onto the other (or use "Merge into…" on its card in Library → Courses). Notes and sessions are combined, the target keeps its name, and the merged course's name stays as an alias of the target, so reading the calendar again never splits them. Events you filed by hand move too. Undo puts both back exactly as they were.

## Classes across the app

A class owns its sessions (confirmed chats and imported notes files), so anything that knows a session knows its class. On **Progress → Map**, the class chips at the top left show one class and what it connects to: its own nodes plus whatever they link to in other classes (two hops, through the implication nodes). Connections across classes are never cut off, and "All classes" shows the whole map. Class colours are the calendar's, so a class has the same colour everywhere (`/api/courses/lens`).

## Files

| Path (data folder) | What |
| --- | --- |
| `briefing/<YYYY-MM-DD>.json` | That day's briefing, so reopening the app shows the same one |
| `briefing/courses.json` | Your course groups: sessions, notes, calendar aliases |
| `briefing/course-pins.json` | Calendar events you filed by hand (or marked "not a class") |
| `briefing/calendar-window.json` | The last eight weeks of calendar events read for the Calendar tab |
| `briefing/prefs.json` | Daily minute budget |
| `briefing/socrates-calendar.json` | The id of the calendar Socrates made for itself |
| `briefing/plan-history.json` | The study plan as it stood on the last 14 days, to say what changed |
