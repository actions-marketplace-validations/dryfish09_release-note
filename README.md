# Conventional Release Notes

GitHub Action by [dryfish09](https://github.com/dryfish09). Automatically creates a GitHub Release, parses conventional commits from PR titles, and groups them by type.

Published on the GitHub Marketplace as **Conventional Release Notes** (repo: `dryfish09/release-note`).

## Grouping

| Commit type | Section |
|---|---|
| `feat` | `### Added` |
| `fix`, `hotfix` | `### Fixed` |
| `docs`, `document` | `### Document updates` |
| `chore` | `### Changed` |
| `style` | `### Code style updates` |

Every release note starts with `## What's changed` and ends with `Released on dd/mm/yyyy`.

Line format:

```
- <parsed pr name> by @<username> in #<pr>
```

## Supported commit formats

Type is case-insensitive. Scope and breaking marker are accepted.

- `feat: message`
- `feat(scope): message`
- `feat!: message`
- `feat(scope)!: message`
- `[feat] message`
- `[feat](scope) message`
- `Feat: message`
- `Feat(scope): message`
- `FEAT: message`
- `FEAT(SCOPE): message`

Aliases are also recognized: `feature`, `features`, `fixes`, `hot-fix`, `hotfix`, `documentation`, `chores`, `styles`.

## Example output

```markdown
## What's changed

### Added
- add login with Google by @alice in #101
- dark mode by @bob in #102

### Fixed
- crash on startup by @carol in #103
- null pointer by @dave in #104

### Document updates
- update README by @eve in #105

### Changed
- bump deps by @frank in #106

### Code style updates
- reformat code by @grace in #107

Released on 12/10/2026
```

## Usage

Create `.github/workflows/release.yml` in the target repository:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: write
  pull-requests: read

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: release-note
        uses: dryfish09/release-note@v1
        with:
          repo_name: ${{ github.event.repository.name }}
          repo_owner: ${{ github.repository_owner }}
          gh_tag: ${{ github.ref_name }}
          accept_invalid_commit: 'false'
```

`fetch-depth: 0` is required so the action can read tags and the commit range between the previous tag and the current tag.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `repo_name` | yes | | Repository name |
| `repo_owner` | yes | | Repository owner (user or org) |
| `gh_tag` | yes | | Tag used to create the release (e.g. `v1.2.3`) |
| `accept_invalid_commit` | no | `false` | `false`: fail on invalid PR titles. `true`: skip them |
| `github_token` | no | `${{ github.token }}` | Token used to call the GitHub API |
| `release_name` | no | `Release <gh_tag>` | Release name |
| `draft` | no | `false` | Create the release as a draft |
| `prerelease` | no | `false` | Mark the release as a prerelease |

## Outputs

| Name | Description |
|---|---|
| `release_url` | URL of the created release |
| `release_id` | ID of the created release |
| `release_body` | Generated release note body |

## Permissions

| Permission | Why |
|---|---|
| `contents: write` | Create the release |
| `pull-requests: read` | List PRs associated with commits |

## Behavior

1. Resolves the previous tag from `git tag --sort=-v:refname`.
2. Collects commits in the range `previousTag...gh_tag` (or just `gh_tag` if it is the first tag).
3. Maps each commit to its merged PR via the GitHub API.
4. Parses the PR title to determine the type.
5. Groups entries under the corresponding section.
6. Creates the release with the generated body.

If `accept_invalid_commit` is `false` and at least one PR title does not match a known type, the action fails and lists the offending PRs.

## Error handling

| Error | Cause | Fix |
|---|---|---|
| `Resource not accessible by integration` | Missing `contents: write` | Add the `permissions` block |
| `422 Validation Failed` | Release for that tag already exists | Delete the existing release or use a new tag |
| `Input "gh_tag" is required` | Empty tag input | Pass `gh_tag` explicitly |
| `Found N PR(s) not following the convention` | Invalid PR titles | Rename PRs or set `accept_invalid_commit: 'true'` |

## Development

```bash
npm install
npm test
```

Tests use the built-in `node:test` runner and cover the parser, classification, formatting, and body builder. CI runs on Node 20, 22, and 24, plus `actionlint` for the action metadata.

## License

MIT
