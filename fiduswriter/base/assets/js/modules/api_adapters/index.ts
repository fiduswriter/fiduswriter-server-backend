import type {BibliographyApi} from "@fiduswriter/bibliography-manager"
import type {
    BibDBEntry,
    SaveCategoriesRequest as BibSaveCategoriesRequest,
    SaveCategoriesResponse as BibSaveCategoriesResponse,
    BiblistResponse,
    SaveBibEntriesResponse
} from "@fiduswriter/bibliography-manager/types/biblio"
import type {DocumentTemplateApi} from "@fiduswriter/document-template-editor"
import type {
    ImportedTemplate,
    SaveDocumentStyleResponse,
    SaveExportTemplateResponse,
    TemplateExportResponse,
    TemplateExtras
} from "@fiduswriter/document-template-editor/types"
import type {
    ApiConnectors,
    AuthApi,
    ConfigApi,
    ContactsApi,
    ContactsInviteResponse,
    ContactsListResponse,
    DocumentApi,
    DocumentImportApi,
    ErrorHookApi,
    FeedbackApi,
    FlatPageApi,
    MaintenanceApi,
    OldDocsResponse,
    RevisionApi,
    RevisionIdsResponse,
    SystemMessageApi,
    TemplateBaseResponse,
    TemplateIdsResponse,
    TwoFactorSetupResponse,
    TwoFactorStatusResponse,
    TwoFactorVerifyResponse,
    UserBibListResponse,
    UserProfileApi
} from "@fiduswriter/frontend/api"
import type {
    ImageApi,
    SaveCategoriesRequest as ImageSaveCategoriesRequest,
    SaveCategoriesResponse as ImageSaveCategoriesResponse,
    ImagesResponse,
    SaveImageRequest,
    SaveImageResponse
} from "@fiduswriter/image-manager/types"
/*
 * Django implementations of the API connector interfaces that the Fidus
 * Writer frontend packages consume (@fiduswriter/frontend/api and friends).
 *
 * Each class implements one of those interfaces, so a mismatch between what
 * the backend adapters return and what the frontend packages expect is
 * caught by `npx tsc --project tsconfig.json`.
 *
 * The backend answers with arbitrary JSON payloads; wherever an interface
 * promises a more specific shape, the payload is asserted at this boundary.
 */
import {get, getJson, post, postBare, postJson} from "fwtoolkit"
import type {PostFiles} from "fwtoolkit/network"

/** Asserts that a JSON response body is an object. */
const asRecord = (value: unknown): Record<string, unknown> =>
    value as Record<string, unknown>

// ---- DocumentApi ----
export class DjangoDocumentApi implements DocumentApi {
    getDocumentList(): Promise<Record<string, unknown>> {
        return postJson("/api/document/documentlist/").then(({json}) =>
            asRecord(json)
        )
    }

    getDocumentListExtra(ids: number[]): Promise<Record<string, unknown>> {
        return postJson("/api/document/documentlist/extra/", {ids}).then(
            ({json}) => asRecord(json)
        )
    }

    deleteDocument(data: {
        id?: number
        ids?: number[]
    }): Promise<Record<string, unknown>> {
        return postJson("/api/document/delete/", data).then(({json}) =>
            asRecord(json)
        )
    }

    moveDocument(data: {
        id: number
        path: string
    }): Promise<Record<string, unknown>> {
        return postJson("/api/document/move/", data).then(({json}) =>
            asRecord(json)
        )
    }

    getEncryptionKeys(): Promise<Record<string, unknown>> {
        return postJson("/api/document/encryption_key/get_all/", {}).then(
            ({json}) => asRecord(json)
        )
    }

