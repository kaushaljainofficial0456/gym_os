"""
BODY v2, STAGE B -- from stage A's fused shell to the web model.

  1. keep the body (drop stray fragments), reduce to a phone-friendly budget
  2. label every part of the surface with the muscle it lies over: the
     nearest real Z-Anatomy muscle wins, and anything nearer a muscle that
     is not a tappable group (sartorius, neck, shin...) is plain "body"
  3. tidy the labels: majority vote with neighbours, small islands absorbed
  4. bake ambient occlusion into vertex colours -- the soft shadow in every
     groove is most of what makes it read as a sculpt instead of plastic
  5. one object per tappable muscle and side, plus "body"; normals are
     computed on the WHOLE surface first, so the split leaves no seams
  6. Draco-compressed GLB + the muscle map + preview renders

    blender --background D:/gym_tmp/anat/shell.blend \
      --python scripts/anatomy/build_body_v2_stage_b.py -- \
      scripts/anatomy/muscle_spec.json OUT.glb OUT_MAP.json PREVIEW_PREFIX [target_tris]
"""
import bmesh
import bpy
import json
import math
import sys
import time
from collections import Counter, deque
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
SPEC, GLB, MAP_OUT, PREVIEW = argv[0], argv[1], argv[2], argv[3]
TARGET_TRIS = int(argv[4]) if len(argv) > 4 else 280000
t0 = time.time()
log = lambda *a: print(f'[{time.time() - t0:6.1f}s]', *a, flush=True)

spec = {m['id']: m for m in json.load(open(SPEC, encoding='utf-8'))['muscles']}
spec['rhomboids']['displayName'] = 'Upper Back'

scene = bpy.context.scene
shell = bpy.data.objects['shell']
srcs = {o.name[4:]: o for o in bpy.data.objects if o.name.startswith('src_')}
log('shell faces', len(shell.data.polygons), 'label sources', sorted(srcs))

def activate(o):
    for x in bpy.data.objects:
        try:
            x.select_set(False)
        except Exception:
            pass
    o.select_set(True)
    bpy.context.view_layer.objects.active = o

# ---- 1. keep the body ----------------------------------------------------
bm = bmesh.new(); bm.from_mesh(shell.data)
bm.verts.ensure_lookup_table()
seen = set(); comps = []
for v in bm.verts:
    if v.index in seen:
        continue
    q = deque([v]); seen.add(v.index); comp = []
    while q:
        a = q.popleft(); comp.append(a)
        for e in a.link_edges:
            b = e.other_vert(a)
            if b.index not in seen:
                seen.add(b.index); q.append(b)
    comps.append(comp)
total = len(bm.verts)
drop = [v for c in comps if len(c) < total * 0.004 for v in c]
bmesh.ops.delete(bm, geom=drop, context='VERTS')
bm.to_mesh(shell.data); bm.free()
log('components', len(comps), 'dropped verts', len(drop))

activate(shell)
dec = shell.modifiers.new('dec', 'DECIMATE')
# The SDF mesh is quads; the budget is in triangles.
tris_now = sum(len(p.vertices) - 2 for p in shell.data.polygons)
dec.ratio = min(1.0, TARGET_TRIS / max(1, tris_now))
bpy.ops.object.modifier_apply(modifier='dec')
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.00005)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
shell.data.shade_smooth()
me = shell.data
log('decimated to', len(me.polygons), 'faces', len(me.vertices), 'verts')

# ---- 2. labels -----------------------------------------------------------
dg = bpy.context.evaluated_depsgraph_get()
bvh = {k: BVHTree.FromObject(o, dg) for k, o in srcs.items()}
keys = sorted(bvh)
# Muscles that lie just under a thin layer of something else get a few
# millimetres of priority, or the layer above them wins every vertex.
PRIORITY = {'rectus_abdominis': 0.012, 'erector_spinae': 0.012, 'rhomboids': 0.005, 'gluteus_medius': 0.004,
            'soleus': 0.003, 'latissimus_dorsi': 0.002, 'obliques': 0.001}

def label_at(co):
    best, bd = 'other', 1e9
    for k in keys:
        hit = bvh[k].find_nearest(co)
        if hit[0] is not None:
            d = hit[3] - PRIORITY.get(k, 0.0)
            if d < bd:
                bd, best = d, k
    return best

# Label the figure's RIGHT half (x <= 0) from the anatomy, then MIRROR it:
# Z-Anatomy is not perfectly symmetric (no left external oblique, a smaller
# left lat), and a member expects both sides of the body to match.
from mathutils.kdtree import KDTree
right = [v.index for v in me.vertices if v.co.x <= 0]
rlab = {i: label_at(me.vertices[i].co) for i in right}
kd = KDTree(len(right))
for i in right:
    kd.insert(me.vertices[i].co, i)
kd.balance()
vlab = []
for v in me.vertices:
    if v.co.x <= 0:
        vlab.append(rlab[v.index])
    else:
        _, j, _ = kd.find(Vector((-v.co.x, v.co.y, v.co.z)))
        vlab.append(rlab[j])
log('vertex labels', Counter(vlab).most_common(12))

# side: Blender's convention, .l is the figure's left = +X
def full(label, x):
    return 'body' if label == 'other' else f"{label}.{'l' if x > 0 else 'r'}"

flab = []
for p in me.polygons:
    c = Counter(vlab[i] for i in p.vertices).most_common(1)[0][0]
    flab.append(full(c, p.center.x))

