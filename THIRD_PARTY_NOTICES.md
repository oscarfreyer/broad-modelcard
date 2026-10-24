# Third-party notices

Broad Modelcard includes the following third-party material in its source. Each keeps its own licence: the project's Apache License 2.0 (`LICENSE`) and CC BY 4.0 (`LICENSE-docs`) do not apply to it (see `NOTICE`).

## ICD-11 for Mortality and Morbidity Statistics

- What: the ICD-11 MMS chapters, blocks, and categories (13,688 concepts: codes and titles) in `backend/seed/atlas-base.json`, read from WHO's simple tabulation `SimpleTabulation-ICD-11-MMS-en.txt`, release 2026-01 ("Version:2026 Jan 17"). They are shown on the atlas, in search, in exports, and in the static demo.
- Source: International Classification of Diseases, 11th Revision (ICD-11), Mortality and Morbidity Statistics, World Health Organization, https://icd.who.int/browse/latest-release/mms/en.
- Licence: Creative Commons Attribution-NoDerivatives 3.0 IGO (CC BY-ND 3.0 IGO), https://creativecommons.org/licenses/by-nd/3.0/igo/. © World Health Organization. The codes and titles are used as published. The seed arranges them into the atlas hierarchy (chapters, blocks, conditions, and deeper categories) and also stores each title with "(ICD-11 category <code>)" appended as its fully specified name. The synthetic metrics, prevalence tiers, and everything else in the seed are not WHO material.

## Healthicons

- What: the ICD-11 chapter icons on the atlas ring and the chapter view, as SVG path data in `frontend/src/design/chapterIcons.js` (21 icons, unchanged; see the file header for the icon used per chapter).
- Source: https://github.com/resolvetosavelives/healthicons, commit `36887b268d2cb61f8d91622ad459bdf07910c2b0` (2026-07-28), `public/icons/svg/outline-24px/` and `public/icons/svg/outline/`.
- Licence: MIT.

```
MIT License

Copyright (c) 2021 Resolve to Save Lives

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Disease ontologies (contract v1.13, backend/CONTRACT.md §23)

None of these files is part of the source. `npm run ontologies:fetch` downloads the pinned releases listed in `scripts/ontologies/sources.json` into `backend/data/ontology-sources/` (ignored by git), and `npm run ontologies:import` reads them into a local store. The atlas names the ontology and its source next to the synthetic-data notice and in exports.

### MONDO

- What: the Mondo Disease Ontology, release v2026-10-06 (`mondo.obo`): term ids, labels, `is_a` parents, and cross-references (`icd11.foundation`, `ICD10CM`, `ICD10WHO`), shown as the MONDO hierarchy of the atlas and used for its crosswalk to ICD-11.
- Source: Mondo Disease Ontology, Monarch Initiative, https://mondo.monarchinitiative.org (https://github.com/monarch-initiative/mondo/releases/tag/v2026-10-06).
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/. Changes: the import keeps the human-disease terms, cuts the graph to chapters, blocks, and conditions (backend/CONTRACT.md §23.1), and shows labels with a capital first letter.

### ICD-10-CM

- What: the ICD-10-CM tabular list, fiscal year 2027 (`icd10cm-table-and-index-2027.zip`): chapters, sections, and three- and four-character codes with their titles.
- Source: International Classification of Diseases, Tenth Revision, Clinical Modification (ICD-10-CM), National Center for Health Statistics, Centers for Disease Control and Prevention, https://www.cdc.gov/nchs/icd/icd-10-cm/.
- Licence: public domain (a work of the US federal government).

### WHO ICD-10 to ICD-11 mapping tables

- What: the ICD-10 to ICD-11 mapping tables, release 2026-01 (`mapping.zip`: `10To11MapToOneCategory.txt`, `foundation_11To10MapToOneCategory.txt`), and the ICD-11 for Mortality and Morbidity Statistics codes they name.
- Source: World Health Organization, https://icd.who.int/browse/latest-release/mms/en (release files https://icdcdn.who.int/static/releasefiles/2026-01/mapping.zip).
- Licence: Creative Commons Attribution-NoDerivatives 3.0 IGO (CC BY-ND 3.0 IGO), https://creativecommons.org/licenses/by-nd/3.0/igo/. The tables are read unmodified at import time to resolve ICD-10-CM and MONDO codes to the ICD-11 atlas; no copy or adaptation of them is distributed with Broad Modelcard.
