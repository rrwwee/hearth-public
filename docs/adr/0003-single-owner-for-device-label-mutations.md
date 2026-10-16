# Give device-label mutations one owner

One shared owner serializes manual edits and inferred-alias mutations within a single running Hearth process. Atomic file replacement alone cannot prevent independent read/modify/write operations from discarding each other's changes. The Python agent becomes read-only, including when configuration is missing, so it cannot race the owner by initializing an empty file. Concurrent external writers are unsupported; direct file edits require stopping Hearth.

Manual edits replace or remove saved labels for the supplied addresses. Inference fills only absent labels and never replaces an existing one, regardless of its origin. Removal does not create a permanent suppression marker and does not erase observed names or presence history; later inference can populate the address again. This preserves the flat address-to-label model without introducing provenance or a separate suppression concept.

This replaces the alias-overwrite behavior preserved during the [shared presence extraction](0001-shared-presence-model.md). Mutations compare address keys case-insensitively; manual edits coalesce only the supplied addresses into lowercase entries. Existing string values, including empty ones, and untouched keys remain valid. The Python agent and dashboard keep their existing naming precedence and cache behavior.

Only a genuinely missing file represents empty configuration. Invalid or unreadable configuration must surface an error without replacement, and successful mutations preserve unrelated fields. Retain atomic replacement and temporary-file cleanup without adding a power-loss durability guarantee. Preserve the current failure boundary in which an inferred-alias write failure prevents that network observation draft from being committed.
