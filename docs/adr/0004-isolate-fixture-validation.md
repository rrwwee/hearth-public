# Isolate fixture validation from target installation settings

Fixture validation removes inherited `HEARTH_*` and `PORT` settings and preserves isolation from inherited Git repository overrides. Fixtures explicitly supply their own settings. Keep ordinary runtime settings such as `PATH` and `HOME`: a minimal environment allowlist or general process sandbox would expand this fix beyond the observed deployment-setting leak. Live-configuration validation continues to receive the actual target configuration and paths.

Keep the existing deployment receipt phase `validation`, adding a durable step identifier and named failure output for syntax checks, fixture tests, and live-configuration validation. Existing receipt readers and reconciliation recognize a fixed set of phases, so new phase names would create an unnecessary compatibility change.

