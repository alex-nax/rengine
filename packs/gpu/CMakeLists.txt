# rengine-gpu — rEngine's first library pack from its own sources (F123, charter D50/D52).
#
# Hand-written on purpose, unlike the generated CMakeLists.txt at the repository root: a pack is
# consumed by projects that have never heard of cmkr, and asking them to install a generator to read
# one library is a dependency the pack does not need. `tools/design.py`'s generated-file rule lists
# the files it governs by name, and this is deliberately not one of them.
#
# Standalone by construction, in the shape ~/iklib already proves in this family: when it is not the
# top-level project it defines the library and nothing else — no tests, no gates, no desktop.
cmake_minimum_required(VERSION 3.21)
project(rengine_gpu C)

# The seam's backend is chosen at BUILD time and exactly one is compiled in (charter D14b/D51: Quest
# is the constrained target, several of these calls are per-draw, and we never ship two backends in
# one binary). Two binaries and a comparison is the regression story, not a runtime toggle.
set(RENGINE_GPU_SEAM_BACKEND "opengl" CACHE STRING "Which graphics API the resource-and-draw seam uses")
set_property(CACHE RENGINE_GPU_SEAM_BACKEND PROPERTY STRINGS opengl vulkan)
if(RENGINE_GPU_SEAM_BACKEND STREQUAL "opengl")
  set(RENGINE_GPU_SEAM_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_gl.c")
elseif(RENGINE_GPU_SEAM_BACKEND STREQUAL "vulkan")
  message(FATAL_ERROR
    "rengine-gpu: the seam's Vulkan backend is not written yet. It is sequenced with its first "
    "consumer (charter D52, F126) so its shape is settled by real call sites; the device layer this "
    "pack already ships is what a Vulkan backend will be built on. Build with "
    "-DRENGINE_GPU_SEAM_BACKEND=opengl until then.")
else()
  message(FATAL_ERROR "rengine-gpu: unknown RENGINE_GPU_SEAM_BACKEND '${RENGINE_GPU_SEAM_BACKEND}'; "
                      "the choices are opengl and vulkan")
endif()

add_library(rengine_gpu STATIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_device.c"
  "${RENGINE_GPU_SEAM_SOURCE}")
add_library(rengine::gpu ALIAS rengine_gpu)

# The public surface is the two layers' headers. `src/` is private, and there is nothing else to
# reach for. `gpu_seam.hpp` is header-only C++ over the C core, so a C consumer never compiles it and
# a C++ consumer needs no extra library.
target_include_directories(rengine_gpu PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_compile_features(rengine_gpu PUBLIC c_std_11)

# The header names <vulkan/vulkan.h>, so a consumer needs those headers to include it — PUBLIC, not
# PRIVATE. rEngine vendors them beside the pack; a consumer that has its own passes
# -DRENGINE_GPU_VULKAN_INCLUDE=<dir>, which is the same shape NOLF_IKLIB_DIR uses for iklib.
set(RENGINE_GPU_VULKAN_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party" CACHE PATH
    "Directory containing vulkan/vulkan.h for the rengine-gpu pack")
if(NOT EXISTS "${RENGINE_GPU_VULKAN_INCLUDE}/vulkan/vulkan.h")
  message(FATAL_ERROR
    "rengine-gpu: vulkan/vulkan.h not found under RENGINE_GPU_VULKAN_INCLUDE="
    "'${RENGINE_GPU_VULKAN_INCLUDE}'. The pack's public header includes it, so a consumer must "
    "provide it: pass -DRENGINE_GPU_VULKAN_INCLUDE=<dir>, or take the pack through rEngine's "
    "submodule, which vendors the headers it was built against.")
endif()
target_include_directories(rengine_gpu SYSTEM PUBLIC "${RENGINE_GPU_VULKAN_INCLUDE}")

if(NOT MSVC)
  target_compile_options(rengine_gpu PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Only when this IS the top-level project: everything below is for someone building the pack alone.
if(NOT CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  return()
endif()
message(STATUS "rengine-gpu: standalone build; a consumer normally add_subdirectory()s this instead")

# The example is built only here, when the pack IS the project being built. A consumer that adds the
# pack must receive the library and nothing else — F123's first criterion — so an example target
# appearing in someone else's build would be a defect, not a convenience.
add_subdirectory(examples/scene)
