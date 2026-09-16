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
# bq/split_ig_handles.sql            — explode multi-handle sheet cells to an array
# bq/migrate_copilot_db.sql          — ADD COLUMN IF NOT EXISTS on live copilot_db
# bq/raw_copilots_union.sql          — expanded sheet union view
# bq/raw_copilots_dedup.sql           — one row per email from the union
# bq/copilot_evaluation_queue.sql    — Review queue (7-day window)
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

| Step              | Source   | Action                                                          |
| ----------------- | -------- | --------------------------------------------------------------- |
| New (`No Status`) | Notion   | Dedupe by email → MT enrich → optional social scrape            |
|                   | BigQuery | Upsert `copilot_applicants`                                     |
|                   | Notion   | Write enrichment fields → status **Evaluated**                  |
| Accepted          | Notion   | Insert into `copilot_db` if not already present (`promoted_at`) |

Schedule on **Cloud Run Jobs** + **Cloud Scheduler** (once daily).

## Onboard (post-acceptance)

Daily job over `copilot_db` rows with `promoted_at` and no `onboarded_at`:

1. Look up a live Co-Pilot membership on their MT account, and an existing promo that belongs to **this person** (`copilot_db.promo_code` / `discount_id`, or an unowned `stg_mt.stg_mt_discounts` match — `FIRSTNAMELASTNAME` / `Seeker First Last`). A code already assigned to another copilot is not reused. If both their promo and a live membership exist, stamp Onboarded and skip a new membership / email (manual onboards). Inactive vouchers are turned back on.
2. Otherwise generate `promo_code` (FIRSTNAMELASTNAME). If that name is already taken in copilot_db or Mariana Tek, use their Instagram handle with symbols stripped (`@jane.smith` → `JANESMITH`). If the handle is missing or also taken, fall back to the email local-part.
3. Create the MT discount (region-correct products), or reactivate their existing voucher. If Mariana Tek rejects the code as already in use, mint the next unique code and retry.
4. Write `offer_link` = `https://othership.us/copilot/intro-offer?id={promo_code}`
5. Assign the Seeker (or current tier) Co-Pilot membership unless one is already live
6. Send the **placeholder** acceptance email (swap `emails/acceptance.html` later)
7. Set `onboarded_at`, `status=active`, Notion Status **Onboarded**

```bash
DRY_RUN=1 ONBOARD_LIMIT=5 npm run onboard-copilots
DRY_RUN=1 npm run onboard-copilots
npm run onboard-copilots
```

Deploy: `./deploy/deploy-onboard-job.sh` (9:15am ET, after evaluate-applications).

## Evaluation + decisions (Christine sheet)

Named view `copilot_evaluation_queue` (on `copilot_performance`): active copilots who have an MT `user_id` and a **Co-Pilot** membership whose performance-view **`days_to_expiry`** is within **7 days** or already expired, **or** whose `ig_handle` contains **re-submit**, **or** who have **no Mariana Tek `user_id`**. `membership_end` / `days_to_expiry` come from `copilot_performance` (Mariana Tek instance end). The job **always rebuilds Review and Add to Modash first** (including when `EVALUATE_EMAILS` is set), then applies filled decisions. Rebuild is one row per email; later duplicate sheet rows win. Filled **decision** / notes / sales cells are copied forward for people still on Review. Apply is idempotent: if a crash happened after assigning a new term but before `decision_applied_at`, the next run will not assign a duplicate. After the Mariana Tek change, the job **sends a placeholder email** to the copilot (swap templates later). If Gmail is not configured, apply fails and the Review row stays for retry.

