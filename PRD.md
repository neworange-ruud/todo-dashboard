# Task Desk — Product Requirements

> Status: requirements drafting. Owner: Ruud van Falier.
> Design document v0.1 (11 Sep 2026) and the Paper file *Daybook — UX/UI Proposal* (Paper file, pre-rename) are the
> visual source of truth. This document is the build contract.

---

## 1. Premise

Linear knows what has to be done. Outlook knows where the time goes. Neither knows about the
other, and neither can tell you what a meeting is actually *about*.

Task Desk does not replace either. It is a **reading surface** that sits on top of them and does
two things they cannot do alone:

1. **Composes** the two sources into a single answer about today.
2. **Enriches** any item you point at with the surrounding context — the last conversation, the
   account status, the open threads — pulled live from Omni.

### The three questions

| Horizon | Question | Answered as |
|---|---|---|
| Today | What do I work on today? | An opinion, not a dump. One sentence, then the shape of the day, then five ranked things with reasons. |
| This week | What is expected of me? | Load and commitment — where the week is heavy, what is due, what is already slipping, what still needs planning. |
| This month | What am I actually for? | A short set of goals with honest, derived progress. |

### What it is not

Not a task manager. Not an inbox. Nothing is editable, assignable, schedulable or repliable.
Every action lands you in Linear or Outlook, where it belongs. The restraint is deliberate: a
read-only surface can be dense with insight without ever being anxious, because there is nothing
on it you can forget to do.

---

## 2. Principles

Six rules that settle arguments later. When two designs are both reasonable, the one that
honours more of these wins.

1. **Calm surface, depth on demand.** The landing view is quiet and under-populated by design.
   Everything dense lives one tap behind it. If the first screen feels busy, something has been
   promoted that should have stayed in a drill-in.
2. **The drill-in is the product.** Composing a calendar and a task list is table stakes. The
   reason to open Task Desk instead of Linear is that pointing at any item summons what surrounds
   it. Design and engineering effort is spent here first.
3. **Have an opinion, then show your work.** Never a flat list where a ranked one is possible,
   and never a ranking without the reason beside it. An unexplained order cannot be trusted or
   corrected.
4. **Read-only, always escapable.** Every item has exactly one action: open it where it lives.
   No verb on this surface ever changes data.
5. **Never lie about state.** Fetching, stale, failed and empty are four different things and
   must look like four different things. Silence is never an acceptable rendering of "we do not
   know yet".
6. **One layout, three sizes.** Identical content and hierarchy on phone, desktop and wall
   monitor. Only the column count changes. No feature exists on one form factor and not another.

---

## 3. Anatomy

Five zones, in priority order. Stacked on phone, unfolded into columns as width allows.

| # | Zone | Content |
|---|---|---|
| 0 | Bar | Date, last-synced marker, manual refresh. Persistent, quiet, 40px. |
| 1 | Attention | Conditional strip. Absent on a normal day — and most days are normal. See §9. |
| 2 | Sentence | The written description of today, with live entities. Largest type on the page. |
| 3 | Today | Timeline of meetings left, ranked top five right. |
| 4 | Week | Load per day, what is due, what needs planning. |
| 5 | Month | Goals with derived progress. |

### Mobile — 390×844, the primary target

Zones stack in priority order. Today / Week / Month become a sticky segmented switcher rather
than three scrolls, because the sentence plus one horizon is already a full screen. The switcher
is the only navigation in the product.

### Desktop — 1440×900 and up

The switcher dissolves. The sentence runs full width; the three horizons sit side by side,
weighted 1.2 / 0.9 / 0.9. Today earns the extra width because it carries two sub-columns.

### Wall monitor — 1440×720, always on

The desktop layout, not a separate mode. The 720px height is the real constraint — roughly half
a normal viewport, so the page must fit without scrolling. Three tunings only:

- Sentence caps at two lines and truncates with a "more" affordance; the timeline shows **now
  onward only**; each horizon column shows its top three and the rest is a count.
- Type goes up one step, not three. Base 17px rather than 15px.
- It re-reads itself: the sentence re-renders as the day progresses. Same component, different
  input.

**Accepted trade-off.** One responsive layout is the simplest thing to build and keeps all three
screens in sync forever. The cost is that the wall monitor will never be as glanceable as a
purpose-built board, and the phone will scroll more than a phone-native design would.

**Adopted (round 3):** the wall monitor is selected by an explicit **`?display=board`** query flag
rather than inferred from viewport size. It changes only the tunings above — never the markup, the
components or the data. Full specification in §17.13.

---

## 4. The daily sentence

The most important component, and the one most likely to be got wrong. It is the difference
between a dashboard and something that feels written for you this morning.

### Voice

Warm and narrative; not factual, not chirpy. It reads like a capable colleague who looked at
your day before you did and told you the truth about it in two or three sentences. It
characterises the day, names the constraint, and points at one thing.

**Right:** "Today is a meeting day. Your only real block is 14:00–16:00 — spend it on the Acme
migration and nothing else. Two people are waiting on it."

**Wrong:** "Good morning! You have 4 meetings and 3 tasks due today. You've got this — let's
make it a productive one! 💪" — restates the data below it, adds no judgement, performs
enthusiasm. Delete on sight.

### Live entities

Any noun the sentence mentions that exists as an object links into its own drill-in. Rendered as
ink-coloured text with a 40%-opacity accent underline — visible as interactive, never a field of
blue.

| Entity | Target |
|---|---|
| Meeting | Meeting drill-in |
| Issue / project | Issue or project drill-in |
| Person | Person view: shared meetings, shared issues, last contact |
| Time range | Scrolls and highlights that band in the timeline. No panel. |
| Account | CRM account drill-in |

### Time of day

| Window | What the sentence does | Example opening |
|---|---|---|
| Before 11:00 | Frames the day, commits to one recommendation | "Today is a meeting day…" |
| 11:00–15:00 | Reports what is left and what has moved | "Two meetings down. The block you protected starts in 40 minutes…" |
| After 16:00 | Closes the day, hands one thing to tomorrow | "That is the last meeting. One thing did not move today — ACME-214…" |
| Nothing scheduled | Names the freedom, points at week or month | "Nothing on the calendar. A rare one — the month needs…" |

### Rules

