import type {App} from "@fiduswriter/frontend/app"

// Adds the books overview page to the app routing table
export class BookAppItem {
    app: App

    constructor(app: App) {
        this.app = app
    }

    init(): void {
        this.app.routes["books"] = {
            app: "book",
            requireLogin: true,
            open: (pathnameParts: string[]) => {
                const path = ("/" + pathnameParts.slice(2).join("/")).replace(
                    /\/?$/,
                    "/"
                )
                return import("../../modules/books/index.js").then(
                    ({BookOverview}) => new BookOverview(this.app.config, path)
                )
            },
            dbTables: {
                data: {
                    keyPath: "id"
                }
            }
        }
    }
}
