import {CSL} from "@fiduswriter/document/citeproc-plus"
import {Editor} from "@fiduswriter/editor"
import {createStaticApp} from "@fiduswriter/editor/static_app"
import type {EditorApp, EditorUser} from "@fiduswriter/editor/types"
import {recreateTransform} from "@fiduswriter/editor/collab/merge/recreate_transform"
import {
    ensureCSS,
    escapeText,
    findTarget,
    gettext,
    staticUrl,
    whenReady
} from "fwtoolkit"

import type {DocumentAdminApiConnectors} from "./types.ts"

/**
 * Embeds the full @fiduswriter/editor into the Django admin change form for
 * a Document, mirroring how DocumentTemplateAdmin embeds the template
 * designer.
 *
 * The editor loads the document through the document connector (getDocumentData).
 * It runs in "external" save mode, so no autosave happens inside the editor;
 * on admin form submit the current editor state is serialized back into the
 * hidden content/bibliography/comments/title/path form fields plus a bumped
 * version (and the pending diffs) so the normal ModelForm save persists it.
 *
 * Switching to source view also serializes the editor state into the fields,
 * and switching back restores the editor from those fields, so edits made on
 * either side survive the round trip.
 *
 * E2EE documents (and the add form, where no document exists yet) are shown
 * in source mode directly: the editor is never mounted and the form fields
 * stay visible.
 */
export class DocumentEditorAdmin {
    connectors: DocumentAdminApiConnectors
    id: number
    editor: Editor | false
    app: EditorApp | false
    csl: CSL | false
    documentInfo: Record<string, unknown> | false
    lastDoc: Record<string, any> | false
    // The document's diffs and version as they were when the page loaded.
    // The editor's pending changes are appended to the stored diffs on save so
    // the existing history (used for collaborative catch-up) is preserved.
    initialDiffs: unknown[]
    // The content JSON as loaded from the server — the base for computing the
    // net diff of this editing session.
    originalContent: Record<string, any> | false
    baseVersion: number
    objectTools: HTMLElement | false
    contentTextarea: HTMLTextAreaElement | false
    bibliographyTextarea: HTMLTextAreaElement | false
    commentsTextarea: HTMLTextAreaElement | false
    titleInput: HTMLInputElement | false
    pathInput: HTMLTextAreaElement | false
    versionInput: HTMLInputElement | false
    diffsInput: HTMLTextAreaElement | false
    titleBlock: HTMLElement | false
    contentBlock: HTMLElement | false
    bibliographyBlock: HTMLElement | false
    commentsBlock: HTMLElement | false
    pathBlock: HTMLElement | false
    versionBlock: HTMLElement | false
    diffsBlock: HTMLElement | false
    editorRow: HTMLElement | false
    editorBlock: HTMLElement | false

    constructor(connectors: DocumentAdminApiConnectors, docId?: number) {
        this.connectors = connectors
        this.editor = false
        this.app = false
        this.csl = false
        this.documentInfo = false
        this.lastDoc = false
        this.initialDiffs = []
        this.originalContent = false
        this.baseVersion = 0
        this.titleBlock = false
        this.contentBlock = false
        this.bibliographyBlock = false
        this.commentsBlock = false
        this.pathBlock = false
        this.versionBlock = false
        this.diffsBlock = false
        this.editorRow = false
        this.editorBlock = false
        this.objectTools = false
        this.contentTextarea = false
        this.bibliographyTextarea = false
        this.commentsTextarea = false
        this.titleInput = false
        this.pathInput = false
        this.versionInput = false
        this.diffsInput = false
        let id = docId ?? 0
        if (!id) {
            // /admin/document/document/<id>/change/
            const locationParts = window.location.href.split("/")
            id = Number.parseInt(locationParts[locationParts.length - 3])
            if (isNaN(id)) {
                id = 0
            }
        }
        this.id = id
    }

