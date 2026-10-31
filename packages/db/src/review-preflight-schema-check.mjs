// CI-only: compare the declared Drizzle schema with the checked-in migration snapshot.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateDrizzleJson } from "drizzle-kit/api";
import { reviewPreflightCompanyLocks, reviewPreflightReservations } from "./schema/review_preflight.ts";

const snapshot = JSON.parse(await readFile(new URL("./migrations/meta/0306_snapshot.json", import.meta.url), "utf8"));
const actual = generateDrizzleJson({ reviewPreflightCompanyLocks, reviewPreflightReservations });
for (const name of ["public.review_preflight_company_locks", "public.review_preflight_reservations"]) {
  assert.deepEqual(actual.tables[name], snapshot.tables[name], `Drizzle snapshot drift: ${name}`);
}
console.log("review preflight Drizzle snapshot matches the declared schema");
