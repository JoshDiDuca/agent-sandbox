// Generates the JSON Schema files (schemas/*.json) and config.example.json from the zod definitions, so editors get
// autocomplete and docs and the example always matches the real defaults. Run after tsc (npm run build does both).
import fs from 'node:fs';
import { jsonSchemas } from '../dist/core/schema.js';
import { DEFAULTS } from '../dist/core/config.js';

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');

fs.mkdirSync('schemas', { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) write('schemas/' + name, schema);
write('config.example.json', { $schema: './schemas/config.schema.json', ...DEFAULTS });
