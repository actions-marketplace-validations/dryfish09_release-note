# Auto Release (Conventional Commits) Action

Automatically creates a GitHub Release, parses conventional commits from PR titles, and groups them by type:

- `feat` -> `### Added`
- `fix`, `hotfix` -> `### Fixed`
- `docs`, `document` -> `### Document updates`
- `chore` -> `### Changed`
- `style` -> `### Code style updates`

The release note ends with `Release on dd/mm/yyyy`.

Line format: `<parsed pr name> by @<username> in #<pr>`

## Supported commit formats

Type is case-insensitive:

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

## Usage

```yaml
name: Release
on:
  push:
    tags: ['v*.*.*']

permissions:
  contents: write
  pull-requests: read

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: your-org/auto-release-action@v1
        with:
          repo_name: ${{ github.event.repository.name }}
          repo_owner: ${{ github.repository_owner }}
          gh_tag: ${{ github.ref_name }}
          accept_invalid_commit: 'false'
```

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| repo_name | yes | | Repository name |
| repo_owner | yes | | Repository owner |
| gh_tag | yes | | Tag used to create the release (e.g. v1.2.3) |
| accept_invalid_commit | no | false | false: fail on invalid PRs. true: skip them |
| github_token | no | ${{ github.token }} | Token used for API calls |
| release_name | no | Release <gh_tag> | Release name |
| draft | no | false | Create as draft |
| prerelease | no | false | Mark as prerelease |

## Outputs

| Name | Description |
|------|-------------|
| release_url | URL of the created release |
| release_id | ID of the created release |
| release_body | Generated release note body |
