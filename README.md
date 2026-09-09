# SaniTap Sampler

A static, offline-capable web tool that draws **statistically valid, logistics-aware water quality monitoring samples** for the SaniTap programme under the Gold Standard *Safe Drinking Water Supply* (SDWS) methodology v2.0.

**Live tool:** https://sanitap-water.github.io/sanitap-sampler/ (deployed from `main` by GitHub Actions; works offline after the first load).

Plain HTML/CSS/JS, no build step, no backend, no accounts. All data stays in the browser. Map by [Leaflet](https://leafletjs.com) (cdnjs) with OpenStreetMap tiles.

```
index.html   app shell, styles, print stylesheet
app.js       Core (PRNG, CSV, mWater frame, draw, statistics, PDF record, exports) + i18n object + UI
sw.js        service worker: caches the app shell for offline use (tiles and the mWater API are never cached)
data/sample-water-points.csv   60 fake points, 3 strata, 4 inactive (CSV-source demo)
bin/file-round.js              files a drawn round under records/ (append-only) and pushes
records/                       filed sampling records, served by Pages (records/index.md is the register)
test/mapper.test.js            Node tests (frame rule, PPS draw, audit, PDF determinism)
docs/protocol-annex.md         one-page annex for the SaniTap Water Quality Testing Protocol
.github/workflows/deploy.yml   GitHub Pages deployment; bakes the git commit hash into app.js
```

## Quick start

1. Open the app (GitHub Pages URL below, or just open `index.html` locally / serve the folder with `python3 -m http.server`).
2. **1 Data** — default source is **mWater (live)**: open *mWater connection*, sign in (or paste a token), choose the stratum and press *Fetch from mWater*. Fallback: switch to **CSV file (offline)** and load a frame CSV, or press *Load sample data*.
3. **2 Parameters** — enter *Drawn by*, pick the stratum, check the defaults, note the seed, press *Draw the sample*.
4. **3 Draw** — read the design check, the selected sources and the audit record; press *Export sampling record* to get the VVB-facing PDF together with the audit JSON and the selection CSV it hashes.
5. **4 Map** — set a start point to get the visiting order; optionally draw custom axis clusters.
6. **5 Field sheet** — print (or *Save as PDF* on the phone).

Language toggle (EN/FR) is in the header; every label lives in the `I18N` object in `app.js`.

## Inputs

### Source A — mWater (default)

The frame is fetched in the browser from the mWater API (`https://api.mwater.co/v3`, CORS is open) and mapped by `Core.mapMwaterEntities()`.

**Eligibility rule (v1.2).** A source is eligible when it

1. belongs to the MadAvance water point register (mWater group `group:aaaf0a14…`, entity type `water_point`);
2. has at least one result in *Clean Water || Water Quality Testing_SDWS 3_Result* (form `7b33c5d7…`) that passes **all of that form's own pass calculations**: E. coli = 0 CFU/100 mL, turbidity ≤ 5 NTU, conductivity < 1500 µS/cm, 6 ≤ pH ≤ 8.5, arsenic ≤ 10 µg/L, fluoride ≤ 1.5 mg/L, iron ≤ 0.3 mg/L and manganese ≤ 0.4 mg/L when measured (a missing value for the first six is a fail, as in the form);
3. is not abandoned: name not "abondonné / identifié / drilling / proposal / puits ouvert", latest final record of the maintenance form not *Non fonctionnel*, type not kiosk or dug well;
4. lies in a district mapped to a stratum: Taolagnaro → **HP-FD**, Maroantsetra → **HP-MA**. Beloha and Amboasary (the Marolinta area) are excluded; any other district is *unassigned* and excluded.

The exclusions are applied in that order and counted: total in group, SDWS 3 pass count, excluded (no passing result), excluded abandoned, excluded Marolinta, unassigned, eligible per stratum. The counts appear on the Data tab, in the audit record (`input.mwater.counts`) and in the sampling record PDF. The 286 `LR-…` points of the group named SaniTap are not in the register and stay out.

| Sampler column | mWater origin |
|---|---|
| `water_point_id` | entity `code` (the id used in every mWater form) |
| `name` | `name` (pump model) + `alt_id` (pump number) |
| `stratum` | district (`admin_div2`, or the admin-region hierarchy) mapped as above, else `unassigned` |
| `commune`, `fokontany`, `village` | `admin_div3`, `admin_div4`, `admin_div5` |
| `lat`, `lon` | `location.coordinates` |
| `households_served` | latest "Nombre de toits" in *Nombre de bénéficiaires* (form `8aa2dd78…`), used as the stage-1 sampling weight and printed on the field sheet |
| `status`, `status_reason`, `sdws3_*` | result of the eligibility rule and the SDWS 3 pass/result counts |

The fetched frame is serialised to CSV, hashed with SHA-256 and stored exactly like an uploaded CSV, so the audit record and the reproducibility guarantee are identical for both sources (`input.source` is `mwater` or `csv`). *Download loaded frame* gives the VVB the exact CSV that was hashed.

**Token handling.** Sign-in posts username/password once to `/v3/clients` and keeps only the returned client id; the password is never stored. The token lives in this browser's `localStorage`, is shown masked, travels only as the `?client=` query parameter, is never logged and never written to any export, audit record or PDF. The service worker never caches `api.mwater.co`. Nothing in this repository contains a credential: `MWATER` in `app.js` holds only identifiers (group id, form ids, question ids).

### Source B — CSV (offline fallback)

**Water points CSV** (mWater export), one row per point, columns:
`water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status`
(`latitude/longitude/lng` are accepted as aliases; `status` is `active`/`inactive`).

**Round parameters**: round name (e.g. `2026 R1`), *drawn by*, stratum, sampling method, target number of PoU samples (default 58), households per source (default 5), replacement fraction (default 20 %), household replacements per source (default 2), and the **seed**, prefilled as `<round without spaces>-<stratum>` (e.g. `2026R1-HP-FD`) and editable. Statistical parameters: ICC (default 0.1), expected pass rate (default 0.95), confidence (90 % default, or 95 %), precision type (relative 10 % of p — the CDM convention — or absolute ±0.10).

## How the draw works

Implemented in `Core.draw()` in `app.js`; also shown in the app under *How it works* and written out in every sampling record PDF.

**Random numbers.** The seed string is hashed with `xmur3` into a 32-bit word that seeds a `mulberry32` PRNG. All stages consume the same stream in a fixed order, so the same seed + same frame file + same parameters reproduce the same selection on any device. Records are sorted by identifier (and by commune for stage 1) before drawing, so CSV row order does not matter.

**Frame.** Sources with `status = active` in the chosen stratum (see the eligibility rule above).

**Stage 1 — sources (Protocol v2.1 §6.4, default method `pps_households`).** The eligible sources are ordered by commune then id, each with its households served (sources without a count get the stratum median; the count of imputed weights is in the audit). `n_wp = ceil(target / households_per_source)` sources are drawn by **systematic PPS**: interval = total households / n_wp, one random start in [0, interval), and the source containing start + k × interval is selected for k = 0 … n_wp − 1. Ordering by commune spreads the selection across communes in proportion to their households. A source with more households than the interval is selected with certainty and the interval is recomputed on the rest, so no source is hit twice. The **replacement list** (`ceil(replacement_fraction × n_wp)` sources) is then drawn one by one from the remaining sources with probability proportional to households, in draw order. The audit records total households, interval, random start, certainty selections and, per selected source, its weight, cumulative range and hit position.

The v1 design (commune or axis clusters drawn PPS by number of sources, then simple random sampling of sources) is still available as method `commune_clusters`.

**Stage 2 — households.** Every source uses the **field rule**: count the households served (K), number them clockwise from the source starting at the nearest, and draw N random numbers between 1 and K (+2 replacements). The numbers are generated when K is typed, from a PRNG seeded with `seed|water_point_id|K=K`, so they are reproducible and are appended to the audit record. There is no household list stage any more: registered household lists are not maintained in mWater.

**Statistical check.** Design effect `DEFF = 1 + (m − 1) × ICC` (m = households per point). Effective sample size `n_eff = n_wp × m / DEFF`. Required size for a proportion at expected pass rate p under the CDM 90/10 rule: `n_req = z² p(1 − p) / d²`, z = 1.645 (90 %) or 1.96 (95 %), d = 0.1 × p (relative) or 0.10 (absolute). If `n_eff < n_req` the tool warns and suggests (a) fewer households per point and hence more water points/clusters, or (b) more water points at the same m.

**Audit record.** Each draw produces a JSON record with: record id (`round-stratum-seed`), timestamp, who drew it, seed and its 32-bit seed word, algorithm, tool version and commit, input source (mWater group, forms used, fetch time, eligibility counts, frame rule) or CSV file name with the frame SHA-256, all parameters, the frame summary, stage-1 numbers, statistics, communes covered, sources (with weights and hit positions), replacements, the field rule, warnings, and, when available, the visiting order and the field-rule numbers generated with K. It is shown on screen, exported as JSON, hashed into the sampling record PDF, and is the evidence of random selection retained for the VVB.

## Outputs

- **Map**: selected points numbered (by visiting order once a start point is set), replacements grey (`R1…`), cluster boundaries (convex hull of each commune's points, or axis polygons), nearest-neighbour route from a start point chosen by tapping the map, using the phone's GPS, or picking a water point; leg and cumulative straight-line distances (haversine).
- **Field sheet** (print stylesheet): one page per water point with the household list or the field rule (K box, generated numbers), PoC sample and boundary-condition checklist (spout disinfection, PoC sample, container disinfection), spaces for times, sample IDs and signature. Replacement points are marked.
- **CSV for mWater**: `round, stratum, cluster, water_point_id, order, household_id_or_rule, replacement_flag` — one row per household (or per point when only the rule applies). `replacement_flag` ∈ `none`, `household`, `water_point`, `water_point+household`.
- **Audit JSON** as described above.
- **Sampling record (PDF)**: *Export sampling record* builds, entirely in the browser with pdf-lib 1.17.1 (cdnjs, cached for offline use), a narrative record for the validator in the UI language: identification (programme, stratum, round, draw time, drawn by), method (Protocol v2.1 §6.4), frame (rule in words, mWater source and counts, frame SHA-256), randomness (seed, PRNG, exact reproduction steps), design check (n, sources, m, p, required n for 90/10, ICC, DEFF, effective n, pass/fail), tables of selected and replacement sources with K values, and a footer on every page with the record id, the audit JSON SHA-256, the tool version and commit, and page x of y. The action downloads the PDF together with the audit JSON and selection CSV it hashed. The PDF is byte-identical for the same audit record (its dates are set to the draw timestamp) and contains nothing from the API token.
- **mWater site list (CSV)**: `code, name, round, stratum, role, order, seed, drawn_at` — one row per selected and replacement point, keyed by the mWater entity code. mWater has no entity property for a monitoring round, so this file is not imported into the site register directly: import it into mWater as a *custom table* (Data → Tables → Import CSV) or attach it to the round's dashboard, and reference it from the monitoring report. Writing a round mark onto the entity itself would need a new custom property on `water_point`; the API route for that is `PATCH /v3/entities/water_point?client=…` with `{doc, base}` (same protocol as forms), which the tool does not use.

## Offline and storage

After the first load `sw.js` caches the app shell and the Leaflet files from cdnjs; the app then opens without a connection (map tiles are not cached). Loaded CSV text, axes, the last draw parameters, K values and the start point are kept in `localStorage` on the device; *Clear stored data* removes them. The last draw is recomputed from its stored parameters on reload (it is deterministic).

## Real data

The programme frame is the MadAvance group in mWater (about 900 private `water_point` entities and the household entities created by the surveys). A second group named SaniTap holds 286 `LR-…` points that no form references; they are not the monitoring frame. Exports of real coordinates go in `data/real/`, which is git-ignored and never published.

## Testing

Mapper and audit tests (Node 18+, no dependencies):

```bash
node --test test/mapper.test.js
```

Set `PDFLIB_DIR` to a folder containing `node_modules/pdf-lib` to include the PDF determinism test.

## Filing a round

Every drawn round is filed in `records/<round>/<stratum>/` and served by Pages at `https://sanitap-water.github.io/sanitap-sampler/records/<round>/<stratum>/`:

```bash
# after "Export sampling record" put the three files in ~/Downloads (or pass paths)
node bin/file-round.js                       # newest sanitap-*-record.pdf / -audit.json / -selection.csv in ~/Downloads
node bin/file-round.js --pdf x.pdf --json x.json --csv x.csv --frame frame.csv   # explicit paths; --frame verifies the frame CSV against the audit hash
node bin/file-round.js ... --frame frame.csv --store-frame                        # also publish the frame CSV (it contains real coordinates: default is not to)
node bin/file-round.js --dry-run             # verify only
```

The script verifies that the SHA-256 of the audit JSON equals the hash in the PDF footer (`/AuditSHA256`) and that the record ids match, copies the files as `sampling-record.pdf`, `audit.json`, `selection.csv` (and `frame.csv` only with `--store-frame`; keep the frame in the private archive otherwise), appends a line to `records/index.md`, commits and pushes. The record folder is **append-only**: an existing `records/<round>/<stratum>/` is never overwritten; a re-draw gets a new seed and a new round name. The only exception is the folder `records/test/`, used for rehearsals.

## Round marking in mWater

Not live. A "Sampling round" form can be created with the org credentials (`POST /v3/forms` works), but creating responses through `POST /v3/responses` is refused for this account ("Permission denied to insert") even with the account listed as enumerator of the deployment, so the tool cannot write one response per source. The test form was soft-deleted. Until mWater support confirms a response-creation path for API clients, hand the selection to mWater with *Export mWater site list (CSV)*. `MWATER.forms.samplingRound` in `app.js` is the placeholder for the form id, deployment id and question ids; the *Mark round in mWater* button appears only when it is set.

## Deployment

Push to `main`; the workflow in `.github/workflows/deploy.yml` publishes the repository root to GitHub Pages (set *Settings → Pages → Source: GitHub Actions* once). The app is then served at

```
https://<owner>.github.io/sanitap-sampler/
```

The SaniTap-water deployment is https://sanitap-water.github.io/sanitap-sampler/.

All paths are relative, so it also works from any sub-folder or from a local file.

## References

- Gold Standard for the Global Goals, *Safe Drinking Water Supply* methodology, v2.0.
- UNFCCC CDM, *Standard: Sampling and surveys for CDM project activities and programmes of activities* (multi-stage cluster sampling; 90/10 confidence/precision).
