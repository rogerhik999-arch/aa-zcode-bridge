#!/bin/bash
# publish-release.sh - put the zip and .sha256 that package-release.mjs built onto the GitHub Release of a tag,
# then download both back and compare (what users install is what was tested).
# Usage: scripts/publish-release.sh v<version> [release-notes.md]
#   Build first: node scripts/package-release.mjs v<version>. The tag must be pushed to origin.
#   The token comes from `git credential fill` for github.com into a shell variable and is never printed.
#   AA_GH_PROXY (default http://127.0.0.1:7897): this network resets direct connections to github.com.
#   Re-running replaces assets of the same name and updates the notes of an existing release.
set -euo pipefail

TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: scripts/publish-release.sh v<version> [release-notes.md]" >&2; exit 2; }
VERSION="${TAG#v}"
NOTES="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ZIP="dist/aa-bridge-reg-$VERSION.zip"
SHA="$ZIP.sha256"
[ -f "$ZIP" ] && [ -f "$SHA" ] || { echo "error: build first: node scripts/package-release.mjs $TAG" >&2; exit 1; }
[ -z "$NOTES" ] || [ -f "$NOTES" ] || { echo "error: no such notes file: $NOTES" >&2; exit 1; }
git rev-parse -q --verify "$TAG^{commit}" > /dev/null || { echo "error: no tag $TAG" >&2; exit 1; }
[ "$(git ls-remote origin "refs/tags/$TAG" | cut -f1 | head -1)" = "$(git rev-parse "$TAG")" ] || { echo "error: tag $TAG is not pushed" >&2; exit 1; }
REPO="$(git remote get-url origin | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"

TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | awk -F= '/^password=/{print $2}')
[ -n "$TOKEN" ] || { echo 'error: no github token from git credential fill' >&2; exit 1; }
PROXY="${AA_GH_PROXY:-http://127.0.0.1:7897}"

api() {  # api METHOD PATH [json] -> body on stdout; non-2xx is an error
  local out st i
  for i in 1 2 3 4 5 6; do
    out=$(curl -sS -m 120 -x "$PROXY" -X "$1" -H "Authorization: Bearer $TOKEN" \
            -H 'Accept: application/vnd.github+json' ${3:+-d "$3"} "https://api.github.com$2" -w $'\n%{http_code}') && break
    sleep 3
  done
  st="${out##*$'\n'}"
  [ "$st" -ge 200 ] && [ "$st" -lt 300 ] || {  # a failed call prints nothing on stdout: its body is not the answer
    printf 'error: %s %s -> HTTP %s: %.200s\n' "$1" "$2" "$st" "${out%$'\n'*}" >&2
    return 1
  }
  printf '%s' "${out%$'\n'*}"
}
field() {  # field KEY... : read nested keys from the JSON on stdin
  python3 -c 'import json,sys
v=json.load(sys.stdin)
for k in sys.argv[1:]: v=v[k]
print(v)' "$@"
}

RELEASE="$(api GET "/repos/$REPO/releases/tags/$TAG" 2>/dev/null || true)"  # 404 = no release yet
if [ -z "$RELEASE" ]; then
  BODY="$(python3 -c 'import json,sys; print(json.dumps({"tag_name": sys.argv[1], "name": "aa-bridge-reg " + sys.argv[1][1:], "body": open(sys.argv[2]).read() if sys.argv[2] else "", "draft": False, "prerelease": False}))' "$TAG" "$NOTES")"
  RELEASE="$(api POST "/repos/$REPO/releases" "$BODY")"
  echo "created release $TAG"
elif [ -n "$NOTES" ]; then
  ID="$(printf '%s' "$RELEASE" | field id)"
  BODY="$(python3 -c 'import json,sys; print(json.dumps({"body": open(sys.argv[1]).read()}))' "$NOTES")"
  RELEASE="$(api PATCH "/repos/$REPO/releases/$ID" "$BODY")"
  echo "updated notes of the existing release $TAG"
fi
ID="$(printf '%s' "$RELEASE" | field id)"
URL="$(printf '%s' "$RELEASE" | field html_url)"
echo "release: $URL"

# an asset of the same name is replaced, so re-running is safe
printf '%s' "$RELEASE" | python3 -c 'import json,sys; [print(a["id"], a["name"]) for a in json.load(sys.stdin).get("assets", [])]' \
  | while read -r aid aname; do
      [ "$aname" = "$(basename "$ZIP")" ] || [ "$aname" = "$(basename "$SHA")" ] || continue
      api DELETE "/repos/$REPO/releases/assets/$aid" > /dev/null && echo "replaced asset $aname"
    done

upload() {  # upload FILE CONTENT-TYPE
  local name out st i
  name="$(basename "$1")"
  for i in 1 2 3; do
    out=$(curl -sS -m 600 -x "$PROXY" -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: $2" \
      --data-binary @"$1" "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$name" -w $'\n%{http_code}') && break
    sleep 3
  done
  st="${out##*$'\n'}"
  [ "$st" -ge 200 ] && [ "$st" -lt 300 ] || { echo "error: upload of $name failed: HTTP $st" >&2; exit 1; }
  echo "uploaded  $name ($(stat -f %z "$1") bytes)"
}
upload "$ZIP" application/zip
upload "$SHA" text/plain

# download both back through the API and compare with what was built
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REL="$(api GET "/repos/$REPO/releases/$ID")"
for pair in "$(basename "$ZIP")|$ZIP" "$(basename "$SHA")|$SHA"; do
  name="${pair%%|*}"; built="${pair##*|}"
  aid="$(printf '%s' "$REL" | python3 -c 'import json,sys; name=sys.argv[1]; print(next(a["id"] for a in json.load(sys.stdin)["assets"] if a["name"]==name))' "$name")"
  for i in 1 2 3; do
    curl -sS -L -m 600 -x "$PROXY" -H "Authorization: Bearer $TOKEN" -H 'Accept: application/octet-stream' \
      -o "$TMP/$name" "https://api.github.com/repos/$REPO/releases/assets/$aid" && break
    sleep 3
  done
  a="$(shasum -a 256 "$TMP/$name" | cut -d' ' -f1)"
  b="$(shasum -a 256 "$built" | cut -d' ' -f1)"
  [ "$a" = "$b" ] || { echo "error: downloaded $name differs from $built" >&2; exit 1; }
  echo "verified  $name sha256 $a"
done
grep -q "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)" "$SHA" || { echo "error: $SHA does not name the zip" >&2; exit 1; }
echo "RESULT: release $TAG published and verified"