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

add_library(rengine_gpu STATIC "${CMAKE_CURRENT_SOURCE_DIR}/src/gpu_device.c")
add_library(rengine::gpu ALIAS rengine_gpu)

# The public surface is one header. `src/` is private, and there is nothing else to reach for.
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
