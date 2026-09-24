"""Build Lumo from the repository sprite reference. Run with Blender --background --python."""
import bpy
import math
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for c in list(bpy.data.collections):
    if c.name != 'Collection':
        bpy.data.collections.remove(c)
character = bpy.data.collections.get('Collection')
character.name = 'Lumo • character'
studio = bpy.data.collections.new('Studio • cameras and lighting')
bpy.context.scene.collection.children.link(studio)

def material(name, color, roughness=.5, texture=False, metallic=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metallic
    if texture:
        n = m.node_tree.nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = 105
        n.inputs['Detail'].default_value = 2
        b = m.node_tree.nodes.new('ShaderNodeBump')
        b.inputs['Strength'].default_value = .14
        b.inputs['Distance'].default_value = .023
        m.node_tree.links.new(n.outputs['Fac'], b.inputs['Height'])
        m.node_tree.links.new(b.outputs['Normal'], p.inputs['Normal'])
    return m

tan = material('Feathers • warm biscuit', (.46, .285, .17), texture=True)
wingmat = material('Feathers • wing highlights', (.56, .365, .23), texture=True)
cream = material('Feathers • ivory face and belly', (.94, .805, .59), texture=True)
scarfmat = material('Scarf • chestnut wool', (.205, .105, .055), texture=True)
scarfedge = material('Scarf • rolled edges', (.31, .173, .09), texture=True)
stitchmat = material('Scarf • woven stitches', (.43, .28, .15))
socket = material('Eyes • warm lid', (.285, .145, .07))
iris = material('Eyes • amber brown', (.13, .052, .015), .19)
dark = material('Eyes • glossy espresso', (.012, .007, .004), .12)
gold = material('Beak and feet • honey amber', (.62, .29, .055), .38)
goldlight = material('Pendant • brushed gold', (.83, .46, .12), .3, metallic=.5)

def finish(obj, name, mat):
    obj.name = name
    obj.data.materials.append(mat)
    if obj.type == 'MESH':
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj

def ell(name, loc, scale, mat, rotation=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, location=loc)
    o = bpy.context.object
    o.scale = scale
    if rotation:
        o.rotation_euler = rotation
    return finish(o, name, mat)

def curve(name, pts, radius, mat, cyclic=False):
    d = bpy.data.curves.new(name, 'CURVE')
    d.dimensions = '3D'
    d.resolution_u = 16
    d.bevel_depth = radius
    d.bevel_resolution = 3
    s = d.splines.new('BEZIER')
    s.bezier_points.add(len(pts)-1)
    for p, co in zip(s.bezier_points, pts):
        p.co = co
        p.handle_left_type = p.handle_right_type = 'AUTO'
    s.use_cyclic_u = cyclic
    o = bpy.data.objects.new(name, d)
    character.objects.link(o)
    return finish(o, name, mat)

def mesh(name, verts, faces, mat, subdiv=0):
    d = bpy.data.meshes.new(name)
    d.from_pydata(verts, [], faces)
    d.update()
    o = bpy.data.objects.new(name, d)
    character.objects.link(o)
    finish(o, name, mat)
    if subdiv:
        m = o.modifiers.new('Soft sculpted surface', 'SUBSURF')
        m.levels = m.render_levels = subdiv
    return o

body = ell('Body • pear silhouette', (0, .06, 1.12), (.91, .68, .99), tan)
head = ell('Head • rounded owl', (0, 0, 2.14), (.94, .70, 1.00), tan)
ell('Belly • cream down', (0, -.29, .99), (.735, .43, .79), cream)

# A single curved heart-shaped facial mask, fitted to the head ellipsoid.
# Catmull-Rom sampling preserves the V between the two brow lobes.
outline = [(0,2.70),(.22,2.93),(.44,2.96),(.65,2.83),(.79,2.60),
           (.80,2.32),(.71,2.10),(.49,1.96),(0,1.88),(-.49,1.96),
           (-.71,2.10),(-.80,2.32),(-.79,2.60),(-.65,2.83),(-.44,2.96),(-.22,2.93)]
boundary=[]
for i in range(len(outline)):
    a,b,c,d=[Vector(outline[j % len(outline)]) for j in (i-1,i,i+1,i+2)]
    for k in range(8):
        t=k/8
        boundary.append(.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t))
def face_y(x,z):
    return -.70*math.sqrt(max(.02,1-(x/.94)**2-((z-2.14)/1.00)**2))-.012
verts=[(0,face_y(0,2.38),2.38)]
N=len(boundary)
for ring in range(1,17):
    r=ring/16
    for p in boundary:
        x=p.x*r
        z=2.38+(p.y-2.38)*r
        verts.append((x,face_y(x,z),z))