    init() {
        if (window.location.search.includes("debug=true")) {
            return
        }
        // The visual editor cannot edit E2EE documents in the admin (they are
        // stored encrypted), and there is no document to load on the add form.
        // In both cases show the source form directly.
        if ((window as any).documentAdminE2EE || !this.id) {
            return
        }
        // The editor's own init() loads the editor CSS; here we only need the
        // admin-specific container styles.
        ensureCSS([staticUrl("css/document_admin.css")])
        const csl = new CSL()
        const initialTasks: Array<Promise<unknown>> = [whenReady()]
        initialTasks.push(csl.getStyles().then(() => (this.csl = csl)))
        Promise.all(initialTasks).then(() => this.setup())
    }

    async setup() {
        this.objectTools = document.querySelector("ul.object-tools") || false
        if (!this.objectTools) {
            const mainContent = document.querySelector("#content-main")
            mainContent?.insertAdjacentHTML(
                "afterbegin",
                '<ul class="object-tools"></ul>'
            )
            this.objectTools =
                document.querySelector("ul.object-tools") || false
        }
        this.titleInput = document.querySelector(
            "#id_title"
        ) as HTMLInputElement
        this.contentTextarea = document.querySelector(
            "textarea[name=content]"
        ) as HTMLTextAreaElement
        this.bibliographyTextarea = document.querySelector(
            "textarea[name=bibliography]"
        ) as HTMLTextAreaElement
        this.commentsTextarea = document.querySelector(
            "textarea[name=comments]"
        ) as HTMLTextAreaElement
        this.pathInput = document.querySelector(
            "#id_path"
        ) as HTMLTextAreaElement
        this.versionInput = document.querySelector(
            "#id_version"
        ) as HTMLInputElement
        this.diffsInput = document.querySelector(
            "textarea[name=diffs]"
        ) as HTMLTextAreaElement
        // The diffs field already holds the document's stored diffs at this
        // point (rendered by the admin form) — remember them so saving from the
        // editor appends to them instead of replacing them.
        this.initialDiffs = this.parseDiffs(this.diffsInput?.value)
        this.modifyDOM()
        await this.initEditor()
        this.bind()
    }

    modifyDOM() {
        const findRow = (el: HTMLElement | false): HTMLElement | false => {
            return el ? (el.closest("div.form-row") as HTMLElement) : false
        }
        this.titleBlock = findRow(this.titleInput as HTMLElement)
        this.contentBlock = findRow(this.contentTextarea as HTMLElement)
        this.bibliographyBlock = findRow(
            this.bibliographyTextarea as HTMLElement
        )
        this.commentsBlock = findRow(this.commentsTextarea as HTMLElement)
        // path, version and diffs are managed by the editor/backend when the
        // editor is shown, so their form rows are hidden as well.
        this.pathBlock = findRow(this.pathInput as HTMLElement)
        this.versionBlock = findRow(this.versionInput as HTMLElement)
        this.diffsBlock = findRow(this.diffsInput as HTMLElement)
        ;[
            this.titleBlock,
            this.contentBlock,
            this.bibliographyBlock,
            this.commentsBlock,
            this.pathBlock,
            this.versionBlock,
            this.diffsBlock
        ]
            .filter(Boolean)
            .forEach(block => ((block as HTMLElement).style.display = "none"))
        ;(this.objectTools as HTMLElement).insertAdjacentHTML(
            "beforeend",
            `<li>
                <span class="link" id="toggle-document-editor">${gettext(
                    "Source/Editor"
                )}</span>
            </li>`
        )
        const anchor = this.contentBlock || this.titleBlock
        ;(anchor as HTMLElement).insertAdjacentHTML(
            "beforebegin",
            `<div class="form-row document-editor">
                <ul class="fw-errorlist"></ul>
                <div id="document-editor"></div>
            </div>`
        )
        this.editorRow = document.querySelector(
            "div.document-editor"
        ) as HTMLElement
        // The editor is mounted into the empty #document-editor container, not
        // the surrounding form-row (the error list lives in the form-row).
        this.editorBlock = document.querySelector(
            "#document-editor"
        ) as HTMLElement
    }

