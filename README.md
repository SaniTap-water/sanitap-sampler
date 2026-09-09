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
3. **1b Test A backlog** — the sources of the loaded stratum that still need an SDWS 3 test (see below); optional.
4. **2 Parameters** — enter *Drawn by*, pick the stratum, check the defaults, note the seed, press *Draw the sample*. Tabs show ✓ when a step is done.
5. **3 Draw** — read the design check, the selected sources and the audit record; press *Export sampling record* to get the VVB-facing PDF together with the audit JSON and the selection CSV it hashes.
6. **4 Map** — numbered markers (1…12, R1…R3) with the same numbers in the stop list beside the map, commune labels, and orange reach flags.
7. **5 Field sheet** — the stop list with GPS, households and the field-rule numbers; print (or *Save as PDF* on the phone).

Every tab ends with a *Next* button to the following one.

Language toggle (EN/FR) is in the header; every label lives in the `I18N` object in `app.js`.

## Inputs

### Source A — mWater (default)

The frame is fetched in the browser from the mWater API (`https://api.mwater.co/v3`, CORS is open) and mapped by `Core.mapMwaterEntities()`.

**Eligibility rule (v1.3).** A source is eligible when it

1. belongs to the MadAvance water point register (mWater group `group:aaaf0a14…`, entity type `water_point`);
2. has at least one **final** result in *Clean Water || Water Quality Testing_SDWS 3_Result* (form `7b33c5d7…`) that meets the **health-based rule**: E. coli = 0 CFU/100 mL, arsenic ≤ 10 µg/L, fluoride ≤ 1.5 mg/L (these three must be present), and, where measured, nitrate ≤ 50 mg/L and manganese ≤ 0.08 mg/L. pH, conductivity, turbidity and iron are recorded by the form but never exclude. The form has no nitrate question yet; the rule entry is in place (`q: null`) and is skipped until one exists;
3. is not abandoned: name not "abondonné / identifié / drilling / proposal / puits ouvert", latest final record of the maintenance form not *Non fonctionnel*, type not kiosk or dug well;
4. lies in a district mapped to a stratum: Taolagnaro and Amboasary-Atsimo (both Anosy) → **HP-FD**, Maroantsetra → **HP-MA**. Beloha (the Marolinta area) is outside the carbon project and excluded; any other district is *unassigned* and excluded.

The exclusions are applied in that order and counted: total in group, SDWS 3 pass count, excluded (no passing result), excluded abandoned, excluded Marolinta, unassigned, eligible per stratum. The counts appear on the Data tab, in the audit record (`input.mwater.counts`) and in the sampling record PDF. The 286 `LR-…` points of the group named SaniTap are not in the register and stay out.

| Sampler column | mWater origin |
|---|---|
| `water_point_id` | entity `code` (the id used in every mWater form) |
| `name` | `name` (pump model) + `alt_id` (pump number) |
| `stratum` | district (`admin_div2`, or the admin-region hierarchy) mapped as above, else `unassigned` |
| `commune`, `fokontany`, `village` | `admin_div3`, `admin_div4`, `admin_div5` |
| `lat`, `lon` | `location.coordinates` |
| `households_served` | latest "Nombre de toits" in *Nombre de bénéficiaires* (form `8aa2dd78…`), used as the stage-1 sampling weight and printed on the field sheet |
| `status`, `status_reason`, `sdws3_*` | result of the eligibility rule, SDWS 3 pass/result counts, last test date and the parameters that failed |
| `alt_id` | pump number as registered in mWater |

The fetched frame is serialised to CSV, hashed with SHA-256 and stored exactly like an uploaded CSV, so the audit record and the reproducibility guarantee are identical for both sources (`input.source` is `mwater` or `csv`). *Download loaded frame* gives the VVB the exact CSV that was hashed.

**Token handling.** Sign-in posts username/password once to `/v3/clients` and keeps only the returned client id; the password is never stored. The token lives in this browser's `localStorage`, is shown masked, travels only as the `?client=` query parameter, is never logged and never written to any export, audit record or PDF. The service worker never caches `api.mwater.co`. Nothing in this repository contains a credential: `MWATER` in `app.js` holds only identifiers (group id, form ids, question ids).

