# Linux package authentication

New public Linux previews authenticate **both DEB and RPM packages, on x64 and
arm64**. The owner identity is **DD4E7F65CE2345A1F4597D643CF856B53093D3A3**.
See the independent [release-key notice and public download](linux-release-key.md).

The main-only `desktop-linux-signed-preview.yml` consumes the exact finalized
four-package artifact from a successful main-dispatched unsigned preview run.
Reviewed main control code signs; the frozen source is data for native pins only.
Original unsigned inputs remain intact. DEBs stay byte-for-byte unchanged; RPM
signing changes only their signature region, preserving the entire main header
and payload. Native architecture, hash pins, root-owned 4755 sandbox metadata,
and source/app/UI/agent runtime digests are rechecked before and after signing.

## Protected boundary

Reuse the existing owner-provisioned `desktop-linux-rpm-signing` environment.
Its compatibility names remain unchanged:

| Setting | Purpose |
| --- | --- |
| `PROPR_DESKTOP_RPM_SIGNING_AUTHORIZED` | Protected authorization, `1` |
| `PROPR_DESKTOP_RPM_PRIVATE_KEY` | Existing protected private key secret |
| `PROPR_DESKTOP_RPM_PASSPHRASE` | Existing protected passphrase secret |
| `PROPR_DESKTOP_RPM_PUBLIC_KEY` | Repository variable containing the public export |
| `PROPR_DESKTOP_RPM_FINGERPRINT` | Repository variable with the complete owner fingerprint |

Private credentials are confined to the protected read-only signing job. The
entry point removes them from the environment before package parsers run. GnuPG
uses temporary private files, scrubbed subprocess environments, exact-primary
selection, bounded diagnostics, and cleanup. Stage/publication jobs have public
inputs only. No keys, permissions, hosting, or access are provisioned by this work.

## Authentication graph

Schema 4 has trust `authenticated-linux-preview`, tag suffix `-all-signed`, and
title suffix **(authenticated DEB and RPM)**. `rpmSigning.originals` records the
unsigned RPM hash and preserved main-header/payload digest; `signing.originalDebs`
records unchanged DEB hashes. Source and original workflow-run bindings remain in
the authenticated manifest.

1. Final native RPM header and header+payload signatures are verified in an
   isolated RPM database containing only the pinned public identity.
2. `APT-Packages-amd64` and `APT-Packages-arm64` describe the final DEBs, including
   their real dependency fields, sizes and SHA256 hashes.
3. `APT-Release` binds both indexes by SHA256 and size; `APT-InRelease` and
   `APT-Release.gpg` each authenticate those exact Release bytes with the pinned
   primary key. Metadata expires after 30 days.
4. Final `SHA256SUMS` covers all four packages, `linux-preview.json`, `INSTALL.md`,
   and all five APT assets. `SHA256SUMS.asc` is its detached armored signature.
   Neither the checksum file nor its detached signature hashes itself. There is
   no circular dependency or unauthenticated checksum claim.

Canonical stage and publication verification require the exact 13-file allowlist,
all hashes, both APT signatures, the complete Release → Packages → DEB chain, both
native RPM signatures, and the source/runtime/payload checks. Missing, extra,
duplicate, symlinked, changed, expired or wrong-key assets fail closed. No RPM-only
fallback is available.

## Direct downloads

Download every asset into a fresh directory. Obtain the public export through the
independent notice, inspect its full primary fingerprint, and use isolated trust:

```sh
KEYHOME="$(mktemp -d)"
chmod 700 "$KEYHOME"
gpg --homedir "$KEYHOME" --import propr-desktop-release.asc
gpg --homedir "$KEYHOME" --with-colons --fingerprint
# Require exactly one primary key with the full fingerprint in the notice.
gpg --homedir "$KEYHOME" --verify SHA256SUMS.asc SHA256SUMS
# Stop on errors, a different signer, expiry, or revocation.
sha256sum --check SHA256SUMS
```

Only after both checks succeed, follow the authenticated `INSTALL.md`. This
explicitly authenticates direct DEB downloads; `apt install ./package.deb` alone
does not establish that provenance. RPM users additionally require both native
signatures with `rpmkeys --checksig --verbose`. Use
`dnf --setopt=localpkg_gpgcheck=1` or ordinary `zypper install` after bootstrapping
the confirmed RPM key. Never override a missing key or failed signature.

## Exported APT repository

This release supplies a **repository bundle**, not a live hosted APT endpoint.
Authenticated `INSTALL.md` contains exact assembly commands: map APT-Release,
APT-InRelease and APT-Release.gpg to `dists/preview/`; map each architecture index
to `dists/preview/main/binary-<architecture>/Packages`; copy the unchanged DEBs
into `pool/`. Verify both Release signatures, including equality of the plaintext
recovered from InRelease. Use a source-scoped binary or armored public keyring:

```text
deb [signed-by=/absolute/path/propr-desktop-release.gpg] file:/absolute/path/apt-repository preview main
```

The keyring and repository must be readable by APT. A locally served copy can use
a local HTTP URL with the same scoped keyring. There is no production URL to
configure. Run `apt update` before downloading, and stop on authentication/hash
errors. APT authenticates signed repository metadata and package hashes; it does
not check an embedded DEB signature. See Debian's
[apt-secure documentation](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html)
and [repository format](https://wiki.debian.org/DebianRepository/Format).

## Operator review and historical releases

After integration, the operator independently reviews the exact main head and
selects a frozen source and successful unsigned `stage-draft` run. Dispatch
`sign-draft` in the authenticated workflow with those inputs. Review its distinct
signed draft before separately authorizing `publish-draft` with the same source.
Publication uses the existing `desktop-linux-preview-publication` environment and
`PROPR_DESKTOP_LINUX_PREVIEW_PUBLICATION_AUTHORIZED` gate. It never promotes latest
or stable, and Linux self-update remains disabled.

Resume failed staging with the same `propr-desktop-linux-signed-<run-id>` artifact.
Do not re-sign or overwrite an existing candidate: signatures can change bytes.
Unavailable inputs require a new explicitly selected source/run, not a fallback.

Unsigned schema 2 remains private validation evidence and cannot be newly
published. Historical schema 3 (`rpm-signed-preview`, `-rpm-signed`) authenticated
RPMs only; its DEBs and claimed checksums were unsigned. Historical immutable
assets remain unchanged and must retain that classification. They cannot satisfy
schema 4 publication. Existing source529d9fb image publication and private unsigned
installer staging remain separate evidence. ARM managed-agent limitations still
apply; signing is not end-to-end runtime acceptance.

## Required regression tests

```sh
PROPR_REQUIRE_RPM_TESTS=1 node --test apps/desktop/scripts/rpm-signing.test.mjs \
  apps/desktop/scripts/linux-preview-release.test.mjs \
  apps/desktop/scripts/linux-preview-workflow.test.mjs
```

CI installs GnuPG, RPM tools, cpio, dpkg and APT and requires real disposable-key
coverage; missing tools fail rather than skip. Tests cover both architectures,
unchanged DEBs, native RPM preservation/signatures, signed checksums, both APT
signatures, tampering and publication rejection. Real loopback HTTP APT update and
download tests use isolated source lists, keyrings, status, cache and download
directories, including successful detached-signature fallback and tamper rejection.
They neither install packages nor alter host trust. Backup, revocation, rotation,
and maintainer contact procedures are in the [key notice](linux-release-key.md).
