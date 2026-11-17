#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { createApp } from '../src/server.js';
import { listSpecs } from '../src/db/specs.js';
import { createRecord, listRecords } from '../src/db/records.js';
import { createSpec } from '../src/db/specs.js';
import { SEED_SPECS, buildSeedRecords } from '../src/seed.js';

const dataDir = process.argv[2] ?? path.join(process.cwd(), 'data');

const app = createApp({ dataDir, startTimers: false });
try {
  const existing = listRecords(app.db);
  if (existing.length > 0) {
    console.log(`data dir already seeded: ${existing.length} records, ${listSpecs(app.db).length} specs`);
  } else {
    const records = buildSeedRecords({ count: 24 });
    for (const record of records) {
      createRecord(app.db, record, { source: 'seed' });
    }
    for (const spec of SEED_SPECS) {
      createSpec(app.db, spec, { source: 'seed' });
    }
    app.invalidator.tick();
    await app.builder.idle();
    const specs = listSpecs(app.db);
    console.log(`seeded ${records.length} records and ${specs.length} specs into ${dataDir}`);
    for (const spec of specs) {
      const state = app.resultService.verify(spec);
      console.log(
        `  ${spec.id}  ${spec.name}  verified=${state.ok}  digest=${state.live.outputDigest.slice(0, 12)}`,
      );
    }
  }
  app.close();
} catch (err) {
  console.error(err);
  app.close();
  process.exitCode = 1;
}
