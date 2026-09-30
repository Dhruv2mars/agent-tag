import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";

import { loadConfig } from "../src/config.ts";
import { AgentTagStore, type AuditAction, type AuditCursor } from "../src/store/store.ts";

const configArgument = process.argv[2];
if (configArgument === undefined) throw new Error("usage: verify-audit CONFIG");

const config = await loadConfig(resolve(configArgument));
const databasePath = join(config.dataDir, "agent-tag.sqlite");
const store = await AgentTagStore.open(databasePath);
const records = [];
let after: AuditCursor | undefined;
try {
  while (true) {
    const page = store.listAuditRecords({ ...(after === undefined ? {} : { after }), limit: 1_000 });
    records.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < 1_000) break;
    after = { createdAt: last.createdAt, auditId: last.auditId };
  }
  if (records.length !== store.diagnostics().auditRecords) {
    throw new Error("paginated audit export count does not match the durable store");
  }
} finally {
  store.close();
}

const serializedAudit = JSON.stringify(records);
const database = new Database(databasePath, { readonly: true, strict: true });
const storedText = database
  .query<{ value: string }, []>(
    `SELECT text AS value FROM slack_events
     UNION ALL SELECT prompt AS value FROM schedules
     UNION ALL SELECT content AS value FROM memory_entries`,
  )
  .all();
database.close();

const leakedTextCount = storedText.filter(
  ({ value }) => value.length >= 8 && serializedAudit.includes(value),
).length;
if (leakedTextCount > 0) throw new Error("audit export contains stored private content");

const actionCounts = new Map<AuditAction, number>();
for (const record of records) {
  actionCounts.set(record.action, (actionCounts.get(record.action) ?? 0) + 1);
}

console.log(
  JSON.stringify(
    {
      records: records.length,
      actions: [...actionCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([action, count]) => ({ action, count })),
      privateContentMatches: leakedTextCount,
      result: "pass",
    },
    null,
    2,
  ),
);
