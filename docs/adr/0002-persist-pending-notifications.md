# Persist pending notifications and retry uncertain deliveries

Retain observed notifications in durable pending records, including their stable identity and message. A failed send must remain retryable across subsequent source snapshots and process restarts: a reproduced failed job-start alert disappeared permanently when the job left the next snapshot, so reconstructing retries from current observations is insufficient.

Retry automatically with the same identity if the notification endpoint may have accepted a request but Hearth did not checkpoint the success. This accepts possible duplicate delivery rather than silently losing the alert. Endpoint acceptance is the delivery boundary; it does not prove that a person's device displayed the notification, and sequence identifiers do not establish exactly-once remote delivery.

## Password reminders

Cancel a pending password reminder after confirmed recovery or a change in which credentials are needed. Keep at most one pending reminder for the current episode, and measure the next reminder interval from successful delivery. A collection failure alone does not end an episode.

## Hourly summaries

Retain and retry every already-pending hourly summary across hour boundaries and restarts. After monitoring downtime, generate a new summary only for the most recently completed hour; do not reconstruct every missed hour from retained observations.

Include the original covered time interval in each summary and retain it on retries. Keep the existing activity descriptions; an explicit interval makes delayed delivery understandable without claiming it describes the current last hour.

## Scheduling

Keep collection sequential under the existing command timeouts, with independent failure boundaries for cluster and network work. Attempt both collection domains before notification delivery. Bound retry work per pass so a delivery backlog cannot monopolize monitoring. This accepts the possibility that network collection waits for the cluster command timeout; independent collection schedules are outside this change.

## Delivery settings

Use the currently configured notification destination and credentials when attempting pending notifications, retaining the saved message and stable identity. Do not store credentials in pending records. Disabling notifications pauses monitoring and delivery without deleting pending records.

## State failures

Missing state initializes safely. Corrupt or unreadable state is surfaced without silently resetting or overwriting it. Observation progress and its pending notifications must be saved together before delivery; delivery success is checkpointed separately. A shared state-store failure stops further checkpoint writes and delivery for the pass, whereas a source or delivery failure stays local to the affected work.

