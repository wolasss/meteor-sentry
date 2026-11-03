// The decisions the runtime advisory audit makes, kept free of I/O so they can be
// tested offline. audit-runtime-deps.mjs owns the file reads, the lookup and the output.

export function collectVersions(dependencies, versionsByPackage = {}) {
    for (const [packageName, entry] of Object.entries(dependencies ?? {})) {
        const versions = (versionsByPackage[packageName] ??= []);
        if (!versions.includes(entry.version)) {
            versions.push(entry.version);
        }
        collectVersions(entry.dependencies, versionsByPackage);
    }
    return versionsByPackage;
}

export function validateAllowlist(allowlist) {
    for (const allowed of allowlist) {
        const missing = ['id', 'package', 'reason', 'expires'].filter((field) => !allowed[field]);
        if (missing.length > 0) {
            throw new Error(`Allowlist entry ${JSON.stringify(allowed)} is missing: ${missing.join(', ')}`);
        }
    }
    return allowlist;
}

export function classifyAdvisories({ advisoriesByPackage, versionsByPackage, allowlist, today }) {
    const failures = [];
    const ignored = [];
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
                ignored.push(`ignored until ${allowed.expires}: ${line}\n    ${allowed.reason}`);
            }
        }
    }

    const unused = allowlist.filter((entry) => !matchedAllowlist.has(entry));
    return { failures, ignored, unused };
}