    createDocument(data: Record<string, unknown>) {
        return postJson("/api/document/create_doc/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    getWebSocketBase(data: {id: number; token?: string}) {
        return postJson("/api/document/get_ws_base/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    getDocumentStyles(data: {id: number; token?: string}) {
        return postJson("/api/document/get_doc_styles/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    getDocumentData(data: {id: number; token?: string; v?: number}) {
        return postJson("/api/document/get_doc_data/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    saveDocument(
        data: Record<string, unknown>,
        options: {keepalive?: boolean} = {}
    ) {
        return postJson("/api/document/save/", data, {}, options).then(
            ({json, status}) => ({json, status})
        )
    }

    commentNotify(data: Record<string, unknown>) {
        return post("/api/document/comment_notify/", data)
    }

    requestAccess(data: {document_id: number; rights: string}) {
        return postJson("/api/document/request_access/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    validateShareToken(token: string) {
        return postJson(`/api/document/share_token/validate/${token}/`).then(
            ({json, status}) => ({json, status})
        )
    }

    listShareTokens(document_id: number) {
        return postJson("/api/document/share_token/list/", {document_id}).then(
            ({json, status}) => ({json, status})
        )
    }

    createShareToken(data: Record<string, unknown>) {
        return postJson("/api/document/share_token/create/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    revokeShareToken(token_id: number) {
        return postJson("/api/document/share_token/revoke/", {token_id}).then(
            ({json, status}) => ({json, status})
        )
    }

    getAccessRights(data: {document_ids: number[]}) {
        return postJson("/api/document/get_access_rights/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    saveAccessRights(data: {
        document_ids: number[]
        access_rights: unknown[]
    }) {
        return post("/api/document/save_access_rights/", data)
    }

    saveE2EEImage(data: Record<string, unknown>, files?: PostFiles) {
        return postJson("/api/document/e2ee_image/", data, files).then(
            ({json, status}) => ({json, status})
        )
    }

    deleteE2EEImage(data: {doc_id: number; image_id: number}) {
        return post("/api/document/delete_e2ee_image/", data)
    }

    uploadRevision(
        data: {note: string; document_id: number},
        files: PostFiles
    ) {
        return post("/api/document/upload/", data, files)
    }

    getTemplateForDoc(id: number | string, token: string | false) {
        return postJson(
            "/api/document/get_template_for_doc/",
            token ? {id, token} : {id}
        ).then(({json, status}) => ({json, status}))
    }
}

// ---- ImageApi ----
export class DjangoImageApi implements ImageApi {
    getImages(): Promise<ImagesResponse> {
        return postJson("/api/usermedia/images/").then(
            ({json}) => json as ImagesResponse
        )
    }

    saveImage(
        data: SaveImageRequest,
        files?: PostFiles
    ): Promise<SaveImageResponse> {
        return postJson("/api/usermedia/save/", data, files).then(
            ({json}) => json as SaveImageResponse
        )
    }

    saveCategories(
        cats: ImageSaveCategoriesRequest
    ): Promise<ImageSaveCategoriesResponse> {
        return postJson("/api/usermedia/save_category/", {...cats}).then(
            ({json}) => json as ImageSaveCategoriesResponse
        )
    }

    deleteImages(ids: number[]) {
        return post("/api/usermedia/delete/", {ids})
    }
}

// ---- BibliographyApi ----
export class DjangoBibliographyApi implements BibliographyApi {
    getDB(
        lastModified: number,
        numberOfEntries: number,
        localStorageOwnerId: number
    ): Promise<BiblistResponse> {
        return postJson("/api/bibliography/biblist/", {
            last_modified: lastModified,
            number_of_entries: numberOfEntries,
            user_id: localStorageOwnerId
        }).then(({json}) => json as BiblistResponse)
    }

    saveBibEntries(
        tmpDB: Record<number, BibDBEntry>,
        isNew: boolean
    ): Promise<SaveBibEntriesResponse> {
        return postJson("/api/bibliography/save/", {
            is_new: isNew,
            bibs: tmpDB
        }).then(({json}) => json as SaveBibEntriesResponse)
    }

    saveCategories(
        cats: BibSaveCategoriesRequest
    ): Promise<BibSaveCategoriesResponse> {
        return postJson("/api/bibliography/save_category/", {...cats}).then(
            ({json}) => json as BibSaveCategoriesResponse
        )
    }

    deleteCategory(ids: number[]) {
        return post("/api/bibliography/delete_category/", {ids})
    }

    deleteBibEntries(ids: number[]) {
        return post("/api/bibliography/delete/", {ids})
    }
}

// ---- DocumentImportApi ----
export class DjangoDocumentImportApi implements DocumentImportApi {
    createDoc(data: Record<string, unknown>, files?: PostFiles) {
        return postJson("/api/document/import/create/", data, files).then(
            ({json, status}) => ({json, status})
        )
    }

    saveImage(data: Record<string, unknown>, files: PostFiles) {
        return postJson("/api/document/import/image/", data, files).then(
            ({json, status}) => ({json, status})
        )
    }

    saveE2EEImage(data: Record<string, unknown>, files: PostFiles) {
        return postJson("/api/document/e2ee_image/", data, files).then(
            ({json, status}) => ({json, status})
        )
    }

    saveDocument(data: Record<string, unknown>) {
        return postJson("/api/document/import/", data).then(
            ({json, status}) => ({json, status})
        )
    }

    getTemplate(importId: string): Promise<Record<string, unknown>> {
        return postJson("/api/document/get_template/", {
            import_id: importId
        }).then(({json}) => asRecord(json))
    }
}

// ---- UserProfileApi ----
export class DjangoUserProfileApi implements UserProfileApi {
    save(data: Record<string, unknown>) {
        return post("/api/user/save/", data)
    }

    updatePreferences(data: Record<string, unknown>) {
        return post("/api/user/preferences/update/", data)
    }

    avatarUpload(files: PostFiles) {
        return post("/api/user/avatar/upload/", {}, files)
    }

    avatarDelete() {
        return post("/api/user/avatar/delete/", {})
    }

    passwordChange(data: Record<string, unknown>) {
        // Deliberately postBare: HTTP error statuses are part of the normal
        // result here (wrong password, etc.).
        return postBare("/api/user/passwordchange/", data).then(response =>
            response.json().then(json => ({
                json: asRecord(json),
                status: response.status
            }))
        )
    }

    emailAdd(data: Record<string, unknown>) {
        return postBare("/api/user/email/add/", data).then(response =>
            response.json().then(json => ({
                json: asRecord(json),
                status: response.status
            }))
        )
    }

    emailDelete(data: Record<string, unknown>) {
        return post("/api/user/email/delete/", data)
    }

    emailPrimary(data: Record<string, unknown>) {
        return post("/api/user/email/primary/", data)
    }

    deleteUser(data: Record<string, unknown>) {
        return postBare("/api/user/delete/", data)
    }

    getSocialAccounts() {
        return getJson("/api/user/social/accounts/")
    }

    deleteSocialAccount(data: Record<string, unknown>) {
        return post("/api/user/social/delete/", data)
    }

    getConfirmKeyData(data: Record<string, unknown>) {
        // Returns the raw response body (username/email/verified/logout),
        // which is what @fiduswriter/frontend's EmailConfirm page consumes.
        // The published UserProfileApi interface up to 0.1.54 mis-declares
        // this as Promise<{json: ...}>; the interface was corrected in the
        // frontend repository (ConfirmKeyDataResponse). Once a fixed
        // frontend version is required here, simplify to
        // `.then(({json}) => json as ConfirmKeyDataResponse)`.
        return postJson("/api/user/get_confirmkey_data/", data).then(
            ({json}) => json as unknown as {json: Record<string, unknown>}
        )
    }

    confirmEmail(key: string) {
        return post(`/api/user/confirm-email/${key}/`)
    }
}

// ---- AuthApi ----
export class DjangoAuthApi implements AuthApi {
    login(data: Record<string, unknown>) {
        return postJson("/api/user/login/", data).then(({json, status}) => {
            const payload = asRecord(json)
            let requiresEmailConfirmation = false
            if (typeof payload.html === "string") {
                try {
                    const htmlValues = JSON.parse(payload.html) as {
                        Location?: string
                    }
                    if (htmlValues.Location === "/api/account/confirm-email/") {
                        requiresEmailConfirmation = true
                    }
                } catch {
                    // ignore malformed html payload
                }
            }
            return {json: payload, status, requiresEmailConfirmation}
        })
    }

    signup(data: Record<string, unknown>) {
        return postJson("/api/user/signup/", data).then(({json}) => {
            const payload = asRecord(json)
            return {
                json: payload,
                requiresEmailConfirmation:
                    payload.location === "/api/account/confirm-email/"
            }
        })
    }

    passwordReset(data: {email: string}) {
        return post("/api/user/password/reset/", data)
    }

    passwordResetKeyGet(key: string) {
        return get(`/api/account/password/reset/key/${key}/`).then(
            response => ({
                url: response.url
            })
        )
    }

    passwordResetKeyPost(url: string, data: Record<string, unknown>) {
        return post(url, data)
    }

    logout() {
        return post("/api/user/logout/")
    }

    twoFactorSetup(): Promise<TwoFactorSetupResponse> {
        return postJson("/api/user/two-factor/setup/").then(
            ({json}) => json as TwoFactorSetupResponse
        )
    }

    twoFactorVerify(
        data: Record<string, unknown>
    ): Promise<TwoFactorVerifyResponse> {
        return postJson("/api/user/two-factor/verify/", data).then(
            ({json}) => json as TwoFactorVerifyResponse
        )
    }

    twoFactorLogin(
        data: Record<string, unknown>
    ): Promise<TwoFactorVerifyResponse> {
        return postJson("/api/user/login/", data).then(
            ({json}) => json as TwoFactorVerifyResponse
        )
    }

    twoFactorDisable(): Promise<TwoFactorVerifyResponse> {
        return postJson("/api/user/two-factor/disable/").then(
            ({json}) => json as TwoFactorVerifyResponse
        )
    }

    twoFactorStatus(): Promise<TwoFactorStatusResponse> {
        return postJson("/api/user/two-factor/status/").then(
            ({json}) => json as TwoFactorStatusResponse
        )
    }
}

// ---- ContactsApi ----
export class DjangoContactsApi implements ContactsApi {
    list(): Promise<ContactsListResponse> {
        return postJson("/api/user/contacts/list/").then(
            ({json}) => json as ContactsListResponse
        )
    }

    delete(data: Record<string, unknown>) {
        // Deliberately postBare: the status code carries the result.
        return postBare("/api/user/contacts/delete/", data).then(response => ({
            status: response.status
        }))
    }

    add(data: {user_string: string}) {
        return postBare("/api/user/invites/add/", data).then(response =>
            response.json().then(json => ({
                json: asRecord(json),
                status: response.status
            }))
        )
    }

    accept(data: Record<string, unknown>) {
        return postBare("/api/user/invites/accept/", data).then(response =>
            response.json().then(json => ({
                json: asRecord(json),
                status: response.status
            }))
        )
    }

    decline(data: Record<string, unknown>) {
        return postBare("/api/user/invites/decline/", data).then(response => ({
            status: response.status
        }))
    }

    invite(data: {key: string}): Promise<ContactsInviteResponse> {
        return postJson("/api/user/invite/", data).then(
            ({json}) => json as ContactsInviteResponse
        )
    }
}

// ---- DocumentTemplateApi ----
export class DjangoDocumentTemplateApi implements DocumentTemplateApi {
    list(): Promise<Record<string, unknown>> {
        return getJson("/api/user_template_manager/list/") as Promise<
            Record<string, unknown>
        >
    }

    get(data: {id: number; token?: string}): Promise<Record<string, unknown>> {
        return postJson(
            "/api/user_template_manager/get/",
            data.token ? data : {id: data.id}
        ).then(({json}) => asRecord(json))
    }

    save(data: Record<string, unknown>) {
        return post("/api/user_template_manager/save/", data)
    }

    delete(data: {id: number}): Promise<Record<string, unknown>> {
        return postJson("/api/user_template_manager/delete/", data).then(
            ({json}) => asRecord(json)
        )
    }

    create(data: Record<string, unknown>, files?: PostFiles) {
        return post("/api/user_template_manager/create/", data, files)
    }

    copy(data: {
        id: number
        title: string
    }): Promise<Record<string, unknown>> {
        return postJson("/api/user_template_manager/copy/", data).then(
            ({json}) => asRecord(json)
        )
    }

    getTemplate(id: number, token?: string): Promise<TemplateExportResponse> {
        return postJson(
            "/api/user_template_manager/get/",
            token ? {id, token} : {id}
        ).then(({json}) => json as TemplateExportResponse)
    }

    createTemplate(
        data: Record<string, unknown>,
        files?: PostFiles
    ): Promise<ImportedTemplate> {
        return postJson("/api/user_template_manager/create/", data, files).then(
            ({json}) => json as ImportedTemplate
        )
    }

    saveExportTemplate(
        data: Record<string, unknown>,
        files?: PostFiles
    ): Promise<SaveExportTemplateResponse> {
        return postJson("/api/style/save_export_template/", data, files).then(
            ({json}) => json as SaveExportTemplateResponse
        )
    }

    deleteExportTemplate(id: number): Promise<Record<string, unknown>> {
        return postJson("/api/style/delete_export_template/", {id}).then(
            ({json}) => asRecord(json)
        )
    }

    saveDocumentStyle(
        data: Record<string, unknown>,
        files?: PostFiles
    ): Promise<SaveDocumentStyleResponse> {
        return postJson("/api/style/save_document_style/", data, files).then(
            ({json}) => json as SaveDocumentStyleResponse
        )
    }

    deleteDocumentStyle(id: number): Promise<Record<string, unknown>> {
        return postJson("/api/style/delete_document_style/", {id}).then(
            ({json}) => asRecord(json)
        )
    }

    importDocumentStyle(
        data: Record<string, unknown>,
        files?: PostFiles
    ): Promise<Record<string, unknown>> {
        return postJson("/api/style/import_document_style/", data, files).then(
            ({json}) => asRecord(json)
        )
    }

    getTemplateExtras(data: {id: number}): Promise<TemplateExtras> {
        return postJson("/api/document/admin/get_template/extras/", data).then(
            ({json}) => json as TemplateExtras
        )
    }
}

// ---- FlatPageApi ----
export class DjangoFlatPageApi implements FlatPageApi {
    get(key: string): Promise<Record<string, unknown>> {
        return postJson("/api/base/flatpage/", {url: key}).then(({json}) =>
            asRecord(json)
        )
    }
}

// ---- SystemMessageApi ----
export class DjangoSystemMessageApi implements SystemMessageApi {
    get(): Promise<Record<string, unknown>> {
        return getJson("/api/base/connection_info/") as Promise<
            Record<string, unknown>
        >
    }

    send(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        return postJson("/api/base/send_system_message/", data).then(({json}) =>
            asRecord(json)
        )
    }
}

// ---- ErrorHookApi ----
export class DjangoErrorHookApi implements ErrorHookApi {
    send(data: {context?: string; details: string}) {
        const body = new FormData()
        body.append("context", data.context || navigator.userAgent)
        body.append("details", data.details)
        return fetch("/api/django_js_error_hook/", {
            method: "POST",
            headers: {
                "X-CSRFToken": window.settings.getCsrfToken()
            },
            credentials: "include",
            body
        })
    }
}

// ---- FeedbackApi ----
export class DjangoFeedbackApi implements FeedbackApi {
    send(data: {message: string}) {
        return post("/api/feedback/feedback/", data)
    }
}

// ---- ConfigApi ----
export class DjangoConfigApi implements ConfigApi {
    getConfiguration(): Promise<Record<string, unknown>> {
        return getJson("/api/base/configuration/") as Promise<
            Record<string, unknown>
        >
    }
}

// ---- MaintenanceApi ----
export class DjangoMaintenanceApi implements MaintenanceApi {
    getAllOldDocs(): Promise<OldDocsResponse> {
        return postJson("/api/document/admin/get_all_old/").then(
            ({json}) => json as OldDocsResponse
        )
    }

    getUserBibList(data: {user_id: number}): Promise<UserBibListResponse> {
        return postJson("/api/document/admin/get_user_biblist/", data).then(
            ({json}) => json as UserBibListResponse
        )
    }

    saveDoc(data: Record<string, unknown>) {
        return post("/api/document/admin/save_doc/", data)
    }

    addImagesToDoc(data: Record<string, unknown>) {
        return post("/api/document/admin/add_images_to_doc/", data)
    }

    getAllTemplateIds(): Promise<TemplateIdsResponse> {
        return postJson("/api/document/admin/get_all_template_ids/").then(
            ({json}) => json as TemplateIdsResponse
        )
    }

    getTemplateBase(data: {id: number}): Promise<TemplateBaseResponse> {
        return postJson("/api/document/admin/get_template/base/", data).then(
            ({json}) => json as TemplateBaseResponse
        )
    }

    saveTemplate(data: Record<string, unknown>) {
        return post("/api/document/admin/save_template/", data)
    }

    getAllRevisionIds(): Promise<RevisionIdsResponse> {
        return postJson("/api/document/admin/get_all_revision_ids/").then(
            ({json}) => json as RevisionIdsResponse
        )
    }

    getRevision(id: number) {
        return get(`/api/document/get_revision/${id}/`)
    }

    updateRevision(id: number, blob: Blob) {
        return post(
            "/api/document/admin/update_revision/",
            {id},
            {
                file: {
                    file: blob,
                    filename: "some_file.fidus"
                }
            }
        )
    }
}

// ---- RevisionApi ----
export class DjangoRevisionApi implements RevisionApi {
    getRevisionBlob(id: number): Promise<Blob> {
        return get(`/api/document/get_revision/${id}/`).then(response =>
            response.blob()
        )
    }

    deleteRevision(data: {id: number}) {
        return post("/api/document/delete_revision/", data)
    }
}

// ---- Bundled connectors ----
export const djangoApiConnectors: ApiConnectors = {
    document: new DjangoDocumentApi(),
    documentImport: new DjangoDocumentImportApi(),
    userProfile: new DjangoUserProfileApi(),
    auth: new DjangoAuthApi(),
    contacts: new DjangoContactsApi(),
    documentTemplate: new DjangoDocumentTemplateApi(),
    flatPage: new DjangoFlatPageApi(),
    systemMessage: new DjangoSystemMessageApi(),
    errorHook: new DjangoErrorHookApi(),
    feedback: new DjangoFeedbackApi(),
    config: new DjangoConfigApi(),
    maintenance: new DjangoMaintenanceApi(),
    revision: new DjangoRevisionApi(),
    bibliography: new DjangoBibliographyApi(),
    image: new DjangoImageApi()
}
