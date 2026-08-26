/*
 * Globals provided by the Django page templates and the .mjs entry points.
 *
 * The Django templates inject a settings object (rendered into
 * base/templates) and, on pages that load JS translations, the gettext,
 * interpolate and staticUrl helpers. The .mjs entry points copy the
 * translation helpers into settings (for fwtoolkit) and expose their page
 * objects on window for use by Selenium tests.
 *
 * This file must stay a script (no top-level imports, no "declare global"):
 * wildcard ambient module declarations only match relative import
 * specifiers when they are declared from a script file, and script files
 * declare globals directly. Use import("...") type expressions to refer to
 * package types.
 */

// window.settings itself is declared by @fiduswriter/frontend (error_hook)
// as CsrfSettings & Record<string, unknown>. Where full settings typing is
// needed, cast via the Settings type from "@fiduswriter/frontend".
interface Window {
    /** The SPA instance created by app.mjs. */
    theApp?: import("@fiduswriter/frontend/app").App
    /** Created by admin_console.mjs. */
    theAdminConsole?: import("@fiduswriter/frontend/admin_console").AdminConsole
    /** Created by error_hook.mjs. */
    theErrorHook?: import("@fiduswriter/frontend/error_hook").ErrorHook
    /** Created by maintenance.mjs. */
    theMaintainer?: import("@fiduswriter/frontend/maintenance").DocMaintenance
    /** Created by document_admin.mjs. */
    theDocumentAdmin?: unknown
    /** Set by the document admin template for E2EE documents. */
    documentAdminE2EE?: boolean
    /** Test helper exposed by test_caret.mjs for Selenium tests. */
    testCaret?: {
        setSelection(selectFrom: number, selectTo: number): unknown
    }
}

// Translation helpers from /api/jsi18n/, available as globals on pages that
// load the JavaScript catalog.
function gettext(msgid: string): string

function interpolate(fmt: string, args: unknown[], named?: boolean): string

function staticUrl(path: string): string

/*
 * Type declarations for the plugin aggregators that django-npm-mjs generates
 * into the transpile cache as plugins/<type>/index.js. The generated modules
 * aggregate every installed Django app's plugins/<type>/ directory at build
 * time and therefore do not exist in this source tree, so their shape is
 * declared here: one [appName, module] tuple per discovered plugin module.
 * The App class filters the tuples by settings.APPS at runtime.
 *
 * (Wildcard ambient modules cannot contain "../", so the pattern matches on
 * the trailing "/index.js"; it only ever applies to module specifiers that
 * do not resolve to a real file.)
 */
declare module "*/index.js" {
    export const plugins: import("@fiduswriter/frontend/app").PluginList
}
