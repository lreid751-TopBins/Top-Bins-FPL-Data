/**
 * store.js reads localStorage at module top level (S.ui's default
 * managerId/watchlist/theme), which is fine in a browser and even in the
 * local Deno CLI (it has its own built-in localStorage), but Supabase's
 * actual edge runtime has no such global - importing store.js there throws
 * "ReferenceError: localStorage is not defined" before any of our own code
 * runs, which is exactly what took prod down twice.
 *
 * This has to be its own module with zero imports of its own, and it has to
 * be the FIRST import in any file that (transitively) imports store.js.
 * ES modules evaluate a module's dependencies before that module's own
 * top-level code runs, in the order the imports are first encountered - so
 * setting globalThis.localStorage as a plain statement above the store.js
 * import in the same file does NOT work; that statement only runs once
 * store.js (and everything it needs) has already finished evaluating.
 * Importing this file first, with no dependencies of its own, is what
 * actually guarantees the polyfill lands before store.js's first line runs.
 */
// deno-lint-ignore no-explicit-any
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
