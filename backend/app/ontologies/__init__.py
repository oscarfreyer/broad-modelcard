"""Other disease ontologies as projections over the ICD-11 atlas (contract v1.13, CONTRACT.md §23).

ICD-11 stays the storage key of every result, population, incident, and
combination. ICD-10-CM and MONDO are alternative hierarchies of
the same three-level shape (chapter → block → condition), imported from
pinned releases (``scripts/ontologies/sources.json``) with a crosswalk from
each condition to an ICD-11 concept of the atlas. Reads with ``ontology=<id>``
serve the mapped ICD-11 results (``app/services/ontology.py``).

* ``sources``: the pinned releases, where they live, and their checksums.
* ``who``, ``icd10cm``, ``mondo``: standard-library parsers of the downloaded
  files. They are untrusted data: archives and XML are size-checked before
  they are read, XML with entity declarations is refused, and nothing in them
  is executed.
* ``crosswalk``: the mapping rules (CONTRACT.md §23).
* ``importer``: ``python -m app.ontologies.importer`` writes the tables.

No source file and nothing derived from the WHO tables (CC BY-ND 3.0 IGO) is
committed; the derived tables exist only in a local store.
"""
