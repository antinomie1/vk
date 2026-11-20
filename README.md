# vk

[中文](README.zh-CN.md)

Vulkan for [Mica](https://github.com/antinomie1/mica), built with
[sheaf](https://github.com/antinomie1/sheaf). A workspace of bundles:

| Package | Role |
|---------|------|
| `vk` | Low-level bindings generated from `vk.xml` and `video.xml` (like ash's `vk` module) |
| `vk_gpu` | High-level Vulkan 1.3 layer: Copy handles, bindless, automatic barriers, frames |
| `vk_draw2d` | Batched 2D on `vk_gpu`: rounded rects, borders, shadows, images, clips, damage |
| `vk_compose` | A compositor frame: views over textures and dmabufs, damage by buffer age |
| `vk_graph` | Render graph on `vk_gpu`: pass culling, pooled transient textures |
| `generator` | Writes `vk/src/lib.mica` and its layout test from the registry |
| `examples/triangle` | A colored triangle in an XCB window (X11 or XWayland), on raw `vk` |
| `examples/triangle_gpu` | The same triangle on `vk_gpu` |

## vk

- All core versions (1.0-1.4) and every extension supported for `vulkan`,
  plus the Video Std types. Only the types reachable from them are emitted.
- Types drop the `Vk` prefix (`InstanceCreateInfo`; `VkResult` keeps it,
  since `Result` is built in). Fields and parameters are snake_case
  (`p_next`, `pp_enabled_extension_names`).
- Handles are typed: `struct Instance { raw: usize }` (dispatchable) and
  `struct Buffer { raw: u64 }`. The null handle is `Instance {}`. Handles
  and enums derive `Show` and `Hash`, so they can be `Map` keys.
- `r.result()` turns a `VkResult` into `Result[(), VkResult]`. Only
  `SUCCESS` is `Ok`, so `try` works on any call.
- Enums are `enum Format: i32`, with values in ash style:
  `Format.R8G8B8A8_UNORM`, `ImageType.TYPE_2D`. Bitmasks are
  `enum BufferUsageFlags: u32 derive(Flags)`, so `|`, `contains` and
  `bits()` work. `XFlagBits` is an alias of `XFlags`.
- Structs have field defaults, and `sType` is preset:
  `vk.BufferCreateInfo { size: 64, usage: ... }`. A struct that holds
  pointers is an `unsafe struct`, so it is `Send` and allowed in safe
  signatures. Bit fields become `bits(uN)` structs.
- Commands live in `extern table`s, resolved once and then called through one
  indirect call:
  - `StaticFn`: `vkGetInstanceProcAddr`, via `StaticFn.open(vk.loader_name)`.
  - Core: `EntryFnV1_x`, `InstanceFnV1_x`, `DeviceFnV1_x`.
  - Extensions: `<Ext>InstanceFn` and `<Ext>DeviceFn`, e.g.
    `KhrSwapchainDeviceFn`. Load these with `try_load`.
  - Some extension commands exist only with another version or extension
    (a `depends` block in vk.xml). They get their own table, e.g.
    `KhrSwapchainV1_1DeviceFn` or `KhrDeviceGroupKhrSurfaceInstanceFn`
    (`,` is `Or`, `+` is `And`, and a parenthesized group starts with
    `Either` or `Both`), so a missing dependency never stops the base table
    from loading. If two expressions would map to one name, the generator
    stops with an error.
- Parameter mapping: `const char*` strings are `str`. A required
  single-object output is `mut` (`mut p_instance: Instance`). Every other
  pointer is `Ptr[T]`, and a `List[T]` can be passed to it directly. An
  optional `const char*` such as `p_layer_name` is `Ptr[u8]`.

```mica
import vk

let st = vk.StaticFn.open(vk.loader_name).expect("no Vulkan loader")
let entry = vk.EntryFnV1_0.load(fn(n) => st.get_instance_proc_addr(vk.Instance {}, n))
let app = vk.ApplicationInfo { api_version: vk.api_version_1_3 }
unsafe let info = vk.InstanceCreateInfo { p_application_info: Ptr.of(app) }
var inst = vk.Instance {}
unsafe let r = entry.create_instance(Ptr.of(info), Ptr.null(), mut inst)
let fns = vk.InstanceFnV1_0.load(fn(n) => st.get_instance_proc_addr(inst, n))
// after fns.create_device(..., mut dev):
let swapchain = vk.KhrSwapchainDeviceFn.try_load(fn(n) => fns.get_device_proc_addr(dev, n))
```

## vk_gpu

Seven nouns: `Device`, `Buffer`, `Texture`, `Pipeline`, `Encoder`, a target
(`Surface`, `Offscreen`) and `Ticket`. No render passes, framebuffers,
descriptor sets, fences, layouts or barriers in user code.

- Vulkan 1.3 floor: dynamic rendering, synchronization2, timeline
  semaphores, buffer device address, update-after-bind descriptor indexing.
- Handles are small Copy values: a generational slot (`SlotMap`), the
  device they belong to, and size, format or address. `destroy_*` marks the
  resource dead at once and frees it after the GPU finishes the last submit
  that could use it.
- An `Encoder` is a list of commands that touches no Vulkan object; submit
  checks it, then records it into a reused command buffer.
- Bindless: every texture is `index()` in one global set (binding 0 sampled,
  1 four immutable samplers, 2 storage); buffers are reached by `addr()`.
  One pipeline layout with 128 bytes of push constants; nothing is bound per
  draw. `shaders/vk_gpu.glsl` declares the layout; index 0 is "no texture".
- Barriers: while recording a submit, each texture moves from its
  device-wide state into what each command needs; barriers are batched into
  one `vkCmdPipelineBarrier2` per scope. Writers publish (pass targets and
  copies end in `Sampled`, buffer writes are made visible), so reads are
  never declared; only compute `storage` writes are.
- Every submit signals one timeline value (`Ticket`): `done`, `wait`.
  `present(frame, encoder)` submits and presents in one call, so the
  acquire and per-image present semaphores are always wired.
- Swapchain rebuilds on `resize` (Wayland), out-of-date, or after a
  suboptimal frame was presented; two frames in flight; FIFO or
  mailbox/immediate.
- Memory: 64 MiB blocks per type, first-fit with merging, dedicated over
  32 MiB; host-visible memory stays mapped; device-local uploads when the
  whole VRAM is mappable. An 8 MiB upload ring (`stage`, `write`,
  `write_texture`) recycled by tickets. Encoder lists and command buffers
  are reused, so steady-state frames allocate nothing.

```mica
import vk_gpu as gpu

var dev = try gpu.Device.open(gpu.Options {})
var out = try gpu.Surface.create(mut dev, native, 800, 600, true)
let tri = try dev.graphics(gpu.Graphics { color: out.format() }, vs_spv, fs_spv)
while running {
    guard let Some(f) = try out.acquire(mut dev) else {
        continue
    }
    var e = try dev.encoder()
    e.render(gpu.Pass { target: f.image() }, fn(mut r) {
        r.bind(tri)
        r.push(bytes_of(params))
        r.draw(3, 1)
    })
    discard try out.present(mut dev, f, take e)
}
out.destroy(mut dev)
```

- Sharing: `export_dmabuf` / `import_dmabuf` (one plane, any DRM
  modifier, dedicated memory), `submit_sync_file` / `wait_sync_file`;
  imported textures pass between queue families with `e.acquire(t)` /
  `e.release(t)`. Frames report their `age()` (buffer age); swapchain
  images keep their contents between presents, so partial redraws work.

### Safety

Safe Mica code using these bundles cannot corrupt CPU memory or hand the
driver an invalid object:

- A destroyed handle, or one from another device, is an `Err` everywhere:
  `submit` (nothing is recorded), `write`, `read`, `read_texture`;
  `destroy_*` of such a handle is ignored. Mapped writes and reads check
  the buffer is alive and bound their range.
- `submit` also rejects: a pipeline bound in a pass of other formats, a
  draw or dispatch without a pipeline, index / indirect ranges past their
  buffer, push constants over 128 bytes or not a multiple of 4, a negative
  scissor, dispatches over the device limits, targets and storage writes
  on textures made without that usage, frames given to another target.
- Every bindless slot always holds a texture: free ones a 1x1 transparent
  black placeholder, and `gpu_sample` / `gpu_index` clamp the index, so a
  stale or wild index reads black. `Options.max_textures` is exact (match
  `GPU_MAX_TEXTURES` when changing it).

Not covered: what shaders do with buffer addresses (out of bounds is
undefined in every Vulkan API; use the validation layer's GPU-assisted
checks) and CPU writes to a host-visible buffer the GPU is still reading
(stale data, not memory corruption: wait for its `Ticket`). Encoders not
submitted are given back with `dev.cancel(e)`.

Not yet: multi-threaded recording, MRT and mipmaps, multi-plane (YCbCr)
dmabufs.

## vk_draw2d

`Canvas`: `rect`, `round_rect`, `border`, `shadow`, `image`, `image_part`
(atlases, glyphs), `push_clip` / `pop_clip`, then `draw(dev, e, pass,
damage)`.

- One instanced draw per target: shapes are 80-byte instances staged in the
  upload ring and read by buffer address; textures by bindless index.
- Every shape is one rounded-box distance field (antialiased edges, rings,
  shadow falloff), so corners and shadows cost what a plain quad costs.
- With damage, the pass is scissored and shapes outside it are skipped; when
  nothing reaches the damage no pass is recorded.
- Premultiplied blending; colors straight alpha, `srgb()` for sRGB targets.

Not yet: text shaping and rasterizing (draw glyphs from your own atlas with
`image_part`), backdrop blur.

## vk_compose

`Scene`: `add`, `set`, `get`, `commit` (client damage in buffer pixels),
`raise`, `remove`, `resize`, `idle`, and `render(dev, canvas, e, frame)`.

- Damage is the union of what moved, changed or appeared since the last
  frame, widened by the target image's age from a 4-frame history; age 0
  redraws everything. `idle()` says no frame is needed at all.
- Views are textures (shm uploads or imported dmabufs) with opacity, corner
  radius and drop shadow; imported ones are acquired and released around
  the pass. Feed client fences to `dev.wait_sync_file`, hand release points
  back with `dev.submit_sync_file`.

Damage is one bounding rectangle per frame (simple, and the scissor is one
rectangle anyway).

## vk_graph

`Graph`: `texture(dev, desc)` (transient, pooled), `render(pass, reads,
Box(fn(mut r: gpu.Render) ...))`, `compute(reads, writes, Box(fn(mut c:
gpu.Compute) ...))`, `run(dev, e, outputs)`.

- Passes run in the order added; a pass that no output depends on is
  culled. Compute passes declare their storage writes; everything else keeps
  the encoder's automatic barriers.
- Transient textures with the same description come back from the pool next
  frame and are freed after 3 unused frames: steady frames allocate no GPU
  memory (the boxed pass closures are small heap allocations).

## Triangle example

```sh
sheaf run -p triangle          # until the window is closed or Escape is pressed
sheaf run -p triangle -- 300   # 300 frames, then exit
```

It needs `libxcb`. One frame is in flight, viewport and scissor are dynamic,
and the swapchain is rebuilt when the window is resized. The shaders are
embedded from `shaders/*.spv`; after editing the GLSL, rebuild them:

```sh
cd examples/triangle/shaders && glslc triangle.vert -o triangle.vert.spv && glslc triangle.frag -o triangle.frag.spv
```

`sheaf run -p triangle_gpu [-- frames]` draws it through `vk_gpu`: about 40
lines instead of 500.

## Regenerate

```sh
sheaf run -p generator -- /usr/share/vulkan/registry vk
```

The first argument is any directory that holds `vk.xml` and `video.xml`,
for example Vulkan-Headers' `registry/`. The generator writes
`vk/src/lib.mica`, plus `vk/tests/layout.c` and `vk/tests/layout.mica`.

## Test

```sh
sheaf test -p vk_gpu   # headless on the real device: clear, draw, bindless sampling,
                       # compute through a buffer address, uploads, retirement,
                       # dmabuf export/import with sync_file, frame age, and
                       # misuse (stale/foreign handles, bad commands) as errors
sheaf test -p vk_draw2d   # shapes, clips, alpha, shadows, damage, read back
sheaf test -p vk_compose  # moves, idle frames, stacking, an imported dmabuf window
sheaf test -p vk_graph    # culling, order, pooling
cd vk_draw2d/shaders && for f in *.vert *.frag; do glslc --target-env=vulkan1.3 -I ../../vk_gpu/shaders $f -o $f.spv; done
cd vk_gpu/tests/shaders && for f in *.vert *.frag *.comp; do glslc --target-env=vulkan1.3 -I ../../shaders $f -o $f.spv; done
sheaf test -p vk    # values, derives, and a real instance and device when a driver is present
                    # layout.mica: builds layout.c with cc against the system Vulkan headers and
                    # compares size, alignment and member offsets of every core struct and union
```

## License

Apache-2.0 ([LICENSE-APACHE](LICENSE-APACHE)) or BSD-2-Clause
([LICENSE-BSD](LICENSE-BSD)), at your option.
