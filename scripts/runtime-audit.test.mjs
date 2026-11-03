import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAdvisories, collectVersions, validateAllowlist } from './runtime-audit.mjs';

const TODAY = '2026-11-02';
const ADVISORY_URL = 'https://github.com/advisories/GHSA-x';
const LINE = 'pkg@1.0.0 GHSA-x (high, vulnerable <1.0.0): T';

function advisory(url = ADVISORY_URL, overrides = {}) {
    return { url, severity: 'high', vulnerable_versions: '<1.0.0', title: 'T', ...overrides };
}

function entry(overrides = {}) {
    return { id: 'GHSA-x', package: 'pkg', reason: 'reason text', expires: '2027-01-01', ...overrides };
}

function classify({ allowlist = [], advisoriesByPackage = { pkg: [advisory()] }, versionsByPackage = { pkg: ['1.0.0'] } } = {}) {
    return classifyAdvisories({ advisoriesByPackage, versionsByPackage, allowlist, today: TODAY });
}

test('collectVersions collects a nested dependencies entry', () => {
    assert.deepEqual(collectVersions({ a: { version: '1', dependencies: { b: { version: '2' } } } }), {
        a: ['1'],
        b: ['2'],
    });
});

test('collectVersions lists both versions of a package seen at two versions', () => {
    const dependencies = {
        a: { version: '1', dependencies: { shared: { version: '1.0.0' } } },
        b: { version: '1', dependencies: { shared: { version: '2.0.0' } } },
    };
    assert.deepEqual(collectVersions(dependencies).shared, ['1.0.0', '2.0.0']);
});

test('collectVersions lists the same version seen twice once', () => {
    const dependencies = {
        a: { version: '1', dependencies: { shared: { version: '1.0.0' } } },
        shared: { version: '1.0.0' },
    };
    assert.deepEqual(collectVersions(dependencies).shared, ['1.0.0']);
});

test('collectVersions yields an empty result for a missing or empty dependencies map', () => {
    assert.deepEqual(collectVersions(undefined), {});
    assert.deepEqual(collectVersions({}), {});
});

for (const field of ['id', 'package', 'reason', 'expires']) {
    test(`validateAllowlist throws naming a missing ${field}`, () => {
        const incomplete = entry();
        delete incomplete[field];
        assert.throws(() => validateAllowlist([incomplete]), {
            message: `Allowlist entry ${JSON.stringify(incomplete)} is missing: ${field}`,
        });
    });
}

test('validateAllowlist names every missing field', () => {
    const incomplete = entry();
    delete incomplete.reason;
    delete incomplete.expires;
    assert.throws(() => validateAllowlist([incomplete]), {
        message: `Allowlist entry ${JSON.stringify(incomplete)} is missing: reason, expires`,
    });
});

test('validateAllowlist returns a valid list unchanged', () => {
    const allowlist = [entry()];
    assert.equal(validateAllowlist(allowlist), allowlist);
});

test('an advisory with no allowlist entry is a failure', () => {
    assert.deepEqual(classify(), { failures: [LINE], ignored: [], unused: [] });
});

test('an entry expiring after today is ignored, not a failure', () => {
    assert.deepEqual(classify({ allowlist: [entry()] }), {
        failures: [],
        ignored: [`ignored until 2027-01-01: ${LINE}\n    reason text`],
        unused: [],
    });
});

test('an entry expiring today is still ignored', () => {
    assert.deepEqual(classify({ allowlist: [entry({ expires: TODAY })] }), {
        failures: [],
        ignored: [`ignored until ${TODAY}: ${LINE}\n    reason text`],
        unused: [],
    });
});

test('an entry expired before today is a failure naming the expiry and reason', () => {
    assert.deepEqual(classify({ allowlist: [entry({ expires: '2026-01-01' })] }), {
        failures: [`${LINE}\n    allowlist entry expired 2026-01-01, re-check: reason text`],
        ignored: [],
        unused: [],
    });
});

test('an entry matching the id but another package does not match', () => {
    const otherPackage = entry({ package: 'other' });
    const { failures, ignored, unused } = classify({ allowlist: [otherPackage] });
    assert.deepEqual(failures, [LINE]);
    assert.deepEqual(ignored, []);
    assert.equal(unused.length, 1);
    assert.equal(unused[0], otherPackage);
});

test('an entry matching nothing is reported unused', () => {
    const stale = entry({ id: 'GHSA-gone' });
    const { failures, ignored, unused } = classify({ allowlist: [stale] });
    assert.deepEqual(failures, [LINE]);
    assert.deepEqual(ignored, []);
    assert.equal(unused.length, 1);
    assert.equal(unused[0], stale);
});

test('an empty advisory response yields no failures', () => {
    const stale = entry();
    const { failures, ignored, unused } = classify({ allowlist: [stale], advisoriesByPackage: {} });
    assert.deepEqual(failures, []);
    assert.deepEqual(ignored, []);
    assert.equal(unused.length, 1);
    assert.equal(unused[0], stale);
});

test('the line lists every shipped version of the package', () => {
    const { failures } = classify({ versionsByPackage: { pkg: ['1.0.0', '2.0.0'] } });
    assert.deepEqual(failures, ['pkg@1.0.0,2.0.0 GHSA-x (high, vulnerable <1.0.0): T']);
});

test('the advisory id is the last path segment of advisory.url', () => {
    const { failures, ignored, unused } = classify({
        allowlist: [entry({ id: 'GHSA-y' })],
        advisoriesByPackage: { pkg: [advisory('https://example.test/a/b/GHSA-y')] },
    });
    assert.deepEqual(failures, []);
    assert.deepEqual(ignored, ['ignored until 2027-01-01: pkg@1.0.0 GHSA-y (high, vulnerable <1.0.0): T\n    reason text']);
    assert.deepEqual(unused, []);
});
