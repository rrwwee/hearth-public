# Pause notification work on invalid configuration

An absent notification configuration means disabled, while malformed or unreadable configuration is an error. Keep the dashboard available, pause notification monitoring and delivery at configuration-check boundaries, preserve pending records, and automatically resume after a valid correction. Continuing with old delivery settings could send to a destination the operator intended to remove; stopping the whole dashboard would unnecessarily remove unrelated functionality.

Dashboard presence projection may retain the last valid presence policy in memory, using documented defaults before any valid policy has loaded. This read-only fallback does not authorize collection or delivery with stale settings and does not change persisted-state compatibility. Use the existing diagnostic log/API for errors and recovery, without exposing raw configuration or credentials.

Enabled notifications require an explicit endpoint. Remove the runtime's implicit public endpoint even though configurations that relied on it must be corrected: a visible configuration error is preferable to silently choosing a public destination.
