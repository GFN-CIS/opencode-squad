#!/usr/bin/env bash
# Decide what a release run must do for the version in package.json, and on
# which source revision. Called by .github/workflows/release.yml; writes
# tag, sha, gh_release, on_npm and skip to $GITHUB_OUTPUT.
#
# One version is one revision: the commit the vX.Y.Z tag points at when the
# tag exists, else the pushed commit ($GITHUB_SHA). Remote state is read three
# ways, and "absent" (HTTP 404, npm E404) is kept apart from "unknown" (a
# timeout, an auth or registry error): anything this run would publish or
# create depends on that state, so unknown stops the run instead of being
# read as "not published yet".
set -euo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
tag="v${version}"

# --- GitHub release: present, absent (404) or unknown ---
if gh_out=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" --jq .tag_name 2>&1); then
  gh_release=true
elif grep -q "HTTP 404" <<<"$gh_out"; then
  gh_release=false
else
  fail "Cannot tell whether release $tag exists: $gh_out"
fi

# --- the revision ---
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  sha=$(git rev-list -n 1 "$tag")
elif [ "$gh_release" = true ]; then
  fail "Release $tag exists but its tag does not; cannot tell which revision it is."
else
  sha="$GITHUB_SHA"
fi
tagged=$(git show "${sha}:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
[ "$tagged" = "$version" ] || fail "$tag points at $sha, whose package.json says $tagged."

# --- npm: published (with the commit it was packed from), absent (E404) or unknown ---
npm_json=$(npm view "${name}@${version}" version gitHead --json 2>/dev/null) || true
npm_state=$(node -e '
  let v;
  try { v = JSON.parse(process.argv[1] || "null"); } catch { v = null; }
  const want = process.argv[2];
  if (v && typeof v === "object" && v.error) {
    console.log(v.error.code === "E404" ? "absent" : "unknown " + (v.error.code ?? "error"));
  } else if (v === want) console.log("present -");
  else if (v && v.version === want) console.log("present " + (v.gitHead || "-"));
  else console.log("unknown no-usable-reply"); // empty or garbled: not proof of absence
' "$npm_json" "$version")
case "$npm_state" in
  absent) on_npm=false ;;
  present*)
    on_npm=true
    npm_head=${npm_state#present }
    if [ "$npm_head" != "$sha" ]; then
      why="npm ${name}@${version} records gitHead '${npm_head}', $tag is $sha"
      [ "$npm_head" = "-" ] && why="npm ${name}@${version} records no gitHead; cannot tell it was packed from $sha"
      if [ "$gh_release" = true ]; then
        # Complete already: nothing is published or created. Rewritten history
        # (re-pointed tags) leaves this on releases made before it.
        echo "::warning::$why."
      else
        fail "$why; refusing to create release $tag."
      fi
    fi
    ;;
  *) fail "Cannot tell whether npm has ${name}@${version} (${npm_state#unknown })." ;;
esac

{
  echo "tag=${tag}"
  echo "sha=${sha}"
  echo "gh_release=${gh_release}"
  echo "on_npm=${on_npm}"
} >>"$GITHUB_OUTPUT"
echo "$tag -> $sha; GitHub release: $gh_release, npm: $on_npm"
if [ "$gh_release" = true ] && [ "$on_npm" = true ]; then
  echo "Release $tag exists on GitHub and npm; nothing to do."
  echo "skip=true" >>"$GITHUB_OUTPUT"
else
  echo "skip=false" >>"$GITHUB_OUTPUT"
fi
