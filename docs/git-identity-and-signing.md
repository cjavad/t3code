# Per-user Git identity and signing

This fork associates Git actions with the authenticated T3 session subject. Create pairing links with a device-specific **Client label** and a stable per-person **Identity subject**. Use the same subject for that person on every device, and different subjects for different people. Configure the identity in **Settings → Source control → Git identity and signing** (the same controls are available in the mobile app).

Subjects are intentionally fixed when a pairing link is issued. To move a client to another person, revoke its session and create a new pairing link; changing the subject in place would silently move its Git identity, signing key, and stored provider credentials.

Saving an identity creates an Ed25519 SSH signing key on the server. The private key stays in the server secrets directory and is never returned over RPC. Copy the displayed public key to GitHub under **Settings → SSH and GPG keys → New SSH key**, select **Signing key**, and use the configured Git email for commits. GitHub will then show commits made by T3 as **Verified**.

The optional GitHub token is stored per session subject and is inherited by that subject's agent process. This makes the normal `gh` CLI work from agent shell commands, scripts, and nested subprocesses, while keeping the token out of Git configuration and logs. `gh` operations therefore use the authenticated subject's token rather than a shared server identity. Pull requests and other GitHub actions are attributed by the token's GitHub account.

The current implementation supports GitHub.com tokens. Git identity and SSH signing are injected into every provider process that launches a local shell, so Bash, Python, Make, and similar descendants inherit the same author and signing configuration. Push authentication remains governed by the repository's remote credentials; HTTPS remotes still need a credential helper or an SSH remote.

Each authenticated subject has one durable row in `auth_users`, with an ID of `user:<subject>`. User-created threads, dispatches, and messages carry that ID. We intentionally store the ID rather than a display-name snapshot, so changing a person's display name does not rewrite historical messages.
