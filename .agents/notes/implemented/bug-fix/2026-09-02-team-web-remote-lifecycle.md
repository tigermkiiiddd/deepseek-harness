# Agent Note: Mount the native Team Web UI through a generated Remote lifecycle

Status: implemented

English | [中文](2026-09-02-team-web-remote-lifecycle.zh.md)

## Problem

The native Team Web plugin depended on the removed API-proxy and client-runtime surfaces. After the upstream Client assembly changed, its browser entry could either fail module materialization or disappear from the Web profile, while a raw source copy still compiled against package names and slots that no longer existed. The host Team service also had no browser-safe generated Remote contribution, so restoring only the UI bundle rows could not produce a loadable feature.

## Decision

`@deepseek-ai/dsh-team` owns a generated `team` Remote namespace with browser-safe roster and topic rows. `@deepseek-ai/dsh-client-ui-team` mounts that contribution first, creates its controller only after `remote.team`, sessions, and slots are available, and registers the lane in `sidebar.footer.action`. Disposal releases the controller and slot before unmounting the Remote contribution. The Web bundle includes the Team service, Team tools, and Team UI together.

The desktop launcher uses the authenticated URL printed by the source-launched Web profile as its readiness signal and performs a clean replacement of the existing DSH Web main process on its fixed port. Browser bundles rely on materialized package factories rather than dynamic workspace requires.

## Testing

The Team UI facade, controller, and component tests cover Remote failure unwrapping, member-session selection, roster management, and rendering. A production Web build and a Chrome smoke through the desktop launch path verify that the page contains the Team controls with no plugin-load or console error.

## Alternatives considered

**Restore the removed API-proxy methods and client-runtime aggregate.** Rejected: those packages are no longer the owning upstream interfaces, and reviving them would create a compatibility layer around native code that can use the current Remote and Session Controller services directly.

**Add Team to the global API Remote assembly.** Rejected: Team is a native optional feature selected by the Web bundle. Its UI mounts its own generated contribution, keeping the base Client assembly independent of Team.

## Consequences

The native Team feature remains optional but loads as one complete Host/Browser slice. Its browser data is explicitly serializable, UI construction cannot race the Remote namespace, and teardown cannot leave UI consumers attached to an unmounted namespace. Team package builds must emit the generated Typert host and remote-client artifacts before Web packaging.