- Two to three sentences. Hard cap ~50 words; the wall monitor caps at two lines.
- It **may** deliver bad news — overbooking, a slip, a conflict — but as one clause, plainly.
  Anything needing more than a clause escalates to the attention strip (§9) and is referred to,
  not explained, here.
- It never restates a number the reader can count below it.
- It never uses the reader's name, never greets, never encourages.
- It never recommends an Inbox-state item (see §6) — unvalidated machine output must not be the
  thing the product tells you to do.
- It regenerates on sync, but only animates when the text has actually changed.

---

## 5. Today

Meetings left as a vertical timeline, tasks right as a ranked list. Two columns on desktop; on
mobile the timeline comes first.

### Proportional time, compressed gaps

Occupied time is drawn to scale, so a three-hour workshop looks like a wall and a fifteen-minute
standup looks like a pebble. Empty time is **not** to scale — it collapses into a labelled band
of fixed height (`2H 15M FREE`). This is what makes the timeline honest about load without
making an empty Thursday four screens tall.

| Context | Rule |
|---|---|
| Desktop | 1 min = 0.9px, clamped to 32px minimum per event. Gaps render as a 34px band. |
| Mobile | Proportion preserved, scale halves; gaps under 30 min absorbed into spacing, not labelled. |
| Wall monitor | Now onward only. Past events removed, not collapsed. |
| Day range | First event −30 min to last event +30 min. Never a fixed 09:00–18:00 frame. |

### Now

A live rule crosses the timeline at the current minute, labelled, in the critical hue — the one
place that colour appears without anything being wrong, because "now" is the only thing on
screen genuinely urgent by nature.

- The current meeting is **elevated**: raised surface, 2px left stripe, countdown `18 MIN LEFT`.
- In the last five minutes the countdown shifts to the critical hue. It never pulses or beeps.
- The view auto-scrolls to keep now in frame on load and on sync — never while you are
  scrolling, and never once you have scrolled away. A small `Now` button returns you.
- Past events dim to ink-3 and lose their subtitle. They stay visible on phone and desktop.

### Meeting card

Time, title, attendee count, location or platform, and — if any exist — a single marker that
related Linear issues are attached. Everything else is a drill-in. Conflicts draw side by side
with a shared warning stripe, never stacked or hidden.

---

## 6. Task states and the two lists

Task Desk reads exactly four Linear workflow states. They divide into **committed** work (which
answers *what do I do*) and **uncommitted** work (which answers *what have I not decided yet*).
These are two different questions and therefore two different lists.

| State | Meaning | Dated | Appears in |
|---|---|---|---|
| **In Progress** | Started, not done | yes | Top five, Due this week |
| **Planned** | Has a due date | yes | Top five, Due this week |
| **Ready** | Not planned yet | no | Needs planning |
| **Inbox** | New, machine-extracted from source data | no | Needs planning, marked `*NEW` |

### The top five

The direct answer to "what do I work on today". Five items, ranked, each with its reason on the
line below. Drawn **only** from In Progress + Planned — an item with no due date cannot generate
a trustworthy reason and would corrode the ranking.

**The reason line is not optional.** One clause in italic, secondary ink: *blocking Jorien · due
Friday · slipped twice*. This is the entire basis of trust in the ranking. An item that cannot
generate a reason belongs in the full list beneath, not in the five.

**Ranking inputs, in weight order:**

1. **Blocking** — someone else cannot proceed. Always outranks everything below.
2. **Due** — due today, then overdue, then due this week.
3. **Meeting-linked** — attached to a meeting today, especially one before the task's deadline.
4. **Slipping** — carried across two or more cycles. Surfaces because it otherwise never will.
5. **Fits the gap** — an estimate that fits the free time you actually have. A 15-minute review
   on a meeting day outranks a four-hour build.
6. **Priority** — Linear's own priority field. A tiebreaker, not a driver.
7. **Tiebreak** — at equal due date, In Progress beats Planned: started work carries context you
   would otherwise pay to rebuild.

Beneath the five: a collapsed row, `⌄ 20 more in progress or planned`. Opening it reveals the
full list grouped by status at full density — the one place on the landing view where density is
allowed, because you asked for it.

**Why five and not one.** A single "do this now" card is calmer and wrong for this week: some
days are all meetings, some are empty, some are ambushed by urgent work. On ambushed days a
single recommendation is stale within the hour and the product loses credibility. Five ranked
items degrade gracefully.

### Needs planning

Ready + Inbox, living in the **Week** zone beneath Due this week — because the week is where
planning actually happens, and uncommitted work is expectation not yet converted into
commitment. Expected volume 10–20 items, so the block is capped: three rows, then
`⌄ 13 more waiting to be planned`. Header carries named counts: `12 READY · 4 NEW`.

Inbox rows carry a `*NEW` marker in the trailing lane **and** a source affordance beneath the
title (`↗ Acme sync, 28 Aug`). Provenance matters more than novelty: these are the only items in
the product no human wrote.

An Inbox backlog never triggers the attention strip — §9 requires time-bound, and "nine things
uncaptured" is not.

### The dot: one device, two dimensions

- **Shape = state.** Filled = In Progress. Hollow = not started (Planned, Ready, Inbox).
- **Colour = urgency.** Critical / at-risk / ink-3, and only where there is no reason line beside
  it. In the top five the dots stay ink-grey, because the reason line already carries urgency in
  words and five coloured dots down the most important column buys nothing.

---

## 7. Week and month

### This week — load lanes, then commitments

Five rows, one per weekday. Each row is a single horizontal bar split into **booked** (accent)
and **free** (rule grey), with today's row marked. No grid, no event titles, no times — a 5-day
calendar grid at this size is unreadable and duplicates Outlook anyway. The question is "where
is my room", and a bar answers it in one glance.

- A day above roughly 70% booked draws its bar in the warning hue — the only colour in the zone.
- Tapping a day swaps the Today column to that day. This is the only way to look forward, and it
  is deliberately a small affordance.
- **Due this week** sits beneath: dated items only, **sorted soonest-first**, with a status dot
  (rust for overdue or slipping, ochre for due within two days, grey for later). Capped, with
  `⌄ 5 more due this week`.
- **Needs planning** sits beneath that (§6).

### This month — goals with honest progress

Three to five goals maximum. Each is a title, a percentage, and a 3px progress track. No cards,
no icons, no charts. More than five means the classification is wrong, not the design.

