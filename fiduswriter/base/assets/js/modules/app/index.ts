import type {Settings} from "@fiduswriter/frontend"
import {App} from "@fiduswriter/frontend/app"
import {addAlert} from "fwtoolkit"

// Django API adapters
import {djangoApiConnectors} from "../api_adapters/index.ts"

/*
 * Plugins are discovered dynamically by django-npm-mjs. For each plugin type,
 * it scans all installed Django apps for files under
 * <app>/static/js/plugins/<type>/ and writes an aggregated index.js into the
 * transpile cache under plugins/<type>/index.js. That generated module exports
 * a `plugins` array of [appName, pluginModule] tuples; its type is declared
 * as a wildcard ambient module in ../globals.d.ts.
 *
 * The App class filters the discovered plugins by settings.APPS at runtime, so
 * optional apps that are not installed never end up in the bundle.
 */

import {plugins as appPlugins} from "../../plugins/app/index.js"
import {plugins as bibliographyOverviewPlugins} from "../../plugins/bibliography_overview/index.js"
import {plugins as citationDialogPlugins} from "../../plugins/citation_dialog/index.js"
import {plugins as confirmAccountPlugins} from "../../plugins/confirm_account/index.js"
import {plugins as documentsOverviewPlugins} from "../../plugins/documents_overview/index.js"
import {plugins as editorPlugins} from "../../plugins/editor/index.js"
import {plugins as menuPlugins} from "../../plugins/menu/index.js"
import {plugins as profilePlugins} from "../../plugins/profile/index.js"

/** Maps logical API endpoint names to the Django backend URLs. */
const djangoApiUrlMap: Record<string, string> = {
    "i18n.setLang": "/api/i18n/setlang/",
    "e2ee.user_encryption_key": "/api/user/encryption_key/",
    "e2ee.user_encryption_key_save": "/api/user/encryption_key/save/",
    "e2ee.user_public_key": "/api/user/encryption_public_key/{userId}/",
    "user.preferences": "/api/user/preferences/get/",
    "user.preferences_update": "/api/user/preferences/update/",
    "e2ee.document_encryption_key_get": "/api/document/encryption_key/get/",
    "e2ee.document_encryption_key_update":
        "/api/document/encryption_key/update/",
    "e2ee.document_encryption_key_save": "/api/document/encryption_key/save/"
}

window.settings.apiUrlMap = djangoApiUrlMap

// The settings object is injected by the Django template; error_hook's
// global declaration types it narrowly, so widen it for the App
// constructor here.
const settings = window.settings as Settings

const theApp = new App(djangoApiConnectors, settings, {
    appPlugins,
    menuPlugins,
    editorPlugins,
    citationDialogPlugins,
    bibliographyOverviewPlugins,
    documentsOverviewPlugins,
    profilePlugins,
    confirmAccountPlugins
})

/*
 * PWA file handling (Chromium/Edge desktop).
 *
 * The web app manifest declares the Fidus Writer formats via `file_handlers`,
 * so an installed PWA is registered with the operating system as a handler for
 * `.fidus`, `.fidusbook` and `.fidustemplate`. When the OS opens a file with
 * the app, the browser exposes it through `window.launchQueue`. We route the
 * launched file to the matching import dialog of the page that handles that
 * format and preload it, so the user only has to confirm the import.
 *
 * Files can arrive before login and before the target page is mounted, so
 * launches are queued and re-dispatched after every page selection.
 */

interface LaunchedFileSpec {
    route: string
    routeName: string
    method: string
    inputId: string
    label: string
}

const LAUNCH_SPECS: Record<string, LaunchedFileSpec> = {
    fidus: {
        route: "/",
        routeName: "",
        method: "importDocument",
        inputId: "doc-uploader",
        label: "Fidus Writer document"
    },
    fidusbook: {
        route: "/books/",
        routeName: "books",
        method: "importBook",
        inputId: "fidusbook-uploader",
        label: "Fidus Writer book"
    },
    fidustemplate: {
        route: "/templates/",
        routeName: "templates",
        method: "uploadDocTemplate",
        inputId: "fidus-template-uploader",
        label: "Fidus Writer document template"
    }
}