### Source B — CSV (offline fallback)

**Water points CSV** (mWater export), one row per point, columns:
`water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status`
(`latitude/longitude/lng` are accepted as aliases; `status` is `active`/`inactive`).

**Round parameters**: round name (e.g. `2026 R1`), *drawn by*, stratum, target number of PoU samples (default 58), households per source (default 5), replacement fraction (default 20 %), and the **seed**, prefilled as `<round without spaces>-<stratum>` (e.g. `2026R1-HP-FD`) and editable. Statistical parameters: ICC (default 0.1), expected pass rate (default 0.95), confidence (90 % default, or 95 %), precision type (relative 10 % of p — the CDM convention — or absolute ±0.10).

## How the draw works

Implemented in `Core.draw()` in `app.js`; also shown in the app under *How it works* and written out in every sampling record PDF.

**Random numbers.** The seed string is hashed with `xmur3` into a 32-bit word that seeds a `mulberry32` PRNG. All stages consume the same stream in a fixed order, so the same seed + same frame file + same parameters reproduce the same selection on any device. Records are sorted by identifier (and by commune for stage 1) before drawing, so CSV row order does not matter.

**Frame.** Sources with `status = active` in the chosen stratum (see the eligibility rule above).

**Stage 1 — sources (Protocol v2.2 §6.4, default method `pps_households`).** The eligible sources are ordered by commune then id, each with its households served (sources without a count get the stratum median; the count of imputed weights is in the audit). `n_wp = ceil(target / households_per_source)` sources are drawn by **systematic PPS**: interval = total households / n_wp, one random start in [0, interval), and the source containing start + k × interval is selected for k = 0 … n_wp − 1. Ordering by commune spreads the selection across communes in proportion to their households. A source with more households than the interval is selected with certainty and the interval is recomputed on the rest, so no source is hit twice. The **replacement list** (`ceil(replacement_fraction × n_wp)` sources) is then drawn one by one from the remaining sources with probability proportional to households, in draw order. The audit records total households, interval, random start, certainty selections and, per selected source, its weight, cumulative range and hit position.

**Stage 2 — households.** Every source uses the **field rule** of Protocol v2.2 §6.4: count the households served (K) and draw N random numbers between 1 and K (+2 replacements, kept internally); for each number k, sample the k-th household met when walking from the source. The numbers are generated when K is typed, from a PRNG seeded with `seed|water_point_id|K=K`, so they are reproducible and are appended to the audit record. Sterile equipment, no flaming; the purge and all sampling steps are recorded on the mWater form (SDWS 22 PoU) together with the record id.

**Reach check.** Each selected source is compared with the nearest other selected source and with the district town (Fort-Dauphin or Maroantsetra). A source farther than 25 km from both is flagged orange on the map, in the stop list, on the field sheet and in the PDF with the text "Far from the rest: replace in the field only if unreachable, and record the reason". The audit record keeps the distances (`reach_check`); nothing is replaced automatically.

**Statistical check.** Design effect `DEFF = 1 + (m − 1) × ICC` (m = households per point). Effective sample size `n_eff = n_wp × m / DEFF`. Required size for a proportion at expected pass rate p under the CDM 90/10 rule: `n_req = z² p(1 − p) / d²`, z = 1.645 (90 %) or 1.96 (95 %), d = 0.1 × p (relative) or 0.10 (absolute). If `n_eff < n_req` the tool warns and suggests (a) fewer households per point and hence more water points/clusters, or (b) more water points at the same m.

**Audit record.** Each draw produces a JSON record with: record id (`round-stratum-seed`), timestamp, who drew it, seed and its 32-bit seed word, algorithm, tool version and commit, input source (mWater group, forms used, fetch time, eligibility counts, frame rule) or CSV file name with the frame SHA-256, all parameters, the frame summary, stage-1 numbers, statistics, communes covered, sources (with weights and hit positions), replacements, the field rule, warnings, and, when available, the visiting order and the field-rule numbers generated with K. It is shown on screen, exported as JSON, hashed into the sampling record PDF, and is the evidence of random selection retained for the VVB.

