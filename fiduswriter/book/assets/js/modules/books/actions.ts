import type {
    Book,
    BookMetadata,
    BookSettings,
    Chapter
} from "@fiduswriter/books-document"
import type {NativeBookImporterOptions} from "@fiduswriter/books-document/importer/native"
import {NativeBookImporter} from "@fiduswriter/books-document/importer/native"
import {createNativeImporterBackend} from "@fiduswriter/frontend/documents/importer/native/import"
import type {ImageDB} from "@fiduswriter/image-manager"
import {ImageSelectionDialog} from "@fiduswriter/image-manager"
import {
    ContentMenu,
    Dialog,
    FileSelector,
    activateWait,
    addAlert,
    deactivateWait,
    escapeText,
    findTarget,
    longFilePath,
    post,
    postJson
} from "fwtoolkit"
import type {DialogButtonSpec} from "fwtoolkit"
import {createBookImporterBackend} from "./adapters/book-importer-backend"
import {
    generateE2EEOptions,
    storeImportedE2EEPassword
} from "./adapters/e2ee_import"
import type {BookOverview} from "./index.js"
import {exportMenuModel} from "./menu"
import {bookSanityCheck} from "./sanity_check"
import {
    bookBasicInfoTemplate,
    bookBibliographyDataTemplate,
    bookChapterDialogTemplate,
    bookChapterListTemplate,
    bookDOCXDataRowTemplate,
    bookDOCXDataTemplate,
    bookDialogChaptersTemplate,
    bookDialogTemplate,
    bookEpubDataCoverTemplate,
    bookEpubDataTemplate,
    bookODTDataRowTemplate,
    bookODTDataTemplate,
    bookPrintDataTemplate,
    bookSanityCheckTemplate
} from "./templates"
import type {BookDialogInfo, BookListEntry} from "./types"

/** One tab of the book dialog. */
interface BookDialogPart {
    title: string
    description: string
    template: (bookInfo: BookDialogInfo) => string
}

/*
 * The native book importer declares the narrow `User` shape of
 * `@fiduswriter/document`; the shared frontend user satisfies it at runtime.
 */
/** The file records fwtoolkit's file selector accepts. */
type FileSelectorFiles = ConstructorParameters<typeof FileSelector>[0]["files"]

const importerUser = (overview: BookOverview) =>
    overview.user as unknown as ConstructorParameters<
        typeof NativeBookImporter
    >[1]

/**
 * Read a value out of one of the book dialog's form fields. The dialog markup
 * comes from the templates in ./templates.ts, so the ids are fixed.
 */
function fieldValue(id: string): string {
    return (document.getElementById(id) as HTMLInputElement).value
}

/** The metadata a freshly created book starts out with. */
function emptyMetadata(): BookMetadata {
    return {
        author: "",
        subtitle: "",
        version: "",
        publisher: "",
        copyright: "",
        keywords: "",
        description: "",
        isbn: "",
        publication_date: "",
        series_title: "",
        series_position: ""
    }
}

export class BookActions {
    bookOverview: BookOverview
    exportMenu: ReturnType<typeof exportMenuModel>
    /** Callbacks invoked after a book has been saved. */
    onSave: Array<(book: Book) => Promise<unknown> | unknown>
    dialogParts: BookDialogPart[]

    constructor(bookOverview: BookOverview) {
        bookOverview.mod.actions = this
        this.bookOverview = bookOverview
        this.exportMenu = exportMenuModel()
        this.onSave = []
        this.dialogParts = [
            {
                title: gettext("Basic info"),
                description: gettext("Basic book information"),
                template: bookBasicInfoTemplate
            },
            {
                title: gettext("Chapters"),
                description: gettext("Documents assigned as chapters"),
                template: bookDialogChaptersTemplate
            },
            {
                title: gettext("Bibliography"),
                description: gettext("Bibliography related settings"),
                template: bookBibliographyDataTemplate
            },
            {
                title: gettext("Epub"),
                description: gettext("Epub related settings"),
                template: bookEpubDataTemplate
            },
            {
                title: gettext("DOCX"),
                description: gettext("DOCX related settings"),
                template: bookDOCXDataTemplate
            },
            {
                title: gettext("ODT"),
                description: gettext("ODT related settings"),
                template: bookODTDataTemplate
            },
            {
                title: gettext("Print/PDF"),
                description: gettext("Print related settings"),
                template: bookPrintDataTemplate
            },
            {
                title: gettext("Sanity check"),
                description: gettext("Perform sanity check on book"),
                template: bookSanityCheckTemplate
            }
        ]
    }

