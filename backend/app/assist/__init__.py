"""Assisted data entry: an LLM proposes records from one study (contract v1.9, CONTRACT.md §20).

The maintainer hands the helper one study excerpt (a PDF for a hosted model,
or text, CSV, or XLSX) and gets back proposed records for the ``metrics`` or
``safety`` data set, each field with its source quote and an uncertainty flag.
The helper **proposes, never publishes**: a proposal becomes a staged merge
upload only when the maintainer sends the records they accept through
``createRecordsUpload`` (CONTRACT.md §11.4); the normal check → change summary
→ preview → publish flow follows.

* ``config``: the provider configuration (``assist.json`` next to the store,
  mode 600); the API key is write-only and never logged or returned.
* ``inputs``: the submitted study as a PDF or as text (tables rendered with
  row numbers so the model can cite cells).
* ``prompting``: the system prompt, the field lists, the search tool, and JSON
  extraction from the model's answer.
* ``providers``: a hosted model (Anthropic Messages API) and a local
  OpenAI-compatible endpoint over standard-library HTTP, and a deterministic
  fake provider for tests and the offline evaluation.
* ``proposals``: checks the model's records against the store (codes and
  cards that exist, never guessed) and maps them to template records.
* ``service``: status, configuration, and the proposal pipeline.
* ``studyset`` and ``evaluate``: the fixed synthetic study set and the
  field-level accuracy measurement (``python -m app.assist.evaluate``).

No SDK and no PDF library. All data is synthetic
demonstration data; never submit patient data.
"""
