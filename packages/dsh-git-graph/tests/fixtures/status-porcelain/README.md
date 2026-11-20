# status porcelain fixture provenance

Real command output captured from real (temporary) git repositories by
`capture.sh`. Every `*.v1.txt` / `*.v2.txt` / `*.branch.txt` pair in this
directory is the literal stdout of a command, not a hand-written string, so
the equivalence tests assert against what git actually prints.

## Commands per case

`capture.sh` builds a repository under `/tmp/gg1-emp/fixture-repo` (plus one
separate empty repository) and, after each state change, records:

| file | command |
| --- | --- |
| `<case>.v1.txt` | `git status --porcelain` |
| `<case>.v2.txt` | `git status --porcelain=v2 --branch` |
| `<case>.branch.txt` | `git rev-parse --abbrev-ref HEAD` (the previous branch source) |
| `manifest.tsv` | `case <TAB> v1 exit <TAB> v2 exit <TAB> abbrev-ref exit` |

## Cases

Cases are cumulative states of one fixture repository (each capture runs after
the previous change), which is deliberate: mixed states (staged + unstaged +
untracked + conflicts) exercise the counting rules harder than isolated ones.

| case | boundary it carries |
| --- | --- |
| `clean` | nothing to report (v2 prints headers only) |
| `modified-unstaged` | worktree modification |
| `staged-modified` | index modification |
| `rename-staged` | pure rename (`2 R.` in v2, `R  old -> new` in v1) |
| `rename-plus-modify` | rename + content change (`2 RM`) |
| `path-with-spaces-modified` | path containing spaces, modified |
| `path-with-spaces-untracked` | path containing spaces, untracked |
| `untracked-directory` | one untracked directory with nested files (one record, not per file) |
| `non-ascii-untracked` | non-ASCII path under the default `core.quotePath` |
| `ignored-present` | `.gitignore`d directory and `*.log` file present: must be counted by neither parser |
| `conflict-uu` | merge conflict `u UU` |
| `conflict-aa` | add/add conflict `u AA` (both conflicts in one state) |
| `conflict-du-approx` | delete/modify attempt that resolved back to a clean tree before capture (recorded as-is; see uncovered boundaries) |
| `many-staged-and-modified` | 200 staged additions + a large dirty file (count scaling) |
| `many-with-untracked-bulk` | plus 50 untracked files in one new directory |
| `detached-head` | detached HEAD (`# branch.head (detached)` vs `HEAD`) |
| `clean-after-changes` | detached HEAD, clean tree (v2 prints `(detached)` with no records) |
| `unborn` | empty repository, unborn HEAD (`# branch.oid (initial)` vs `HEAD` exit 128) |

## Uncovered boundaries

- **Submodules**: not captured; both formats emit one record per submodule, so
  the counting rule is shared, but no fixture proves it here.
- **Paths needing C-quoting beyond non-ASCII** (embedded newline, tab, quote):
  both v1 and v2 C-quote such paths into one record, which the line-counting
  rule handles, but only the non-ASCII case is captured.
- **A branch literally named `(detached)` / `(unknown)`**: `parseStatusV2`
  maps any `# branch.head` starting with `(` to `''`; git allows such a ref
  name, so that (pathological) case would report an empty branch. The previous
  `rev-parse --abbrev-ref HEAD` source had no such ambiguity.
- **`conflict-du-approx`** did not reproduce a delete/modify conflict: the
  capture sequence resolved the tree before capturing. `UU` and `AA` are
  covered; `DU`/`UD`/`AU`/`UA`/`DD` share the v1 unmerged-code set and the v2
  `u` record type, but are not individually captured.
- **`# branch.ab`** (ahead/behind) is absent from all fixtures because the
  fixture repositories have no upstream; the parser skips every `#` header
  line, and a unit test covers the header explicitly.
