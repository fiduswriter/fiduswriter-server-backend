import type {Book} from "@fiduswriter/books-document"
import {BITSBookExporter} from "@fiduswriter/books-document/exporter/bits"
import {DOCXBookExporter} from "@fiduswriter/books-document/exporter/docx"
import {EpubBookExporter} from "@fiduswriter/books-document/exporter/epub"
import {HTMLBookExporter} from "@fiduswriter/books-document/exporter/html"
import {LatexBookExporter} from "@fiduswriter/books-document/exporter/latex"
import {NativeBookExporter} from "@fiduswriter/books-document/exporter/native"
import {ODTBookExporter} from "@fiduswriter/books-document/exporter/odt"
import {PrintBookExporter} from "@fiduswriter/books-document/exporter/print"
import {getMissingChapterData} from "@fiduswriter/books-document/exporter/tools"
import type {CSL, User} from "@fiduswriter/document"
import {saveFile} from "@fiduswriter/document/exporter/save"
import type {ProgressCallback} from "@fiduswriter/document/exporter/tools/progress"
import {FileDialog, NewFolderDialog, addAlert, addProgress} from "fwtoolkit"
import {BookAccessRightsDialog} from "./accessrights"
import {createChapterLoader} from "./adapters/chapter-loader"
import {e2eeStrategy} from "./adapters/e2ee-strategy"
import type {BookOverview} from "./index.js"
import type {
    BookContact,
    BookListEntry,
    BookStyles,
    ContentMenuInit,
    DocumentListEntry,
    OverviewMenuModel
} from "./types"

let currentlySearching = false

/**
 * The subset of a book exporter this module needs. Every exporter of
 * `@fiduswriter/books-document` exposes these members; the declared return
 * type of `init()` differs slightly between them (some return `false`, some
 * `void`, instead of a Blob), so it is kept loose here. `mimeType` likewise
 * only exists on the DOCX/ODT exporters, which read it off the instance.
 */
interface BookExporterLike {
    book: Book
    defaultFilename: string
    // Declared inconsistently across the exporters: some resolve to `false`
    // or nothing, and BITS/DOCX/ODT can return `false` synchronously.
    init(
        progressCallback?: ProgressCallback
    ): Promise<Blob | false | void> | false
}

/*
 * The book overview's `app`/`user` are the shared frontend objects, which are
 * structurally wider than the narrow `CSL` class and `User` shape that the
 * exporters declare. Both are satisfied at runtime, so narrow them once here
 * rather than casting at each of the twelve exporter call sites.
 */
const exporterCSL = (overview: BookOverview): CSL =>
    overview.app.csl as unknown as CSL
const exporterUser = (overview: BookOverview): User =>
    overview.user as unknown as User
const exporterStyles = (overview: BookOverview): BookStyles =>
    overview.styles as BookStyles
const exporterDocuments = (overview: BookOverview): DocumentListEntry[] =>
    overview.documentList

/**
 * Arguments passed to the callbacks of the single-book export menu. The
 * dialogs assemble them once and hand them to every entry.
 */
interface ExportMenuArgs {
    saveBook: () => Promise<unknown>
    book: BookListEntry
    overview: BookOverview
}

/** Model of the book dialog's export menu (a `ContentMenu` of actions). */
type ExportMenuModel = ContentMenuInit

/**
 * Load any missing chapter data (fetching content lazily and decrypting E2EE
 * chapters), run the given exporter, then trigger a browser download of the
 * resulting Blob.
 *
 * The @fiduswriter/books-document exporters are environment-agnostic: they
 * load chapter data through injected strategies (defaulting to no-ops) and
 * their base `download()` simply returns the produced Blob. In the browser we
 * therefore pre-load the chapter data with the core-backed adapters — after
 * which the exporter's own internal `getMissingChapterData` call is a no-op —
 * and deliver the finished Blob to the user via saveFile (File System Access
 * API where available, download fallback otherwise).
 *
 * @param exporter - A constructed book exporter instance.
 * @param overview - The BookOverview page.
 * @param mimeType - MIME type for the downloaded file.
 * @param rawContent - Whether the exporter needs doc.rawContent.
 */
const runBookExport = (
    exporter: BookExporterLike,
    overview: BookOverview,
    mimeType: string,
    rawContent = false
): Promise<unknown> => {
    const formatName =
        exporter.defaultFilename.split(".").pop()?.toUpperCase() ||
        gettext("Book")
    const task = addProgress(
        "info",
        `${exporter.book.title}: ${gettext("Exporting")} ${formatName}...`,
        {autoClose: 6000}
    )
    const progressCallback: ProgressCallback = (message, percentage) =>
        task.update(percentage ?? null, message)

    return getMissingChapterData(
        exporter.book,
        exporterDocuments(overview),
        overview.schema,
        {
            rawContent,
            loader: createChapterLoader(overview.app),
            e2ee: e2eeStrategy,
            progressCallback
        }
    )
        .then(() => exporter.init(progressCallback))
        .then(blob => {
            task.update(100, gettext("Export complete."))
            if (blob) {
                const extension = `.${exporter.defaultFilename.split(".").pop()}`
                saveFile(blob, exporter.defaultFilename, {
                    description: exporter.book.title,
                    mimeType,
                    extensions: [extension]
                })
            }
            return blob
        })
        .catch((error: Error) => {
            task.close()
            addAlert("error", error.message || gettext("Book export failed."))
        })
}

