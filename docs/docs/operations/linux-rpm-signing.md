# Linux RPM preview signing

The credential-free `desktop-linux-preview.yml` and nightly native validation bundles remain
unsigned. Existing artifacts, including the observed 0.9.0 preview from source
`ef0350859b1d726abbcb72ac40ddef77a210d384`, run `38230913378`, are not retroactively signed.
Keep ongoing validation on its frozen source. Signing does not rebuild the application,
refresh its runtime image references, promote stable/latest, or enable self-updates.

`desktop-linux-signed-preview.yml` is a separate, manual, main-only distribution path.
It consumes the exact finalized four-package artifact from a successful main-dispatched
unsigned preview run. Reviewed code from the dispatched `main` revision signs both RPMs;
the original source checkout is read only as data to verify native pins. No package scripts
or frozen-source JavaScript are executed by the signing helper.

## Owner provisioning (required before any signed preview)

No release key or signing authority is supplied by this change. An owner must provision
an existing, stable OpenPGP v4 RSA signing-capable **primary** key (at least 2048 bits;
3072 or 4096 recommended for a newly owner-provisioned identity). The helper selects its
full fingerprint with `!`; it does not silently select a subkey. The primary must be
unexpired and unrevoked. Keep offline backups and a revocation certificate under the
owner's custody. Do not use disposable test keys as release keys.

An owner must configure the following manually; the workflow never changes permissions,
environments, protection rules, or key custody:

| Scope | Name | Value/purpose |
| --- | --- | --- |
| Protected environment | `desktop-linux-rpm-signing` | Required reviewers, prevent self-review as appropriate, deployment restricted to `main` |
| Environment variable | `PROPR_DESKTOP_RPM_SIGNING_AUTHORIZED` | `1`, only after protections and identity are reviewed |
| Environment secret | `PROPR_DESKTOP_RPM_PRIVATE_KEY` | ASCII-armored, passphrase-protected private key export for the selected identity |
| Environment secret | `PROPR_DESKTOP_RPM_PASSPHRASE` | Nonempty single-line passphrase; never a workflow input, command argument, or artifact |
| Repository variable | `PROPR_DESKTOP_RPM_PUBLIC_KEY` | ASCII-armored public export of that identity, with actual newlines |
| Repository variable | `PROPR_DESKTOP_RPM_FINGERPRINT` | Exact full 40-character uppercase fingerprint, no spaces or key-ID abbreviation |
| Protected publication environment | `desktop-linux-preview-publication` | Existing required-reviewer, main-only preview-publication environment |
| Publication environment variable | `PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED` | Existing `1` authorization for preview publication |

Use repository **Settings → Environments → desktop-linux-rpm-signing** for its
protections, environment secrets and authorization variable. Set the two public repository
variables under **Settings → Secrets and variables → Actions → Variables**. Use the existing
publication environment for its own authorization variable.

Store the private key and passphrase **only** in the signing environment, never repository
or organization secrets shared with build/PR jobs. Signing has read-only repository and
Actions permissions; separate jobs stage and publish with `contents: write` and no private
signing secrets. Do not override the public repository variables with different environment
values: sign, stage and publish must use exactly the same public export and fingerprint.
Maintain the existing immutable `desktop-linux-preview-v*` tag rules, which also cover the
new `-rpm-signed` suffix. Provisioning is an owner action, not implied by preview-publication
standing authorization.

On the owner's trusted key-management machine, inspect the public export without importing
system trust:

```sh
gpg --show-keys --with-colons --with-fingerprint propr-desktop-rpm.asc
```

