/*
 * Ambient declarations for untyped runtime dependencies of the book app.
 *
 * This file must stay a script (no top-level imports): wildcard ambient
 * module declarations only match non-relative import specifiers when they are
 * declared from a script file.
 */

/*
 * fast-deep-equal is a tiny CommonJS package that ships no type declarations.
 * It is used by the book overview to compare the cached /api/book/list/ payload
 * with a freshly fetched one.
 */
declare module "fast-deep-equal" {
    function deepEqual(a: unknown, b: unknown): boolean
    export = deepEqual
}