faces=[(0,1+j,1+(j+1)%N) for j in range(N)]
for ring in range(15):
    a=1+ring*N
    b=a+N
    for j in range(N):
        k=(j+1)%N
        faces.append((a+j,b+j,b+k,a+k))
mask=mesh('Face • ivory heart mask',verts,faces,cream)
solid=mask.modifiers.new('Feather edge thickness','SOLIDIFY')
solid.thickness=.008

for side in (-1,1):
    x=side*.365
    ell(f'Eye lid {side}',(x,-.656,2.405),(.235,.098,.268),socket)
    ell(f'Iris {side}',(x,-.715,2.415),(.200,.104,.231),iris)
    ell(f'Pupil {side}',(x+side*.008,-.795,2.43),(.145,.051,.185),dark)
    # Small inset brow feather above each eye.
    ell(f'Brow feather {side}',(side*.36,-.516,2.775),(.065,.019,.031),wingmat,
        (0,side*.25,0))

mesh('Beak • upper diamond',[(0,-.697,2.285),(-.12,-.71,2.165),(0,-.92,2.16),
     (.12,-.71,2.165),(0,-.70,2.105)],[(0,1,2),(0,2,3),(1,4,2),(2,4,3),(0,3,4,1)],gold)
curve('Beak • mouth seam',[(-.105,-.731,2.155),(0,-.918,2.15),(.105,-.731,2.155)],.006,socket)

# Layered, poseable wing groups.
for side in (-1,1):
    pivot=bpy.data.objects.new(f'Wing pivot {side}',None)
    character.objects.link(pivot)
    pivot.location=(side*.77,.01,1.48)
    parts=[]
    parts.append(ell(f'Wing {side} • upper', (side*.87,-.01,1.16),(.27,.38,.52),wingmat,(0,side*-.24,side*.10)))
    for j in range(3):
        parts.append(ell(f'Wing {side} • primary {j+1}',(side*(.92+j*.012),-.24+j*.18,.98+j*.025),
                         (.15,.14,.32-j*.035),wingmat,(0,side*-.27,0)))
    for o in parts:
        bpy.context.view_layer.update()
        w=o.matrix_world.copy()
        o.parent=pivot
        o.matrix_world=w

# Three subtle crest feathers lean backwards over the crown.
for i in range(3):
    curve(f'Crest • feather {i+1}',[(-.08+i*.085,.02,3.055),(-.07+i*.08,-.005,3.15),
          (-.025+i*.073,.035,3.23-i*.038)],.035-i*.007,wingmat)

for side in (-1,1):
    ell(f'Foot {side} • pad',(side*.45,-.13,.19),(.24,.26,.14),gold)
    for j in range(3):
        ell(f'Foot {side} • toe {j+1}',(side*.45+(j-1)*.135,-.33,.15),(.077,.19,.09),gold)

# Scarf: two uneven, thick elliptical wraps, with raised rolled hems.
def scarf_loop(name,z,rx,ry,tube,mat):
    pts=[]
    for i in range(32):
        a=2*math.pi*i/32
        pts.append((rx*math.cos(a),ry*math.sin(a),z+.055*math.cos(a+.3)+.028*math.sin(2*a)))
    return curve(name,pts,tube,mat,True)
scarf_loop('Scarf • lower wrap',1.655,.855,.645,.118,scarfmat)
scarf_loop('Scarf • upper wrap',1.80,.87,.651,.112,scarfmat)
scarf_loop('Scarf • lower piping',1.576,.851,.659,.019,scarfedge)
scarf_loop('Scarf • middle fold',1.733,.88,.688,.026,scarfedge)
scarf_loop('Scarf • upper piping',1.882,.86,.649,.018,scarfedge)

# Hanging scarf end follows the belly, with a softly bevelled fabric edge.
verts=[]
for j in range(7):
    t=j/6
    for i in range(5):
        u=i/4
        verts.append((-.39+u*.34-.10*t,-.751-.03*math.sin(t*math.pi)-.016*math.cos(u*math.pi*4),
                      1.70-.69*t+.025*math.sin(u*math.pi)))
faces=[]
for j in range(6):
    for i in range(4):
        a=j*5+i
        faces.append((a,a+1,a+6,a+5))
tail=mesh('Scarf • hanging end',verts,faces,scarfmat,2)
m=tail.modifiers.new('Wool thickness','SOLIDIFY'); m.thickness=.065
m=tail.modifiers.new('Soft edges','BEVEL'); m.width=.025; m.segments=3
for i in range(7):
    x=-.475+i*.048
    curve(f'Scarf • fringe {i+1}',[(x,-.765,1.065),(x-.005,-.77,.988),(x+.006,-.758,.965)],.015,scarfedge)
