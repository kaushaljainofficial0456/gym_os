"""
BODY v2, STAGE A -- one continuous sculpted body from Z-Anatomy.

v1 (process_and_export.py) shipped 21 muscles as separate pieces: no head,
hands or feet, gaps between every muscle. v2 keeps the real geometry but
fuses EVERY superficial structure -- all muscles, plus the skull, hand and
foot bones and the eyes, so the figure is complete -- into one watertight
surface through a signed distance field:

    points on every source surface -> SDF (union of small spheres)
    -> smoothed -> offset back toward the true surface -> mesh

Small seams between neighbouring muscles close; the big anatomical grooves
(between pecs and delts, down the abs, along the shin) stay. That is the
look of a sculpted anatomy figure rather than a flayed chart.

Stage A does the expensive part once and saves a SMALL new .blend with the
fused shell plus, per tappable muscle group, its source geometry (needed by
stage B to label the shell). The Z-Anatomy files are only read: this never
saves over them (save_as_mainfile(copy=True) to a different path only).

    blender --background D:/Z-Anatomy-SKOS-working.blend \
      --python scripts/anatomy/build_body_v2_stage_a.py -- \
      scripts/anatomy/muscle_spec.json D:/gym_tmp/anat/shell.blend
"""
import bmesh
import bpy
import json
import re
import sys
import time

argv = sys.argv[sys.argv.index('--') + 1:]
SPEC, OUT = argv[0], argv[1]
RADIUS = float(argv[2]) if len(argv) > 2 else 0.0045      # sphere per surface point (m)
VOXEL = float(argv[3]) if len(argv) > 3 else 0.0022       # SDF resolution (m)
OFFSET = float(argv[4]) if len(argv) > 4 else -0.0028     # pull back toward the real surface
DENSITY = float(argv[5]) if len(argv) > 5 else 160000.0   # surface points per m^2
t0 = time.time()
log = lambda *a: print(f'[{time.time() - t0:6.1f}s]', *a, flush=True)

spec = json.load(open(SPEC, encoding='utf-8'))['muscles']
# v2: "Upper back" is what is VISIBLE between the traps and the lats -- the
# rhomboids sit under the trapezius, so on their own they barely surface.
for m in spec:
    if m['id'] == 'rhomboids':
        m['name_contains'] = m.get('name_contains', []) + ['Teres major muscle', 'Teres minor muscle', 'Infraspinatus muscle']
        m['collections'] = []

# ---- which objects make the body ----------------------------------------
def walk(coll, acc):
    acc.add(coll.name)
    for ch in coll.children:
        walk(ch, acc)
    return acc

roots = {c.name: c for c in bpy.data.collections}
include_colls = set()
for root in ('3:Muscular system', '1:Skeletal system'):
    if root in roots:
        walk(roots[root], include_colls)
skip_colls = set()
for root in ('Teeth', 'Arthrology'):
    if root in roots:
        walk(roots[root], skip_colls)

obj_colls = {}
for c in bpy.data.collections:
    for o in c.objects:
        obj_colls.setdefault(o.name, set()).add(c.name)

SKIP_WORDS = ('artery', 'vein', 'nerve', 'plexus', 'ganglion', 'line', 'plane', 'eraser', 'label', 'bursa', 'diaphragm',
              'intercost', 'pelvic floor', 'levator ani', 'coccygeus')

def wanted(o):
    if o.type != 'MESH' or not o.data.polygons:
        return False
    cs = obj_colls.get(o.name, set())
    if not (cs & include_colls) or (cs & skip_colls):
        return False
    low = o.name.lower()
    if any(w in low for w in SKIP_WORDS):
        return False
    return True

sources = [o for o in bpy.data.objects if wanted(o)]
eyes = [o for o in bpy.data.objects if o.type == 'MESH' and re.search(r'eyeball', o.name, re.I) and not re.search(r'\.\d{3}$', o.name)]
sources += [e for e in eyes if e not in sources]
n_sources = len(sources)
log('sources', n_sources, 'eyes', len(eyes))

# ---- per-group source sets (same matching rules as v1) -------------------
def base_name(name):
    n = re.sub(r'\.\d{3}$', '', name)
    n = re.sub(r"'(\.[lr])$", r'\1', n)
    n = re.sub(r'\.[lr]$', '', n, flags=re.I)
    return n.strip()

EXCLUDE_KW = ['insertion', 'artery', 'vein', 'nerve', 'plexus', 'ganglion', ' on ', 'origin of', '-origin', 'phalanx', 'region']

