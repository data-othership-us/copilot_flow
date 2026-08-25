# copilot-flow

Automation for the Othership Co-Pilot program across **Notion** (applicant database), **BigQuery** (`copilots.copilot_applicants` + `copilot_db`), and **Mariana Tek**.

Migrated from `os-mt-services/src/scripts/internal/copilots/` and related BigQuery workflows.

## Setup

```bash
cp .env.example .env
npm install
```

### One-time: BigQuery tables

Create / migrate tables (replace `YOUR_PROJECT` with `BQ_PROJECT_ID`):

```bash
# bq/copilot_applicants.sql          — applicant pipeline state
# bq/copilot_db.sql                  — post-acceptance dimension (greenfield)
# bq/modash_creators.sql             — Modash Creators CSV (Slack bot MERGE)
# bq/modash_content.sql              — Modash Content CSV (Slack bot MERGE)
# bq/normalize_ig_handle.sql         — IG handle UDF used by copilot_performance
# bq/migrate_copilot_db.sql          — ADD COLUMN IF NOT EXISTS on live copilot_db
# bq/raw_copilots_union.sql          — expanded sheet union view
# bq/raw_copilots_dedup.sql           — one row per email from the union
# bq/copilot_evaluation_queue.sql    — Review queue (14-day window)
# bq/copilot_add_to_modash.sql       — active handles missing from Modash Creators
```

Or let the sync job apply migration + views:

```bash
DRY_RUN=1 npm run sync-copilot-db    # preview
npm run sync-copilot-db              # ensure columns, replace views, MERGE sheet → copilot_db
```

## Application evaluation (daily job)

Polls Notion for new applications, enriches from Mariana Tek (+ optional Apify Instagram scrape), writes to `copilot_applicants`, and moves cards to **Evaluated**. A second pass promotes **Accepted** applicants into `copilot_db`.

```bash
DRY_RUN=1 npm run evaluate-applications
```

| Step | Source | Action |
|---|---|---|
| New (`No Status`) | Notion | Dedupe by email → MT enrich → optional social scrape |
| | BigQuery | Upsert `copilot_applicants` |
| | Notion | Write enrichment fields → status **Evaluated** |
| Accepted | Notion | Insert into `copilot_db` if not already present (`promoted_at`) |

Schedule on **Cloud Run Jobs** + **Cloud Scheduler** (once daily).

## Onboard (post-acceptance)

Daily job over `copilot_db` rows with `promoted_at` and no `onboarded_at`:

1. Generate `promo_code` (FIRSTNAMELASTNAME) if missing
2. Create the MT discount (region-correct products)
3. Write `offer_link` = `https://othership.us/copilot/intro-offer?id={promo_code}`
4. Assign the Seeker (or current tier) Co-Pilot membership
5. Send the **placeholder** acceptance email (swap `emails/acceptance.html` later)
6. Set `onboarded_at`, `status=active`, Notion Status **Onboarded**

```bash
DRY_RUN=1 ONBOARD_LIMIT=5 npm run onboard-copilots
DRY_RUN=1 npm run onboard-copilots
npm run onboard-copilots
```

Deploy: `./deploy/deploy-onboard-job.sh` (9:15am ET, after evaluate-applications).

## Evaluation + decisions (Christine sheet)

Named view `copilot_evaluation_queue` (on `copilot_performance`): active copilots whose **Co-Pilot** membership ends within **14 days** or already expired, plus active copilots with **no Co-Pilot membership** (and no sheet expiry). The job rebuilds the Review tab from that queue. She picks `decision` from a dropdown (`renew` / `offboard` / `never again` / `upgrade` / `downgrade` / `snooze` / `freeze`). Then the job writes `decision*` to `copilot_db` and applies.

