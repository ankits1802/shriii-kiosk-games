# Consent script: archive (`consent.archive`)

**Version:** 0.1 DRAFT, 2026-10-21. English source text for recording; not approved (see the [consent index](README.md)).

**Kind:** `archive`. **Where:** kiosk, immediately after core consent, as a separate question.
**Delivered by:** pre-recorded audio, 1 segment plus the decision; replayable.
**Decision:** separate tick, **default no**. Time-out or skip = no. Saying no changes nothing about the game.
**Records:** consent artefact `kind: archive`, `granted` true or false.
**Effect:** only sessions with archive consent can appear in de-identified research exports and the
long-term research archive (VAL-17, PRV-02 acceptance criterion).

## Script

### Segment 1 (`consent.archive.explain`) — target 25 s
Pictograms: a locked box; two researchers; a crossed-out name tag.

> One more, separate question. After this study ends, may we keep your game record, without anything that
> says who you are, in a safe research store, so that other approved researchers can study it in future?
> This is your choice. If you say no, you can still play everything, and your record is deleted when this
> study no longer needs it.

### Decision prompt (`consent.archive.decision`) — target 8 s

> Touch the tick if we may keep it for future research. Touch the cross if not.

## Notes

- Archive copies are de-identified, meet k-anonymity of at least 5, and are shared only under a data-use
  agreement. Retention proposed at 10 years **[STAKEHOLDER REVIEW]**.
- Withdrawal later removes the person from future exports and triggers notification of recipients of
  earlier exports ([retention and deletion policy](../retention-and-deletion-policy.md), section 4).
- **[LEGAL REVIEW]** whether de-identified archive data remains personal data under the DPDP Act, and so
  whether the archive needs consent at all; the programme asks for consent regardless.

## ITC notes specific to this script

- "Without anything that says who you are" must not be translated as "anonymous" if that word suggests
  something secret or illegal in the target language.
- Make the "this is your choice" sentence prominent; testers should report that saying no feels acceptable.
