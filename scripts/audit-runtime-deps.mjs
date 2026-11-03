// Checks the npm packages this Meteor package ships against the GitHub advisory
// database. Dependabot only reads package-lock.json (dev tooling) and never sees
// Meteor's .npm/package/npm-shrinkwrap.json, so this is the only check on it.
import { readFileSync } from 'node:fs';
import { classifyAdvisories, collectVersions, validateAllowlist } from './runtime-audit.mjs';

const SHRINKWRAP_PATH = new URL('../.npm/package/npm-shrinkwrap.json', import.meta.url);
const ALLOWLIST_PATH = new URL('./runtime-audit-allowlist.json', import.meta.url);
// The endpoint `npm audit` itself queries.
const ADVISORY_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

function loadAllowlist() {
    return validateAllowlist(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')));
}

async function fetchAdvisories(versionsByPackage) {
    const response = await fetch(ADVISORY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(versionsByPackage),
    });
    if (!response.ok) {
        throw new Error(`Advisory lookup failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}

const versionsByPackage = collectVersions(JSON.parse(readFileSync(SHRINKWRAP_PATH, 'utf8')).dependencies);
const packageCount = Object.keys(versionsByPackage).length;
// An empty map would pass silently, e.g. if Meteor changes the shrinkwrap layout.
if (packageCount === 0) {
    throw new Error(`No packages found in ${SHRINKWRAP_PATH.pathname}`);
}

const allowlist = loadAllowlist();
const advisoriesByPackage = await fetchAdvisories(versionsByPackage);
const today = new Date().toISOString().slice(0, 10);
const { failures, ignored, unused } = classifyAdvisories({ advisoriesByPackage, versionsByPackage, allowlist, today });

for (const line of ignored) {
    console.log(line);
}
for (const entry of unused) {
    console.log(`warning: allowlist entry ${entry.id} (${entry.package}) no longer matches, remove it`);
}

console.log(`Checked ${packageCount} shipped packages.`);
if (failures.length > 0) {
    console.error(`\n${failures.length} unresolved advisories:\n${failures.join('\n')}`);
    process.exit(1);
}