## Outputs

- **Map**: selected sources numbered in draw order, replacements grey (`R1…`), commune labels, OSM tiles, a *Fit* button and a *Show on map: draw / Test A backlog* toggle; a stop list under the map with the same numbers (id, pump no., name, commune, fokontany, households, reach distances).
- **Field sheet** (print stylesheet): the stop list only — number, id and name, commune and fokontany, GPS, households served, K box and the pre-generated household numbers — plus the record id and the line "Sampling steps and results are recorded in the mWater form (SDWS 22 PoU); enter the record id on every form". It carries coordinates and is never filed.
- **CSV for mWater**: `round, stratum, cluster, water_point_id, order, household_id_or_rule, replacement_flag` — one row per household (or per point when only the rule applies). `replacement_flag` ∈ `none`, `household`, `water_point`, `water_point+household`.
- **Audit JSON** as described above.
- **Sampling record (PDF)**: *Export sampling record* builds, entirely in the browser with pdf-lib 1.17.1 (cdnjs, cached for offline use), a narrative record for the validator in the UI language: identification (programme, stratum, round, draw time, drawn by), method (Protocol v2.2 §6.4), frame (rule in words, mWater source and counts, frame SHA-256), randomness (seed, PRNG, exact reproduction steps), design check (n, sources, m, p, required n for 90/10, ICC, DEFF, effective n, pass/fail), tables of selected and replacement sources with K values, and a footer on every page with the record id, the audit JSON SHA-256, the tool version and commit, and page x of y. The action downloads the PDF together with the audit JSON and selection CSV it hashed. The PDF is byte-identical for the same audit record (its dates are set to the draw timestamp) and contains nothing from the API token.
- **mWater site list (CSV)**: `code, name, round, stratum, role, order, seed, drawn_at` — one row per selected and replacement point, keyed by the mWater entity code. mWater has no entity property for a monitoring round, so this file is not imported into the site register directly: import it into mWater as a *custom table* (Data → Tables → Import CSV) or attach it to the round's dashboard, and reference it from the monitoring report. Writing a round mark onto the entity itself would need a new custom property on `water_point`; the API route for that is `PATCH /v3/entities/water_point?client=…` with `{doc, base}` (same protocol as forms), which the tool does not use.

## Test A backlog

Tab **1b** lists, for the loaded stratum, the sources that are in the register and not abandoned but have no passing SDWS 3 result, in three groups: **operating, untested** (a rehabilitation record, maintenance visit or beneficiaries count exists but no SDWS 3 result), **last result failed** (tested, the latest result failed a health-based parameter; the parameter is shown), and **not yet built** ("identifié"/"drilling" names without records). Columns: id, alt_id, pump name, commune/fokontany, households served, last maintenance visit (with a *rehab* mark), last test date and result. The counts appear as tiles on the Data tab next to the eligibility counts. The Map tab can show the backlog instead of the draw, with a nearest-neighbour route from the district town (Fort-Dauphin or Maroantsetra). Two exports exist for the field team only and are never filed: a printable visit sheet per commune and a CSV, both with coordinates.

## Offline, updates and storage

