#!/usr/bin/env bash
set -e

# Tag validation
if ! git describe --tags --abbrev=0 &>/dev/null; then
    echo "No tags found. Creating initial version..."
    npm version 0.0.1 --no-git-tag-version
    exit 0
fi


LATEST_TAG=$(git describe --tags --abbrev=0)

# Grab commits from latest tag to HEAD, each line = "SHA|commit_subject"
COMMITS_STR=$(git log "$LATEST_TAG"..HEAD --pretty=format:"%H|%s")

# Validate if there are new commits
if [ -z "$COMMITS_STR" ]; then
    echo "No new commits since last tag ($LATEST_TAG). Skipping version bump."
    exit 0
fi

# Run commit-analyzer via an inline Node script
RELEASE_TYPE=$(COMMITS_STR="$COMMITS_STR" node << 'EOF'
  (async () => {
    const { analyzeCommits } = await import('@semantic-release/commit-analyzer');

    const commitsArray = process.env.COMMITS_STR.trim().split('\n');
    const commits = commitsArray.map(line => {
      const [hash, ...messageParts] = line.split('|');
      return { hash, message: messageParts.join('|') };
    });

    try {
      const releaseType = await analyzeCommits({}, { commits, logger: { log: () => {} } }); // suppress logging
      if (releaseType) {
        process.stdout.write(releaseType);
      }
    } catch (error) {
      console.error('Error analyzing commits:', error);
      process.exit(1);
    }
  })();
EOF
)

# Validate if RELEASE_TYPE is empty (no version bump needed)
if [[ ! "$RELEASE_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Invalid release type: $RELEASE_TYPE"
  exit 1
fi

echo "Analyzed release type: $RELEASE_TYPE"

npm version "$RELEASE_TYPE" --no-git-tag-version --allow-same-version