    async initEditor(useCurrentValues = false) {
        if (!this.id) {
            this.showErrors({error: gettext("No document id found.")})
            return
        }
        // The editor appends a new .editor div into #document-editor every
        // time it is mounted, so remove any previous instance before creating
        // a new one (this runs both on page load and when toggling back from
        // source view via restoreVisual()).
        if (this.editorBlock) {
            ;(this.editorBlock as HTMLElement).innerHTML = ""
        }
        this.editor = false

        // The editor loads the document through
        // app.apiConnectors.document.getDocumentData({id}). The Django
        // connector (passed via apiConnectors) normally fetches from the
        // server; when restoring from source view we override it with a
        // session-local implementation that returns the current form field
        // values so source edits survive the round trip.
        const connector = this.connectors.document as {
            getDocumentData: (
                data: {id: number}
            ) => Promise<{json: any; status: number}>
        }
        if (useCurrentValues) {
            let restoredDoc: Record<string, any>
            try {
                restoredDoc = {
                    ...(this.lastDoc ?? {}),
                    v: this.getCurrentVersion(),
                    content: JSON.parse(
                        this.contentTextarea?.value || "{}"
                    ),
                    comments: JSON.parse(
                        this.commentsTextarea?.value || "{}"
                    ),
                    bibliography: JSON.parse(
                        this.bibliographyTextarea?.value || "{}"
                    )
                }
            } catch (error) {
                this.showErrors({
                    error: gettext(
                        "Could not parse the document source."
                    ) as string
                })
                console.error(error)
                return
            }
            this.lastDoc = restoredDoc
            const docInfo =
                (this.documentInfo as Record<string, unknown>) || {}
            connector.getDocumentData = async () => ({
                json: {doc: restoredDoc, doc_info: docInfo, time: Date.now()},
                status: 200
            })
        } else {
            connector.getDocumentData =
                this.defaultGetDocumentData.bind(this)
        }

        let json: Record<string, any>
        try {
            const response = await connector.getDocumentData({id: this.id})
            json = (response.json ?? response) as Record<string, any>
        } catch (error) {
            this.showErrors({
                error: gettext("Could not load the document.") as string
            })
            console.error(error)
            return
        }
        // The API returns the document data nested under "doc" together with
        // "doc_info"; accept both that shape and a flat shape.
        const doc = (json.doc ?? json) as Record<string, any>
        if (!doc.content) {
            this.showErrors({
                error: gettext("Could not load the document.") as string
            })
            return
        }
        if (!useCurrentValues) {
            // Remember the server-side doc (images, etc.) so we can rebuild
            // the editor data when toggling back from source view, and keep
            // the load-time content/version as the base for the net diff.
            this.lastDoc = doc
            this.originalContent = doc.content
            this.baseVersion = Number(doc.v ?? 0)
            this.documentInfo = (json.doc_info ?? {}) as Record<string, unknown>
        }

        if (!this.csl) {
            return
        }

        const locale =
            ((window as any).settings?.LANGUAGE as string) ||
            (window.navigator.language || "en").slice(0, 2)

        this.app = await createStaticApp({
            locale,
            gettext: (window as any).gettext || ((msgid: string) => msgid),
            csl: this.csl,
            // The admin page must not autosave: nothing is persisted until one
            // of the Django admin save buttons is clicked (setCurrentValue()
            // copies the editor state into the hidden form fields on submit).
            saveMode: "external",
            initialImages: (doc.images ?? {}) as Record<number, never> as any,
            apiConnectors: {
                document: this.connectors.document,
                documentImport: this.connectors.documentImport,
                image: this.connectors.image,
                bibliography: this.connectors.bibliography,
                contacts: this.connectors.contacts
            }
        })

        const owner = (this.documentInfo as any)?.owner || {}
        const user = {
            id: owner.id,
            name: owner.name,
            username: owner.username,
            is_authenticated: true,
            contacts: [],
            emails: []
        } as unknown as EditorUser

        this.editor = new Editor(
            {app: this.app, user, mount: this.editorBlock as HTMLElement},
            String((this.documentInfo as any)?.path ?? ""),
            String(this.id)
        )
        try {
            await this.editor.init()
        } catch (error) {
            this.showErrors({
                error: gettext("Could not start the editor.") as string
            })
            console.error(error)
        }
    }