Review is **membership work only**: no MT account, no live Co-Pilot term, `payment_failure`, or a live Co-Pilot term within 7 days of ending. Rebuild sorts **blank decisions first** (soonest `days_to_expiry`), then filled rows the job will apply, then parked **nudge / last-day / apply-failed** rows with a grey background. **Renew / upgrade / downgrade / offboard / never again** stay on Review until the last day (`days_to_expiry <= 0`) **while they are still in that membership window**; the filled **decision** is kept across those rebuilds (and restored from copilot_db if the sheet cell is blank) until apply. Payment-method holds also stay on Review (grey). Someone with a live Co-Pilot term more than 7 days out is dropped from Review, even if their handle is **re-submit** — those people are **social-only** and live on **Add to Modash** as `status=outlier` (not in the paste-ready `ig_handle` list). Dual people (expiring within 7 days **and** waiting on a public handle) stay on Review **and** appear as Modash outliers. Successful **onboard / offboard / renew / upgrade / downgrade / snooze / freeze / update** deletes the Review row. There is no Applied tab.

`DRY_RUN=1` plans the same Review rebuild in memory, looks up the live MT membership / card, and prints the email that would send — no sheet, BQ, MT, or Gmail writes. `EVALUATE_EMAILS` limits apply / social nudges to those people but **still rebuilds** Review / Add to Modash.

If **onboard / renew / upgrade / downgrade** cannot add the new membership because there is **no payment method on file** or the stored card is **expired**, apply takes a hold path: it does **not** terminate the live term, sends a payment-method nudge (`emails/nudgePaymentMethod.html`) **once**, stamps `payment_nudge_at`, and **leaves the Review row**. The lifecycle email is not sent. Later runs retry membership add but do not send another nudge. Once a valid card is on file, the original decision completes as usual.

- **onboard** — assign a new same-tier term (does not terminate a live Co-Pilot membership), send the welcome/acceptance email with estimated end, `status=active`, stamp `onboarded_at` / `acceptance_emailed_at`
- **renew** — ops can fill Review in the 7-day window; apply waits until **last day** (`days_to_expiry <= 0`). Does **not** terminate the live term. Assigns a new same-tier term (Seeker 3 mo / Wayfinder 6 mo / Luminary 12 mo) starting now, send renewal email with estimated end, `status=active`. Does **not** add a term if the live membership still has more than a day left (stale queue).
- **offboard** — ops can fill Review any time; apply waits until **last day** (`days_to_expiry <= 0`). Rebuild stamps `offboarding end of term on YYYY-MM-DD` (from `membership_end`) and parks the row in the grey hold block, even if they are otherwise social-only with a live term more than 7 days out. Then expire MT promo, send offboard email, `status=inactive`. Live membership is left to expire on its own. Keep `promo_code` / `offer_link` on copilot_db
- **never again** — same as offboard, plus sticky `never_again=TRUE` on `copilot_db`. If they apply again, evaluate-applications auto-rejects (does not accept, even if Re-onboard is Proceed)
- **upgrade** — same last-day apply as renew; one step Seeker → Wayfinder → Luminary; new-tier membership starting now + patch discount %; send upgrade email; Luminary + upgrade is treated as renew
- **downgrade** — same last-day apply as renew; one step Luminary → Wayfinder → Seeker; new-tier (shorter) membership starting now + patch discount %; send downgrade email; Seeker + downgrade **fails** so she can pick offboard
- **snooze** — no MT change, no email (review hold only); hide from Review for **3 months** after `decision_at`, then re-queue if still in the window
- **freeze** — freeze the live Co-Pilot membership until `freeze_until`, or **3 months** if blank; send freeze email; persist `freeze_until` on `copilot_db`; hide while `membership_status` is frozen or until that date
- **social** — send the resubmit-handles email (`emails/resubmitHandles.html`) immediately (no last-day wait, no `user_id` required). Stamp `decision_notes` to `resubmit handles email sent YYYY-MM-DD` (Review if they are still a membership row; otherwise copilot_db + Add to Modash `notes`). **Social-only** people (live term more than 7 days out) are **not** kept on Review. Dual people stay on Review for the membership decision. Does not re-send if that note is already present. Does not set `decision_applied_at`, so she can still pick renew / offboard / etc. afterward.

