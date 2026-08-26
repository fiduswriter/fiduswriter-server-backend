import type {App} from "@fiduswriter/frontend/app"
// Adds the templates overview page to the app routing table
import {
    DocTemplatesEditor,
    DocTemplatesOverview
} from "@fiduswriter/frontend/document_templates"

/**
 * Constructor options of the two template pages. Their published types
 * require `csl`, `indexedDB` and `page` to be initialized on the app object.
 * That is guaranteed at runtime because route handlers only run after
 * App.init(), but it is not part of the exported FrontendApp type, hence the
 * assertion where the options are built.
 */
type DocTemplatesPageOptions = ConstructorParameters<
    typeof DocTemplatesOverview
>[0] &
    ConstructorParameters<typeof DocTemplatesEditor>[0]

export class DocTemplatesAppItem {
    app: App

    constructor(app: App) {
        this.app = app
    }

    init(): void {
        this.app.routes["templates"] = {
            app: "user_template_manager",
            requireLogin: true,
            open: pathnameParts => {
                const pageOptions = {
                    app: this.app.config,
                    user: this.app.config.user
                } as DocTemplatesPageOptions
                if (pathnameParts.length < 4) {
                    return Promise.resolve(
                        new DocTemplatesOverview(pageOptions)
                    )
                } else {
                    const id = pathnameParts[2]
                    return Promise.resolve(
                        new DocTemplatesEditor(pageOptions, id)
                    )
                }
            },
            dbTables: {
                list: {
                    keyPath: "id"
                }
            }
        }
    }
}
