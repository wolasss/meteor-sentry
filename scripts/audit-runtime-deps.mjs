// Checks the npm packages this Meteor package ships against the GitHub advisory
// database. Dependabot only reads package-lock.json (dev tooling) and never sees
// Meteor's .npm/package/npm-shrinkwrap.json, so this is the only check on it.
import { readFileSync } from 'node:fs';

const SHRINKWRAP_PATH = new URL('../.npm/package/npm-shrinkwrap.json', import.meta.url);
const ALLOWLIST_PATH = new URL('./runtime-audit-allowlist.json', import.meta.url);
// The endpoint `npm audit` itself queries.
const ADVISORY_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

function collectVersions(dependencies, versionsByPackage = {}) {
    for (const [packageName, entry] of Object.entries(dependencies ?? {})) {
        const versions = (versionsByPackage[packageName] ??= []);
        if (!versions.includes(entry.version)) {
            versions.push(entry.version);
        }
        collectVersions(entry.dependencies, versionsByPackage);
    }
    return versionsByPackage;
}

function loadAllowlist() {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    for (const allowed of allowlist) {
        const missing = ['id', 'package', 'reason', 'expires'].filter((field) => !allowed[field]);
        if (missing.length > 0) {
            throw new Error(`Allowlist entry ${JSON.stringify(allowed)} is missing: ${missing.join(', ')}`);
        }
    }
    return allowlist;
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
const failures = [];
const matchedAllowlist = new Set();

for (const [packageName, advisories] of Object.entries(advisoriesByPackage)) {
    for (const advisory of advisories) {
        const advisoryId = advisory.url.split('/').pop();
        const line = `${packageName}@${versionsByPackage[packageName].join(',')} ${advisoryId} (${advisory.severity}, vulnerable ${advisory.vulnerable_versions}): ${advisory.title}`;
        const allowed = allowlist.find((entry) => entry.id === advisoryId && entry.package === packageName);
        if (!allowed) {
            failures.push(line);
        } else if (allowed.expires < today) {
            matchedAllowlist.add(allowed);
            failures.push(`${line}\n    allowlist entry expired ${allowed.expires}, re-check: ${allowed.reason}`);
        } else {
            matchedAllowlist.add(allowed);
            console.log(`ignored until ${allowed.expires}: ${line}\n    ${allowed.reason}`);
        }
    }
}

for (const unused of allowlist.filter((entry) => !matchedAllowlist.has(entry))) {
    console.log(`warning: allowlist entry ${unused.id} (${unused.package}) no longer matches, remove it`);
}

console.log(`Checked ${packageCount} shipped packages.`);
if (failures.length > 0) {
    console.error(`\n${failures.length} unresolved advisories:\n${failures.join('\n')}`);
    process.exit(1);
}
