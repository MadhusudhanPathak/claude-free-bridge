#!/usr/bin/env node
// Integration runner - requires project to be built (dist folder present)
const path = require('path');
const fs = require('fs');
const child = require('child_process');
const http = require('http');

const distRoot = path.join(__dirname, 'dist');
const distAuth = path.join(distRoot, 'session', 'auth.js');
const distOrg = path.join(distRoot, 'session', 'org_store.js');
const distIndex = path.join(distRoot, 'index.js');

if (!fs.existsSync(distAuth) || !fs.existsSync(distOrg) || !fs.existsSync(distIndex)) {
  console.error('Dist files not found. Build project first (npm run build or npx tsc -p tsconfig.json)');
  process.exit(2);
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.abort(); reject(new Error('timeout')); });
      });
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

(async () => {
  const auth = require(distAuth);
  const store = require(distOrg);
  console.log('Running integration checks...');

  // Start server
  console.log('Starting API server from dist/index.js');
  const serverProc = child.spawn(process.execPath, [distIndex, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', (b) => { process.stdout.write('[server] ' + b.toString()); });
  serverProc.stderr.on('data', (b) => { process.stderr.write('[server.err] ' + b.toString()); });

  const healthy = await waitForServer('http://127.0.0.1:8080/health', 30000);
  if (!healthy) {
    console.error('Server did not become healthy within timeout. Exiting.');
    serverProc.kill();
    process.exit(3);
  }
  console.log('Server healthy');

  try {
    const orgs = await store.getKnownOrgs();
    console.log('Known orgs:', orgs);

    // Basic auth presence check
    const hasAuth = typeof auth.hasStoredAuth === 'function' ? await auth.hasStoredAuth() : false;
    if (!hasAuth) {
      console.warn('No stored auth detected. To run full API tests, run auth-info --login to create a profile. Skipping API probes.');
      serverProc.kill();
      process.exit(0);
    }

    // Non-streaming probe
    console.log('Running non-streaming chat probe');
    const body = JSON.stringify({ model: 'claude-3.5-web', messages: [{ role: 'user', content: 'Say hello' }], stream: false });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ method: 'POST', host: '127.0.0.1', port: 8080, path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
        let bufs = [];
        r.on('data', (c) => bufs.push(c));
        r.on('end', () => {
          const txt = Buffer.concat(bufs).toString('utf8');
          try { resolve({ statusCode: r.statusCode, body: JSON.parse(txt) }); } catch (e) { resolve({ statusCode: r.statusCode, body: txt }); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    console.log('Non-stream response status:', res.statusCode);
    if (res.statusCode !== 200) throw new Error('Non-streaming probe failed with status ' + res.statusCode);
    if (!res.body || !res.body.choices || !res.body.choices[0] || !res.body.choices[0].message) throw new Error('Invalid response shape for non-stream probe');
    console.log('Non-streaming probe OK');

    // Streaming probe
    console.log('Running streaming chat probe');
    const sBody = JSON.stringify({ model: 'claude-3.5-web', messages: [{ role: 'user', content: 'Stream test' }], stream: true });
    const streamResult = await new Promise((resolve, reject) => {
      const req = http.request({ method: 'POST', host: '127.0.0.1', port: 8080, path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sBody) } }, (r) => {
        let acc = '';
        let chunks = 0;
        r.on('data', (c) => {
          const str = c.toString('utf8');
          acc += str;
          // crude parse: count occurrences of data: {...}
          const matches = acc.match(/data: (\{[\s\S]*?\})/g);
          if (matches) {
            for (const m of matches) {
              try {
                const jsonPart = m.replace(/^data: /, '');
                const obj = JSON.parse(jsonPart);
                if (obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content) {
                  chunks += 1;
                }
                if (obj && obj.choices && obj.choices[0] && obj.choices[0].finish_reason === 'stop') {
                  resolve({ chunks });
                  return;
                }
              } catch (e) {
                // ignore parse errors for partial frames
              }
            }
          }
        });
        r.on('end', () => resolve({ chunks }));
      });
      req.on('error', reject);
      req.write(sBody);
      req.end();
      // timeout guard
      setTimeout(() => reject(new Error('Streaming probe timed out')), 60000);
    });

    console.log('Streaming probe chunks received:', streamResult.chunks);
    if (!streamResult.chunks || streamResult.chunks < 1) throw new Error('Streaming probe did not receive any content chunks');
    console.log('Streaming probe OK');

    console.log('Integration tests completed successfully');
    serverProc.kill();
    process.exit(0);
  } catch (e) {
    console.error('Integration failed', e);
    serverProc.kill();
    process.exit(1);
  }
})();
