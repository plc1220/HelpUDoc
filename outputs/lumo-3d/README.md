# Lumo — first 3D model

Based on `frontend/src/assets/lumo/lumo-spritesheet.webp` (packed into the Blender file).

- `lumo.blend`: editable character, procedural materials, studio lights, and portrait camera.
- `lumo.glb`: character-only geometry and basic PBR materials for 3D viewers.
- `lumo-three-quarter.png` and `lumo-front.png`: rendered previews.
- `build_lumo.py`: reproducible Blender build script.

Open `lumo.blend` in Blender. The **Lumo • character** collection holds the named parts. Move the **LUMO • move entire character** empty to reposition the model; the two **Wing pivot** empties control wing placement. The studio has its own collection.

This is a stylized first interpretation of the painted sprite, with back and depth inferred from the available front and side views. It is an assembled model, not a finished deformation rig or retopologized animation asset. The GLB retains colors and roughness; Blender's procedural microtexture is not baked into its materials.

Rebuild from the repository root:

```sh
blender --background --python outputs/lumo-3d/build_lumo.py
```

Built with Blender 5.2.1.