interface PendingLaunch {
    file: File
    navigated: boolean
}

function launchedFileExtension(file: File): string {
    const parts = file.name.toLowerCase().split(".")
    return parts.length > 1 ? parts.pop()! : ""
}

function waitForElement(id: string, timeout = 3000): Promise<HTMLElement | null> {
    return new Promise(resolve => {
        const existing = document.getElementById(id)
        if (existing) {
            resolve(existing)
            return
        }
        const start = Date.now()
        const timer = window.setInterval(() => {
            const element = document.getElementById(id)
            if (element) {
                window.clearInterval(timer)
                resolve(element)
            } else if (Date.now() - start > timeout) {
                window.clearInterval(timer)
                resolve(null)
            }
        }, 50)
    })
}

function preloadFile(input: HTMLInputElement, file: File): boolean {
    try {
        const transfer = new DataTransfer()
        transfer.items.add(file)
        input.files = transfer.files
        input.dispatchEvent(new Event("change", {bubbles: true}))
        return true
    } catch (error) {
        console.error("Could not preload the launched file:", error)
        return false
    }
}

function setupFileHandling(app: App): void {
    const launchQueue = (window as any).launchQueue
    if (!launchQueue || typeof launchQueue.setConsumer !== "function") {
        return
    }

    const pending: PendingLaunch[] = []
    let dispatching = false

    const dispatch = async (): Promise<void> => {
        if (dispatching) {
            return
        }
        dispatching = true
        try {
            while (pending.length) {
                const entry = pending[0]
                const spec = LAUNCH_SPECS[launchedFileExtension(entry.file)]
                if (!spec) {
                    pending.shift()
                    addAlert(
                        "info",
                        interpolate(
                            gettext(
                                'The file "%s" is not a supported Fidus Writer file type.'
                            ),
                            [entry.file.name]
                        )
                    )
                    continue
                }
                if (!(app.routes as Record<string, unknown>)[spec.routeName]) {
                    pending.shift()
                    addAlert(
                        "info",
                        interpolate(
                            gettext(
                                'The Fidus Writer app that opens "%s" is not enabled on this server.'
                            ),
                            [entry.file.name]
                        )
                    )
                    continue
                }
                if (window.location.pathname !== spec.route && !entry.navigated) {
                    entry.navigated = true
                    void app.goTo(spec.route)
                    return
                }
                const actions = (app.page as any)?.mod?.actions
                if (!actions || typeof actions[spec.method] !== "function") {
                    // The page is not ready yet. The wrapped selectPage() will
                    // dispatch again once it is.
                    return
                }
                pending.shift()
                try {
                    await actions[spec.method]()
                } catch (error) {
                    console.error("Could not open the import dialog:", error)
                }
                const input = (await waitForElement(
                    spec.inputId
                )) as HTMLInputElement | null
                if (input && preloadFile(input, entry.file)) {
                    addAlert(
                        "info",
                        interpolate(
                            gettext('Selected "%s". Confirm to finish the import.'),
                            [entry.file.name]
                        )
                    )
                } else {
                    addAlert(
                        "info",
                        interpolate(
                            gettext('Open %s and import "%s" manually.'),
                            [spec.label, entry.file.name]
                        )
                    )
                }
            }
        } finally {
            dispatching = false
        }
    }

    launchQueue.setConsumer(async (launchParams: any) => {
        const handles = launchParams?.files ?? []
        for (const handle of handles) {
            try {
                pending.push({file: await handle.getFile(), navigated: false})
            } catch (error) {
                console.error("Could not read the launched file:", error)
            }
        }
        if (pending.length) {
            await dispatch()
        }
    })

    // Re-attempt the dispatch after every page switch, so launches that
    // arrived before login or before the target page was mounted are handled.
    const originalSelectPage = app.selectPage.bind(app)
    ;(app as any).selectPage = async () => {
        const result = await originalSelectPage()
        await dispatch()
        return result
    }

    void dispatch()
}

setupFileHandling(theApp)
theApp.init()
window.theApp = theApp
