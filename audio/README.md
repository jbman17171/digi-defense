# Swapping the sound effects

Everything the game plays is a file in this folder, listed in
[`sounds.json`](sounds.json). To change a sound:

1. Drop your file in this folder (`camp-flash-fps/audio/`).
2. Open `sounds.json` and put the filename next to the sound you're replacing.
3. Reload the page. That's it — no build step, nothing to install.

You never have to touch `game.js`.

## Two ways to do step 2

**Keep the name, skip the editing.** If you name your file exactly what's
already there — `shutter.ogg`, `whack.ogg` — it just replaces it and you can
skip straight to reloading.

**Or use any name and any format.** Put whatever you want in the folder and
point at it:

```json
"shutter": "my-better-shutter.wav",
"whack":   "big-thwack.mp3",
```

`.ogg`, `.mp3`, `.wav` and `.m4a` all work — whatever the browser can decode.
No need to convert anything.

## Random variants

A list means "pick one at random each time it plays", which stops a sound that
fires constantly from grating. Enemy hits already work this way:

```json
"hit": ["hit1.ogg", "hit2.ogg", "hit3.ogg"]
```

Drop in a fourth and add it to the list. Any sound can be a list — a couple of
alternate swings or footsteps go a long way.

## If a file is missing or broken

The game falls back to a built-in synthesized beep rather than going silent,
and logs which sound failed to the browser console (F12). So a typo costs you
one sound, not the whole game.

Setting a sound to `null` silences it deliberately:

```json
"thunder": null
```

## Every sound

### Weapons

| Name | Plays when | Wants to be |
| --- | --- | --- |
| `shutter` | Flash camera fires | Sharp mechanical *ka-chak*. Fires constantly — keep it short and not shrill. |
| `reload` | Flash finishes recharging | Capacitor whine or a film advance. |
| `laser` | Laser camcorder beam | Thin and quick. Plays many times a second, so quiet and short. |
| `swing` | Foam sword / racket swung | Air whoosh. |
| `whack` | Melee connects | Meaty foam thump. |
| `thunk` | SD card sticks in something | Dull impact. |

### Hitting things

| Name | Plays when | Wants to be |
| --- | --- | --- |
| `hit` | Any enemy takes damage | The most-heard sound in the game. Short, punchy, worth 3–4 variants. |
| `headshot` | Clean headshot | A reward — brighter and crunchier than `hit`. |
| `enemyDie` | Enemy goes down | Robotic power-down or a comic squelch. |
| `glass` | A computer screen shatters | Glass smash. |
| `explode` | Computer or crate blows up | Small punchy boom, not a movie explosion. |

### The player

| Name | Plays when | Wants to be |
| --- | --- | --- |
| `hurt` | You take damage | Grunt or impact. Keep it short — it stacks when swarmed. |
| `jump` | You jump | Light effort sound. |
| `land` | You hit the floor | Soft footfall thud. |
| `shield` | Shield potion picked up | Rising shimmer, protective. |
| `pickup` | Any dropped item stepped on | Short grab/collect blip. Plays under the item's own sound, so keep it quiet. |
| `oneup` | 1-UP mushroom picked up | Little victory jingle. |

### The world

| Name | Plays when | Wants to be |
| --- | --- | --- |
| `round` | A round starts, mystery box breaks | Short fanfare or stinger. |
| `portal` | Rainbow annex portal opens | Whoosh or magical swell. |
| `thunder` | Lightning during a storm round | Long rumble. Distance and rumble beat a sharp crack. |
| `doorOpen` | Garage door starts moving | Metal clunk as it takes up slack. |
| `doorClose` | Garage door settles shut | Clunk as it seats. |
| `doorMotor` | **Loops** while a garage door moves | Must loop seamlessly — a steady motor hum, no fade in or out at the ends. |

`doorMotor` is the only looping sound. If it clicks or pulses, the loop points
aren't clean; trim it to a whole number of cycles at a zero crossing.

## Where to find sounds

The current set is from [Kenney](https://kenney.nl/)'s game audio packs, all
CC0 (see `KENNEY-CC0-LICENSE.txt`). [Freesound](https://freesound.org/) has a
much bigger library — filter by CC0 so you don't have to credit anyone.

If you use something that needs attribution, add it to the credits line at the
bottom of `index.html`.

## Levels and pitch

Per-sound volume and pitch randomization live near the bottom of `game.js`, in
the block of `fxShutter` / `sfxLand` / `sfxEnemyHit` one-liners. The two
numbers after the name are volume (0–1) and playback rate:

```js
sfxEnemyHit = () => { playSfx('hit', 0.45, rnd(0.9, 1.2)); }
//                            name   vol   random pitch per shot
```

If a new sound comes in too loud, that number is the fix. Sounds that fire in
bursts also have a minimum retrigger gap in `SFX_GAP`, so they can't stack into
a buzzing wash.
