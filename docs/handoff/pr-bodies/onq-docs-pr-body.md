Aligns the generic calendar interaction rule with the detailed DS-DATEPICKER contract: dates display as YYYY.MM.DD, remain YYYY-MM-DD through component/API boundaries, and cannot be typed or pasted into the field. The SearchBox native-date comment and existing native-date call sites remain queued for their component/screen owners. HANDOFF now marks merged #889 complete and queues date/time modernization to the existing layout owner.

Validation: git diff --check passed; branch parent is latest origin/main 4a06ba9016dae9784774329c1e253ecc92b0c9d3. Docs-only; no app tests run.
