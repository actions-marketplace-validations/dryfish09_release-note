const core = require('@actions/core');
const { execSync } = require('child_process');
const fs = require('fs');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

async function ghApi(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'auto-release-action',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  return res;
}

function getPreviousTag(currentTag, tagsRaw) {
  try {
    const tags = (tagsRaw ?? sh('git tag --sort=-v:refname'))
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const idx = tags.indexOf(currentTag);
    if (idx >= 0 && idx + 1 < tags.length) return tags[idx + 1];
    return null;
  } catch {
    return null;
  }
}

async function fetchPRs(owner, repo, token, prevTag, currentTag) {
  const range = prevTag ? `${prevTag}...${currentTag}` : currentTag;

  let shas = [];
  try {
    shas = sh(`git log ${range} --pretty=format:%H`)
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    core.warning(`Could not read commit range ${range}: ${e.message}`);
  }

  const prMap = new Map();
  for (const sha of shas) {
    const res = await ghApi(`/repos/${owner}/${repo}/commits/${sha}/pulls`, token);
    if (!res.ok) continue;
    const prs = await res.json();
    for (const pr of prs) {
      if (!pr.merged_at) continue;
      prMap.set(pr.number, pr);
    }
  }
  return [...prMap.values()];
}

/**
 * Supported formats (type is case-insensitive):
 *   feat: message
 *   feat(scope): message
 *   feat!: message
 *   feat(scope)!: message
 *   [feat] message
 *   [feat](scope) message
 *   Feat: message
 *   Feat(scope): message
 *   FEAT: message
 *   FEAT(SCOPE): message
 */
function parseType(title) {
  const t = title.trim();

  const bracketMatch = t.match(/^\[([a-zA-Z]+)\](?:\(([^)]+)\))?[\s:]+/);
  if (bracketMatch) return bracketMatch[1].toLowerCase();

  const convMatch = t.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?\s*:\s*/);
  if (convMatch) return convMatch[1].toLowerCase();

  return null;
}

const GROUPS = {
  feat: { order: 1, header: '### Added', items: [] },
  fix: { order: 2, header: '### Fixed', items: [] },
  hotfix: { order: 2, header: '### Fixed', items: [] },
  docs: { order: 3, header: '### Document updates', items: [] },
  document: { order: 3, header: '### Document updates', items: [] },
  chore: { order: 4, header: '### Changed', items: [] },
  style: { order: 5, header: '### Code style updates', items: [] },
};

function classify(type) {
  if (!type) return null;
  if (GROUPS[type]) return GROUPS[type];
  if (/^features?$/.test(type)) return GROUPS.feat;
  if (/^fix(es|ed)?$/.test(type)) return GROUPS.fix;
  if (/^hot[-_]?fix(es)?$/.test(type)) return GROUPS.hotfix;
  if (/^doc(s|umentation|uments?)?$/.test(type)) return GROUPS.docs;
  if (/^chores?$/.test(type)) return GROUPS.chore;
  if (/^styles?$/.test(type)) return GROUPS.style;
  return null;
}

function formatLine(pr) {
  const name = pr.title
    .replace(/^\[[^\]]+\](?:\([^)]+\))?[\s:]*/, '')
    .replace(/^[a-zA-Z]+(?:\([^)]+\))?!?\s*:\s*/, '')
    .trim();
  const username = pr.user?.login ?? 'unknown';
  return `- ${name} by @${username} in #${pr.number}`;
}

function buildBody(prs, acceptInvalid, now = new Date()) {
  for (const g of Object.values(GROUPS)) g.items = [];

  const invalid = [];

  for (const pr of prs) {
    const type = parseType(pr.title);
    const group = classify(type);

    if (!group) {
      invalid.push(pr);
      continue;
    }

    group.items.push(formatLine(pr));
  }

  if (invalid.length > 0 && !acceptInvalid) {
    throw new Error(
      `Found ${invalid.length} PR(s) not following the convention. ` +
        `Set accept_invalid_commit: true to skip them.`
    );
  }

  const sections = Object.values(GROUPS)
    .sort((a, b) => a.order - b.order)
    .filter((g) => g.items.length > 0)
    .map((g) => `${g.header}\n${g.items.join('\n')}`);

  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateLine = `Release on ${dd}/${mm}/${yyyy}`;

  return sections.length
    ? `${sections.join('\n\n')}\n\n${dateLine}`
    : `${dateLine}`;
}

async function run() {
  const repoName = core.getInput('repo_name', { required: true });
  const repoOwner = core.getInput('repo_owner', { required: true });
  const ghTag = core.getInput('gh_tag', { required: true });
  const acceptInvalid =
    core.getInput('accept_invalid_commit').toLowerCase() === 'true';
  const token = core.getInput('github_token', { required: true });
  const releaseName = core.getInput('release_name') || `Release ${ghTag}`;
  const draft = core.getInput('draft').toLowerCase() === 'true';
  const prerelease = core.getInput('prerelease').toLowerCase() === 'true';

  if (!ghTag || !ghTag.trim()) {
    throw new Error('Input "gh_tag" is required and must not be empty.');
  }

  const tagName = ghTag.trim();
  const prevTag = getPreviousTag(tagName);
  core.info(`Previous tag: ${prevTag || '(none)'}`);
  core.info(`Current tag:  ${tagName}`);

  const prs = await fetchPRs(repoOwner, repoName, token, prevTag, tagName);
  core.info(`Found ${prs.length} PR(s).`);

  const body = buildBody(prs, acceptInvalid);
  core.info('Release notes:');
  core.info(body);

  const createRes = await ghApi(
    `/repos/${repoOwner}/${repoName}/releases`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tagName,
        name: releaseName,
        body,
        draft,
        prerelease,
      }),
    }
  );

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Failed to create release (${createRes.status}): ${text}`);
  }

  const release = await createRes.json();

  core.setOutput('release_url', release.html_url);
  core.setOutput('release_id', String(release.id));
  core.setOutput('release_body', body);

  fs.writeFileSync('release-notes.md', body);

  core.info(`Release created successfully: ${release.html_url}`);
}

if (require.main === module) {
  run().catch((err) => core.setFailed(err.message));
}

module.exports = {
  parseType,
  classify,
  formatLine,
  buildBody,
  getPreviousTag,
  GROUPS,
};
