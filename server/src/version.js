import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// What this server is, for the About section and for anyone reading a bug report.
//
// The client can afford a simpler answer: its version is baked into an exe at build time, so the
// running build cannot drift from the number it claims. The server has no build step, which means
// **the running server is the working tree** — `git pull`, edit one file, and package.json still
// says 0.1.4 while what is running matches no tag anywhere. So the number is derived, not read:
// package.json's version, plus a `+dev.<sha>` marker whenever git says this tree is not sitting
// exactly on that version's release tag.
//
// Resolved once at startup. A version that changed under the process would be worse than useless in
// a log, and nobody edits a tree they are also running and expects the banner to keep up.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** The bare X.Y.Z from package.json — what publish.sh bumps and tags. */
export const PACKAGE_VERSION = readPackageVersion();

/** What is actually running: PACKAGE_VERSION, or `X.Y.Z+dev.<sha>` for anything off-tag. */
export const VERSION = PACKAGE_VERSION + devSuffix();

/** True when this tree is not the tagged release it claims to be. */
export const IS_DEV_BUILD = VERSION !== PACKAGE_VERSION;

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    // A server that cannot read its own package.json has larger problems, but refusing to boot over
    // a cosmetic string is not the way to report them.
    return '0.0.0';
  }
}

/**
 * '' when this tree is exactly the release tag, '+dev.<sha>' otherwise — including a dirty tree, a
 * tree a few commits past the tag, and a deployment with no git at all (a tarball copy, say), which
 * cannot prove it is the release and therefore does not get to claim it.
 */
function devSuffix() {
  const tag = `server-v${PACKAGE_VERSION}`;
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  try {
    const sha = git('rev-parse', '--short', 'HEAD');
    const dirty = git('status', '--porcelain') !== '';
    if (dirty) return `+dev.${sha}.dirty`;

    // --exact-match: being a descendant of the tag is not being the tag.
    const described = git('describe', '--tags', '--exact-match', 'HEAD');
    return described === tag ? '' : `+dev.${sha}`;
  } catch {
    // No git, no repository, or no tag on HEAD. All of them mean the same thing here.
    return '+dev.unknown';
  }
}
