# Instagram native AI disclosure

OriginPost supports an explicit, human-approved request for Instagram's native AI information label. It never infers this choice from a caption, drafting runtime, filename, metadata, or media appearance.

## Workflow

1. In Content Studio, choose **Add Instagram's AI info label** or **No native AI info label requested**.
2. OriginPost stores a pending settings candidate. The server normalizes the entire Instagram settings object and computes its SHA-256.
3. A manager or owner approves the exact draft, account, collaborators, Reel options, and AI-label choice. Scheduling resolves that immutable approval by ID; the client cannot submit a new hash or label setting at schedule time.
4. The official connector sends `is_ai_generated=true` only when the approved choice is on. It is placed on a single image, Reel, Story container, or carousel parent—never on carousel child containers.
5. After `media_publish`, OriginPost reads the exact published media with `fields=permalink,is_ai_generated`. A requested label is not considered successful unless Instagram reports `is_ai_generated=true`.
6. Publish proof records both `requested` and `observed`. Missing read-back becomes an uncertain, reconciliation-first result and is never silently treated as success.

## Manual handoff and recovery

A manual handoff with an approved label requires a human to attest that the native label is visible on the exact Instagram post before proof can be saved. For an uncertain official provider result, the API performs a read-only check of the exact media ID and live URL. It does not publish again and it does not accept a caption hashtag as provider evidence.

The setting cannot be added to an existing post through this workflow. Changing the choice creates a new pending settings candidate and requires a new approval.

## Safety and privacy

- Access tokens remain in encrypted server credentials and Authorization headers.
- Provider responses are sanitized and hashed; raw bodies and tokens are not stored in proof.
- Carousel children never receive the field.
- Legacy Instagram targets with no setting remain readable and send no native label field.
- A provider-observed label can be recorded separately from the requested state so OriginPost does not misstate who applied it.

## Production gates

- Pin and contract-test the deployment's Meta Graph version.
- Use reviewed Instagram permissions and a real owned professional test account.
- Run watched image, Reel, carousel-parent, and basic Story publishes for both supported login families.
- Verify requested-on, requested-off, missing read-back, timeout-after-publish, and manual-recovery cases.
- Confirm the Content Studio proof shows `requested` and `observed` independently.
- Keep `ALLOW_LIVE_PUBLISH=false` until those watched checks and the provider application's review are complete.
