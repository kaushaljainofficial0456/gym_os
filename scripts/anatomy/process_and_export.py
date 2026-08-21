"""
Isolate the surface-muscular subset of the Z-Anatomy working copy, join each
canonical muscle's sub-parts per side, decimate to a real-time-safe budget,
assign one shared neutral material, and export a web-ready GLB.

Never saves the .blend file (no bpy.ops.wm.save_mainfile call anywhere) --
runs entirely in memory against the WORKING COPY given on the command line,
so both the pristine original and the working copy stay untouched on disk.
The only new file this script writes is the GLB + a JSON processing log.
"""
import bpy
import json
import re
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
spec_path, glb_out, log_out = argv[0], argv[1], argv[2]

with open(spec_path, encoding='utf-8') as f:
    spec = json.load(f)

EXCLUDE_KW = ['insertion', 'artery', 'vein', 'nerve', 'plexus', 'ganglion', ' on ',
              'origin of', '-origin', 'phalanx', 'region', 'tendon']
GLOBAL_EXCLUDE_EXACT = {'longissimus thoracis'}
TARGET_POLYS = 9000          # was 3000 -- v1 read as flat/undefined; this
                              # keeps far more of the source sculpt's surface
                              # detail (striations, insertions, natural
                              # bulge) instead of smoothing it away.
BULK_SCALE = 1.08            # modest per-muscle inflate from each muscle's
                              # own center -- reads as more muscle mass and,
                              # since every muscle is a separate object,
                              # widens the natural seams between them
                              # (more "cut"/defined), without touching the
                              # underlying sculpt.

log = {"muscles": [], "errors": []}


def base_name(name):
    n = re.sub(r'\.\d{3}$', '', name)
    n = re.sub(r"'(\.[lr])$", r'\1', n)
    n = re.sub(r'\.[lr]$', '', n, flags=re.I)
    return n.strip()


def is_clean(name):
    low = name.lower()
    if any(kw in low for kw in EXCLUDE_KW):
        return False
    if re.search(r'\.\d{3}$', name):
        return False
    if base_name(name).lower() in GLOBAL_EXCLUDE_EXACT:
        return False
    return True


def enable_all_collections(layer_coll):
    layer_coll.exclude = False
    layer_coll.hide_viewport = False
    for child in layer_coll.children:
        enable_all_collections(child)

print("Enabling every collection in every scene's view layer...")
for scene in bpy.data.scenes:
    for vl in scene.view_layers:
        enable_all_collections(vl.layer_collection)
print("Enabled.")

# also force every collection itself (not just the layer-collection wrapper)
# to not be hidden, and every object to not be hidden -- belt and suspenders,
# since Z-Anatomy ships with most of the file toggled off for its own
# interactive show/hide UI.
for coll in bpy.data.collections:
    coll.hide_viewport = False
for obj in bpy.data.objects:
    try:
        obj.hide_set(False)
    except RuntimeError:
        pass
    obj.hide_viewport = False
    obj.hide_select = False

print("Indexing collection membership for", len(bpy.data.objects), "objects...")
obj_colls = {}
for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue
    obj_colls[obj.name] = set()
for coll in bpy.data.collections:
    for obj in coll.objects:
        if obj.name in obj_colls:
            obj_colls[obj.name].add(coll.name)
print("Indexed.")


def matches(obj, m, side=None):
    name = obj.name
    if side is not None:
        # per-side muscles must be an explicit .l/.r object -- an unsided
        # match here would silently get assigned to only one side.
        if not re.search(r'\.[lr]$', name, re.I):
            return False
        if not name.lower().endswith(f'.{side}'):
            return False
    if not is_clean(name):
        return False
    low = name.lower()
    for kw in m.get('exclude_name_contains', []):
        if kw.lower() in low:
            return False
    ocolls = obj_colls.get(name, set())
    bn = base_name(name).lower()
    coll_ok = bool(m.get('collections')) and bool(ocolls & set(m['collections']))
    name_ok = bool(m.get('name_contains')) and any(bn == kw.lower() for kw in m['name_contains'])
    if m.get('collections') and m.get('name_contains'):
        return coll_ok and name_ok
    if m.get('collections'):
        return coll_ok
    if m.get('name_contains'):
        return name_ok
    return False


# one shared neutral "muscle" material, glTF-compatible (Principled BSDF nodes)
mat = bpy.data.materials.new("SKOS_Muscle")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.62, 0.60, 0.57, 1.0)  # neutral
                                                 # grey clay, not muscle-red
                                                 # -- matches the reference
                                                 # sculpt's render style;
                                                 # user-approved over red.
