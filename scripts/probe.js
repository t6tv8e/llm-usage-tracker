'use strict';

// This file intentionally uses the JavaScript subset of TypeScript so the
// supported Node runtime can run it without adding a runtime transpiler.
const { QuotaAxiClient } = require('../dist/main/providers/quota-axi');

async function main() {
  const client = new QuotaAxiClient();
  try {
    const snapshots = await client.fetch(['codex', 'claude'], true);
    console.log('Codex:', JSON.stringify(snapshots.codex, null, 2));
    console.log('Claude:', JSON.stringify(snapshots.claude, null, 2));
    if (!snapshots.claude.ok || !snapshots.codex.ok) process.exitCode = 1;
  } finally {
    client.stop();
  }
}

main().catch(() => {
  console.error('Provider probe failed without exposing credential details.');
  process.exitCode = 1;
});