for x in (-.425,-.21):
    curve('Scarf • end seam',[(x+.06,-.798,1.51),(x+.025,-.808,1.28),(x,-.79,1.08)],.008,stitchmat)
ell('Scarf • knot',(-.245,-.754,1.732),(.195,.133,.159),scarfedge,(0,0,-.12))
for x in (-.325,-.235,-.15):
    curve('Scarf • knot fold',[(x,-.802,1.855),(x-.025,-.883,1.745),(x+.012,-.81,1.612)],.013,scarfmat)

# Small brass shield charm on a short cord.
curve('Pendant • cord',[(.105,-.745,1.56),(.10,-.758,1.42)],.014,scarfedge)
verts=[(.025,-.771,1.425),(.18,-.771,1.425),(.18,-.775,1.32),(.103,-.785,1.235),(.025,-.775,1.32)]
pendant=mesh('Pendant • golden shield',verts,[tuple(range(5))],goldlight)
m=pendant.modifiers.new('Metal thickness','SOLIDIFY');m.thickness=.035
m=pendant.modifiers.new('Rounded rim','BEVEL');m.width=.014;m.segments=3
curve('Pendant • engraved stem',[(.102,-.807,1.391),(.102,-.807,1.295)],.008,scarfmat)

# Short tail feathers on the unpictured back are an interpretation.
for i in range(3):
    ell(f'Tail • feather {i+1}',((i-1)*.18,.62,.61),(.15,.37,.16),wingmat,(.35,0,(i-1)*-.22))

# Reference is packed into the editable file, hidden from renders.
reference=bpy.data.images.load(str(ROOT/'frontend/src/assets/lumo/lumo-spritesheet.webp'))
reference.use_fake_user=True
reference.pack()
root=bpy.data.objects.new('LUMO • move entire character',None)
character.objects.link(root)
for o in list(character.objects):
    if o != root and o.parent is None:
        o.parent=root
root['reference']='frontend/src/assets/lumo/lumo-spritesheet.webp'
root['design_note']='First 3D interpretation; back and depth inferred. Separate editable parts; no deformation rig.'

def to_studio(o):
    for c in list(o.users_collection):
        c.objects.unlink(o)
    studio.objects.link(o)

ground=material('Studio • warm porcelain',(.70,.65,.55),.8)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,.045))
o=finish(bpy.context.object,'Studio • floor',ground);to_studio(o)
def point_at(o, target):
    o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
def area(name,loc,power,size,color):
    bpy.ops.object.light_add(type='AREA',location=loc)
    o=bpy.context.object;o.name=name;o.data.energy=power;o.data.shape='DISK';o.data.size=size;o.data.color=color
    point_at(o,(0,0,1.5));to_studio(o)
area('Studio • large softbox',(-3.8,-4.5,6),480,4,(1,.86,.70))
area('Studio • cool fill',(4,-2.3,3.8),260,3,(.78,.86,1))
area('Studio • rim',(1.5,3.4,5),600,3,(1,.79,.52))
bpy.ops.object.camera_add(location=(4,-8,3.35))
camera=bpy.context.object;camera.name='Camera • portrait';to_studio(camera)
point_at(camera,(0,0,1.62));camera.data.type='ORTHO';camera.data.ortho_scale=4.25
scene=bpy.context.scene
scene.camera=camera
scene.render.engine='CYCLES'
scene.cycles.samples=48
scene.cycles.use_denoising=True
scene.world.color=(.25,.25,.25)
scene.render.resolution_x=1100
scene.render.resolution_y=1100
scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
scene.render.image_settings.file_format='PNG'

# Export just the character, converting evaluated curves and modifiers to meshes.
bpy.ops.object.select_all(action='DESELECT')
for o in character.objects:
    if o.type in {'MESH','CURVE'}:
        o.select_set(True)
        bpy.context.view_layer.objects.active=o
bpy.ops.export_scene.gltf(filepath=str(OUT/'lumo.glb'),use_selection=True,export_apply=True,export_animations=False)

bpy.ops.object.select_all(action='DESELECT')
root.select_set(True)
bpy.context.view_layer.objects.active=root
for screen in bpy.data.screens:
    for a in screen.areas:
        if a.type=='VIEW_3D':
            a.spaces.active.region_3d.view_perspective='CAMERA'
scene.render.filepath=str(OUT/'lumo-three-quarter.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'lumo.blend'))
bpy.ops.render.render(write_still=True)
camera.location=(0,-8,2.95)
point_at(camera,(0,0,1.63))
scene.render.filepath=str(OUT/'lumo-front.png')
bpy.ops.render.render(write_still=True)
print('LUMO_BUILD_COMPLETE')