After the first load `sw.js` caches the app shell and the Leaflet and pdf-lib files from cdnjs; the app then opens without a connection (map tiles and the mWater API are never cached). The cache is named after the build commit (baked into `sw.js`, `app.js` and the `app.js?v=` script URL in `index.html` by the Pages workflow, shown in the header), so a new build always loads a new script URL that no HTTP cache can serve stale. `index.html` and `app.js` are fetched network-first with revalidation, so a reload after a deploy gets the new build, and a page that stays open checks for a new worker when its tab regains focus and every 30 minutes; when a newer build activates, a banner *New version available — Reload* appears. Pages still running a build older than 1.4.0 have no banner: their first reload installs the new worker and their second reload shows the new build. Loaded CSV text, the last draw parameters and K values are kept in `localStorage` on the device; *Clear stored data* removes them. The last draw is recomputed from its stored parameters on reload (it is deterministic).

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
node bin/file-round.js --dry-run             # verify only
```

The script verifies that the SHA-256 of the audit JSON equals the hash in the PDF footer (`/AuditSHA256`) and that the record ids match, copies the files as `sampling-record.pdf`, `audit.json`, `selection.csv` (the frame CSV is verified but never copied: it holds coordinates), appends a line to `records/index.md`, commits and pushes. The record folder is **append-only**: an existing `records/<round>/<stratum>/` is never overwritten; a re-draw gets a new seed and a new round name. The only exception is the folder `records/test/`, used for rehearsals.

## Link between mWater and a sampling record

There is no write-back from the tool to mWater. The link from mWater to a sampling record is the **record id** (`<round>-<stratum>-<seed>`, printed on the sampling record and the field sheet) entered on each PoU form response in mWater. Records are published under `records/<round>/<stratum>/` on this site and copied to the monitoring report folder of the round. *Export mWater site list (CSV)* remains available to import the selected sources into an mWater custom table.

**Published record files carry no coordinates.** The sampling record PDF, the audit JSON and the selection CSV contain identifiers, pump names, communes, households served and k-values only. The field sheet (with GPS positions) and the map are downloads for the field team and are never filed; the frame CSV is kept in the private archive (`bin/file-round.js --frame` verifies its hash without publishing it). The test suite fails if any file under `records/` contains a latitude/longitude field.

## If the app shows an old version

Open `https://sanitap-water.github.io/sanitap-sampler/reset.html` (linked as *Reset app* on the *How it works* tab). The page is never cached: it unregisters every service worker and deletes every cache, keeps `localStorage` (the mWater token, settings, last draw), then loads the plain URL, which fetches the current build. `./?reset=1` does the same from inside `index.html`, but a worker older than 1.4.0 serves that address from its cache, so `reset.html` is the address to give to someone stuck on an old version. The header shows the build hash to confirm.

## Reconciliation (SDWS 3 and crediting)

```bash
node bin/reconcile.js --env ~/mwater-mcp/.env        # or MWATER_TOKEN / MWATER_USERNAME+MWATER_PASSWORD in the environment
```

