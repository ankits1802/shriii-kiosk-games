# Consent scripts

**Version:** 0.1 DRAFT, 2026-10-21. **Owner:** Ethics Officer. **Approvers:** Ethics Officer, IEC, DPO.
**Plan features:** ONB-02, ONB-03, PRV-02, PRV-03, VOX-07, EPI-06, VOX-06, CRT-08. **Contract:** `consent-artefact.v1`.

These are the **English source texts** for the consent recordings. They are written to be spoken, not read.
Each kind of consent has its own script and its own decision; one never implies another.

| Kind (`consent_kind`) | Script | Where | Delivered by | Default |
|---|---|---|---|---|
| `core` | [core.md](core.md) | Every kiosk session | Kiosk audio + pictograms | Must tap "yes" to play |
| `archive` | [archive.md](archive.md) | Kiosk, right after core | Kiosk audio, separate tick | No |
| `contact` | [contact.md](contact.md) | Kiosk, after the report or thank-you | Kiosk audio | No (time-out = no) |
| `criterion` | [criterion.md](criterion.md) | Supervised sites | Administrator reads aloud (or plays audio) | Must tap "yes" to join |
| `coplay_substudy` | [coplay_substudy.md](coplay_substudy.md) | Supervised sites, Stage 2 | Administrator + kiosk audio, per player | No |
| `asr_eval` | [asr_eval.md](asr_eval.md) | Supervised sites, ASR bake-off | Administrator reads aloud | No |
| `research_audio` | [research_audio.md](research_audio.md) | Supervised sites, Stage 1 think-aloud | Administrator reads aloud | No |

## Rules for every script

1. **Consent is committed only by a tap.** Never by voice. The microphone is closed during consent.
2. **Short segments** (target 15 to 25 seconds each), each with a pictogram, each replayable. Replays are
   counted in the consent artefact (`replay_counts`).
3. **Plain words.** Short sentences; one idea per sentence; no legal terms; no numbers that matter for the
   decision. Where a number must be said (for example "18"), it is said as a word and shown with a picture.
4. **Notice content (DPDP Act section 5):** what is collected, why, how to withdraw and ask for deletion,
   how to complain, and that a complaint can go to the Data Protection Board. The QR code on the bezel links
   to the fiduciary and grievance contact. **[LEGAL REVIEW]** confirm the notice content against the DPDP
   Rules.
5. **Opt-ins default to "no".** A time-out or skip counts as "no".
6. **Every recording is versioned.** The consent artefact stores `consent_script_id` and
   `script_audio_sha256`, which must resolve to the exact audio played (ONB-02 acceptance criterion).
7. **Line ids** (`consent.<kind>.<segment>`) are the keys in the audio manifest and the ITC workflow.

## ITC adaptation notes (apply to every script)

Translation follows the VOX-07 workflow: draft -> forward_translated -> back_translated -> expert_reviewed ->
recorded -> audio_qc -> think_aloud_tested -> approved. Production packs contain only `approved` audio.

- **Translate meaning, not words.** Keep each sentence's meaning; restructure freely for natural speech.
  Back-translation is checked for meaning, not word order.
- **Register.** Polite, warm, respectful, like a trusted community health worker; not bureaucratic. Use the
  respectful second-person form that is natural in the language and region.
- **Terms to adapt carefully:** "information" / "data" (use the everyday word for "what you did in the game"
  and "your answers"); "delete"; "research"; "phone number"; "complain"; "Data Protection Board" (use the
  official name in the language, then a one-phrase explanation).
- **Avoid idioms, metaphors and English loanwords** unless the loanword is the everyday word (for example
  "phone" is commonly used in many Indian languages; testers decide).
- **Numbers and ages** are spoken in the everyday form for the region and always paired with a picture.
- **Regional variants** keep the same line id; a variant is a separate approved recording.
- **Recording:** native speaker of the region; consistent voice across segments; target duration within
  +-15% of the English source timing noted per segment; loudness normalised; no background music under
  consent audio.
- **Comprehension testing (Stage 1 think-aloud):** after the consent, ask the participant in their words:
  "What will happen to what you do in the game?", "Can you stop? How?", "Is your voice kept?", "Who can see
  the summary?". Revise any segment that more than 20% of testers misunderstand.
- **Pictograms** are tested with the same participants; a pictogram that is misread is redrawn, not
  explained with more words.

## Review status

All scripts are drafts. Items marked **[IEC REVIEW]** or **[LEGAL REVIEW]** must be resolved before
translation starts, because translation and recording are expensive to redo.
