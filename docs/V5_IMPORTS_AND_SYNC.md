# V5 — Imports, PDF and calendar sync: what's built, what's next

## Built in V5-C (deterministic, no AI, no network)

| Source | How | Notes |
|---|---|---|
| Pasted syllabus text | `src/import/syllabusParser.js` | Dated lines → items; weekday + time-range lines → weekly classes; course code/name from the header. Works with lists and tables pasted from Word / Google Docs (tab-separated cells). English, Chinese and Japanese date words and keywords. |
| CSV / TSV | `src/import/importModel.js` (`parseCsv`, `guessColumns`, `rowsFromCsv`) | Quoted fields, `""` escapes, BOM, `,` `;` or tab. Columns are guessed from headers (en/zh/ja) and can be changed. An "hours" column is converted to minutes. |
| `.ics` calendar | existing `calendarModel.parseIcsCalendar` → `rowsFromIcsEvents` | Coursework-looking events are ticked, others unticked. Repeating events are skipped (as in the Calendar page import). |

**Trust rules** (all asserted in `tests/import.test.js`):

* Lines without a date never become deadlines. Impossible dates (Feb 30) are ignored, never "fixed".
* Uncertain fields are flagged and **block the import** until the student edits them or presses *Looks right*:
  * `order`: `3/4` could be March 4 or 3 April. Pick the order once in the source step to settle it.
  * `year`: no year in the text and no term start given.
  * `multiDate`: a line with several dates (the last one is used).
  * `kind`: the type couldn't be told.
  * `title`: the line was only a date.
  * `date`: a CSV row with no date.
* Duplicates (same course, normalised title and date, already saved or earlier in the same import) are unticked and labelled.
* Past-dated items start unticked.
* "No class" days are recognised but never saved as tasks.
* Estimates are labelled starting points and editable. Imported tasks have no day until the student runs *Plan my deadlines*.

## PDF text extraction: investigated, recommended for V5.1

* **Text PDFs** (exported from Word/Docs, most syllabi): Mozilla's
  [`pdfjs-dist`](https://github.com/mozilla/pdf.js) can extract the text layer
  entirely in the browser.
  * Cost: about 1 MB of JavaScript plus a worker. It can be lazy-loaded only when a PDF is chosen, so nothing changes for anyone else.
  * Privacy: the file never leaves the device.
  * Reliability: line order is usually right for single-column documents. Multi-column layouts and tables can come out interleaved. That's acceptable, because every row still goes through the same review table.
  * Until then, the import screen tells students to open the PDF, select all the text and paste it.
* **Scanned / photographed PDFs** have no text layer. Reading them needs OCR. There are two options, and both are out of scope for a no-paid-AI release:
  * Tesseract.js in the browser: about 10 MB plus language data, slow on phones, and errors are likely on dates.
  * A paid vision/AI API. Costs would be roughly $0.001–0.01 per page, plus a privacy review (student documents would leave the device) and server-side entitlement checks.
  
  If added, it should be an **optional Pro capability** behind an Edge Function that checks the `subscriptions` row. Its results still go through the confirmation table.

## Google Calendar: a controlled later milestone (not promised in the UI)

`src/calendar/providers.js` already defines the provider boundary, with
Google marked "not configured", so no Connect button is shown. Suggested
order:

1. **Owner setup.**
   * A Google Cloud project, an OAuth consent screen (verification is needed for sensitive scopes), and a web client ID.
   * The token exchange happens in a Supabase Edge Function. The client secret lives there, never in the frontend.
2. **Read-only import** (`calendar.readonly`):
   * Show the student's Google events as fixed, busy time in the planner.
   * Store the provider event id to prevent duplicates.
   * Re-sync on open, never on a timer at first.
3. **One-way export** (`calendar.events` on a dedicated "Student Scheduler" calendar the app creates):
   * Write study blocks there only, never to the primary calendar.
   * Update and delete only events the app created (by stored id).
4. **Two-way sync** only after a conflict model exists and is tested. Open questions include what wins when a block is moved in both places, and how deletions propagate.

   Until all of that ships and is tested, the product must not claim "sync". The landing page and Pro plan say "Calendar sync (planned)".

Risks: Google's OAuth verification timeline, token refresh and revocation
handling, rate limits, time zones on all-day events, and recurring-event
exceptions.