export const menuModel = (): OverviewMenuModel => ({
    content: [
        {
            type: "text",
            title: gettext("Create new book"),
            keys: "Alt-n",
            action: (page: unknown) => {
                const overview = page as BookOverview
                overview.getImageDB().then(() => {
                    overview.mod.actions.createBookDialog(0, overview.imageDB)
                })
            },
            order: 1
        },
        {
            type: "text",
            title: gettext("Create new folder"),
            keys: "Alt-f",
            action: (page: unknown) => {
                const overview = page as BookOverview
                const dialog = new NewFolderDialog(folderName => {
                    overview.path = overview.path + folderName + "/"
                    window.history.pushState({}, "", "/books" + overview.path)
                    overview.initTable()
                })
                dialog.open()
            },
            order: 2
        },
        {
            type: "text",
            title: gettext("Import book from Fidusbook file"),
            keys: "Alt-i",
            action: (page: unknown) => {
                const overview = page as BookOverview
                overview.mod.actions.importBook()
            },
            order: 3
        },
        {
            type: "search",
            icon: "search",
            title: gettext("Search books"),
            keys: "s",
            input: (page: unknown, text: string) => {
                const overview = page as BookOverview
                if (text.length && !currentlySearching) {
                    overview.initTable(true)
                    currentlySearching = true
                    overview.table!.on("datatable.init", () =>
                        overview.table!.search(text)
                    )
                } else if (!text.length && currentlySearching) {
                    overview.initTable(false)
                    currentlySearching = false
                } else if (text.length) {
                    overview.table!.search(text)
                }
            },
            order: 4
        }
    ]
})

/** Look a book up in the overview list by its id. */
const findBook = (overview: BookOverview, id: number): BookListEntry =>
    overview.bookList.find(book => book.id === id) as BookListEntry

const exportEpub = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new EpubBookExporter(
        overview.schema,
        exporterCSL(overview),
        exporterStyles(overview),
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(exporter, overview, "application/epub+zip")
}

const exportBITS = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new BITSBookExporter(
        overview.schema,
        exporterCSL(overview),
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(exporter, overview, "application/zip")
}

const exportHTML = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new HTMLBookExporter(
        overview.schema,
        exporterCSL(overview),
        exporterStyles(overview),
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(exporter, overview, "application/zip")
}

const exportSingleHTML = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new HTMLBookExporter(
        overview.schema,
        exporterCSL(overview),
        exporterStyles(overview),
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated,
        false
    )
    return runBookExport(exporter, overview, "application/zip")
}

const exportLatex = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new LatexBookExporter(
        overview.schema,
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(exporter, overview, "application/zip")
}

const exportDOCX = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new DOCXBookExporter(
        overview.schema,
        exporterCSL(overview),
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(exporter, overview, exporter.mimeType, true)
}

const exportODT = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new ODTBookExporter(
        overview.schema,
        exporterCSL(overview),
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(exporter, overview, exporter.mimeType, true)
}

const exportPrint = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new PrintBookExporter(
        overview.schema,
        exporterCSL(overview),
        exporterStyles(overview),
        book,
        exporterUser(overview),
        overview.documentList
    )
    return runBookExport(exporter, overview, "text/html")
}

const exportFidusbook = (book: BookListEntry, overview: BookOverview) => {
    const exporter = new NativeBookExporter(
        overview.schema,
        book,
        exporterUser(overview),
        exporterDocuments(overview),
        book.updated
    )
    return runBookExport(
        exporter,
        overview,
        "application/vnd.fiduswriter.book+zip"
    )
}

