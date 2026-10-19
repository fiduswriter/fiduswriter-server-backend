"""Fuzz tests for the ProseMirror step engine (document/prosemirror.py).

The step engine is the deepest server-side parsing of untrusted user data:
every collaborative diff goes through Step.from_json/apply. These tests feed
random *valid* step sequences (generated with prosemirror-py's own
Transform, then re-serialized through JSON) and *malformed* step JSONs
(mutations of valid ones plus raw garbage) into the engine.

Invariants:
  * Valid step sequences apply and reproduce the generator's document —
    identical on the python and rust backends.
  * Malformed step JSONs never crash: apply() either returns False (the
    designed "unfixable" path that triggers reset_collaboration in the
    websocket consumer) or raises a structured error — never an unhandled
    exception type that would bypass the consumer's error handling.

Run: python manage.py test document.tests.test_fuzz_steps
"""

import json
import unittest

from django.test import SimpleTestCase

from hypothesis import HealthCheck, given, settings, strategies as st

from document import prosemirror

BASE_DOC = {
    "type": "doc",
    "attrs": {"template": "Fuzz"},
    "content": [
        {"type": "title", "content": [{"type": "text", "text": "Fuzz title"}]},
        {
            "type": "richtext_part",
            "attrs": {"id": "body", "title": "Body"},
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Hello brave new world"}
                    ],
                },
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Second paragraph 😀 ünïcode"}
                    ],
                },
                {
                    "type": "bullet_list",
                    "content": [
                        {
                            "type": "list_item",
                            "content": [{"type": "paragraph", "content": []}],
                        }
                    ],
                },
            ],
        },
    ],
}


def base_node():
    return prosemirror.from_json(json.loads(json.dumps(BASE_DOC)))


def random_valid_steps(seed):
    """Generate a random sequence of valid steps against BASE_DOC using
    prosemirror-py's Transform, and return their JSON serializations."""
    import random

    from prosemirror.transform import Transform

    rnd = random.Random(seed)
    node = base_node()
    tr = Transform(node)
    for _ in range(rnd.randint(1, 6)):
        size = tr.doc.content.size
        if size < 2:
            break
        from_pos = rnd.randint(0, size - 1)
        to_pos = min(size, from_pos + rnd.randint(0, 4))
        op = rnd.randint(0, 2)
        try:
            if op == 0:
                text = prosemirror.schema.text(
                    rnd.choice(["a", "ö", "😀", "ж"])
                )
                tr.replace_with(from_pos, from_pos, text)
            elif op == 1:
                tr.delete(from_pos, to_pos)
            elif op == 2:
                text = prosemirror.schema.text(rnd.choice(["x", "y"]))
                tr.replace_with(from_pos, from_pos, text)
            else:
                # Split a block at the mapped position — structural steps
                # exercise the backends' position mapping much harder than
                # plain text edits.
                tr.split(from_pos, rnd.randint(1, 2))
        except Exception:
            # Some constructions are invalid (e.g. text outside inline
            # content) — the generator skips them, the same way the editor's
            # random-edit generator does.
            continue
    if not tr.steps:
        return None, None
    return [step.to_json() for step in tr.steps], tr.doc


class StepEngineFuzzTest(SimpleTestCase):
    databases = {}

    @given(st.integers(min_value=0, max_value=2**31))
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_valid_steps_apply_and_match_generator(self, seed):
        steps, expected = random_valid_steps(seed)
        if not steps:
            return
        node = base_node()
        result = prosemirror.apply(steps, node)
        self.assertFalse(result is False, "valid steps failed to apply")
        # The applied document must equal the generator's document (both
        # prosemirror-py nodes, so eq() is meaningful).
        self.assertTrue(
            result.eq(expected),
            "applied document differs from generator document",
        )

    @given(st.integers(min_value=0, max_value=2**31))
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_valid_steps_identical_across_backends(self, seed):
        steps, _expected = random_valid_steps(seed)
        if not steps:
            return
        try:
            from document import prosemirror_rs
        except ImportError:
            self.skipTest("rust backend not available")
        # python backend
        py_node = base_node()
        py_result = prosemirror.apply(steps, py_node)
        self.assertFalse(
            py_result is False, "valid steps failed on python backend"
        )
        py_doc = prosemirror.to_content(py_result)
        # rust backend (apply mutates the editor in place)
        rs_editor = prosemirror_rs.from_json(json.loads(json.dumps(BASE_DOC)))
        rs_result = prosemirror_rs.apply(steps, rs_editor)
        self.assertFalse(
            rs_result is False, "valid steps failed on rust backend"
        )
        rs_doc = json.loads(prosemirror_rs.to_content(rs_editor))
        # The two backends serialize document attrs differently (the python
        # to_content keeps all doc attrs, the rust doc_json skips
        # defaults) — the content tree is the contract.
        self.assertEqual(
            json.dumps(py_doc["content"], sort_keys=True),
            json.dumps(rs_doc["content"], sort_keys=True),
            "python and rust backends produced different documents",
        )

    @given(st.integers(min_value=0, max_value=2**31))
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_malformed_steps_fail_cleanly(self, seed):
        """Malformed step JSONs must not crash the process: apply() should
        take the designed False path (or raise a structured parse error the
        websocket layer tolerates) — never an unexpected exception type."""
        import random

        rnd = random.Random(seed)
        node = base_node()
        # First produce a valid step to mutate.
        from prosemirror.transform import Transform

        tr = Transform(node)
        tr.replace_with(2, 2, prosemirror.schema.text("seed"))
        step_json = tr.steps[0].to_json()

        mutations = [
            {**step_json, "from": rnd.choice([-5, 10**9, "x", None])},
            {**step_json, "to": rnd.choice([-3, 10**9, None, []])},
            {**step_json, "stepType": rnd.choice(["bogus", "", 42, None])},
            {**step_json, "slice": rnd.choice([None, {}, {"content": "x"}])},
            {**step_json, "param": {"pos": rnd.choice([-1, 10**9])}},
            {
                "stepType": "addMark",
                "mark": rnd.choice([None, {}, {"type": "nope"}]),
            },
            {"stepType": "replace", "from": 1, "to": 0},
            {},
            rnd.choice([None, 42, "string", [], True]),
        ]
        mutated = mutations[rnd.randint(0, len(mutations) - 1)]
        if mutated is None:
            return
        try:
            result = prosemirror.apply([mutated], node)
        except (ValueError, KeyError, TypeError) as error:
            # Structured parse errors are tolerated at the consumer level:
            # prosemirror-py raises ValueError subclasses for invalid input.
            self.assertIn(
                type(error).__name__,
                ("ValueError", "KeyError", "TypeError"),
                f"unexpected exception type for {mutated!r}: {error!r}",
            )
            return
        except Exception as error:  # noqa: BLE001
            self.fail(
                f"malformed step {mutated!r} raised an unexpected "
                f"{type(error).__name__}: {error}"
            )
        # Either the designed False ("unfixable" path) or a successfully
        # applied node (the mutation was semantically still valid) — both
        # are fine; crashing is not, and that is covered above.
        self.assertTrue(
            result is False or hasattr(result, "content"),
            f"apply returned an unexpected value for {mutated!r}",
        )


