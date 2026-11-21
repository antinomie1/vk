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
| `vk_window` | A Vulkan surface for a raw window handle (like ash-window) |
| `raw_window_handle` | Native window handles shared by window and graphics libraries |
| `glfw_sys` | GLFW 3.4+ bindings generated from `glfw3.h` |
| `glfw` | Safe GLFW windows on `glfw_sys`, giving raw window handles |
| `generator` | Writes `vk/src/lib.mica` and its layout test from the registry |
| `examples/triangle` | A colored triangle in a GLFW window (X11 or Wayland), on raw `vk` |
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
  `write_texture`, `write_texture_rect`) recycled by tickets.
  `write_texture_rect` copies a rectangle out of a strided image (a wl_shm
  pool) and stages only the bytes it spans. Encoder lists and command buffers
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

- Sharing: `export_dmabuf` / `import_dmabuf` (1..4 planes, non-disjoint or
  `DISJOINT` BOs detected via `statx`, atomic fd handling), `import_dmabuf_target`
  + `copy_texture`, `submit_sync_file` / `wait_sync_file`;
  imported textures pass between queue families with `e.acquire(t)` /
  `e.release(t)`. Queue global priority (`Options.priority`) negotiates
  `VK_KHR/EXT_global_priority` with fallback, and `VK_ERROR_DEVICE_LOST`
  triggers `lost()` for clean teardown/recovery. `opaque` (on `TextureDesc` and `Dmabuf`) makes alpha read
  as 1 through the view's swizzle, for XRGB formats. Frames report their `age()` (buffer age); swapchain
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

Not yet: multi-threaded recording, MRT and mipmaps, planar YCbCr
sampler conversion.

## vk_draw2d

`Canvas`: `rect`, `round_rect`, `border`, `shadow`, `image`, `image_part`
(atlas sprites), `texture` (crop and `Transform`), `opaque`, `push_clip` /
`pop_clip`, then `draw(dev, e, pass, damage)`.

- One pass per target: shapes are 96-byte instances staged once in the
  upload ring and read by buffer address; textures by bindless index.
- Every shape is one rounded-box distance field (antialiased edges, rings,
  shadow falloff), so corners and shadows cost what a plain quad costs.
  Texture coordinates are an affine map per shape, so crops and the eight
  `wl_output.transform`s cost nothing extra.
- Damage is a list of rectangles, each one scissored instanced draw of the
  shapes that reach it, in the same pass; when nothing reaches the damage no
  pass is recorded.
- Occlusion: each rectangle starts at the topmost shape that hides all of
  it. Rectangles at full alpha and opaque textures hide what is under them;
  `opaque(r)` marks more. A full-screen opaque window draws one quad.
- Premultiplied blending; colors straight alpha, `srgb()` for sRGB targets.

Not yet: backdrop blur.

## vk_compose

`Scene`: `add`, `set`, `get`, `commit` (client damage in texture pixels),
`raise`, `place_above`, `reorder` (O(N log N) LIS damage), `remove`,
`remove_many`, `resize`, `damage`, `idle`, `visible`, `scanout`,
`overlay_candidates`, `set_overlays`, `changed`, and
`render(dev, canvas, e, frame)`.

- A `View` is a texture (an shm upload or an imported dmabuf; a solid color
  is 1x1) with a place and size, a source crop (wp_viewport), a buffer
  transform, opacity, corner radius, drop shadow and opaque region.
- Damage is up to 8 whole-pixel rectangles: what moved, changed or appeared
  since the last frame, widened by the target image's age from a 4-frame
  history; age 0 redraws everything. Client damage is mapped through the
  view's crop, transform and scale. A new texture alone damages nothing but
  what `commit` reports.
- Rendering skips what opaque views hide; `visible(id)` says whether a view
  shows at all, so hidden clients can be throttled (no frame callbacks).
- `idle()`: no frame is needed. `scanout()`: the one view that fills the
  screen as it is, to put on a plane instead of rendering. `changed()`: what
  the last frame changed (KMS `FB_DAMAGE_CLIPS`, a parent compositor's
  damage).
- Imported textures are acquired and released around the pass. Swap a
  client's texture in once its acquire fence has signaled (poll the
  sync_file in the event loop), so a slow client never holds up a frame;
  hand release points back with `dev.submit_sync_file`.
- Steady frames allocate nothing: regions, history and the canvas reuse
  their lists.

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

## Window stack

Split as in Rust, so window and graphics libraries never depend on each
other:

| Bundle | Rust | Role |
|---|---|---|
| `glfw_sys` | glfw-sys | the whole GLFW API, generated by `mica bind`; handles are `u64`, `0` is NULL |
| `glfw` | glfw | safe windows, input, monitors, gamepads (below) |
| `raw_window_handle` | raw-window-handle | `WindowHandle`: `Xlib`, `Xcb`, `Wayland`, `Win32` or `AppKit`, and the `HasWindowHandle` trait |
| `vk_window` | ash-window | `extensions(handle)` for the instance, `create_surface(st, instance, handle)` (on macOS it attaches a `CAMetalLayer` to the view) |

`vk_gpu.Surface.create` takes a `WindowHandle`; raw `vk` programs use
`vk_window` directly. A handle is only data: keep the window open until its
surface is destroyed.

