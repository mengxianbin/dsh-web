#!/usr/bin/env bash
# GG-1 夹具采集：在 /tmp 下建真实 git 仓库，逐个边界场景抓
# `git status --porcelain` 与 `git status --porcelain=v2 --branch` 的原始输出。
# 产物：/tmp/gg1-emp/capture/<case>.v1.txt / <case>.v2.txt / manifest.tsv
set -uo pipefail
ROOT=/tmp/gg1-emp/capture
REPO=/tmp/gg1-emp/fixture-repo
rm -rf "$ROOT" "$REPO"
mkdir -p "$ROOT" "$REPO"
cd "$REPO"
git init -q -b main .
git config user.email fixture@example.com
git config user.name Fixture
git config commit.gpgsign false

capture() {
  local case="$1"
  git status --porcelain > "$ROOT/$case.v1.txt" 2>"$ROOT/$case.v1.err"
  local v1=$?
  git status --porcelain=v2 --branch > "$ROOT/$case.v2.txt" 2>"$ROOT/$case.v2.err"
  local v2=$?
  # 旧实现的 branch 来源：rev-parse --abbrev-ref HEAD（退出码一并记录）。
  git rev-parse --abbrev-ref HEAD > "$ROOT/$case.branch.txt" 2>/dev/null
  local vb=$?
  printf '%s\t%s\t%s\t%s\n' "$case" "$v1" "$v2" "$vb" >> "$ROOT/manifest.tsv"
  echo "[capture] $case v1_lines=$(wc -l < "$ROOT/$case.v1.txt" | tr -d ' ') v2_lines=$(wc -l < "$ROOT/$case.v2.txt" | tr -d ' ') abbrev_ref_exit=$vb"
}

# 基线提交
mkdir -p src docs
printf 'alpha\n' > src/alpha.txt
printf 'beta\n' > src/beta.txt
printf 'gamma\n' > docs/gamma.txt
git add -A && git commit -qm base
BASE_COMMIT=$(git rev-parse HEAD)

capture clean

# 未暂存修改 + 暂存修改
printf 'alpha changed\n' > src/alpha.txt
capture modified-unstaged
git add src/alpha.txt
capture staged-modified
git commit -qm "modify alpha"

# 重命名（纯重命名 + 重命名带修改）
git mv src/beta.txt src/beta-renamed.txt
capture rename-staged
printf 'beta tweaked\n' >> src/beta-renamed.txt
capture rename-plus-modify
git add -A && git commit -qm "rename beta"

# 路径含空格（修改 + 未跟踪）
printf 'space file\n' > "docs/file with spaces.txt"
git add "docs/file with spaces.txt" && git commit -qm "space file"
printf 'space changed\n' >> "docs/file with spaces.txt"
capture path-with-spaces-modified
printf 'new\n' > "docs/another file with spaces.txt"
capture path-with-spaces-untracked

# 未跟踪目录（目录内多文件 -> v1 一行、v2 一行）
mkdir -p untracked-dir/nested
printf 'u1\n' > untracked-dir/u1.txt
printf 'u2\n' > untracked-dir/nested/u2.txt
capture untracked-directory

# 非 ASCII 路径（core.quotePath 默认 true）
printf 'unicode\n' > "docs/文档.txt"
capture non-ascii-untracked

# 忽略文件不得计入
printf 'ignored-dir/\n*.log\n' > .gitignore
mkdir -p ignored-dir && printf 'x\n' > ignored-dir/x.txt
printf 'log\n' > docs/debug.log
git add .gitignore && git commit -qm "gitignore"
capture ignored-present

# 冲突：UU（双方修改同一行）
git checkout -q -b side
printf 'alpha side\n' > src/alpha.txt
git commit -qam "side edit"
git checkout -q main
printf 'alpha main\n' > src/alpha.txt
git commit -qam "main edit"
git merge side >/dev/null 2>&1
capture conflict-uu
git merge --abort

# 冲突：AA（双方各自新增同名文件）
git checkout -q -b add-both side
printf 'from side\n' > docs/added-both.txt
git add docs/added-both.txt && git commit -qm "side add"
git checkout -q main
printf 'from main\n' > docs/added-both.txt
git add docs/added-both.txt && git commit -qm "main add"
git merge add-both >/dev/null 2>&1
capture conflict-aa
git merge --abort

# 冲突：DU（我方删除、对方修改）
git checkout -q -b del-branch main
printf 'to delete\n' > docs/to-delete.txt
git add docs/to-delete.txt && git commit -qm "add to-delete"
git checkout -q -b dup-main main
git rm -q docs/to-delete.txt && git commit -qm "delete it"
git merge del-branch >/dev/null 2>&1 || true
git checkout -q --theirs docs/to-delete.txt 2>/dev/null || true
capture conflict-du-approx
git merge --abort 2>/dev/null || git reset -q --hard HEAD

# 大规模：200 修改 + 50 未跟踪
for i in $(seq 1 200); do printf 'mod %s\n' "$i" >> "docs/gamma.txt"; printf 'f%s\n' "$i" > "src/many-$i.txt"; done
git add src/many-*.txt 2>/dev/null
capture many-staged-and-modified
mkdir -p bulk && for i in $(seq 1 50); do printf 'b%s\n' "$i" > "bulk/b$i.txt"; done
capture many-with-untracked-bulk

# 分离头指针
git checkout -q --detach "$BASE_COMMIT"
capture detached-head

# 干净仓（分离态下清理工作树）
git checkout -q -- . 2>/dev/null || true
git stash -q -u 2>/dev/null || true
capture clean-after-changes

# 空仓（unborn HEAD）
EMPTY=/tmp/gg1-emp/empty-repo-2
rm -rf "$EMPTY" && mkdir -p "$EMPTY" && cd "$EMPTY" && git init -q -b main .
git status --porcelain > "$ROOT/unborn.v1.txt" 2>/dev/null
git status --porcelain=v2 --branch > "$ROOT/unborn.v2.txt" 2>/dev/null
git rev-parse --abbrev-ref HEAD > "$ROOT/unborn.branch.txt" 2>/dev/null
printf 'unborn\t0\t0\t%s\n' "$?" >> "$ROOT/manifest.tsv"
echo "[capture] unborn v2_lines=$(wc -l < "$ROOT/unborn.v2.txt" | tr -d ' ')"

echo "capture dir: $ROOT"
ls "$ROOT" | wc -l | tr -d ' ' | sed 's/^/files: /'
