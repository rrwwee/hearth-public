# Publish reviewed snapshots from private development

Keep the private repository as the development source of truth and publish occasional reviewed snapshots with independent public history. The private history contains sensitive information, so the initial public candidate starts from a fresh root, and subsequent updates preserve public history without importing private ancestry. Prefer an agent-guided review for each export over building reusable export automation now.

Retain the sanitized implementation and its tests, including live-capable code, while promising a fictional local demonstration to the public audience. Demo and live behavior already have a runtime boundary and share modules; stripping live functionality would add a separate maintenance burden without serving that audience. Public documentation emphasizes the demonstration and useful architecture rather than private operational records or a supported live-installation onboarding path.

Keep exact private-to-public revision mappings, export transformations, and detailed review and verification evidence in the private repository. Public snapshots contain sanitized release information and retain the license and required attribution. Preparing a candidate does not authorize publication, repository settings changes, or live deployment.
