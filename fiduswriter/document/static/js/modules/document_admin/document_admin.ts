import {CSL} from "@fiduswriter/document/citeproc-plus"
import {Editor} from "@fiduswriter/editor"
import {createStaticApp} from "@fiduswriter/editor/static_app"
import type {EditorApp, EditorUser} from "@fiduswriter/editor/types"
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
 * The editor loads the document through the document connector (getDocumentData),
 * autosaves in "direct" mode through saveDocument, and on admin form submit the
 * current editor state is serialized back into the hidden content/bibliography/
 * comments textareas so the normal ModelForm save also persists it.
 */
export class DocumentEditorAdmin {
    connectors: DocumentAdminApiConnectors
    id: number
    editor: Editor | false
    app: EditorApp | false
    csl: CSL | false
    documentInfo: Record<string, unknown> | false
    objectTools: HTMLElement | false
    contentTextarea: HTMLTextAreaElement | false
    bibliographyTextarea: HTMLTextAreaElement | false
    commentsTextarea: HTMLTextAreaElement | false
    titleInput: HTMLInputElement | false
    titleBlock: HTMLElement | false
    contentBlock: HTMLElement | false
    bibliographyBlock: HTMLElement | false
    commentsBlock: HTMLElement | false
    editorBlock: HTMLElement | false

    constructor(connectors: DocumentAdminApiConnectors, docId?: number) {
        this.connectors = connectors
        this.editor = false
        this.app = false
        this.csl = false
        this.documentInfo = false
        this.titleBlock = false
        this.contentBlock = false
        this.bibliographyBlock = false
        this.commentsBlock = false
        this.editorBlock = false
        this.objectTools = false
        this.contentTextarea = false
        this.bibliographyTextarea = false
        this.commentsTextarea = false
        this.titleInput = false
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
        ;[
            this.titleBlock,
            this.contentBlock,
            this.bibliographyBlock,
            this.commentsBlock
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
        this.editorBlock = document.querySelector(
            "div.document-editor"
        ) as HTMLElement
    }

    async initEditor() {
        if (!this.id) {
            this.showErrors({error: gettext("No document id found.")})
            return
        }
        let json: Record<string, any> = {}
        try {
            const response = await this.connectors.document.getDocumentData({
                id: this.id
            })
            json = (response.json ?? response) as Record<string, any>
        } catch (error) {
            this.showErrors({
                error: gettext("Could not load the document.") as string
            })
            console.error(error)
            return
        }
        if (!json.content) {
            this.showErrors({
                error: gettext("Could not load the document.") as string
            })
            return
        }
        this.documentInfo = (json.doc_info ?? {}) as Record<string, unknown>

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
            saveMode: "direct",
            documentData: async () => ({
                doc: {
                    v: json.v,
                    content: json.content,
                    comments: json.comments ?? {},
                    bibliography: json.bibliography ?? {},
                    images: json.images ?? {}
                },
                doc_info: (this.documentInfo as Record<string, unknown>) || {},
                time: Date.now()
            }),
            initialImages: (json.images ?? {}) as Record<number, never> as any,
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

    setCurrentValue() {
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
        return true
    }

    showErrors(errors: Record<string, string>) {
        const list = (this.editorBlock as HTMLElement | null)?.querySelector(
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
                        if (!this.setCurrentValue()) {
                            event.preventDefault()
                        }
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
            this.commentsBlock
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
            this.commentsBlock
        ]
            .filter(Boolean)
            .forEach(block => ((block as HTMLElement).style.display = "none"))
        ;(this.editorBlock as HTMLElement).style.display = ""
        this.initEditor()
    }
}
