# Require explicit source trust for privileged dashboard requests

Privileged dashboard requests are admitted from the Hearth host and explicitly configured remote device addresses. Do not infer admission from membership in the shared `100.64/10` address range or from a claimed HTTPS scheme. This deliberately gives up automatic admission of every overlay address: device-level trust is explicit and does not authenticate individual users or processes on an admitted device.

Configure admitted remote devices as exact IPv4 or IPv6 addresses, not network ranges or hostnames. Normalize equivalent address forms, reject malformed configuration at startup, and load changes on restart. Loopback is admitted by default.

Support a documented private proxy path with explicit trust configuration. Delegate caller admission to the configured proxy rather than maintaining another allowlist of forwarded client addresses in Hearth. Hearth verifies the immediate proxy peer and its forwarding metadata. The proxy must restrict its callers and replace caller-supplied forwarding headers; public, unauthenticated proxy access must not grant privileged actions. An undeclared proxy on loopback is indistinguishable from another trusted local program, so the host trust boundary includes responsibility for its local services.

The proxy preserves the external Host and supplies exactly one `X-Forwarded-Proto: https`. Reject missing, duplicate, comma-separated, or invalid scheme values from configured proxy peers. Forwarded client addresses and forwarded-host headers do not establish admission or the destination. Headers from other peers cannot expand their privileges.

Proxy classification takes precedence over direct-device and loopback admission. All protected requests from a configured proxy address must satisfy the proxy contract, including local command-line requests sharing that address. Recommend a distinct proxy source address when both direct and proxy paths are needed. Allowing fallback to direct admission would conceal a broken proxy contract.

Default the listener to `127.0.0.1`, requiring an explicit bind setting for remote access. Document the compatibility change for installations that relied on an omitted bind setting exposing all IPv4 interfaces.

Validate the request destination against allowed dashboard origins and compare any supplied Origin using scheme, hostname, and effective port. Derive local defaults and explicitly configure remote and proxy origins. Permit an absent Origin for command-line clients while still requiring an admitted source and allowed destination. Neither matching origins nor source admission authenticates a person.

Preserve direct HTTP over loopback and an encrypted private overlay. Operators must ensure the overlay transport protection: admission of an address does not prove encryption. Other remote access uses the private HTTPS proxy path.

Keep the protected surface limited to password actions, manual label edits, and diagnostics. Health and ordinary dashboard telemetry remain readable by clients that can reach the listener. Document this exposure alongside deliberate non-loopback binding.

Preserve the existing HTTP 400 access-failure status for password and label actions and HTTP 403 for diagnostics. Replace the misleading HTTPS-based messages with useful, credential-free reasons distinguishing an unapproved source, invalid proxy metadata, and an origin mismatch. Retain the password handler's local-agent restriction and required custom header, and preserve demo-mode isolation.

