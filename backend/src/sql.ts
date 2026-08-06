/**
 * "Only touch the columns the caller actually sent."
 *
 *   undefined -> leave the column alone
 *   null      -> explicitly clear it
 *
 * Column and table names always come from this codebase, never from request
 * data, so interpolating them is safe; every value is a bound parameter.
 */
export interface SqlStatement {
  text: string;
  values: unknown[];
}

type Columns = Record<string, unknown>;

const provided = (columns: Columns) =>
  Object.entries(columns).filter(([, v]) => v !== undefined);

export function insertSql(table: string, columns: Columns, returning = '*'): SqlStatement {
  const entries = provided(columns);
  if (!entries.length) {
    return { text: `INSERT INTO ${table} DEFAULT VALUES RETURNING ${returning}`, values: [] };
  }
  const names = entries.map(([c]) => c).join(', ');
  const holders = entries.map((_, i) => `$${i + 1}`).join(', ');
  return {
    text: `INSERT INTO ${table} (${names}) VALUES (${holders}) RETURNING ${returning}`,
    values: entries.map(([, v]) => v)
  };
}

/**
 * Multi-row INSERT for bulk loads (import). Postgres caps bind parameters at
 * 65,535 per statement, so rows are chunked to stay well under that.
 */
export async function insertRows(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  table: string,
  columns: string[],
  rows: unknown[][],
  suffix = ''
): Promise<void> {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(60_000 / columns.length));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map(
      (row) =>
        `(${row
          .map((v) => {
            values.push(v);
            return `$${values.length}`;
          })
          .join(',')})`
    );
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${suffix}`,
      values
    );
  }
}

/** `null` when there is nothing to update. */
export function updateSql(
  table: string,
  id: string,
  columns: Columns,
  returning?: string
): SqlStatement | null {
  const entries = provided(columns);
  if (!entries.length) return null;
  const sets = entries.map(([c], i) => `${c} = $${i + 2}`).join(', ');
  return {
    text: `UPDATE ${table} SET ${sets} WHERE id = $1${returning ? ` RETURNING ${returning}` : ''}`,
    values: [id, ...entries.map(([, v]) => v)]
  };
}