Writes `sdws3_reconciliation.csv` to the Windows Downloads folder (`/mnt/c/Users/bushp/Downloads`, else `~/Downloads`) with one row per water point of the MadAvance group and no coordinates: id, alt_id, registered pump name, pump type from maintenance, name pattern (identifié / drilling / abandonné / normal), district, commune, stratum, eligibility status and reason, SDWS 3 tested (Y/N), last test date, passes the health rule (Y/N), failing parameters, eligible (Y/N), installation date (earliest end-of-works date of a rehabilitation record), rehabilitation record (Y/N, from the maintenance form's *Première réhabilitation* records and the *Suivi avancement nouveau forage et réhabilitation* form; no form is named SDWS 2), last maintenance visit, households served (*Nombre de toits*), first seen (earliest response referencing the point in any programme form that links water points), and `status_for_crediting`:

| Status | Rule |
|---|---|
| `outside-carbon` | district Beloha (Marolinta) |
| `abandoned` | name "abondonné" or latest maintenance record not functional |
| `credited-eligible` | rehabilitation record and a passing SDWS 3 result (and eligible) |
| `operating-untested` | rehabilitation record, maintenance visit or beneficiaries count, but no SDWS 3 result |
| `not-yet-built` | name "identifié" or "drilling" and no records |
| `other` | anything else; `crediting_note` says why (tested but failing, passing without rehabilitation record, no records) |

`marolinta_class` classifies the Marolinta register entries, which are not all pumps: `rehabilitated` (a rehabilitation record or end-of-works date), `new borehole` (name contains forage/drilling/nouveau and first seen in 2026), `assessment` (first seen in the August 2025 assessment series, no rehabilitation record) or `other`. `duplicate_candidate` (Y/N) and `duplicate_pair_ids` flag probable duplicate register entries there: the commune holds about 90 entries for about 50 real points, from an August 2025 assessment series (generic names IndiaMark / Pompe à cordes / Puits ouvert, first seen 2025-08-22 to 24), a June 2026 registration series (first seen 2026-06-11 to 16) and "Drilling" placeholders. Entries of different series in the same commune within 50 m of each other are flagged and printed as pairs; coordinates are used for the check but never written.

_Generated 2026-09-09 by `bin/reconcile.js` from 908 water points of the MadAvance group, 732 final SDWS 3 results, rehabilitation records for 784 points._

**Per district × crediting status**

| district | total | credited-eligible | operating-untested | not-yet-built | abandoned | outside-carbon | other |
|---|---|---|---|---|---|---|---|
| (none) | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| Amboasary-Atsimo | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| Ampanihy Ouest | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| Antananarivo Renivohitra | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| Beloha | 91 | 0 | 0 | 0 | 0 | 91 | 0 |
| Maroantsetra | 636 | 599 | 9 | 0 | 14 | 0 | 14 |
| Moramanga | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| Taolagnaro | 176 | 124 | 7 | 0 | 40 | 0 | 5 |
| TOTAL | 908 | 723 | 16 | 1 | 55 | 91 | 22 |

"Other" breakdown: no records 15; passing SDWS 3, no rehabilitation record 4; tested, failing 3.

Marolinta (Beloha): 27 programme pumps (rehabilitated 13 + new boreholes 14) among 90 register entries, outside the carbon frame; 24 assessment entries (Aug 2025) and 39 other. Probable duplicate register entries (different series within 50 m): 47 entries in 31 pairs, flagged in `duplicate_candidate`.

**Operating but untested (16)**

| id | alt_id | name | district | commune | last_maintenance_visit | households_served | records |
|---|---|---|---|---|---|---|---|
| 847071188 |  | Point d'eau identifié | Maroantsetra | Andranofotsy | 2025-05-30 |  | maintenance |
| 841871296 |  | Point d'eau identifié | Maroantsetra | Anjanazana | 2025-05-30 |  | maintenance |
| 846562715 |  | Point d'eau identifié | Maroantsetra | Anjanazana | 2025-05-30 |  | maintenance |
| 905251482 | N/A | Pompe aspirante  | Maroantsetra | Anjanazana | 2025-05-30 |  | maintenance |
| 905251499 |  | Canzee | Maroantsetra | Anjanazana | 2025-05-30 |  | maintenance |
| 833033404 |  | Point d'eau identifié | Maroantsetra | Ankofabe | 2025-05-30 |  | maintenance |
| 833033411 |  | Point d'eau identifié | Maroantsetra | Ankofabe | 2025-05-30 |  | maintenance |
| 833066068 |  | IndiaMark | Maroantsetra | Maroantsetra | 2025-05-29 |  | maintenance |
| 835481092 |  | Canzee | Maroantsetra | Maroantsetra | 2025-05-29 |  | maintenance |
| 987623074 |  | Canzee | Taolagnaro |  | 2025-08-22 |  | maintenance |
| 742895223 |  | Canzee | Taolagnaro | Mahatalaky | 2024-05-30 |  | rehab+maintenance |
| 742895357 |  | Canzee | Taolagnaro | Mahatalaky | 2024-06-01 |  | rehab+maintenance |
| 742895364 |  | Canzee | Taolagnaro | Mahatalaky | 2024-06-01 |  | rehab+maintenance |
| 742895388 |  | Canzee | Taolagnaro | Mahatalaky | 2024-06-01 |  | rehab+maintenance |
| 742895711 |  | Canzee | Taolagnaro | Manantenina | 2025-01-17 |  | rehab+maintenance |
| 742895113 |  | Canzee | Taolagnaro | Ranopiso | 2025-04-27 |  | rehab+maintenance |

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
