# shriii-i18n: localisation tooling (VOX-07)

`shriii-i18n` is a command-line tool for the translation and ITC adaptation workflow. It works on the
following files:

- `content/i18n/lines.yaml`: the line catalogue. This tool only reads it.
- `content/i18n/translations/<lang>.yaml`: one recording-script file per language.
- `content/i18n/translations/workflow.yaml`: statuses, transitions, roles and thresholds.
- `content/i18n/translations/register-guide.yaml`: register guidance and the glossary.

It is a uv workspace member. After `uv sync --all-packages`, run it with `uv run shriii-i18n ...` or
`python -m shriii_i18n ...`.

| Command | What it does |
|---|---|
| `validate [--lang L] [--warnings] [--strict]` | Checks each translation file against the catalogue, the workflow and the glossary. Fails on errors, or on warnings too with `--strict`. Use it in CI. |
| `sync [--lang L] [--prune] [--dry-run]` | Adds new catalogue lines as drafts and restores catalogue order. Reports lines whose source text changed (stale) and entries with no catalogue line (orphans). `--prune` removes the orphans. |
| `export [--lang L] [--out-dir D]` | Writes one review workbook per language: `shriii-translations_<lang>_<date>.xlsx`. |
| `import WORKBOOK... [--dry-run] [--report R.json] [--today YYYY-MM-DD]` | Validates reviewed workbooks. If a workbook has no errors, it is applied to the YAML (all or nothing). |
| `coverage [--lang L] [--format md\|json] [--out F] [--min-status S --min-ratio R]` | Reports per language: status counts, share of lines at each milestone, pilot and production pack readiness, issues, and duration estimates. Exits non-zero below the threshold you set. |
| `trail [--lang L] [--out-dir D]` | Exports the ITC sign-off trail as CSV. |

## The review workbook

- **`translations` sheet.** The sheet is protected, so only the yellow columns can be edited:
  - Translation, Back-translation, Register note and Translator note.
  - New status: a dropdown list of statuses.
  - Reviewer name, Reviewer role (a dropdown list of roles), Review date (date-validated) and Review comment.

  Grey rows are lines that are not recorded in this language. Hidden columns hold the source hash and a
  fingerprint of the YAML entry taken at export.
- **`status_guide` sheet.** For each status: what it means, who signs the move into it, what it requires,
  and which statuses can come next.
- **`README` sheet.** Instructions for translators.
- **Hidden `_lists` and `_meta` sheets.** `_lists` feeds the dropdowns. `_meta` holds the schema, language,
  catalogue version and export time.

## Import rules

Each rule below has an issue code. The import is rejected if any row has an error.

| Rule | Issue code |
|---|---|
| Every catalogue line appears exactly once | `missing_line`, `duplicate_line`, `unknown_line` |
| The source text has not changed since export | `stale_export` |
| The YAML entry has not changed since export | `concurrent_change` |
| Placeholders (`{x}`, `{{x}}`, `%s`, `<tag/>`, `[pause]`) match the source exactly | `placeholder_mismatch` |
| Statuses move forward only, one step at a time, or to `flagged_for_revision` | `illegal_transition` |
| A flagged line restarts at `forward_translated` | `illegal_transition` |
| Every status change is signed with name, role and date. The role must match the target status. The date must be a valid ISO date, not in the future, and not earlier than the previous sign-off. Flagging needs a comment. | `signoff_missing`, `signoff_role`, `bad_date`, `future_date`, `history_date_order`, `comment_missing` |
| The back-translator differs from the forward translator, and the approver differs from the expert reviewer | `signoff_not_independent` |
| The script is locked after back-translation. Only the reconciliation panel may edit it, on entry to `expert_reviewed`, or someone flags the line for revision first. | `locked_field` |
| Content checks: required fields per status, correct script, Latin letters, glossary terms, estimated spoken duration against the target (±15%, flagged at 1.5×) | various |

## Tests

```
uv run pytest tools/i18n/tests
```

The tests also check the repository content:

- All three draft files validate with no errors.
- Every catalogue line is translated in the right script.
- The adaptation sheets cover every language and point to real lines and modules.
- The ITC checklist covers all 18 guidelines and every in-repo evidence path exists.
