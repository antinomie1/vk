# vk

[English](README.md)

面向 [Mica](https://github.com/antinomie1/mica) 的 Vulkan，用
[sheaf](https://github.com/antinomie1/sheaf) 构建。一个由多个 bundle 组成的工作区：

| 包 | 作用 |
|----|------|
| `vk` | 由 `vk.xml` 与 `video.xml` 生成的底层绑定（类似 ash 的 `vk` 模块） |
| `vk_gpu` | Vulkan 1.3 高层库：Copy 句柄、bindless、自动屏障、帧 |
| `vk_draw2d` | 基于 `vk_gpu` 的批量 2D：圆角矩形、边框、阴影、图片、裁剪、局部重绘 |
| `vk_compose` | 合成器的一帧：纹理与 dmabuf 上的视图，按缓冲年龄计算损坏区域 |
| `vk_graph` | 基于 `vk_gpu` 的渲染图：pass 剔除，临时纹理池化 |
| `vk_window` | 根据原始窗口句柄创建 Vulkan surface（类似 ash-window） |
| `raw_window_handle` | 窗口库与图形库共用的原生窗口句柄约定 |
| `glfw_sys` | 由 `glfw3.h` 生成的 GLFW 3.4+ 绑定 |
| `glfw` | 基于 `glfw_sys` 的安全 GLFW 窗口，产出原始窗口句柄 |
| `generator` | 从注册表生成 `vk/src/lib.mica` 及其布局测试 |
| `examples/triangle` | GLFW 窗口（X11 或 Wayland）中的彩色三角形，直接用 `vk` |
| `examples/triangle_gpu` | 同一个三角形，用 `vk_gpu` |

## vk

- 支持所有核心版本（1.0–1.4）以及 `vulkan` 支持的全部扩展，外加 Video Std
  类型；只生成从它们可达的类型。
- 类型去掉 `Vk` 前缀（`InstanceCreateInfo`；`VkResult` 保留，因为 `Result`
  是内建类型）。字段和参数用 snake_case（`p_next`、`pp_enabled_extension_names`）。
- 句柄有类型：`struct Instance { raw: usize }`（可分发）和
  `struct Buffer { raw: u64 }`。空句柄是 `Instance {}`。句柄和枚举派生
  `Show`、`Hash`，可作 `Map` 的键。
- `r.result()` 把 `VkResult` 变成 `Result[(), VkResult]`，只有 `SUCCESS` 是
  `Ok`，所以任何调用都能用 `try`。
- 枚举是 `enum Format: i32`，取值为 ash 风格：`Format.R8G8B8A8_UNORM`、
  `ImageType.TYPE_2D`。位掩码是 `enum BufferUsageFlags: u32 derive(Flags)`，
  支持 `|`、`contains`、`bits()`。`XFlagBits` 是 `XFlags` 的别名。
- 结构体字段有默认值，`sType` 已预设：`vk.BufferCreateInfo { size: 64, usage: ... }`。
  含指针的结构体是 `unsafe struct`，因此是 `Send` 且可出现在安全签名中。
  位域生成 `bits(uN)` 结构体。
- 命令放在 `extern table` 中，只解析一次，之后每次调用是一次间接调用：
  - `StaticFn`：`vkGetInstanceProcAddr`，通过 `StaticFn.open(vk.loader_name)`。
  - 核心：`EntryFnV1_x`、`InstanceFnV1_x`、`DeviceFnV1_x`。
  - 扩展：`<Ext>InstanceFn` 与 `<Ext>DeviceFn`，如 `KhrSwapchainDeviceFn`，用
    `try_load` 加载。
  - 某些扩展命令依赖其他版本或扩展（vk.xml 中的 `depends`），它们有单独的
    表，如 `KhrSwapchainV1_1DeviceFn`、`KhrDeviceGroupKhrSurfaceInstanceFn`
    （`,` 是 `Or`，`+` 是 `And`，括号组以 `Either` 或 `Both` 开头），因此缺少
    依赖不会妨碍基础表加载。若两个表达式映射到同一名字，生成器报错停止。
- 参数映射：`const char*` 字符串是 `str`；必需的单对象输出是 `mut`
  （`mut p_instance: Instance`）；其余指针是 `Ptr[T]`，可直接传 `List[T]`；
  可选的 `const char*`（如 `p_layer_name`）是 `Ptr[u8]`。

```mica
import vk

let st = vk.StaticFn.open(vk.loader_name).expect("no Vulkan loader")
let entry = vk.EntryFnV1_0.load(fn(n) => st.get_instance_proc_addr(vk.Instance {}, n))
let app = vk.ApplicationInfo { api_version: vk.api_version_1_3 }
unsafe let info = vk.InstanceCreateInfo { p_application_info: Ptr.of(app) }
var inst = vk.Instance {}
unsafe let r = entry.create_instance(Ptr.of(info), Ptr.null(), mut inst)
let fns = vk.InstanceFnV1_0.load(fn(n) => st.get_instance_proc_addr(inst, n))
// 在 fns.create_device(..., mut dev) 之后：
let swapchain = vk.KhrSwapchainDeviceFn.try_load(fn(n) => fns.get_device_proc_addr(dev, n))
```

## vk_gpu

七个名词：`Device`、`Buffer`、`Texture`、`Pipeline`、`Encoder`、目标
（`Surface`、`Offscreen`）和 `Ticket`。用户代码里没有 render pass、
framebuffer、描述符集、fence、布局和屏障。

- 以 Vulkan 1.3 为底线：动态渲染、synchronization2、时间线信号量、缓冲设备
  地址、update-after-bind 描述符索引。
- 句柄是小的 Copy 值：一个带代数的槽位（`SlotMap`）、所属设备，以及尺寸、
  格式或地址。`destroy_*` 立即把资源标记为已销毁，等 GPU 完成最后一个可能
  用到它的提交后再释放。
- `Encoder` 是一张命令列表，不接触任何 Vulkan 对象；提交时先检查，再录制进
  复用的命令缓冲。
- Bindless：每个纹理按 `index()` 位于一个全局描述符集（binding 0 采样，1 为
  四个不可变采样器，2 为存储图像）；缓冲通过 `addr()` 访问。只有一个 pipeline
  layout，128 字节 push constant；每次绘制不绑定任何东西。
  `shaders/vk_gpu.glsl` 声明了这个布局；下标 0 表示“无纹理”。
- 屏障：录制提交时，每个纹理从设备级状态转到每条命令需要的状态；屏障按作用域
  合并为一次 `vkCmdPipelineBarrier2`。写入者负责发布（pass 目标和拷贝结束后
  转为 `Sampled`，缓冲写入变为可见），所以读取从不需要声明；只有 compute 的
  `storage` 写入需要声明。
- 每次提交推进一个时间线值（`Ticket`）：`done`、`wait`。
  `present(frame, encoder)` 一次完成提交和呈现，获取与逐图像呈现信号量总是
  接好的。
- 交换链在 `resize`（Wayland）、out-of-date、或 suboptimal 帧呈现后重建；两帧
  并行；FIFO 或 mailbox/immediate。
- 内存：每种类型 64 MiB 块，首次适配并合并空闲段，超过 32 MiB 单独分配；
  主机可见内存常驻映射；整块显存可映射时上传直接写显存。8 MiB 上传环
  （`stage`、`write`、`write_texture`、`write_texture_rect`）按 Ticket 回收。
  `write_texture_rect` 从带行跨度的图像（wl_shm 池）中拷贝一个矩形，只暂存它
  覆盖的字节。Encoder 列表和命令缓冲
  都复用，稳态帧不分配内存。

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

- 共享：`export_dmabuf` / `import_dmabuf`（1..4 平面，支持同 BO 与基于
  `statx` 识别的 `DISJOINT` 多平面、原子 fd 管理）、`import_dmabuf_target`
  与 `copy_texture`、`submit_sync_file` / `wait_sync_file`；导入纹理用
  `e.acquire(t)` / `e.release(t)` 在队列族之间交接所有权。队列全局优先级
  （`Options.priority`）支持 `VK_KHR/EXT_global_priority` 自动降级协商，
  遇到 `VK_ERROR_DEVICE_LOST` 会标记 `lost()` 以便安全销毁与恢复。`TextureDesc` 和 `Dmabuf` 的
  `opaque` 通过视图的分量重排让 alpha 读作 1，用于 XRGB 格式。帧通过 `age()` 报告缓冲年龄；交换链
  图像在两次呈现之间保留内容，因此可以局部重绘。

### 安全性

使用这些 bundle 的安全 Mica 代码不会破坏 CPU 内存，也不会把无效对象交给驱动：

- 已销毁的句柄或其他设备的句柄在任何地方都是 `Err`：`submit`（不录制任何
  东西）、`write`、`read`、`read_texture`；对这类句柄调用 `destroy_*` 会被
  忽略。映射内存的读写会检查缓冲仍然存活并限制范围。
- `submit` 还会拒绝：在格式不同的 pass 中绑定的 pipeline、未绑定 pipeline 的
  绘制或调度、超出缓冲的索引 / 间接参数范围、超过 128 字节或不是 4 的倍数的
  push constant、负的裁剪矩形、超过设备上限的调度、在没有相应用途的纹理上
  渲染或存储写入、交给其他目标的帧。
- 每个 bindless 槽位都始终持有一个纹理：空闲槽位指向 1×1 透明黑占位纹理，
  `gpu_sample` / `gpu_index` 会钳制下标，因此失效或越界的下标读到黑色。
  `Options.max_textures` 是精确值（修改时同步 `GPU_MAX_TEXTURES`）。

不覆盖：shader 如何使用缓冲地址（越界在所有 Vulkan API 中都是未定义行为，请用
验证层的 GPU 辅助检查），以及 CPU 写入 GPU 仍在读取的主机可见缓冲（得到旧数据，
不会破坏内存：先等它的 `Ticket`）。未提交的 encoder 用 `dev.cancel(e)` 归还。

尚未实现：多线程录制、多渲染目标与 mipmap、平面型 YCbCr 采样转换。

## vk_draw2d

`Canvas`：`rect`、`round_rect`、`border`、`shadow`、`image`、`image_part`
（图集中的精灵）、`texture`（裁剪与 `Transform`）、`opaque`、`push_clip` /
`pop_clip`，然后 `draw(dev, e, pass, damage)`。

- 每个目标一个 pass：形状是 96 字节的实例，一次放进上传环，按缓冲地址读取；
  纹理按 bindless 下标读取。
- 每个形状都是同一个圆角盒距离场（抗锯齿边缘、圆环、阴影衰减），所以圆角和
  阴影的开销与普通矩形相同。纹理坐标是每个形状的仿射映射，裁剪和八种
  `wl_output.transform` 不增加开销。
- 损坏区域是一组矩形，每个矩形在同一个 pass 里做一次带裁剪的实例化绘制，只画
  落入它的形状；没有形状落入时不录制 pass。
- 遮挡剔除：每个矩形从完全盖住它的最上层形状开始画。满 alpha 的矩形和不透明
  纹理会遮住下面的内容，`opaque(r)` 可以再标记。全屏不透明窗口只画一个四边形。
- 预乘 alpha 混合；颜色用非预乘 alpha，sRGB 目标用 `srgb()`。

尚未实现：背景模糊。

## vk_compose

`Scene`：`add`、`set`、`get`、`commit`（客户端损坏区域，单位为纹理像素）、
`raise`、`place_above`、`reorder`（O(N log N) LIS 最小脏区重排）、`remove`、
`remove_many`、`resize`、`damage`、`idle`、`visible`、`scanout`、
`overlay_candidates`、`set_overlays`、`changed`，以及
`render(dev, canvas, e, frame)`。

- `View` 是一张纹理（shm 上传或导入的 dmabuf；纯色用 1x1 纹理），带位置和
  尺寸、源裁剪（wp_viewport）、缓冲变换、不透明度、圆角、投影和不透明区域。
- 损坏区域最多 8 个整像素矩形：自上一帧以来移动、变化或出现的部分，再按目标
  图像的年龄并上最近 4 帧的历史；年龄为 0 时全部重绘。客户端损坏区域会经过
  视图的裁剪、变换和缩放映射到屏幕。只换纹理不产生损坏，只重绘 `commit` 报告
  的部分。
- 渲染跳过被不透明视图遮住的内容；`visible(id)` 表示视图是否还能看到，被遮住
  的客户端可以降频（不发帧回调）。
- `idle()`：不需要新的一帧。`scanout()`：原样铺满屏幕的那个视图，可以直接放到
  plane 上而不渲染。`changed()`：上一帧改变的区域（KMS `FB_DAMAGE_CLIPS`、
  上级合成器的损坏区域）。
- 导入的纹理在 pass 前后自动取回和归还。客户端的获取栅栏在事件循环中轮询，
  发出信号后再用 `set` 换入纹理，慢客户端不会拖住任何一帧；释放点用
  `dev.submit_sync_file` 返回。
- 稳态帧不分配内存：区域、历史和画布都复用各自的列表。

## vk_graph

`Graph`：`texture(dev, desc)`（临时、池化）、`render(pass, reads,
Box(fn(mut r: gpu.Render) ...))`、`compute(reads, writes, Box(fn(mut c:
gpu.Compute) ...))`、`run(dev, e, outputs)`。

- pass 按添加顺序执行；没有被任何输出依赖的 pass 被剔除。compute pass 声明
  其存储写入；其余仍由 encoder 自动插屏障。
- 描述相同的临时纹理下一帧从池中取回，连续 3 帧不用就释放：稳态帧不分配显存
  （装箱的 pass 闭包是很小的堆分配）。

## 窗口层

按 Rust 的方式分层，窗口库和图形库互不依赖：

| Bundle | Rust 对应 | 作用 |
|---|---|---|
| `glfw_sys` | glfw-sys | 完整的 GLFW API，由 `mica bind` 生成；句柄是 `u64`，`0` 表示 NULL |
| `glfw` | glfw | 安全的窗口、输入、显示器、手柄（见下） |
| `raw_window_handle` | raw-window-handle | `WindowHandle`：`Xlib`、`Xcb`、`Wayland`、`Win32` 或 `AppKit`，以及 `HasWindowHandle` trait |
| `vk_window` | ash-window | `extensions(handle)` 给出实例扩展，`create_surface(st, instance, handle)` 创建 surface（macOS 下给 view 挂上 `CAMetalLayer`） |

`vk_gpu.Surface.create` 接收 `WindowHandle`；直接用 `vk` 的程序直接用
`vk_window`。句柄只是数据：在销毁它的 surface 之前不要关闭窗口。

`glfw`（只需 `import glfw`）：

- `Window.open(title, w, h)` 或 `Window.create(WindowDesc { ... })`：可调整
  大小、可见、有边框、聚焦、置顶、最大化、透明、随显示器缩放、在某个显示器上
  全屏。不带 GL 上下文。GLFW 从第一个窗口打开存活到最后一个关闭。
- 事件：`poll()` / `wait(seconds)`（窗口要关闭时返回 false），然后 `events()`
  取出该窗口的 `Event`，按时间先后：`Key(Key, scancode, Action, Mods)`、
  `Char`、`MouseButton`、`CursorPos`、`CursorEnter`、`Scroll`、`Pos`、`Size`、
  `FramebufferSize`、`ContentScale`、`Close`、`Refresh`、`Focus`、`Iconify`、
  `Maximize`、`FileDrop`。一个窗口最多积压 4096 个未读事件。
- 输入状态：`key(Key)`、`mouse_button(MouseButton)`、`cursor_pos`；
  `set_cursor_mode`（正常、隐藏、禁用、限制在窗口内）、`set_cursor`（标准形状）、
  `set_raw_mouse_motion`。
- 几何与状态：标题、大小、位置、帧缓冲大小、内容缩放、大小限制、宽高比、
  最小化 / 还原 / 最大化 / 显示 / 隐藏 / 聚焦 / 请求注意、不透明度、可调整大小 /
  边框 / 置顶；`set_fullscreen(monitor)` / `set_windowed(...)` / `monitor()`。
- `clipboard()` / `set_clipboard`；`glfw.monitors()`（名称、位置、工作区、物理
  尺寸、缩放、当前与全部视频模式）、`glfw.joysticks()`、`glfw.gamepad(j)`
  （按钮、摇杆）、`glfw.time()`。
- `window_handle()`：Windows 下是 Win32，macOS 下是 AppKit，Linux 下是
  Wayland 或 Xlib。其余功能用 `raw()` 拿到 `glfw_sys` 的窗口。
- 显示器和手柄都是快照（显示器断开时 GLFW 会释放它），`Window` 不是 `Send`：
  GLFW 只在一个线程上运行（macOS 下必须是主线程）。

会话支持 Wayland 时 GLFW 使用 Wayland（取消 `WAYLAND_DISPLAY` 则用 X11）；
Wayland 交换链从不报告 out-of-date，要跟随 `framebuffer_size()` 重建。

## 平台

| | Linux | Windows | macOS |
|---|---|---|---|
| 窗口层、示例 | 已运行并测试（X11、Wayland） | 已做类型检查并编译为目标文件 | 已做类型检查并编译为目标文件（arm64、x86_64） |
| GLFW 库 | `libglfw` | `glfw3`（静态，链接 `gdi32` `user32` `shell32`） | `libglfw`（Homebrew：`LIBRARY_PATH=/opt/homebrew/lib`） |
| Surface | Xlib、XCB、Wayland | Win32 | Metal（`VK_EXT_metal_surface`） |
| Vulkan | 任意 1.3 驱动 | 任意 1.3 驱动 | MoltenVK；有 portability enumeration 和 `VK_KHR_portability_subset` 时自动开启 |

`vk_gpu` 在所有平台都需要 Vulkan 1.3 驱动；dmabuf 与 sync_file 共享只在 Linux
上可用（其他平台返回 `Err`）。Windows 与 macOS 用 `mica emit-llvm --target
<triple>` 和 `clang -c` 检查过，但没有实际运行。

## 三角形示例

```sh
sheaf run -p triangle          # 直到关闭窗口或按 Escape
sheaf run -p triangle -- 300   # 画 300 帧后退出
```

需要 GLFW 3.4+。一帧在飞，视口和裁剪是动态的，窗口大小变化时重建交换链。shader
从 `shaders/*.spv` 嵌入；修改 GLSL 后重新编译：

```sh
cd examples/triangle/shaders && glslc triangle.vert -o triangle.vert.spv && glslc triangle.frag -o triangle.frag.spv
```

`sheaf run -p triangle_gpu [-- frames]` 用 `vk_gpu` 画同一个三角形：约 40 行，
而不是 500 行。

## 重新生成

```sh
sheaf run -p generator -- /usr/share/vulkan/registry vk
```

第一个参数是任何包含 `vk.xml` 和 `video.xml` 的目录，例如 Vulkan-Headers 的
`registry/`。生成器写出 `vk/src/lib.mica`，以及 `vk/tests/layout.c` 和
`vk/tests/layout.mica`。

```sh
cd glfw_sys/src && mica bind /usr/include/GLFW/glfw3.h -D GLFW_INCLUDE_NONE --handles u64 -o lib.mica
```

## 测试

```sh
sheaf test -p vk_gpu      # 在真实设备上无头运行：清屏、绘制、bindless 采样、
                          # 通过缓冲地址的 compute、上传、回收、
                          # 带行跨度的矩形上传、不透明纹理、
                          # dmabuf 导出导入与 sync_file、帧年龄，
                          # 以及误用（失效/外部句柄、非法命令）报错
sheaf test -p vk_draw2d   # 形状、裁剪、透明、阴影、变换、源裁剪、遮挡、
                          # 多个损坏矩形，读回比对
sheaf test -p vk_compose  # 区域；移动、空闲帧、经变换映射的客户端损坏、遮挡、
                          # 层叠、dmabuf 窗口、直接扫描输出
sheaf test -p vk_graph    # 剔除、顺序、池化
sheaf test -p glfw_sys    # 生成的 API 对真实库的调用
sheaf test -p glfw        # 窗口及其句柄
sheaf test -p vk_window   # 扩展，以及为真实窗口创建 surface
                          # （窗口测试在没有显示服务器时跳过）
cd vk_draw2d/shaders && for f in *.vert *.frag; do glslc --target-env=vulkan1.3 -I ../../vk_gpu/shaders $f -o $f.spv; done
cd vk_gpu/tests/shaders && for f in *.vert *.frag *.comp; do glslc --target-env=vulkan1.3 -I ../../shaders $f -o $f.spv; done
sheaf test -p vk    # 取值、派生，以及有驱动时创建真实的实例和设备
                    # layout.mica：用 cc 针对系统 Vulkan 头文件编译 layout.c，
                    # 比对每个核心结构体和联合体的大小、对齐与成员偏移
```

## 许可证

Apache-2.0（[LICENSE-APACHE](LICENSE-APACHE)）或 BSD-2-Clause
（[LICENSE-BSD](LICENSE-BSD)），任选其一。
