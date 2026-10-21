# Consent script: co-play substudy (`consent.coplay_substudy`)

**Version:** 0.1 DRAFT, 2026-10-21. English source text for recording; not approved (see the [consent index](README.md)).

**Kind:** `coplay_substudy`. **Where:** supervised sites only, Stage 2 live-dyad substudy (EPI-06), A arm;
never at open public kiosks.
**Delivered by:** administrator reads aloud, then kiosk audio; **each player consents separately**; the two
consents are linked by `coplay_group_id`.
**Decision:** each player taps yes or no. If either says no, the pair does not play together; each can still
play alone under core consent.
**Records:** consent artefact `kind: coplay_substudy` per player, `player_slot`.
**Session length:** up to 20 minutes (instead of 15) under this consent.

## Script

### Segment 1 (`consent.coplay.what`)

> We are also studying how people play together. If you both agree, you will play one more short game side
> by side on the same screen, taking turns and sharing a pot. It adds about five minutes.

### Segment 2 (`consent.coplay.partners`)

> In some parts of the games you play with pretend helpers. They are part of the game, run by the computer,
> not real people. In this extra game, your partner is the real person next to you.

### Segment 3 (`consent.coplay.rating`)

> At the end, each of you will answer a few picture questions about how it was to play with the other
> person. You will answer privately while the other person looks away. Your partner will not see your
> answers, and neither will the staff here.

### Segment 4 (`consent.coplay.voluntary`)

> You can say no, and you can stop at any time. Saying no does not affect anything else today. Your choices
> are recorded with a code, not your name.

### Decision prompt (`consent.coplay.decision`)

> Do you agree to play the extra game together? Each of you, please touch the tick for yes, or the cross for
> no, on your side of the screen.

## Deception and debriefing **[IEC REVIEW]**

- Scripted partners in the episodes are disclosed as "pretend helpers" (`partner_disclosure`). The draft
  protocol therefore uses **no deception about who the partner is**. If the IEC prefers a less explicit
  disclosure (to reduce demand effects), a debriefing script is mandatory:

> Thank you. Before you go: the helpers in the market games were run by the computer, so that everyone met
> the same helpers. Some puzzles could not be solved; that was on purpose, to see how people handle a hard
> task, and it says nothing bad about you. If you would like your game record deleted now that you know
> this, tell me and we will delete it.

- The private partner rating is never shown to the partner; ratings carry `rater_role` and both pids;
  self-rating is impossible.

## ITC notes specific to this script

- "Pretend helpers": choose a phrase that is clear but not childish; test whether participants understand
  that the helpers are not real people.
- "Looks away": show a pictogram of the partner turning around.
