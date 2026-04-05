#!/usr/bin/env bash
set -euo pipefail

# Prepare Release: bump version, update CHANGELOG, create tag
# Triggered by workflow_dispatch via prepare-release.yml
# Publish and GitHub Release steps run in the same workflow after this script

# 1. Read current version
CURRENT=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT"

# 2. Get last release tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
echo "Last tag: $LAST_TAG"
LAST_TAG_DATE=$(git log -1 --format=%aI "$LAST_TAG" 2>/dev/null || echo "1970-01-01T00:00:00+00:00")

# 3. Find merged PRs since last tag
echo "Scanning merged PRs since $LAST_TAG..."
PRS=$(gh pr list --state merged --base trunk --search "merged:>=${LAST_TAG_DATE}" --json number,labels,body --limit 100)
PR_COUNT=$(echo "$PRS" | jq length)
echo "Found $PR_COUNT merged PRs"

if [ "$PR_COUNT" -eq 0 ]; then
  echo "No merged PRs since last release. Nothing to do."
  exit 0
fi

# 4. Determine bump type
BUMP="patch"

# Check PR labels directly
for PR_ROW in $(echo "$PRS" | jq -c '.[]'); do
  PR_LABELS=$(echo "$PR_ROW" | jq -r '.labels[].name' 2>/dev/null || true)
  if echo "$PR_LABELS" | grep -q "^minor$"; then
    BUMP="minor"
    echo "Found 'minor' label on PR — will bump minor version"
    break
  fi
done

# Also check linked issue labels
if [ "$BUMP" = "patch" ]; then
  for PR_ROW in $(echo "$PRS" | jq -c '.[]'); do
    PR_BODY=$(echo "$PR_ROW" | jq -r '.body // ""')
    ISSUE_NUMS=$(echo "$PR_BODY" | grep -oP '(?:Closes|Fixes|Resolves)\s+#\K\d+' || true)
    for INUM in $ISSUE_NUMS; do
      ISSUE_LABELS=$(gh issue view "$INUM" --json labels --jq '.labels[].name' 2>/dev/null || true)
      if echo "$ISSUE_LABELS" | grep -q "^minor$"; then
        BUMP="minor"
        echo "Found 'minor' label on issue #$INUM — will bump minor version"
        break 2
      fi
    done
  done
fi

echo "Bump type: $BUMP"

# 5. Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
if [ "$BUMP" = "minor" ]; then
  NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"
else
  NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
fi
echo "New version: $NEW_VERSION"

# Export for subsequent GitHub Actions steps
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NEW_VERSION=$NEW_VERSION" >> "$GITHUB_ENV"
fi

# 6. Update package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Updated package.json to $NEW_VERSION"

# 7. Update package-lock.json
npm install --package-lock-only --ignore-scripts
echo "Updated package-lock.json"

# 8. Update CHANGELOG.md
TODAY=$(date +%Y-%m-%d)
if grep -q '## \[Unreleased\]' CHANGELOG.md; then
  sed -i "s/## \[Unreleased\]/## [${NEW_VERSION}] — ${TODAY}/" CHANGELOG.md
  echo "Updated CHANGELOG.md: [Unreleased] → [${NEW_VERSION}] — ${TODAY}"
else
  echo "WARNING: No [Unreleased] section found in CHANGELOG.md. Skipping CHANGELOG update."
fi

# 9. Commit, tag, push
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
echo "Created tag v${NEW_VERSION}"

git push origin trunk --follow-tags
echo "Pushed to trunk with tag v${NEW_VERSION}"
