# rengine-agent — a local model behind a C ABI (charter D68/D72, specs 139 and 150).
#
# Hand-written on purpose, like packs/gpu and for the same reason: a pack is consumed by projects
# that have never heard of cmkr, and asking them to install a generator to read one library is a
# dependency the pack does not need. tools/design.py's generated-file rule lists what it governs by
# name, and this is deliberately not one of them.
#
# Standalone by construction: when this is not the top-level project it defines the library and
# nothing else — no tests, no gates, no desktop.
#
# The engine is NOT vendored here. It is this project's fork of llama.cpp, pinned as a submodule,
# and a consumer points at it:
#
#   set(RENGINE_AGENT_ENGINE_DIR /path/to/llama_r.cpp)
#   add_subdirectory(packs/agent)
#   target_link_libraries(my_game PRIVATE rengine::agent)
#
# When the engine targets already exist in the build (rEngine's own case, where the root adds the
# submodule itself), the directory is not added twice.
cmake_minimum_required(VERSION 3.21)
project(rengine_agent CXX C)

if(NOT DEFINED RENGINE_AGENT_TARGET_NAME)
  set(RENGINE_AGENT_TARGET_NAME rengine_agent)
endif()

if(NOT TARGET llama)
  if(NOT DEFINED RENGINE_AGENT_ENGINE_DIR)
    message(FATAL_ERROR
      "rengine-agent needs the engine. Either add it before this pack, or set\n"
      "  RENGINE_AGENT_ENGINE_DIR=<path to llama_r.cpp>\n"
      "The pack does not vendor or fetch it: the engine is pinned by whoever consumes both.")
  endif()
  # A relative path is resolved against THIS directory, which is how a person writing it reads it.
  # Left to CMake it would resolve against whichever directory happens to be current, and the answer
  # would change depending on who added the pack.
  get_filename_component(RENGINE_AGENT_ENGINE_DIR "${RENGINE_AGENT_ENGINE_DIR}"
                         ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
  if(NOT EXISTS "${RENGINE_AGENT_ENGINE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "RENGINE_AGENT_ENGINE_DIR=${RENGINE_AGENT_ENGINE_DIR} has no CMakeLists.txt")
  endif()
  # How the engine is configured for this ABI belongs to the PACK, not to whoever happens to build
  # it: a consumer that added the engine itself has already made these choices, and one that lets the
  # pack add it gets the same engine rEngine gets. Static because a pack ships a library, not a
  # runtime dependency somebody has to install; no binaries because an ABI needs none of them; and
  # two options forced off because they reach the network — LLAMA_LLGUIDANCE git-clones and
  # cargo-builds a dependency, and LLAMA_USE_PREBUILT_UI (which defaults ON upstream) pulls a bundle.
  set(BUILD_SHARED_LIBS     OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_COMMON    ON  CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_TESTS     OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_TOOLS     OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES  OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER    OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_APP       OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_UI        OFF CACHE BOOL "" FORCE)
  set(LLAMA_LLGUIDANCE      OFF CACHE BOOL "" FORCE)
  set(LLAMA_USE_PREBUILT_UI OFF CACHE BOOL "" FORCE)
  add_subdirectory("${RENGINE_AGENT_ENGINE_DIR}" "${CMAKE_BINARY_DIR}/llama_r.cpp")
endif()

add_library(${RENGINE_AGENT_TARGET_NAME} STATIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src/model.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sha256.c")

# The ABI is C and the header says so; the implementation is C++ because the engine is. A consumer
# compiles against the header alone and never sees the engine's own headers — which is what lets the
# engine's pin move without the consumer recompiling against a different llama.h.
target_include_directories(${RENGINE_AGENT_TARGET_NAME}
  PUBLIC  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(${RENGINE_AGENT_TARGET_NAME} PRIVATE llama)
set_target_properties(${RENGINE_AGENT_TARGET_NAME} PROPERTIES
  C_STANDARD 11 CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON POSITION_INDEPENDENT_CODE ON)

add_library(rengine::agent ALIAS ${RENGINE_AGENT_TARGET_NAME})

# Tests only when this pack is the top-level project or the parent asked for them, so a game that
# links the library does not inherit a test suite (the packs/gpu rule).
# packs/gpu's rule, kept: as a subdirectory this defines the library and nothing else. Standalone it
# tests itself, which is how the "standalone by construction" claim stays true rather than asserted.
if(PROJECT_IS_TOP_LEVEL)
  include(CTest)
endif()
if(BUILD_TESTING AND (PROJECT_IS_TOP_LEVEL OR RENGINE_AGENT_TESTS))
  add_executable(rengine_agent_test "${CMAKE_CURRENT_SOURCE_DIR}/tests/model_test.c")
  target_link_libraries(rengine_agent_test PRIVATE ${RENGINE_AGENT_TARGET_NAME})
  set_target_properties(rengine_agent_test PROPERTIES C_STANDARD 11)
  # Two tests, because two different things are being asked and only one needs weights.
  add_test(NAME rengine_agent_digest COMMAND rengine_agent_test digest)
  add_test(NAME rengine_agent_turn   COMMAND rengine_agent_test turn)
  # A fixture that is absent must SKIP and name what is missing, never pass quietly.
  set_tests_properties(rengine_agent_turn PROPERTIES SKIP_RETURN_CODE 77)
endif()
