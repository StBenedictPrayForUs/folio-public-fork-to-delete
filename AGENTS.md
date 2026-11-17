# Working on Folio (notes for AI coding agents and maintainers)

This is a personal fork of [Forward-Future/folio](https://github.com/Forward-Future/folio), used on Windows. GitHub
is only a backup: there is no CI and no release pipeline. To build the app locally, run `npm run dist:win`.

## Keeping every platform working

- Platform differences live in a few places; check them when you touch related code:
  - `electron/main.cjs`: window chrome (`titleBarOverlay` on Windows/Linux, traffic lights on macOS), file opening
    (argv on Windows/Linux, `open-file` on macOS), install kinds and update behavior (`installKind`, `NOTIFY_ONLY`).
  - `src/platform.ts`: `keys()` writes shortcuts as ⌘/⇧ on macOS. Use it for every shortcut shown in the UI.
  - `package.json` `build.win` / `build.mac` / `build.linux`, `build/linux/*.tpl` (the .deb's install scripts).
- Paths shown to users differ per OS; don't hard-code Windows paths or "Explorer" in UI or docs.

## Updates

Installed copies (not portable ones) check upstream's releases at
[Forward-Future/folio-releases](https://github.com/Forward-Future/folio-releases) through electron-updater, using
`publish` in `package.json` and the auto-update code in `electron/main.cjs`.

## Pull requests

- Open a pull request only when asked. One request is one pull request; fix one problem in each.
- Title: what changes for the user, in plain words ("Keep text boxes when a document is reopened"). Pull requests are
  squash-merged, so the title becomes the commit message on `main`.
- The body follows `.github/pull_request_template.md`: the problem, the change, the issue or approval, and how you
  checked it, including which platforms. End with the model and harness that did the work.
- Visible changes need before/after screenshots attached to the pull request; never commit them.
- Don't change the version or the changelog in a pull request; maintainers update both when releasing.
- When reviewing an outside pull request, check for a duplicate open pull request or issue first, then whether it fixes
  one problem, has the approval it needs (see CONTRIBUTING.md), and shows evidence on the platforms it touches.

## Code style

Match the surrounding code: comments explain why, not what; user-facing text is plain and short.

## Testing

- **Every change:** `npm test` (vitest plus the Node-only `scripts/test-*` checks, about 10 seconds) and
  `npm run build`, which type-checks.
- **Changes to how the running app behaves** (UI, Electron main process, saving, printing, OCR): also `npm run smoke`.
  It runs the Electron smoke tests in parallel and takes about two minutes, so skip it for changes that can't affect
  the running app (docs, unit-tested pure logic, release scripts).
- Put new checks in the fastest place that can catch the bug: a vitest or `node --test` unit test first. Add to the
  smoke test only for behavior that needs the real app, and don't repeat there what a unit test already covers.

To check a change in the running app, use `npm run smoke` (extend it if it doesn't cover your change). It runs Folio
without a visible window (off-screen on Windows and Linux, never shown on macOS) and leaves the clipboard alone, so it
doesn't interrupt whoever is using the computer. A new script that launches Electron gets the binary from
`scripts/electron-path.mjs`, which keeps a hidden run out of the Dock on macOS. Don't open a visible window
(`npm run app`, `electron .`, `FOLIO_SMOKE_SHOW=1`) unless the user asks to see the app.
