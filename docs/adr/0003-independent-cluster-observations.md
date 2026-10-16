# Accept cluster query observations independently

Distinguish remote cluster reachability from the success of individual scheduler queries. Accept each valid query observation independently: a failed jobs query preserves the jobs notification baseline while a successful accounting query may still advance terminal-job observations. Rejecting the entire cluster observation would discard useful independent evidence; treating remote execution as proof of scheduler success can erase a baseline and cause false job-start alerts.

Reject the entire jobs observation if any job row is malformed rather than silently dropping that row. Only a successful, complete query with zero rows establishes an empty job list. This trades temporary data unavailability for preserving the distinction between a job disappearing and Hearth failing to observe it.

Retain a completed, validated query result even if a later query times out or the connection breaks. Each accepted result must carry explicit evidence of its own successful completion; missing status, truncated output, and legacy payloads without explicit job validity cannot replace the jobs baseline. Collection remains subject to one bounded deadline.

The dashboard shows unavailable jobs and their derived fields as unavailable rather than retaining stale jobs or inventing empty results. Independently valid node information remains usable. Failed start-time estimates and display-name enrichment do not invalidate the main job list.

Confirmed remote execution is evidence of credential recovery even if a scheduler query fails. Scheduler degradation is separate: missing primary jobs or node observations degrades the display, while failures of optional enrichment and accounting are diagnosed individually. Prioritize jobs and accounting before node data and optional enrichment within the existing bounded execution model.