    deleteBook(id: number): Promise<unknown> {
        const book = this.bookOverview.bookList.find(book => book.id === id)
        if (!book) {
            return Promise.resolve()
        }

        return post("/api/book/delete/", {id})
            .catch(error => {
                addAlert(
                    "error",
                    `${gettext("Could not delete book")}: '${longFilePath(
                        book.title,
                        book.path
                    )}'`
                )
                throw error
            })
            .then(() => {
                addAlert(
                    "success",
                    `${gettext("Book has been deleted")}: '${longFilePath(
                        book.title,
                        book.path
                    )}'`
                )
                this.bookOverview.bookList = this.bookOverview.bookList.filter(
                    book => book.id !== id
                )
                this.bookOverview.initTable()
            })
    }

    deleteBookDialog(ids: number[]): void {
        const bookPaths = ids.map(id => {
            const book = this.bookOverview.bookList.find(
                book => book.id === id
            ) as BookListEntry
            return escapeText(longFilePath(book.title, book.path))
        })
        const buttons: DialogButtonSpec[] = [
            {
                type: "close"
            },
            {
                text: gettext("Delete"),
                classes: "fw-dark",
                click: () => {
                    Promise.all(ids.map(id => this.deleteBook(id))).then(() => {
                        dialog.close()
                        this.bookOverview.initTable()
                    })
                }
            }
        ]

        const dialog = new Dialog({
            title: gettext("Confirm deletion"),
            id: "confirmdeletion",
            icon: "exclamation-triangle",
            height: Math.min(50 + 15 * ids.length, 500),
            body: `<p>${
                ids.length > 1
                    ? gettext(
                          "Do you really want to delete the following books?"
                      )
                    : gettext(
                          "Do you really want to delete the following book?"
                      )
            }</p>
            <p>
                ${bookPaths.join("<br>")}
            </p>`,
            buttons
        })
        dialog.open()
    }

    editChapterDialog(chapter: Chapter, book: Book): void {
        const doc = this.bookOverview.documentList.find(
            doc => doc.id === chapter.text
        ) as BookOverview["documentList"][number]
        let docTitle = doc.title
        if (!docTitle.length) {
            docTitle = gettext("Untitled")
        }

        const buttons: DialogButtonSpec[] = [
            {
                type: "cancel"
            },
            {
                text: gettext("Submit"),
                classes: "fw-dark",
                click: () => {
                    chapter.part = fieldValue("book-chapter-part")
                    document.getElementById("book-chapter-list")!.innerHTML =
                        bookChapterListTemplate({
                            book,
                            documentList: this.bookOverview.documentList
                        })
                    dialog.close()
                }
            }
        ]

        const dialog = new Dialog({
            title: `${gettext("Edit Chapter")}: ${chapter.number}. ${docTitle}`,
            body: bookChapterDialogTemplate({chapter}),
            width: 300,
            height: 100,
            buttons
        })
        dialog.open()
    }