# ---- 3. tidy -------------------------------------------------------------
bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
nbrs = [[g.index for e in f.edges for g in e.link_faces if g.index != f.index] for f in bm.faces]
for _ in range(3):
    nxt = flab[:]
    for i, ns in enumerate(nbrs):
        cnt = Counter(flab[j] for j in ns); cnt[flab[i]] += 1
        lab, n = cnt.most_common(1)[0]
        if n >= 3:
            nxt[i] = lab
    flab = nxt
# absorb islands smaller than ~0.25% of the surface into what surrounds them
MIN_ISLAND = max(40, len(flab) // 2500)
done = [False] * len(flab)
for i in range(len(flab)):
    if done[i]:
        continue
    lab = flab[i]; q = deque([i]); done[i] = True; isl = []
    while q:
        a = q.popleft(); isl.append(a)
        for b in nbrs[a]:
            if not done[b] and flab[b] == lab:
                done[b] = True; q.append(b)
    if len(isl) < MIN_ISLAND:
        border = Counter(flab[b] for a in isl for b in nbrs[a] if flab[b] != lab)
        if border:
            new = border.most_common(1)[0][0]
            for a in isl:
                flab[a] = new
bm.free()
log('face labels', Counter(flab).most_common(50))

# ---- 4. ambient occlusion into vertex colours ----------------------------
for o in list(bpy.data.objects):
    if o.name.startswith('src_'):
        bpy.data.objects.remove(o, do_unlink=True)
mat = bpy.data.materials.new('SKOS_Body')
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Base Color'].default_value = (0.78, 0.75, 0.72, 1.0)
bsdf.inputs['Roughness'].default_value = 0.55
me.materials.clear(); me.materials.append(mat)
ca = me.color_attributes.new('ao', 'BYTE_COLOR', 'POINT')
me.color_attributes.active_color = ca
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 64
if scene.world is None:
    scene.world = bpy.data.worlds.new('w')
scene.world.light_settings.distance = 0.12
scene.render.bake.target = 'VERTEX_COLORS'
activate(shell)
log('baking AO...')
bpy.ops.object.bake(type='AO')
# Remap: grooves darken, nothing goes black; a little contrast in the mid.
cols = ca.data
for c in cols:
    a = c.color[0]
    v = 0.42 + 0.58 * (a ** 1.25)
    c.color = (v, v, v, 1.0)
log('AO baked')

# ---- 5. split, keeping the whole-surface normals ------------------------
me.normals_split_custom_set_from_vertices([v.normal for v in me.vertices])
labels = sorted(set(flab))
lab_mats = []
for lab in labels:
    m = bpy.data.materials.new(f'L::{lab}')
    me.materials.append(m)
    lab_mats.append(m)
index_of = {lab: i + 1 for i, lab in enumerate(labels)}
for p, lab in zip(me.polygons, flab):
    p.material_index = index_of[lab]
activate(shell)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='MATERIAL')
bpy.ops.object.mode_set(mode='OBJECT')
parts = [o for o in bpy.data.objects if o.type == 'MESH']
for o in parts:
    used = {p.material_index for p in o.data.polygons}
    mname = o.data.materials[next(iter(used))].name if used else 'L::body'
    o.name = mname[3:]
    o.data.name = o.name
    o.data.materials.clear(); o.data.materials.append(mat)
log('parts', sorted(o.name for o in parts))

# ---- 6. export ----------------------------------------------------------
bpy.ops.export_scene.gltf(
    filepath=GLB, export_format='GLB', use_selection=False, export_apply=True, export_yup=True,
    export_normals=True, export_texcoords=False, export_materials='EXPORT',
    export_vertex_color='ACTIVE',
    export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14, export_draco_normal_quantization=10, export_draco_color_quantization=8,
)
mp = {}
for o in parts:
    if o.name == 'body':
        continue
    mid = o.name.rsplit('.', 1)[0]
    s = spec.get(mid, {})
    mp[mid] = {'displayName': s.get('displayName', mid), 'exerciseMuscleGroup': s.get('exerciseMuscleGroup')}
json.dump(dict(sorted(mp.items())), open(MAP_OUT, 'w', encoding='utf-8'), indent=2)
log('exported', GLB)

# ---- previews ----------------------------------------------------------
scene.render.engine = 'BLENDER_WORKBENCH'
try:
    scene.render.image_settings.media_type = 'IMAGE'
except Exception:
    pass
scene.render.image_settings.file_format = 'PNG'
sh = scene.display.shading
sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = False
scene.render.resolution_x = 760; scene.render.resolution_y = 1200
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in parts:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
center = (mn + mx) / 2; height = (mx - mn).z
target = bpy.data.objects.new('target', None); scene.collection.objects.link(target); target.location = center
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam
cam.data.lens = 85
con = cam.constraints.new('TRACK_TO'); con.target = target; con.track_axis = 'TRACK_NEGATIVE_Z'; con.up_axis = 'UP_Y'
dist = height * 2.9
for label, ang in (('front', 0.0), ('back', math.pi), ('side', math.pi / 2), ('three', math.pi / 5)):
    cam.location = center + Vector((math.sin(ang) * dist, -math.cos(ang) * dist, height * 0.04))
    scene.render.filepath = f'{PREVIEW}-{label}.png'
    bpy.ops.render.render(write_still=True)
log('previews written')
