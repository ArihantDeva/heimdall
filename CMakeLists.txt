cmake_minimum_required(VERSION 3.20)
file(READ "${CMAKE_SOURCE_DIR}/VERSION" GRAFT_VERSION_RAW)
string(STRIP "${GRAFT_VERSION_RAW}" GRAFT_VERSION_FULL)
# project(VERSION ...) only accepts X.Y.Z[.W], strip SemVer pre-release suffix.
string(REGEX REPLACE "[-+].*$" "" GRAFT_VERSION_NUMERIC "${GRAFT_VERSION_FULL}")
project(graft VERSION ${GRAFT_VERSION_NUMERIC} LANGUAGES C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

if(NOT MSVC)
  add_compile_options(-Wall -Wextra -Wno-unused-parameter -fPIC)
endif()

# === Dipendenze esterne ===
find_package(PkgConfig REQUIRED)
pkg_check_modules(SQLITE REQUIRED sqlite3)
pkg_check_modules(YAML REQUIRED yaml-0.1)

# llama.cpp (deve essere stato compilato in third_party/llama.cpp/build)
set(LLAMA_DIR ${CMAKE_SOURCE_DIR}/third_party/llama.cpp)
# pkg-config -L paths are not searched by default on macOS (no /opt/homebrew/lib in default search)
link_directories(${YAML_LIBRARY_DIRS} ${SQLITE_LIBRARY_DIRS})
include_directories(${LLAMA_DIR}/include ${LLAMA_DIR}/ggml/include)
link_directories(${LLAMA_DIR}/build/bin ${LLAMA_DIR}/build/src ${LLAMA_DIR}/build/ggml/src ${LLAMA_DIR}/build/ggml/src/ggml-blas ${LLAMA_DIR}/build/ggml/src/ggml-metal)

# mpack
set(MPACK_DIR ${CMAKE_SOURCE_DIR}/third_party/mpack/src/mpack)
include_directories(${MPACK_DIR})

# blake3 (portable-only: skip SIMD to avoid intrinsics build pain on MinGW)
set(BLAKE3_DIR ${CMAKE_SOURCE_DIR}/third_party/BLAKE3/c)
add_library(blake3 STATIC
  ${BLAKE3_DIR}/blake3.c
  ${BLAKE3_DIR}/blake3_dispatch.c
  ${BLAKE3_DIR}/blake3_portable.c
)
target_include_directories(blake3 PUBLIC ${BLAKE3_DIR})
target_compile_definitions(blake3 PRIVATE
  BLAKE3_NO_SSE2 BLAKE3_NO_SSE41 BLAKE3_NO_AVX2 BLAKE3_NO_AVX512
  BLAKE3_USE_NEON=0
)

# sqlite-vec
set(SQLITE_VEC_DIR ${CMAKE_SOURCE_DIR}/third_party/sqlite-vec)
# The submodule ships only a `sqlite-vec.h.tmpl`; the header is generated
# at make-time upstream. Substitute the placeholders ourselves so the build
# works end-to-end without an external `make sqlite-vec.h` step.
if(NOT EXISTS ${SQLITE_VEC_DIR}/sqlite-vec.h)
  file(READ ${SQLITE_VEC_DIR}/VERSION _sv_raw)
  string(STRIP "${_sv_raw}" VERSION)
  string(REGEX MATCH "^([0-9]+)\\.([0-9]+)\\.([0-9]+)" _sv_match "${VERSION}")
  set(VERSION_MAJOR "${CMAKE_MATCH_1}")
  set(VERSION_MINOR "${CMAKE_MATCH_2}")
  set(VERSION_PATCH "${CMAKE_MATCH_3}")
  string(TIMESTAMP DATE "%Y-%m-%dT%H:%M:%SZ" UTC)
  set(SOURCE "cmake-configured")
  configure_file(
    ${SQLITE_VEC_DIR}/sqlite-vec.h.tmpl
    ${SQLITE_VEC_DIR}/sqlite-vec.h
    @ONLY
  )
  # @ONLY only substitutes @VAR@ — but the template uses ${VAR}. Re-run with
  # the default mode that also handles ${VAR}.
  configure_file(
    ${SQLITE_VEC_DIR}/sqlite-vec.h.tmpl
    ${SQLITE_VEC_DIR}/sqlite-vec.h
  )
endif()
add_library(sqlite_vec STATIC ${SQLITE_VEC_DIR}/sqlite-vec.c)
target_include_directories(sqlite_vec PUBLIC ${SQLITE_VEC_DIR} ${SQLITE_INCLUDE_DIRS})
target_compile_definitions(sqlite_vec PRIVATE SQLITE_CORE)

# mpack come libreria
add_library(mpack STATIC
  ${MPACK_DIR}/mpack-common.c
  ${MPACK_DIR}/mpack-expect.c
  ${MPACK_DIR}/mpack-node.c
  ${MPACK_DIR}/mpack-platform.c
  ${MPACK_DIR}/mpack-reader.c
  ${MPACK_DIR}/mpack-writer.c
)
target_include_directories(mpack PUBLIC ${MPACK_DIR})

# === Headers ===
# SQLITE/YAML headers may live outside the compiler default search path on
# Homebrew arm64 (/opt/homebrew/include) — explicitly add the pkg-config dirs.
include_directories(
  ${CMAKE_SOURCE_DIR}/include
  ${SQLITE_INCLUDE_DIRS}
  ${YAML_INCLUDE_DIRS}
)

# === Sorgenti core (libreria condivisa interna) ===
file(GLOB GRAFT_SRC CONFIGURE_DEPENDS
  src/common/*.c
  src/storage/*.c
  src/embed/*.c
  src/insert/*.c
  src/retrieve/*.c
  src/explore/*.c
  src/verify/*.c
  src/rerank/*.c
  src/stats/*.c
  src/config/*.c
  src/http/*.c
  src/daemon/wire.c
  src/daemon/dispatch.c
  src/daemon/socket.c
)

add_library(graft_core STATIC ${GRAFT_SRC})
# Order matters: sqlite_vec depends on sqlite3 symbols, must precede ${SQLITE_LIBRARIES}.
set(MG_PLATFORM_LIBS "")
if(WIN32)
  list(APPEND MG_PLATFORM_LIBS ws2_32 bcrypt)
elseif(APPLE)
  list(APPEND MG_PLATFORM_LIBS "-framework Accelerate" "-framework Metal" "-framework MetalKit" "-framework Foundation")
endif()
target_link_libraries(graft_core
  sqlite_vec
  ${SQLITE_LIBRARIES}
  ${YAML_LIBRARIES}
  mpack
  blake3
  llama
  ggml
  ggml-base
  ggml-cpu
  ggml-blas
  ggml-metal
  m
  pthread
  ${MG_PLATFORM_LIBS}
)

# === Binari ===
add_executable(graftd src/daemon/main.c)
target_link_libraries(graftd graft_core)
# llama is C++; graftd consumes libllama/ggml symbols → link libc++
target_link_libraries(graftd c++)

add_executable(graft
  src/cli/main.c
  src/cli/autostart.c
  src/cli/usage_log.c
  src/cli/profile.c
  src/cli/setup.c
  src/cli/upgrade.c
  src/cli/view.c
)
target_compile_definitions(graft PRIVATE
  GRAFT_VERSION="${GRAFT_VERSION_FULL}"
  GRAFT_REPOSITORY="AEndrix03/Graft"
)
target_link_libraries(graft graft_core)

# === Tests ===
option(GRAFT_BUILD_TESTS "Build the test executables" ON)
if(GRAFT_BUILD_TESTS)
  enable_testing()
  file(GLOB TEST_SRC tests/test_*.c)
  foreach(TFILE ${TEST_SRC})
    get_filename_component(TNAME ${TFILE} NAME_WE)
    add_executable(${TNAME} ${TFILE})
    target_link_libraries(${TNAME} graft_core)
    add_test(NAME ${TNAME} COMMAND ${TNAME})
  endforeach()
endif()
