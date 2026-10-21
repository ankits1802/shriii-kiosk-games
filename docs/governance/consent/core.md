# Consent script: core (`consent.core`)

**Version:** 0.1 DRAFT, 2026-10-21. English source text for recording; not approved (see the [consent index](README.md)).

**Kind:** `core`. **Where:** every kiosk session, after language selection, before any play.
**Delivered by:** pre-recorded native-speaker audio, 4 segments with pictograms, each replayable.
**Decision:** tap "yes" (tick) to play, or "no" (cross). Only a tap commits. No guardian branch.
**Records:** `consent.granted` or `consent.declined` with `tap_confirmed: true`, `consent_script_id`,
`script_audio_sha256`, language, policy version, protocol id, replay counts.
**If declined:** "Thank you. Have a good day." The session ends; only an anonymous decline counter is kept;
no session row is stored.

## Script

### Segment 1 (`consent.core.what_we_play`) — target 20 s
Pictogram: the market fair with small game scenes.

> Welcome. This is a set of short games about everyday choices at a village market fair. It takes about
> fifteen minutes. There are no right or wrong answers, and nothing here is a test. You play by touching the
> screen. You never need to read or type.

### Segment 2 (`consent.core.what_we_keep`) — target 25 s
Pictograms: a hand tapping (kept); a crossed-out microphone; a crossed-out camera; a crossed-out name tag.

> If you agree, we keep a record of what you do in the games, like which picture you touch and how long you
> take, and your answers to a few picture questions about your age group and schooling. We do not ask your
> name. We do not keep any recording of your voice. There is no camera. The record is used for research, to
> make these games fair and useful for people across India.

### Segment 3 (`consent.core.stop_and_delete`) — target 20 s
Pictograms: the hand icon; a bin.

> You can stop at any time. Touch the hand picture, and choose whether to keep or delete what you did.
> Later, you can also ask us to delete it, or ask a question or make a complaint, using the code on this
> machine or at the help desk. You can also complain to the Data Protection Board of India.

### Segment 4 (`consent.core.summary_use`) — target 20 s
Pictograms: a picture-page summary; a person thinking; crossed-out briefcase, crossed-out hospital.

> At the end you may get a short picture summary, or simply a thank-you. The summary is a snapshot of one
> game session, not a diagnosis, and it is only for you to think about. It must not be used to decide on a
> job, a loan, or anything important about you.

### Decision prompt (`consent.core.decision`) — target 8 s
Pictograms: tick and cross.

> Do you agree to play? Touch the tick for yes. Touch the cross for no.

## Notes

- Age: the age-band question that follows consent ends the session for anyone under 18 with nothing kept
  ([minors policy](../minors-policy.md)). **[IEC REVIEW]** whether the 18+ condition should also be stated
  in segment 1 ("These games are for grown-ups").
- Supervised sites: the administrator may stand by but does not answer for the participant.
- Open public kiosks: the same script; reports are not given until gates pass (thank-you mode).
- **[LEGAL REVIEW]** confirm that segments 2 and 3 plus the QR code satisfy the DPDP section 5 notice
  (itemised data, purpose, rights, complaint to the Board) for a participant who cannot read.

## ITC notes specific to this script

- "Nothing here is a test": choose the phrase that removes exam anxiety without suggesting the games are
  trivial.
- "Snapshot, not a diagnosis": avoid a medical word for "diagnosis" that people may not know; "it does not
  say anything about your health or your mind" is an acceptable adaptation if testers prefer it.
- "Data Protection Board of India": official name in the language, then "the government office that
  protects people's information".