Apply is idempotent: if a crash happened after assigning a new term but before `decision_applied_at`, the next run will not terminate that new term. After the Mariana Tek change, the job **sends a placeholder email** to the copilot (swap templates later). If Gmail is not configured, apply fails and the Review row stays for retry. Promo codes stay active on offboard. Hub / Notion access removal is out of scope.

- **renew** — terminate any live Co-Pilot membership, assign a new same-tier term (Seeker 3 mo / Wayfinder 6 mo / Luminary 12 mo), send renewal email with estimated end, `status=active`
- **offboard** — terminate live membership if present, send offboard email, `status=inactive` (drops out of performance / Review), keep promo / offer_link
- **never again** — same as offboard, plus sticky `never_again=TRUE` on `copilot_db`. If they apply again, evaluate-applications auto-rejects (does not accept, even if Re-onboard is Proceed)
- **upgrade** — one step Seeker → Wayfinder → Luminary; new-tier membership + patch discount %; send upgrade email; Luminary + upgrade is treated as renew
- **downgrade** — one step Luminary → Wayfinder → Seeker; new-tier (shorter) membership + patch discount %; send downgrade email; Seeker + downgrade **fails** so she can pick offboard
- **snooze** — no MT change, no email (review hold only); hide from Review for **3 months** after `decision_at`, then re-queue if still in the window
- **freeze** — freeze the live Co-Pilot membership until `freeze_until`, or **3 months** if blank; send freeze email; persist `freeze_until` on `copilot_db`; hide while `membership_status` is frozen or until that date

After apply, the Review row is deleted. People come back when:

- **renew / upgrade / downgrade** — a new `membership_start` is on/after `decision_applied_at` and that term is again within 14 days of ending
- **snooze** — 3 months after `decision_at` and still expiring / membership-less
- **freeze** — `freeze_until` has passed (default applied + 3 months) and membership is no longer frozen
- **offboard** — they stay inactive unless ops marks them active again
- **never again** — same as offboard, and a later application is auto-rejected

```bash
npm run sync-copilot-db                 # creates/refreshes copilot_evaluation_queue
DRY_RUN=1 npm run evaluate-copilots
npm run evaluate-copilots
```

Create a Google Sheet, share it with the job’s service account as Editor, set `EVALUATION_SHEET_ID`. The **Review** tab (and the decision dropdown) is created on first run. The same job rebuilds **Add to Modash** with active copilots whose IG handle is not on `modash_creators`. Applied history is a Sheets data connector, not written by the job. To change the 14-day window, edit `bq/copilot_evaluation_queue.sql` and re-run `sync-copilot-db`.

Deploy: `./deploy/deploy-evaluate-copilots-job.sh` (9:30am ET).

### Deploy (Web Services / `marianatek-webhooks`)

Creates/updates the job + a **9:00am America/New_York** scheduler. Does **not** run the job.

```bash
./deploy/deploy-evaluate-job.sh
```

Manual run later:

```bash
gcloud run jobs execute copilot-evaluate-applications --region=us-central1 --project=marianatek-webhooks
```

### Historical cutoff (`pre_pipeline`)

Before go-live, backfill every Notion application into `copilot_applicants` marked `pre_pipeline=TRUE`. Accepted nudge/promote and Rejected email/credit only run when `pre_pipeline=FALSE` (set when `evaluate-applications` enriches a row).

```bash
DRY_RUN=1 npm run backfill-applicants   # preview counts
npm run backfill-applicants             # write to BigQuery
```

## Copilot DB sync (sheet → BigQuery)

Ops tracking still lives in the TO/NY Google Sheets. External tables `raw_to_*` / `raw_nyc_*` feed `raw_copilots_union` → `raw_copilots_dedup`. The sync job MERGEs into `copilot_db` by email.

```bash
DRY_RUN=1 npm run sync-copilot-db
npm run sync-copilot-db                 # full sync
npm run sync-copilot-db -- --skip-views # MERGE only (views already applied)
```

