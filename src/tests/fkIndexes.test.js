import prisma from '../db/prisma.js';

// FX-092: every foreign key needs an index whose leading columns are the FK's
// columns. Without one, deleting or re-keying the parent (a Role, a User)
// scans the whole child table under lock, and joins from the parent side
// can't use an index. Asked of the live (migrated) test database, so a new
// relation without an index fails here rather than in production.

const UNINDEXED_FKS = `
  SELECT c.conrelid::regclass::text AS "table",
         array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS "columns"
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.contype = 'f'
    AND c.connamespace = 'public'::regnamespace
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
    )
  GROUP BY c.conrelid, c.conname
  ORDER BY 1, 2`;

test('every foreign key is covered by an index', async () => {
  const rows = await prisma.$queryRawUnsafe(UNINDEXED_FKS);
  expect(rows.map((r) => `${r.table}(${r.columns})`)).toEqual([]);
});
