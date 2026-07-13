import path from 'node:path';
import { SyncDoctor } from './doctor.js';

const repair = process.argv.includes('--repair');
const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const vaultRoot = path.resolve(process.env.VAULT_PATH ?? './sample-vault');
const report = await new SyncDoctor(dataDir, vaultRoot).run({ repair });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.readOnlyRecommended) process.exitCode = 2;
else if (!report.healthy) process.exitCode = 1;
