const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseType,
  classify,
  formatLine,
  buildBody,
  getPreviousTag,
  createGroups,
  ALIASES,
} = require('../index.js');

// Helper: build a parsed object from a title, the same way buildBody does.
const parse = (title) => parseType(title);

// Helper: get a group for a type using a fresh groups map.
const groupFor = (type) => {
  const groups = createGroups();
  return classify(type, groups);
};

// ---------- parseType ----------
test('parseType: canonical conventional', () => {
  assert.equal(parse('feat: add login').type, 'feat');
  assert.equal(parse('fix: crash on start').type, 'fix');
  assert.equal(parse('docs: update readme').type, 'docs');
  assert.equal(parse('chore: bump deps').type, 'chore');
  assert.equal(parse('style: reformat').type, 'style');
  assert.equal(parse('hotfix: critical').type, 'hotfix');
});

test('parseType: extracts message', () => {
  assert.equal(parse('feat: add login').message, 'add login');
  assert.equal(parse('fix: crash on start').message, 'crash on start');
  assert.equal(parse('feat(auth): add login').message, 'add login');
});

test('parseType: with scope', () => {
  const a = parse('feat(auth): add login');
  assert.equal(a.type, 'feat');
  assert.equal(a.scope, 'auth');
  assert.equal(a.message, 'add login');

  const b = parse('fix(api): null pointer');
  assert.equal(b.type, 'fix');
  assert.equal(b.scope, 'api');
  assert.equal(b.message, 'null pointer');
});

test('parseType: scope is null when absent', () => {
  assert.equal(parse('feat: add login').scope, null);
  assert.equal(parse('fix: bug').scope, null);
});

test('parseType: breaking marker', () => {
  assert.equal(parse('feat!: add login').type, 'feat');
  assert.equal(parse('feat(auth)!: add login').type, 'feat');
  assert.equal(parse('feat(auth)!: add login').scope, 'auth');
  assert.equal(parse('feat(auth)!: add login').message, 'add login');
});

test('parseType: bracket style', () => {
  const a = parse('[feat] add login');
  assert.equal(a.type, 'feat');
  assert.equal(a.message, 'add login');

  const b = parse('[feat](auth) add login');
  assert.equal(b.type, 'feat');
  assert.equal(b.scope, 'auth');
  assert.equal(b.message, 'add login');

  assert.equal(parse('[FEAT] add login').type, 'feat');
});

test('parseType: case-insensitive', () => {
  assert.equal(parse('Feat: add login').type, 'feat');
  assert.equal(parse('FEAT: add login').type, 'feat');
  assert.equal(parse('Feat(auth): add login').type, 'feat');
  assert.equal(parse('FEAT(AUTH): add login').type, 'feat');
});

test('parseType: invalid', () => {
  assert.equal(parse('add login'), null);
  assert.equal(parse('random title'), null);
  assert.equal(parse(''), null);
  assert.equal(parse('123 feat'), null);
  assert.equal(parse(null), null);
  assert.equal(parse(undefined), null);
});

// ---------- classify ----------
test('classify: known types', () => {
  assert.equal(groupFor('feat').header, '### Added');
  assert.equal(groupFor('fix').header, '### Fixed');
  assert.equal(groupFor('hotfix').header, '### Fixed');
  assert.equal(groupFor('docs').header, '### Document updates');
  assert.equal(groupFor('document').header, '### Document updates');
  assert.equal(groupFor('chore').header, '### Changed');
  assert.equal(groupFor('style').header, '### Code style updates');
});

test('classify: aliases', () => {
  assert.equal(groupFor('feature').header, '### Added');
  assert.equal(groupFor('features').header, '### Added');
  assert.equal(groupFor('fixes').header, '### Fixed');
  assert.equal(groupFor('fixed').header, '### Fixed');
  assert.equal(groupFor('bugfix').header, '### Fixed');
  assert.equal(groupFor('hot-fix').header, '### Fixed');
  assert.equal(groupFor('hot_fix').header, '### Fixed');
  assert.equal(groupFor('documentation').header, '### Document updates');
  assert.equal(groupFor('chores').header, '### Changed');
  assert.equal(groupFor('styles').header, '### Code style updates');
});