After apply, the Review row is deleted (except payment-method / last-day holds). Social-only people are written to **Add to Modash** (`status=outlier`) instead of staying on Review. People come back when:

- **onboard / renew / upgrade / downgrade** — a new `membership_start` is on/after `decision_applied_at` and that term is again within 7 days of ending
- **snooze** — 3 months after `decision_at` and still expiring with a Co-Pilot membership
- **freeze** — `freeze_until` has passed (default applied + 3 months) and membership is no longer frozen
- **offboard** — they stay inactive unless ops marks them active again
- **never again** — same as offboard, and a later application is auto-rejected

```bash
npm run sync-copilot-db                 # creates/refreshes copilot_evaluation_queue
DRY_RUN=1 npm run evaluate-copilots
DRY_RUN=1 EVALUATE_EMAILS=a@example.com npm run evaluate-copilots
npm run evaluate-copilots
# Rebuild Review from the queue without ingesting/applying filled decisions
# (keeps decision / freeze_until / notes / sales cells for people still in queue):
EVALUATE_SKIP_APPLY=1 npm run evaluate-copilots
```

Create a Google Sheet, share it with the job’s service account as Editor, set `EVALUATION_SHEET_ID`. The **Review** tab (and the decision dropdown) is created on first run. The same job rebuilds **Add to Modash** with paste-ready `status=add` rows (one per active-copilot IG handle that is not on `modash_creators` — copy the `ig_handle` column) and a separate `status=outlier` block for people waiting on a public handle (do not paste those). Applied history is a Sheets data connector, not written by the job. To change the 7-day window, edit `bq/copilot_evaluation_queue.sql` and re-run `sync-copilot-db`.

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

Ops tracking still lives in the TO/NY Google Sheets. External tables `raw_to_*` / `raw_nyc_*` feed `raw_copilots_union` → `raw_copilots_dedup`. The sync job MERGEs into `copilot_db` by email. After MERGE, any `copilot_db` row that is not already `inactive` and whose email is **not on any active tab** is set to `inactive` (removed from the roster, or never added to an active tab). People still on an active tab stay active even if they also appear on Inactive.

```bash
DRY_RUN=1 npm run sync-copilot-db
npm run sync-copilot-db                 # full sync
npm run sync-copilot-db -- --skip-views # MERGE only (views already applied)
```

Deploy: `./deploy/deploy-sync-copilot-db-job.sh` (**8:45am ET**, before evaluate-applications). The Cloud Run service account must be able to query the Drive-linked `raw_*` tables (share the TO/NY sheets with that SA) and **BigQuery Data Viewer** on `data-pipeline-492715.stg_mt` (live MT discounts for onboard / find-discount-ids / `copilot_performance`).

### Column ownership on `copilot_db`

| Owner          | Columns                                                                                                                                                                                                                | Who writes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ops sheet**  | names, region, tier, **`status`**, bb_link, **`ig_handle`** (`@handle` or `@a, @b`), **sales fields**, **`sheet_membership_expiry`**, ops tracking (`renewal_amt`, `modash`, `in_hub`, …), notes                       | `sync-copilot-db` — does not overwrite `status` after an applied **offboard** / **never again**, or `tier` after an applied **upgrade** / **downgrade**. After MERGE, sets **`status=inactive`** for emails not on any active tab. Does not overwrite **`ig_followers`** (Modash is live; DB value is onboard seed only). Canonicalizes `ig_handle` (splits several accounts in one sheet cell); rebuilds **`ig_url`** as one profile link per handle. |
| **System**     | `user_id`, `mt_email`, `mt_profile_link`, `discount_id`, **`promo_code`**, **`offer_link`**, `promoted_at`, `onboarded_at`, `acceptance_emailed_at`, **`tiktok_handle`**, **`tiktok_followers`**, **`other_channels`** | MT / promote / enrich jobs — **never overwritten by ops sheet sync**. Empty `ig_url` is kept when the sheet has no handle. The performance view overlays the current MT code string by `discount_id` from `stg_mt.stg_mt_discounts`.                                                                                                                                                                                                                                                |
| **Evaluation** | `decision`, `decision_notes`, `decision_at`, `decision_source`, `decision_applied_at`, **`payment_nudge_at`**, **`freeze_until`**, **`never_again`**, **`new_hybrid_sales`**                                           | Evaluation Sheet → DB — **never ops sheet sync**                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Computed**   | membership (instances join), **`home_studio`** (MT user home location), classes / last class, promo redemptions, **`modash_posts`**, **`ig_followers`** (Modash, else copilot_db seed)                                 | View `copilot_performance`. Slack bot writes `modash_creators` + `modash_content`.                                                                                                                                                                                                                                                                                                                                                                     |