    /**
     * Copy the current editor state into the (hidden) form fields. When
     * *bumpVersion* is true (an actual form submit) the version field is
     * incremented, mirroring save_document / save_doc; when called from the
     * Source/Editor toggle the version is left unchanged.
     */
    setCurrentValue(bumpVersion = false) {
        if (!this.editor) {
            return false
        }
        const doc = this.editor.getDoc({use_current_view: true})
        if (this.contentTextarea) {
            this.contentTextarea.value = JSON.stringify(doc.content)
        }
        if (this.bibliographyTextarea) {
            this.bibliographyTextarea.value = JSON.stringify(
                this.editor.mod.db?.bibDB.db ?? {}
            )
        }
        if (this.commentsTextarea) {
            this.commentsTextarea.value = JSON.stringify(
                (this.editor.mod.comments as any)?.store?.comments ?? {}
            )
        }
        if (this.titleInput) {
            this.titleInput.value = doc.title ?? ""
        }
        if (this.pathInput) {
            this.pathInput.value = doc.path ?? ""
        }
        const diffsJson = this.getEditorDiffs()
        if (this.versionInput) {
            let newVersion = Number(doc.version ?? 0)
            if (bumpVersion) {
                // Versioning mirrors the collaborative flow: the version
                // increases by the number of *new* diffs appended (the stored
                // diffs already counted towards the version at load).
                const diffCount = (
                    JSON.parse(diffsJson) as unknown[]
                ).length
                newVersion =
                    this.baseVersion +
                    Math.max(0, diffCount - this.initialDiffs.length)
            }
            this.versionInput.value = String(newVersion)
        }
        if (this.diffsInput) {
            this.diffsInput.value = diffsJson
        }
        return true
    }

    /**
     * Serialize the diffs to store in the document's `diffs` field: the diffs
     * that were already stored when the document was loaded, plus the net
     * change of this editing session. The net change is computed between the
     * content as loaded from the server and the current view state (rather
     * than between the session's confirmed doc and the view), so it stays
     * correct across Source/Editor toggle round trips.
     */
    getEditorDiffs(): string {
        const editor = this.editor as any
        const newDiffs: Array<Record<string, unknown>> = []
        const originalDoc = this.originalContent
            ? editor?.schema?.nodeFromJSON(this.originalContent)
            : null
        const currentDoc = editor?.view?.state?.doc
        const commentUpdates =
            editor?.mod?.comments?.store?.unsentEvents?.() || []
        const bibliographyUpdates =
            editor?.mod?.db?.bibDB?.unsentEvents?.() || []
        const docChanged =
            originalDoc && currentDoc && !originalDoc.eq(currentDoc)
        if (docChanged || commentUpdates.length || bibliographyUpdates.length) {
            const diff: Record<string, unknown> = {
                type: "diff",
                v: this.baseVersion
            }
            if (docChanged) {
                const tr = recreateTransform(originalDoc, currentDoc) as any
                diff.ds = tr.steps.map((step: any) => step.toJSON())
            }
            if (commentUpdates.length) {
                diff.cu = commentUpdates
            }
            if (bibliographyUpdates.length) {
                diff.bu = bibliographyUpdates
            }
            newDiffs.push(diff)
        }
        // Keep the stored diffs that led up to the loaded version and append
        // the session's changes, capped at the same length the WebSocket
        // consumer keeps.
        return JSON.stringify(
            [...this.initialDiffs, ...newDiffs].slice(-1000)
        )
    }

