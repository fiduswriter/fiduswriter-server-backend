"""Diagnostic test: inspect image upload preview + crop menu in the real app."""

import os
import time

from django.conf import settings
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from document.tests.test_editor import EditorTest

try:
    from PIL import Image

    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def make_test_images(dir_path):
    """Create images of various types; return list of (name, path)."""
    out = []
    if not HAS_PIL:
        return [
            (
                "png",
                os.path.join(
                    settings.PROJECT_PATH, "document/tests/uploads/image.png"
                ),
            )
        ]
    specs = [
        ("png", "PNG", "RGB"),
        ("jpg", "JPEG", "RGB"),
        ("webp", "WEBP", "RGB"),
        ("gif", "GIF", "P"),
    ]
    for name, fmt, mode in specs:
        path = os.path.join(dir_path, f"diag.{name}")
        img = Image.new(mode, (600, 400), "red")
        try:
            img.save(path, fmt)
        except Exception:
            img.convert("RGB").save(path, fmt)
        out.append((name, path))
    return out


class DiagnosticImageUploadTest(EditorTest):
    def test_upload_preview_diagnostics(self):
        self.driver.get(self.base_url)
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "id-login"))
        )
        self.driver.find_element(By.ID, "id-login").send_keys("Yeti")
        self.driver.find_element(By.ID, "id-password").send_keys("otter")
        self.driver.find_element(By.ID, "login-submit").click()
        self.click_new_document_button(self.driver)
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "editor-toolbar"))
        )
        # Type some body text first (mirrors the working test)
        self.driver.find_element(By.CSS_SELECTOR, ".doc-title").click()
        self.driver.find_element(By.CSS_SELECTOR, ".doc-title").send_keys(
            "Test"
        )
        self.driver.find_element(By.CSS_SELECTOR, ".doc-body").click()
        self.driver.find_element(By.CSS_SELECTOR, ".doc-body").send_keys(
            "Body"
        )
        # Add a figure
        self.driver.find_element(By.XPATH, '//*[@title="Figure"]').click()
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "span.math-field")
            )
        )
        # Click Insert image (retry until MathLive loaded)
        for _attempt in range(5):
            self.driver.find_element(By.ID, "insert-figure-image").click()
            try:
                WebDriverWait(self.driver, 2).until(
                    EC.presence_of_element_located(
                        (By.XPATH, '//*[normalize-space()="Add new image"]')
                    )
                )
                break
            except Exception:
                continue
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="Add new image"]'
        ).click()
        file_input = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, '#editimage input[type="file"]')
            )
        )

        tmp = "/tmp/kilo/imgrepro"
        os.makedirs(tmp, exist_ok=True)
        for name, path in make_test_images(tmp):
            file_input = self.driver.find_element(
                By.CSS_SELECTOR, '#editimage input[type="file"]'
            )
            file_input.send_keys(path)
            time.sleep(1.5)
            state = self.driver.execute_script(
                """
                const dlg = document.querySelector('#editimage')
                const fp = dlg && dlg.querySelector('.figure-preview')
                if (!fp) return {error: 'no .figure-preview'}
                const inner = fp.querySelector(':scope > div')
                const imgDiv = inner && inner.querySelector('.img')
                const rect = imgDiv ? imgDiv.getBoundingClientRect() : null
                const style = getComputedStyle(imgDiv || fp)
                // is the preview actually visible on screen?
                let visible = null
                if (imgDiv) {
                    const r = imgDiv.getBoundingClientRect()
                    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
                    const topEl = document.elementFromPoint(cx, cy)
                    visible = !!(r.width && r.height) && (
                        imgDiv === topEl || imgDiv.contains(topEl) ||
                        (topEl && topEl.contains(imgDiv)))
                }
                return {
                    hasInner: !!inner,
                    hasImgDiv: !!imgDiv,
                    rect: rect ? {w: rect.width, h: rect.height} : null,
                    bgImageSet: imgDiv ? imgDiv.style.backgroundImage.slice(0, 30) : null,
                    display: style.display,
                    position: style.position,
                    visibleAtCenter: visible,
                    dialogRect: (() => {const r = dlg.getBoundingClientRect(); return {w: r.width, h: r.height}})(),
                    figurePreviewDisplay: getComputedStyle(fp).display
                }
                """
            )
            print(f"PREVIEW[{name}] =", state)

            # Check edit menu opens
            menu_btn = self.driver.find_element(
                By.CSS_SELECTOR, "#editimage .figure-edit-menu"
            )
            menu_btn.click()
            time.sleep(0.8)
            menu_state = self.driver.execute_script(
                """
                const menus = document.querySelectorAll('.fw-content-menu')
                let items = []
                document.querySelectorAll('.fw-content-menu li, .ui-menu li').forEach(li => items.push(li.textContent.trim()))
                return {menuCount: menus.length, items}
                """
            )
            print(f"  EDITMENU[{name}] =", menu_state)
            # close menu by clicking its overlay backdrop
            self.driver.execute_script(
                "const m = document.querySelector('.fw-content-menu'); "
                "if (m && m.nextElementSibling) m.nextElementSibling.click()"
            )
            time.sleep(0.4)

        # Now upload the PNG and observe what happens after clicking Upload
        png_path = None
        for name, path in make_test_images(tmp):
            if name == "png":
                png_path = path
        file_input.send_keys(png_path)
        time.sleep(1.0)
        self.driver.find_element(
            By.XPATH,
            '//*[contains(@class, "fw-button") and normalize-space()="Upload"]',
        ).click()
        time.sleep(2)
        after = self.driver.execute_script(
            """
            const dialogs = Array.from(document.querySelectorAll('.fw-dialog')).map(d => {
                const title = d.querySelector('.fw-dialog-title')
                return title ? title.textContent : '?'
            })
            const checks = document.querySelectorAll('.fw-data-table i.fa-check').length
            const rows = document.querySelectorAll('.image-selection-table tbody tr').length
            const alerts = Array.from(document.querySelectorAll('#fw-alerts-wrapper li')).map(a => a.textContent)
            return {dialogs, checks, rows, alerts}
            """
        )
        print("AFTER UPLOAD =", after)