    saveBook(book: Book, oldBookId: number | false = false): Promise<unknown> {
        const oldBook = oldBookId
            ? this.bookOverview.bookList.find(book => book.id === oldBookId)
            : undefined
        if (book.rights !== "write") {
            return Promise.resolve()
        }
        book.title = fieldValue("book-title")
        book.metadata.author = fieldValue("book-metadata-author")
        book.metadata.subtitle = fieldValue("book-metadata-subtitle")
        book.metadata.version = fieldValue("book-metadata-version")
        book.metadata.copyright = fieldValue("book-metadata-copyright")
        book.metadata.publisher = fieldValue("book-metadata-publisher")
        book.metadata.keywords = fieldValue("book-metadata-keywords")
        book.metadata.description = fieldValue("book-metadata-description")
        book.metadata.isbn = fieldValue("book-metadata-isbn")
        book.metadata.publication_date = fieldValue(
            "book-metadata-publication-date"
        )
        book.metadata.series_title = fieldValue("book-metadata-series-title")
        book.metadata.series_position = fieldValue(
            "book-metadata-series-position"
        )
        book.settings.language = fieldValue("book-settings-language")
        book.path =
            (oldBookId ? (oldBook?.path ?? "") : "") || this.bookOverview.path
        const bookData = Object.assign({}, book)
        delete bookData.cover_image_data

        return postJson("/api/book/save/", {book: bookData})
            .catch(error => {
                addAlert("error", gettext("The book could not be saved"))
                throw error
            })
            .then(({status, json}) => {
                const saved = json as {
                    id: number
                    added: number
                    updated: number
                }
                if (status == 201) {
                    book.id = saved.id
                    book.added = saved.added
                }
                book.updated = saved.updated
                if (oldBookId) {
                    this.bookOverview.bookList =
                        this.bookOverview.bookList.filter(
                            book => book.id !== oldBookId
                        )
                }
                this.bookOverview.bookList.push(book as BookListEntry)
                this.bookOverview.initTable()
                return Promise.all(this.onSave.map(method => method(book)))
            })
    }

    copyBook(oldBook: BookListEntry): Promise<unknown> {
        const book = Object.assign({}, oldBook) as BookListEntry
        book.is_owner = true
        book.owner = {
            id: (this.bookOverview.user.id as number) ?? 0,
            name: this.bookOverview.user.name ?? "",
            avatar: (this.bookOverview.user.avatar as string) ?? null
        }
        book.rights = "write"
        const path = longFilePath(
            oldBook.title,
            oldBook.path,
            `${gettext("Copy of")} `
        )
        return postJson("/api/book/copy/", {id: book.id, path})
            .catch(error => {
                addAlert("error", gettext("The book could not be copied"))
                throw error
            })
            .then(({json}) => {
                const copied = json as {id: number; path: string}
                book.id = copied["id"]
                book.path = copied["path"]
                this.bookOverview.bookList.push(book as BookListEntry)
                this.bookOverview.initTable()
            })
    }

    /**
     * Open a dialog to let the user pick a .fidusbook file and import it.
     * Creates all chapter documents on the server via the native importer
     * backend and finally creates the book record via the book importer
     * backend.
     */
    importBook(): void {
        const overview = this.bookOverview
        const e2eeMode = overview.app.settings.E2EE_MODE
        const e2eeRequired = e2eeMode === "required"
        const e2eeOptional = e2eeMode === "enabled"

        const e2eeNote = e2eeRequired
            ? `<p class="fw-note" style="margin-top:10px;">
                <i class="fas fa-lock"></i>
                ${gettext("Chapters will be imported as encrypted (E2EE) documents.")}
               </p>`
            : ""
        const e2eeCheckbox = e2eeOptional
            ? `<p style="margin-top:10px;">
                <label>
                    <input type="checkbox" id="fidusbook-import-e2ee" style="margin-right:6px;">
                    ${gettext("Import chapters as encrypted (E2EE) documents")}
                </label>
               </p>`
            : ""

        const importDialog = new Dialog({
            id: "import_fidusbook",
            title: gettext("Import a book"),
            body: `<p>
                <label class="fw-document-list-item fw-large" for="fidusbook-uploader">
                    ${gettext("Select a .fidusbook file:")}
                </label>
            </p>
            <p>
                <input type="file"
                       id="fidusbook-uploader"
                       accept=".fidusbook"
                       style="display:block;margin-top:8px;">
            </p>
            ${e2eeNote}
            ${e2eeCheckbox}`,
            height: e2eeRequired || e2eeOptional ? 230 : 180,
            buttons: [
                {
                    text: gettext("Import"),
                    classes: "fw-dark",
                    click: () => {
                        const fileInput = document.getElementById(
                            "fidusbook-uploader"
                        ) as HTMLInputElement | null
                        if (!fileInput?.files || fileInput.files.length === 0) {
                            return
                        }
                        const file = fileInput.files[0]
                        if (file.size > 524288000) {
                            // 500 MB hard limit
                            addAlert("error", gettext("File too large"))
                            return
                        }
                        const useE2EE =
                            e2eeRequired ||
                            (e2eeOptional &&
                                !!(
                                    document.getElementById(
                                        "fidusbook-import-e2ee"
                                    ) as HTMLInputElement | null
                                )?.checked)
                        importDialog.close()
                        activateWait(true)

                        const importer = new NativeBookImporter(
                            file,
                            importerUser(overview),
                            createNativeImporterBackend(
                                overview.user,
                                null,
                                overview.app.apiConnectors
                            ) as unknown as ConstructorParameters<
                                typeof NativeBookImporter
                            >[2],
                            createBookImporterBackend(overview.path),
                            {
                                path: overview.path,
                                getE2EEOptions: useE2EE
                                    ? (generateE2EEOptions as NonNullable<
                                          NativeBookImporterOptions["getE2EEOptions"]
                                      >)
                                    : undefined,
                                onChapterImported: useE2EE
                                    ? (storeImportedE2EEPassword as unknown as NonNullable<
                                          NativeBookImporterOptions["onChapterImported"]
                                      >)
                                    : undefined
                            }
                        )
                        importer
                            .init()
                            .then(({ok, statusText}) => {
                                deactivateWait()
                                if (ok) {
                                    addAlert("info", statusText)
                                    // Refresh the book list from the server
                                    // so the newly-imported book appears.
                                    overview.getBookListData()
                                } else {
                                    addAlert("error", statusText)
                                }
                            })
                            .catch(() => {
                                deactivateWait()
                            })
                    }
                },
                {
                    type: "cancel"
                }
            ]
        })
        importDialog.open()
    }

