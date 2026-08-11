/**
 * Regression test for the outage this caused twice: store.js reads
 * localStorage at module top level, which the local Deno CLI happily
 * provides natively (masking the bug in every other test in this repo,
 * including handler.test.ts's own rate-team tests) but Supabase's actual
 * edge runtime does not - importing rating.ts there throws
 * "ReferenceError: localStorage is not defined" before any request can be
 * handled, which took the whole site down, twice.
 *
 * This has to be its own file, and rating.ts must never be statically
 * imported anywhere else in this file: ES modules only evaluate once per
 * process, so if anything had already loaded rating.ts's module graph
 * before the delete below runs, this would test nothing - the cached
 * module instance wouldn't re-execute its top-level code.
 */
import { MOCK } from "../../../test/mock-data.mjs";

Deno.test("rating.ts loads and scores a squad without a native localStorage global", async () => {
  // deno-lint-ignore no-explicit-any
  delete (globalThis as any).localStorage;

  const { buildPool, optimalSquad } = await import("./rating.ts");

  const m = MOCK as Record<string, unknown>;
  buildPool(m["/api/bootstrap"], m["/api/fixtures"], m["/api/form?last=6"]);
  const squad = optimalSquad(5);

  if (squad.picks.length !== 15) {
    throw new Error(`expected optimalSquad to return 15 picks, got ${squad.picks.length}`);
  }
});
