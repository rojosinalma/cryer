# cryer 0.4.1

Image: `ghcr.io/rojosinalma/cryer:0.4.1` (`linux/amd64`, `linux/arm64`). Licence: AGPL-3.0.

## Highlights

- cryer is now released under the **AGPL-3.0** (was MIT): `LICENSE`, `package.json` and the image label
  `org.opencontainers.image.licenses=AGPL-3.0-only`.
- README restructured — requirements with minimum versions, installation, usage, development — plus
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates and Dependabot.
- `run-tests` runs on pull requests and pushes to `main` only; both workflows carry run names.

## Breaking changes

None in behaviour. If you redistribute cryer or run a modified copy as a network service, the AGPL-3.0
terms now apply: the source of your modifications has to be made available to its users.

## Upgrade

Set the image tag to `0.4.1` and `docker compose up -d`. No schema or settings changes.

Full changelog: [CHANGELOG.md](https://github.com/rojosinalma/cryer/blob/main/CHANGELOG.md#041---2026-10-16).
