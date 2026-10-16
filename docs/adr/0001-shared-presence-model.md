# Share one presence model between tracking and dashboard projection

Hearth's monitor and dashboard currently interpret presence separately. One pure module will own presence transitions and dashboard interpretation, with explicit observations, prior state, policy, and time as inputs. Network and Bluetooth collection, persistence, alias writes, HTTP formatting, and notification delivery stay outside that module. Extracting only shared helpers would leave callers responsible for coordinating the same rules. Preserve the existing API shape and persisted-state compatibility; include behavior corrections only when individually agreed and covered by reproducing tests, while keeping notification retry and checkpoint behavior in its own module.

## Agreed behavior

- Preserve notification-enabled gating of background presence tracking. Independent tracking would add scanning and state writes when notifications are disabled and is a separate product change.
- Require consecutive observations for pending arrival and return confirmation. A successful scan that misses the device resets confirmation progress; a failed scan supplies no presence evidence.
- Measure a return's absence from the last observation before departure to the first observation on return. Start the new presence session at that first return observation, independent of when confirmation completes.
- Use observation timestamps for presence evidence. Convert scan timestamps from seconds to milliseconds at the model boundary, and retain seconds in the existing HTTP response fields. Repeated or older snapshots do not advance confirmation or refresh last-seen times. Dashboard status ages from the actual observation time. Failed scans are not empty successful scans.
- Preserve the current neighbor-table fallback, single-candidate address inference, ambiguous labels, alias behavior, retention rules, and legacy-state migration. Bluetooth remains contextual evidence, not identity proof.
- Preserve a quiet initial baseline, so devices already present when tracking begins do not generate new-device alerts.

## Verification boundary

Keep tests isolated from the live dashboard and VPN. Collection, persistence, and delivery remain outside the pure presence model.
