import {AddContactDialog} from "@fiduswriter/frontend/user/contacts/add_dialog"
import {
    ContentMenu,
    Dialog,
    addAlert,
    findTarget,
    getSettings,
    postJson,
    setCheckableLabel
} from "fwtoolkit"
import type {DialogButtonSpec} from "fwtoolkit"
import type {Settings} from "fwtoolkit/settings"
import type {
    BookAccessRight,
    BookContact,
    ContentMenuInit,
    FrontendApp
} from "../types"
import {
    bookAccessRightOverviewTemplate,
    bookCollaboratorsTemplate,
    bookContactsTemplate
} from "./templates"
/**
 * Helper functions to deal with the book access rights dialog.
 */

/** A collaborator row as passed to the access-right templates. */
type CollaboratorRow = BookAccessRight & {count?: number}

/** A pending access right as collected from the dialog's DOM. */
interface NewAccessRight {
    holder: {
        id: number
        type: string
        name?: string
        avatar?: string | null
    }
    rights: string
}

export class BookAccessRightsDialog {
    bookIds: number[]
    contacts: BookContact[]
    newContactCall: (contact: BookContact) => void
    settings: Settings
    accessRights: BookAccessRight[] = []
    dialog!: Dialog
    /** The frontend config, used to reach the contacts API connector. */
    app: FrontendApp

    constructor(
        bookIds: number[],
        contacts: BookContact[],
        newContactCall: (contact: BookContact) => void,
        app: FrontendApp
    ) {
        this.bookIds = bookIds
        this.contacts = contacts
        this.newContactCall = newContactCall // a function to be called when a new contact has been added with contact details
        this.app = app
        this.settings = getSettings()
    }

    init(): Promise<void> {
        return postJson("/api/book/access_rights/get/", {
            book_ids: this.bookIds
        })
            .catch((error: unknown) => {
                addAlert("error", gettext("Cannot load book access data."))
                throw error
            })
            .then(({json}) => {
                this.accessRights = (
                    json as {access_rights: BookAccessRight[]}
                ).access_rights
                this.createAccessRightsDialog()
            })
    }

