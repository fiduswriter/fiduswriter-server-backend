import {postJson} from "fwtoolkit"
import {initSettings} from "fwtoolkit/settings"
import {DocumentEditorAdmin} from "./modules/document_admin/document_admin.ts"

import {djangoApiConnectors} from "../../base/static/js/modules/api_adapters/index.js"

window.settings.gettext = window.gettext
window.settings.staticUrl = window.staticUrl
window.settings.interpolate = window.interpolate
initSettings(window.settings)

// Document saves go through the staff-only admin endpoint so that admins can
// edit any document regardless of ownership. Use Object.create so the
// connector's prototype methods (getDocumentData etc.) are inherited — a
// spread only copies own enumerable properties.
const adminDocumentApi = Object.create(djangoApiConnectors.document)
adminDocumentApi.saveDocument = data =>
    postJson("/api/document/admin/save_doc/", data).then(
        ({json, status}) => ({json, status})
    )

const theDocumentAdmin = new DocumentEditorAdmin({
    document: adminDocumentApi,
    documentImport: djangoApiConnectors.documentImport,
    image: djangoApiConnectors.image,
    bibliography: djangoApiConnectors.bibliography,
    contacts: djangoApiConnectors.contacts
})

theDocumentAdmin.init()

window.theDocumentAdmin = theDocumentAdmin
