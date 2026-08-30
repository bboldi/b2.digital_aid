#!/usr/bin/env bash
# Builds a *release* client exe: runs the tests, bumps VERSION, publishes, commits, tags, pushes,
# and creates the GitHub Release with the exe attached (ADR-0018).
#
#   ./publish.sh patch|minor|major     bump from the current VERSION
#   ./publish.sh 0.4.0                 set an explicit version
#   ./publish.sh                       interactive menu (only when run from a terminal)
#   ./publish.sh --test                a build for your own test machine, from the tree as it stands
#
# The commit and the tag are the point. Without them 'X.Y.Z' is a label with no anchor: build it,
# tweak a file, build again, and two different exes both claim the same version — and since the
# client updates on SHA-256, both would actually install, leaving the Client Page lying to the
# parent about what is running. The tag makes a version mean exactly one tree.
#
# --test exists because installing on the test VM is the only way to check the Windows half of a
# change, and demanding a commit and a tag for every round of that is a tax on iteration. It skips
# the dirty check, the bump, the commit and the tag, and stamps '<VERSION>-test.<fingerprint>'
# instead — a prerelease tag ('-'), not build metadata ('+'), so the server accepts it, which is the
# whole point. The fingerprint covers HEAD plus every uncommitted and untracked change, so two
# different trees can never produce the same label. That is the invariant the commit was protecting;
# --test keeps it by another means rather than dropping it.
#
# A test build is visibly not a release everywhere it shows up — the Client Page's version column,
# the Ping, the Settings upload list all read '0.2.1-test.a1b2c3d'.
#
# Framework-dependent on purpose: 273 KB instead of 166 MB self-contained, which matters because
# self-update ships this file to every kid's PC (PRD §6.7). The trade is that each machine needs the
# .NET Desktop Runtime installed once, by the parent, at install time:
#   winget install Microsoft.DotNet.DesktopRuntime.10
set -euo pipefail

cd "$(dirname "$0")"

current=$(tr -d '[:space:]' < VERSION)

# Flags are accepted in any position, and anything else beginning with '-' is an error rather than a
# path. Positional parsing cost a real release once: './publish.sh patch --test' read the flag as the
# output directory, published into a folder literally called '--test', and committed and tagged the
# bump it was never meant to make. An unrecognised option must stop the script, not become an
# argument to something further down.
test_build=false
unknown_option=false
positional=()
for arg in "$@"; do
    case "$arg" in
        --test|--ignore-commit) test_build=true ;;
        -*) echo "error: unknown option '$arg'" >&2
            unknown_option=true ;;
        *)  positional+=("$arg") ;;
    esac
done

usage() {
    echo "usage: $0 [patch|minor|major|X.Y.Z] [outdir]" >&2
    echo "       $0 --test [outdir]" >&2
}

if [[ "$unknown_option" == true ]]; then
    usage
    exit 1
fi

# --test takes no bump, so its lone positional is the output directory. Spelling that out here rather
# than letting position decide is what stops 'patch' being read as a folder name, or the reverse.
if [[ "$test_build" == true ]]; then
    if [[ ${#positional[@]} -gt 1 ]]; then
        echo "error: too many arguments: ${positional[*]}" >&2
        usage
        exit 1
    fi
    case "${positional[0]:-}" in
        patch|minor|major|[0-9]*.[0-9]*.[0-9]*)
            echo "error: --test builds the version you already have ($current); it does not bump." >&2
            echo "       drop the '${positional[0]}' and just run: $0 --test" >&2
            exit 1 ;;
    esac
    bump=""
    out="${positional[0]:-./dist}"
else
    if [[ ${#positional[@]} -gt 2 ]]; then
        echo "error: too many arguments: ${positional[*]}" >&2
        usage
        exit 1
    fi
    bump="${positional[0]:-}"
    out="${positional[1]:-./dist}"
fi

if [[ "$test_build" == true ]]; then
    # A fingerprint of the tree as it stands. `git stash create` captures the working tree — tracked
    # modifications included — without touching the worktree or the index, and is empty when clean.
    #
    # Its *tree* object, never the commit it returns: a commit SHA folds in the time it was made, so
    # hashing that gave a different label every second and two builds of identical source would
    # collide with nothing and agree on nothing. The tree is pure content.
    #
    # Untracked files are hashed separately because the stash does not include them, and a new file
    # is exactly the kind of change that would otherwise reuse the previous build's label.
    stash=$(git stash create)
    fingerprint=$(
        {
            git rev-parse "${stash:-HEAD}^{tree}"
            git ls-files --others --exclude-standard -z | xargs -0 -r sha256sum
        } 2>/dev/null | sha256sum | cut -c1-7
    )
    version="$current-test.$fingerprint"
else
    # A release must be reproducible from the tag, so it cannot be cut from uncommitted work.
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "error: working tree is dirty — commit or stash first, or use --test for a build you" >&2
        echo "       just want to install on your own machine (a release must match its tag)." >&2
        exit 1
    fi
fi

if [[ "$test_build" == false && -z "$bump" ]]; then
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

if [[ "$test_build" == false ]]; then
    IFS=. read -r major minor patch <<< "$current"
    case "$bump" in
        major)   version="$((major + 1)).0.0" ;;
        minor)   version="$major.$((minor + 1)).0" ;;
        patch)   version="$major.$minor.$((patch + 1))" ;;
        [0-9]*.[0-9]*.[0-9]*) version="$bump" ;;
        *) echo "error: expected patch|minor|major|X.Y.Z, got '$bump'" >&2; exit 1 ;;
    esac

    if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
        echo "error: tag v$version already exists." >&2
        exit 1
    fi
