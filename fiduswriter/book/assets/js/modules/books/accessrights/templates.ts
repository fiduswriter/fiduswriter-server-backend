import {avatarTemplate, escapeText} from "fwtoolkit"
import type {BookAccessRight, BookContact} from "../types"

/** A template for the book collaboration pane */
export const bookCollaboratorsTemplate = ({
    collaborators
}: {
    collaborators: BookAccessRight[]
}): string => {
    return collaborators
        .map(
            collaborator =>
                `<tr id="collaborator-${collaborator.holder.type}-${
                    collaborator.holder.id
                }"
        data-type="${collaborator.holder.type}" data-id="${
            collaborator.holder.id
        }"
        class="fw-collaborator-tr" data-rights="${collaborator.rights}">
            <td width="212">
                <span>${avatarTemplate({
                    user: {
                        name: collaborator.holder.name,
                        username: collaborator.holder.username,
                        avatar: collaborator.holder.avatar ?? undefined
                    }
                })}</span>
                <span class="fw-inline">${
                    collaborator.holder.type === "userinvite"
                        ? `${gettext("Invite")}: `
                        : ""
                }${escapeText(collaborator.holder.name)}</span>
            </td>
            <td width="50" align="center">
                <div class="fw-inline edit-right-wrapper">
                    <i class="fw-icon-access-right icon-access-${
                        collaborator.rights
                    }"></i>
                    <i class="fas fa-caret-down edit-right"></i>
                </div>
            </td>
            <td width="50" align="center">
                <span class="delete-collaborator fw-inline">
                    <i class="fas fa-trash-alt fw-link-text"></i>
                </span>
            </td>
        </tr>`
        )
        .join("")
}

export const bookContactsTemplate = ({
    contacts
}: {
    contacts: BookContact[]
}): string =>
    contacts
        .map(
            contact =>
                `<tr>
            <td width="337" data-id="${contact.id}" data-type="${contact.type}" class="fw-checkable fw-checkable-td">
                <span>${avatarTemplate({
                    user: {
                        name: contact.name,
                        username: contact.username,
                        avatar: contact.avatar ?? undefined
                    }
                })}</span>
                <span class="fw-inline">
                ${
                    contact.type === "userinvite"
                        ? `${gettext("Invite")}:&nbsp;`
                        : ""
                }
                    ${escapeText(contact.name)}

                </span>
            </td>
        </tr>`
        )
        .join("")

/** A template for the book access rights overview */
export const bookAccessRightOverviewTemplate = ({
    contacts,
    collaborators
}: {
    contacts: BookContact[]
    collaborators: BookAccessRight[]
}): string =>
    `<div id="my-contacts" class="fw-ar-container">
            <h3 class="fw-green-title">${gettext("My contacts")}</h3>
            <table class="fw-data-table">
                <thead class="fw-data-table-header">
                    <tr>
                        <th width="332">${gettext("Contacts")}</th>
                    </tr>
                </thead>
                <tbody class="fw-data-table-body fw-small">
                    ${bookContactsTemplate({contacts})}
                </tbody>
            </table>
        </div>
        <span id="add-share-contact" class="fw-button fw-large fw-square fw-light fw-ar-button">
            <i class="fas fa-caret-right"></i>
        </span>
        <div id="share-contact" class="fw-ar-container">
            <h3 class="fw-green-title">${gettext("My collaborators")}</h3>
            <table class="fw-data-table tablesorter">
                <thead class="fw-data-table-header"><tr>
                        <th width="212">${gettext("Collaborators")}</th>
                        <th width="50" align="center">${gettext("Rights")}</th>
                        <th width="50" align="center">${gettext("Delete")}</th>
                </tr></thead>
                <tbody class="fw-data-table-body fw-small">${bookCollaboratorsTemplate(
                    {
                        collaborators
                    }
                )}</tbody>
            </table>
        </div>`
