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

add_library(companion SHARED
  companion.c
  "${RE_ROOT}/third_party/microui/microui.c"
  "${RE_ROOT}/orchestrator/native/render/draw_list.c"
  "${RE_ROOT}/orchestrator/native/render/utf8.c"
  "${RE_ROOT}/orchestrator/native/theme.c"
)

# ui.c — the D33 owned control layer — is NOT here yet, and the reason is worth writing down: it
# includes orchestrator/native/common.h, which includes SDL.h. The layer itself is SDL-free (it
# draws through the draw list and nothing else); the header it leans on is not. Splitting that
# header is its own change, and pulling the layer in before it is split would mean either an SDL
# dependency on Android or a copied module — the two things decision 10 exists to avoid.

target_include_directories(companion PRIVATE
  "${RE_ROOT}/orchestrator/native"
  "${RE_ROOT}/third_party"
  "${RE_ROOT}/third_party/microui"
)

# The glue that lets a NativeActivity hand its window to C. Shipped with the NDK, compiled from
# there rather than copied, for the same reason the modules above are.
add_library(native_app_glue STATIC
  "${ANDROID_NDK}/sources/android/native_app_glue/android_native_app_glue.c")
target_include_directories(native_app_glue PUBLIC "${ANDROID_NDK}/sources/android/native_app_glue")

target_link_libraries(companion PRIVATE native_app_glue android log m)
# NativeActivity looks up ANativeActivity_onCreate, which the glue defines; without this the linker
# drops it and the app starts to a black screen with no error.
target_link_options(companion PRIVATE "-u" "ANativeActivity_onCreate")
