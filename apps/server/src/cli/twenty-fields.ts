// Lists what LinkedIn Console adds to Twenty (Person fields + the LinkedIn conversation object), which exist and
// which are missing. With APPLY=1 it adds the missing ones (custom, nullable; nothing existing is ever changed).
// Run through scripts/twenty-fields.sh. The actual work lives in lib/twenty-fields.ts (shared with the admin UI).
import { syncTwentyFields } from '../lib/twenty-fields.ts';

const apply = process.env.APPLY === '1';
const mark = (s: 'exists' | 'added' | 'missing') => (s === 'exists' ? '✅' : s === 'added' ? '✅' : '➕');
const verb = (s: 'exists' | 'added' | 'missing') => (s === 'exists' ? 'exists' : s === 'added' ? 'added' : 'would be added');

try {
  const { items, missing } = await syncTwentyFields(apply);
  for (const it of items) {
    const indent = it.scope === 'person' ? '  ' : '    ';
    console.log(`${indent}${mark(it.status)} ${it.label} (${it.name}) ${verb(it.status)}`);
  }
  if (!missing) console.log('\nEverything LinkedIn Console needs is there.');
  else if (!apply) console.log(`\n${missing} missing. Nothing was changed. Add them with: ./scripts/twenty-fields.sh --apply`);
  process.exit(0);
} catch (err) {
  console.error(`Twenty: ${(err as Error).message}`);
  process.exit(1);
}
