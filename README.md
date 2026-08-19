Fidus Writer server backend
===========================

This repository contains the **Fidus Writer server backend**: the Django
application that powers the classic Fidus Writer server (user management,
document storage, bibliography, WebSocket-based real-time collaboration, REST
API, and the Django admin).

The Python package / PyPI distribution published from this repository is named
**`fiduswriter`** (kept for backwards compatibility — `pip install fiduswriter`
installs the server). The repository itself is called `fiduswriter-server-backend`
to distinguish it from the main `fiduswriter` repository, which holds packaging
(docker/deb/rpm/snap), documentation, dev-scripts, and CI only.

Fidus Writer is an online collaborative editor especially made for academics who
need to use citations and/or formulas. The editor focuses on the content rather
than the layout, so that with the same text, you can later on publish it in
multiple ways: on a website, as a printed book, or as an ebook.

Installation and documentation
------------------------------

Installation guides, packaging (Debian/RPM/Snap/Docker), and the full
documentation live in the [main `fiduswriter` repository](https://git.fiduswriter.org/fiduswriter/fiduswriter).

Quick start for development:

```bash
# Install Python dependencies
pip install -r fiduswriter/dev-requirements.txt

# Copy and adapt the default configuration
cp fiduswriter/configuration-default.py fiduswriter/configuration.py

# Run the setup (migrate, npm install, transpile)
python fiduswriter/manage.py setup

# Run the development server
python fiduswriter/manage.py runserver
```

Running tests:

```bash
cd fiduswriter/fiduswriter
python manage.py test document.tests.test_external_save --noinput
```

Related repositories
--------------------

- `fiduswriter/` — main repository: packaging, docs, dev-scripts, CI.
- `fwtoolkit/` — shared UI toolkit (`fwtoolkit` npm package).
- `fiduswriter-document-ts/` — `@fiduswriter/document` npm package.
- `fiduswriter-editor-ts/` — `@fiduswriter/editor` npm package.
- `fiduswriter-frontend-ts/` — `@fiduswriter/frontend` npm package.
- `fiduswriter-bibliography-manager-ts/`, `fiduswriter-image-manager-ts/`,
  `fiduswriter-document-template-editor-ts/` — supporting npm packages.

License
-------

All of Fidus Writer's original code is licensed under the GNU AFFERO GENERAL
PUBLIC LICENSE, for details see LICENSE. Some third party libraries are
licensed under other, compatible open source libraries. Licensing information
is included in those files.