def matches(o, m):
    name = o.name
    if not re.search(r'\.[lr]$', name, re.I) or re.search(r'\.\d{3}$', name):
        return False
    low = name.lower()
    if any(k in low for k in EXCLUDE_KW):
        return False
    if any(k.lower() in low for k in m.get('exclude_name_contains', [])):
        return False
    bn = base_name(name).lower()
    coll_ok = bool(m.get('collections')) and bool(obj_colls.get(name, set()) & set(m['collections']))
    # EXACT names: "Extensor digitorum" (forearm) must not also take
    # "Extensor digitorum longus", which is in the shin.
    name_ok = bool(m.get('name_contains')) and any(bn == k.lower() for k in m['name_contains'])
    if m.get('collections') and m.get('name_contains'):
        return coll_ok and name_ok
    return coll_ok or name_ok

all_mesh = [o for o in bpy.data.objects if o.type == 'MESH']
groups = {}
for m in spec:
    hits = [o for o in all_mesh if matches(o, m)]
    groups[m['id']] = hits
    log('group', m['id'], len(hits))

# ---- world-space copies --------------------------------------------------
dg = bpy.context.evaluated_depsgraph_get()

def world_mesh(objs, name):
    bm = bmesh.new()
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        ev.to_mesh_clear()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob

body_src = world_mesh(sources, 'body_src')
log('body_src', len(body_src.data.vertices), 'verts', len(body_src.data.polygons), 'faces')
src_objs = []
for gid, objs in groups.items():
    if objs:
        src_objs.append(world_mesh(objs, f'src_{gid}'))
# Thin connective sheets (the rectus sheath over the abs, the thoracolumbar
# fascia over the lower back, the iliotibial tract over the outer quad...)
# shape the body but must not win the labelling: the muscle under a sheet
# is what a member means when they tap there.
SHEETS = ('fascia', 'aponeuros', 'sheath', 'retinacul', 'linea ', 'ligament', 'membrane', 'tract', 'raphe', 'septum')
other = [o for o in sources if not any(o in g for g in groups.values()) and not any(w in o.name.lower() for w in SHEETS)]
sheet_names = sorted(o.name for o in sources if any(w in o.name.lower() for w in SHEETS))
log('sheets left out of labelling', len(sheet_names), sheet_names[:30])
src_objs.append(world_mesh(other, 'src_other'))
log('label sources built')

# ---- the SDF shell (geometry nodes) -------------------------------------
tree = bpy.data.node_groups.new('SKOS_Shell', 'GeometryNodeTree')
tree.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
tree.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
N = tree.nodes; L = tree.links
gin = N.new('NodeGroupInput'); gout = N.new('NodeGroupOutput')
dist = N.new('GeometryNodeDistributePointsOnFaces'); dist.inputs['Density'].default_value = DENSITY
m2p = N.new('GeometryNodeMeshToPoints')
join = N.new('GeometryNodeJoinGeometry')
sdf = N.new('GeometryNodePointsToSDFGrid'); sdf.inputs['Radius'].default_value = RADIUS; sdf.inputs['Voxel Size'].default_value = VOXEL
mean = N.new('GeometryNodeSDFGridMean')
off = N.new('GeometryNodeSDFGridOffset'); off.inputs['Distance'].default_value = OFFSET
g2m = N.new('GeometryNodeGridToMesh')
L.new(gin.outputs[0], dist.inputs['Mesh'])
L.new(gin.outputs[0], m2p.inputs['Mesh'])
L.new(dist.outputs['Points'], join.inputs[0])
L.new(m2p.outputs['Points'], join.inputs[0])
L.new(join.outputs[0], sdf.inputs['Points'])
L.new(sdf.outputs[0], mean.inputs[0])
L.new(mean.outputs[0], off.inputs[0])
L.new(off.outputs[0], g2m.inputs[0])
L.new(g2m.outputs['Mesh'], gout.inputs[0])
log('mean inputs', [s.name for s in mean.inputs])
for s in mean.inputs:
    if s.name == 'Width': s.default_value = 1
    if s.name == 'Iterations': s.default_value = 2

shell = body_src.copy(); shell.data = body_src.data.copy(); shell.name = 'shell'
bpy.context.scene.collection.objects.link(shell)
mod = shell.modifiers.new('sdf', 'NODES'); mod.node_group = tree
bpy.context.view_layer.objects.active = shell
for o in bpy.context.view_layer.objects:
    o.select_set(o == shell)
log('applying SDF modifier...')
bpy.ops.object.modifier_apply(modifier='sdf')
log('shell', len(shell.data.vertices), 'verts', len(shell.data.polygons), 'faces')

# ---- keep only what stage B needs, save a small NEW file ----------------
group_names = {k: [o.name for o in v] for k, v in groups.items()}
keep = {shell.name, *[o.name for o in src_objs]}
for o in list(bpy.data.objects):
    if o.name not in keep:
        bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections):
    bpy.data.collections.remove(c)
bpy.data.orphans_purge(do_recursive=True)
json.dump({'groups': group_names, 'sources': n_sources},
          open(OUT.replace('.blend', '_groups.json'), 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=OUT, copy=True)
log('saved', OUT)
