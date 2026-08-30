#!/usr/bin/env bash
# Fast build of the Windows client exe from the Linux dev box — no test gate, no version bump.
# Use this for quick iteration; use ./publish.sh for a release you're about to install/push
# (that one runs the full test suite, bumps VERSION, commits and tags).
#
# Every build here is stamped '<VERSION>+dev.<git-sha>'. That suffix is what tells a scratch build
# apart from the release it was built from — the client reports it in every Ping and the server
# refuses to accept it as an update, so a half-finished build can never reach a kid's PC.
#
# Framework-dependent on purpose: ~280 KB instead of 166 MB self-contained, because self-update ships
# this file to every kid's PC (PRD §6.7). Each machine needs the .NET Desktop Runtime installed once:
#   winget install Microsoft.DotNet.DesktopRuntime.10
set -euo pipefail

cd "$(dirname "$0")"
out="${1:-./dist}"

sha=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
git diff --quiet 2>/dev/null || sha="$sha.dirty"

dotnet publish Client.App -c Release -r win-x64 \
    -p:SelfContained=false -p:PublishSingleFile=true -p:DebugType=none \
    -p:BuildMetadata="dev.$sha" \
    -o "$out" --nologo -v q

hash=$(sha256sum "$out/DigitalAid.exe" | cut -d' ' -f1)

echo "built  : $out/DigitalAid.exe"
echo "version: $(cat VERSION)+dev.$sha  (dev build — the server will refuse it)"
echo "sha256 : $hash"
echo "size   : $(du -h "$out/DigitalAid.exe" | cut -f1)"