test('classify: extended types', () => {
  assert.equal(groupFor('perf').header, '### Performance');
  assert.equal(groupFor('performance').header, '### Performance');
  assert.equal(groupFor('refactor').header, '### Changed');
  assert.equal(groupFor('test').header, '### Tests');
  assert.equal(groupFor('build').header, '### Build');
  assert.equal(groupFor('ci').header, '### CI');
});

test('classify: invalid', () => {
  assert.equal(groupFor(null), null);
  assert.equal(groupFor('random'), null);
  assert.equal(groupFor('xyz'), null);
});

test('classify: does not leak state between calls', () => {
  const groups1 = createGroups();
  const g1 = classify('feat', groups1);
  g1.items.push('- leaked');

  const groups2 = createGroups();
  const g2 = classify('feat', groups2);
  assert.deepEqual(g2.items, []);

  // The ALIASES map should also not be mutated by classify.
  assert.equal(ALIASES.feat, 'feat');
});

// ---------- formatLine ----------
test('formatLine: uses parsed message, strips prefix', () => {
  const pr = { title: 'feat(auth): add login', number: 42, user: { login: 'alice' } };
  const parsed = parse(pr.title);
  assert.equal(formatLine(pr, parsed), '- **auth:** add login by @alice in #42');
});

test('formatLine: no scope', () => {
  const pr = { title: 'feat: add login', number: 1, user: { login: 'bob' } };
  const parsed = parse(pr.title);
  assert.equal(formatLine(pr, parsed), '- add login by @bob in #1');
});

test('formatLine: bracket style', () => {
  const pr = { title: '[FEAT](auth) add login', number: 7, user: { login: 'bob' } };
  const parsed = parse(pr.title);
  assert.equal(formatLine(pr, parsed), '- **auth:** add login by @bob in #7');
});

test('formatLine: unknown user fallback', () => {
  const pr = { title: 'fix: bug', number: 1, user: null };
  const parsed = parse(pr.title);
  assert.equal(formatLine(pr, parsed), '- bug by @unknown in #1');
});

test('formatLine: works without parsed (fallback to regex strip)', () => {
  const pr = { title: 'feat: add login', number: 5, user: { login: 'eve' } };
  assert.equal(formatLine(pr), '- add login by @eve in #5');
});

// ---------- buildBody ----------
const samplePRs = [
  { title: 'feat(auth): add login', number: 1, user: { login: 'alice' } },
  { title: 'FEAT: dark mode', number: 2, user: { login: 'bob' } },
  { title: 'fix: crash', number: 3, user: { login: 'carol' } },
  { title: 'hotfix: null pointer', number: 4, user: { login: 'dave' } },
  { title: 'docs: update readme', number: 5, user: { login: 'eve' } },
  { title: 'chore: bump deps', number: 6, user: { login: 'frank' } },
  { title: 'style: reformat', number: 7, user: { login: 'grace' } },
];

const testDate = new Date(Date.UTC(2026, 9, 12)); // 2026-10-12 UTC

test("buildBody: starts with \"## What's changed\"", () => {
  const body = buildBody(samplePRs, false, testDate);
  assert.ok(body.startsWith("## What's changed\n"));
});

