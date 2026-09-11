#!/usr/bin/env bash
# Regression tests for scripts/check-release-consistency.sh.
#
# The guard under test is release-critical and its failure mode is silent — a
# skipped publish job reports the run green — so the guard itself must not be
# allowed to quietly stop guarding. A later edit to the version comparison or to
# the changeset predicate it mirrors would otherwise pass CI on every ordinary
# PR, since those only ever exercise the early-exit path.
#
# Each case builds a throwaway git repo under one temp dir and runs a COPY of the
# real script inside it. The copy is load-bearing: the script resolves its repo
# root from its own location, so placing it in the fixture is what points it at
# the fixture rather than at this repo.
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
real_script="$tests_dir/../check-release-consistency.sh"

if [ ! -f "$real_script" ]; then
    echo "error: cannot find check-release-consistency.sh at ${real_script}" >&2
    exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/rc-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failures=0

# Builds a fixture repo whose single commit is tagged `base`: two packages at
# 1.0.0 and an otherwise empty .changeset/, mirroring this repo's layout.
new_fixture() {
    local dir="$work/$1"
    mkdir -p "$dir/packages/sdk" "$dir/packages/cli" "$dir/.changeset" "$dir/scripts"
    cp "$real_script" "$dir/scripts/check-release-consistency.sh"
    printf '{\n    "name": "@scope/sdk",\n    "version": "1.0.0"\n}\n' >"$dir/packages/sdk/package.json"
    printf '{\n    "name": "@scope/cli",\n    "version": "1.0.0"\n}\n' >"$dir/packages/cli/package.json"
    printf '{}\n' >"$dir/.changeset/config.json"
    printf 'placeholder\n' >"$dir/README.md"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email test@example.com
    git -C "$dir" config user.name 'Release Guard Test'
    git -C "$dir" config commit.gpgsign false
    git -C "$dir" add -A
    git -C "$dir" commit -qm base
    git -C "$dir" tag base
    printf '%s' "$dir"
}

set_version() { # set_version <repo> <package> <version>
    printf '{\n    "name": "@scope/%s",\n    "version": "%s"\n}\n' "$2" "$3" >"$1/packages/$2/package.json"
}

add_changeset() { # add_changeset <repo> <name>
    printf -- "---\n'@scope/sdk': patch\n---\n\n%s\n" "$2" >"$1/.changeset/$2.md"
}

commit_all() { git -C "$1" add -A && git -C "$1" commit -qm "$2"; }

expect() { # expect <description> <expected-exit> <repo> [base-ref]
    local desc="$1" want="$2" dir="$3" base="${4:-base}" out status
    set +e
    out="$(cd "$dir" && ./scripts/check-release-consistency.sh "$base" 2>&1)"
    status=$?
    set -e
    if [ "$status" -eq "$want" ]; then
        echo "  ok   — ${desc} (exit ${status})"
    else
        echo "  FAIL — ${desc}: expected exit ${want}, got ${status}"
        printf '%s\n' "$out" | sed 's/^/         | /'
        failures=$((failures + 1))
    fi
}

echo "check-release-consistency.sh"

# The motivating incident: #107 bumped both packages and left behind the
# changeset `changeset version` had already consumed.
dir="$(new_fixture bump-with-leftover)"
add_changeset "$dir" consumed
commit_all "$dir" "add changeset"
set_version "$dir" sdk 1.0.1
set_version "$dir" cli 1.0.1
commit_all "$dir" "version packages"
expect "version bump with a leftover changeset fails" 1 "$dir"

# The same release done correctly.
dir="$(new_fixture clean-release)"
set_version "$dir" sdk 1.0.1
set_version "$dir" cli 1.0.1
commit_all "$dir" "version packages"
expect "version bump with an empty .changeset/ passes" 0 "$dir"

# One package bumped rather than both, to prove the loop does not depend on
# every package moving together.
dir="$(new_fixture single-package-bump)"
add_changeset "$dir" consumed
set_version "$dir" sdk 1.0.1
commit_all "$dir" "version sdk only"
expect "single-package bump with a leftover changeset fails" 1 "$dir"

# An ordinary feature PR: pending changesets are exactly what should be there.
dir="$(new_fixture feature-branch)"
add_changeset "$dir" pending
printf 'edited\n' >"$dir/README.md"
commit_all "$dir" "a feature"
expect "no version change with a pending changeset passes" 0 "$dir"

# A package added by the PR has no base version to compare against, so it must
# not read as a bump.
dir="$(new_fixture added-package)"
add_changeset "$dir" pending
mkdir -p "$dir/packages/new"
printf '{\n    "name": "@scope/new",\n    "version": "0.1.0"\n}\n' >"$dir/packages/new/package.json"
commit_all "$dir" "add a package"
expect "newly added package is not a bump" 0 "$dir"

# Nor is a package the PR removes.
dir="$(new_fixture removed-package)"
add_changeset "$dir" pending
rm "$dir/packages/cli/package.json"
commit_all "$dir" "remove a package"
expect "removed package is not a bump" 0 "$dir"

# A version field that reappears unchanged after an edit elsewhere in the file.
dir="$(new_fixture unrelated-manifest-edit)"
add_changeset "$dir" pending
printf '{\n    "name": "@scope/sdk",\n    "version": "1.0.0",\n    "private": false\n}\n' >"$dir/packages/sdk/package.json"
commit_all "$dir" "edit manifest without touching version"
expect "manifest edit that leaves version alone is not a bump" 0 "$dir"

# A base ref that cannot be resolved is a setup error, distinct from a failure.
dir="$(new_fixture bad-base)"
expect "unresolvable base ref exits 2" 2 "$dir" no-such-ref

echo
if [ "$failures" -ne 0 ]; then
    echo "${failures} test(s) failed"
    exit 1
fi
echo "all tests passed"
