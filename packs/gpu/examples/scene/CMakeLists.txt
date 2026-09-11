# The scene example (F132, spec 124). Built by a project that adds the pack; not part of the library.
#
# SDL2 is the host here — the window, the GL context and the entry-point loader. The PACK needs none
# of that, which is the point: a consumer brings its own platform layer and the seam takes
# glGetProcAddress from it. If SDL2 is not installed this example is skipped and the pack still
# builds, because an example must never be a dependency of the library it demonstrates.
cmake_minimum_required(VERSION 3.21)

find_package(SDL2 QUIET CONFIG)
if(NOT SDL2_FOUND)
  message(STATUS "rengine-gpu: SDL2 not found; the scene example is skipped (the pack is unaffected)")
  return()
endif()

add_executable(rengine_gpu_scene
  "${CMAKE_CURRENT_SOURCE_DIR}/main.c"
  "${CMAKE_CURRENT_SOURCE_DIR}/scene.c"
  "${CMAKE_CURRENT_SOURCE_DIR}/obj.c")
target_link_libraries(rengine_gpu_scene PRIVATE rengine::gpu SDL2::SDL2)
target_compile_features(rengine_gpu_scene PRIVATE c_std_11)
if(NOT MSVC)
  target_compile_options(rengine_gpu_scene PRIVATE -Wall -Wextra)
  find_library(RENGINE_GPU_M m)
  if(RENGINE_GPU_M)
    target_link_libraries(rengine_gpu_scene PRIVATE ${RENGINE_GPU_M})
  endif()
endif()
