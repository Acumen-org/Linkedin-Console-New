// Lists what LinkedIn Console adds to Twenty: the fields on Person, and the LinkedIn conversation object with its
// fields and its link to Person; which exist, which are missing. With APPLY=1 it adds the missing ones (custom,
// nullable; nothing existing is ever changed). Run through scripts/twenty-fields.sh.
import {
  CONVERSATION_OBJECT,
  createConversationObject,
  createConversationRelation,
  createField,
  type FieldSpec,
  objectsSchema,
  PERSON_FIELDS,
} from '../lib/twenty-fields.ts';

const apply = process.env.APPLY === '1';
let missing = 0;

async function ensureFields(objectId: string | null, have: Map<string, string>, fields: FieldSpec[], indent: string) {
  for (const f of fields) {
    const has = have.get(f.name);
    if (has) {
      console.log(`${indent}✅ ${f.label} (${f.name}) exists${has !== f.type ? `, as ${has} (expected ${f.type}: check it)` : ''}`);
      continue;
    }
    missing++;
    if (!apply || !objectId) {
      const values = f.options ? `: ${f.options.map((o) => o.label).join(' · ')}` : '';
      console.log(`${indent}➕ ${f.label} (${f.name}, ${f.type}${values}) would be added`);
      continue;
    }
    await createField(objectId, f);
    console.log(`${indent}✅ ${f.label} (${f.name}) added`);
  }
}

try {
  const objects = await objectsSchema();
  const person = objects.get('person');
  if (!person) throw new Error('Twenty has no "person" object');

  console.log('Person: LinkedIn summary of the prospect');
  await ensureFields(person.id, person.fields, PERSON_FIELDS, '  ');

  const o = CONVERSATION_OBJECT;
  console.log(`\n${o.labelSingular} (one per conversation, listed on the Person)`);
  let conv = objects.get(o.nameSingular);
  if (!conv) {
    missing++;
    if (apply) {
      const id = await createConversationObject();
      conv = (await objectsSchema()).get(o.nameSingular) ?? { id, fields: new Map() };
      console.log(`  ✅ object ${o.labelPlural} (${o.nameSingular}) added`);
    } else {
      console.log(`  ➕ object ${o.labelPlural} (${o.nameSingular}) would be added`);
    }
  } else {
    console.log(`  ✅ object ${o.labelPlural} (${o.nameSingular}) exists`);
  }
  await ensureFields(conv?.id ?? null, conv?.fields ?? new Map(), o.fields, '    ');
  if (conv?.fields.has(o.relation.name)) {
    console.log(`    ✅ link to Person (${o.relation.name}) exists`);
  } else {
    missing++;
    if (apply && conv) {
      await createConversationRelation(conv.id, person.id);
      console.log(`    ✅ link to Person (${o.relation.name}; the Person page lists its ${o.labelPlural}) added`);
    } else {
      console.log(`    ➕ link to Person (${o.relation.name}; the Person page lists its ${o.labelPlural}) would be added`);
    }
  }

  if (!missing) console.log('\nEverything LinkedIn Console needs is there.');
  else if (!apply) console.log(`\n${missing} missing. Nothing was changed. Add them with: ./scripts/twenty-fields.sh --apply`);
  process.exit(0);
} catch (err) {
  console.error(`Twenty: ${(err as Error).message}`);
  process.exit(1);
}
