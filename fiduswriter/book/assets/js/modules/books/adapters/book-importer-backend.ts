import type {
    Book,
    BookImporterBackend,
    BookMetadata,
    BookSettings
} from "@fiduswriter/books-document"
import {addAlert, postJson} from "fwtoolkit"

/**
 * Browser `BookImporterBackend` factory.
 *
 * Implements the `BookImporterBackend` interface from
 * `@fiduswriter/books-document` by posting the imported book record to the
 * Fidus Writer server `/api/book/save/` endpoint. The chapter documents have
 * already been created on the server by `NativeImporter` (via the native
 * importer backend), so this only needs to persist the book itself.
 *
 * @param path - The folder path where the imported book should land.
 */
export const createBookImporterBackend = (path = "/"): BookImporterBackend => ({
    createBook(bookData, chapters, coverImageId) {
        const bookObj: Book = {
            id: 0,
            title: (bookData.title as string) || gettext("Untitled"),
            path: path.endsWith("/") ? path : path + "/",
            metadata: (bookData.metadata as BookMetadata) || {},
            settings: (bookData.settings as BookSettings) || {language: "en"},
            chapters,
            rights: "write" // required by the server-side save guard
        }

        if (coverImageId) {
            bookObj.cover_image = coverImageId
        }

        return postJson("/api/book/save/", {book: bookObj})
            .then(({json}) => {
                bookObj.id = (json as {id: number}).id
                return bookObj
            })
            .catch((error: unknown) => {
                addAlert("error", gettext("Could not create book record."))
                throw error
            })
    }
})
