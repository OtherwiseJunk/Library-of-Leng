# Validate-Batch Workflow — Design

**Date:** 2026-05-27
**Issue:** #1 — Add validate-batch workflow before cards enter inventory

## Summary

Add a post-capture validation step for each scan batch. OCR/card-match results
must be reviewed and corrected before cards become searchable inventory. The
system distinguishes "OCR found a plausible card" from "a human approved the
exact card and printing."

## Locked decisions

- **Scope:** Phase 1 is the validation workflow only. Browser-based computer-vision
  card detection for continuous scan mode is deferred to a separate follow-up spec.
- **Batch model:** real `batches` table with an explicit open/closed lifecycle.
- **Metadata model:** immutable OCR-guess snapshot + working "best answer" card
  columns + a validated marker.
- **Migration:** none. The database is dev-only; schema and code change directly.
- **Navigation:** new `Batches` tab plus auto-route to the Validate screen when a
  batch is finished.
- **Correction UX:** backend-proxied two-step Scryfall lookup (pick card, then pick
  exact printing).

## 1. Data model

### New `batches` table

```sql
CREATE TABLE IF NOT EXISTS batches (
  id          BIGSERIAL PRIMARY KEY,
  location    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open', 'closed')) DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at   TIMESTAMPTZ
);
```

### `scans` table changes

- Add `batch_id BIGINT NOT NULL REFERENCES batches(id)`.
- `status` CHECK becomes `('processing', 'needs_validation', 'failed', 'approved')`
  — `completed` is removed.
- **OCR snapshot (immutable after the first scan completes):**
  - `detected_card_name` — repurposed to hold the raw recognized name from `scan.py`.
  - `detected_confidence` — rename of the existing `confidence_score`.
  - `detected_scryfall_id` — NEW; the candidate Scryfall id from the initial fuzzy
    lookup.
- **Working / best-answer columns (overwritten on correction):**
  - `card_name` — NEW; the resolved display name used by Search/Library.
  - Existing: `scryfall_id`, `set_code`, `set_name`, `collector_number`, `rarity`,
    `mana_cost`, `card_type`, `oracle_text`, `colors`, `color_identity`, `image_url`,
    `scryfall_uri`, `card_metadata`.
- **Validated marker:**
  - `validated_scryfall_id TEXT`
  - `validated_at TIMESTAMPTZ`

**Semantics:** `detected_*` records what OCR guessed and never changes (audit / OCR
accuracy). The working columns hold the current best card and are overwritten when a
scan is corrected. A non-null `validated_at` means a human confirmed the card.

### Indexes

- Add an index on `scans (batch_id)`.
- Existing GIN/text indexes that reference `detected_card_name` move to `card_name`
  (the column Search/Library now read).

## 2. Status lifecycle

**Scan status:**

```
processing ──OCR ok──▶ needs_validation ──approve/correct──▶ approved
     │                       │
     └──OCR error──▶ failed  ├──mark failed──▶ failed
                             └──skip──▶ (stays needs_validation)
```

**Batch lifecycle:** explicit `open` → `closed`. The display status is *derived*
from child scans, not stored:

- `open` → "Scanning"
- `closed` + any scan `processing` → "Processing"
- `closed` + any scan `needs_validation` → "Needs validation"
- otherwise → "Done"

## 3. API routes

**New / changed:**

- `POST /api/batches {location}` → create a batch (status `open`), returns the batch.
- `GET /api/batches` → list batches with derived status + counts
  (total / processing / needs_validation / approved / failed).
- `GET /api/batches/:id` → batch detail.
- `GET /api/batches/:id/scans` → scans belonging to the batch.
- `POST /api/batches/:id/close` → set status `closed` (idempotent); the frontend then
  routes to the Validate screen.
- `POST /api/scan` (changed) → now requires `batch_id`; on OCR success the scan is set
  to `needs_validation` (previously `completed`).
- `POST /api/scans/:id/approve` → status `approved`,
  `validated_scryfall_id = scryfall_id`, `validated_at = NOW()`.
