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
# A consumer that needs more than ONE backend in one binary builds this directory more than once.
# That is not the case a game has — a game ships one backend and pays no indirection, which is the
# whole of D14b — but it is exactly the case a desktop has when `--renderer` stays a runtime switch
# (rEngine's own, spec 126 decision 3). Set these as normal variables before each add_subdirectory()
# and give each call its own binary directory:
#
#   set(RENGINE_GPU_TARGET_NAME rengine_gpu_metal)
#   set(RENGINE_GPU_SEAM_BACKEND metal)
#   set(RENGINE_GPU_FORCE_INCLUDE "${CMAKE_SOURCE_DIR}/my_metal_prefix.h")
#   add_subdirectory(packs/gpu "${CMAKE_BINARY_DIR}/packs/gpu-metal")
#
# The force-included header renames the pack's public symbols so two copies can coexist; it is
# applied PUBLIC, so whatever links that copy is compiled against the same names and needs no
# knowledge of the scheme. The pack's own sources are not modified and know nothing about it.
if(NOT DEFINED RENGINE_GPU_TARGET_NAME)
  set(RENGINE_GPU_TARGET_NAME rengine_gpu)
endif()

set(RENGINE_GPU_SEAM_BACKEND "opengl" CACHE STRING "Which graphics API the resource-and-draw seam uses")
set_property(CACHE RENGINE_GPU_SEAM_BACKEND PROPERTY STRINGS opengl vulkan metal)
if(RENGINE_GPU_SEAM_BACKEND STREQUAL "opengl")
  set(RENGINE_GPU_SEAM_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_gl.c")
elseif(RENGINE_GPU_SEAM_BACKEND STREQUAL "vulkan")
  set(RENGINE_GPU_SEAM_SOURCE
    "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_vk.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_vk_draw.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_spirv.c")
elseif(RENGINE_GPU_SEAM_BACKEND STREQUAL "metal")
  if(NOT APPLE)
    message(FATAL_ERROR "rengine-gpu: the Metal backend needs an Apple platform")
  endif()
  enable_language(OBJC)
  set(RENGINE_GPU_SEAM_SOURCE
    "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_metal.m"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_spirv.c")
else()
  message(FATAL_ERROR "rengine-gpu: unknown RENGINE_GPU_SEAM_BACKEND '${RENGINE_GPU_SEAM_BACKEND}'; "
                      "the choices are opengl, vulkan and metal")
endif()

add_library(${RENGINE_GPU_TARGET_NAME} STATIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_device.c"
  "${RENGINE_GPU_SEAM_SOURCE}")
# The alias names THE pack; extra copies are a build detail of whoever asked for them and get none.
if(RENGINE_GPU_TARGET_NAME STREQUAL "rengine_gpu")
  add_library(rengine::gpu ALIAS rengine_gpu)
endif()

if(RENGINE_GPU_FORCE_INCLUDE)
  if(MSVC)
    target_compile_options(${RENGINE_GPU_TARGET_NAME} PUBLIC "/FI${RENGINE_GPU_FORCE_INCLUDE}")
  else()
    target_compile_options(${RENGINE_GPU_TARGET_NAME} PUBLIC "SHELL:-include ${RENGINE_GPU_FORCE_INCLUDE}")
  endif()
endif()

# The public surface is the two layers' headers. `src/` is private, and there is nothing else to
# reach for. `gpu_seam.hpp` is header-only C++ over the C core, so a C consumer never compiles it and
# a C++ consumer needs no extra library.
target_include_directories(${RENGINE_GPU_TARGET_NAME} PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_compile_features(${RENGINE_GPU_TARGET_NAME} PUBLIC c_std_11)

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
target_include_directories(${RENGINE_GPU_TARGET_NAME} SYSTEM PUBLIC "${RENGINE_GPU_VULKAN_INCLUDE}")

if(NOT MSVC)
  target_compile_options(${RENGINE_GPU_TARGET_NAME} PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(RENGINE_GPU_SEAM_BACKEND STREQUAL "metal")
  # Without ARC, deliberately: this file owns Metal objects in plain C tables with create/destroy
  # pairs, which is the discipline the rest of the pack follows. See the note at the top of the file.
  set_source_files_properties("${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_seam_metal.m"
                              PROPERTIES COMPILE_OPTIONS "-fno-objc-arc")
  target_link_libraries(${RENGINE_GPU_TARGET_NAME} PUBLIC "-framework Metal" "-framework Foundation")
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
