# 3D muscle-selection asset — source, licence, and pipeline

> **Current model: v2, `frontend/public/assets/anatomy/skos-body-v2.glb`** (2026-11-15).
> v1 (`skos-muscular-body.glb`, described further down) shipped 21 muscles as
> separate floating pieces: no head, hands or feet, a gap between every
> muscle, the left external oblique missing. v2 is one continuous sculpted
> body from the same Z-Anatomy data, cut into tappable regions.

## v2 — one sculpted body, tappable regions

Built by two headless Blender scripts (Blender 5.2), from the same read-only
working copy (`D:\Z-Anatomy-SKOS-working.blend`; neither .blend is ever
saved over):

1. **`scripts/anatomy/build_body_v2_stage_a.py`** — every structure in the
   muscular system plus the skull, hand/foot bones and eyes (teeth, vessels,
   nerves, the diaphragm and other deep sheets left out) is sampled into
   points and fused through a signed distance field: points → SDF (union of
   4.5 mm spheres, 2.2 mm voxels) → mean-smoothed → offset back 2.8 mm →
   mesh. Seams between neighbouring muscles close; the real anatomical
   grooves stay. Saves a small scratch .blend with the shell and, per
   tappable group, its source geometry for labelling.
2. **`scripts/anatomy/build_body_v2_stage_b.py`** — drops stray fragments,
   decimates to ~266k triangles, labels each vertex with the nearest real
   muscle (thin sheets left out; abs and lower back given ~12 mm priority
   over the aponeurosis/lat that covers them; the RIGHT half labelled from
   the anatomy and MIRRORED to the left, because Z-Anatomy is not
   symmetric), majority-filters the labels and absorbs specks, bakes Cycles
   ambient occlusion into vertex colours, sets custom normals on the whole
   surface (so splitting leaves no shading seams), splits into
   `<muscleId>.l` / `<muscleId>.r` plus `body`, and exports a Draco GLB
   (~1.5 MB) and `skos-muscle-map.json`.

```bash
blender --background D:/Z-Anatomy-SKOS-working.blend \
  --python scripts/anatomy/build_body_v2_stage_a.py -- \
  scripts/anatomy/muscle_spec.json D:/gym_tmp/anat/shell.blend
blender --background D:/gym_tmp/anat/shell.blend \
  --python scripts/anatomy/build_body_v2_stage_b.py -- \
  scripts/anatomy/muscle_spec.json \
  frontend/public/assets/anatomy/skos-body-v2.glb \
  frontend/public/assets/anatomy/skos-muscle-map.json \
  D:/gym_tmp/anat/preview 300000
```

"Upper back" (`rhomboids`) also takes teres major/minor and infraspinatus in
v2: the rhomboids sit under the trapezius and barely reach the surface.
The deep gluteus minimus never surfaces, so glutes are maximus + medius.

Licence and attribution below apply to v2 unchanged (same source data).

---

## v1 (superseded) — notes kept for the licence and history

## What this is

`frontend/public/assets/anatomy/skos-muscular-body.glb` is a web-ready 3D
model used by the trainer "Pick by muscle" panel in Build Workout
(`frontend/src/components/anatomy/MuscleBody3D*.jsx`). It is a decimated,
re-organized derivative of the **Z-Anatomy** anatomical model, isolated down
to 21 gym-relevant surface muscles (42 meshes — left/right pairs), each
individually selectable.

## Source and licence — read this before redistributing

- Upstream data: **BodyParts3D**, © The Database Center for Life Science,
  licensed under **CC Attribution-ShareAlike 2.1 Japan**.
- Mixed and modified by **Z-Anatomy** (z-anatomy.com) — cleaned/repaired
  meshes, renamed to Terminologia Anatomica (2nd ed., 2019), added
  materials and muscular insertions.
- Required attribution string (keep this intact wherever the asset is
  credited in-app or in docs):

  > "BodyParts3D, © The Database Center for Life Science licensed under CC
  > Attribution-Share Alike 2.1 Japan" mixed and modified by 'Z-anatomy.com'

- **CC BY-SA is a ShareAlike licence.** Any derivative built from this data
  — including `skos-muscular-body.glb` — is expected to be distributed
  under the same or a compatible licence. This project (SK OS) has decided
  to proceed on that basis; the full licence text is kept alongside the
  asset at `frontend/public/assets/anatomy/Licence.txt` and must ship with
  it if the asset is redistributed.
