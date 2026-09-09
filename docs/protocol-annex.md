# Annex X — Random selection of water points and households for PoU/PoC water quality testing

*Annex to the SaniTap Water Quality Testing Protocol. Applies to monitoring under the Gold Standard "Safe Drinking Water Supply" (SDWS) methodology v2.0.*

## 1. Purpose and standard

This annex describes how the water points and households tested in each monitoring round are selected. The selection is a **multi-stage cluster sample** drawn in accordance with the CDM *Standard: Sampling and surveys for CDM project activities and programmes of activities* (UNFCCC, EB, latest version), which the Gold Standard accepts for sampling under SDWS. Selection is performed with the open-source **SaniTap Sampler** tool, which runs entirely on the sampler's phone or laptop, needs no connection and records every draw.

## 2. Sampling frame and stratification

The frame is the mWater register of project water points. Only water points with status *active* are eligible. Each stratum (project area or technology group as defined in the monitoring plan) is sampled separately with its own seed, so that each stratum meets the sample size requirement on its own.

## 3. Sampling stages

| Stage | Unit | Method |
|---|---|---|
| 1 | Geographic cluster (commune, or a custom "axis" polygon defined for logistics) | Selection **with probability proportional to size** (number of eligible water points), sequentially and without replacement. The number of clusters defaults to the smallest number whose smallest members can hold the required water points; the sampler may increase it. |
| 2 | Water point | **Simple random sampling without replacement** among the eligible water points of the selected clusters, until ⌈target samples ÷ households per point⌉ points are selected. A replacement list (default 20 % of that number) is then drawn in random order. |
| 3 | Household | If a register of households served exists: simple random sample of N households (default 5) plus 2 replacements. Otherwise the **field rule**: the sampler counts the households served by the pump (K), numbers them clockwise from the pump starting at the nearest, and the tool draws N random numbers between 1 and K (plus 2 replacements) from the round seed. |

Replacement water points and households are used strictly in the listed order and only when a primary unit cannot be sampled (pump broken, household absent after two visits, refusal). The reason is written on the field sheet and in mWater.

At each selected water point one **point-of-collection (PoC)** sample is taken after disinfection of the spout and flushing, and one **point-of-use (PoU)** sample is taken from the stored drinking water of each selected household, following the main protocol.

## 4. Randomness and reproducibility

All random numbers come from the *mulberry32* pseudo-random generator seeded with a 32-bit hash (*xmur3*) of a seed text of the form `<round>-<stratum>` (for example `2026R1-FD`). The same seed, input file and parameters always reproduce the same selection on any device, which allows the VVB to re-run the draw. The seed is fixed **before** fieldwork and written in the monitoring report.

## 5. Sample size and precision

The sample size per stratum is set so that the proportion of samples meeting the water quality criterion is estimated with **90 % confidence and 10 % precision** (the CDM "90/10" rule for small-scale activities). Because households sampled at the same water point are correlated, the design effect DEFF = 1 + (m − 1) × ICC is applied (m households per point, ICC 0.1 unless monitoring data justify another value), and the effective sample size n/DEFF must be at least the CDM requirement n = z² p(1 − p)/d² (z = 1.645, p = expected pass rate, d = 0.1 × p). The tool performs this check and refuses to declare a draw compliant if it fails; the sampler then reduces households per point (more water points and clusters) or increases the number of water points.

## 6. Evidence retained for verification

For every draw the tool produces an **audit record** (JSON) containing: timestamp, seed, algorithm, name and SHA-256 hash of the input files, all parameters, the frame (clusters and their sizes), the selected clusters, water points, replacements, and the selected households or field rule (with the numbers generated once K was entered). The audit record, the exported selection CSV imported into mWater, and the signed field sheets are filed with the monitoring report for the round. **The audit record is the evidence of random selection retained for the validation and verification body (VVB).**

## 7. Deviations

Any deviation (cluster inaccessible, replacement exhausted, seed changed) is documented in the monitoring report with the reason and its effect on the sample size assessed with the tool's statistical check.