export const bulkMenuModel = (): ContentMenuInit => ({
    content: [
        {
            title: gettext("Move selected"),
            tooltip: gettext("Move the books that have been selected."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                const books = ids.map(id => findBook(overview, id))
                if (books.length) {
                    const dialog = new FileDialog({
                        title:
                            books.length > 1
                                ? gettext("Move books")
                                : gettext("Move book"),
                        movingFiles: books,
                        allFiles: overview.bookList,
                        moveUrl: "/api/book/move/",
                        successMessage: gettext("Book has been moved"),
                        errorMessage: gettext("Could not move book"),
                        succcessCallback: (file, path) => {
                            file.path = path
                            overview.initTable()
                        }
                    })
                    dialog.init()
                }
            }
        },
        {
            title: gettext("Delete selected"),
            tooltip: gettext("Delete selected books."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                const ownIds = ids.filter(id => findBook(overview, id).is_owner)
                if (ownIds.length !== ids.length) {
                    addAlert(
                        "error",
                        gettext("You cannot delete books of other users.")
                    )
                }
                if (ownIds.length) {
                    overview.mod.actions.deleteBookDialog(ownIds)
                }
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Share selected"),
            tooltip: gettext("Share selected books."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                const ownIds = ids.filter(id => findBook(overview, id).is_owner)
                if (ownIds.length !== ids.length) {
                    addAlert(
                        "error",
                        gettext("You cannot share books of other users.")
                    )
                }
                if (ownIds.length) {
                    const accessDialog = new BookAccessRightsDialog(
                        ownIds,
                        overview.contacts,
                        (memberDetails: BookContact) =>
                            overview.contacts.push(memberDetails),
                        overview.app
                    )
                    accessDialog.init()
                }
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Copy selected"),
            tooltip: gettext("Copy selected books."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id =>
                    overview.mod.actions.copyBook(findBook(overview, id))
                )
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as BITS"),
            tooltip: gettext("Export selected books as BITS."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportBITS(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as Epub"),
            tooltip: gettext("Export selected books as Epub."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportEpub(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as HTML"),
            tooltip: gettext("Export selected books as HTML."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportHTML(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as Unified HTML"),
            tooltip: gettext("Export selected books as Single-file HTML."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportSingleHTML(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as LaTeX"),
            tooltip: gettext("Export selected books as LaTeX."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportLatex(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as DOCX"),
            tooltip: gettext("Export selected books as DOCX."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    if (book.docx_template) {
                        exportDOCX(book, overview)
                    } else {
                        addAlert(
                            "error",
                            book.title +
                                ": " +
                                gettext(
                                    "This book does not have a DOCX template."
                                )
                        )
                    }
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as ODT"),
            tooltip: gettext("Export selected books as ODT."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    if (book.odt_template) {
                        exportODT(book, overview)
                    } else {
                        addAlert(
                            "error",
                            book.title +
                                ": " +
                                gettext(
                                    "This book does not have an ODT template."
                                )
                        )
                    }
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected to Print/PDF"),
            tooltip: gettext("Export selected books to the print dialog."),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportPrint(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        },
        {
            title: gettext("Export selected as Fidusbook"),
            tooltip: gettext(
                "Export selected books as .fidusbook files (for moving to another server)."
            ),
            action: (page: unknown) => {
                const overview = page as BookOverview
                const ids = overview.getSelected()
                ids.forEach(id => {
                    const book = findBook(overview, id)
                    exportFidusbook(book, overview)
                })
            },
            disabled: (page: unknown) =>
                !(page as BookOverview).getSelected().length
        }
    ]
})

export const exportMenuModel = (): ExportMenuModel => ({
    content: [
        {
            type: "action",
            title: gettext("Export as BITS"),
            tooltip: gettext("Export book as Book Interchange Tag Set."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportBITS(book, overview))
            }
        },
        {
            type: "action",
            title: gettext("Export as Epub"),
            tooltip: gettext("Export book as Epub."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportEpub(book, overview))
            }
        },
        {
            type: "action",
            title: gettext("Export as HTML"),
            tooltip: gettext("Export book as HTML."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportHTML(book, overview))
            }
        },
        {
            type: "action",
            title: gettext("Export as Unified HTML"),
            tooltip: gettext("Export book as Single-file HTML."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportSingleHTML(book, overview))
            }
        },
        {
            type: "action",
            title: gettext("Export as LaTeX"),
            tooltip: gettext("Export book as LaTeX."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportLatex(book, overview))
            }
        },
        {
            type: "action",
            title: gettext("Export as DOCX"),
            tooltip: gettext("Export book as DOCX."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportDOCX(book, overview))
            },
            disabled: (page: unknown) =>
                !(page as ExportMenuArgs).book.docx_template
        },

        {
            type: "action",
            title: gettext("Export as ODT"),
            tooltip: gettext("Export book as ODT."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportODT(book, overview))
            },
            disabled: (page: unknown) =>
                !(page as ExportMenuArgs).book.odt_template
        },
        {
            type: "action",
            title: gettext("Export to Print/PDF"),
            tooltip: gettext("Export book to the print dialog."),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportPrint(book, overview))
            }
        },
        {
            type: "action",
            title: gettext("Export as Fidusbook"),
            tooltip: gettext(
                "Export book as a .fidusbook file (for moving to another server)."
            ),
            action: (page: unknown) => {
                const {saveBook, book, overview} = page as ExportMenuArgs
                saveBook().then(() => exportFidusbook(book, overview))
            }
        }
    ]
})
