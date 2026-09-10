# Agent Note: Make the Windows Web desktop launcher build-aware

Status: implemented

English | [中文](2026-09-10-windows-web-launcher-build-preflight.zh.md)

## Problem

The Windows desktop shortcut launches the Web profile from TypeScript source, but that profile loads generated Host modules, browser package factories, and the Vite application. A source update can therefore leave the launcher executable while required artifacts are absent or belong to another commit. Deleted package directories can also retain generated residue that a workspace build mistakes for live packages.

## Decision

The desktop launcher treats the repository client build record as the version identity. Before replacing a running DSH Web main process, it compares the record's short Git commit with `HEAD`, checks the Vite entry page, and checks `lib/client.js` for every workspace package that declares `dsh.client`.

When any check fails, the launcher runs the locked dependency install, the repository-owned safe clean, and the complete repository build. A failed step prevents server startup and leaves the diagnostic visible for 20 seconds. `-ForceBuild` provides the same path for local source edits that do not change `HEAD`. A current and complete build starts without rebuilding.

The root Host tsdown defaults express `index`, `invariant`, and `startup` as independent character-class globs. This retains optional per-package entries and avoids brace expansion that Rolldown does not resolve on Windows. The safe clean removes manifest-less package directories only when they contain known generated residue.

## Testing

The source Web command reproduces missing client factories before a complete build and reaches authenticated HTTP readiness after the build. The Windows PowerShell 5.1 launcher covers the current-build fast path and the forced-build path; both start the fixed-port server, and `-Stop` releases it.

## Alternatives considered

**Launch without a build preflight.** Rejected because a valid TypeScript launcher file does not prove that its generated Host, browser, and Vite dependencies exist.

**Run only the Vite Web build.** Rejected because Vite consumes browser package factories and the source-launched Host consumes bundled package entry points; both are produced before the Vite pass by the complete build.

**Run the complete build on every launch.** Rejected because it adds dependency, native, TypeScript, bundle, and Vite work to an unchanged checkout. The build record and artifact checks make repeated launches fast while retaining an explicit rebuild option.

## Consequences

The first launch after an update can take several minutes and may need dependency network access. A same-commit local source edit is not inferred from Git dirty state; the operator uses `-ForceBuild`. Startup failures identify the build step before the launcher changes the running server process.
