# CI/CD workflows

This repository uses a **Git Flow**‐inspired process with the following branches:

- **feature** branches (e.g. feat/some-cool-feature)
- **dev** for development (collecting features)
- **hotfix** for urgent fixes that need to go to production quickly
- **release-candidate** (staging environment)
- **master** (production)

We have two major paths: **Feature to Dev** and **Hotfix to Hotfix**. In both cases, merging into `dev` or `hotfix` triggers a job that:

- **resets** `release-candidate` to match the incoming branch
- bumps version
- builds a Docker image for staging

Once validated in staging, a manual dispatch of the **Fast forward release-candidate to master** job can fast‐forward `release-candidate` → `master`. Which does:

1. forwards `release-candidate` changes to master (including the version bump commit)
2. makes the image available to production environment
3. propagate changes back into `dev` and `hotfix` via rebase

This ensures `dev` and `hotfix` is always up to date with master.

## High‐Level Diagram

```mermaid
flowchart TD
    %% Nodes
    A[Feature Branches]
    B[dev]
    H[Hotfix Branches]
    G[hotfix]
    C_merge[merge-to-dev-or-hotfix.yml]
    RC[release-candidate]
    D[master]

    %% Dev Flow
    subgraph Dev Flow
        A -->|"(1a) Merge Pull Request"| B
    end

    %% Hotfix Flow
    subgraph Hotfix Flow
        H -->|"(1a) Merge Pull Request"| G
    end

    B -->|"(1b) Merge triggers"| C_merge
    G -->|"(1b) Merge triggers"| C_merge
    
    C_merge -->|"(2) Resets and syncs rc + version bump + push image"| RC

    RC -->|"(3a) Manual step: ff-release-candidate-to-master.yml"| D
    D -->|"(3b) rebases to"| B
    D -->|"(3b) rebases to"| G
```

### Normal Flow

1. **Code Integration**: Branches are merged to either `dev` or `hotfix`
   - Merge triggers `merge-to-dev-or-hotfix.yml` workflow
2. **Staging Preparation**: `merge-to-dev-or-hotfix.yml` workflow:
   - Resets `release-candidate` to match the merged branch
   - Bumps version using `conventional-recommended-bump`
   - Builds and pushes Docker image (`vX.X.X-SHA`) to staging environment (**NOTE:** deployment not automatic)
3. **Production Release**: After staging validation, manually trigger `ff-release-candidate-to-master.yml`:
   - Fast-forwards `master` to match `release-candidate`
   - Tags Docker image as `latest` for production (**NOTE:** deployment not automatic)
   - Creates and pushes Git tag for the release
   - Rebases `hotfix` branch onto `master`
   - Rebases `dev` branch onto `master` (done last to ensure `release-candidate` stays in sync with `dev`)

### Hotfix Flow Example

1. **Initial State**: Commit `A` merges to `dev`

   - `release-candidate` is reset to `dev`, version-bumped (commit `B`)
   - `release-candidate` now contains: `A` + `B`

2. **Hotfix Process**: Fix (commit `C`) merges to `hotfix` branch

   - `release-candidate` is reset to `hotfix`, dropping commits `A` and `B`, and is version-bumped (commit `D`)
   - `release-candidate` now contains: `C` + `D`

3. **Production Release**: Manual trigger of `ff-release-candidate-to-master.yml`
   - `master` is fast-forwarded to match `release-candidate` (`C` + `D`)
   - `hotfix` is rebased on `master` (synced with `C` + `D`)
   - `dev` is rebased on `master` (now contains `C` + `D` + `A`)
   - The `dev` rebase triggers a workflow that:
     - Resets `release-candidate` to `dev`
     - Version-bumps `release-candidate` (new commit `B'`)
     - `release-candidate` now contains: `C` + `D` + `A` + `B'`

Result: All branches contain the hotfix (`C` + `D`). The development work (`A`) remains in `dev` and `release-candidate`, ready for the next production release via the same process.

## Detailed Workflows

Below is a breakdown of each workflow file's responsibilities and when they run.

### Shared Workflow Files (This Repository)

#### 1. reset.yml

- Used by **merge-to-dev-or-hotfix.yml** to reset `release-candidate` to whichever branch was just merged (`dev` or `hotfix`).
- Runs `git reset --hard origin/<base-ref>` and force-pushes back to `<target-ref>`.

#### 2. bump.yml

- Also used in **merge-to-dev-or-hotfix.yml** after the reset.
- Runs `conventional-recommended-bump` to automatically determine if the version should be patch/minor/major, then commits and pushes the new `package.json`

#### 3. build.yml

- Builds and pushes a Docker image to GitHub Container Registry (GHCR).
- The image tag is typically `<package.json version>-<git SHA>`.

#### 4. tag-image.yml

- **After** building an image, we sometimes want an additional "friendly" tag. E.g., `latest` for `master` or `staging` for `release-candidate`.
- This workflow pulls the previously built image and re‐tags/pushes it to GHCR.

#### 5. fast-forward.yml

- Called to do a `--ff-only` merge from a source branch (e.g. `release-candidate`) to a target branch (e.g. `master`).
- If there are commits on the target branch that aren't in the source, fast-forward fails. That's when we fallback to `rebase.yml`.

#### 6. rebase.yml

- Uses rebase to sync the target branch from the source branch
- A **force push** is required after rebasing, as the commit SHAs will change.

#### 7. git-tag.yml

- Creates a new Git tag in the format `v<version>` from the package.json version value.
- Pushes the newly created tag to the remote repository.

#### 8. ff-or-rebase.yml

- Attempts a fast-forward merge, falling back to rebase if necessary.

### Main Repository Workflows (each repository)

These workflows lives in each of the individual repository.

#### 1. checks.yml

- Triggers on all branches and all tags.
- Performs:
  - Setup (Node install, caching)
  - Lint
  - Test
- If the branch is `dev` or it's a tag, then it also builds & pushes an image, and optionally deploys.

This is our "global CI check" pipeline. It ensures code quality (`linting`) and runs unit tests on each code changes.

#### 2. merge-to-dev-or-hotfix.yml

- **Triggers** on `push` events to either the `dev` branch or the `hotfix` branch.
- Once a PR merges into `dev` or `hotfix`, this workflow does:
  1. **Reset**` release-candidate` = `dev` (or hotfix)
  2. **Bump** version (via `conventional-recommended-bump`) on `release-candidate`
  3. **Builds** a Docker image from `release-candidate`
  4. **Tag** the built image (usually "staging") and made available in staging. (**NOTE:** deployment is not done automatically)

This means that every merge into `dev` or `hotfix` automatically flows into `release-candidate` for our staging environment.

#### 3. ff-release-candidate-to-master.yml

This job is manually triggered once staging testing passed. This is the final step in releasing to production. `master` is updated, a production image is pushed, and we sync `dev` and `hotfix` via rebase so that everything is consistent with production.

- Manually triggered in the GitHub Actions UI (i.e. workflow_dispatch)
- Steps:
  - **Fast‐forwards** `master` from `release-candidate`.
  - **Tags** the Docker image with `latest` for production.
  - **Creates a Git tag** for the release and push it to the remote.
  - Uses **rebase** to sync `hotfix` from `master`.
  - Uses **rebase** to sync `dev` from `master`.
