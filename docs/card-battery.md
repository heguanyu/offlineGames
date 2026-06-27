# Card-game battery reduction — implementation plan

Goal: cut battery use of the card games (麻将 天津/国标/国标无定番, 斗地主, 掼蛋), driven by analysis in
this doc's sibling discussion. Three changes, in priority order.

## Findings (the costs)

1. **Always-on 60 fps render loop (dominant).** Every 3D scene calls `renderer.render()` every frame
   regardless of motion — `doudizhu/scene.js:441`, `guandan/scene.js:393`, `mahjong-common/scene.js:1048`.
   A card game is idle ~90% of the time, so most frames re-shade an unchanged table. Made worse on iPad
   by `setPixelRatio(min(dpr,2))` (4× fragment work on Retina), shadow maps (mahjong PCFSoft), antialias,
   tone mapping — all recomputed every idle frame.
2. **Second always-on loop: gamepad polling.** `pollPad()` runs its own perpetual rAF even on a
   touch-only iPad with no controller (`doudizhu/main.js:505`, + guandan/mahjong variants).
3. The flat 2D renderer (`scene2d.js`) is already event-driven (no rAF) → ~0 idle cost.

## Changes

### 1. On-demand rendering (both 3D tiers — biggest win, keeps the look)
Replace each scene's perpetual loop with a self-stopping one:
- `this._running=false`; `_kick()` starts the loop iff not already running.
- The loop does its animation math, renders once, then decides: if anything is still *active*
  (deal running, any card not within epsilon of its target pos/quat/scale, an `_fx` effect, a camera
  shake, an in-progress drag, or the turn-ring not yet at its target angle) → schedule the next frame;
  else → stop (`_running=false`).
- **Cosmetic pulses freeze when idle.** The turn-ring "breathing" + selection-outline glow are
  `sin(time)` opacity loops that would otherwise render forever. When settled we stop the loop, freezing
  those at a fixed opacity (position/seat still shown) — an acceptable trade for idling the GPU.
- Call `_kick()` from every state entry point: `sync`/`setState`, selection change, deal start, fx/shake
  start, turn-ring retarget, drag move, `resize`. Missing a kick = a frame that doesn't repaint, so audit
  each scene's public mutators.

Risk: e2e tests wait on animations/screenshots — they must still settle. Keep behavior identical while
*moving*; only idle frames are removed. Run each game's e2e after the change.

### 2. Gate gamepad polling on connect/disconnect
Only poll while a pad is present: start `pollPad` on `gamepadconnected`, stop on `gamepaddisconnected`
(and kick once at load if `getGamepads()` already shows one). On iPad (touch) it then never runs.

### 3. 省电模式 (power mode) — a shared 3-tier setting
`流畅 (3D) / 均衡 (省电 3D) / 省电 (2D)`, persisted, surfaced in each game's settings.
- New shared helper `games/common/power-mode.js`: `getPowerMode()` / `setPowerMode()` (localStorage,
  one key shared across games), default per device (see below), + `apply3DProfile(renderer, mode)` that
  sets pixelRatio/shadows/AA for the 3D tiers.
- **均衡 (省电 3D):** pixelRatio→1 (no Retina super-sampling), shadow maps off, antialias off, slightly
  lower lerp rate. ≈½–¾ the per-frame fill of 流畅, still 3D.
- **省电 (2D):** force the existing flat renderer regardless of screen size; scale it up to fill an
  iPad (the flat CSS is phone-sized today — add a viewport-scaling pass so tiles/cards read well at
  ≥744px). Near-zero idle cost.
- **Renderer choice** moves from the current width-only `FLAT` check to: `省电 → 2D`; otherwise the 3D
  scene with the tier's profile. `?flat=1`/`?d3=1` still override for tests.
- **Default tier:** phones stay 2D (as today). Tablets/desktop default to **均衡** (keeps 3D, saves
  battery via on-demand + pixelRatio cap — strict win, minimal visual loss). Users can pick 流畅 or 省电.

## Rollout / testing
Implement per family, test before moving on: (a) doudizhu, (b) guandan, (c) mahjong-common (covers all
three mahjong variants). Order within a family: on-demand rendering → gamepad gate → power-mode wiring.
Keep all existing e2e green; add a small test asserting the loop stops when idle (frame counter stops
climbing after things settle) and restarts on a state change.
