# vicoop-codex-cli

## 0.8.1

### Patch Changes

- Remove the unused A2A surface from `serve` ([#40](https://github.com/planetarium/vicoop-codex-cli/pull/40)).

## 0.8.0

### Minor Changes

- `serve`/responses: abort the upstream `/responses` call on client disconnect and retry on stall ([#38](https://github.com/planetarium/vicoop-codex-cli/pull/38)).

## 0.7.2

### Minor Changes

- responses: add a file sink for `[upstream]` logs ([#36](https://github.com/planetarium/vicoop-codex-cli/pull/36)).

## 0.7.1

### Minor Changes

- responses: instrument the raw upstream `/responses` call (first-byte / status / totals) ([#35](https://github.com/planetarium/vicoop-codex-cli/pull/35)).

## 0.7.0

### Minor Changes

- models: surface `context_window` on the models catalog ([#34](https://github.com/planetarium/vicoop-codex-cli/pull/34)).
