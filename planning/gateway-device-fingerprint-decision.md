# Gateway device fingerprint decision

## Status

Accepted for the gateway-runner-reuse plan. This resolves the stable-fingerprint
spike called out in [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

## Finding

The adopted `ovld` CLI currently computes its device identity locally; it does
not accept a fingerprint override. In version `0.2607121101.0`, its
`clientDeviceIdentity()` uses Node's `os.hostname()` and `os.platform()`, then
`@overlord/core/service/device-identity` calculates:

```
sha256(`${deviceLabel}:${devicePlatform}`).slice(0, 32)
```

The CLI sends that value in `x-overlord-device-fingerprint` on every backend
request. This is the value used by Overlord's
`ensureActingDeviceTarget` / `ensureDeviceTargetForFingerprint` lookup. A
container normally receives a deployment-specific hostname, so the stock CLI
would produce a different fingerprint after a redeploy and silently provision
another device/execution-target row.

`OVERLORD_DEVICE_FINGERPRINT` is not honored by this client version: it is not
read by `clientDeviceIdentity()` and is not a supported CLI flag for the
gateway-relevant protocol or runner commands. Setting it alone would therefore
not solve the problem.

## Decision

The Racecar gateway must supply an explicit, stable device fingerprint for its
own logical deployment. Add a small, maintained adaptation to the adopted
`ovld` client so `clientDeviceIdentity()` uses an explicit fingerprint override
when present (for example `OVERLORD_DEVICE_FINGERPRINT`), while retaining the
existing hostname/platform-derived behavior for ordinary developer CLI use.

The gateway should configure that override from a required
`RACECAR_GATEWAY_DEVICE_FINGERPRINT` setting and pass it only to the `ovld`
subprocess environment. The value should be a generated, opaque 32-hex
identifier stored as a durable deployment secret/configuration value. Generate
it once when provisioning the logical gateway and keep it unchanged through
container restarts, image rebuilds, rolling redeploys, and token rotation.

Use one fingerprint per logical gateway execution target, not per project,
sandbox, branch, image revision, or container instance. This matches the
intended one-target-many-projects model. If availability requires multiple
independently runnable gateway replicas, assign each replica a different
durable fingerprint deliberately; they are then separate Overlord targets and
must be managed as such.

Do not derive the fingerprint from the bearer token, container ID, pod UID,
hostname, build SHA, or project ID. Those values either rotate unexpectedly or
would incorrectly split the single target. A stable platform deployment ID may
be used as seed only when its immutability and uniqueness are guaranteed; a
random generated value is simpler and less coupled to infrastructure naming.

The gateway may still supply a human-readable device label separately (for
example `racecar-gateway-prod-us-east-1`); label changes must not change the
fingerprint. Fingerprint rotation is an explicit migration that creates a new
Overlord device/target row, so it should be avoided except when intentionally
replacing that logical target.

## Follow-on implementation requirements

- Add and test the explicit `ovld` identity override before making the gateway
  depend on it. The override must be forwarded in every HTTP request, including
  runner claim/status calls and `ovld protocol *` calls.
- Make `RACECAR_GATEWAY_DEVICE_FINGERPRINT` required in the gateway config and
  reject empty values. Keep the credential (`USER_TOKEN`) independent from the
  fingerprint so normal credential rotation retains the same target.
- Document provisioning: generate the value once, store it as a deployment
  secret, and reuse it across redeploys. Never log it alongside credentials.
- Add a smoke test that starts two fresh gateway processes with the same
  configured fingerprint and confirms they address the same device/target;
  separately prove that different configured fingerprints produce distinct
  targets.

