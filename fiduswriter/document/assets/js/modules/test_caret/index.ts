import {TextSelection} from "prosemirror-state"
import type {EditorView} from "prosemirror-view"

/**
 * During editor tests the SPA's active page is the editor page, which
 * exposes the ProseMirror view of the main text editor.
 */
interface TestRunnerApp {
    page: {view: EditorView}
}

/**
 * Sets the text selection between two positions in the currently open
 * editor. Exposed to Selenium tests through window.testCaret.
 */
export function setSelection(
    selectFrom: number,
    selectTo: number
): TextSelection {
    const app = window.theApp as unknown as TestRunnerApp
    const view = app.page.view
    const caretOneRes = view.state.doc.resolve(selectFrom)
    const caretTwoRes = view.state.doc.resolve(selectTo)
    const selection = new TextSelection(caretOneRes, caretTwoRes)

    view.dispatch(view.state.tr.setSelection(selection))
    view.focus()

    return selection
}
