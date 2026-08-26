// Adds a link to the document templates to the main menu on the overview pages.
import type {NavItem, SiteMenuLike} from "@fiduswriter/frontend"

export class DocTemplatesMenuItem {
    menu: SiteMenuLike

    constructor(menu: SiteMenuLike) {
        this.menu = menu
    }

    init(): void {
        const navItem: NavItem = {
            id: "templates",
            title: gettext("Document Templates"),
            url: "/templates/",
            text: gettext("Templates"),
            order: 4,
            keys: "Alt-t"
        }
        this.menu.navItems.push(navItem)
    }
}
