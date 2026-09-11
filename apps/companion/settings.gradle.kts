// The companion lives in this repository so it compiles the same C modules the desktop compiles,
// not a fork of them (spec 128, decision 10). Its Gradle build is separate from the CMake build on
// purpose: Android drives CMake, never the other way round.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "companion"
include(":app")