bsdf.inputs["Roughness"].default_value = 0.35
for spec_key in ("Specular", "Specular IOR Level"):
    if spec_key in bsdf.inputs:
        bsdf.inputs[spec_key].default_value = 0.5
        break

final_objects = []


def build_one(cands, out_name, decorative=False):
    for o in cands:
        o.hide_set(False)
        o.hide_viewport = False
        o.hide_select = False

    bpy.ops.object.select_all(action='DESELECT')
    for o in cands:
        o.select_set(True)
    bpy.context.view_layer.objects.active = cands[0]

    polys_before = sum(len(o.data.polygons) for o in cands)

    if len(cands) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = out_name

    # force single-user mesh data -- a joined object can still end up
    # sharing its mesh datablock with an unrelated object elsewhere in
    # this 2650-object file, and modifier_apply refuses multi-user data.
    joined.data = joined.data.copy()

    joined.data.materials.clear()
    joined.data.materials.append(mat)

    # bulk it up: recenter this muscle's own origin to its own geometry,
    # then scale it up from that center. Rigid, so it never corrupts
    # topology -- and because every muscle is already its own separate
    # object, inflating each one independently widens the seams between
    # neighbours instead of closing them, which reads as more definition,
    # not just "bigger".
    bpy.context.view_layer.objects.active = joined
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    joined.scale = (BULK_SCALE, BULK_SCALE, BULK_SCALE)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    polys_after_join = len(joined.data.polygons)
    npoly = polys_after_join
    if npoly > TARGET_POLYS:
        ratio = max(0.03, min(1.0, TARGET_POLYS / npoly))
        mod = joined.modifiers.new("Decimate", 'DECIMATE')
        mod.ratio = ratio
        bpy.ops.object.modifier_apply(modifier=mod.name)

    final_objects.append(joined)
    log['muscles'].append({
        "id": out_name, "decorative": decorative,
        "source_objects": len(cands),
        "polys_before_join": polys_before,
        "polys_after_join": polys_after_join,
        "polys_after_decimate": len(joined.data.polygons),
    })
    print(f"OK  {joined.name:28s} src={len(cands):3d} before={polys_before:7d} after={len(joined.data.polygons):6d}")


for m in spec['muscles']:
    if m.get('combine_sides'):
        cands = [o for o in bpy.data.objects if o.type == 'MESH' and matches(o, m)]
        if not cands:
            log['errors'].append(f"{m['id']}: no candidates matched")
            print("EMPTY:", m['id'])
            continue
        build_one(cands, m['id'], decorative=m.get('decorative', False))
        continue

    for side in ['l', 'r']:
        cands = [o for o in bpy.data.objects if o.type == 'MESH' and matches(o, m, side)]
        if not cands:
            log['errors'].append(f"{m['id']}.{side}: no candidates matched")
            print("EMPTY:", m['id'], side)
            continue
        build_one(cands, f"{m['id']}.{side}", decorative=m.get('decorative', False))

print("Total final objects:", len(final_objects))
print("Total final polys:", sum(len(o.data.polygons) for o in final_objects))

# Rather than trust the exporter's use_selection flag (it did not actually
# restrict the export in an earlier headless run -- the GLB came out full of
# unrelated Z-Anatomy objects like "Skin_Generated_Mesh_From_X3D.063" and UI
# button meshes), delete every object that is NOT one of our final joined
# muscles. Nothing is ever saved back to the .blend, so this is consequence-
# free for the working copy on disk -- it only shapes what gets exported.
keep_names = {o.name for o in final_objects}
to_remove = [o for o in bpy.data.objects if o.name not in keep_names]
print(f"Removing {len(to_remove)} non-muscle objects before export (keeping {len(keep_names)})...")
for o in to_remove:
    bpy.data.objects.remove(o, do_unlink=True)
print("Objects remaining in file:", len(bpy.data.objects))

bpy.ops.object.select_all(action='SELECT')
if final_objects:
    bpy.context.view_layer.objects.active = final_objects[0]

export_ok = False
last_err = None
try:
    bpy.ops.export_scene.gltf(filepath=glb_out, export_format='GLB', export_apply=True)
    export_ok = True
except Exception as e:
    last_err = str(e)

if not export_ok:
    log['errors'].append(f"GLB export failed: {last_err}")
    print("EXPORT FAILED:", last_err)
else:
    print("EXPORTED:", glb_out)

log['final_object_count'] = len(final_objects)
log['final_total_polys'] = sum(len(o.data.polygons) for o in final_objects)
log['export_ok'] = export_ok

with open(log_out, 'w', encoding='utf-8') as f:
    json.dump(log, f, indent=2)

print("WROTE_LOG:", log_out)
