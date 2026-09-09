# SaniTap Sampler

A static, offline-capable web tool that draws **statistically valid, logistics-aware water quality monitoring samples** for the SaniTap programme under the Gold Standard *Safe Drinking Water Supply* (SDWS) methodology v2.0.

**Live tool:** https://sanitap-water.github.io/sanitap-sampler/ (deployed from `main` by GitHub Actions; works offline after the first load).

Plain HTML/CSS/JS, no build step, no backend, no accounts. All data stays in the browser. Map by [Leaflet](https://leafletjs.com) (cdnjs) with OpenStreetMap tiles.

```
index.html   app shell, styles, print stylesheet
app.js       Core (PRNG, CSV, draw, statistics, exports) + i18n object + UI
sw.js        service worker: caches the app shell for offline use (tiles are never cached)
data/sample-water-points.csv   60 fake points, 3 strata (FD, MA, AM), 4 inactive
data/sample-households.csv     161 fake households for the FD stratum
docs/protocol-annex.md         one-page annex for the SaniTap Water Quality Testing Protocol
.github/workflows/deploy.yml   GitHub Pages deployment
```

## Quick start

1. Open the app (GitHub Pages URL below, or just open `index.html` locally / serve the folder with `python3 -m http.server`).
2. **1 Data** — default source is **mWater (live)**: open *mWater connection*, sign in (or paste a token), choose the stratum and press *Fetch from mWater*. Fallback: switch to **CSV file (offline)** and load the water point CSV (and optionally a household CSV), or press *Load sample data*.
3. **2 Parameters** — pick the stratum, check the defaults, note the seed, press *Draw the sample*.
4. **3 Draw** — read the statistical check, the selected points and the audit record; export CSV and JSON.
5. **4 Map** — set a start point to get the visiting order; optionally draw custom axis clusters.
6. **5 Field sheet** — print (or *Save as PDF* on the phone).

Language toggle (EN/FR) is in the header; every label lives in the `I18N` object in `app.js`.

## Inputs

### Source A — mWater (default)

The frame is fetched in the browser from the mWater API (`https://api.mwater.co/v3`, CORS is open) and mapped to the sampler columns by `Core.mapMwaterEntities()`:

| Sampler column | mWater origin |
|---|---|
| `water_point_id` | entity `code` (the id used in every mWater form and the site list) |
| `name` | `name` (pump model: Canzee, IndiaMark, …) + `alt_id` (pump number) |
| `stratum` | district: `admin_div2`, or the admin-region hierarchy when the entity has no `admin_div` fields → `FD` Taolagnaro/Fort-Dauphin, `MA` Maroantsetra, `BE` Beloha, `AM` Amboasary-Atsimo (table `MWATER.strata` in `app.js`) |
| `commune`, `fokontany`, `village` | `admin_div3`, `admin_div4`, `admin_div5` (or the admin-region hierarchy) |
| `lat`, `lon` | `location.coordinates` |
| `households_served` | latest "Nombre de toits" in the *Nombre de bénéficiaires* form |
| `status` | `active` unless the name marks an abandoned/identified/proposal point, the latest final *Première réhabilitation / Entretien / Réparation* record says *Non fonctionnel*, or the type is kiosk/dug well. The reason is kept in `status_reason`. |

Water points belong to the MadAvance operator group and are **private**, so a token is required. Registered households are taken from the survey responses that link a household code to a water point code (*Baseline Cbn&Gender*, *Project Cbn&Gender*, *Hygiene&San*); points without such links use the field rule. The fetched frame is serialised to CSV, hashed with SHA-256 and stored exactly like an uploaded CSV, so the audit record and the reproducibility guarantee are identical for both sources (`input.source` is `mwater` or `csv`). *Download loaded frame* gives the VVB the exact CSV that was hashed.

**Token handling.** Sign-in posts username/password once to `/v3/clients` and keeps only the returned client id; the password is never stored. The token lives in this browser's `localStorage`, is shown masked, travels only as the `?client=` query parameter, is never logged and never written to any export or audit record. The service worker never caches `api.mwater.co`. Nothing in this repository contains a credential: `MWATER` in `app.js` holds only identifiers (group id, form ids, question ids).

### Source B — CSV (offline fallback)

**Water points CSV** (mWater export), one row per point, columns:
`water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status`
(`latitude/longitude/lng` are accepted as aliases; `status` is `active`/`inactive`).

**Households CSV** (optional): `household_id, water_point_id, name_or_code, lat, lon`.

**Round parameters**: round name (e.g. `2026 R1`), stratum, target number of PoU samples (default 58), households per water point (default 5), number of clusters to select (default: automatic, see below), replacement fraction (default 20 %), household replacements per point (default 2), and the **seed**, prefilled as `<round without spaces>-<stratum>` (e.g. `2026R1-FD`) and editable. Statistical parameters: ICC (default 0.1), expected pass rate (default 0.95), confidence (90 % default, or 95 %), precision type (relative 10 % of p — the CDM convention — or absolute ±0.10).

## How the draw works

Implemented in `Core.draw()` in `app.js`; also shown in the app under *How it works*.

**Random numbers.** The seed string is hashed with `xmur3` into a 32-bit word that seeds a `mulberry32` PRNG. All stages consume the same stream in a fixed order, so the same seed + same input file + same parameters reproduce the same selection on any device. Eligible records are sorted by `water_point_id` (and clusters by name, households by `household_id`) before drawing, so CSV row order does not matter.

**Frame.** Water points with `status = active` in the chosen stratum.

**Stage 1 — clusters (PPS).** Clusters are communes, or custom *axes*: polygons drawn on the map, stored in `localStorage` and exportable/importable as JSON (a point belongs to the first axis containing it; points outside every axis are excluded with a warning). Clusters are selected sequentially **with probability proportional to their number of eligible water points, without replacement**: draw u ~ U[0, total), walk the cumulative sizes, take the cluster hit, remove it, repeat. The default number of clusters is the smallest *k* such that the *k smallest* clusters together hold the required number of points (selected + replacements), which guarantees any PPS draw has enough points; the user can override it.

**Stage 2 — water points (SRS).** In the pooled eligible points of the selected clusters, simple random sampling without replacement (uniform index into the remaining pool) until `n_wp = ceil(target / households_per_point)` points are chosen. Then a **replacement list of `ceil(replacement_fraction × n_wp)` points** is drawn the same way, in random order (with the fraction set to 100 % the list has the same size as the selection). If the selected clusters hold fewer points than needed the tool warns and asks for more clusters.

**Stage 3 — households.** For every selected and replacement point:
- if a household list is loaded: SRS of N households + 2 replacements from those linked to the point (all taken, with a warning, if fewer exist);
- otherwise a **field rule**: *number the households clockwise from the pump starting at the nearest; count them (K); take N random numbers between 1 and K (+2 replacements).* When K is typed on the phone (results table or field sheet) the numbers are generated from a PRNG seeded with `seed|water_point_id|K=K`, so they are reproducible and are appended to the audit record.

**Statistical check.** Design effect `DEFF = 1 + (m − 1) × ICC` (m = households per point). Effective sample size `n_eff = n_wp × m / DEFF`. Required size for a proportion at expected pass rate p under the CDM 90/10 rule: `n_req = z² p(1 − p) / d²`, z = 1.645 (90 %) or 1.96 (95 %), d = 0.1 × p (relative) or 0.10 (absolute). If `n_eff < n_req` the tool warns and suggests (a) fewer households per point and hence more water points/clusters, or (b) more water points at the same m.

**Audit record.** Each draw produces a JSON record with: timestamp, seed and its 32-bit seed word, algorithm, input file names and SHA-256 hashes, all parameters, the frame (clusters and sizes, unassigned points), statistics, selected clusters (with draw order), water points, replacements, households or field rule, warnings, and, when available, the visiting order and the field-rule numbers generated with K. It is shown on screen, exported as JSON, and is the evidence of random selection retained for the VVB.

## Outputs

- **Map**: selected points numbered (by visiting order once a start point is set), replacements grey (`R1…`), cluster boundaries (convex hull of each commune's points, or axis polygons), nearest-neighbour route from a start point chosen by tapping the map, using the phone's GPS, or picking a water point; leg and cumulative straight-line distances (haversine).
- **Field sheet** (print stylesheet): one page per water point with the household list or the field rule (K box, generated numbers), PoC sample and boundary-condition checklist (spout disinfection, PoC sample, container disinfection), spaces for times, sample IDs and signature. Replacement points are marked.
- **CSV for mWater**: `round, stratum, cluster, water_point_id, order, household_id_or_rule, replacement_flag` — one row per household (or per point when only the rule applies). `replacement_flag` ∈ `none`, `household`, `water_point`, `water_point+household`.
- **Audit JSON** as described above.
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

Core logic runs in Node without a browser:

```bash
node -e "
const C=require('./app.js'),fs=require('fs');
const wp=C.normaliseWaterPoints(C.parseCsv(fs.readFileSync('data/sample-water-points.csv','utf8')).records).points;
const hh=C.normaliseHouseholds(C.parseCsv(fs.readFileSync('data/sample-households.csv','utf8')).records);
const P={roundName:'2026 R1',stratum:'FD',target:58,hhPerPoint:5,nClusters:null,replacementFraction:0.2,seed:'2026R1-FD',clusterMode:'commune',icc:0.1,expectedPass:0.95,confidence:'0.90',precision:0.1,precisionType:'relative',hhReplacements:2,timestamp:'t'};
const a=C.draw(P,wp,hh,[]),b=C.draw(P,wp,hh,[]);
console.log('reproducible:',JSON.stringify(a.audit)===JSON.stringify(b.audit));
console.log(a.selected.map(w=>w.water_point_id).join(' '));
console.log(C.toCsv(a).split('\n').slice(0,3).join('\n'));"
```

With the sample data and seed `2026R1-FD` the FD draw selects
`WP-FD-018 WP-FD-003 WP-FD-014 WP-FD-009 WP-FD-015 WP-FD-017 WP-FD-016 WP-FD-011 WP-FD-008 WP-FD-005 WP-FD-002 WP-FD-004` with replacements `WP-FD-013 WP-FD-020 WP-FD-006`.

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
