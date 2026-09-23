# Per-user Git identity and signing

This fork associates Git actions with the authenticated T3 session subject. Give each pairing link a distinct label (the label becomes its subject) so people do not share an identity. Configure the identity in **Settings → Source control → Git identity and signing** (the same controls are available in the mobile app).

Saving an identity creates an Ed25519 SSH signing key on the server. The private key stays in the server secrets directory and is never returned over RPC. Copy the displayed public key to GitHub under **Settings → SSH and GPG keys → New SSH key**, select **Signing key**, and use the configured Git email for commits. GitHub will then show commits made by T3 as **Verified**.

The optional GitHub token is stored per session subject and is used only for that user's pull-request API calls. It is not included in profiles, logs, or cache keys. A token is required for PR creation so the PR is attributed to the person who initiated it; the server's shared `gh` login is not used for that action.

The current implementation supports GitHub.com tokens. The commit identity and SSH signing path work with any Git remote. Push authentication remains governed by the repository's existing remote credentials, so HTTPS remotes should be configured with an appropriate credential helper or changed to SSH.
