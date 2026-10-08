# Upstream provenance and updates

This repository imports the OpenClaw integration only, not the Hindsight server.

- Repository: https://github.com/vectorize-io/hindsight
- Tag: `integrations/openclaw/v0.13.0`
- Resolved commit: `87be3538bf93d3377abdd0569407348da2f10f58`
- Directory: `hindsight-integrations/openclaw`
- License: upstream root `LICENSE` (MIT, Vectorize AI, Inc.)
- Initial local import commit: `3181a96`
- Verified baseline commit (including executable modes): `4fca449`

`upstream/openclaw` contains the unmodified integration directory at its root,
plus the upstream root license. `main` adds fork metadata and recall events.
Keep the baseline branch when publishing/cloning this repository: future updates
use it as the common ancestor, so Git can distinguish upstream changes from fork
changes. Do not squash or replace its history.

## Manual update

Use Git, tar, and a POSIX shell. Start in this repository with a clean working
tree. For a fresh clone, create the local baseline branch once with
`git branch --track upstream/openclaw origin/upstream/openclaw`.

Choose a release tag and independently verify its full commit SHA on upstream.
The example below reproduces the current source. Downloads use a temporary,
shallow, filtered clone without a checkout; only the integration subtree and
root license are extracted. The temporary clone is never added as a remote to
this repository. Git must support partial clones, and the upstream server must
support filtering.

```sh
set -eu
upstream_tag='integrations/openclaw/v0.13.0'
expected_sha='87be3538bf93d3377abdd0569407348da2f10f58'
upstream_subdir='hindsight-integrations/openclaw'
repo_root=$(git rev-parse --show-toplevel)
test -z "$(git status --porcelain)"
git show-ref --verify refs/heads/upstream/openclaw
update_tmp=$(mktemp -d)

git clone --no-checkout --depth=1 --filter=blob:none \
  --branch "$upstream_tag" https://github.com/vectorize-io/hindsight.git \
  "$update_tmp/source"
actual_sha=$(git -C "$update_tmp/source" rev-parse HEAD)
test "$actual_sha" = "$expected_sha"
git -C "$update_tmp/source" archive "HEAD:$upstream_subdir" > "$update_tmp/integration.tar"
git -C "$update_tmp/source" show HEAD:LICENSE > "$update_tmp/LICENSE"

# Git refuses if this branch is already checked out elsewhere.
git worktree add "$update_tmp/baseline" upstream/openclaw
git -C "$update_tmp/baseline" rm -r -- .
tar -xf "$update_tmp/integration.tar" -C "$update_tmp/baseline"
cp "$update_tmp/LICENSE" "$update_tmp/baseline/LICENSE"
git -C "$update_tmp/baseline" add --all
git -C "$update_tmp/baseline" diff --cached --stat
git -C "$update_tmp/baseline" diff --cached
```

Review this isolated baseline before committing. A rerun of the current version
should produce an empty staged diff: in that case skip the commit and remove the
clean worktree. If a command fails, inspect the temporary directory before
removing anything; the main working tree was not replaced.

For a new version, after review:

```sh
git -C "$update_tmp/baseline" commit \
  -m "chore: import $upstream_tag" \
  -m "Upstream-Commit: $actual_sha"
git worktree remove "$update_tmp/baseline"
cd "$repo_root"
git switch -c update/hindsight-next main
git merge --no-commit --no-ff upstream/openclaw
```

Resolve conflicts on the update branch, preserving fork package identity and
recall event behavior. Update the provenance tag and full SHA above, fork version
in both package manifests, and archive filename examples in README.md. Preserve
the license and review upstream changes to dependencies, the manifest, and
packing hooks. Run:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

Review and commit the merge, then publish the update branch for review and the
baseline branch as appropriate. No step here pushes, force-pushes, publishes an
npm package, or changes a live plugin installation. The temporary source clone
can be removed after the update is accepted.
