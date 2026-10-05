/*
 * App-specific types for the book overview.
 *
 * The book record, chapter and document-list shapes come from
 * `@fiduswriter/books-document` (they are what the exporters consume). This
 * module only adds the pieces that exist solely in the Django backend's
 * /api/book/ payloads: the contact list, the access-right payloads and the
 * book overview's own mutable state.
 *
 * A few toolkit types are not re-exported by name from `fwtoolkit` /
 * `@fiduswriter/frontend`, so they are derived here from the exported classes
 * instead of widening those packages' public API for this one consumer.
 */

import type {
    Book,
    BookStyle,
    BookStyles,
    Chapter,
    DocumentListEntry
} from "@fiduswriter/books-document"
import type {App} from "@fiduswriter/frontend/app"
import type {
    DatatableBulk,
    OverviewDataTable,
    OverviewMenuView
} from "fwtoolkit"

export type {Book, BookStyle, BookStyles, Chapter, DocumentListEntry}

/** The runtime config object that pages receive as their `app`. */
export type FrontendApp = App["config"]

/** The simple-datatables instance owned by an {@link OverviewDataTable}. */
export type DataTable = NonNullable<OverviewDataTable["table"]>

/** The menu model consumed by fwtoolkit's `OverviewMenuView`. */
export type OverviewMenuModel = OverviewMenuView["model"]

/** A single item inside an {@link OverviewMenuModel}. */
export type OverviewMenuItem = OverviewMenuModel["content"][number]

/** The content-menu model consumed by fwtoolkit's bulk-action menus. */
export type ContentMenuInit = DatatableBulk["model"]

/**
 * A book as returned by /api/book/list/.
 *
 * The exporters' `Book` type marks the fields below optional because a book
 * is also constructed client-side before it is saved. The list endpoint
 * always fills them in, so they are required here. (Redeclaring them is
 * preferable to `Omit<Book, …>`: `Book` carries an index signature, so
 * `Omit` would erase the declared property types.)
 */
export interface BookListEntry extends Book {
    id: number
    path: string
    added: number
    updated: number
    is_owner: boolean
    owner: {
        id: number
        name: string
        avatar: string | null
    }
}

/** A contact or pending invite a book can be shared with. */
export interface BookContact {
    id: number
    name: string
    username: string
    avatar: string | null
    type: "user" | "userinvite"
}

/** An access right as returned by /api/book/access_rights/get/. */
export interface BookAccessRight {
    book_id: number
    rights: string
    holder: BookContact
}

/** The /api/book/list/ payload that is cached in IndexedDB. */
export interface BookListPayload {
    books: BookListEntry[]
    documents: DocumentListEntry[]
    contacts: BookContact[]
    styles: BookStyles
    /** IndexedDB key, added by the overview before it stores the payload. */
    id?: number
}

/** Constructor options of the book overview page. */
export interface BookOverviewOptions {
    app: FrontendApp
    user: FrontendApp["user"]
}

/** The `mod.actions` bag the book dialogs are reached through. */
export interface BookOverviewActions {
    createBookDialog(id: number, imageDB: unknown): void
    deleteBookDialog(ids: number[], imageDB?: unknown): void
    copyBook(book: BookListEntry): void
    importBook(): void
}

/** The image database entries a book dialog renders from. */
export interface BookDialogImageDB {
    db: Record<number, {image?: string; [key: string]: unknown}>
}

/**
 * The bundle every book-dialog tab template receives. The dialog adds the
 * current user's cover image to the page's image DB before rendering, so this
 * is a plain record rather than an `ImageDB` instance.
 */
export interface BookDialogInfo {
    book: Book
    documentList: DocumentListEntry[]
    citationStyles: Array<{id: string; title?: string}>
    bookStyleList: BookStyle[]
    imageDB: BookDialogImageDB
}
