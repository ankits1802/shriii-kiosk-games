# Cultural adaptation review (VOX-07, VOX-08, CRT-08)

This folder holds the material the field team uses to check that every game scenario means the same thing in
each pilot language and region, before Stage 2. It covers Stage 1 exit gate 3 in plan section 7.3: a
cultural-equivalence sign-off per scenario by region, age band and gender.

| File | What it is |
|---|---|
| `scenarios/market.yaml` | The village market fair setting: stalls, fruit, props |
| `scenarios/bribe.yaml` | Bribe and overpayment dilemmas at the Weighing Post |
| `scenarios/weighing.yaml` | Weighmaster role, needle, spoken quantities, the new left-lean rule |
| `scenarios/customer-rudeness.yaml` | Customer tone levels at the Stall, with a tone-ordering acceptance test |
| `scenarios/partner-sharing.yaml` | Share-the-Pot, fuel sharing, co-play credit and blame |
| `scenarios/dice-luck-tokens.yaml` | Private dice, luck tokens, "lucky" stalls |
| `scenarios/gender-roles.yaml` | Gender of the guide, customers, weighmaster, partners and voices |
| `regions.yaml` | Regions per language, age bands and genders that make up the sign-off cells |
| `itc-checklist.yaml` | The 18 ITC Guidelines (2nd ed., 2017) mapped to project evidence and open gaps |

## Each scenario sheet has

- **appears_in / lines**: the modules and catalogue line IDs the scenario touches.
- **locked_elements**: scored parameters that no variant may change (VOX-08 rejects such overlays).
- **adaptable_surface**: what a regional variant pack may change (art, props, wording, voice casting).
- **construct_risks**: how a cultural difference could change what the scenario measures.
- **universal_probes**: think-aloud questions asked in every region, given in English, Hindi, Marathi and
  Tamil, each with a *listen for* note. The probe translations are drafts and go through the same review
  as the recording scripts.
- **regions**: known considerations, candidate surface adaptations and extra region probes for each language.
- **observer_codes**: the CRT-08 codebook (confusion, misunderstood instruction, reading-dependent screen,
  digit-dependent decision, cultural mismatch, strategy).
- **signoff**: the cells, decision options (`equivalent`, `equivalent_with_surface_change`,
  `not_equivalent_redesign`), rules and who signs.

## How to use it in Stage 1

1. Before fieldwork, the expert panel for each language reads the sheets with the recording scripts
   (`content/i18n/translations/<lang>.yaml`) and adds any local knowledge to the region sections.
2. During each think-aloud session (kiosk in think-aloud mode, CRT-08), the observer codes against the
   codebook. After each module, ask the universal probes for every scenario that module touches, then the
   region probes.
3. After each region's sessions, fill one sign-off record per scenario × age band × gender (template in each
   sheet) and commit it to `governance/` (PLT-09), signed by the field researcher, a cultural expert reviewer
   and the ITC lead.
4. A surface change becomes a variant pack (VOX-08). In the pilot only one variant per language is allowed,
   and a variant is a form, so it enters the invariance and DIF checks (VAL-08/09).
5. When a probe exposes a wording problem, flag the line for revision through the spreadsheet round-trip
   (`shriii-i18n export` / `import`) so the change is recorded in the ITC trail.

`tools/i18n` tests check that every sheet covers all three languages, that probe translations are in the
right script, that referenced line IDs and modules exist, and that every in-repo evidence path in the ITC
checklist exists.
