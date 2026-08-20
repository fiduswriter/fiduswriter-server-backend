import type {
    EditorContactsApi,
    EditorDocumentApi,
    EditorDocumentImportApi
} from "@fiduswriter/editor"
import type {BibliographyApi} from "@fiduswriter/bibliography-manager"
import type {ImageApi} from "@fiduswriter/image-manager"

/**
 * API connectors the admin document editor needs. In the Django app these are
 * the `djangoApiConnectors` from
 * `base/static/js/modules/api_adapters/index.js`, with `document.saveDocument`
 * typically overridden to use the staff-only admin save endpoint.
 */
export interface DocumentAdminApiConnectors {
    document: EditorDocumentApi
    documentImport: EditorDocumentImportApi
    image: ImageApi
    bibliography: BibliographyApi
    contacts: EditorContactsApi
}
