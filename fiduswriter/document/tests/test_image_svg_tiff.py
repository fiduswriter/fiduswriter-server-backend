"""E2E: SVG and TIFF handling through the real upload dialog + server."""

import os
import time

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from document.tests.test_editor import EditorTest


class SvgTiffFlowTest(EditorTest):
    def test_svg_and_tiff_upload_flow(self):
        driver = self.driver
        driver.get(self.base_url)
        WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "id-login"))
        )
        driver.find_element(By.ID, "id-login").send_keys("Yeti")
        driver.find_element(By.ID, "id-password").send_keys("otter")
        driver.find_element(By.ID, "login-submit").click()
        self.click_new_document_button(driver)
        WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "editor-toolbar"))
        )
        driver.find_element(By.CSS_SELECTOR, ".doc-title").send_keys("Test")
        driver.find_element(By.CSS_SELECTOR, ".doc-body").click()
        driver.find_element(By.CSS_SELECTOR, ".doc-body").send_keys("Body")

        # Open figure dialog -> selection dialog -> upload dialog
        driver.find_element(By.XPATH, '//*[@title="Figure"]').click()
        WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "span.math-field"))
        )
        for _ in range(5):
            driver.find_element(By.ID, "insert-figure-image").click()
            try:
                WebDriverWait(driver, 2).until(
                    EC.presence_of_element_located(
                        (By.XPATH, '//*[normalize-space()="Add new image"]')
                    )
                )
                break
            except Exception:
                continue
        driver.find_element(
            By.XPATH, '//*[normalize-space()="Add new image"]'
        ).click()
        WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, '#editimage input[type="file"]')
            )
        )

        tmp = "/tmp/kilo/imgrepro"

        def top_dialog_button(text):
            return driver.execute_script(
                """
                const text = arguments[0]
                const dialogs = Array.from(document.querySelectorAll('.fw-dialog'))
                const dlg = dialogs[dialogs.length - 1]
                const btn = Array.from(
                    dlg.querySelectorAll('.fw-dialog-buttonpane button')
                ).filter(b => b.offsetParent !== null)
                 .find(b => b.textContent.trim() === text)
                if (!btn) return null
                btn.click()
                return true
                """,
                text,
            )

        def set_file(fname):
            el = driver.find_element(
                By.CSS_SELECTOR, '#editimage input[type="file"]'
            )
            el.send_keys(os.path.join(tmp, fname))
            time.sleep(1.2)

        def preview_state():
            return driver.execute_script(
                """
                const inner = document.querySelector('#editimage .figure-preview > div')
                if (!inner) return {noInner: true}
                const imgDiv = inner.querySelector('.img')
                const msgDiv = inner.querySelector('.fw-media-preview-missing')
                let visible = false
                if (imgDiv) {
                    const r = imgDiv.getBoundingClientRect()
                    visible = r.width > 0 && r.height > 0
                }
                return {hasPreview: !!imgDiv, previewVisible: visible,
                        message: msgDiv ? msgDiv.textContent.slice(0, 60) : null}
                """
            )

        def upload_disabled():
            return driver.execute_script(
                """
                const up = Array.from(document.querySelectorAll(
                    '.fw-dialog .fw-dialog-buttonpane button')).find(
                        b => b.textContent.trim() === 'Upload')
                return up ? up.disabled : null
                """
            )

        # ---- TIFF: rejected client-side before any upload attempt ----
        set_file("t.tiff")
        st = preview_state()
        print("TIFF state:", st)
        print("TIFF upload disabled:", upload_disabled())
        assert st.get("message") and "not supported" in st["message"]
        assert upload_disabled() is True

        # ---- SVG: preview + restricted editing + successful upload ----
        set_file("t.svg")
        st = preview_state()
        print("SVG state:", st)
        print("SVG upload disabled:", upload_disabled())
        assert st.get("previewVisible") is True
        assert upload_disabled() is False

        driver.find_element(By.CSS_SELECTOR, "#editimage .figure-edit-menu").click()
        time.sleep(0.6)
        menu = driver.execute_script(
            """
            return Array.from(
                document.querySelectorAll('.fw-content-menu li.fw-content-menu-item')
            ).map(li => ({
                text: li.textContent.trim(),
                disabled: li.classList.contains('fw-disabled')
            }))
            """
        )
        print("SVG edit menu:", menu)
        for name in ("Rotate Left", "Rotate Right", "Crop"):
            item = next((i for i in menu if i["text"] == name), None)
            assert item and item["disabled"], f"{name} should be disabled for SVG"
        copy_item = next((i for i in menu if i["text"] == "Set Copyright"), None)
        assert copy_item and not copy_item["disabled"], (
            "Set Copyright should be enabled"
        )
        driver.execute_script(
            "const m = document.querySelector('.fw-content-menu'); "
            "if (m && m.nextElementSibling) m.nextElementSibling.click()"
        )
        time.sleep(0.4)

        # Give it a title so we can find it later, then upload
        title_input = driver.find_element(By.CSS_SELECTOR, "#editimage .fw-media-title")
        title_input.send_keys("My vector image")
        assert top_dialog_button("Upload")
        time.sleep(2)

        state = driver.execute_script(
            """
            const checks = document.querySelectorAll('.fw-data-table i.fa-check').length
            const rows = Array.from(document.querySelectorAll(
                '.image-selection-table tbody tr')).map(tr => tr.textContent.trim())
            return {checks, rows}
            """
        )
        print("after SVG upload:", state)
        assert state["checks"] == 1, "uploaded SVG should be preselected"

        # Insert into the document
        assert top_dialog_button("Use image")
        time.sleep(1.0)
        driver.find_element(By.CSS_SELECTOR, "button.fw-dark").click()
        fig = WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "div.doc-body figure img")
            )
        )
        print("figure <img> src:", fig.get_attribute("src"))
        assert "svg" in (fig.get_attribute("src") or "")
