const { execFileSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Minimal replacement for @actions/core, so no dependency is needed at runtime.
// ---------------------------------------------------------------------------

function getInput(name) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (process.env[key] || '').trim();
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `ghadelimiter_${crypto.randomUUID()}`;
  fs.appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

function sh(args) {
  const [cmd, ...rest] = args;
  return execFileSync(cmd, rest, { encoding: 'utf8' }).trim();
}

async function ghApi(path, token, options = {}, attempt = 0) {
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

  // Handle rate limit / secondary rate limit with backoff
  if ((res.status === 403 || res.status === 429) && attempt < 3) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const resetAt = Number(res.headers.get('x-ratelimit-reset'));
    let waitMs = 5000 * (attempt + 1);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      waitMs = retryAfter * 1000;
    } else if (Number.isFinite(resetAt) && resetAt > 0) {
      waitMs = Math.max(0, resetAt * 1000 - Date.now()) + 1000;
    }
    warning(`GitHub API ${res.status} on ${path}, retrying in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return ghApi(path, token, options, attempt + 1);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function listLocalTags() {
  try {
    const raw = sh(['git', 'tag', '--sort=-v:refname']);
    return raw.split('\n').map((t) => t.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns the previous tag relative to `currentTag`.
 * Prefers local tags; if not available (common on shallow checkout),
 * falls back to GitHub API listing of tags.
 */
async function getPreviousTag(currentTag, tags, { owner, repo, token } = {}) {
  const localTags = tags ?? listLocalTags();

  if (localTags.length > 0) {
    const idx = localTags.indexOf(currentTag);
    if (idx >= 0 && idx + 1 < localTags.length) return localTags[idx + 1];
    if (idx === -1) {
      warning(`Tag "${currentTag}" not found in local tags; falling back to API.`);
    }
  }

  if (owner && repo && token) {
    try {
      const res = await ghApi(`/repos/${owner}/${repo}/tags?per_page=100`, token);
      if (res.ok) {
        const remoteTags = (await res.json()).map((t) => t.name);
        const idx = remoteTags.indexOf(currentTag);
        if (idx >= 0 && idx + 1 < remoteTags.length) return remoteTags[idx + 1];
        if (idx === -1) {
          warning(`Tag "${currentTag}" not found in remote tags either.`);
        }
      }
    } catch (e) {
      warning(`Failed to fetch remote tags: ${e.message}`);
    }
  }

  return null;
}

async function fetchPRs(owner, repo, token, prevTag, currentTag) {
  const range = prevTag ? `${prevTag}...${currentTag}` : currentTag;

  let shas = [];
  try {
    shas = sh(['git', 'log', range, '--pretty=format:%H'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    warning(`Could not read commit range ${range}: ${e.message}`);
    return [];
  }

  // Deduplicate shas in case of weird history
  shas = [...new Set(shas)];

  const prMap = new Map();
  for (const sha of shas) {
    const res = await ghApi(`/repos/${owner}/${repo}/commits/${sha}/pulls`, token);
    if (!res.ok) continue;
    const prs = await res.json();
    for (const pr of prs) {
      if (!pr.merged_at) continue;
      // Keep the earliest-merged occurrence to avoid clobbering
      if (!prMap.has(pr.number)) prMap.set(pr.number, pr);
    }
  }

  // Sort by PR number ascending for stable output
  return [...prMap.values()].sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Supported formats (type is case-insensitive):
 *   feat: message
 *   feat(scope): message
 *   feat!: message
 *   feat(scope)!: message
 *   [feat] message
 *   [feat](scope) message
 *   Feat: message
 *   FEAT(SCOPE): message
 *
 * Returns { type, scope, message } or null.
 */
function parseType(title) {
  const t = (title ?? '').trim();

  const bracketMatch = t.match(/^\[([a-zA-Z]+)\](?:\(([^)]+)\))?[\s:]+(.*)$/);
  if (bracketMatch) {
    return {
      type: bracketMatch[1].toLowerCase(),
      scope: bracketMatch[2] || null,
      message: (bracketMatch[3] || '').trim(),
    };
  }

  const convMatch = t.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?\s*:\s*(.*)$/);
  if (convMatch) {
    return {
      type: convMatch[1].toLowerCase(),
      scope: convMatch[2] || null,
      message: (convMatch[4] || '').trim(),
    };
  }

  return null;
}

// Canonical group definitions (factory so state is never shared).
function createGroups() {
  return {
    feat: { order: 1, header: '### Added', items: [] },
    fix: { order: 2, header: '### Fixed', items: [] },
    hotfix: { order: 2, header: '### Fixed', items: [] },
    perf: { order: 3, header: '### Performance', items: [] },
    docs: { order: 4, header: '### Document updates', items: [] },
    document: { order: 4, header: '### Document updates', items: [] },
    chore: { order: 5, header: '### Changed', items: [] },
    refactor: { order: 5, header: '### Changed', items: [] },
    style: { order: 6, header: '### Code style updates', items: [] },
    test: { order: 7, header: '### Tests', items: [] },
    build: { order: 8, header: '### Build', items: [] },
    ci: { order: 8, header: '### CI', items: [] },
  };
}

// Single source of truth: alias -> canonical group key.
const ALIASES = {
  feat: 'feat', feature: 'feat', features: 'feat',
  fix: 'fix', fixes: 'fix', fixed: 'fix', bugfix: 'fix', bug: 'fix',
  hotfix: 'hotfix', 'hot-fix': 'hotfix', 'hot_fix': 'hotfix',
  perf: 'perf', performance: 'perf',
  docs: 'docs', doc: 'docs', document: 'document', documentation: 'docs', documents: 'docs',
  chore: 'chore', chores: 'chore',
  refactor: 'refactor',
  style: 'style', styles: 'style',
  test: 'test', tests: 'test',
  build: 'build',
  ci: 'ci',
};

function classify(type, groups) {
  if (!type) return null;
  const canonical = ALIASES[type];
  if (!canonical) return null;
  return groups[canonical] || null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatLine(pr, parsed) {
  const scope = parsed?.scope ? `**${parsed.scope}:** ` : '';
  const rawMessage = parsed?.message || pr.title;
  // Fallback: strip a leading "type: " / "type(scope): " if parseType missed it
  const message = rawMessage
    .replace(/^\[[^\]]+\](?:\([^)]+\))?[\s:]*/, '')
    .replace(/^[a-zA-Z]+(?:\([^)]+\))?!?\s*:\s*/, '')
    .trim();
  const username = pr.user?.login ?? 'unknown';
  return `- ${scope}${message} by @${username} in #${pr.number}`;
}

function buildBody(prs, acceptInvalid, now = new Date()) {
  const groups = createGroups();
  const invalid = [];

  for (const pr of prs) {
    const parsed = parseType(pr.title);
    const group = classify(parsed?.type, groups);

    if (!group) {
      invalid.push(pr);
      continue;
    }

    group.items.push(formatLine(pr, parsed));
  }

  if (invalid.length > 0 && !acceptInvalid) {
    const list = invalid.map((pr) => `#${pr.number} "${pr.title}"`).join(', ');
    throw new Error(
      `Found ${invalid.length} PR(s) not following the convention: ${list}. ` +
        `Set accept_invalid_commit: true to skip them.`
    );
  }

  // Merge groups that share the same header (e.g. fix + hotfix -> "### Fixed")
  const byHeader = new Map();
  for (const g of Object.values(groups)) {
    if (g.items.length === 0) continue;
    if (!byHeader.has(g.header)) {
      byHeader.set(g.header, { order: g.order, header: g.header, items: [] });
    }
    byHeader.get(g.header).items.push(...g.items);
  }

  const sections = [...byHeader.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => `${g.header}\n${g.items.join('\n')}`);

  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  const dateLine = `Released on ${yyyy}-${mm}-${dd}`;

  const whatsChanged = `## What's changed`;

  return sections.length
    ? `${whatsChanged}\n\n${sections.join('\n\n')}\n\n${dateLine}`
    : `${whatsChanged}\n\n${dateLine}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run() {
  const repoName = getInput('repo_name');
  const repoOwner = getInput('repo_owner');
  const ghTag = getInput('gh_tag');
  const acceptInvalid = getInput('accept_invalid_commit').toLowerCase() === 'true';
  const token = getInput('github_token') || (process.env.GITHUB_TOKEN || '').trim();
  const releaseName = getInput('release_name') || `Release ${ghTag}`;
  const draft = getInput('draft').toLowerCase() === 'true';
  const prerelease = getInput('prerelease').toLowerCase() === 'true';

  if (!repoName) throw new Error('Input "repo_name" is required.');
  if (!repoOwner) throw new Error('Input "repo_owner" is required.');
  if (!ghTag) {
    throw new Error('Input "gh_tag" is required and must not be empty.');
  }
  if (!token) {
    throw new Error('No GitHub token available. Set "github_token" or GITHUB_TOKEN.');
  }

  const tagName = ghTag;
  const prevTag = await getPreviousTag(tagName, undefined, {
    owner: repoOwner,
    repo: repoName,
    token,
  });
  info(`Previous tag: ${prevTag || '(none)'}`);
  info(`Current tag:  ${tagName}`);

  const prs = await fetchPRs(repoOwner, repoName, token, prevTag, tagName);
  info(`Found ${prs.length} PR(s).`);

  const body = buildBody(prs, acceptInvalid);
  info(`Release notes generated (${body.length} chars).`);
  info(body.length > 4000 ? body.slice(0, 4000) + '\n...(truncated)' : body);

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
  createGroups,
  ALIASES,
};
