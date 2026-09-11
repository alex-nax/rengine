# The companion's native layer (charter D57, spec 128 decisions 7 and 10).
#
# The point of this file is the paths: every shared module is compiled FROM ITS PLACE in this
# repository. There are no copies under apps/, and there is no vendored second microui — a fork of
# the UI layer is exactly what putting the app in this repo was meant to prevent (decision 10).
#
# What it deliberately does NOT pull in is the desktop's windowing: app.c, the SDL surface and the
# seam hosts are the desktop's half of the boundary. Android brings its own window, and the C layer
# drives the frame loop here exactly as app.c does there (decision 7).
cmake_minimum_required(VERSION 3.22)
project(companion C)

# apps/companion/app/src/main/cpp -> the repository root
get_filename_component(RE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../.." ABSOLUTE)
if(NOT EXISTS "${RE_ROOT}/orchestrator/native/render/draw_list.c")
  message(FATAL_ERROR
    "companion: the shared C modules are not where this build expects them (looked in ${RE_ROOT}). "
    "This app compiles the desktop's sources from one origin; it carries no copies to fall back on.")
endif()

# Which backend this build carries (charter D59). Vulkan is the path where a device offers it — it
# was proved on a Quest 3 — but the seam's Vulkan backend needs dynamic rendering and
# synchronization2, and a 2022 Adreno 619 offers neither, so OpenGL ES is what reaches that class of
# phone. One binary carries one backend here, exactly as a game does (D14b); the desktop's trick of
# linking prefixed copies is what a runtime choice would need, and nothing needs it yet.
set(RE_COMPANION_BACKEND "opengl" CACHE STRING "Which graphics API the companion's seam uses")
set_property(CACHE RE_COMPANION_BACKEND PROPERTY STRINGS opengl vulkan)
if(RE_COMPANION_BACKEND STREQUAL "opengl")
  set(RE_COMPANION_HOST "seam_host_android_gl.c")
  set(RE_COMPANION_SEAM "${RE_ROOT}/packs/gpu/src/gpu_seam_gl.c")
  set(RE_COMPANION_GPU_LIBS EGL GLESv3)
elseif(RE_COMPANION_BACKEND STREQUAL "vulkan")
  set(RE_COMPANION_HOST "seam_host_android.c")
  set(RE_COMPANION_SEAM
    "${RE_ROOT}/packs/gpu/src/gpu_device.c"
    "${RE_ROOT}/packs/gpu/src/gpu_seam_vk.c"
    "${RE_ROOT}/packs/gpu/src/gpu_seam_vk_draw.c"
    "${RE_ROOT}/packs/gpu/src/gpu_seam_spirv.c")
  set(RE_COMPANION_GPU_LIBS "")
else()
  message(FATAL_ERROR "companion: unknown RE_COMPANION_BACKEND '${RE_COMPANION_BACKEND}'; opengl or vulkan")
endif()

add_library(companion SHARED
  companion.c
  "${RE_ROOT}/third_party/microui/microui.c"
  "${RE_ROOT}/orchestrator/native/render/draw_list.c"
  "${RE_ROOT}/orchestrator/native/render/utf8.c"
  "${RE_ROOT}/orchestrator/native/render/font.c"
  "${RE_ROOT}/orchestrator/native/theme.c"
  # The renderer, unchanged: backend_seam.c is the draw list on the pack's seam and it compiles here
  # exactly as it does on the desktop, because the window handle above the host is opaque. The host
  # beside it is the one file per platform (spec 124's split, now with a fourth member).
  "${RE_ROOT}/orchestrator/native/render/backend_seam.c"
  "${RE_ROOT}/orchestrator/native/render/${RE_COMPANION_HOST}"
  # The pack, from packs/gpu like any consumer.
  ${RE_COMPANION_SEAM}
)

# ui.c — the D33 owned control layer — is NOT here yet, and the reason is worth writing down: it
# includes orchestrator/native/common.h, which includes SDL.h. The layer itself is SDL-free (it
# draws through the draw list and nothing else); the header it leans on is not. Splitting that
# header is its own change, and pulling the layer in before it is split would mean either an SDL
# dependency on Android or a copied module — the two things decision 10 exists to avoid.

target_include_directories(companion PRIVATE
  "${RE_ROOT}/orchestrator/native"
  "${RE_ROOT}/third_party/microui"
  "${RE_ROOT}/third_party/stb"
  "${RE_ROOT}/third_party"
  "${RE_ROOT}/packs/gpu/include"
)
# The repository's own vendored Vulkan headers, NOT the NDK's. The pack pins VK_HEADER_VERSION 328
# exactly and the NDK ships 275, so the NDK's would be refused — and the pin is right: one header
# version everywhere is the point. What the vendored set was missing is vulkan_android.h, which
# nothing had needed until this target; it is now vendored from the same tag and recorded in
# third_party/sources.json with its hash (spec 122's "no platform headers" was true until now).
# Vulkan-only on Android (spec 128, decision 8) and the surface extension that needs declaring.
target_compile_definitions(companion PRIVATE VK_USE_PLATFORM_ANDROID_KHR VK_NO_PROTOTYPES)

# The glue that lets a NativeActivity hand its window to C. Shipped with the NDK, compiled from
# there rather than copied, for the same reason the modules above are.
add_library(native_app_glue STATIC
  "${ANDROID_NDK}/sources/android/native_app_glue/android_native_app_glue.c")
target_include_directories(native_app_glue PUBLIC "${ANDROID_NDK}/sources/android/native_app_glue")

target_link_libraries(companion PRIVATE native_app_glue android log m dl ${RE_COMPANION_GPU_LIBS})
# NativeActivity looks up ANativeActivity_onCreate, which the glue defines; without this the linker
# drops it and the app starts to a black screen with no error.
target_link_options(companion PRIVATE "-u" "ANativeActivity_onCreate")
