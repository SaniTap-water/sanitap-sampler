# Annex D — Random selection of sources and households for PoU/PoC water quality testing

*Annex to the SaniTap Water Quality Testing Protocol. Applies to monitoring under the Gold Standard "Safe Drinking Water Supply" (SDWS) methodology v2.0.*

**Live tool:** https://sanitap-water.github.io/sanitap-sampler/ — source code and version history at https://github.com/SaniTap-water/sanitap-sampler.

## 1. Purpose and standard

This annex describes how the sources (water points) and households tested in each monitoring round are selected. The selection is a **two-stage cluster sample** (Protocol section 6.4) drawn in accordance with the CDM *Standard: Sampling and surveys for CDM project activities and programmes of activities* (UNFCCC, EB, latest version), which the Gold Standard accepts for sampling under SDWS. Selection is performed with the open-source **SaniTap Sampler** tool, which runs entirely on the sampler's phone or laptop, works offline once loaded and records every draw.

## 2. Sampling frame and stratification

Inputs are the **water points fetched from mWater by the tool at the time of the draw, or a CSV export of the same register when offline**. The frame is the MadAvance water point register in mWater. A source is eligible when it has at least one final water quality result in the form *Water Quality Testing_SDWS 3_Result* that meets the health-based rule (E. coli = 0 CFU/100 mL, arsenic ≤ 10 µg/L, fluoride ≤ 1.5 mg/L and, where measured, nitrate ≤ 50 mg/L and manganese ≤ 0.08 mg/L; pH, conductivity, turbidity and iron do not exclude), is not abandoned, identified-only, proposed, reported not functional in its latest maintenance record or of a non-hand-pump type, and lies in a stratum district. Strata are **HP-FD** (hand pumps, Taolagnaro district) and **HP-MA** (hand pumps, Maroantsetra district); the Marolinta area (Beloha and Amboasary districts) is excluded and any other district is unassigned. Each stratum is sampled separately with its own seed, so that each stratum meets the sample size requirement on its own. The tool records the source (mWater or CSV), the fetch time, the exclusion counts and the SHA-256 hash of the frame it used. Households served per source come from the *Nombre de bénéficiaires* form and are the stage-1 weights.

## 3. Sampling stages

| Stage | Unit | Method |
|---|---|---|
| 1 | Source (water point) | The eligible sources of the stratum are listed by commune then id with their households served. ⌈target samples ÷ households per source⌉ sources are drawn by **systematic sampling with probability proportional to households served**: one random start, then every interval of households; ordering by commune spreads the selection across communes. A source larger than the interval is taken with certainty. A **replacement list** (default 20 % of the selection) is then drawn from the remaining sources, again proportional to households, and kept in draw order. |
| 2 | Household | The **field rule**: the sampler counts the households served by the source (K), numbers them clockwise from the source starting at the nearest, and the tool draws N random numbers between 1 and K (default 5, plus 2 replacements) from the round seed, the source id and K. |

Replacement sources and households are used strictly in the listed order and only when a primary unit cannot be sampled (pump broken, household absent after two visits, refusal). The reason is written on the field sheet and in mWater.

At each selected source one **point-of-collection (PoC)** sample is taken after disinfection of the spout and flushing on each day households of that source are sampled, so that every **point-of-use (PoU)** sample taken from the stored drinking water of a selected household is paired with a PoC sample of the same source and day, following the main protocol.

## 4. Randomness and reproducibility

All random numbers come from the *mulberry32* pseudo-random generator seeded with a 32-bit hash (*xmur3*) of a seed text of the form `<round>-<stratum>` (for example `2026R1-HP-FD`). The same seed, input file and parameters always reproduce the same selection on any device, which allows the VVB to re-run the draw. The seed is fixed **before** fieldwork and written in the monitoring report.

## 5. Sample size and precision

The sample size per stratum is set so that the proportion of samples meeting the water quality criterion is estimated with **90 % confidence and 10 % precision** (the CDM "90/10" rule for small-scale activities). Because households sampled at the same water point are correlated, the design effect DEFF = 1 + (m − 1) × ICC is applied (m households per point, ICC 0.1 unless monitoring data justify another value), and the effective sample size n/DEFF must be at least the CDM requirement n = z² p(1 − p)/d² (z = 1.645, p = expected pass rate, d = 0.1 × p). The tool performs this check and refuses to declare a draw compliant if it fails; the sampler then reduces households per point (more water points and clusters) or increases the number of water points.

## 6. Evidence retained for verification

For every draw the tool produces an **audit record** (JSON) containing: record id, timestamp, who drew it, seed, algorithm and tool version, source and SHA-256 hash of the frame, eligibility counts, all parameters, stage-1 numbers (total households, interval, random start), the selected sources with their weights and hit positions, the replacements, and the field rule (with the numbers generated once K was entered). The tool also produces a **sampling record (PDF)** that narrates the method, frame, randomness, design check and selection for a validator and carries the audit record's SHA-256 in its footer. Both, with the selection CSV, are filed under `records/<round>/<stratum>/` in the tool's repository, published at `https://sanitap-water.github.io/sanitap-sampler/records/` and copied to the monitoring report folder of the round; they carry no coordinates (the frame file and the field sheets stay in the private archive). The link from mWater to the record is the **record id** (`<round>-<stratum>-<seed>`) entered on each PoU form response. **The audit record and the sampling record are the evidence of random selection retained for the validation and verification body (VVB).**

## 7. Deviations

Any deviation (cluster inaccessible, replacement exhausted, seed changed) is documented in the monitoring report with the reason and its effect on the sample size assessed with the tool's statistical check.
