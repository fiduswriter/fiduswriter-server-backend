from pathlib import Path
import re

from django.core.files import File
from django.db import migrations

SOURCE_SANS_REGULAR_FILENAME = "SourceSansPro-Regular.woff"

# The Source Sans Pro Regular woff is bundled with the app (also shipped in
# the fixtures media dir so fresh installs get it via `loaddata`).
FONT_PATH = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "media"
    / "style-files"
    / SOURCE_SANS_REGULAR_FILENAME
)

SOURCE_SANS_REGULAR_FONTFACE = (
    "@font-face {font-family: 'Source Sans Pro';\r\n"
    "font-style: normal;\r\n"
    "font-weight: 400;\r\n"
    "src: local('Source Sans Pro'), local('SourceSansPro-Regular'), "
    "url(SourceSansPro-Regular.woff) format('woff');}"
)

# Courier New is proprietary; replace it with the bundled open-source
# JetBrains Mono (also fixes the "mono-space" typo).
COURIER_REPLACEMENTS = (
    (
        '"Courier New", Courier, mono-space',
        '"JetBrains Mono", "DejaVu Sans Mono", monospace',
    ),
    (
        "'Courier', monospace",
        '"JetBrains Mono", "DejaVu Sans Mono", monospace',
    ),
)


def add_margin_box_rule(contents):
    """Vivliostyle does not apply the `.pagination-pagenumber` class to its
    generated page-number element, so the docstyle's class-based page-number
    styling is dead code. Re-emit the page-number font on the `@page
    @bottom-center` margin box rule, which vivliostyle does honor."""
    if "@bottom-center" in contents:
        return contents
    match = re.search(r"\.pagination-pagenumber\s*\{([^}]*)\}", contents)
    if not match:
        return contents
    props = match.group(1)
    family = re.search(r"font-family:\s*([^;]+)", props)
    if not family:
        return contents
    fam = family.group(1).strip()
    weight = re.search(r"font-weight:\s*([^;]+)", props)
    wt = weight.group(1).strip() if weight else "400"
    rule = (
        "@page {@bottom-center {font-family: "
        + fam
        + "; font-weight: "
        + wt
        + ";}}"
    )
    return contents.rstrip() + "\r\n" + rule


def forward(apps, schema_editor):
    DocumentStyle = apps.get_model("style", "DocumentStyle")
    DocumentStyleFile = apps.get_model("style", "DocumentStyleFile")

    for style in DocumentStyle.objects.all():
        contents = style.contents
        new_contents = contents
        for old, new in COURIER_REPLACEMENTS:
            new_contents = new_contents.replace(old, new)

        # Add a weight-400 Source Sans Pro face so page numbers (and other
        # weight-400 Source Sans Pro text) match instead of falling back.
        if (
            "Source Sans Pro" in new_contents
            and "SourceSansPro-Regular.woff" not in new_contents
        ):
            marker = new_contents.rfind("@font-face")
            if marker != -1:
                end = new_contents.find("}", marker) + 1
                new_contents = (
                    new_contents[:end]
                    + SOURCE_SANS_REGULAR_FONTFACE
                    + new_contents[end:]
                )

        # Make the page-number font actually apply (see add_margin_box_rule).
        new_contents = add_margin_box_rule(new_contents)

        if new_contents != contents:
            style.contents = new_contents
            style.save()

        # The Regular font file must be registered for the exporter to embed
        # it (CSS url() → media/... rewrite + http file list).
        if (
            "SourceSansPro-Regular.woff" in new_contents
            and not DocumentStyleFile.objects.filter(
                style=style, filename=SOURCE_SANS_REGULAR_FILENAME
            ).exists()
        ):
            if FONT_PATH.exists():
                dsf = DocumentStyleFile(
                    style=style, filename=SOURCE_SANS_REGULAR_FILENAME
                )
                with FONT_PATH.open("rb") as font_file:
                    dsf.file.save(
                        SOURCE_SANS_REGULAR_FILENAME, File(font_file)
                    )
                dsf.save()


def reverse(apps, schema_editor):
    # Data migration; not meaningfully reversible.
    pass


class Migration(migrations.Migration):
    dependencies = [("style", "0003_counter_reset_body")]

    operations = [migrations.RunPython(forward, reverse)]
