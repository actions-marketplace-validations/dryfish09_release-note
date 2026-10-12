const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseType,
  classify,
  formatLine,
  buildBody,
  getPreviousTag,
} = require('../index.js');

// ---------- parseType ----------
test('parseType: canonical conventional', () => {
  assert.equal(parseType('feat: add login'), 'feat');
  assert.equal(parseType('fix: crash on start'), 'fix');
  assert.equal(parseType('docs: update readme'), 'docs');
  assert.equal(parseType('chore: bump deps'), 'chore');
  assert.equal(parseType('style: reformat'), 'style');
  assert.equal(parseType('hotfix: critical'), 'hotfix');
});

test('parseType: with scope', () => {
  assert.equal(parseType('feat(auth): add login'), 'feat');
  assert.equal(parseType('fix(api): null pointer'), 'fix');
});

test('parseType: breaking marker', () => {
  assert.equal(parseType('feat!: add login'), 'feat');
  assert.equal(parseType('feat(auth)!: add login'), 'feat');
});

test('parseType: bracket style', () => {
  assert.equal(parseType('[feat] add login'), 'feat');
  assert.equal(parseType('[feat](auth) add login'), 'feat');
  assert.equal(parseType('[FEAT] add login'), 'feat');
});

test('parseType: case-insensitive', () => {
  assert.equal(parseType('Feat: add login'), 'feat');
  assert.equal(parseType('FEAT: add login'), 'feat');
  assert.equal(parseType('Feat(auth): add login'), 'feat');
  assert.equal(parseType('FEAT(AUTH): add login'), 'feat');
});

test('parseType: invalid', () => {
  assert.equal(parseType('add login'), null);
  assert.equal(parseType('random title'), null);
  assert.equal(parseType(''), null);
  assert.equal(parseType('123 feat'), null);
});

// ---------- classify ----------
test('classify: known types', () => {
  assert.equal(classify('feat').header, '### Added');
  assert.equal(classify('fix').header, '### Fixed');
  assert.equal(classify('hotfix').header, '### Fixed');
  assert.equal(classify('docs').header, '### Document updates');
  assert.equal(classify('document').header, '### Document updates');
  assert.equal(classify('chore').header, '### Changed');
  assert.equal(classify('style').header, '### Code style updates');
});

test('classify: aliases', () => {
  assert.equal(classify('feature').header, '### Added');
  assert.equal(classify('features').header, '### Added');
  assert.equal(classify('fixes').header, '### Fixed');
  assert.equal(classify('hot-fix').header, '### Fixed');
  assert.equal(classify('documentation').header, '### Document updates');
  assert.equal(classify('chores').header, '### Changed');
  assert.equal(classify('styles').header, '### Code style updates');
});

test('classify: invalid', () => {
  assert.equal(classify(null), null);
  assert.equal(classify('random'), null);
});

// ---------- formatLine ----------
test('formatLine: strip canonical prefix', () => {
  const pr = { title: 'feat(auth): add login', number: 42, user: { login: 'alice' } };
  assert.equal(formatLine(pr), '- add login by @alice in #42');
});

test('formatLine: strip bracket prefix', () => {
  const pr = { title: '[FEAT](auth) add login', number: 7, user: { login: 'bob' } };
  assert.equal(formatLine(pr), '- add login by @bob in #7');
});

test('formatLine: unknown user fallback', () => {
  const pr = { title: 'fix: bug', number: 1, user: null };
  assert.equal(formatLine(pr), '- bug by @unknown in #1');
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

test("buildBody: starts with \"## What's changed\"", () => {
  const date = new Date(2026, 9, 12);
  const body = buildBody(samplePRs, false, date);
  assert.ok(body.startsWith("## What's changed\n"));
});

test('buildBody: groups and ordering', () => {
  const date = new Date(2026, 9, 12);
  const body = buildBody(samplePRs, false, date);

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

  assert.ok(body.endsWith('Released on 12/10/2026'));
});

test('buildBody: merge fix and hotfix under Fixed', () => {
  const date = new Date(2026, 9, 12);
  const body = buildBody(samplePRs, false, date);

  const fixedCount = (body.match(/### Fixed/g) || []).length;
  assert.equal(fixedCount, 1);

  const afterFixed = body.split('### Fixed')[1] || '';
  const fixedSection = afterFixed.split('###')[0];

  assert.match(fixedSection, /- crash by @carol in #3/);
  assert.match(fixedSection, /- null pointer by @dave in #4/);
});

test('buildBody: no duplicate headers', () => {
  const date = new Date(2026, 9, 12);
  const body = buildBody(samplePRs, false, date);

  const headers = body.match(/^### .+$/gm) || [];
  const unique = new Set(headers);
  assert.equal(headers.length, unique.size, `Duplicate headers: ${headers.join(', ')}`);
});

test('buildBody: fails on invalid PR when acceptInvalid=false', () => {
  const prs = [{ title: 'random title', number: 99, user: { login: 'x' } }];
  assert.throws(
    () => buildBody(prs, false, new Date(2026, 9, 12)),
    /not following the convention/
  );
});

test('buildBody: skips invalid PR when acceptInvalid=true', () => {
  const prs = [
    { title: 'random title', number: 99, user: { login: 'x' } },
    { title: 'feat: ok', number: 100, user: { login: 'y' } },
  ];
  const body = buildBody(prs, true, new Date(2026, 9, 12));
  assert.match(body, /### Added/);
  assert.match(body, /- ok by @y in #100/);
  assert.doesNotMatch(body, /#99/);
});

test('buildBody: empty prs still emits header and date line', () => {
  const body = buildBody([], true, new Date(2026, 9, 12));
  assert.equal(body, "## What's changed\n\nReleased on 12/10/2026");
});

// ---------- getPreviousTag ----------
test('getPreviousTag: returns previous tag', () => {
  const tags = ['v2.0.0', 'v1.1.0', 'v1.0.0'].join('\n');
  assert.equal(getPreviousTag('v2.0.0', tags), 'v1.1.0');
});

test('getPreviousTag: null when oldest', () => {
  const tags = ['v2.0.0', 'v1.1.0', 'v1.0.0'].join('\n');
  assert.equal(getPreviousTag('v1.0.0', tags), null);
});

test('getPreviousTag: null when not found', () => {
  const tags = ['v2.0.0', 'v1.0.0'].join('\n');
  assert.equal(getPreviousTag('v3.0.0', tags), null);
});
