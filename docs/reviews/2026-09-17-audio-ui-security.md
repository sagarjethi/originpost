# Audio and agent UI review — 17 September 2026

Scope: changes after `42776df` for project language skills, post-to-voice handoff, narration, compact Audio UI and local-language media delivery. Independent standards/security and specification reviews ran before fixes. Subsequent fixes were inspected separately; this is not a full penetration test or a review of unrelated documentation commits.

## Standards

One P2 finding: script drafting bypassed the narration cost controls. Resolved with a separate daily script quota, durable request identity, atomic database reservation and persisted replay results. Failed and interrupted attempts count and do not retry automatically. API and PostgreSQL tests cover duplicate and concurrent requests.

No additional actionable credential, authorization, provider fallback or header-injection finding remained in the reviewed scope. A live desktop check separately exposed invalid non-ASCII filenames in delivery headers; the corrected ASCII fallback and UTF-8 filename parameter are covered by Gujarati, Hindi and control-character regression cases.

## Spec

Two P2 findings, both resolved:

- Selecting another news item retained the previous story's script/banner and could use the wrong project profile. Selection now resolves the chosen story's context and clears unrelated state.
- An in-flight draft could overwrite a newly selected story. All composer controls are disabled during requests, including external provider configuration.

The final follow-up code inspection reported zero remaining findings for the handoff and draft-state scope. Live speech acceptance remains pending a valid provider secret; no paid provider calls were made during review.

## Desktop verification

The deployed owner UI was inspected at 1440×1000 and 980×900. The wider view uses two aligned panels; the narrower workspace stacks them. Document width matched viewport width in both checks, with no horizontal overflow. The connection dialog uses collapsed advanced sections. A final width correction makes the pre-connection script field fill its card.

## Automated safeguards

- Executable `.githooks/pre-commit` and `.githooks/pre-push` are configured through `core.hooksPath`.
- The Verify CI workflow runs the release/dependency/secret/test checks.
- API and web TypeScript checks now reject unused locals and parameters; detected unused imports and the unused identity-query argument were removed.
- Production dependency audit: no known vulnerabilities reported.
- Public-release audit: passing after generalizing installation-specific paths and publisher references.
- Secret-guard regression tests: passing, including rejection of private paths and synthetic credentials.

Summary: Standards — 1 finding resolved (unbounded script charges); Spec — 2 findings resolved (stale story association and asynchronous overwrite). No remaining actionable findings in the reviewed scope; this does not guarantee absence of defects elsewhere.
