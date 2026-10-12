# Linux desktop release key

The owner-provisioned Linux desktop release identity is:

**DD4E7F65CE2345A1F4597D643CF856B53093D3A3**

[Download the ASCII-armored public key](/keys/propr-desktop-release.asc).
This is public information; the export contains no private key material.

The RSA4096 primary signing key was issued on **2026-10-12** and expires on
**2028-10-11**. Its historical user ID is `ProPR Desktop RPM Signing`; the same
identity authenticates the new DEB/RPM preview checksums and APT repository metadata.
It does not authenticate older unsigned DEBs retroactively.

Inspect the downloaded export with GnuPG without installing host trust:

```sh
gpg --show-keys --with-colons --with-fingerprint propr-desktop-release.asc
```

Require exactly one `pub` record, RSA4096, and the full fingerprint above in its
following `fpr` record. Compare this notice through independently reviewed project
documentation, not only a key delivered alongside an installer. Reject expired,
revoked, or different keys. See [Linux package authentication](linux-rpm-signing.md)
for checksum verification and scoped APT trust. APT verifies repository metadata
and hashes, not an embedded signature inside each DEB.

The owner must keep encrypted offline backups and a revocation certificate under
restricted custody; this notice specifies the required procedure, not an audit of
those backups. Never put private exports, passwords, backup locations, or recovery
material in issues, documentation, artifacts, or CI logs. Test restoration using a
controlled owner process; implementation tests use disposable keys only.

For a suspected compromise or a key question, contact the repository maintainers
through [integry/propr on GitHub](https://github.com/integry/propr/issues).
Do not post secrets. No private contact address is asserted here.

On compromise, maintainers must disable signing and publication authorization,
publish the revocation certificate and affected-release notice through reviewed
docs and existing trusted channels, and arrange a replacement identity. Consumers
must stop trusting the affected key; local RPM databases and scoped APT keyrings
do not discover revocations automatically. Consult the latest reviewed notice
before installing.

Before expiry or rotation, publish both complete fingerprints, effective dates,
and the replacement public export, authenticating the transition with the old
key where safe. Review the code pin and public settings together. Preserve
historical notices and immutable assets with their original trust classification;
never relabel them or bypass verification to accommodate expiry.

This notice and download are delivered through the normal reviewed documentation
pipeline. They do not establish a live production APT endpoint.