    createAccessRightsDialog(): void {
        const bookCollabs: Record<string, CollaboratorRow> = {}
        this.accessRights.forEach(ar => {
            if (!this.bookIds.includes(ar.book_id)) {
                return
            }
            const holderIdent = ar.holder.type + ar.holder.id
            if (bookCollabs[holderIdent]) {
                if (bookCollabs[holderIdent].rights != ar.rights) {
                    // We use read rights if the user has different rights on different docs.
                    bookCollabs[holderIdent].rights = "read"
                }
                bookCollabs[holderIdent].count! += 1
            } else {
                bookCollabs[holderIdent] = Object.assign({}, ar, {count: 1})
            }
        })

        const collaborators = Object.values(bookCollabs).filter(
            col => col.count === this.bookIds.length
        )

        const buttons: DialogButtonSpec[] = [
            {
                text:
                    this.settings.REGISTRATION_OPEN ||
                    this.settings.SOCIALACCOUNT_OPEN
                        ? gettext("Add contact or invite new user")
                        : gettext("Add contact"),
                classes: "fw-light fw-add-button",
                click: () => {
                    const dialog = new AddContactDialog(
                        this.app.settings,
                        this.app.apiConnectors.contacts
                    )
                    dialog.init().then(contactsData => {
                        contactsData.forEach(contactData => {
                            const contact =
                                contactData as unknown as BookContact
                            if (contact.id) {
                                document
                                    .querySelector(
                                        "#my-contacts .fw-data-table-body"
                                    )!
                                    .insertAdjacentHTML(
                                        "beforeend",
                                        bookContactsTemplate({
                                            contacts: [contact]
                                        })
                                    )
                                document
                                    .querySelector(
                                        "#share-contact table tbody"
                                    )!
                                    .insertAdjacentHTML(
                                        "beforeend",
                                        bookCollaboratorsTemplate({
                                            collaborators: [
                                                {
                                                    book_id: 0,
                                                    holder: contact,
                                                    rights: "read"
                                                }
                                            ]
                                        })
                                    )
                                this.newContactCall(contact)
                            } else {
                                document
                                    .querySelector(
                                        "#share-contact table tbody"
                                    )!
                                    .insertAdjacentHTML(
                                        "beforeend",
                                        bookCollaboratorsTemplate({
                                            collaborators: [
                                                {
                                                    book_id: 0,
                                                    holder: contact,
                                                    rights: "read"
                                                }
                                            ]
                                        })
                                    )
                            }
                        })
                    })
                }
            },
            {
                text: gettext("Submit"),
                classes: "fw-dark",
                click: () => {
                    const accessRights: NewAccessRight[] = []
                    document
                        .querySelectorAll<HTMLElement>(
                            "#share-contact .fw-collaborator-tr"
                        )
                        .forEach(el => {
                            accessRights.push({
                                holder: {
                                    id: Number.parseInt(
                                        el.dataset.id as string
                                    ),
                                    type: el.dataset.type as string
                                },
                                rights: el.dataset.rights as string
                            })
                        })
                    this.submitAccessRight(accessRights)
                    this.dialog.close()
                }
            },
            {
                type: "close",
                click: () => {
                    this.dialog.close()
                }
            }
        ]

        this.dialog = new Dialog({
            width: 820,
            height: 400,
            id: "access-rights-dialog",
            title: gettext("Share your book with others"),
            body: bookAccessRightOverviewTemplate({
                contacts: this.contacts,
                collaborators
            }),
            buttons
        })
        this.dialog.open()

        this.dialog.dialogEl
            .querySelector<HTMLElement>("#add-share-contact")!
            .addEventListener("click", () => {
                const selectedData: CollaboratorRow[] = []
                document
                    .querySelectorAll<HTMLElement>(
                        "#my-contacts .fw-checkable.fw-checked"
                    )
                    .forEach(el => {
                        const collaboratorEl = document.getElementById(
                            `collaborator-${el.dataset.type}-${el.dataset.id}`
                        )
                        if (collaboratorEl) {
                            if (collaboratorEl.dataset.rights === "delete") {
                                collaboratorEl.dataset.rights = "read"
                                const accessRightIcon =
                                    collaboratorEl.querySelector(
                                        ".fw-icon-access-right"
                                    )!
                                accessRightIcon.classList.remove(
                                    "icon-access-delete"
                                )
                                accessRightIcon.classList.add(
                                    "icon-access-read"
                                )
                            }
                        } else {
                            const collaborator = this.contacts.find(
                                contact =>
                                    contact.type === el.dataset.type &&
                                    contact.id ===
                                        Number.parseInt(el.dataset.id as string)
                            )
                            if (!collaborator) {
                                console.warn(
                                    `No contact found of type: ${el.dataset.type} id: ${el.dataset.id}.`
                                )
                                return
                            }
                            selectedData.push({
                                book_id: 0,
                                holder: {
                                    id: collaborator.id,
                                    type: collaborator.type,
                                    name: collaborator.name,
                                    username: collaborator.username,
                                    avatar: collaborator.avatar
                                },
                                rights: "read"
                            })
                        }
                    })

                document
                    .querySelectorAll(
                        "#my-contacts .checkable-label.fw-checked"
                    )
                    .forEach(el => el.classList.remove("fw-checked"))
                document
                    .querySelector("#share-contact table tbody")!
                    .insertAdjacentHTML(
                        "beforeend",
                        bookCollaboratorsTemplate({
                            collaborators: selectedData
                        })
                    )
            })

        this.dialog.dialogEl.addEventListener("click", event => {
            const el: {target?: HTMLElement} = {}
            switch (true) {
                case findTarget(event, ".fw-checkable", el):
                    setCheckableLabel(el.target!)
                    break
                case findTarget(event, ".edit-right", el): {
                    const colRow = el.target!.closest<HTMLElement>(
                        ".fw-collaborator-tr,.invite-tr"
                    )!
                    const currentRight = colRow.dataset.rights as string
                    const menu = this.getDropdownMenu(
                        currentRight,
                        (newRight: string) => {
                            colRow.dataset.rights = newRight
                            colRow
                                .querySelector(".fw-icon-access-right")!
                                .setAttribute(
                                    "class",
                                    `fw-icon-access-right icon-access-${newRight}`
                                )
                        }
                    )
                    const contentMenu = new ContentMenu({
                        menu,
                        menuPos: {X: event.pageX, Y: event.pageY},
                        width: 200
                    })
                    contentMenu.open()
                    break
                }
                case findTarget(event, ".delete-collaborator", el): {
                    const colRow = el.target!.closest<HTMLElement>(
                        ".fw-collaborator-tr"
                    )!
                    colRow.dataset.right = "delete"
                    colRow
                        .querySelector(".fw-icon-access-right")!
                        .setAttribute(
                            "class",
                            "fw-icon-access-right icon-access-delete"
                        )
                    break
                }
                default:
                    break
            }
        })
    }

    getDropdownMenu(
        currentRight: string,
        onChange: (right: string) => void
    ): ContentMenuInit {
        return {
            content: [
                {
                    type: "action",
                    title: gettext("Write"),
                    icon: "pencil-alt",
                    tooltip: gettext("Write"),
                    action: () => {
                        onChange("write")
                    },
                    selected: currentRight === "write"
                },
                {
                    type: "action",
                    title: gettext("Read"),
                    icon: "eye",
                    tooltip: gettext("Read"),
                    action: () => {
                        onChange("read")
                    },
                    selected: currentRight === "read"
                }
            ]
        }
    }

    submitAccessRight(newAccessRights: NewAccessRight[]): Promise<void> {
        return postJson("/api/book/access_rights/save/", {
            book_ids: this.bookIds,
            access_rights: newAccessRights
        })
            .catch((error: unknown) => {
                addAlert("error", gettext("Cannot save access rights."))
                throw error
            })
            .then(() => {
                addAlert("success", gettext("Access rights have been saved"))
            })
    }
}