Dedup: one row per email; prefer **`active` over `inactive`**, then `ORDER BY tier` (Seeker &lt; Luminary &lt; Wayfinder).

## Other BigQuery / MT jobs

| npm script                     | What it does                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `npm run onboard-copilots`     | Promote handoff → discount, offer_link, membership, acceptance email, Onboarded                                    |
| `npm run evaluate-copilots`    | Queue view → Review sheet → apply onboard / renew / offboard / never again / upgrade / downgrade / snooze / freeze / update / social |
| `npm run sync-copilot-db`      | Migrate columns, refresh views, MERGE sheet → `copilot_db`, inactivate emails not on an active tab                 |
| `npm run find-discount-ids`    | Lookup existing discount ids from `stg_mt.stg_mt_discounts` + set `offer_link` (no create)                          |
| `npm run create-discounts`     | **Onboarding only** — create MT discounts for rows with `promo_code` but no `discount_id`                          |
| `npm run update-discounts`     | Sync existing discounts in MT from BQ                                                                              |
| `npm run find-user-ids`        | Backfill `user_id` / `mt_email` in `copilot_db` from MT                                                            |
| `npm run find-memberships`     | Deprecated no-op (membership is view-joined)                                                                       |
| `npm run backfill-memberships` | Deprecated no-op (same)                                                                                            |
| `npm run find-two-memberships` | Sync latest + second membership into `copilot_memberships`                                                         |
| `npm run update-memberships`   | End legacy co-pilot memberships listed in `copilot_memberships`                                                    |
| `npm run assign-memberships`   | Assign Seeker co-pilot memberships by email list                                                                   |
| `npm run find-reservations`    | Report future reservations for terminating memberships                                                             |
| `npm run email-resubmit-handles` | One-time: email active copilots with a live Co-Pilot membership whose IG is **re-submit**                        |

### Resubmit social handles (one-time)

Emails every **active** copilot who has a **live Co-Pilot membership** (`active` / `pending` / `payment_failure`) and whose `ig_handle` is the ops placeholder **re-submit** (same flag Review stamps as `need to resubmit social handles`). Asks them to reply with a public Instagram handle, plus TikTok if they have one. After a successful send, Review `decision_notes` (and `copilot_db`) become `resubmit handles email sent YYYY-MM-DD` in place of the original resubmit flag.

```bash
DRY_RUN=1 npm run email-resubmit-handles
EMAILS=a@example.com DRY_RUN=1 npm run email-resubmit-handles
LIMIT=5 DRY_RUN=1 npm run email-resubmit-handles
DRY_RUN=0 npm run email-resubmit-handles -- --apply
```

## Env

See [`.env.example`](.env.example). Required for `evaluate-applications`: `NOTION_TOKEN`, `NOTION_APPLICATIONS_DATABASE_ID`, `BQ_PROJECT_ID`, `MT_API_BASE_URL`, `MT_API_KEY`.

Sheet sync needs a BigQuery SA (or ADC) that can read the Drive-linked external tables, or run on Cloud Run where that access is already configured.

Set `SOCIAL_ENRICHMENT_PROVIDER=apify` and `APIFY_API_TOKEN` to enable Instagram follower scraping.