- Original source files (never modify these — see "Pipeline" below):
  `D:\Z-Anatomy.blend` (pristine, untouched), `Licence.txt`.

## Pipeline (how the GLB was built, and how to rebuild it)

1. `D:\Z-Anatomy-SKOS-working.blend` is a full copy of the original,
   created once so the pristine file is never opened for writing.
2. A Blender headless script (`scripts/anatomy/process_and_export.py`)
   loads the working copy **read-only in memory**
   — it never calls `save_mainfile`, so neither the original nor the
   working copy is ever modified on disk.
3. `scripts/anatomy/muscle_spec.json` declares, for each of the 21 target muscles, which
   Z-Anatomy collection(s) and/or exact object name(s) make up its left/
   right "belly" meshes (excluding insertion stubs, fascia, vessels,
   nerves, and Z-Anatomy's own duplicate/bonus-scene objects). This was
   derived by inspecting the file's real Terminologia-Anatomica collection
   hierarchy and object names, not guessed.
4. For each muscle/side: the matching source objects are joined into one
   mesh, renamed to `<muscleId>.l` / `<muscleId>.r`, recentred to its own
   geometry and scaled up 8% (`BULK_SCALE` — reads as more muscle mass, and
   since every muscle is still a separate object this widens the seams
   between neighbours instead of closing them), decimated to a
   ~9,000-triangle budget per mesh (Blender's Collapse decimate, ratio
   adapted per object — high enough to keep most of the source sculpt's
   surface detail rather than smoothing it away), and assigned one shared
   neutral PBR material (`SKOS_Muscle` — grey clay, not muscle-red; no baked
   labels/UVs needed since selection state is applied at runtime in the
   frontend, not baked in).
5. Every object that isn't one of the 42 final muscle meshes is deleted
   from the in-memory scene, then the file exports as GLB (`export_apply`
   applies modifiers). Nothing is written back to either `.blend` file.

Result: **360,329 triangles, ~6.85&nbsp;MB**, vs. the 356&nbsp;MB /
~7.7M-polygon source file — about 52× smaller by file size, still
comfortably real-time-safe for a single interactive prop.

A grey-clay + 3-point-studio-light render style was chosen deliberately —
Z-Anatomy has no skin/integument layer in this file, so a smooth
skin-covered sculpt (the original visual reference) isn't reachable from
this data without fabricating geometry, which this pipeline does not do.
The clay treatment is the closest honest match: same real geometry, a
render style closer to a sculpted anatomy reference than a flayed muscle
chart.

To rebuild (needs Blender 5.x and the working copy at
`D:\Z-Anatomy-SKOS-working.blend`):

```bash
blender --background "D:/Z-Anatomy-SKOS-working.blend" \
  --python scripts/anatomy/process_and_export.py -- \
  scripts/anatomy/muscle_spec.json \
  frontend/public/assets/anatomy/skos-muscular-body.glb \
  scripts/anatomy/process_log.json
```

## Muscle coverage

21 muscles × 2 sides, mapped to SK OS's real exercise taxonomy
(`skos-muscle-map.json`, keyed by muscle ID without the side suffix):

CHEST, FRONT/SIDE/REAR DELTS, TRAPS, LATS, UPPER BACK, CORE (serratus
anterior, obliques), ABS, LOWER BACK, GLUTES, QUADS, HAMSTRINGS, CALVES,
FOREARMS, BICEPS, TRICEPS — 17 of the app's 24 `primary_muscle` values.
Not represented by a single muscle mesh: UPPER CHEST / LOWER CHEST (pec is
shipped as one mesh, not split by head), SHOULDERS (covered by the three
delt heads), POSTERIOR CHAIN / FULL BODY / CARDIO / MOBILITY (not literal
prime-mover muscles).

## Known limitations (v1)

- `obliques.l` has no matching left-side "external oblique" object in the
  source file (only internal oblique) — a real asymmetry in Z-Anatomy's own
  data, not introduced by this pipeline. Cosmetic only.
- The two triceps-head objects living inside Z-Anatomy's "Triceps brachii
  muscle" collection are named "…biceps brachii…" in the source file (an
  upstream labelling mistake); they were joined into `triceps.*` by
  collection membership, not by name, and are correctly triceps geometry.