Progress is **derived, never hand-entered**: completed child issues over total, or milestones met
over milestones planned. Where a target date has passed with work outstanding, the track draws in
the critical hue and the percentage is followed by the days over.

**Linear classification.** Linear's existing hierarchy does this with no custom fields:

- **Issues** → tasks. Feed Today and Due this week. Need a due date and an estimate to rank well.
- **Projects with a target date in the current month** → monthly goals. Progress comes free from
  Linear's own project progress.
- **Project milestones due this month** → goals too, for long projects spanning several months.
  This is what stops a six-month project sitting at "September goal" four times in a row.
- **Initiatives** → ignored, or shown as faint parent context on a goal.

Discipline required: give every project a target date, and give long ones milestones. The
fallback is a `goal` label on a handful of issues — cheaper, but you lose automatic progress and
have to maintain the percentage by hand, which you will not do.

> **Open.** Milestone handling for month goals is not yet decided. Month can be built from
> projects alone and gain milestones later; a milestone is structurally a goal with a nearer date
> and the same derived progress.

---

## 8. The drill-in

Where the value is. Everything above exists to give you something to point at.

### Mechanics

| Context | Behaviour |
|---|---|
| Desktop | Panel slides in from the right, 480px, over a dimmed but still-visible dashboard. Context is never lost. |
| Mobile | Full-height sheet rises from the bottom, drag handle, a visible strip of dashboard above. |
| Wall monitor | Same as desktop. Panel takes a third of the width; columns do not reflow behind it. |
| Dismiss | Escape, backdrop click, swipe down, or the close control. All four, always. |
| URL | Every drill-in has its own address, so a panel survives a refresh and can be sent to yourself. |

### The trail

You can drill from a drill-in — meeting → the Linear issue it mentioned → that issue's project →
the account. Each hop pushes onto a stack within the same panel and leaves a breadcrumb:
`Acme sync › ACME-214 › Migration`. Back steps one level; any crumb jumps directly; close
dismisses the whole stack. **The panel never spawns a second panel.**

### Meeting drill-in — five blocks, fixed order

The order *is* the design: it runs from what you can verify instantly to what the AI had to go
and find.

| # | Block | Source | Arrives |
|---|---|---|---|
| 1 | **Attendees** — name, role, company, internal/external, last contact | Outlook + CRM | Instant |
| 2 | **Last time** — two or three sentences on the previous meeting with these people | Omni → notes / transcripts | ~2–4s |
| 3 | **Open action items** — related Linear issues, with owner and status | Linear | Fast |
| 4 | **Account status** — stage, open opportunities, last invoice, health | Brain CRM | ~1–3s |
| 5 | **Unresolved** — questions left open last time, anything promised and not delivered | Omni, synthesised | Slowest |

### Everything fetches at once, and says so

All five blocks lay out immediately as titled containers with skeletons. Each fills independently.
**Nothing reorders once placed** — a late block fills in where it always was, so the panel never
jumps under your eyes while you are reading.

Every block header carries its own state on the right: *Checking CRM…* in flight, a timing once
done, *Nothing found* if empty, *Could not reach CRM · Retry* if failed. One block failing never
blocks the others and never shows a whole-panel error.

### Output format

Structured sections with scannable headers, and prose *within* a section where prose is genuinely
better. "Last time" and "Unresolved" are paragraphs because their meaning lives in the connective
tissue; "Attendees" and "Action items" are rows because they are lists. Never a wall of bullets,
never an undifferentiated essay.

### Sourcing

Every AI-synthesised statement carries a source affordance beneath it — `↗ Meeting notes, 28 Aug`,
`↗ ACME-214` — in accent mono. Understated enough to ignore while reading, present enough to check
when a claim surprises you. Statements drawn from more than two sources show the count and expand
on tap.

If the model produced something it cannot source, it is marked *inferred* rather than dropped. A
visibly hedged guess is more useful than a confident invention and far more useful than silence.

### Other drill-in types

| Type | Contents |
|---|---|
| Issue | Description, status, cycle, assignee, blocking / blocked-by, recent comments, linked meetings past and upcoming, parent project. |
| Person | Role, shared upcoming meetings, shared open issues, last interaction, what you owe each other. |
| Account | CRM status, open opportunities and projects, contacts, meeting history, invoices. |
| Project / goal | Progress, milestones, contributing issues, target date, who else is on it. |

Every one ends with the same single action: **Open in Linear**, **Open in Outlook**, **Open in
Brain**. One button, bottom of the panel, always in the same place.

---

## 9. States

A dashboard is judged on its bad days. These are specified as carefully as the happy path because
you will see them more often.

### Needs attention

A conditional strip directly above the sentence — not a badge, not a count, not a red dot on an
icon. It appears only for things that are true, actionable and time-bound, and names them in full:

- An issue assigned to you has slipped two or more cycles
- You are double-booked in the next four hours
- Something you own is blocking someone else and is overdue
- A monthly goal's target date passes with work outstanding

Maximum three items; a fourth collapses into "and 2 more". Each is one line, rust left-stripe on a
raised surface, each a link into its drill-in. The strip is absent — **taking zero height, not
collapsed** — when nothing qualifies.

**No numeric badges anywhere in the product.** A count with no name is anxiety with no
information. (A count inside a named header — `DUE THIS WEEK · 9` — is fine.)

### Quiet and empty

| Situation | What the screen does |
|---|---|
| No meetings, nothing due | Sentence names it plainly — "Nothing on the calendar and nothing due. A rare one." Timeline column replaced by a single line of free time. Month goals move up. No illustration, no encouragement. |
| Everything done by 15:00 | Sentence closes the day and offers one look-ahead. Nothing is invented to fill space. |
| Meetings only, no tasks | Top-five column shows one line pointing at the next horizon rather than apologising. |
| Weekend / out of office | Sentence acknowledges it. Week and month remain; today collapses. |

Whitespace is an acceptable and intended outcome. An empty day should look like calm, not a
broken page.

### Sync, staleness, failure

| State | Behaviour |
|---|---|
| Last synced | Always visible in the bar, mono 11px: `↻ Synced 2m ago`. It is a button. |
| Refreshing | Glyph rotates once per second. Data on screen stays live and readable — never blanked, never skeletonised. Changed values cross-fade in place. |
| Stale > 15 min | Marker shifts to the warning hue. Nothing else changes. |
| Source down | Affected zone shows an inline line — "Linear unreachable · showing data from 08:12 · Retry" — and keeps rendering cached data behind it. Other zones untouched. |
| Offline | Everything renders from cache with a single bar-level notice. The product stays readable offline; it was never interactive anyway. |

