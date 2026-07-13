import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PROTOCOL_VERSION, ProtocolSchemaRegistry } from '../src/schemas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../../../docs/sync');
await mkdir(outputDir, { recursive: true });

const definitions = Object.fromEntries(
  Object.entries(ProtocolSchemaRegistry).map(([name, schema]) => {
    const converted = zodToJsonSchema(schema, { name, target: 'jsonSchema7', $refStrategy: 'root' });
    return [name, converted.definitions?.[name] ?? converted];
  }),
);
const document = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `https://webobsidian.dev/schemas/sync-${PROTOCOL_VERSION}.json`,
  title: `WebObsidian Sync Protocol ${PROTOCOL_VERSION}`,
  protocolVersion: PROTOCOL_VERSION,
  definitions,
};
await writeFile(
  path.join(outputDir, 'protocol-v1.schema.json'),
  `${JSON.stringify(document, null, 2)}\n`,
  'utf8',
);
console.log(`generated ${Object.keys(definitions).length} schemas`);
