# Per-user Git identity and signing

This fork associates Git actions with the authenticated T3 session subject. Create pairing links with a device-specific **Client label** and a stable per-person **Identity subject**. Use the same subject for that person on every device, and different subjects for different people. Configure the identity in **Settings → Source control → Git identity and signing** (the same controls are available in the mobile app).

Subjects are intentionally fixed when a pairing link is issued. To move a client to another person, revoke its session and create a new pairing link; changing the subject in place would silently move its Git identity, signing key, and stored provider credentials.

Saving an identity creates an Ed25519 SSH signing key on the server. The private key stays in the server secrets directory and is never returned over RPC. Copy the displayed public key to GitHub under **Settings → SSH and GPG keys → New SSH key**, select **Signing key**, and use the configured Git email for commits. GitHub will then show commits made by T3 as **Verified**.

The optional GitHub token is stored per session subject and is used only for that user's pull-request API calls. It is not included in profiles, logs, or cache keys. A token is required for PR creation so the PR is attributed to the person who initiated it; the server's shared `gh` login is not used for that action.

The current implementation supports GitHub.com tokens. The commit identity and SSH signing path work with any Git remote. Push authentication remains governed by the repository's existing remote credentials, so HTTPS remotes should be configured with an appropriate credential helper or changed to SSH.