### When the AI is wrong

It will be. Each synthesised block carries a quiet control in its header on hover or long-press:
**↻ Regenerate** and **⊘ Not right**. Dismissing hides that block for this item for the day and
records the item, the block and the output. That log is the only way the prompts ever improve, and
it costs the reader one tap.

Source links (§8) are the first line of defence: the fastest way to handle a wrong summary is to
make checking it take two seconds.

---

## 10. Visual system

Mood: **almanac** — newsprint, printer's ink, and the blue of a tide table.

### Palette — light

| Token | Hex | Role |
|---|---|---|
| `--color-paper` | `#F6F3EC` | Page ground |
| `--color-raised` | `#FCFAF5` | Cards, current meeting, panel |
| `--color-sunken` | `#EFEBE2` | Inset, inactive switcher |
| `--color-rule` | `#E2DCD1` | Structural rules, free time |
| `--color-rule-soft` | `#EDE8DE` | Row separators |
| `--color-ink` | `#1B1917` | Primary text |
| `--color-ink-2` | `#55504A` | Secondary, reason lines |
| `--color-ink-3` | `#8B857B` | Labels, past events, meta |
| `--color-accent` | `#1F4E5F` | Links, entities, booked time, progress |
| `--color-accent-soft` | `#E0EAEA` | Protected-block fill |

### Semantic — never decorative

| Token | Hex | Meaning |
|---|---|---|
| `--color-clear` | `#4A7355` | Done, on track, block resolved |
| `--color-risk` | `#9A6B1E` | Due soon, heavy day, stale sync |
| `--color-critical` | `#A2402D` | Overdue, blocking, conflict, and now |
| `--color-critical-soft` | `#F3E3DE` | Attention strip ground |

Colour carries meaning — but only these three, and only on state. Project and client identity is
**not** colour-coded: a rainbow of client colours would eat the calm and collide with the semantic
triad the moment a green client had a red issue. Clients are identified by name.

### Dark

Not an inversion. Ground goes to warm charcoal `#171613`, accent lifts to `#79B4B8` to survive the
dark ground, semantic triad desaturates and brightens. Follows the system by default; a manual
override is remembered. The wall monitor is the strongest argument for dark and the reason it must
be as considered as light.

### Type — two voices

The serif carries anything written **for** you — the sentence, drill-in titles, AI prose. The sans
carries anything read **from** a system. That split is the whole typographic idea and it does real
work: you can tell at a glance whether you are reading a fact or a judgement.

| Role | Spec |
|---|---|
| Daily sentence | Newsreader 300 · 28/38 |
| Drill-in title | Newsreader 400 · 20/26 |
| Meeting and task titles | IBM Plex Sans 500 · 15/18 (17 on wall monitor) |
| Body, attendees, summaries | IBM Plex Sans 400 · 13–15 |
| Reason line | IBM Plex Sans 400 italic · 13 · ink-2 |
| Meta, times, labels | IBM Plex Mono 400 · 11 · 0.1em, uppercase |

All times, counts, percentages and durations use `tabular-nums`.

### Surface and space

| Aspect | Rule |
|---|---|
| Elevation | Exactly two levels — paper and raised. **No shadows anywhere.** Separation is a 1px rule or a 2px left stripe. |
| Radius | 2px on interactive surfaces, 0 on structural. Nothing is a rounded card. |
| Stripes | A 2px left stripe is the single device for "this needs your eye" — current meeting, attention strip, source-failed notice. Nowhere else. |
| Spacing | 4px base. Zones separated by 32px and a hairline rule; within a zone, 8px. |
| Touch | 44px minimum on mobile, including timeline and list rows. |

---

## 11. Motion

Motion is where "crafted" lands, and it must never fight the calm — so it is orchestrated into a
few deliberate moments rather than sprinkled everywhere.

| Moment | Spec |
|---|---|
| **Open** | One staggered cascade, 60ms apart, 400ms each, 8px rise with fade: bar → attention → sentence → timeline → top five → week → month. ~700ms end to end. Once per session, not on every sync. |
| **Sentence** | When the text has genuinely changed, old fades out and new writes in word by word — ~28ms per word, 500ms total. The one indulgence, and it earns its place: it is what makes the thing feel written rather than assembled. |
| **Panel** | In over 280ms on `cubic-bezier(.22,.7,.3,1)`, backdrop dimming to 45% over the same interval. Content blocks stagger 40ms apart behind it. Out in 200ms — leaving is always faster than arriving. |
| **Arrival** | A resolving skeleton cross-fades to real content over 250ms with a 3px rise. Never a pop, never a layout jump — the container was already the right size. |

**Continuous motion.** Only two things move on their own: the now-line advances (1s transition on
each minute tick, so it glides rather than jumps) and the refresh glyph rotates while fetching.
The countdown re-renders without animating. Nothing pulses, breathes, shimmers or loops — on an
always-on monitor, ambient motion becomes a nervous tic within a day.

**Implementation.** anime.js, pinned, for the open cascade, panel choreography and word-by-word
sentence. Plain CSS transitions for everything single-property (hover, cross-fade, skeleton
resolve, dim) — do not route these through the library. `prefers-reduced-motion: reduce` collapses
every one of these to a 120ms opacity fade, and the sentence appears whole, never typed. Transform
and opacity only; nothing animates layout.

---

## 12. Implementation

### 12.1 Deployment model

- **Next.js** (App Router, Server Components by default; `'use client'` only where interactivity
  is required). Node.js runtime — this is a local server, not an edge deployment.
- **Runs locally on this Mac only.** Single user, single instance. No cloud hosting, no
  multi-tenancy, no public origin.
- **Exposed over Tailscale** for phone and wall-monitor access. The tailnet is the security
  boundary; there is no application-level login.
- Because it is local, the app can reach services on `localhost` that are not otherwise
  addressable — principally Omni.

### 12.2 Data sources