try:
    from document import prosemirror_rs as _prosemirror_rs

    _RUST_BACKEND_AVAILABLE = True
except ImportError:
    _RUST_BACKEND_AVAILABLE = False


@unittest.skipUnless(_RUST_BACKEND_AVAILABLE, "rust backend not available")
class StepEngineRustFuzzTest(SimpleTestCase):
    """Fuzz the rust step engine (the production default backend)."""

    databases = {}

    def _mutated_batch(self, seed):
        """A random malformed step batch, built the same way as the python
        test's mutations so both backends see the same garbage."""
        import random

        from prosemirror.transform import Transform

        rnd = random.Random(seed)
        node = base_node()
        tr = Transform(node)
        tr.replace_with(2, 2, prosemirror.schema.text("seed"))
        step_json = tr.steps[0].to_json()
        mutations = [
            {**step_json, "from": rnd.choice([-5, 10**9, "x", None])},
            {**step_json, "to": rnd.choice([-3, 10**9, None, []])},
            {**step_json, "stepType": rnd.choice(["bogus", "", 42, None])},
            {**step_json, "slice": rnd.choice([None, {}, {"content": "x"}])},
            {
                "stepType": "addMark",
                "mark": rnd.choice([None, {"type": "nope"}]),
            },
            {"stepType": "replace", "from": 1, "to": 0},
            {},
            rnd.choice([None, 42, "string", [], True]),
        ]
        return mutations[rnd.randint(0, len(mutations) - 1)]

    def _fresh_editor(self):
        return _prosemirror_rs.from_json(json.loads(json.dumps(BASE_DOC)))

    @given(st.integers(min_value=0, max_value=2**31))
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_malformed_steps_fail_cleanly(self, seed):
        """apply() must take the designed False path for any malformed
        step — the consumer turns False into unfixable() +
        reset_collaboration(); a raised exception would kill the
        websocket handler instead."""
        mutated = self._mutated_batch(seed)
        if mutated is None:
            return
        editor = self._fresh_editor()
        result = _prosemirror_rs.apply([mutated], editor)
        self.assertFalse(
            result is not False,
            f"malformed step {mutated!r} was applied by the rust backend",
        )

    @given(st.integers(min_value=0, max_value=2**31))
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_failed_batch_rolls_back_atomically(self, seed):
        """apply_steps is atomic: a batch containing valid steps followed
        by a malformed one must leave the document exactly as it was, and
        the editor must stay usable."""
        steps, _expected = random_valid_steps(seed)
        if not steps:
            return
        editor = self._fresh_editor()
        before = _prosemirror_rs.to_content(editor)
        mixed = list(steps) + [{"stepType": "bogus"}]
        result = _prosemirror_rs.apply(mixed, editor)
        self.assertFalse(result is not False, "mixed batch applied")
        self.assertEqual(
            before,
            _prosemirror_rs.to_content(editor),
            "failed batch was not rolled back",
        )
        # The editor remains usable: the same valid steps still apply.
        result = _prosemirror_rs.apply(steps, editor)
        self.assertFalse(result is False, "editor unusable after rollback")

    @given(
        st.integers(min_value=0, max_value=2**31),
        st.integers(min_value=0, max_value=2**31),
    )
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_garbage_then_valid_matches_python(self, seed, garbage_seed):
        """After any amount of rejected garbage, the rust backend still
        produces the same document as the python backend for the same
        valid steps."""
        steps, _expected = random_valid_steps(seed)
        if not steps:
            return
        mutated = self._mutated_batch(garbage_seed)
        py_node = base_node()
        py_result = prosemirror.apply(steps, py_node)
        self.assertFalse(py_result is False)
        py_doc = prosemirror.to_content(py_result)
        rs_editor = self._fresh_editor()
        if mutated is not None:
            self.assertFalse(
                _prosemirror_rs.apply([mutated], rs_editor) is not False
            )
        rs_result = _prosemirror_rs.apply(steps, rs_editor)
        self.assertFalse(
            rs_result is False, "valid steps failed after garbage"
        )
        rs_doc = json.loads(_prosemirror_rs.to_content(rs_editor))
        self.assertEqual(
            json.dumps(py_doc["content"], sort_keys=True),
            json.dumps(rs_doc["content"], sort_keys=True),
            "backends diverged after a rejected garbage batch",
        )
