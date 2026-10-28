# Your data

Everything you build in Socrates is plain JSON in the app's data folder.

- **Daily snapshot.** The first time you open Today each day, Socrates copies your sessions, knowledge map, flashcards, mock exams, course links, settings and history into `backups/<date>/` and keeps the last five. API keys and Google tokens are not copied.
- **Export.** Settings → General → Export downloads the same data as one JSON file (`/api/export`). Keys, tokens and notes originals are left out.
- **Restore.** Quit the app, copy the folders from a snapshot back into the data folder, start the app.
- **History outlives sessions.** What each session proved about your memory (graded answers, confidence, message times) is kept in `digests/`. Deleting a session with that box unchecked keeps that history, so your review schedule and calibration do not forget it; deleting it with "Also remove its graph traces" checked erases it as well. The digests also make Today, Progress and Calibration fast: only a session that changed since its digest is re-read. Deleting `digests/` is safe while the sessions exist; they are rebuilt.
- **Crash safety.** Sessions, jobs, settings and the map's bookkeeping files are written to a temporary file and renamed into place, so a crash leaves the old file or the whole new one.
