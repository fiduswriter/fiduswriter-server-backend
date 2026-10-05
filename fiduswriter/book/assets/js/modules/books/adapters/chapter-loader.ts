import type {
    ChapterLoader,
    DocumentListEntry
} from "@fiduswriter/books-document"
import {getMissingDocumentListData} from "@fiduswriter/frontend/documents/tools"
import type {Schema} from "prosemirror-model"
import type {FrontendApp} from "../types"

/**
 * Browser `ChapterLoader` adapter.
 *
 * Implements the `ChapterLoader` interface from `@fiduswriter/books-document`
 * by delegating to the Fidus Writer core `getMissingDocumentListData` fetch
 * helper, which lazily loads a chapter's content, comments, bibliography and
 * images from the server and updates the document list entries in place.
 *
 * @param app - The Fidus Writer app instance (provides `apiConnectors.document`).
 * @returns A `ChapterLoader` with a `loadChapters` method.
 */
export const createChapterLoader = (app: FrontendApp): ChapterLoader => ({
    loadChapters(
        chapterIds: number[],
        documentList: DocumentListEntry[],
        schema?: Schema,
        rawContent = false
    ) {
        return getMissingDocumentListData(
            chapterIds,
            // The core helper describes the entries it mutates with its own
            // `DocEntry`; the book app holds the exporter's
            // `DocumentListEntry`, which describes the same API objects.
            documentList as unknown as Parameters<
                typeof getMissingDocumentListData
            >[1],
            schema as Parameters<typeof getMissingDocumentListData>[2],
            app.apiConnectors.document,
            rawContent
        )
    }
})