Deploy: `./deploy/deploy-sync-copilot-db-job.sh` (**8:45am ET**, before evaluate-applications). The Cloud Run service account must be able to query the Drive-linked `raw_*` tables (share the TO/NY sheets with that SA).

### Column ownership on `copilot_db`

| Owner | Columns | Who writes |
|---|---|---|
| **Ops sheet** | names, region, tier, **`status`**, bb_link, **`ig_handle`** (`@handle`), **sales fields**, **`sheet_membership_expiry`**, ops tracking (`renewal_amt`, `modash`, `in_hub`, …), notes | `sync-copilot-db` — does not overwrite `status` after an applied **offboard** / **never again**, or `tier` after an applied **upgrade** / **downgrade**. Does not overwrite **`ig_followers`** (Modash is live; DB value is onboard seed only). Canonicalizes `ig_handle`; fills **`ig_url`** only when empty. |
| **System** | `user_id`, `mt_email`, `mt_profile_link`, `discount_id`, **`promo_code`**, **`offer_link`**, `promoted_at`, `onboarded_at`, `acceptance_emailed_at`, **`tiktok_handle`**, **`tiktok_followers`**, **`other_channels`**, **`ig_url`** (applicant profile link) | MT / promote / enrich jobs — **never overwritten by ops sheet sync** (except empty `ig_url` filled from the sheet handle) |
| **Evaluation** | `decision`, `decision_notes`, `decision_at`, `decision_source`, `decision_applied_at`, **`freeze_until`**, **`never_again`** | Evaluation Sheet → DB — **never ops sheet sync** |
| **Computed** | membership (instances join), **`home_studio`** (MT user home location), classes / last class, promo redemptions, **`modash_posts`**, **`ig_followers`** (Modash, else copilot_db seed) | View `copilot_performance`. Slack bot writes `modash_creators` + `modash_content`. |

Dedup: one row per email; prefer **`active` over `inactive`**, then `ORDER BY tier` (Seeker &lt; Luminary &lt; Wayfinder).

## Other BigQuery / MT jobs

| npm script | What it does |
|---|---|
| `npm run onboard-copilots` | Promote handoff → discount, offer_link, membership, acceptance email, Onboarded |
| `npm run evaluate-copilots` | Queue view → Review sheet → apply renew / offboard / never again / upgrade / downgrade / snooze / freeze |
| `npm run sync-copilot-db` | Migrate columns, refresh sheet + performance + evaluation_queue views, MERGE sheet → `copilot_db` |
| `npm run find-discount-ids` | Lookup existing discount ids from `discount_codes` + set `offer_link` (no create) |
| `npm run create-discounts` | **Onboarding only** — create MT discounts for rows with `promo_code` but no `discount_id` |
| `npm run update-discounts` | Sync existing discounts in MT from BQ |
| `npm run find-user-ids` | Backfill `user_id` / `mt_email` in `copilot_db` from MT |
| `npm run find-memberships` | Deprecated no-op (membership is view-joined) |
| `npm run backfill-memberships` | Deprecated no-op (same) |
| `npm run find-two-memberships` | Sync latest + second membership into `copilot_memberships` |
| `npm run update-memberships` | End legacy co-pilot memberships listed in `copilot_memberships` |
| `npm run assign-memberships` | Assign Seeker co-pilot memberships by email list |
| `npm run find-reservations` | Report future reservations for terminating memberships |

## Env

See [`.env.example`](.env.example). Required for `evaluate-applications`: `NOTION_TOKEN`, `NOTION_APPLICATIONS_DATABASE_ID`, `BQ_PROJECT_ID`, `MT_API_BASE_URL`, `MT_API_KEY`.

Sheet sync needs a BigQuery SA (or ADC) that can read the Drive-linked external tables, or run on Cloud Run where that access is already configured.

Set `SOCIAL_ENRICHMENT_PROVIDER=apify` and `APIFY_API_TOKEN` to enable Instagram follower scraping.
