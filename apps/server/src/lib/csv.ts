/**
 * RFC 4180 CSV rows, one at a time: quoted fields with commas, quotes ("") and line breaks inside, CRLF or LF,
 * an optional UTF-8 byte order mark. Fast enough for archive files of tens of MB.
 */
export function* csvRows(text: string): Generator<string[]> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let row: string[] = [];
  let field = '';
  while (i < n) {
    const c = text[i];
    if (c === '"' && field === '') {
      // Quoted field: until the closing quote ("" is a literal quote).
      i++;
      let start = i;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          field += text.slice(start);
          i = n;
          break;
        }
        if (text[q + 1] === '"') {
          field += `${text.slice(start, q)}"`;
          i = q + 2;
          start = i;
          continue;
        }
        field += text.slice(start, q);
        i = q + 1;
        break;
      }
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      yield row;
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    yield row;
  }
}

/**
 * Rows as objects keyed by the header row, found by its column names (files may start with notes).
 * Returns null when no row has all `required` columns (compared case-insensitively).
 */
export function csvRecords(text: string, required: string[]): { header: string[]; records: Generator<Record<string, string>> } | null {
  const rows = csvRows(text);
  const want = required.map((r) => r.toLowerCase());
  // Stepped by hand: leaving a for…of with return would close the generator and lose the records.
  for (let lookahead = 0; lookahead <= 20; lookahead++) {
    const next = rows.next();
    if (next.done) break;
    const row = next.value;
    const header = row.map((h) => h.trim());
    const lower = header.map((h) => h.toLowerCase());
    if (want.every((w) => lower.includes(w))) {
      const records = (function* () {
        for (const r of rows) {
          if (r.length === 1 && r[0] === '') continue; // blank line
          const rec: Record<string, string> = {};
          lower.forEach((key, idx) => {
            rec[key] = (r[idx] ?? '').trim();
          });
          yield rec;
        }
      })();
      return { header, records };
    }
  }
  return null; // the header is near the top, or the file isn't this kind
}

/** Cells starting with these are formulas in Excel/Sheets: prefix them so they stay text. */
const FORMULA = /^[=+\-@\t\r]/;
export function csvCell(v: unknown) {
  let s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
