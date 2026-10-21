# Minors policy: adults only (18+), locked

**Version:** 0.1 DRAFT, 2026-10-21. **Owner:** DPO. **Approvers:** DPO, Ethics Officer, legal counsel.
**Config:** `minimum_age = 18`, `allow_minors = false` (**locked**). **Plan features:** plan 1.3 and 1.4, PRV-01, PRV-12, ONB-04.

## 1. Policy

1. Only adults aged 18 or over may take part, at every site and in every mode.
2. No data is kept from anyone who indicates they are under 18.
3. There is no guardian or parental-consent branch in the kiosk.
4. The setting `allow_minors` cannot be switched on by configuration alone. The policy validator rejects any
   deployment policy with `allow_minors = true` unless every precondition in section 4 is met and recorded.
   **Implementation status (2026-10-21):** the deployment-policy validator (PRV-01) is not built yet, and no
   `allow_minors` configuration key exists in code. Until it exists there is no way to enable minors at all:
   the kiosk has no guardian branch, and an under-18 band ends the session with nothing persisted
   (`frontend/packages/kiosk-game/src/onboarding/screens/bands.ts`).

## 2. Why

- **DPDP Act 2023, section 9:** processing a child's personal data (a child is anyone under 18) needs
  verifiable consent of a parent or lawful guardian; processing likely to harm a child's well-being is
  prohibited; and tracking, **behavioural monitoring** and targeted advertising directed at children are
  prohibited (section 9(3)). A behavioural assessment game is, by design, behavioural monitoring.
  **[LEGAL REVIEW]** confirm, including any exemptions notified under section 9(4) and 9(5).
- The integrity, accountability and moral-judgement content is not appropriate for children.
- The criterion instruments (for example BFI-2, DERS-16) are adult instruments; no norms or validity evidence
  for children exist in this programme.

## 3. How it is enforced

| Control | Detail |
|---|---|
| Age band question | The first picture-band question shows life-stage figures with spoken age ranges. Choosing an under-18 band ends the session politely ("Thank you. This game is for grown-ups.") and **nothing is persisted** (tested: zero persisted data, ONB-04 acceptance criterion). |
| No age guessing from behaviour | The system does not estimate age from play, voice or images (camera input does not exist). |
| Supervised sites | Administrators do not ask for documents. If a participant is evidently a child, the administrator ends the session kindly and does not enrol them. Criterion batteries are administered only to adults. |
| Open public kiosks | Thank-you mode only, core consent only; no contact capture unless opted in, no criterion battery, no audio. |
| Policy validator | Rejects `allow_minors = true` without the precondition records (PRV-01). **Planned, not yet implemented**; see section 1, item 4. |
| Content | No module is designed or tested for children. |

**Limitation.** Age is self-declared. A child could choose an adult band. The design minimises what such a
session would contain (pseudonymous play data only, deleted after 90 days in public mode) and gives no
individual report until gates pass. **[LEGAL REVIEW]** whether the DPDP Rules require stronger age assurance
for anonymous kiosks.

## 4. Preconditions before minors could ever be enabled

All of the following must exist and be recorded as signed governance records:

1. Verifiable parental or guardian consent in a form that meets section 9 and the DPDP Rules.
2. A legal opinion on the section 9(3) behavioural-monitoring bar for this use.
3. An age-tiered module set that **excludes integrity and accountability content**, with its own validation
   evidence and norms.
4. Ethics approval from the IEC for research with children (ICMR guidelines on vulnerable populations).
5. An updated DPIA.
6. A stakeholder decision naming the purpose.

## 5. If a minor's data is found

1. Delete it at once through the erasure workflow ([retention and deletion policy](retention-and-deletion-policy.md)).
2. Record an incident (severity S4, or higher if other data was involved) under the
   [incident response runbook](incident-response-runbook.md).
3. Inform the Ethics Officer and the DPO; review how it happened.
