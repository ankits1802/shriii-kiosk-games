# Consent script: speech-recognition evaluation (`consent.asr_eval`)

**Version:** 0.1 DRAFT, 2026-10-21. English source text for recording; not approved (see the [consent index](README.md)).

**Kind:** `asr_eval`. **Where:** supervised sites only, ASR bake-off (VOX-06). Not available at open public
kiosks (PRV-03 acceptance criterion).
**Delivered by:** administrator reads aloud and answers questions; the participant taps on the
administrator device.
**Decision:** tap yes or no, **default no**. Saying no does not affect taking part in anything else.
**Records:** consent artefact `kind: asr_eval`.
**What is recorded:** short clips of the participant saying a fixed list of words (for example "yes", "no",
colour and object names used in the games), plus age band, gender and background noise level. Recordings
are encrypted and use the separate `asr_eval` schema; they never enter game data.
**Deletion:** within 30 days of the signed bake-off report, and no later than 6 months after recording.

## Script

### Segment 1 (`consent.asr.purpose`)

> We want the games to understand a few spoken words, like "yes" and "no", for people who prefer to speak
> instead of touching the screen. To test this fairly for men and women, young and old, we would like to
> record you saying a short list of words. It takes about five minutes.

### Segment 2 (`consent.asr.what_kept`)

> Only these short word recordings are kept, together with your age group and whether you are a man or a
> woman. We do not record anything else you say. The recordings are locked, used only to test the computer
> programs, and deleted after the test, within six months at the latest.

### Segment 3 (`consent.asr.voluntary`)

> You can say no, stop at any time, or ask us to delete your recordings. This does not affect anything else
> today. Questions or complaints: the help desk, [phone number], or the Data Protection Board of India.

### Decision prompt (`consent.asr.decision`)

> May we record you saying the words? Touch the tick for yes, or the cross for no.

## Notes

- Voice tone is never used as a trait signal; these clips measure recogniser accuracy only.
- Gender is asked with a "prefer not to say" option; clips without gender are still usable for overall
  accuracy. **[IEC REVIEW]** wording of the gender question in each language.
- **[LEGAL REVIEW]** voice recordings may be identifying; confirm that the safeguards and the deletion period
  are adequate.

## ITC notes specific to this script

- The word list itself is localised per language and region; the script refers to "a short list of words"
  so it does not need re-recording when the list changes.
