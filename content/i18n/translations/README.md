# Recording-script translations (VOX-07)

One YAML file per pilot language holds the spoken recording script for every line in
`content/i18n/lines.yaml` (which is read-only here).

| File | What it is |
|---|---|
| `hi-IN.yaml`, `mr-IN.yaml`, `ta-IN.yaml` | Script, back-translation, register note, translator note, ITC status and sign-off history per line |
| `workflow.yaml` | ITC statuses, allowed transitions (forward-only), sign-off roles, field locks, pack eligibility, duration thresholds |
| `register-guide.yaml` | Register and tone guidance per language, tone notes for voice directors, and the machine-checked glossary |

## Current state

All 184 lines are drafted in Hindi (Devanagari), Marathi (Devanagari) and Tamil (Tamil script) with the status
`draft_machine_needs_native_review`. They are machine (LLM-assisted) drafts written as spoken recording scripts:
warm, respectful and simple, with no words that need schooling to understand. The back-translations are the
drafter's own literal English renderings, there for ITC review. **Nothing here has been checked by a native
speaker yet**, and nothing may be recorded until a line has gone through native forward translation,
independent back-translation and expert review.

Choices worth checking first (each is explained in the line's `translator_note`):

- Greetings are adapted: नमस्ते (hi), नमस्कार (mr), வணக்கம் (ta).
- Hindi lines addressed to the player avoid gendered verb forms (for example
  `... आपकी ख़ूबी है` instead of `आप ... करते/करती हैं`). Marathi and Tamil address forms are gender-neutral already.
- Tamil is written in standard spoken Tamil (`-ங்க` forms), not the formal written register.
- Language-face lines (`onboarding.language_face.*`, `onboarding.language_confirm.*`) are recorded only in their
  own language. The other versions have `record: false` and are kept only for review.
- Hindi `feedback.wrong_sound_hint` is still estimated at 1.65x its 1.3 s target. `validate --warnings` reports it
  so the panel can shorten the line or agree a new target.

## Workflow

```
draft_machine_needs_native_review -> forward_translated -> back_translated -> expert_reviewed
  -> recorded -> audio_qc -> think_aloud_tested -> approved      (any step -> flagged_for_revision -> forward_translated)
```

Edit only through the spreadsheet round-trip in `tools/i18n` (see its README). Every status change needs a
sign-off from the right role. Production packs take only `approved` lines. Pilot packs may also take
`think_aloud_tested` lines and are marked as pilot packs.