test('buildBody: groups and ordering', () => {
  const body = buildBody(samplePRs, false, testDate);

  assert.match(body, /### Added/);
  assert.match(body, /### Fixed/);
  assert.match(body, /### Document updates/);
  assert.match(body, /### Changed/);
  assert.match(body, /### Code style updates/);

  const idxAdded = body.indexOf('### Added');
  const idxFixed = body.indexOf('### Fixed');
  const idxDocs = body.indexOf('### Document updates');
  const idxChanged = body.indexOf('### Changed');
  const idxStyle = body.indexOf('### Code style updates');

  assert.ok(idxAdded < idxFixed);
  assert.ok(idxFixed < idxDocs);
  assert.ok(idxDocs < idxChanged);
  assert.ok(idxChanged < idxStyle);

  assert.ok(body.endsWith('Released on 2026-10-12'));
});

test('buildBody: date is ISO format (UTC)', () => {
  const body = buildBody([], true, testDate);
  assert.equal(body, "## What's changed\n\nReleased on 2026-10-12");
});

test('buildBody: merge fix and hotfix under Fixed', () => {
  const body = buildBody(samplePRs, false, testDate);

  const fixedCount = (body.match(/### Fixed/g) || []).length;
  assert.equal(fixedCount, 1);

  const afterFixed = body.split('### Fixed')[1] || '';
  const fixedSection = afterFixed.split('###')[0];

  assert.match(fixedSection, /- crash by @carol in #3/);
  assert.match(fixedSection, /- null pointer by @dave in #4/);
});

test('buildBody: no duplicate headers', () => {
  const body = buildBody(samplePRs, false, testDate);

  const headers = body.match(/^### .+$/gm) || [];
  const unique = new Set(headers);
  assert.equal(headers.length, unique.size, `Duplicate headers: ${headers.join(', ')}`);
});

test('buildBody: preserves scope in output', () => {
  const body = buildBody(samplePRs, false, testDate);
  assert.match(body, /- \*\*auth:\*\* add login by @alice in #1/);
});

test('buildBody: fails on invalid PR when acceptInvalid=false', () => {
  const prs = [{ title: 'random title', number: 99, user: { login: 'x' } }];
  assert.throws(
    () => buildBody(prs, false, testDate),
    /not following the convention/
  );
});

test('buildBody: error message lists offending PRs', () => {
  const prs = [{ title: 'random title', number: 99, user: { login: 'x' } }];
  assert.throws(
    () => buildBody(prs, false, testDate),
    /#99 "random title"/
  );
});

test('buildBody: skips invalid PR when acceptInvalid=true', () => {
  const prs = [
    { title: 'random title', number: 99, user: { login: 'x' } },
    { title: 'feat: ok', number: 100, user: { login: 'y' } },
  ];
  const body = buildBody(prs, true, testDate);
  assert.match(body, /### Added/);
  assert.match(body, /- ok by @y in #100/);
  assert.doesNotMatch(body, /#99/);
});

test('buildBody: empty prs still emits header and date line', () => {
  const body = buildBody([], true, testDate);
  assert.equal(body, "## What's changed\n\nReleased on 2026-10-12");
});

test('buildBody: does not leak state between calls', () => {
  const body1 = buildBody(samplePRs, false, testDate);
  const body2 = buildBody([], true, testDate);
  assert.equal(body2, "## What's changed\n\nReleased on 2026-10-12");

  // Second call with same input must be identical (no accumulated items).
  const body3 = buildBody(samplePRs, false, testDate);
  assert.equal(body3, body1);
});

// ---------- getPreviousTag (async now) ----------
test('getPreviousTag: returns previous tag from local array', async () => {
  const tags = ['v2.0.0', 'v1.1.0', 'v1.0.0'];
  assert.equal(await getPreviousTag('v2.0.0', tags), 'v1.1.0');
});

test('getPreviousTag: null when oldest', async () => {
  const tags = ['v2.0.0', 'v1.1.0', 'v1.0.0'];
  assert.equal(await getPreviousTag('v1.0.0', tags), null);
});

test('getPreviousTag: null when not found and no API options', async () => {
  const tags = ['v2.0.0', 'v1.0.0'];
  assert.equal(await getPreviousTag('v3.0.0', tags), null);
});

test('getPreviousTag: null when tags list is empty and no API options', async () => {
  assert.equal(await getPreviousTag('v1.0.0', []), null);
});