    parseDiffs(value?: string): unknown[] {
        if (!value) {
            return []
        }
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : []
        } catch (_error) {
            return []
        }
    }

    getCurrentVersion(): number {
        const v = Number(this.versionInput?.value)
        if (!isNaN(v) && v >= 0) {
            return v
        }
        return Number((this.lastDoc as any)?.v ?? 0)
    }

    /**
     * The regular document loader: remove any per-session override installed
     * by initEditor(useCurrentValues = true) and fall back to the inherited
     * Django connector implementation (server fetch).
     */
    async defaultGetDocumentData(data: {id: number}): Promise<{
        json: any
        status: number
    }> {
        delete (this.connectors.document as any).getDocumentData
        return (this.connectors.document as any).getDocumentData(data)
    }

    /**
     * When saving from source view the version field is bumped by the number
     * of *new* diffs (the stored diffs already counted towards the version at
     * load), mirroring the collaborative flow where every diff increments the
     * version.
     */
    bumpVersionFromDiffs() {
        if (!this.diffsInput || !this.versionInput) {
            return
        }
        try {
            const diffs = this.parseDiffs(this.diffsInput.value)
            const newCount = Math.max(
                0,
                diffs.length - this.initialDiffs.length
            )
            this.versionInput.value = String(
                Number(this.versionInput.value ?? 0) + newCount
            )
        } catch (_error) {
            // Leave the version untouched if the diffs field is invalid.
        }
    }

    showErrors(errors: Record<string, string>) {
        const list = (this.editorRow as HTMLElement | null)?.querySelector(
            "ul.fw-errorlist"
        )
        if (list) {
            list.innerHTML = Object.values(errors)
                .map(error => `<li>${escapeText(error)}</li>`)
                .join("")
        }
    }

    bind() {
        document.body.addEventListener("click", event => {
            const el: {target?: HTMLElement} = {}
            switch (true) {
                case findTarget(event, "#toggle-document-editor", el):
                    event.preventDefault()
                    if (
                        this.editor &&
                        (this.editorBlock as HTMLElement).style.display ===
                            "none"
                    ) {
                        this.restoreVisual()
                    } else {
                        this.showSource()
                    }
                    break
                case findTarget(event, "div.submit-row input[type=submit]", el):
                    if (
                        this.editor &&
                        (this.editorBlock as HTMLElement).style.display !==
                            "none"
                    ) {
                        if (!this.setCurrentValue(true)) {
                            event.preventDefault()
                        }
                    } else if (
                        this.editor &&
                        (this.editorBlock as HTMLElement).style.display ===
                            "none"
                    ) {
                        // Saving from source view: keep the version consistent
                        // with the number of stored diffs.
                        this.bumpVersionFromDiffs()
                    }
                    break
                default:
                    break
            }
        })
    }

    showSource() {
        ;(this.editorBlock as HTMLElement).style.display = "none"
        ;[
            this.titleBlock,
            this.contentBlock,
            this.bibliographyBlock,
            this.commentsBlock,
            this.pathBlock,
            this.versionBlock,
            this.diffsBlock
        ]
            .filter(Boolean)
            .forEach(block => ((block as HTMLElement).style.display = ""))
        this.setCurrentValue()
        if (this.editor) {
            this.editor.close()
        }
    }

    restoreVisual() {
        ;[
            this.titleBlock,
            this.contentBlock,
            this.bibliographyBlock,
            this.commentsBlock,
            this.pathBlock,
            this.versionBlock,
            this.diffsBlock
        ]
            .filter(Boolean)
            .forEach(block => ((block as HTMLElement).style.display = "none"))
        ;(this.editorBlock as HTMLElement).style.display = ""
        this.initEditor(true)
    }
}
