// Writes schemas/spec.schema.json from the zod schema. Run: npm run schema
import { writeFile } from 'node:fs/promises';
import { specJsonSchema } from '../src/spec/index.js';

const target = new URL('../schemas/spec.schema.json', import.meta.url);
await writeFile(target, `${JSON.stringify(specJsonSchema(), null, 2)}\n`, 'utf8');