fi

# Tests before the bump: a failing suite should leave no trace behind. Test builds run them too —
# they cost a couple of seconds, and finding out on the VM is much more expensive.
dotnet test --nologo -v q

# VERSION is only written for a real release. A test build passes its version straight to MSBuild,
# so the file keeps pointing at the last thing that was actually tagged.
[[ "$test_build" == true ]] || echo "$version" > VERSION

dotnet publish Client.App -c Release -r win-x64 \
    -p:SelfContained=false -p:PublishSingleFile=true -p:DebugType=none \
    -p:BaseVersion="$version" \
    -o "$out" --nologo -v q

if [[ "$test_build" == false ]]; then
    git add VERSION
    git commit -q -m "Release client v$version"
    git tag -a "v$version" -m "Client v$version"
fi

hash=$(sha256sum "$out/DigitalAid.exe" | cut -d' ' -f1)

echo "built  : $out/DigitalAid.exe"
if [[ "$test_build" == true ]]; then
    echo "version: $version  (test build — installable, not a release, nothing committed)"
else
    echo "version: $version  (committed and tagged v$version)"
fi
echo "sha256 : $hash"
echo "size   : $(du -h "$out/DigitalAid.exe" | cut -f1)"

# A release ends on GitHub, not in the terminal. The tag anchors the version to a tree; the GitHub
# Release is where a stranger's first exe comes from (ADR-0018) — bare DigitalAid.exe plus its
# checksum, never a zip, because the real Install Kit comes from the family's own server. A tag that
# exists locally but not on GitHub is a half-released state, so this step is automatic rather than a
# flag. Test builds never reach here: they are not releases and never leave the household.
#
# Failure here is a warning, not an error — the release is already committed and tagged, and being
# offline should not unwind it. The printed commands are the by-hand recovery.
if [[ "$test_build" == false ]]; then
    echo
    sha256sum "$out/DigitalAid.exe" | sed 's|  .*/|  |' > "$out/SHA256SUMS.txt"
    if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 \
        && git push && git push origin "v$version" \
        && gh release create "v$version" \
            --title "Client v$version" \
            --notes "SHA-256 \`$hash\`

Upload this exe on your server's **Settings** page — kid PCs install and update from your own server, never from GitHub. Each PC needs the .NET Desktop Runtime once: \`winget install Microsoft.DotNet.DesktopRuntime.10\`. See the README for the full install story." \
            "$out/DigitalAid.exe" "$out/SHA256SUMS.txt"; then
        echo "release: https://github.com/bboldi/b2.digital_aid/releases/tag/v$version"
    else
        echo "warning: GitHub release not created (offline, gh missing, or not authenticated)." >&2
        echo "         finish by hand:  git push && git push origin v$version" >&2
        echo "         gh release create v$version --title 'Client v$version' $out/DigitalAid.exe $out/SHA256SUMS.txt" >&2
    fi
fi