- `POST /api/scans/:id/correct {scryfall_id}` → fetch the printing from Scryfall,
  overwrite the working columns + `card_name`, set the validated marker, status
  `approved`.
- `POST /api/scans/:id/fail` → status `failed` (mark for rescan; surfaces in the
  existing Fail Queue).
- `GET /api/scryfall/search?q=NAME` → proxied distinct-card search.
- `GET /api/scryfall/printings?oracle_id=...` → all printings for a chosen card
  (`unique=prints`, includes art thumbnails / set / collector number).
- **Search + Library** → filter `status = 'approved'` only (previously
  `completed` + `approved`).

**Unchanged:** `POST /api/scans/:id/retry`, `GET /api/failures`,
`DELETE /api/scans/:id`, scan detail (`GET /api/scans/:id`).

## 4. Frontend

`main.jsx` is currently a single ~500-line file. Adding three surfaces will overrun
it, so split (targeted, scoped to this work):

- `src/api.js` — fetch helper.
- `src/components.jsx` — shared components (Header, EmptyState, StatusIcon, card/image
  rows).
- `src/views/ScanView.jsx`, `BatchesView.jsx`, `ValidateBatchView.jsx`,
  `FailQueue.jsx`, `SearchView.jsx`, `LibraryView.jsx`.

**Scan flow change:** capturing requires an active batch. "Start batch" (with location)
creates a batch and stores the active id; Capture/Upload attach `batch_id`. "Finish
batch" closes the batch and auto-navigates to its Validate screen.

**Batches tab:** lists batches with derived status + pending counts + created time;
clicking re-enters the Validate screen (or Scan if the batch is still open).

**Validate Batch screen:**

- While any scan in the batch is `processing`, show a waiting/progress state (reuse the
  existing ~1.8s polling pattern from `ScanView`).
- Each `needs_validation` row shows: uploaded scan image, detected name + confidence,
  candidate Scryfall image + set / collector number / rarity / type, batch location,
  current status.
- Row actions: **Approve / Correct / Mark failed / Skip**.

**Correct panel:** name search input → proxied card results → pick a card → printings
list (art thumbnail, set, collector number) → pick the exact printing → apply
correction.

## 5. Error handling

- Scryfall proxy: handle non-200 responses and timeouts; return a graceful error so the
  frontend shows a message instead of crashing.
- Candidate missing (OCR found no card): the row cannot be approved — only Corrected or
  Marked failed.
- Closing an already-closed batch: idempotent no-op.
- Single-user assumption: no locking / concurrency handling.

## 6. Testing

No test harness exists today (both `package.json` files only have start/dev/build
scripts). This work adds a lightweight backend integration suite using the built-in
`node:test` runner against the dev-container Postgres. Initial coverage:

- create batch → scan rows attach `batch_id`.
- close batch → derived status transitions.
- approve sets `validated_scryfall_id` + `validated_at` and status `approved`.
- correct overwrites working columns and approves.
- Search/Library exclude non-`approved` scans (regression guard for the inventory-leak
  fix).

Frontend behavior (camera, Validate screen interactions) is verified manually against
the acceptance criteria.

## 7. Follow-up work (out of scope, tracked as issues)

- **Browser CV card-detection for continuous scan mode** (deferred from this spec).
  Must run as JavaScript in an Android mobile browser, so library choice is constrained
  by download size and CPU.
- **Expand automated test coverage** beyond the initial backend suite (frontend
  component tests, Scryfall proxy mocking, e2e). An issue is filed at the end of this
  work.

## Acceptance criteria (from issue #1)

- After finishing a batch, the UI opens a validation view for that batch.
- Validation waits gracefully if OCR is not complete yet.
- Each validation row shows the original uploaded image and the OCR result.
- The user can approve a correct match.
- The user can correct an incorrect match by selecting a Scryfall printing.
- Approved cards become visible in Search and Library.
- Unapproved OCR guesses do not pollute default inventory results.
