# Consent script: contact (`consent.contact`)

**Version:** 0.1 DRAFT, 2026-10-21. English source text for recording; not approved (see the [consent index](README.md)).

**Kind:** `contact`. **Where:** kiosk, **after** the summary or thank-you screen (so it does not use play
time), supervised and open public modes.
**Delivered by:** pre-recorded audio; phone digits confirmed by **picture-digit tiles on screen, or audio
through a headset only, never through the speakers** (`contact_readback_mode`).
**Decision:** one yes/no, **default no**. Time-out or skip = no.
**Records:** consent artefact `kind: contact`; event `optin.contact` (boolean only). The number goes only to
the identity vault; it never appears in event tables (ONB-03 acceptance criterion).
**After yes:** a pseudonymous retest token is printed or shown as a QR code.

## Script

### Segment 1 (`consent.contact.explain`) — target 25 s
Pictograms: a phone; a calendar showing about two weeks; the market fair again.

> Thank you for playing. May we call you in about two to four weeks, to invite you to play once more? It
> helps us check that the games give steady results. If you say yes, we keep your phone number separately,
> only for this invitation, and delete it when the study ends. We will not use it for anything else, and we
> will not give it to anyone.

### Decision prompt (`consent.contact.decision`) — target 8 s

> Touch the tick if we may call you. Touch the cross if not.

### Number entry (`consent.contact.enter_number`) — target 10 s
Pictograms: the picture-digit pad.

> Please touch the pictures for each number of your phone. You can check the numbers on the screen.
> [If a headset is connected:] You can also listen to the numbers in the headset.

### Confirmation (`consent.contact.confirm`) — target 10 s

> Is this your number? Touch the tick if it is right, or the back arrow to change it.

### Token (`consent.contact.token`) — target 15 s
Pictograms: the printed card or QR code.

> Please keep this card. Bring it when you come back. You can also use it to ask us to delete your
> information or to stop the calls.

## Notes

- Reminder calls are pre-recorded native-speaker IVR calls by default; SMS is optional. Each call offers a
  keypress to stop further calls, which deletes the number.
- The send path refuses anyone without a contact consent (CRT-10 acceptance criterion).
- **[IEC REVIEW]** whether a reminder call may mention the study name (privacy if someone else answers the
  phone). Draft wording avoids the purpose: "a game you played at [site]".

## ITC notes specific to this script

- "Two to four weeks": say it in the everyday form; testers check it is not heard as "two or four days".
- Digit read-back clips in the headset use the regional way of saying phone numbers (in groups, or digit by
  digit), decided in think-aloud testing.