| Source | Route | Carries |
|---|---|---|
| **Linear** | **Direct API** — does *not* go through Omni | Issues, states, due dates, estimates, cycles, projects, milestones, blocking relations, comments |
| **Outlook Calendar** | Omni | Meetings, attendees, times, location/platform |
| **Outlook Mail** | Omni | Mail history for context and enrichment |
| **Fireflies** | Omni | Meeting transcripts and summaries |
| **Files** | Omni | Notes, presentations, documents |
| **Slack** | Omni | Message history |
| **Brain (CRM)** | TBD — see open questions | Accounts, contacts, opportunities, invoices |

**Omni** is the local context platform that aggregates all personal data behind one API. Linear is
the single exception and is integrated directly, because Task Desk needs live, structured,
write-accurate task state that a retrieval index cannot guarantee.

### 12.3 Verified local environment (11 Sep 2026)

Confirmed by inspection on this machine:

- Omni runs in Docker, fronted by Caddy at **`http://127.0.0.1:41435`**. `GET /api/v1/health`
  returns healthy with `postgres`, `redis`, `searcher`, `indexer`, `connector_manager` all `ok`.
- Running containers: `omni-web`, `omni-searcher`, `omni-indexer`, `omni-ai`,
  `omni-connector-manager`, `omni-sandbox`, `omni-postgres` (ParadeDB 0.24 / pg17, published on
  `127.0.0.1:55433`), `omni-redis`, `omni-caddy`, plus connectors:
  `omni-microsoft-connector`, `omni-fireflies-connector`, `omni-slack-connector`,
  `omni-github-connector`, `omni-atlassian-connector`.
- A separate `archive-postgres-1` (postgres 17.6) runs on `127.0.0.1:55432` — the New Orange
  canonical archive that mirrors normalized Omni records.
- Omni's documented public API surface is **`POST /api/v1/search`**, **`GET /api/v1/documents/{id}`**
  and **`GET /api/v1/health`**, with API keys scoped per user/admin and restrictable by source.
  No OpenAPI document is served.
- **Hermes** runs on this machine against the same Omni instance and is the reference for working
  endpoints and credentials (`~/.hermes`, `~/.config/buzz/hermes-agent.env`). Reading those
  credential files is currently blocked by the sandbox and needs explicit approval.

