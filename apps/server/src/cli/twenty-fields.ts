// Lists the LinkedIn Console fields on Twenty's Person: which exist, which are missing. With APPLY=1 it adds the
// missing ones (custom, nullable; existing fields are never changed). Run through scripts/twenty-fields.sh.
import { createPersonField, PERSON_FIELDS, personFields } from '../lib/twenty-fields.ts';

const apply = process.env.APPLY === '1';
try {
  const { objectId, fields } = await personFields();
  let missing = 0;
  for (const f of PERSON_FIELDS) {
    const has = fields.get(f.name);
    if (has) {
      console.log(`  ✅ ${f.label} (${f.name}) exists${has !== f.type ? `, as ${has} (expected ${f.type}: check it)` : ''}`);
      continue;
    }
    missing++;
    if (!apply) {
      const values = f.options ? `: ${f.options.map((o) => o.label).join(' · ')}` : '';
      console.log(`  ➕ ${f.label} (${f.name}, ${f.type}${values}) would be added`);
      continue;
    }
    await createPersonField(objectId, f);
    console.log(`  ✅ ${f.label} (${f.name}) added`);
  }
  if (!missing) console.log('All LinkedIn Console fields are there.');
  else if (!apply) console.log(`\n${missing} field(s) missing. Nothing was changed. Add them with: ./scripts/twenty-fields.sh --apply`);
  process.exit(0);
} catch (err) {
  console.error(`Twenty: ${(err as Error).message}`);
  process.exit(1);
}
