# Fuzz testing

The backend's untrusted-input surfaces are fuzz-tested with
hypothesis-based Django test modules:

| Module | Target | Key invariants |
|--------|--------|----------------|
| `document/tests/test_fuzz_steps.py` | the ProseMirror step engine (`document/prosemirror.py` + the rust backend) — every websocket diff passes through it | valid step sequences apply and match the generating transform, **python and rust backends produce identical documents**, malformed step JSONs take the designed "unfixable" path instead of raising |
| `document/tests/test_fuzz_views.py` | AJAX endpoints (`import/create`, `import`, `save`, `upload_revision`, `bibliography/save`, `book/save`, `user_template_manager/create`, `style/save_document_style`, …) with malformed payloads and non-dict JSON bodies | no view returns 500 — malformed shapes degrade to 4xx |
| `usermedia/tests/test_fuzz_images.py` | image upload + Pillow thumbnail path with truncated/spoofed/hostile images | rejections below 500; valid images still upload |

Run them with the project's test runner (from the inner `fiduswriter/`
directory, with direnv/pyenv activated):

```bash
python manage.py test document.tests.test_fuzz_steps --noinput
python manage.py test document.tests.test_fuzz_views --noinput
python manage.py test usermedia.tests.test_fuzz_images --noinput
```

Hypothesis prints a reproducible failing example on failure; re-run with
`--hyp-seed=<seed>` (or pin `@settings`) to replay.

The websocket consumer input path (`handle_diff` with attacker-controlled
steps) funnels into the same `prosemirror.apply()` engine covered by
`test_fuzz_steps.py`; the consumer converts an `apply()` failure into the
designed `unfixable()` + `reset_collaboration()` flow.

## Bugs found by fuzzing so far (all fixed)

1. **Failed ProseMirror steps were treated as successes** —
   `prosemirror.py`'s `apply()` checked `step_result.ok`, which in
   prosemirror-py 0.6 is a *classmethod factory*, not a property: the check
   was always truthy, so a failed step replaced the node with `None` (and a
   multi-step diff crashed the websocket handler with an `AttributeError`
   instead of triggering `reset_collaboration`). The check now uses
   `step_result.failed`, and `Step.from_json`/`apply` exceptions on
   malformed input return `False` (the designed unfixable path).
2. **Malformed API payloads produced 500s** — views index
   `request.JSON["key"]` directly; missing keys (`import_id`, `bibs`,
   `book`, `ids`, …), wrong types, non-dict JSON bodies and unparseable
   scalars (`int(doc_id)` on "not-a-number") raised
   KeyError/TypeError/AttributeError/ValueError in at least ten endpoints
   (including `user_template_manager/create` and
   `create_template_admin`, which crashed on a missing template title).
   Fixed systemically: `JsonToPostMiddleware` now (a) normalizes non-dict
   JSON bodies to `{}` and (b) converts client-shape exceptions on `/api/`
   routes into a logged 400 response; the two template-creating views
   additionally validate the title up front.