> **Material constraint** (resolved in §15 — calendar now reads Omni's Postgres directly).
> Omni's public API is a *retrieval* interface — search plus document
> fetch. The Today timeline needs *structured* calendar records (start, end, attendees, location,
> organiser) in deterministic order. A search endpoint cannot reliably answer "every event today,
> in order, with end times". Resolving this is open question 1.

### 12.4 AI

- **OpenAI** via a **custom gateway URL**, with a user-supplied API key. Standard OpenAI-compatible
  client pointed at the gateway base URL.
- Used for:
  - The daily sentence (§4).
  - The synthesised drill-in blocks — "Last time" and "Unresolved" (§8).
  - Personal touches beyond the above, to be specified.
- Every synthesised statement must carry a source affordance or be marked *inferred* (§8).
  Sourcing is a hard requirement, not a nicety — it is the mitigation for being wrong.

### 12.5 Secrets and configuration

- Linear API token: user-supplied.
- OpenAI API key and gateway base URL: user-supplied.
- Omni API key: to be obtained, or reused from Hermes.
- All held in `.env.local`, never committed. `.gitignore` already excludes it.

### 12.6 Non-goals for v1

- No authentication or user model.
- No write path to Linear, Outlook or Brain.
- No notifications, push, or email digests. The product is checked, not pushed.
- No mobile app — the phone target is the responsive web app over Tailscale.
- No multi-user, no hosting, no public deployment.

---

## 13. Open questions

Carried from the design document and still undecided:

| # | Question | Note |
|---|---|---|
| 1 | **The name** | *Task Desk* is a working title. Alternatives: *Clearing*, *Standing*, *Almanac*, *Ruud's Morning*. |
| 2 | **Goal authorship** | §7 derives month goals from Linear projects and milestones. If they should be hand-written instead, that is the one place a read-only product needs a write path. |
| 3 | **Estimates** | "Fits the gap" ranking depends on Linear estimates existing. If they mostly do not, that input silently does nothing. |
| 4 | **Yesterday** | Nothing looks backwards beyond the current day. A "what moved yesterday" line may be the cheapest way to make month goals feel real. Out of scope for v1. |
| 5 | **Triage** | Ready and Inbox both *want* a verb — plan this, accept this, bin this. The product has none, so both can only link into Linear. This is the second candidate write path after goal authorship, and the likelier of the two to become irritating. |
| 6 | **Cost of enrichment** | Fetching all five drill-in blocks on every open is the right experience and the expensive one. Fallback is blocks 1–3 eagerly, 4–5 behind one control — a change to timing, not layout. |

Implementation questions are resolved through the refinement rounds below and folded back into
§12 as they are answered.

---

## 14. Build order

From the design document, unchanged:

1. Confirm the palette direction and the name.
2. Audit the Linear board against §7 — target dates on projects, milestones on long ones,
   estimates on issues.
3. Build the mobile Today view against real data, with the sentence stubbed. It is the smallest
   thing that proves whether the premise holds.
4. Then build one meeting drill-in end to end. **If that does not feel remarkable, nothing else in
   here matters.**

---

## 15. Resolved architecture (refinement round 1)

### 15.1 Three data paths

| Path | Source | Transport |
|---|---|---|
| **A — Linear** | Issues, projects, milestones, cycles, states | Linear GraphQL API, direct. Fetched on request, cached. |
| **B — Calendar** | Outlook Calendar events | Direct read-only SQL against Omni's ParadeDB (`127.0.0.1:55433`). |
| **C — Everything else** | Outlook Mail, Fireflies transcripts, files/notes/presentations, Slack | Omni public API — `POST /api/v1/search`, `GET /api/v1/documents/{id}`. |

Omni is the source for everything that is **neither Linear nor Calendar**. Calendar is split out
because the timeline needs deterministic, ordered, structured records that a retrieval endpoint
cannot guarantee.

### 15.2 Freshness and caching

- **Fetch on request**, with a short-lived in-process cache. No database of our own.
- The app is a permanently running local server, so the in-process cache is effectively durable
  between restarts-in-practice; a restart simply re-warms it.
- **Nothing is ever written to Omni's Postgres or to `archive-postgres`.** Path B is strictly
  read-only, and should use a dedicated read-only Postgres role.

### 15.3 AI caching and scheduling

- **Drill-in blocks** ("Last time", "Unresolved") are cached keyed by their inputs — per meeting,
  per day.
- **The daily sentence** is generated on a schedule (roughly every 15 minutes, plus on each of the
  three time-window boundaries in §4) so it is always warm when the page opens, and regenerated
  when the underlying data hash changes.
- **Wall monitor** polls on an interval and re-renders. No SSE or websocket.

### 15.4 Time

- Timezone is fixed to **Europe/Amsterdam**. Not read from the client.

### 15.5 Calendar schema — verified

Omni stores every document in a single `documents` table:

```
documents(
  id CHAR(26), source_id CHAR(26), external_id VARCHAR(500),
  title TEXT, content_id CHAR(26) -> content_blobs, content (denormalized),
  url TEXT, metadata JSONB, attributes JSONB, permissions JSONB,
  created_at, updated_at, last_indexed_at
)
```

`attributes` is GIN-indexed and intended for structured, filterable data. The Microsoft connector
(`ms_connector/mappers.py :: map_event_to_document`) writes calendar events as:

| Field | Where it lands |
|---|---|
| `external_id` | `calendar:{user_id}:{event_id}` |
| `title` | Event subject |
| `attributes.source_type` | `"outlook_calendar"` |
| `attributes.organizer` | Organizer email, lowercased |
| `attributes.attendees[]` | Attendee emails, lowercased, sorted |
| `attributes.date` | Start date only, `YYYY-MM-DD` |
| `metadata.created_at` / `updated_at` | **Both set to the event start datetime** |
| `metadata.url` | Outlook `webLink` |
| `metadata.extra` | `event_id`, `is_all_day`, `is_cancelled` |
| `permissions.users` | Attendee emails |

> **⚠ Blocking gap.** **End time and location are not stored as structured fields.** They exist
> only as text lines inside the generated document content, in a fixed format:
> ```
> Event: {subject}
> Start: {iso} ({tz})
> End: {iso} ({tz})
> Location: {displayName}
> Organizer: {name} <{address}>
> Attendees: a@x, b@y
> ```
> §5 requires end times for proportional drawing, gap computation, the now-rule and the
> `18 MIN LEFT` countdown. Without them there is no timeline. See round 2, question 1.

The calendar syncer pulls a `calendarView` delta window of −`DEFAULT_MAX_AGE_DAYS` to
+`DEFAULT_FUTURE_MONTHS × 30` days, selecting `id, subject, body, start, end, location, organizer,
attendees, webLink, isAllDay, isCancelled` — so Graph is already returning everything needed; it is
only the mapper that drops it.

### 15.6 Note — Omni has a Linear connector

Omni ships a `connectors/linear` and Linear content may already be indexed. This does not change
path A: Task Desk needs live, structured, write-accurate task state for ranking, which an index
cannot guarantee. Omni's Linear content may still be useful as *narrative* context in drill-ins.

---

## 16. Linear board audit (11 Sep 2026, verified against the live API)

Team **RW — Ruud's Work**, the only team. Viewer confirmed as `ruud.vanfalier@neworange.agency`.
Assignees are not used, so all filtering is by team + state.

### 16.1 Workflow states — all nine

| Position | State | Linear type | Task Desk treatment |
|---|---|---|---|
| 0 | Backlog | `backlog` | **Excluded** — the deep pile |
| 1 | Ready | `unstarted` | Needs planning |
| 2 | In Progress | `started` | Top five, Due this week |
| 3 | Done | `completed` | Excluded |
| 4 | Canceled | `canceled` | Excluded |
| 5 | Duplicate | `duplicate` | **Excluded** |
| 1000 | Inbox | `backlog` | Needs planning, `*NEW` |
| 1001 | Planned | `unstarted` | Top five, Due this week |
| 1002 | **Waiting** | `started` | **Undecided** — not covered by the original model |

### 16.2 Actual volumes — materially smaller than estimated

22 open issues, excluding 55 sitting in `Duplicate`.

| State | Count | With due date |
|---|---|---|
| Planned | 7 | 7 |
| In Progress | 6 | 5 |
| Ready | 6 | 2 |
| Inbox | 2 | 0 |
| Waiting | 1 | 1 |

The earlier working estimate was 10–20 each. Reality is **13 dated items** feeding the top five
and **8 uncommitted items** in Needs planning. The caps designed for ~40 items (`⌄ 13 more waiting
to be planned`, `⌄ 20 more in progress or planned`) are wrong at this scale — both lists nearly fit
whole.

### 16.3 ⚠ Four of six ranking inputs are dead

| § 6 input | Board reality | Status |
|---|---|---|
| Blocking | **1 issue relation on the entire board** | Effectively dead |
| Due | 15 of 22 have due dates | **Works** |
| Meeting-linked | Derived by model matching | **Works** |
| Slipping | **Zero cycles exist** — "carried across two cycles" is undefined | Dead |
| Fits the gap | **Zero estimates** | Dead (dropped for v1) |
| Priority | **21 of 22 are P0 / unset** | Dead |
| In Progress tiebreak | — | **Works** |

This is the most consequential finding in the audit. §6 rests on "never present a ranking without
the reason beside it", and with only due dates surviving, every reason line degrades to *"due
Friday"* — which §6 itself names as the failure mode. Resolving this is round 3, question 1.

### 16.4 No projects, no cycles

`projects: 0`, `cycles: 0`, and **no open issue belongs to a project**.

§7 derives month goals entirely from *projects with a target date in the current month* and *project
milestones*. **The Month zone currently has nothing to render.** Round 3, question 2.

### 16.5 Labels carry provenance

Labels in use on open issues: `Email` (7), `Transcript` (6), plus six topic labels
(`Technische governance…`, `Technische richting en architectuur`, …).

`Email` and `Transcript` look like **origin markers on machine-extracted issues** — a structured
provenance signal that could feed the `↗ source` affordance on Inbox rows (§6) more cheaply and
more reliably than asking the model. Note they span states, so they mark origin, not state.

### 16.6 One issue is badly overdue

`RW-339` — *De Agentic Engineering-presentatie…* — is in **Ready** with a due date of
**2026-07-22**, i.e. 51 days overdue. This is simultaneously a good test of the attention strip
(§9) and a contradiction in the state model: Ready means "not planned yet", yet it carries a date.
Two of six Ready issues have due dates.

---

## 17. Resolved (refinement round 3) and verified environment

### 17.1 Name

**Task Desk.** Supersedes the *Daybook* working title. Open question 1 in §13 is closed.
The Paper file and the repo directory (`todo-dashboard`) still carry the old name.

### 17.2 Ranking — rebuilt around what the board actually has

Only **due date**, **meeting-linked** and the **In Progress tiebreak** survive as structured
inputs. Priority is retained as a weak tiebreaker (occasionally set — 1 of 22 today).

The reason line is preserved — the §6 promise — by **sourcing it from Omni context rather than
from Linear fields**. The model writes the clause from mail, transcripts and Slack: *"Marieke asked
for this on Tuesday"*, *"mentioned in yesterday's transcript"*, *"due Friday"*. Every such clause
carries a source affordance exactly as §8 requires.

**Ranking inputs, v1:**

1. **Overdue** — hardest weight. `RW-339` is 51 days over.
2. **Due** — today, then this week.
3. **Meeting-linked** — model-matched against today's calendar (round 2, answer 5d).
4. **Blocked** — the `Waiting` state means *blocked by someone else*. Surfaced in the five with a
   distinct reason line, because being blocked is precisely what you want to see.
5. **In Progress** beats Planned at equal due date.
6. **Priority** — weak tiebreaker only.

Dropped for v1: *slipping* (no cycles), *fits the gap* (no estimates).

### 17.3 State model — final

| Linear state | Type | Treatment |
|---|---|---|
| In Progress | started | Top five · Due this week · filled dot |
| **Waiting** | started | Top five, **blocked by someone else** · filled dot · distinct reason clause |
| Planned | unstarted | Top five · Due this week · hollow dot |
| Ready | unstarted | **Needs planning only** — a due date on a Ready issue does *not* promote it into Due this week. The state always wins. |
| Inbox | backlog | Needs planning, `*NEW` + source |
| Backlog, Done, Canceled, Duplicate | — | Excluded. `Duplicate` holds 55 issues and is pure noise. |

### 17.4 Month zone — cut from v1

No projects, no cycles, no milestones exist. §7's month goals and the §3 zone 5 are **out of scope
for v1**. Ship Today + Week. The zone returns if and when Linear projects with target dates exist.
On mobile the switcher drops to two segments.

### 17.5 Lists show everything

At 13 dated and 8 uncommitted items, the `⌄ N more` caps are removed. Both lists render whole.
The caps return only if volume grows past roughly 8 rows per list.

### 17.6 Provenance

The Linear labels **`Email`** (7 issues) and **`Transcript`** (6) are the `↗ source` signal on Inbox
rows — structured, free, and more reliable than asking the model.

### 17.7 Storage

In-process cache now. One **app-owned SQLite file** later, for exactly two things: warm restarts
and the §9 *"Not right"* feedback log. Never Omni's Postgres, never `archive-postgres`.

### 17.8 Microsoft Graph — verified working

A dedicated Entra app registration. `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_SECRET` in `.env`.
Client-credentials flow against `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope
`https://graph.microsoft.com/.default`.

**Verified 11 Sep 2026:** token issued, app roles `["Calendars.Read", "Calendars.Read.All"]`,
`appid` and `tid` match `.env`. `GET /v1.0/users/ruud.vanfalier@neworange.agency/calendarView`
returned 5 events for today with `start`, `end`, `location`, `attendees`, `organizer`, `isAllDay`,
`isCancelled`, `webLink` — everything §5 needs, which the Omni mapper was dropping.

Request shape:
```
GET /v1.0/users/{UPN}/calendarView
  ?startDateTime=...&endDateTime=...
  &$select=id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,webLink
  &$orderby=start/dateTime
Prefer: outlook.timezone="Europe/Amsterdam"
```

> **⚠ Security note.** `Calendars.Read.All` is a **tenant-wide application permission** — this
> credential can read any mailbox in the tenant. The single-identity rule is therefore enforced by
> our code, not by the grant. Mitigation: the UPN is a hard-coded constant in one module, never a
> parameter, never derived from request input. Worth revisiting whether `Calendars.Read` alone,
> or an application access policy scoped to the one mailbox, would remove the risk structurally.

### 17.9 Observations from real calendar data

Today's real events expose three cases the mocks did not:

- **All-day events** — *"Katja vakantie"* returns `00:00–00:00` with `isAllDay: true`, and is
  someone else's holiday, not a commitment of yours. All-day events cannot be drawn proportionally
  and must render as a separate header band above the timeline, not as a block in it.
- **Zero-attendee blocks** — *Tandarts*, *Claude remote* have `attendees: []`. These are personal
  blocks, not meetings. §5's "N attendees" subtitle and §8's Attendees block must both degrade.
- **Very short events** — a 5-minute and a 15-minute event on one day. The 32px minimum clamp in
  §5 matters more than expected; real days are emptier and spikier than the mock.

### 17.10 Brain

MCP over HTTP, bearer token. `BRAIN_MCP_URL` and `BRAIN_API_KEY` in `.env`. The Next.js server
needs a trustworthy MCP client; connection is confirmed by calling `whoami`.

### 17.11 Tailscale — verified configuration

- Tailnet **`tail981ec3.ts.net`**; this node is **`ruuds-macbook-pro-2023`** (`100.116.89.124`).
- `iphone-14-pro-max` is on the tailnet, so the phone target works with no extra setup.
- **`/` is already taken by Hermes** — `tailscale serve` currently proxies
  `https://ruuds-macbook-pro-2023.tail981ec3.ts.net/` → `http://127.0.0.1:27462`.
- Funnel is **not** enabled; everything is tailnet-only. Correct — the tailnet is the security
  boundary (§12.1) and Task Desk must never be funnelled to the public internet.

**Proposed:** bind Next.js to `127.0.0.1:3000` and publish it on its own HTTPS port so it does not
collide with Hermes and needs no `basePath`:

```
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```

giving `https://ruuds-macbook-pro-2023.tail981ec3.ts.net:8443`. The alternative — a path such as
`/desk` — requires Next.js `basePath` and buys only a shorter URL.

### 17.12 Remaining open

All three closed on 11 Sep 2026.

| # | Question | Resolution |
|---|---|---|
| 1 | Wall monitor URL | **Adopted** — explicit `?display=board` flag. Specified in §17.13. |
| 2 | Rename the repo directory | **No.** Stays `todo-dashboard`. The product is Task Desk; the directory is just a directory. |
| 3 | Narrow the Graph grant | **No.** `Calendars.Read.All` accepted as-is. The single-identity rule is enforced in code per §17.8 — hard-coded UPN constant, never a parameter. |

### 17.13 Display modes — the `?display=board` flag

One codebase, one set of components, one data path. The flag selects a **presentation profile**,
nothing more. It is read once on the server from `searchParams` and passed down as a prop; no
component branches on viewport width to decide it.

| | Default (`/`) | Board (`/?display=board`) |
|---|---|---|
| Target | Phone and desktop | The always-on 1440×720 wall monitor |
| Selected by | Nothing — the default | Explicit query flag only, never inferred from viewport |
| Type scale | Base 15px | Base **17px** — one step, not three |
| Sentence | Full, up to ~50 words | **Caps at two lines**, truncates with a "more" affordance |
| Timeline | Whole day; past events dimmed and kept | **Now onward only** — past events removed, not collapsed |
| List length | Everything (§17.5) | **Top three per block**, remainder as a named count in the header |
| Must fit without scrolling | No | **Yes.** 720px is the hard constraint. |
| Refresh | On load, plus manual | **Polls on an interval** and re-renders in place |
| Open cascade (§11) | Once per session | Once on first paint only — **never on a poll refresh** |

**Rules that hold in both modes:**

- Identical content and identical hierarchy. No feature exists in one mode and not the other —
  principle 6 is not weakened by the flag, because board mode only *truncates* and *rescales*.
- The drill-in still works. A wall monitor is glanced at from a distance but walked up to
  occasionally; §8 behaves exactly as on desktop.
- Auto-scroll to "now" (§5) still applies on load and on poll, and is still suppressed once the
  reader has scrolled away.
- Dark mode is independent of the flag and follows the system, with the manual override remembered
  (§10). The wall monitor is the strongest argument for dark and is the reason it must be as
  considered as light.

**Why a flag and not a breakpoint.** The wall monitor is 1440×720 — a width indistinguishable from
an ordinary laptop. Inferring board mode from the viewport would flip a normal desktop browser into
a truncated, polling display the moment someone resized a window. The mode is a deployment choice,
so it is stated, not guessed.

**Where it is set.** The wall monitor opens
`https://ruuds-macbook-pro-2023.tail981ec3.ts.net:8443/?display=board` (§17.11). Nothing else needs
to know.

---

## 18. Omni — verified contract (12 Sep 2026)

§13's open items 1 and 6 are closed; §15.1 path C is proven end to end.

### 18.1 Where the key lives

Not in Hermes. Hermes reaches Omni through a **custom stdio MCP adapter**
(`~/Projects/neworange-context-platform`, ADR 0003) publishing four read-only tools —
`search_context`, `get_document`, `list_sources`, `get_context_health`. The adapter reads
`OMNI_API_KEY` from the owner-private `0600` file:

```
~/Library/Application Support/New Orange Context/mirror/.env
```

That is why Omni's web UI offers no key-creation page: the key was provisioned out of band.
Minting a second key into `omni-postgres` was considered and rejected — a scoped key already
existed, and PRD §15.2 forbids writing to Omni's database.

### 18.2 Request and response — confirmed against the live instance

```
POST /api/v1/search            Authorization: Bearer <OMNI_API_KEY>
{ query, source_types[], content_types[], attribute_filters{},
  mode: "fulltext"|"semantic"|"hybrid", limit: 1–100, offset }

→ { results: [{ document, score, match_type, highlights[], source_type }],
    total_count, has_more, query_time_ms, query, facets, active_filters }
```

`GET /api/v1/documents/{id}` returns a document plus `source_type`, `content`, `match_type`,
and accepts `start_line` / `end_line`. `GET /api/v1/health` needs no auth.

### 18.3 ⚠ Three findings that would have failed silently

| Finding | Consequence if missed |
|---|---|
| **Source names were wrong.** `outlook` not `outlook_mail`; `fireflies` not `fireflies_transcript`; `slack` not `slack_message`; `local_files` not `file`. | Every one of the guessed names returns **`total_count: 0`**. Enrichment would have looked like a missing key rather than a bug. |
| **`attribute_filters` accepts exact scalar match only.** `{ date: '2026-09-11' }` works; `{ date: { gte: … } }` and `{ date: ['…'] }` return **502 Search service unavailable**. | A 502 is indistinguishable from Omni being down, so the drill-in would have reported "Could not reach Omni" forever. Date narrowing is therefore done client-side. |
| **`source_type` lives on the search *hit*, not inside the document.** | Nearly every document typed `unknown`, silently disabling anything keyed on source. |

Live counts at the time of verification: `outlook` 13,776 · `jira` 59,774 · `outlook_calendar`
1,968 · `confluence` 1,110 · `fireflies` 932 · `slack` 575 · `github` 12 · `local_files` 3 ·
`brain` 0. Brain is not indexed in Omni, which is why the Account block calls Brain directly
over MCP (§17.10).

### 18.4 Recurring series are collapsed before synthesis

A weekly meeting indexes as one document per occurrence, so an attendee search returned the
same title five times and spent the synthesis context budget on near-duplicates. Calendar and
transcript results are now collapsed to their most recent occurrence; mail is never collapsed,
because a repeated subject is a thread and each message may say something different.

### 18.5 Verified drill-in, live

```
attendees     ok    2ms
last-time     ok  1642ms   prose + sources
action-items  empty 279ms
account       empty   1ms
unresolved    ok  1549ms   prose + sources
```

---

## 19. The weekend register (PRD §9)

§9's table required the sentence to acknowledge a weekend; §4 defined only morning, midday,
evening and empty. On the first Saturday the product produced *"The afternoon is unusually
open…"* — true, and completely wrong.

`window` now includes **`weekend`**, and it **overrides the clock**: on a Saturday the register
is about the day, not the hour. The rule is that it says so in the first clause, issues no
recommendation for today, never tells the reader to work, and names what Monday opens with.

Live output: *"It is the weekend. Monday opens with overdue RW-772, while a heavily booked
Wednesday will constrain the rest of the week."*
