const { execSync } = require('child_process');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Minimal replacement for @actions/core, so no dependency is needed at runtime.
// ---------------------------------------------------------------------------

function getInput(name) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return process.env[key] || '';
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}<<EOF\n${value}\nEOF\n`);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function warning(msg) {
  process.stdout.write(`::warning::${msg}\n`);
}

function error(msg) {
  process.stdout.write(`::error::${msg}\n`);
}

function setFailed(msg) {
  process.stdout.write(`::error::${msg}\n`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

async function ghApi(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'release-note',
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
    warning(`Could not read commit range ${range}: ${e.message}`);
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

  // Merge groups that share the same header (e.g. fix + hotfix -> "### Fixed")
  const byHeader = new Map();
  for (const g of Object.values(GROUPS)) {
    if (g.items.length === 0) continue;
    if (!byHeader.has(g.header)) {
      byHeader.set(g.header, { order: g.order, header: g.header, items: [] });
    }
    byHeader.get(g.header).items.push(...g.items);
  }

  const sections = [...byHeader.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => `${g.header}\n${g.items.join('\n')}`);

  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateLine = `Released on ${dd}/${mm}/${yyyy}`;

  const whatsChanged = `## What's changed`;

  return sections.length
    ? `${whatsChanged}\n\n${sections.join('\n\n')}\n\n${dateLine}`
    : `${whatsChanged}\n\n${dateLine}`;
}

async function run() {
  const repoName = getInput('repo_name');
  const repoOwner = getInput('repo_owner');
  const ghTag = getInput('gh_tag');
  const acceptInvalid = getInput('accept_invalid_commit').toLowerCase() === 'true';
  const token = getInput('github_token') || process.env.GITHUB_TOKEN;
  const releaseName = getInput('release_name') || `Release ${ghTag}`;
  const draft = getInput('draft').toLowerCase() === 'true';
  const prerelease = getInput('prerelease').toLowerCase() === 'true';

  if (!repoName) throw new Error('Input "repo_name" is required.');
  if (!repoOwner) throw new Error('Input "repo_owner" is required.');
  if (!ghTag || !ghTag.trim()) {
    throw new Error('Input "gh_tag" is required and must not be empty.');
  }
  if (!token) {
    throw new Error('No GitHub token available. Set "github_token" or GITHUB_TOKEN.');
  }

  const tagName = ghTag.trim();
  const prevTag = getPreviousTag(tagName);
  info(`Previous tag: ${prevTag || '(none)'}`);
  info(`Current tag:  ${tagName}`);

  const prs = await fetchPRs(repoOwner, repoName, token, prevTag, tagName);
  info(`Found ${prs.length} PR(s).`);

  const body = buildBody(prs, acceptInvalid);
  info('Release notes:');
  info(body);

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

  setOutput('release_url', release.html_url);
  setOutput('release_id', String(release.id));
  setOutput('release_body', body);

  fs.writeFileSync('release-notes.md', body);

  info(`Release created successfully: ${release.html_url}`);
}

if (require.main === module) {
  run().catch((err) => setFailed(err.message));
}

module.exports = {
  parseType,
  classify,
  formatLine,
  buildBody,
  getPreviousTag,
  GROUPS,
};