`glfw` (only `import glfw` is needed):

- `Window.open(title, w, h)` or `Window.create(WindowDesc { ... })`:
  resizable, visible, decorated, focused, floating, maximized, transparent,
  scale to monitor, fullscreen on a monitor. No GL context. GLFW lives from
  the first window to the last.
- Events: `poll()` / `wait(seconds)` (false once closing), then `events()`
  for that window's `Event`s, oldest first: `Key(Key, scancode, Action,
  Mods)`, `Char`, `MouseButton`, `CursorPos`, `CursorEnter`, `Scroll`,
  `Pos`, `Size`, `FramebufferSize`, `ContentScale`, `Close`, `Refresh`,
  `Focus`, `Iconify`, `Maximize`, `FileDrop`. A window keeps at most 4096
  unread events.
- Input state: `key(Key)`, `mouse_button(MouseButton)`, `cursor_pos`;
  `set_cursor_mode` (normal, hidden, disabled, captured), `set_cursor`
  (standard shapes), `set_raw_mouse_motion`.
- Geometry and state: title, size, position, framebuffer size, content
  scale, size limits, aspect ratio, iconify / restore / maximize / show /
  hide / focus / request attention, opacity, resizable / decorated /
  floating; `set_fullscreen(monitor)` / `set_windowed(...)` / `monitor()`.
- `clipboard()` / `set_clipboard`; `glfw.monitors()` (name, position,
  work area, physical size, scale, current and all video modes),
  `glfw.joysticks()`, `glfw.gamepad(j)` (buttons, axes), `glfw.time()`.
- `window_handle()`: Win32 on Windows, AppKit on macOS, Wayland or Xlib on
  Linux. `raw()` is the `glfw_sys` window for anything else.
- Monitors and gamepads are snapshots (GLFW frees a monitor when it
  disconnects), and a `Window` is not `Send`: GLFW runs on one thread (the
  main thread on macOS).

GLFW uses Wayland when the session has it (unset `WAYLAND_DISPLAY` for
X11); a Wayland swapchain follows `framebuffer_size()`, it is never out of
date.

## Platforms

| | Linux | Windows | macOS |
|---|---|---|---|
| Window stack, examples | run and tested (X11, Wayland) | type-checked, compiled to objects | type-checked, compiled to objects (arm64, x86_64) |
| GLFW library | `libglfw` | `glfw3` (static, links `gdi32` `user32` `shell32`) | `libglfw` (Homebrew: `LIBRARY_PATH=/opt/homebrew/lib`) |
| Surface | Xlib, XCB, Wayland | Win32 | Metal (`VK_EXT_metal_surface`) |
| Vulkan | any 1.3 driver | any 1.3 driver | MoltenVK; portability enumeration and `VK_KHR_portability_subset` are enabled when present |

`vk_gpu` needs a Vulkan 1.3 driver everywhere; dmabuf and sync_file sharing
are Linux only (elsewhere they return `Err`). Windows and macOS were checked
with `mica emit-llvm --target <triple>` and `clang -c`, not run.

## Triangle example

```sh
sheaf run -p triangle          # until the window is closed or Escape is pressed
sheaf run -p triangle -- 300   # 300 frames, then exit
```

It needs GLFW 3.4+. One frame is in flight, viewport and scissor are dynamic,
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

```sh
cd glfw_sys/src && mica bind /usr/include/GLFW/glfw3.h -D GLFW_INCLUDE_NONE --handles u64 -o lib.mica
```

## Test

```sh
sheaf test -p vk_gpu   # headless on the real device: clear, draw, bindless sampling,
                       # compute through a buffer address, uploads, retirement,
                       # strided rectangle uploads, opaque textures,
                       # dmabuf export/import with sync_file, frame age, and
                       # misuse (stale/foreign handles, bad commands) as errors
sheaf test -p vk_draw2d   # shapes, clips, alpha, shadows, transforms, crops,
                          # occlusion, several damage rectangles, read back
sheaf test -p vk_compose  # regions; moves, idle frames, client damage through
                          # transforms, occlusion, stacking, dmabuf windows, scanout
sheaf test -p vk_graph    # culling, order, pooling
sheaf test -p glfw_sys    # the generated API against the real library
sheaf test -p glfw        # windows and their handles
sheaf test -p vk_window   # extensions, and a surface for a real window
                          # (window tests are skipped without a display)
cd vk_draw2d/shaders && for f in *.vert *.frag; do glslc --target-env=vulkan1.3 -I ../../vk_gpu/shaders $f -o $f.spv; done
cd vk_gpu/tests/shaders && for f in *.vert *.frag *.comp; do glslc --target-env=vulkan1.3 -I ../../shaders $f -o $f.spv; done
sheaf test -p vk    # values, derives, and a real instance and device when a driver is present
                    # layout.mica: builds layout.c with cc against the system Vulkan headers and
                    # compares size, alignment and member offsets of every core struct and union
```

## License

Apache-2.0 ([LICENSE-APACHE](LICENSE-APACHE)) or BSD-2-Clause
([LICENSE-BSD](LICENSE-BSD)), at your option.
