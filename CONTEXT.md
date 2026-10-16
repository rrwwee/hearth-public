# Hearth

Hearth is a household dashboard with a private installation and a public demonstration mode.
It brings local-device presence, host telemetry, cluster workloads, and remote-access status into one dashboard.

## Language

**Public demonstration**:
A version of Hearth that presents the dashboard using fictional data without access to a private installation. Its audience is evaluating the dashboard, rather than setting up a live installation.

**Public snapshot**:
A reviewed copy of selected Hearth source and documentation intended for public demonstration, with history independent of private development. It can be refreshed from a later private revision without importing that revision's ancestry.

**Privileged dashboard source**:
The Hearth host or an explicitly admitted remote device from which diagnostics, manual label edits, and password actions may be requested. Admission trusts the device's callers; it does not authenticate an individual person.

**Trusted dashboard proxy**:
An explicitly admitted intermediary that restricts its callers before forwarding dashboard requests and replaces caller-supplied forwarding metadata. Encrypted transport alone does not make a proxy or its callers trusted.

**Device label**:
A saved name associated with a device address. A device label can be supplied by a manual edit or inferred from another observed address.

**Manual label edit**:
A user's replacement or removal of saved labels for the supplied device addresses. Removing a saved label does not prevent later inference from supplying one.

**Inferred alias**:
A device label learned from an inferred relationship between observed addresses. It fills an address without a saved label and does not replace an existing label.

**Scan observation**:
A report that a network scan saw a device at a particular time. An observation is evidence used to interpret presence.

**Dashboard status**:
The online or offline indication shown for a device, including the grace period after its last observation. Offline status can precede the device becoming away.

**Confirmed presence**:
Presence that has met the required threshold of consecutive observations for a new arrival or return. A single observation can make a device visible before its presence is confirmed.

**Away**:
A device's absence after the configured interval without an observation. Becoming offline alone does not mean the device is away.

**Presence session**:
A continuous period of device presence that spans transient absences and ends when the device becomes away. A return after becoming away starts a new session.

**Presence policy**:
The configured rules for confirming device presence, interpreting absences, relating observed addresses, and retaining unnamed devices on the dashboard.

**Cluster job alert**:
A notification about the user's own job starting or reaching a terminal state.

**Cluster reachability**:
Evidence that Hearth reached the remote cluster and received a response. Reachability does not imply that a scheduler query succeeded.

**Cluster query observation**:
The result of an individual cluster query, accepted independently of other query results. An unavailable observation supplies no evidence that the queried data is empty.

**Valid empty job observation**:
A successful, complete job query that reports no jobs. Malformed or incomplete job output is not a valid empty job observation.

**First-seen alert**:
A notification that a network device has satisfied Hearth's existing confirmation rules for being seen for the first time.

**Network activity summary**:
A notification of recorded device departures and returns during a completed hour.

**Observed credential need**:
The VPN or cluster credentials identified as needing attention by a particular cluster observation. An observation that identifies no credential need does not by itself establish recovery or end an existing password reminder episode.

**Password reminder episode**:
A continuous period in which Hearth observes that VPN or cluster credentials need attention. Confirmed recovery or a change in which credentials are needed ends the episode; a failed observation does not.

**Release**:
A version of Hearth identified by its source commit and prepared for use by a private installation.

**Selected release**:
The release chosen for the installation. A selected release need not currently be running.

**Activation**:
The change that selects a prepared Hearth release and verifies that it can run in the installation.

**Rollback**:
Restoration of the installation's configuration, selected release, and service policy after activation fails.

**Autostart policy**:
Whether the installation is configured to start Hearth automatically. This is separate from whether Hearth is running now.

**Source checkout**:
The trusted local repository whose committed history supplies the release chosen for deployment. Uncommitted and untracked files are not part of that release.

**Bundle deployment**:
A deployment that transfers a chosen committed release from a source checkout to an installation as a Git bundle.

**Fixture validation**:
Verification of a candidate Hearth release using controlled examples and temporary installations that are independent of the target installation's settings and data.

**Live-configuration validation**:
Verification that a candidate Hearth release can use the actual target installation's configuration and required paths before activation. It does not establish the health of external services.

**Unknown deployment outcome**:
A deployment whose final activation or recovery result has not been established. A lost connection alone does not establish success or failure.

**Deployment attempt**:
One identified attempt to deliver and activate a chosen release in an installation, including any rollback needed by that attempt.

**Deployment receipt**:
A retained account of a deployment attempt's chosen release, transfer integrity, progress and outcome. Its outcome can remain unknown until reconciliation.

**Deployment reconciliation**:
Establishing the result of an unresolved deployment attempt by inspecting the installation and its recovery evidence.

**Installation evidence**:
Observed facts about an installation's configuration, selected and running releases, and autostart policy, used to verify activation, rollback, or deployment reconciliation. Retaining evidence alone does not establish a deployment outcome.

**Implementation handoff**:
The delivery of Hearth work at the endpoint agreed for its task: a pull request, local-only work, a historical review, or post-merge verification. A handoff does not itself authorize merging or deployment.

**Handoff readiness**:
Evidence that Hearth work has met its agreed handoff endpoint. It is distinct from GitHub's merge eligibility and keeps observed facts separate from supplied reviewer assertions.
