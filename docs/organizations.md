# Workspaces and brands

OriginPost separates team access from publishing identity.

- A **Workspace** owns members, roles, brands, content, media, monitors, connected accounts, schedules, notifications, and audit history.
- A **Brand** is one publishing identity inside a workspace. Content, media, monitors, and connected Instagram or YouTube accounts belong to exactly one brand.
- A user can belong to more than one workspace. The active workspace and brand are selected in the sidebar and remembered in the browser.

## Access rules

Owners can create workspaces and brands, invite and manage members, and connect publishing accounts. Managers and creators work within the permissions defined by their workspace role. Viewers have read-only access.

## Inviting members

In team session mode, **Organizations** gives Workspace owners a separate invitation list. Creating or resending an invitation produces a manual, copyable link; OriginPost does not send email in this release. The list shows the server-owned email, role, expiry, status, and `link_ready` delivery state, but never the raw token or its stored hash. Because the raw token is returned only once, copy the new link before leaving the page.

One Workspace/email can have only one active invitation. Resending rotates the token, and revoking makes the current link unusable. Existing users sign in and accept with their matching account email. New users register from the invitation. In both cases the server—not the browser—selects the Workspace and role, and acceptance is atomic with membership creation and audit history. See [Self-hosted authentication](authentication.md#workspace-invitations) for the complete security behavior.

Every server request is checked against the selected workspace. PostgreSQL reads and writes use `workspace_id`; brand-owned resources also use `brand_id`. A publishing target cannot use an account from another brand, even when both brands belong to the same workspace.

Switching brands filters the content inbox, Content Studio media and channels, Library, Channels, and source monitors. Notifications and delivery operations remain workspace-wide because they are operational alerts for the team.

## Archiving

A workspace must keep at least one active brand. Archiving a brand removes it from the normal selector but does not delete its records or proof history. Existing data stays available for future recovery and export work.

## Migration behavior

Migration `021_workspaces_and_brands.sql` creates the organization model and assigns existing content to the workspace's first brand. Migration `022_brand_scoped_resources.sql` assigns existing media, accounts, OAuth states, and monitor rules to that same brand, then makes `brand_id` required with foreign keys and workspace-brand indexes. Migration `052_workspace_invitations.sql` adds hashed, expiring Workspace invitation records with a unique active invitation per Workspace/email and membership-bound actor references.

Back up PostgreSQL before applying migrations to an existing installation.
