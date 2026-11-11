# PROVENANCE - vendored bash runtime

This file records exactly what ships in `runtime/win32-x64/`, where it
came from, how it was reduced, and what licenses apply. Nothing here is
generated at install time: the payload is committed to the repository and
verified by SHA256 on every mount.

## Upstream

The payload has TWO source assets. Both come from the same Git for Windows
release, `v2.56.0.windows.2` (latest stable, not a prerelease, published
2026-10-05), and both are downloaded from the same release page prefix
`https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/`.

| Asset | What it supplies | Bytes | SHA256 |
| --- | --- | --- | --- |
| `MinGit-2.56.0.2-64-bit.zip` | the shell and the rest of the userland: every payload file EXCEPT `usr/bin/sleep.exe` and `usr/bin/seq.exe` | 39806486 | `da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be` |
| `Git-2.56.0.2-64-bit.tar.bz2` | `usr/bin/sleep.exe` and `usr/bin/seq.exe` only | 118485193 | `16ca394bdb94b372267d79e1e10b68763674f73e03e0648202a7971a8a730a84` |

MinGit is the upstream's own minimal, redistributable Git for Windows build, but
it is not a complete `usr/bin`: it ships only the slice of each MSYS2 package
its own tooling needs. `coreutils` is declared in the MinGit archive's
`etc/package-versions.txt` (8.32-5) while `sleep.exe` and `seq.exe` are simply
absent from the archive, so those two files cannot be taken from MinGit. The
full Git for Windows installer archive carries the same release's complete
`usr/bin`, and is the pinned, digest-addressed place they come from.

Extraction is mechanical in both cases: the zip is unpacked with the system
`tar` (bsdtar reads zip) and the `.tar.bz2` is decompressed with `bzip2` and
unpacked with `tar`. No patching, no recompilation and no binary rewriting is
performed on any file below; every byte ships as the upstream release wrote it.

## What ships

`runtime/win32-x64/` holds a CURATED subset of the two upstream trees
described above - the payload must be large enough to be a usable shell and
small enough to belong to a plugin package - plus the license texts the
redistributed components require:

