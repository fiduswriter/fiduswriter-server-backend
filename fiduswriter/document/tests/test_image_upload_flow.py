"""E2E: crop flow + cancel/re-add flow in the real app."""

import os
import time

from PIL import Image

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from document.tests.test_editor import EditorTest


class CropFlowTest(EditorTest):
    def test_crop_and_cancel_readd_flow(self):
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

        # Make a large-ish image so cropping is meaningful
        tmp = "/tmp/kilo/imgrepro"
        img_path = os.path.join(tmp, "crop-me.png")
        Image.new("RGB", (1200, 900), "blue").save(img_path)

        # Open figure dialog and image selection dialog
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

        def top_dialog_button(text):
            return driver.execute_script(
                """
                const text = arguments[0]
                const dialogs = Array.from(document.querySelectorAll('.fw-dialog'))
                const dlg = dialogs[dialogs.length - 1]
                const buttons = Array.from(
                    dlg.querySelectorAll('.fw-dialog-buttonpane button')
                ).filter(b => b.offsetParent !== null)
                const btn = buttons.find(b => b.textContent.trim() === text)
                if (!btn) return 'NOT FOUND: ' + text
                btn.click()
                return 'clicked'
                """,
                text,
            )

        # 1) Open upload dialog, then CANCEL it
        assert top_dialog_button("Add new image") == "clicked"
        WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, '#editimage input[type="file"]')
            )
        )
        print("cancel upload:", top_dialog_button("Cancel"))
        time.sleep(0.5)

        # Selection dialog must still be there; re-open upload
        assert top_dialog_button("Add new image") == "clicked"
        file_input = WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, '#editimage input[type="file"]')
            )
        )
        file_input.send_keys(img_path)
        time.sleep(1.5)

        # 2) Rotate right once, then crop to a region
        driver.find_element(By.CSS_SELECTOR, "#editimage .figure-edit-menu").click()
        time.sleep(0.6)
        clicked_rotate = driver.execute_script(
            """
            const items = Array.from(
                document.querySelectorAll('.fw-content-menu li.fw-content-menu-item')
            )
            const rotate = items.find(li => li.textContent.includes('Rotate Right'))
            if (!rotate) return 'NO ROTATE'
            rotate.click()
            return 'rotated'
            """
        )
        print("rotate:", clicked_rotate)
        time.sleep(1.0)

        driver.find_element(By.CSS_SELECTOR, "#editimage .figure-edit-menu").click()
        time.sleep(0.6)
        clicked_crop = driver.execute_script(
            """
            const items = Array.from(
                document.querySelectorAll('.fw-content-menu li.fw-content-menu-item')
            )
            const crop = items.find(li => li.textContent.includes('Crop'))
            if (!crop) return 'NO CROP'
            crop.click()
            return 'crop mode'
            """
        )
        print("crop:", clicked_crop)
        time.sleep(1.0)

        # Cropper UI present?
        cropper_ui = driver.execute_script(
            "return !!document.querySelector('#editimage .cropper-container')"
        )
        print("cropper container visible:", cropper_ui)

        # Click the 'Crop' confirmation button (dialog buttons were replaced)
        print("confirm crop:", top_dialog_button("Crop"))
        time.sleep(1.0)

        # 3) Upload the cropped image
        print("upload:", top_dialog_button("Upload"))
        time.sleep(2.0)

        state = driver.execute_script(
            """
            const dlg = window.theApp ? null : null
            const checks = document.querySelectorAll('.fw-data-table i.fa-check').length
            const rows = document.querySelectorAll('.image-selection-table tbody tr').length
            const titles = Array.from(document.querySelectorAll('.fw-dialog-title')).map(e => e.textContent)
            return {checks, rows, titles}
            """
        )
        print("after upload:", state)
        assert state["rows"] == 1, "expected exactly one image row"
        assert state["checks"] == 1, "expected the new image to be preselected"

        # 3b) The stored thumbnail preserves the aspect ratio of the uploaded
        # image and fits within the 150x100 box (no square cropping).
        thumb_src = driver.execute_script(
            """
            const img = document.querySelector(
                '.image-selection-table tbody td .fw-image-preview img'
            )
            return img ? img.src : null
            """
        )
        print("thumbnail src:", thumb_src)
        import io
        import urllib.request

        from PIL import Image as PilImage

        with urllib.request.urlopen(thumb_src) as response:
            thumb = PilImage.open(io.BytesIO(response.read()))
        w, h = thumb.size
        print(f"thumbnail dimensions: {w}x{h}")
        assert w <= 150 and h <= 100, (
            f"thumbnail larger than the 150x100 box: {w}x{h}"
        )
        expected_ratio = 900 / 1200  # rotated before upload: portrait 3:4
        actual_ratio = w / h
        assert abs(actual_ratio - expected_ratio) < 0.02, (
            f"thumbnail aspect ratio {actual_ratio:.3f} deviates from "
            f"expected {expected_ratio:.3f}"
        )

        # 4) Use image -> insert into doc
        print("use image:", top_dialog_button("Use image"))
        time.sleep(1.0)
        driver.find_element(By.CSS_SELECTOR, "button.fw-dark").click()
        caption = WebDriverWait(driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "div.doc-body figure figcaption")
            )
        )
        print("figure inserted into document:", caption is not None)
