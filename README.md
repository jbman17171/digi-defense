# DIGI DEFENSE — Camp Media Lab

A browser FPS set in the Camp Media Lab. Fight off waves of enemies with a flash
camera, a LARP foam sword, a tennis racket and a fistful of SD cards.

**Play it:** https://JBMAN17171.github.io/digi-defense/

Runs entirely in the browser — no build step, no dependencies to install.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| `Shift` | Sprint |
| `Space` | Jump |
| Click | Attack |
| `Tab` | Weapon wheel |
| `1`–`5` | Quick swap |
| `M` | Mute sound |
| `Esc` | Release cursor |
| `[` `]` | Graphics quality down / up |
| `F3` | FPS and render stats |

## Performance

The game guesses a graphics tier from your machine on first run and remembers
what you pick after that. If it runs badly, choose **LOW** on the start screen —
or press `[` in game.

| | LOW | MEDIUM | HIGH |
| --- | --- | --- | --- |
| Render resolution cap | 1x | 1.25x | 2x (retina) |
| Bloom | off | on | on |
| Shadows | off | 1024, every 3rd frame | 2048 soft, every frame |
| Room point lights | 1 | 5 | 11 |
| Texture ceiling | 512px | 1024px | 4096px |
| GPU texture memory | ~38 MB | ~63 MB | ~147 MB |
| Dust / precipitation | 0 / 600 | 260 / 1200 | 700 / 2200 |
| Looping TV clip | off | on | on |

On top of the tier, the renderer watches its own frame time and lowers or
raises the render resolution while you play. If it bottoms out and is still
below ~45 fps it starts switching effects off — bloom first, then shadows —
and tells you what it dropped.

`F3` shows FPS, frame time, the current resolution scale and the draw call
count. `window.digiPerf` in the console has the same numbers plus
`setQuality('low' | 'medium' | 'high')`.

## What's in it

- **Waves of enemies** that pour in through the garage doors, plus a boss, a
  wandering bear, a caterpillar that sheds a segment per hit, and a SpongeBob.
- **Mystery boxes** drop in mid-round. Flash or smash one open and the prize
  pops out Smash-Bros style — walk over it to use it, or leave it alone.
  Rewards include a laser camcorder, an exposure bomb, a Premiere "Timeline
  Runner" minigame, and a rare 1-UP mushroom.
- **Shootable computers.** Every iMac in the lab can be blown apart, and one
  random machine each round is hiding a shield potion.
- **Weather that changes every round** — clear, thunderstorm with real
  lightning, snow, wildfire haze, dead fog, and an aurora night.
- **The rainbow annex** across the ravine, which stays hidden until round 6
  when the bridge extends.

## Running locally

Any static file server works — the game uses ES modules, so opening
`index.html` straight off the filesystem won't work.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Credits

Built with [three.js](https://threejs.org/) (MIT).

Sound effects from [Kenney](https://kenney.nl/) game audio packs — Impact
Sounds, Sci-Fi Sounds, UI Audio, RPG Audio and Interface Sounds — all released
under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). See
`audio/KENNEY-CC0-LICENSE.txt`.

3D models:

- "Camera 01" by Poly Haven (CC0)
- "Sponge Neighbor - Rigged" by AndruBanana (CC-BY-4.0)
- "Animated Realistic Bear" by AnimalMesh 3D (CC-BY-4.0)
- "area 9 golf cart" by maxdragonn (CC-BY-4.0)
- "Dancing Alien" by nthmn.exe (CC-BY-NC-SA-4.0)
- "SanDisk SD Card" by Kiran Kumar (CC-BY-4.0)