| Path | Contents |
| --- | --- |
| `usr/bin/bash.exe` | The upstream `usr/bin/sh.exe` byte-for-byte (upstream ships bash under both names; `bash.exe` is the name kept so the shell's own `$BASH` resolves to `/usr/bin/bash`) |
| `usr/bin/sh.exe` | The same bytes, kept under the upstream name |
| `usr/bin/*.exe` | The payload's userland: bash plus the shell/scripting/text helpers this tool promises |
| `usr/bin/sleep.exe`, `usr/bin/seq.exe` | The two files MinGit does not ship. Taken from the same release's full `Git-2.56.0.2-64-bit.tar.bz2` at `usr/bin/`, byte-for-byte; `coreutils` 8.32-5 (GPL-3.0-or-later), see Licensing |
| `usr/bin/msys-*.dll` | The MSYS2 runtime and exactly the DLL closure those executables import |
| `etc/` | The MSYS2 runtime configuration that makes the payload self-contained (see below) |
| `licenses/` | License texts for everything redistributed (see Licensing) |
| `checksums.sha256` | SHA256 of every other file in this directory, in `sha256sum -c` format |

### Payload inventory

| Fact | Value |
| --- | --- |
| Registered payload files | 91 |
| Payload bytes | 16873759 (16.09 MiB) |
| `usr/bin` regular files | 56 |
| `usr/bin/sleep.exe` SHA256 | `3dfa2435317339e861121c1bd22e57b7b67c204705f00a88b5ac10a0cba87514` |
| `usr/bin/sleep.exe` bytes | 36003 |
| `usr/bin/seq.exe` SHA256 | `6e5c79fce1d50d888b38f5a0a02a314265e733f151e8b9d2c953b363a60d27d0` |
| `usr/bin/seq.exe` bytes | 68488 |
| `bash.exe` SHA256 | `5490d0da5e7cf9d92068cc48fcc590f2bcf8564add8ff91c3b5fe541eb2d72e3` |
| `bash.exe` bytes | 2449886 |
| `msys-2.0.dll` SHA256 | `2a89b7c31b323c42e2fb37900af087aeb27417694e630a210bc75b0369410bc7` |
| Shell version | GNU bash 5.3.15(2)-release (x86_64-pc-cygwin) |

### Why the payload is curated rather than the whole upstream trees

The full MinGit `usr/bin` carries a second, unrelated tool family (OpenSSH,
with the whole Heimdal/Kerberos/OpenSSL closure - about 9 MiB of `msys-*.dll`).
`ssh` is not what this plugin provides, and shipping it would put a
credential-bearing network client inside a DSH profile for no reason. The
vendored set is the shell plus its userland; anything else is reachable from
the session's own tools.

The excluded executables are exactly: `ssh.exe`, `ssh-add.exe`, `ssh-agent.exe`,
`rebase.exe`, `rebaseall`, `chattr.exe`, `lsattr.exe`, `getfacl.exe`,
`gencat.exe`, `getopt.exe`, `gmondump.exe`, `newgrp.exe`, `profiler.exe`,
`cygwin-console-helper.exe`, plus the DLLs only those import:
`msys-crypto-3`, `msys-asn1-8`, `msys-cbor-0.11`, `msys-com_err-1`, `msys-crypt-2`,
`msys-fido2-1`, `msys-gssapi-3`, `msys-hcrypto-4`, `msys-heimbase-1`, `msys-heimntlm-0`,
`msys-hx509-5`, `msys-krb5-26`, `msys-roken-18`, `msys-sqlite3-0`, `msys-wind-0` and `msys-z`.

The reduction was verified by PE-import analysis, not by guessing: the import
table of every kept executable was walked transitively, and every non-kept DLL
appears in no kept file's closure. The kept DLLs are exactly `msys-2.0`,
`msys-gcc_s-seh-1`, `msys-gmp-10`, `msys-iconv-2`, `msys-intl-8`, `msys-mpfr-6`,
`msys-ncursesw6`, `msys-pcre-1` and `msys-readline8`.

Two files are taken from the second source asset rather than MinGit, because
MinGit does not contain them at all: `usr/bin/sleep.exe` and `usr/bin/seq.exe`
(`coreutils` 8.32-5). Their import tables were walked the same way and resolve
entirely inside the payload - `msys-intl-8.dll`, `msys-2.0.dll` and
`KERNEL32.dll` - so they add two executables and no DLL. The selection rule for
the second asset stays a named-file rule, never a wildcard: the full installer
archive carries far more than the payload needs (Perl, Tcl/Tk, vim, mintty,
OpenSSH, curl and their whole dependency closure), and only `usr/bin/sleep.exe`
and `usr/bin/seq.exe` are taken from it.

### Why `etc/` is part of the payload

The MSYS2 runtime resolves its own root from the executable's location. Two
files decide whether the payload is a self-contained userland or a shell that
resolves its tools against the host:

- `etc/fstab` declares the `usertemp` mount for `/tmp`. Without it, `/tmp` does
  not resolve and MSYS prints `bash.exe: warning: could not find /tmp,
  please create!` on every start, losing a working scratch directory.
- Everything else under `etc/` keeps the payload's own configuration
  (`profile`, `bash.bashrc`, `nsswitch.conf`, `msystem`, and the
  `msystem.d/` and `profile.d/` fragments) inside the package instead of
  inheriting whatever a host Git for Windows install left behind.

`etc/ssh` is deliberately NOT vendored: the payload ships no ssh client, so
its configuration would be dead weight.

### Payload integrity

- `runtime/win32-x64/checksums.sha256` registers every file in the directory
  except itself, in `sha256sum -c` format.
- The host half verifies the whole manifest BEFORE the tool is registered
  (`resolveRuntime` in `src/runtime.ts`). A mismatch refuses the mount with the
  first offending path; a tampered or half-installed payload never runs a
  model-authored command.
- The repository `.gitattributes` pins the payload's binaries (`*.exe`,
  `*.dll`) as `binary`, so a Windows checkout cannot rewrite the bytes the
  digests cover.

## Licensing

Git for Windows is a distribution of many upstream projects, and the parts of
it this package redistributes are licensed under GPL-2.0-or-later and
GPL-3.0-or-later among others. The corresponding texts ship with the payload
in `runtime/win32-x64/licenses/`, so the vendored binaries are never distributed
without their notices.

The Git for Windows umbrella license (`git-for-windows-LICENSE.txt`) is
reproduced verbatim from the upstream archive, together with every license
text that archive itself ships for the components below. For components whose
MSYS2 package ships no license text inside the MinGit archive (bash,
msys2-runtime, coreutils, sed, grep, gawk, findutils, diffutils and dash), the
canonical upstream text of the license named by the MSYS2 package is vendored
instead and listed as such.

`sleep.exe` and `seq.exe` belong to `coreutils` (8.32-5, the version the MinGit
archive itself declares in `etc/package-versions.txt`), which is
GPL-3.0-or-later. Neither source archive ships a coreutils license text - the
MinGit zip has none, and the full `Git-2.56.0.2-64-bit.tar.bz2` carries license
files for many of its bundled packages but none for coreutils - so taking the
two binaries from the second asset adds no new license obligation to satisfy
and no new license file to vendor. The already-vendored canonical
`GPL-3.0.txt` covers them exactly as it already covered the other coreutils
members of the payload (`sort`, `head`, `tail`, `wc`, `uniq`, `tr`, `expr`,
`test`, `cp`, `mv`, `rm`, `cat`), which come from the same MSYS2 package.

