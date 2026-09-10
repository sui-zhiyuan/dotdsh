// dotdsh UI tweaks — node half.
//
// This package is dual-face: the row the Loader mounts is THIS file, while every
// tweak ships through `exports["./client"]` (client/index.js). The empty apply is
// deliberate — the row is what makes dsh's client-modules scan pick the package
// up among the active Loader entries and add its browser half to the boot graph,
// so the host side has nothing of its own to do.
//
// One consequence is worth knowing: a client half cannot read this row's
// `config` (the boot graph carries id/url/rev/inject/external/immediately and no
// config), so a tweak is enabled by the package's presence and turned off per
// profile through that profile's own cordis.patch.yml
// (`- {id: ui-tweaks, disabled: true}`).

// cordis plugin: the name follows dsh's convention (package name minus scope and
// prefix: @dsh-external/dotdsh-ui-tweaks → ui-tweaks).
export const name = "ui-tweaks";

/** Host plugin body — this package contributes browser behaviour only. */
export function apply(): void {}
