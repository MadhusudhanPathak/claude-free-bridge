#!/usr/bin/env node
// Integration runner - requires project to be built (dist folder present)
const path = require('path');
const fs = require('fs');

const distAuth = path.join(__dirname, 'dist', 'session', 'auth.js');
const distOrg = path.join(__dirname, 'dist', 'session', 'org_store.js');

if (!fs.existsSync(distAuth) || !fs.existsSync(distOrg)) {
  console.error('Dist files not found. Build project first (npm run build or npx tsc -p tsconfig.json)');
  process.exit(2);
}

(async () => {
  const auth = require(distAuth);
  const store = require(distOrg);
  console.log('Running integration checks...');

  try {
    const orgs = await store.getKnownOrgs();
    console.log('Known orgs:', orgs);

    if (orgs && orgs.length > 0) {
      const org = orgs[0];
      console.log('Using org:', org);
      try {
        if (!auth.hasStoredAuthForOrg(org)) {
          console.warn('No stored auth for org', org, '- skipping probe');
        } else {
          const res = await auth.fetchWithAuth('https://claude.ai/api/account_profile');
          console.log('account_profile probe status:', res && res.status);
        }
      } catch (e) {
        console.error('Probe failed:', e);
      }
    } else {
      console.log('No known orgs found. To run a full integration test, run auth-info --login to create a profile first.');
    }
  } catch (e) {
    console.error('Integration failed', e);
    process.exit(1);
  }
})();