| Vendored file | Applies to | License |
| --- | --- | --- |
| `git-for-windows-LICENSE.txt` | the Git for Windows distribution as a whole | GPL-2.0 |
| `GPL-3.0.txt` | bash, msys2-runtime (Cygwin), coreutils (including `sleep.exe` and `seq.exe` from the full Git tarball), sed, grep, gawk, findutils, diffutils | GPL-3.0-or-later |
| `GPL-2.0.txt` | dash, gmp, and the GPLv2 components of the distribution | GPL-2.0 |
| `LGPL-2.1.txt` | libiconv, libintl (gettext-runtime), libxcrypt | LGPL-2.1-or-later |
| `LGPL-3.0.txt` | mpfr, gmp (dual) | LGPL-3.0-or-later |
| `gcc-libs-RUNTIME.LIBRARY.EXCEPTION.txt` | libgcc_s (msys-gcc_s-seh-1.dll) | GCC Runtime Library Exception |
| `ncurses-LICENSE` | ncurses (msys-ncursesw6.dll) | MIT-style |
| `libpcre-LICENCE.txt` | PCRE1 (msys-pcre-1.dll) | BSD-3-Clause |
| `libiconv-COPYING.txt`, `libiconv-COPYING.LIB.txt` | libiconv (msys-iconv-2.dll) | LGPL-2.1-or-later |
| `gettext-runtime-COPYING.txt`, `gettext-runtime-COPYING.LIB.txt` | GNU gettext runtime (msys-intl-8.dll) | LGPL-2.1-or-later |
| `libffi-LICENSE.txt` | libffi | MIT |
| `expat-COPYING.txt` | Expat | MIT |
| `zlib-LICENSE` | zlib | Zlib |
| `libcbor-LICENSE.md` | libcbor | MIT |
| `libfido2-LICENSE.txt` | libfido2 | BSD-2-Clause |
| `heimdal-LICENSE.txt` | Heimdal | BSD-3-Clause |
| `libopenssl-LICENSE.txt` | OpenSSL | Apache-2.0 |
| `libsqlite-LICENSE` | SQLite | Public domain |
| `openssh-LICENCE.txt` | OpenSSH (carried because the MinGit archive ships it for the runtime family; no ssh client is vendored here) | BSD-style |

The package's own source code is Apache-2.0, matching the rest of this
repository. The vendored payload keeps its own licenses; the two do not mix,
which is why the payload sits in its own directory with its own `licenses/`
tree rather than being folded into the package's source.

## Reproducing this payload

Both assets are required; the payload cannot be rebuilt from either one alone.

1. Download `MinGit-2.56.0.2-64-bit.zip` from
   `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip`
   and verify its SHA256 is
   `da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be`.
2. Download `Git-2.56.0.2-64-bit.tar.bz2` from
   `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.tar.bz2`
   and verify its SHA256 is
   `16ca394bdb94b372267d79e1e10b68763674f73e03e0648202a7971a8a730a84`.
   A snapshot whose digest does not match is unusable: stop rather than
   reselecting bytes.
3. Extract the zip with `tar -xf <zip> -C <dir>` (bsdtar handles zip).
4. Copy `usr/bin/*` EXCEPT the excluded names listed above, copy
   `usr/bin/sh.exe` to `usr/bin/bash.exe`, and copy `etc/` minus `etc/ssh`.
5. Extract exactly the two extra files from the tarball, naming them (no
   wildcard):
   `bzip2 -dc Git-2.56.0.2-64-bit.tar.bz2 | tar -xf - -C <dir> usr/bin/sleep.exe usr/bin/seq.exe`
   and copy them into `usr/bin/`. Confirm `sleep.exe` is 36003 bytes /
   `3dfa2435317339e861121c1bd22e57b7b67c204705f00a88b5ac10a0cba87514` and
   `seq.exe` is 68488 bytes /
   `6e5c79fce1d50d888b38f5a0a02a314265e733f151e8b9d2c953b363a60d27d0`.
6. Copy the license texts into `licenses/`. `GPL-3.0.txt` already covers the
   `coreutils` files, including the two just added; step 5 adds no new license
   text.
7. Regenerate `checksums.sha256` over the result, in LF, so it registers 91
   files and 16873759 bytes.

A packaging-time verification script that performs steps 1-7 and checks the
result against a committed manifest is listed as follow-up work in the package
README; this file records what the committed payload IS.
