# Conformance manifest pinned to Overlord contract v27

## Summary

Racecar's root `conformance-manifest.yaml` declared `contractVersion: '4'` while
Overlord's machine-readable contract (`contract/components.yaml`) is at `'27'`.
The manifest pin and the vendored runner claim response were brought inline.

## Changes

- `conformance-manifest.yaml`: bump `contractVersion` from `'4'` to `'27'`; annotate
  claim/status/failed endpoints with vendored type names.
- `packages/gateway/src/overlord-runner-contract.ts`: vendor additive claim-response
  fields from contract v23 (`longPoll`, nullable `request`).
- `packages/gateway/src/main.ts`: treat empty claims as `request == null`.

## Validation

- `ovld contract check conformance-manifest.yaml` → valid
- `yarn typecheck` → clean
