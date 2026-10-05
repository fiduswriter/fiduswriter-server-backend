// Adds a link to the book creator to the main menu on the overview pages.
import type {NavItem, SiteMenuLike} from "@fiduswriter/frontend"

export class BookMenuItem {
    menu: SiteMenuLike

    constructor(menu: SiteMenuLike) {
        this.menu = menu
    }

    init(): void {
        const navItem: NavItem = {
            id: "books",
            title: gettext("compose books"),
            url: "/books/",
            text: gettext("Books"),
            order: 5,
            keys: "Alt-o"
        }
        this.menu.navItems.push(navItem)
    }
}