Identify the `fpr` immediately following the single `pub` record. Independently compare it
to the owner-controlled key inventory, then set the two public variables above. Publish
`propr-desktop-rpm.asc` and the full fingerprint in an owner-controlled HTTPS release-key
notice (for example the project's official documentation), with issuance, expiry, and
revocation contact information. The notice must be independently discoverable, not solely
embedded in an installer download. Announce the fingerprint through an existing trusted
owner channel. This implementation deliberately contains no invented production fingerprint.
The signed bundle also carries the identical public export in `linux-preview.json` under
`rpmSigning.publicKey` and the fingerprint in both that manifest and `INSTALL.md`.

## Stage and publish

After merging the reviewed workflow and provisioning authority, dispatch from `main`:

```sh
# Preserve the observed source and its already-finalized runtime digests:
gh workflow run desktop-linux-signed-preview.yml --ref main \
  -f operation=sign-draft \
  -f source_revision=ef0350859b1d726abbcb72ac40ddef77a210d384 \
  -f unsigned_run_id=38230913378
```

This requires that run's exact finalized artifact still be retained. If it is unavailable,
stop; do not substitute build fragments or rebuild a different source implicitly. A newer
source/run requires explicit selection and renewed validation.

Review the signed candidate and draft. Its tag is
`desktop-linux-preview-v<version>-<first-12-source-SHA>-rpm-signed`. The existing unsigned
tag/draft is left intact. Then dispatch `publish-draft` with the same source and **omit**
`unsigned_run_id`. The protected publication job re-downloads the draft, validates final
hashes, signatures, architecture, sandbox metadata, native pins and runtime references,
and publishes a prerelease with `make_latest=false`.

A failed upload can resume by re-running the failed staging job using the same run's
`propr-desktop-rpm-signed-<run-id>` artifact. Never re-sign to resume an existing draft:
OpenPGP signature timestamps can change bytes. Conflicting assets/tags are refused, not
overwritten. Publication downloads only the signed draft's exact allowlisted assets;
there is no fallback to unsigned originals, wildcard fragment download, or update feed.

## Verification and installation on openSUSE / RPM systems

Download all assets from the **signed** preview into one directory. Read its `INSTALL.md`.
Compare the full fingerprint with the independently published owner notice before trusting
the key. Extract the public key without evaluating manifest content:

```sh
python3 -c 'import json; print(json.load(open("linux-preview.json"))["rpmSigning"]["publicKey"], end="")' > propr-desktop-rpm.asc
gpg --show-keys --with-fingerprint propr-desktop-rpm.asc
# Only after independently confirming the full fingerprint:
sudo rpm --import propr-desktop-rpm.asc
sha256sum --check SHA256SUMS
VERSION=0.9.0
ARCH=x64 # or arm64
rpmkeys --checksig --verbose "./ProPR-Desktop-${VERSION}-linux-${ARCH}.rpm"
sudo zypper install "./ProPR-Desktop-${VERSION}-linux-${ARCH}.rpm"
```

Require both the header signature and package signature to report `OK`, not just digests.
First-time `NOKEY` / unknown-key indicates missing trust; an unsigned header means the
wrong asset was downloaded. Stop on missing/invalid signatures, digest errors, or fingerprint
mismatch. Do not accept an ignore/bypass option. Importing a public key establishes local
trust; it cannot manufacture a signature on an unsigned RPM. These are explicit user
commands: neither the application nor these helpers modifies the user's system trust store.
The normal local-RPM install is documented in the
[openSUSE Leap 15.6 Zypper manual](https://manpages.opensuse.org/Leap-15.6/zypper/zypper.8.en.html).

For a same-version manual upgrade use `zypper install --force ./<verified-package>.rpm`
after the same checks. Fedora/RHEL users should enforce local-package checking with
`dnf --setopt=localpkg_gpgcheck=1 install ./<verified-package>.rpm`. Generated `INSTALL.md`
also includes upgrade/reinstall/removal commands. This work does not claim installed
openSUSE GUI/runtime acceptance or remove the documented ARM managed-agent limitation.

For exact-key verification independent of any system keyring, the reusable helper accepts
an RPM path, public export and full fingerprint:

```sh
node apps/desktop/scripts/rpm-signing.mjs verify \
  --rpm "./ProPR-Desktop-${VERSION}-linux-${ARCH}.rpm" \
  --public-key propr-desktop-rpm.asc \
  --fingerprint "$INDEPENDENTLY_CONFIRMED_FULL_FINGERPRINT"
```

It imports only that public key into a new
temporary RPM database and requires header **and** package signatures. It rejects unsigned
RPMs even though `rpmkeys` can return success for their digest checks. The signer uses
RSA/SHA256 plus `--rpmv3` for an additional header+payload signature; see the
[RPM signing manual](https://rpm.org/docs/4.20.x/man/rpmsign.8). GnuPG uses a private temporary
home and a mode-0600 passphrase file (only its pathname is an argument), with bounded,
non-forwarded tool output. Temporary signing material is removed on completion/failure.

## Metadata and payload guarantees

Schema 2 remains `unsigned-preview`. Signed schema 3 explicitly requires `--signed-rpm`
and operator-pinned public inputs; its trust value is `rpm-signed-preview`, **not** a claim
that the DEBs, manifest, or SHA256SUMS are OpenPGP-signed. The canonical preview reader and
publication helper reject cross-mode bundles. `rpmSigning.originals` retains each original
unsigned RPM checksum plus the SHA256 of its full main-header/payload region. Signing may
only change the RPM signature area. Final artifact sizes/hashes and `SHA256SUMS` always
refer to final bytes, including the final instructions and manifest.

Before signing and again afterward, the helpers inspect both native architectures, root:root
4755 RPM sandbox metadata, launcher layout, runtime source/app/UI/agent digest bindings,
and native addon bytes against hash pins read from the frozen source. Full main-header/payload
hash equality additionally preserves all native files, package file hashes, scripts and modes.
Independent public-only signature verification is repeated at staging and publication.

Standalone DEBs remain unsigned and are byte-for-byte unchanged. RPM signatures do not
authenticate them. An apt repository authenticates package hashes through signed repository
metadata (`InRelease` or `Release.gpg`); this preview has no apt repository. Building or
hosting one is outside this change. Apple notarization and Ed25519 desktop update metadata
remain separate, and Linux self-updates stay disabled.

## Rotation and revocation

Keep the same identity across previews until the owner deliberately rotates it. Publish a
transition notice with both full fingerprints, effective dates, and an independently
verified new public export; authenticate the transition with the old key where appropriate.
Provision the new protected secret and public variables together, then review a fresh preview
identity. Do not overwrite or relabel historical signed assets. Existing drafts pinned to
the old identity will fail current-policy verification and must not be silently promoted.

On compromise/revocation, disable signing/publication authorization immediately, remove
access to the compromised private key, publish the owner's revocation certificate and an
incident notice through independent channels, and identify affected packages. RPM trust
databases do not automatically learn online revocations: users must explicitly stop trusting
and remove the affected key after matching its full fingerprint, then bootstrap the replacement.
Keep historical public keys/notices for audit, clearly marked revoked/retired. Never instruct
users to bypass verification to work around expiry or revocation.

## Offline regression test

On Linux with Node, GnuPG, RPM tools (`rpm`, `rpmkeys`, `rpmsign`, `rpmbuild`, `rpm2cpio`),
`cpio`, and `dpkg-deb`:

```sh
PROPR_REQUIRE_RPM_TESTS=1 node --test apps/desktop/scripts/rpm-signing.test.mjs \
  apps/desktop/scripts/linux-preview-release.test.mjs \
  apps/desktop/scripts/linux-preview-workflow.test.mjs
```

Tests use disposable passphrase-protected keys and real x64/ARM64 package fixtures in
isolated temporary directories. They require no provider credentials or host trust changes.
