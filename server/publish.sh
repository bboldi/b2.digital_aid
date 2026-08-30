#!/usr/bin/env bash
# Cuts a *release* of the server: runs the tests, bumps package.json, commits and tags.
#
#   ./publish.sh patch|minor|major     bump from the current version
#   ./publish.sh 0.2.0                 set an explicit version
#   ./publish.sh                       interactive menu (only when run from a terminal)
#
# It builds nothing, because there is nothing to build — the server has no build step and no
# artifact. The **tag is the release**, and that is exactly why this script exists rather than a
# one-line `npm version`. Without a tag, "0.1.4" names no particular tree: the running server *is*
# the working tree, so a number in package.json is a claim anybody can invalidate by saving a file.
# src/version.js checks that claim against git and appends '+dev.<sha>' when it does not hold, and
# this is the script that makes it hold.
#
# There is no --test counterpart to the client's. A test build exists there because installing on a
# Windows VM is the only way to exercise that half; here you just run the tree.
#
# There is deliberately no deploy step, and no update script anywhere (ADR-0011). Updating a server
# is `git pull && npm install` and a restart, by a human, on purpose.
set -euo pipefail

cd "$(dirname "$0")"

current=$(node -p "require('./package.json').version")

usage() {
    echo "usage: $0 [patch|minor|major|X.Y.Z]" >&2
}

bump=""
for arg in "$@"; do
    case "$arg" in
        -*) echo "error: unknown option '$arg'" >&2; usage; exit 1 ;;
        *)  if [[ -n "$bump" ]]; then
                echo "error: too many arguments" >&2
                usage
                exit 1
            fi
            bump="$arg" ;;
    esac
done

# A release must be reproducible from its tag, so it cannot be cut from uncommitted work. This is the
# whole guarantee: without it two different trees can both call themselves 0.1.4, and the About
# section starts lying about what is running.
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: working tree is dirty — commit or stash first." >&2
    echo "       (a release must match its tag; run the tree as it stands if you just want to test)" >&2
    exit 1
fi

if [[ -z "$bump" ]]; then
    if [[ ! -t 0 ]]; then
        usage
        exit 1
    fi
    echo "current version: $current"
    select choice in patch minor major cancel; do
        case "$choice" in
            patch|minor|major) bump="$choice"; break ;;
            cancel) echo "cancelled."; exit 0 ;;
        esac
    done
fi

IFS=. read -r major minor patch <<< "$current"
case "$bump" in
    major)   version="$((major + 1)).0.0" ;;
    minor)   version="$major.$((minor + 1)).0" ;;
    patch)   version="$major.$minor.$((patch + 1))" ;;
    [0-9]*.[0-9]*.[0-9]*) version="$bump" ;;
    *) echo "error: expected patch|minor|major|X.Y.Z, got '$bump'" >&2; exit 1 ;;
esac

# 'server-v', not 'v': the client already owns the plain vX.Y.Z namespace, and its tags are the
# anchor for every exe ever shipped. Two version lines, one tag namespace each.
tag="server-v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "error: tag $tag already exists." >&2
    exit 1
fi

# Tests before the bump: a failing suite should leave no trace behind.
npm test

# --no-git-tag-version: npm would tag it 'v0.1.4', in the client's namespace. The tag is made below.
npm version "$version" --no-git-tag-version --allow-same-version >/dev/null

git add package.json package-lock.json
git commit -q -m "Release server v$version"
git tag -a "$tag" -m "Server v$version"

echo "version: $version  (committed and tagged $tag)"
echo
echo "Push the tag when you're happy:  git push && git push origin $tag"
