#!/usr/bin/env bash
# Fail a release PR that bumps package versions while consumed changesets are
# still sitting in `.changeset/`.
#
# Why this exists: publish-packages.yml gates publishing on `.changeset/` being
# empty, and GitHub reports a SKIPPED job as a green run. So a release commit
# that forgets to delete the changesets `changeset version` consumed publishes
# nothing and still shows a tick. That is exactly how 0.2.1 (#107, 151cae6) came
# to be versioned in git, tagged nowhere, and never published to npm — noticed
# two days and three green runs later. This check enforces the same predicate one
# step earlier, on the PR, where the fix is a single `git rm`.
#
# Usage: scripts/check-release-consistency.sh [base-ref]   (default: origin/main)
set -euo pipefail

base="${1:-origin/main}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    echo "error: base ref '${base}' not found. Fetch it first, or pass one explicitly." >&2
    exit 2
fi

merge_base="$(git merge-base "$base" HEAD)"

# Reads a package.json from stdin and prints its `version`, or nothing if the
# field or the JSON is missing. Node rather than jq: this is a Node repo, so it
# is the one interpreter guaranteed on every runner and every contributor's box.
json_version() {
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let v="";try{v=JSON.parse(s).version||""}catch(e){}process.stdout.write(String(v))})'
}

# Newline-delimited rather than arrays: macOS still ships bash 3.2, where an
# empty array expansion trips `set -u`.
bumped=""
while IFS= read -r file; do
    [ -n "$file" ] || continue
    # Deleted in this PR: not a bump.
    [ -f "$file" ] || continue
    # Added in this PR, so there is no previous version to compare against.
    old_version="$(git show "${merge_base}:${file}" 2>/dev/null | json_version)" || true
    [ -n "$old_version" ] || continue
    new_version="$(json_version < "$file")"
    [ -n "$new_version" ] || continue
    if [ "$old_version" != "$new_version" ]; then
        bumped="${bumped}  ${file}: ${old_version} -> ${new_version}
"
    fi
done < <(git diff --name-only "$merge_base" HEAD -- 'packages/*/package.json')

if [ -z "$bumped" ]; then
    echo "No package version changes vs ${base} — ordinary feature branch, pending changesets are expected."
    exit 0
fi

# Mirrors the `find` in publish-packages.yml's `detect` job exactly. If the two
# ever disagree, this check stops meaning anything.
pending=""
if [ -d .changeset ]; then
    pending="$(find .changeset -maxdepth 1 -name '*.md' ! -iname 'README.md' | sort)"
fi

echo "Release branch detected — package versions changed vs ${base}:"
printf '%s' "$bumped"

if [ -n "$pending" ]; then
    echo
    echo "error: these changesets are still present:"
    printf '%s\n' "$pending" | sed 's/^/  /'
    echo
    echo "\`changeset version\` consumes changesets by deleting them, so a release commit"
    echo "must leave .changeset/ holding nothing but config.json. While any remain,"
    echo "publish-packages.yml treats the merge as an ordinary feature commit and skips"
    echo "publishing — reporting the run green while shipping nothing to npm."
    echo
    echo "Fix: delete the files above (their contents are already in the CHANGELOGs), or"
    echo "re-run \`pnpm version:packages\` and commit the full result."
    exit 1
fi

echo
echo "OK: .changeset/ holds no pending entries — this merge will publish."