    createBookDialog(bookId: number, imageDB: ImageDB): void {
        let title: string, book: BookListEntry, oldBookId: number | false
        const bookImageDB: {db: Record<number, unknown>} = {db: {}}

        if (bookId === 0) {
            title = gettext("Create Book")
            book = {
                title: "",
                id: 0,
                chapters: [],
                is_owner: true,
                owner: {
                    id: (this.bookOverview.user.id as number) ?? 0,
                    name: this.bookOverview.user.name ?? "",
                    avatar: (this.bookOverview.user.avatar as string) ?? null
                },
                added: 0,
                updated: 0,
                path: this.bookOverview.path,
                rights: "write",
                metadata: emptyMetadata(),
                settings: {
                    bibliography_header: gettext("Bibliography"),
                    citationstyle: "apa",
                    book_style: this.bookOverview.styles[0]
                        ? this.bookOverview.styles[0].slug
                        : ("" as string),
                    papersize: "octavo",
                    language: "en-US"
                }
            }
        } else {
            const oldBook = this.bookOverview.bookList.find(
                book => book.id === bookId
            ) as BookListEntry
            book = Object.assign({}, oldBook)
            book.metadata = Object.assign(emptyMetadata(), oldBook.metadata)
            oldBookId = oldBook.id

            if (book.cover_image && !imageDB.db[book.cover_image]) {
                // The cover image is not in the current user's image DB --
                // it was either deleted or another user originally added
                // it. As we don't do anything fancy with it, we simply add
                // the current cover image to the DB locally so that image
                // selection works as expected.
                bookImageDB.db[book.cover_image] = book.cover_image_data as
                    | Record<string, unknown>
                    | undefined
            }
            title = gettext("Edit Book")
        }
        const body = bookDialogTemplate({
            title,
            dialogParts: this.dialogParts,
            bookInfo: {
                book,
                documentList: this.bookOverview.documentList,
                citationStyles: this.bookOverview.citationStyles,
                bookStyleList: this.bookOverview.styles,
                imageDB: {
                    db: Object.assign({}, imageDB.db, bookImageDB.db) as Record<
                        number,
                        {image?: string}
                    >
                }
            }
        })

        const buttons: DialogButtonSpec[] = []
        buttons.push({
            text: gettext("Export"),
            dropdown: true,
            classes: "fw-dark",
            click: (event?: Event) => {
                const mouseEvent = event as MouseEvent
                const contentMenu = new ContentMenu({
                    page: {
                        saveBook: () => this.saveBook(book, oldBookId),
                        book,
                        overview: this.bookOverview
                    },
                    menu: this.exportMenu,
                    menuPos: {X: mouseEvent.pageX, Y: mouseEvent.pageY},
                    width: 250
                })
                return contentMenu.open()
            }
        })
        if (book.rights === "write") {
            buttons.push({
                text: gettext("Submit"),
                classes: "fw-dark",
                click: () => {
                    return this.saveBook(book, oldBookId).then(() =>
                        dialog.close()
                    )
                }
            })
            buttons.push({type: "cancel"})
        } else {
            buttons.push({type: "close"})
        }

        const dialog = new Dialog({
            width: 840,
            height: 520,
            title,
            body,
            buttons
        })
        dialog.open()

        dialog.dialogEl
            .querySelectorAll<HTMLElement>("#bookoptions-tab .tab-content")
            .forEach((el, index) => {
                if (index) {
                    el.style.display = "none"
                }
            })
        let fileSelector: FileSelector | undefined
        if (book.rights === "write") {
            fileSelector = new FileSelector({
                dom: dialog.dialogEl.querySelector<HTMLElement>(
                    "#book-document-list"
                )!,
                files: this.bookOverview
                    .documentList as unknown as FileSelectorFiles,
                multiSelect: true,
                selectFolders: false
            })
            fileSelector.init()

            dialog.dialogEl
                .querySelector<HTMLInputElement>("#input-docx-template")!
                .addEventListener("change", event => {
                    const file = (event.target as HTMLInputElement).files![0]
                    return this.saveBook(book)
                        .then(() =>
                            postJson(
                                "/api/book/docx_template/save/",
                                {
                                    id: book.id
                                },
                                {file}
                            )
                        )
                        .then(({status, json}) => {
                            if (status !== 200) {
                                return
                            }
                            book.docx_template = (
                                json as {docx_template: string}
                            ).docx_template
                            const docxTemplateRow =
                                document.getElementById("docx-template-row")
                            if (docxTemplateRow) {
                                docxTemplateRow.innerHTML =
                                    bookDOCXDataRowTemplate({book})
                            }
                        })
                })

            dialog.dialogEl
                .querySelector<HTMLInputElement>("#input-odt-template")!
                .addEventListener("change", event => {
                    const file = (event.target as HTMLInputElement).files![0]
                    return this.saveBook(book)
                        .then(() =>
                            postJson(
                                "/api/book/odt_template/save/",
                                {
                                    id: book.id
                                },
                                {file}
                            )
                        )
                        .then(({status, json}) => {
                            if (status !== 200) {
                                return
                            }
                            book.odt_template = (
                                json as {odt_template: string}
                            ).odt_template
                            const odtTemplateRow =
                                document.getElementById("odt-template-row")
                            if (odtTemplateRow) {
                                odtTemplateRow.innerHTML =
                                    bookODTDataRowTemplate({book})
                            }
                        })
                })
        }

        // Handle tab link clicking
        dialog.dialogEl
            .querySelectorAll<HTMLAnchorElement>(
                "#bookoptions-tab .fw-tab-link a"
            )
            .forEach(el => {
                const tab = el.parentElement as HTMLElement
                const tabList = tab.parentElement as HTMLElement
                el.addEventListener("click", event => {
                    event.preventDefault()

                    tabList
                        .querySelectorAll<HTMLElement>(
                            ".fw-tab-link.fw-current-tab"
                        )
                        .forEach(other =>
                            other.classList.remove("fw-current-tab")
                        )
                    tab.classList.add("fw-current-tab")

                    const link = el.getAttribute("href") as string
                    dialog.dialogEl
                        .querySelectorAll<HTMLElement>(
                            "#bookoptions-tab .tab-content"
                        )
                        .forEach(panel => {
                            if (panel.matches(link)) {
                                panel.style.display = ""
                            } else {
                                panel.style.display = "none"
                            }
                        })
                })
            })

        dialog.dialogEl.addEventListener("click", event => {
            const el: {target?: HTMLElement} = {}
            let chapterId: number, chapter: Chapter

            // Helper: add or remove the encrypted-chapters notice that lives
            // alongside #book-chapter-list. Called after any operation that
            // changes book.chapters so the notice stays in sync.
            const updateChapterNotice = () => {
                const chapterListEl =
                    document.getElementById("book-chapter-list")
                if (!chapterListEl) {
                    return
                }
                const container = chapterListEl.closest(".fw-ar-container")
                if (!container) {
                    return
                }
                const existingNotice = container.querySelector(
                    ".e2ee-chapter-notice"
                )
                const hasEncrypted = book.chapters.some(
                    ch =>
                        this.bookOverview.documentList.find(
                            doc => doc.id === ch.text
                        )?.e2ee
                )
                if (hasEncrypted && !existingNotice) {
                    container.insertAdjacentHTML(
                        "beforeend",
                        `<p class="fw-note e2ee-chapter-notice">
                            <i class="fas fa-lock"></i>
                            ${gettext("This book contains encrypted chapters. A personal passphrase is required to export or run a sanity check on this book.")}
                        </p>`
                    )
                } else if (!hasEncrypted && existingNotice) {
                    existingNotice.remove()
                }
            }

            switch (true) {
                case findTarget(event, ".book-sort-up", el): {
                    chapterId = Number.parseInt(el.target!.dataset.id as string)
                    chapter = book.chapters.find(
                        chapter => chapter.text === chapterId
                    ) as Chapter

                    const higherChapter = book.chapters.find(
                        bChapter => bChapter.number === chapter.number - 1
                    ) as Chapter
                    chapter.number--
                    higherChapter.number++
                    document.getElementById("book-chapter-list")!.innerHTML =
                        bookChapterListTemplate({
                            book,
                            documentList: this.bookOverview.documentList
                        })
                    updateChapterNotice()
                    break
                }
                case findTarget(event, ".book-sort-down", el): {
                    chapterId = Number.parseInt(el.target!.dataset.id as string)
                    chapter = book.chapters.find(
                        chapter => chapter.text === chapterId
                    ) as Chapter

                    const lowerChapter = book.chapters.find(
                        bChapter => bChapter.number === chapter.number + 1
                    ) as Chapter

                    chapter.number++
                    lowerChapter.number--
                    document.getElementById("book-chapter-list")!.innerHTML =
                        bookChapterListTemplate({
                            book,
                            documentList: this.bookOverview.documentList
                        })
                    updateChapterNotice()
                    break
                }
                case findTarget(event, ".delete-chapter", el):
                    chapterId = Number.parseInt(el.target!.dataset.id as string)
                    chapter = book.chapters.find(
                        chapter => chapter.text === chapterId
                    ) as Chapter

                    book.chapters.forEach(bChapter => {
                        if (bChapter.number > chapter.number) {
                            bChapter.number--
                        }
                    })

                    book.chapters = book.chapters.filter(
                        bChapter => bChapter !== chapter
                    )

                    document.getElementById("book-chapter-list")!.innerHTML =
                        bookChapterListTemplate({
                            book,
                            documentList: this.bookOverview.documentList
                        })
                    updateChapterNotice()

                    break
                case findTarget(event, "#add-chapter", el): {
                    fileSelector!.selected.forEach(entry => {
                        const chapNums = book.chapters.map(
                                chapter => chapter.number
                            ),
                            number = chapNums.length
                                ? Math.max(...chapNums) + 1
                                : 1
                        if (entry.type !== "file") {
                            return
                        }
                        book.chapters.push({
                            text: entry.file.id as number,
                            number,
                            part: ""
                        })
                    })
                    fileSelector!.deselectAll()

                    document.getElementById("book-chapter-list")!.innerHTML =
                        bookChapterListTemplate({
                            book,
                            documentList: this.bookOverview.documentList
                        })
                    updateChapterNotice()
                    break
                }
                case findTarget(event, ".edit-chapter", el):
                    chapterId = Number.parseInt(el.target!.dataset.id as string)
                    chapter = book.chapters.find(
                        chapter => chapter.text === chapterId
                    ) as Chapter
                    this.editChapterDialog(chapter, book)
                    break
                case findTarget(event, "#select-cover-image-button", el): {
                    const imageSelection = new ImageSelectionDialog(
                        bookImageDB as unknown as ImageDB,
                        imageDB,
                        book.cover_image ?? false,
                        this.bookOverview as unknown as ConstructorParameters<
                            typeof ImageSelectionDialog
                        >[3]
                    )

                    imageSelection.init().then(selected => {
                        const image = selected as {
                            id: number
                            db: string
                        } | null
                        if (!image) {
                            delete book.cover_image
                        } else {
                            book.cover_image = image.id
                            book.cover_image_data = (
                                image.db === "user"
                                    ? imageDB.db[image.id]
                                    : bookImageDB.db[image.id]
                            ) as BookListEntry["cover_image_data"]
                        }
                        const coverPreviewRow =
                            document.getElementById("cover-preview-row")
                        if (coverPreviewRow) {
                            coverPreviewRow.innerHTML =
                                bookEpubDataCoverTemplate({
                                    book,
                                    imageDB: {
                                        db: Object.assign(
                                            {},
                                            imageDB.db,
                                            bookImageDB.db
                                        )
                                    }
                                })
                        }
                    })
                    break
                }
                case findTarget(event, "#select-docx-template", el): {
                    const fileSelector = document.querySelector<HTMLElement>(
                        "#input-docx-template"
                    )
                    fileSelector!.click()
                    break
                }
                case findTarget(event, "#select-odt-template", el): {
                    const fileSelector = document.querySelector<HTMLElement>(
                        "#input-odt-template"
                    )
                    fileSelector!.click()
                    break
                }
                case findTarget(event, "#remove-cover-image-button", el): {
                    delete book.cover_image
                    const coverPreviewRow =
                        document.getElementById("cover-preview-row")
                    if (coverPreviewRow) {
                        coverPreviewRow.innerHTML = bookEpubDataCoverTemplate({
                            book,
                            imageDB: {db: {}} // We just deleted the cover image, so we don't need a full DB
                        })
                    }
                    break
                }
                case findTarget(event, "#remove-docx-template-button", el): {
                    delete book.docx_template
                    const docxTemplateRow =
                        document.getElementById("docx-template-row")
                    if (docxTemplateRow) {
                        docxTemplateRow.innerHTML = bookDOCXDataRowTemplate({
                            book
                        })
                    }
                    break
                }
                case findTarget(event, "#remove-odt-template-button", el): {
                    delete book.odt_template
                    const odtTemplateRow =
                        document.getElementById("odt-template-row")
                    if (odtTemplateRow) {
                        odtTemplateRow.innerHTML = bookODTDataRowTemplate({
                            book
                        })
                    }
                    break
                }
                case findTarget(event, "#perform-sanity-check-button", el): {
                    this.saveBook(book, oldBookId)
                        .then(() =>
                            bookSanityCheck(
                                book,
                                this.bookOverview.documentList,
                                this.bookOverview.schema,
                                this.bookOverview.app
                            )
                        )
                        .then(sanityCheckOutputHTML => {
                            const sanityCheckOutput = document.getElementById(
                                "sanity-check-output"
                            )
                            if (sanityCheckOutput) {
                                sanityCheckOutput.innerHTML =
                                    sanityCheckOutputHTML
                            }
                        })
                    break
                }
                default:
                    break
            }
        })

        dialog.dialogEl
            .querySelector<HTMLSelectElement>("#book-settings-citationstyle")!
            .addEventListener("change", event => {
                book.settings.citationstyle = (
                    event.target as HTMLSelectElement
                ).value
            })

        dialog.dialogEl
            .querySelector<HTMLSelectElement>("#book-settings-bookstyle")!
            .addEventListener("change", event => {
                book.settings.book_style = (
                    event.target as HTMLSelectElement
                ).value
            })

        dialog.dialogEl
            .querySelector<HTMLSelectElement>("#book-settings-papersize")!
            .addEventListener("change", event => {
                book.settings.papersize = (
                    event.target as HTMLSelectElement
                ).value
            })
    }
}
